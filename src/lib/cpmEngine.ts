import type { Activity, ActivityLink, CalendarType, P6Calendar, ProjectCalendar, ActivityConstraintType } from '@/types';
import {
  getCalendar,
  isWorkingDay,
  getNextWorkingDay,
  getPreviousWorkingDay,
  addWorkingDays,
  subtractWorkingDays,
  countWorkingDays,
  calculateLinkDate,
  offsetWorkingDays,
  effectiveLinkLagDays,
  forwardLagShift,
  backwardLagShift,
  resolveActivityExecutionCalendar,
} from './calendarEngine';

export interface CpmOptions {
  calendarType?: CalendarType;
  customHolidays?: string[];
  dataDate?: string | null;
  statusLogic?: 'retained_logic' | 'progress_override';
  calculateDrag?: boolean;
  /**
   * F1.1: project P6 calendars (the `calendars` table rows). An activity whose
   * `calendar_id` matches a usable row is scheduled on that P6 work pattern; anything
   * else keeps the exact legacy path (activity `calendar_type`, else project default).
   * Omit (or pass []) and the calculation is byte-identical to pre-F1.1.
   */
  calendars?: P6Calendar[];
}

export interface CpmResult {
  activityId: string;
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  totalFloat: number;
  freeFloat: number;
  isCritical: boolean;
  isLongestPath: boolean;
  activityDrag: number;
  remainingDuration: number;
  outOfSequence: boolean;
  drivingPredecessorIds?: string[];
}

export interface LinkDrivingResult {
  linkId: string;
  predecessorId: string;
  successorId: string;
  isDriving: boolean;
  drivingFloat: number;
}

export interface CpmCalculation {
  results: CpmResult[];
  linkResults: LinkDrivingResult[];
  cycle: string[] | null;
  projectEarlyStart: string;
  projectEarlyFinish: string;
  projectLateFinish: string;
  criticalPathDuration: number;
  dataDate: string;
}

function findCycle(activities: Activity[], links: ActivityLink[]): string[] | null {
  const graph = new Map<string, string[]>();
  links.forEach((link) => {
    graph.set(link.predecessor_id, [...(graph.get(link.predecessor_id) || []), link.successor_id]);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(id: string): string[] | null {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const next of graph.get(id) || []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const activity of activities) {
    const cycle = visit(activity.id);
    if (cycle) return cycle;
  }
  return null;
}

export function calculateCpm(
  activities: Activity[],
  links: ActivityLink[],
  calendarTypeOrOptions?: CalendarType | CpmOptions,
  customHolidaysParam?: string[],
): CpmCalculation {
  if (!activities.length) {
    return {
      results: [],
      linkResults: [],
      cycle: null,
      projectEarlyStart: '',
      projectEarlyFinish: '',
      projectLateFinish: '',
      criticalPathDuration: 0,
      dataDate: '',
    };
  }

  // Parse polymorphic options
  let options: CpmOptions = {};
  if (typeof calendarTypeOrOptions === 'string') {
    options = {
      calendarType: calendarTypeOrOptions,
      customHolidays: customHolidaysParam || [],
    };
  } else if (calendarTypeOrOptions && typeof calendarTypeOrOptions === 'object') {
    options = calendarTypeOrOptions;
  }

  const defaultCalendarType: CalendarType = options.calendarType || '6_days';
  const customHolidays: string[] = options.customHolidays || [];
  const statusLogic = options.statusLogic || 'retained_logic';

  const defaultCalendar: ProjectCalendar = getCalendar(defaultCalendarType, customHolidays);
  const cycle = findCycle(activities, links);
  if (cycle) {
    return {
      results: [],
      linkResults: [],
      cycle,
      projectEarlyStart: '',
      projectEarlyFinish: '',
      projectLateFinish: '',
      criticalPathDuration: 0,
      dataDate: '',
    };
  }

  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const predecessors = new Map<string, ActivityLink[]>();
  const successors = new Map<string, ActivityLink[]>();

  links.forEach((link) => {
    predecessors.set(link.successor_id, [...(predecessors.get(link.successor_id) || []), link]);
    successors.set(link.predecessor_id, [...(successors.get(link.predecessor_id) || []), link]);
  });

  // F1.1: resolve each activity onto its P6 calendar when one is assigned and usable;
  // the resolver's legacy branch reproduces the historical logic verbatim, so projects
  // without calendar assignments (or callers that pass no calendars) are unaffected.
  const p6ById = new Map((options.calendars || []).map((c) => [c.id, c]));
  const getActivityCalendar = (act: Activity): ProjectCalendar => {
    if (p6ById.size > 0 && act.calendar_id) {
      return resolveActivityExecutionCalendar(act, p6ById, defaultCalendar, customHolidays).calendar;
    }
    if (act.calendar_type) {
      return getCalendar(act.calendar_type, customHolidays);
    }
    return defaultCalendar;
  };

  // Topological sorting
  const order: Activity[] = [];
  const visited = new Set<string>();

  function topological(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    (successors.get(id) || []).forEach((link) => topological(link.successor_id));
    const activity = byId.get(id);
    if (activity) order.unshift(activity);
  }

  activities.forEach((activity) => topological(activity.id));

  // Determine Project Start Date & Data Date
  const baseProjectStart = activities.reduce((earliest, act) => {
    const s = act.actual_start || act.early_start;
    if (!s) return earliest;
    return !earliest || s < earliest ? s : earliest;
  }, new Date().toISOString().split('T')[0]);

  const defaultStart = getNextWorkingDay(baseProjectStart, defaultCalendar);
  const dataDate = options.dataDate
    ? getNextWorkingDay(options.dataDate, defaultCalendar)
    : defaultStart;

  // Track out-of-sequence activities and driving predecessors
  const outOfSequenceMap = new Map<string, boolean>();
  const drivingPredecessorsMap = new Map<string, string[]>();
  const linkDrivingResults: LinkDrivingResult[] = [];

  // 1. FORWARD PASS: Early Start (ES) and Early Finish (EF)
  const early = new Map<string, { start: string; finish: string; remDuration: number }>();

  for (const activity of order) {
    const cal = getActivityCalendar(activity);
    const actPreds = predecessors.get(activity.id) || [];
    const isCompleted = activity.percent_complete >= 100 || Boolean(activity.actual_finish);
    const isStarted = Boolean(activity.actual_start) || activity.percent_complete > 0;
    const isMilestone = activity.is_milestone || activity.activity_type === 'start_milestone' || activity.activity_type === 'finish_milestone';

    // F1.1: when this successor itself runs on a P6 calendar, relationship results are
    // placed onto it (lag still shifts on the predecessor basis inside calculateLinkDate).
    let succPlaceCal: ProjectCalendar | null = null;
    if (p6ById.size > 0 && activity.calendar_id) {
      const resolved = resolveActivityExecutionCalendar(activity, p6ById, defaultCalendar, customHolidays);
      if (resolved.source === 'activity_calendar' || resolved.source === 'activity_calendar_partial') {
        succPlaceCal = resolved.calendar;
      }
    }

    let totalDuration = isMilestone ? 0 : Math.max(1, Number(activity.duration_days || 1));
    let remainingDuration = totalDuration;

    if (isMilestone) {
      remainingDuration = 0;
    } else if (isCompleted) {
      remainingDuration = 0;
    } else if (isStarted) {
      if (activity.remaining_duration_days !== undefined && activity.remaining_duration_days !== null) {
        remainingDuration = Math.max(1, Number(activity.remaining_duration_days));
      } else {
        const pct = Math.min(99, Math.max(0, activity.percent_complete || 0));
        remainingDuration = Math.max(1, Math.round(totalDuration * (1 - pct / 100)));
      }
    }

    // Determine initial candidate early start
    let startCandidate = defaultStart;

    if (isCompleted && activity.actual_start) {
      startCandidate = activity.actual_start;
    } else if (isStarted && activity.actual_start && activity.actual_start < dataDate) {
      // In progress: actual start occurred before data date
      startCandidate = activity.actual_start;
    } else if (activity.early_start) {
      startCandidate = getNextWorkingDay(activity.early_start, cal);
    }

    // Check predecessors impact and calculate driving relationships
    let isOOS = false;
    const drivingPreds: string[] = [];

    if (actPreds.length > 0) {
      const predStarts: { link: ActivityLink; calcDate: string }[] = [];
      for (const link of actPreds) {
        const predDates = early.get(link.predecessor_id);
        const predAct = byId.get(link.predecessor_id);
        if (predDates && predAct) {
          const predCal = getActivityCalendar(predAct);
          const linkType = (link.link_type as 'FS' | 'SS' | 'FF' | 'SF') || 'FS';
          const calcStart = calculateLinkDate(
            predDates.start,
            predDates.finish,
            remainingDuration,
            linkType,
            effectiveLinkLagDays(link),
            predCal,
            succPlaceCal,
          );

          // Check for out of sequence execution (successor started before predecessor completed)
          if (isStarted && !predAct.actual_finish && linkType === 'FS') {
            isOOS = true;
          }

          if (statusLogic === 'progress_override' && isStarted) {
            predStarts.push({ link, calcDate: dataDate });
          } else {
            predStarts.push({ link, calcDate: calcStart });
          }
        }
      }

      if (predStarts.length > 0) {
        const maxPredStart = predStarts.reduce((max, d) => (d.calcDate > max ? d.calcDate : max), predStarts[0].calcDate);
        if (!isCompleted) {
          startCandidate = maxPredStart > startCandidate ? maxPredStart : startCandidate;
        }

        // Identify driving vs non-driving links
        for (const item of predStarts) {
          const isDriving = item.calcDate === startCandidate;
          if (isDriving) {
            drivingPreds.push(item.link.predecessor_id);
          }
          const diffDays = Math.max(0, countWorkingDays(item.calcDate, startCandidate, cal) - 1);
          linkDrivingResults.push({
            linkId: item.link.id,
            predecessorId: item.link.predecessor_id,
            successorId: item.link.successor_id,
            isDriving,
            drivingFloat: diffDays,
          });
        }
      }
    }
    outOfSequenceMap.set(activity.id, isOOS);
    drivingPredecessorsMap.set(activity.id, drivingPreds);

    // Apply Constraints during Forward Pass
    const constraint = activity.constraint_type;
    const constraintDate = activity.constraint_date ? getNextWorkingDay(activity.constraint_date, cal) : null;

    if (constraint && constraintDate && !isCompleted) {
      if (constraint === 'SNET' || constraint === 'MSO' || constraint === 'MS') {
        if (constraintDate > startCandidate) {
          startCandidate = constraintDate;
        }
      }
    }

    // For uncompleted activities, remaining work cannot start before Data Date unless already in progress
    let finishDate: string;
    if (isCompleted) {
      finishDate = activity.actual_finish || (totalDuration === 0 ? startCandidate : addWorkingDays(startCandidate, totalDuration, cal));
    } else if (isStarted && activity.actual_start) {
      const effectiveWorkStart = dataDate > activity.actual_start ? dataDate : activity.actual_start;
      finishDate = remainingDuration === 0 ? effectiveWorkStart : addWorkingDays(effectiveWorkStart, remainingDuration, cal);
    } else {
      if (dataDate > startCandidate) {
        startCandidate = dataDate;
      }
      finishDate = remainingDuration === 0 ? startCandidate : addWorkingDays(startCandidate, remainingDuration, cal);
    }

    // Check Expected Finish Date override
    if (activity.expected_finish_date && !isCompleted) {
      finishDate = getNextWorkingDay(activity.expected_finish_date, cal);
    }

    // Check Finish Constraints
    if (constraint && constraintDate && !isCompleted) {
      if (constraint === 'FNET' || constraint === 'MFO' || constraint === 'MF') {
        if (constraintDate > finishDate) {
          finishDate = constraintDate;
        }
      }
    }

    early.set(activity.id, {
      start: startCandidate,
      finish: finishDate,
      remDuration: remainingDuration,
    });
  }

  // Find latest project finish
  let projectEarlyFinish = defaultStart;
  let projectEarlyStart = defaultStart;
  let isFirst = true;

  for (const dates of early.values()) {
    if (isFirst || dates.start < projectEarlyStart) {
      projectEarlyStart = dates.start;
      isFirst = false;
    }
    if (dates.finish > projectEarlyFinish) {
      projectEarlyFinish = dates.finish;
    }
  }

  // 2. BACKWARD PASS: Late Start (LS) and Late Finish (LF)
  const late = new Map<string, { start: string; finish: string }>();

  for (const activity of [...order].reverse()) {
    const cal = getActivityCalendar(activity);
    const actSuccs = successors.get(activity.id) || [];
    const earlyDates = early.get(activity.id)!;
    const duration = earlyDates.remDuration;
    const constraint = activity.constraint_type;
    const constraintDate = activity.constraint_date ? getNextWorkingDay(activity.constraint_date, cal) : null;

    let calculatedLateFinish = projectEarlyFinish;

    if (actSuccs.length === 0) {
      calculatedLateFinish = projectEarlyFinish;
    } else {
      let minLateFinish: string | null = null;
      for (const link of actSuccs) {
        const succDates = late.get(link.successor_id);
        const succAct = byId.get(link.successor_id);
        if (succDates && succAct) {
          const succCal = getActivityCalendar(succAct);
          const linkType = (link.link_type as 'FS' | 'SS' | 'FF' | 'SF') || 'FS';
          const lag = effectiveLinkLagDays(link);

          // Backward pass: the exact inverse of the forward relationship rules.
          //
          // Under this engine's inclusive working-day convention a duration of n puts the finish
          // n - 1 working-day STEPS after the start. Writing D(x, y) for the signed number of
          // working-day steps from x to y (so D(x, x) = 0), calculateLinkDate implements:
          //
          //   forward rule                            backward rule (its inverse)
          //   FS  D(EF_pred, ES_succ) = 1 + lag  =>   LF_pred = LS_succ offset by -(1 + lag)
          //   SS  D(ES_pred, ES_succ) = lag      =>   LS_pred = LS_succ offset by -lag
          //   FF  D(EF_pred, EF_succ) = lag      =>   LF_pred = LF_succ offset by -lag
          //   SF  D(ES_pred, EF_succ) = lag      =>   LS_pred = LF_succ offset by -lag
          //
          // FS alone carries the extra step because the forward pass makes the successor start on
          // the NEXT working day after the predecessor finish — the same one-step gap the FS free
          // float formula already accounts for with its `- 2`. Inverting FS with only `-lag` left
          // the backward pass one working day looser than the forward pass at every FS hop, which
          // injected one phantom day of total float per hop: a 3 x 5-day FS+0 chain reported total
          // float 2/1/0 and marked only the last activity critical, so a fully driving chain was
          // presented as two thirds float.
          //
          // FS with lag -1 is the fixed point of the corrected rule (offset 0, LF_pred = LS_succ),
          // matching the forward pass where a one-day lead starts the successor exactly on the
          // predecessor finish. Leads of any other size keep their sign, so the negative-lag
          // behaviour established for FS and SF is preserved.
          //
          // F1.1: `lag` may be fractional (hour-derived). backwardLagShift negates the rounded
          // forward shift instead of rounding the negation, keeping the backward pass the
          // exact inverse at any precision; whole-day lags reduce to the rule above.
          const constrainedBySuccFinish = linkType === 'FF' || linkType === 'SF';
          const predecessorEventIsStart = linkType === 'SS' || linkType === 'SF';
          const backwardOffset = backwardLagShift(lag, linkType);

          const predecessorAnchor = offsetWorkingDays(
            constrainedBySuccFinish ? succDates.finish : succDates.start,
            backwardOffset,
            succCal,
          );

          // When the constrained predecessor event is its START, convert to a late FINISH with
          // the inclusive duration convention (a milestone keeps start == finish).
          const constraintFinish = predecessorEventIsStart && duration !== 0
            ? addWorkingDays(predecessorAnchor, duration, cal)
            : predecessorAnchor;

          if (!minLateFinish || constraintFinish < minLateFinish) {
            minLateFinish = constraintFinish;
          }
        }
      }
      calculatedLateFinish = minLateFinish || projectEarlyFinish;
    }

    // Apply Late Constraints
    if (constraint && constraintDate) {
      if (constraint === 'SNLT' || constraint === 'MSO' || constraint === 'MS') {
        const maxLFForStart = duration === 0 ? constraintDate : addWorkingDays(constraintDate, duration, cal);
        if (maxLFForStart < calculatedLateFinish) {
          calculatedLateFinish = maxLFForStart;
        }
      }
      if (constraint === 'FNLT' || constraint === 'MFO' || constraint === 'MF') {
        if (constraintDate < calculatedLateFinish) {
          calculatedLateFinish = constraintDate;
        }
      }
    }

    const calculatedLateStart = duration === 0 ? calculatedLateFinish : subtractWorkingDays(calculatedLateFinish, duration, cal);
    late.set(activity.id, { start: calculatedLateStart, finish: calculatedLateFinish });
  }

  // 3. FLOATS & CRITICAL PATH / LONGEST PATH CALCULATION
  const intermediateResults = activities.map((activity) => {
    const cal = getActivityCalendar(activity);
    const e = early.get(activity.id) || { start: defaultStart, finish: defaultStart, remDuration: 1 };
    const l = late.get(activity.id) || { start: e.start, finish: e.finish };

    // Total Float in working days (LF - EF)
    let totalFloat = 0;
    if (e.finish === l.finish) {
      totalFloat = 0;
    } else if (l.finish > e.finish) {
      totalFloat = countWorkingDays(e.finish, l.finish, cal) - 1;
    } else {
      totalFloat = -(countWorkingDays(l.finish, e.finish, cal) - 1);
    }

    // Free Float = min(Early Start of Successors - Lag - Early Finish)
    const actSuccs = successors.get(activity.id) || [];
    let freeFloat = totalFloat;

    if (actSuccs.length > 0) {
      let minFF = Infinity;
      for (const link of actSuccs) {
        const succEarly = early.get(link.successor_id);
        const succAct = byId.get(link.successor_id);
        if (succEarly && succAct) {
          const succCal = getActivityCalendar(succAct);
          const linkType = (link.link_type as 'FS' | 'SS' | 'FF' | 'SF') || 'FS';
          // F1.1: free float consumes the same rounded forward shift the forward pass
          // placed, so a driving fractional link still reports zero free float. Whole-day
          // lags reduce to the historical `- lag` verbatim.
          const lag = forwardLagShift(effectiveLinkLagDays(link), linkType);

          // Free float per relationship type (GAP-013): the working-day slack between the
          // predecessor event that drives the link and the successor event that link constrains,
          // less the lag. countWorkingDays is INCLUSIVE (same day = 1), hence the -1; FS also
          // consumes the mandatory one-working-day gap between a predecessor finish and a
          // successor start, hence its -2.
          //
          //   FS  EF_pred vs ES_succ   SS  ES_pred vs ES_succ
          //   FF  EF_pred vs EF_succ   SF  ES_pred vs EF_succ
          //
          // SF previously fell through to the FS branch, which measured the wrong event pair
          // (EF_pred vs ES_succ). Under the inclusive convention that understated SF free float by
          // (predecessor duration + successor duration - 1) working days — 9 days for two 5-day
          // activities — so a genuinely float-free SF link was reported as slack.
          let availableDays = 0;
          switch (linkType) {
            case 'SS':
              availableDays = countWorkingDays(e.start, succEarly.start, succCal) - 1 - lag;
              break;
            case 'FF':
              availableDays = countWorkingDays(e.finish, succEarly.finish, succCal) - 1 - lag;
              break;
            case 'SF':
              availableDays = countWorkingDays(e.start, succEarly.finish, succCal) - 1 - lag;
              break;
            case 'FS':
            default:
              availableDays = countWorkingDays(e.finish, succEarly.start, succCal) - 2 - lag;
              break;
          }
          if (availableDays < minFF) minFF = availableDays;
        }
      }
      freeFloat = minFF === Infinity ? totalFloat : Math.max(0, Math.min(totalFloat, minFF));
    }

    const isCritical = totalFloat <= 0 && activity.percent_complete < 100;

    return {
      activityId: activity.id,
      activityCode: activity.code,
      earlyStart: e.start,
      earlyFinish: e.finish,
      lateStart: l.start,
      lateFinish: l.finish,
      totalFloat: Math.round(totalFloat),
      freeFloat: Math.round(Math.max(0, freeFloat)),
      isCritical,
      isLongestPath: isCritical,
      activityDrag: 0,
      remainingDuration: e.remDuration,
      outOfSequence: outOfSequenceMap.get(activity.id) || false,
      drivingPredecessorIds: drivingPredecessorsMap.get(activity.id) || [],
    };
  });

  // 4. CRITICAL PATH DRAG COMPUTATION
  const criticalActivities = intermediateResults.filter((r) => r.isCritical);
  const minNonCriticalFloat = intermediateResults
    .filter((r) => !r.isCritical && r.totalFloat > 0)
    .reduce((min, r) => (r.totalFloat < min ? r.totalFloat : min), Infinity);

  const results: CpmResult[] = intermediateResults.map((item) => {
    let drag = 0;
    if (item.isCritical) {
      if (item.remainingDuration === 0) {
        drag = 0;
      } else if (criticalActivities.length === 1 || minNonCriticalFloat === Infinity) {
        drag = item.remainingDuration;
      } else {
        drag = Math.min(item.remainingDuration, minNonCriticalFloat);
      }
    }
    return {
      ...item,
      activityDrag: Math.max(0, drag),
    };
  });

  const criticalPathDuration = countWorkingDays(projectEarlyStart, projectEarlyFinish, defaultCalendar);

  return {
    results,
    linkResults: linkDrivingResults,
    cycle: null,
    projectEarlyStart,
    projectEarlyFinish,
    projectLateFinish: projectEarlyFinish,
    criticalPathDuration,
    dataDate,
  };
}

import type { Activity, ActivityLink, CalendarType, ProjectCalendar, ActivityConstraintType } from '@/types';
import {
  getCalendar,
  isWorkingDay,
  getNextWorkingDay,
  getPreviousWorkingDay,
  addWorkingDays,
  subtractWorkingDays,
  countWorkingDays,
  calculateLinkDate,
} from './calendarEngine';

export interface CpmOptions {
  calendarType?: CalendarType;
  customHolidays?: string[];
  dataDate?: string | null;
  statusLogic?: 'retained_logic' | 'progress_override';
  calculateDrag?: boolean;
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

  // Helper to get calendar for specific activity
  const getActivityCalendar = (act: Activity): ProjectCalendar => {
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
            link.lag_days || 0,
            predCal,
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
          const lag = link.lag_days || 0;
          let constraintFinish = succDates.start;

          if (linkType === 'FS') {
            constraintFinish = subtractWorkingDays(succDates.start, Math.max(1, lag + 1), succCal);
          } else if (linkType === 'FF') {
            constraintFinish = lag > 0
              ? subtractWorkingDays(succDates.finish, lag + 1, succCal)
              : addWorkingDays(succDates.finish, Math.abs(lag) + 1, succCal);
          } else if (linkType === 'SS') {
            const predStartLim = lag > 0
              ? subtractWorkingDays(succDates.start, lag + 1, succCal)
              : addWorkingDays(succDates.start, Math.abs(lag) + 1, succCal);
            constraintFinish = duration === 0 ? predStartLim : addWorkingDays(predStartLim, duration, cal);
          } else if (linkType === 'SF') {
            const predStartLim = subtractWorkingDays(succDates.finish, Math.max(1, lag + 1), succCal);
            constraintFinish = duration === 0 ? predStartLim : addWorkingDays(predStartLim, duration, cal);
          }

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
          const lag = link.lag_days || 0;
          let availableDays = 0;
          if (link.link_type === 'SS') {
            availableDays = countWorkingDays(e.start, succEarly.start, succCal) - 1 - lag;
          } else if (link.link_type === 'FF') {
            availableDays = countWorkingDays(e.finish, succEarly.finish, succCal) - 1 - lag;
          } else {
            availableDays = countWorkingDays(e.finish, succEarly.start, succCal) - 2 - lag;
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

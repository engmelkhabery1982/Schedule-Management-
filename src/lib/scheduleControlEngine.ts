/**
 * F5 — Schedule Updating & Control Intelligence.
 *
 * A pure, deterministic decision layer over the canonical statused CPM. It never re-implements
 * scheduling math: every date, float and driving relationship comes from `calculateCpm` called
 * with an explicit Data Date. This module only (a) validates update inputs against the single
 * governed Data Date, (b) compares the statused schedule against baseline and previous update,
 * and (c) derives evidence-traced control findings (variances, migration, erosion, milestones,
 * attribution, lookahead, forecast accuracy, actions, confidence).
 *
 * Hard rules (locked by the F5 charter):
 * - Single Data Date discipline: any actual / progress dated after the Data Date is rejected
 *   (update entries) or reported as an integrity error (stored data). No machine date anywhere.
 * - Canonical CPM only: no second forward/backward pass, no EVM/DCMA formula changes.
 * - Evidence-only attribution: a delay cause is named only when stored data proves it, else the
 *   activity is reported as `unattributed`. Missing inputs surface as N/A (null), never as
 *   fabricated defaults.
 * - Working-day deltas use the inclusive `countWorkingDays` convention shared with the CPM
 *   engine (`same day = 1`, so a signed delta subtracts 1). The ruler calendar is the
 *   activity's own `calendar_type` when set, else the project calendar passed in.
 */

import { calculateCpm } from './cpmEngine';
import { countWorkingDays, getCalendar } from './calendarEngine';
import { calendarDaysBetween, isAfterDataDate, isIsoDate } from './chronologyGuard';
import type {
  Activity,
  ActivityLink,
  BaselineActivity,
  CalendarType,
  ProgressUpdate,
  ProjectCalendar,
  ScheduleSnapshotDetails,
  ScheduleUpdateSnapshot,
} from '@/types';

/** F5: near-critical band is strictly 0 < TF <= 5 working days (critical itself excluded). */
export const NEAR_CRITICAL_TF_DAYS = 5;
/** F5: lookahead horizons in calendar days from the Data Date (2 / 4 / 6 weeks). */
export const LOOKAHEAD_WINDOWS_DAYS = [14, 28, 42] as const;
/** F5: a prior forecast within ±2 working days of the actual finish counts as a match. */
export const FORECAST_MATCH_TOLERANCE_WD = 2;
/** F5: milestone slip bands — 1..5 working days late is at-risk, beyond 5 is slipped. */
export const MILESTONE_AT_RISK_WD = 5;
/**
 * F5: low-production detection threshold. Quantity progress more than 10 percentage points
 * behind time-elapsed progress (both measured against plan) is reported as low production.
 */
export const LOW_PRODUCTION_TOLERANCE_PP = 10;
/** F5: an update with no approved progress evidence inside 7 calendar days is flagged stale. */
export const UPDATE_STALENESS_DAYS = 7;

export type IntegritySeverity = 'error' | 'warning' | 'info';
export type ConfidenceLevel = 'High' | 'Medium' | 'Low';

export interface IntegrityFinding {
  severity: IntegritySeverity;
  code: string;
  activityId: string | null;
  activityCode: string | null;
  message: string;
  evidence: string[];
}

export interface ProgressEntry {
  activityId: string;
  updateDate: string;
  percentComplete?: number | null;
  actualStart?: string | null;
  actualFinish?: string | null;
  remainingDuration?: number | null;
  actualQuantity?: number | null;
}

export interface ApplyUpdateResult {
  activities: Activity[];
  applied: string[];
  rejected: Array<{ activityId: string; activityCode: string | null; errors: IntegrityFinding[] }>;
  findings: IntegrityFinding[];
}

export interface StatusedActivity {
  id: string;
  code: string;
  name: string;
  isMilestone: boolean;
  started: boolean;
  completed: boolean;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number;
  remaining: number | null;
  earlyStart: string;
  earlyFinish: string;
  totalFloat: number;
  freeFloat: number;
  critical: boolean;
  /** Actual finish when finished, else the statused early finish. Null when unschedulable. */
  forecastFinish: string | null;
  outOfSequence: boolean;
  drivingPredecessors: string[];
}

export interface ActivityVariance {
  id: string;
  code: string;
  hasBaseline: boolean;
  baselineStart: string | null;
  baselineFinish: string | null;
  baselineDuration: number | null;
  currentStart: string;
  currentFinish: string;
  startVarianceWd: number | null;
  finishVarianceWd: number | null;
  durationVarianceWd: number | null;
  baselineFloat: number | null;
  currentFloat: number;
  /** Current TF minus baseline TF; null for legacy baselines that stored no float. */
  floatChange: number | null;
}

export interface CriticalMigration {
  hasPrevious: boolean;
  enteredCritical: string[];
  leftCritical: string[];
  newDrivingLinkIds: string[];
  floatErosion: Array<{ id: string; code: string; prevTf: number; curTf: number; erosion: number }>;
}

export interface NearCriticalItem {
  id: string;
  code: string;
  name: string;
  tf: number;
  prevTf: number | null;
  erosion: number | null;
  /**
   * Working days until TF hits zero at the observed erosion rate between the previous and
   * current Data Date. Null when not eroding, when the rate is unmeasurable, or when there is
   * no previous update.
   */
  daysUntilCritical: number | null;
}

export type MilestoneState = 'achieved' | 'on_track' | 'at_risk' | 'slipped' | 'unknown';

export interface MilestoneStatus {
  id: string;
  code: string;
  name: string;
  baselineDate: string | null;
  forecastDate: string | null;
  varianceWd: number | null;
  state: MilestoneState;
}

export type DelayCause =
  | 'resource_constraint'
  | 'predecessor_delay'
  | 'late_actual_start'
  | 'remaining_increase'
  | 'low_production'
  | 'logic_change'
  | 'calendar_change'
  | 'unattributed';

export interface DelayAttribution {
  activityId: string;
  code: string;
  finishVarianceWd: number;
  causes: Array<{ cause: DelayCause; evidence: string[] }>;
  primary: DelayCause;
}

export interface LookaheadBlocker {
  code: string;
  forecastFinish: string | null;
  delaysSuccessorStart: boolean;
}

export interface LookaheadItem {
  id: string;
  code: string;
  name: string;
  earlyStart: string;
  earlyFinish: string;
  remaining: number;
  tf: number;
  critical: boolean;
  nearCritical: boolean;
  startsInWindow: boolean;
  finishesInWindow: boolean;
  blockers: LookaheadBlocker[];
}

export interface ForecastAccuracy {
  hasPrevious: boolean;
  /** Signed working-day drift of the project forecast finish since the previous update. */
  driftWd: number | null;
  completedSince: number;
  matched: number;
  lateVsForecast: number;
  earlyVsForecast: number;
  meanAbsErrWd: number | null;
  bias: 'optimistic' | 'pessimistic' | 'neutral' | 'insufficient';
}

export interface ControlAction {
  rank: number;
  issue: string;
  evidence: string[];
  impact: string;
  action: string;
  confidence: ConfidenceLevel;
}

export interface KpiConfidence {
  level: ConfidenceLevel;
  sources: string[];
  notes: string[];
}

export interface ScheduleControlInput {
  activities: Activity[];
  links: ActivityLink[];
  baselines: BaselineActivity[];
  progressUpdates?: ProgressUpdate[];
  previousSnapshot?: ScheduleUpdateSnapshot | null;
  dataDate: string;
  calendarType?: CalendarType;
  statusLogic?: 'retained_logic' | 'progress_override';
  /** Optional caller-supplied progress (e.g. EVM-derived); else duration-weighted is computed. */
  progressPctOverride?: number | null;
}

export interface ScheduleControlReport {
  dataDate: string;
  statusLogic: 'retained_logic' | 'progress_override';
  integrity: IntegrityFinding[];
  /** Sorted ids of currently driving links; stored so the next update can diff migration. */
  drivingLinkIds: string[];
  statused: StatusedActivity[];
  project: {
    baselineFinish: string | null;
    forecastFinish: string | null;
    totalDelayWd: number | null;
    delayVsPreviousWd: number | null;
    criticalCount: number;
    nearCriticalCount: number;
    progressPct: number | null;
    progressSource: 'override' | 'duration_weighted' | 'unavailable';
  };
  variances: ActivityVariance[];
  migration: CriticalMigration;
  nearCritical: NearCriticalItem[];
  milestones: MilestoneStatus[];
  attribution: DelayAttribution[];
  lookahead: Record<'w14' | 'w28' | 'w42', LookaheadItem[]>;
  accuracy: ForecastAccuracy;
  actions: ControlAction[];
  confidence: Record<'forecastFinish' | 'totalDelay' | 'criticalPath' | 'milestones' | 'progressPct', KpiConfidence>;
}

export interface ScheduleSnapshotPayload {
  project_id: string;
  data_date: string;
  forecast_finish: string | null;
  progress_pct: number | null;
  critical_count: number;
  near_critical_count: number;
  total_delay_days: number | null;
  delay_vs_previous_days: number | null;
  milestones_slipped: number;
  details: ScheduleSnapshotDetails;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function rulerCal(activity: Activity, projectCal: CalendarType): ProjectCalendar {
  return getCalendar(activity.calendar_type || projectCal);
}

/**
 * Signed working-day distance `to - from` on `cal` (0 when equal). Uses the inclusive
 * `countWorkingDays` convention shared with the CPM engine and the F4 leveling engine.
 */
export function workingDayDelta(from: string, to: string, cal: ProjectCalendar): number | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  if (from === to) return 0;
  if (to > from) return countWorkingDays(from, to, cal) - 1;
  return -(countWorkingDays(to, from, cal) - 1);
}

function addCalendarDays(date: string, days: number): string | null {
  if (!isIsoDate(date)) return null;
  const ms = new Date(`${date}T00:00:00Z`).getTime() + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function byCode<T extends { code: string }>(a: T, b: T): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function lagOf(link: ActivityLink): number {
  return typeof link.lag_days_exact === 'number' && Number.isFinite(link.lag_days_exact)
    ? link.lag_days_exact
    : Number(link.lag_days) || 0;
}

/** Stable incoming-logic signature per activity; changes prove a logic revision (F5 §8). */
function linkSignature(activityId: string, links: ActivityLink[]): string {
  return links
    .filter((l) => l.successor_id === activityId)
    .map((l) => `${l.predecessor_id}:${l.link_type}:${lagOf(l)}`)
    .sort()
    .join('|');
}

function prevActivityOf(
  snap: ScheduleUpdateSnapshot | null | undefined,
  activityId: string,
): ScheduleSnapshotDetails['activities'][string] | null {
  if (!snap || !snap.details || snap.details.version !== 1) return null;
  return snap.details.activities[activityId] || null;
}

// ---------------------------------------------------------------------------
// §1 + §3 — progress integrity (shared by stored-data checks and update entry)
// ---------------------------------------------------------------------------

function inspectActivity(
  act: Activity,
  dataDate: string,
  hasApprovedUpdate: boolean,
): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  const id = act.id;
  const code = act.code || null;
  const push = (severity: IntegritySeverity, c: string, message: string, evidence: string[] = []) => {
    out.push({ severity, code: c, activityId: id, activityCode: code, message, evidence });
  };

  const pct = Number(act.percent_complete);
  const pctOk = Number.isFinite(pct) && pct >= 0 && pct <= 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    push('error', 'percent_out_of_range', `Percent complete ${String(act.percent_complete)} is outside 0..100.`, [
      `stored percent_complete = ${String(act.percent_complete)}`,
    ]);
  }
  if (act.actual_start && !isIsoDate(act.actual_start)) {
    push('error', 'bad_actual_start', `Actual start ${act.actual_start} is not a usable date.`, [
      `stored actual_start = ${act.actual_start}`,
    ]);
  } else if (isAfterDataDate(act.actual_start, dataDate)) {
    push('error', 'future_actual_start', `Actual start ${act.actual_start} is after the Data Date ${dataDate}.`, [
      `actual_start = ${act.actual_start}`,
      `data_date = ${dataDate}`,
    ]);
  }
  if (act.actual_finish && !isIsoDate(act.actual_finish)) {
    push('error', 'bad_actual_finish', `Actual finish ${act.actual_finish} is not a usable date.`, [
      `stored actual_finish = ${act.actual_finish}`,
    ]);
  } else if (isAfterDataDate(act.actual_finish, dataDate)) {
    push('error', 'future_actual_finish', `Actual finish ${act.actual_finish} is after the Data Date ${dataDate}.`, [
      `actual_finish = ${act.actual_finish}`,
      `data_date = ${dataDate}`,
    ]);
  }
  if (
    isIsoDate(act.actual_start) && isIsoDate(act.actual_finish)
    && (act.actual_start as string) > (act.actual_finish as string)
  ) {
    push('error', 'actual_start_after_finish', 'Actual start is after actual finish.', [
      `actual_start = ${act.actual_start}`,
      `actual_finish = ${act.actual_finish}`,
    ]);
  }

  const remaining = act.remaining_duration_days;
  if (remaining !== undefined && remaining !== null) {
    if (!Number.isFinite(Number(remaining)) || Number(remaining) < 0) {
      push('error', 'negative_remaining', 'Remaining duration is negative.', [
        `stored remaining_duration_days = ${String(remaining)}`,
      ]);
    } else if (Number(remaining) > Number(act.duration_days || 0)) {
      push('warning', 'remaining_exceeds_duration', 'Remaining duration exceeds the planned duration.', [
        `remaining_duration_days = ${remaining}`,
        `duration_days = ${act.duration_days}`,
      ]);
    }
  }
  if (pctOk && pct >= 100 && !act.actual_finish) {
    push('warning', 'complete_without_actual_finish', 'Activity is 100% but carries no actual finish date.', [
      `percent_complete = ${pct}`,
      'actual_finish is missing',
    ]);
  }
  if (act.actual_finish && pctOk && pct < 100) {
    push('warning', 'finish_without_complete', 'Activity has an actual finish but is below 100%.', [
      `actual_finish = ${act.actual_finish}`,
      `percent_complete = ${pct}`,
    ]);
  }
  if (pctOk && pct >= 100 && remaining !== undefined && remaining !== null && Number(remaining) > 0) {
    push('warning', 'remaining_after_complete', 'Activity is 100% yet still shows remaining duration.', [
      `percent_complete = ${pct}`,
      `remaining_duration_days = ${remaining}`,
    ]);
  }
  if (act.actual_start && pctOk && pct < 100 && remaining === 0) {
    push('warning', 'zero_remaining_incomplete', 'Activity started with zero remaining duration but is incomplete.', [
      `actual_start = ${act.actual_start}`,
      `percent_complete = ${pct}`,
      'remaining_duration_days = 0',
    ]);
  }

  const plannedQty = Number(act.planned_quantity);
  const actualQty = Number(act.actual_quantity);
  if (Number.isFinite(plannedQty) && plannedQty > 0 && Number.isFinite(actualQty) && actualQty > plannedQty) {
    push('warning', 'quantity_overrun', 'Actual quantity exceeds the planned quantity.', [
      `actual_quantity = ${actualQty}`,
      `planned_quantity = ${plannedQty}`,
    ]);
  }
  if (Number.isFinite(actualQty) && actualQty > 0 && pctOk && pct === 0) {
    push('warning', 'quantity_without_progress', 'Actual quantity exists but progress is 0%.', [
      `actual_quantity = ${actualQty}`,
      'percent_complete = 0',
    ]);
  }
  if (pctOk && pct > 0 && !act.actual_start && !hasApprovedUpdate) {
    push('info', 'progress_without_source', 'Progress has no recorded source (no actual start, no approved update).', [
      `percent_complete = ${pct}`,
      'actual_start is missing',
      'no approved progress_updates row',
    ]);
  }
  if (act.actual_start && pctOk && pct === 0) {
    push('info', 'started_zero_progress', 'Activity started but still shows 0% progress.', [
      `actual_start = ${act.actual_start}`,
      'percent_complete = 0',
    ]);
  }
  return out;
}

/**
 * §1 + §3: integrity of stored progress against the single governed Data Date.
 * Only `approved` update rows count as progress evidence.
 */
export function checkProgressIntegrity(
  activities: Activity[],
  progressUpdates: ProgressUpdate[],
  dataDate: string,
): IntegrityFinding[] {
  const approvedByAct = new Map<string, ProgressUpdate[]>();
  for (const u of progressUpdates) {
    if (u.status !== 'approved') continue;
    const list = approvedByAct.get(u.activity_id) || [];
    list.push(u);
    approvedByAct.set(u.activity_id, list);
  }
  const findings: IntegrityFinding[] = [];
  const sorted = [...activities].sort(byCode);
  for (const act of sorted) {
    findings.push(...inspectActivity(act, dataDate, (approvedByAct.get(act.id) || []).length > 0));
  }
  const codeById = new Map(activities.map((a) => [a.id, a.code]));
  const rows = [...progressUpdates].sort((a, b) =>
    a.update_date < b.update_date ? -1 : a.update_date > b.update_date ? 1 : a.id < b.id ? -1 : 1,
  );
  for (const u of rows) {
    if (!isIsoDate(u.update_date)) {
      findings.push({
        severity: 'warning', code: 'undated_progress_update',
        activityId: u.activity_id, activityCode: codeById.get(u.activity_id) || null,
        message: `Progress update ${u.id} carries no usable date and cannot count as evidence.`,
        evidence: [`progress_updates.id = ${u.id}`],
      });
    } else if (isAfterDataDate(u.update_date, dataDate)) {
      findings.push({
        severity: 'error', code: 'future_progress_update',
        activityId: u.activity_id, activityCode: codeById.get(u.activity_id) || null,
        message: `Progress update dated ${u.update_date} is after the Data Date ${dataDate}.`,
        evidence: [`update_date = ${u.update_date}`, `data_date = ${dataDate}`],
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// §2 — governed update application (validate, then status via canonical CPM)
// ---------------------------------------------------------------------------

/**
 * §2: apply a batch of progress entries onto activity clones. Entries dated after the Data
 * Date, or producing actuals/quantities that violate §1/§3 error rules, are rejected and the
 * activity clone is left untouched. Warnings attach but do not reject. Callers persist the
 * returned clones and re-run the canonical CPM — the engine itself never writes storage.
 */
export function applyProgressUpdate(
  activities: Activity[],
  entries: ProgressEntry[],
  dataDate: string,
): ApplyUpdateResult {
  const clones = new Map(activities.map((a) => [a.id, { ...a }]));
  const applied: string[] = [];
  const rejected: ApplyUpdateResult['rejected'] = [];
  const findings: IntegrityFinding[] = [];

  for (const e of entries) {
    const target = clones.get(e.activityId);
    if (!target) {
      const err: IntegrityFinding = {
        severity: 'error', code: 'unknown_activity', activityId: e.activityId, activityCode: null,
        message: `Progress entry references unknown activity ${e.activityId}.`,
        evidence: [`update_date = ${e.updateDate}`],
      };
      rejected.push({ activityId: e.activityId, activityCode: null, errors: [err] });
      findings.push(err);
      continue;
    }
    const entryErrors: IntegrityFinding[] = [];
    if (!isIsoDate(e.updateDate) || isAfterDataDate(e.updateDate, dataDate)) {
      entryErrors.push({
        severity: 'error', code: 'future_progress_update', activityId: target.id, activityCode: target.code,
        message: `Update date ${e.updateDate} is not on or before the Data Date ${dataDate}; entry rejected.`,
        evidence: [`update_date = ${e.updateDate}`, `data_date = ${dataDate}`],
      });
    }
    if (e.percentComplete !== undefined && e.percentComplete !== null
      && (!Number.isFinite(e.percentComplete) || e.percentComplete < 0 || e.percentComplete > 100)) {
      entryErrors.push({
        severity: 'error', code: 'percent_out_of_range', activityId: target.id, activityCode: target.code,
        message: `Entered percent ${String(e.percentComplete)} is outside 0..100; entry rejected.`,
        evidence: [`percent_complete = ${String(e.percentComplete)}`],
      });
    }
    if (e.remainingDuration !== undefined && e.remainingDuration !== null
      && (!Number.isFinite(e.remainingDuration) || e.remainingDuration < 0)) {
      entryErrors.push({
        severity: 'error', code: 'negative_remaining', activityId: target.id, activityCode: target.code,
        message: 'Entered remaining duration is negative; entry rejected.',
        evidence: [`remaining_duration_days = ${String(e.remainingDuration)}`],
      });
    }
    if (e.actualQuantity !== undefined && e.actualQuantity !== null
      && (!Number.isFinite(e.actualQuantity) || e.actualQuantity < 0)) {
      entryErrors.push({
        severity: 'error', code: 'negative_quantity', activityId: target.id, activityCode: target.code,
        message: 'Entered actual quantity is negative; entry rejected.',
        evidence: [`actual_quantity = ${String(e.actualQuantity)}`],
      });
    }
    if (entryErrors.length > 0) {
      rejected.push({ activityId: target.id, activityCode: target.code, errors: entryErrors });
      findings.push(...entryErrors);
      continue;
    }

    const merged: Activity = { ...target };
    if (e.percentComplete !== undefined && e.percentComplete !== null) merged.percent_complete = e.percentComplete;
    if (e.actualStart !== undefined) merged.actual_start = e.actualStart;
    if (e.actualFinish !== undefined) merged.actual_finish = e.actualFinish;
    if (e.remainingDuration !== undefined && e.remainingDuration !== null) {
      merged.remaining_duration_days = Math.round(e.remainingDuration);
    }
    if (e.actualQuantity !== undefined && e.actualQuantity !== null) merged.actual_quantity = e.actualQuantity;

    const mergedFindings = inspectActivity(merged, dataDate, true);
    const fatal = mergedFindings.filter((f) => f.severity === 'error');
    if (fatal.length > 0) {
      rejected.push({ activityId: target.id, activityCode: target.code, errors: fatal });
      findings.push(...mergedFindings);
      continue;
    }
    clones.set(target.id, merged);
    applied.push(target.code);
    findings.push(...mergedFindings);
  }

  return { activities: activities.map((a) => clones.get(a.id) as Activity), applied, rejected, findings };
}

// ---------------------------------------------------------------------------
// §4–§13 — the control analysis
// ---------------------------------------------------------------------------

export function analyzeScheduleControl(input: ScheduleControlInput): ScheduleControlReport {
  const {
    activities, links, baselines, dataDate,
    statusLogic = 'retained_logic',
    calendarType = '6_days',
  } = input;
  const progressUpdates = input.progressUpdates || [];
  const previousSnapshot = input.previousSnapshot || null;
  const prevDD = previousSnapshot && isIsoDate(previousSnapshot.data_date) ? previousSnapshot.data_date : null;

  const integrity = checkProgressIntegrity(activities, progressUpdates, dataDate);

  // The ONLY scheduling calculation in F5: canonical statused CPM with an explicit Data Date.
  const cpm = activities.length > 0
    ? calculateCpm(activities, links, { calendarType, dataDate, statusLogic })
    : null;
  const results = cpm ? cpm.results : [];
  const linkResults = cpm ? cpm.linkResults : [];
  const resultById = new Map(results.map((r) => [r.activityId, r]));
  const drivingLinkIds = new Set(linkResults.filter((l) => l.isDriving).map((l) => l.linkId));
  const drivingBySucc = new Map<string, ActivityLink[]>();
  for (const l of links) {
    if (!drivingLinkIds.has(l.id)) continue;
    const list = drivingBySucc.get(l.successor_id) || [];
    list.push(l);
    drivingBySucc.set(l.successor_id, list);
  }

  const codeById = new Map(activities.map((a) => [a.id, a.code]));
  const actById = new Map(activities.map((a) => [a.id, a]));
  const sorted = [...activities].sort(byCode);

  // --- statused activities + forecast finishes (§2 read-out) ---
  const statused: StatusedActivity[] = sorted.map((a) => {
    const r = resultById.get(a.id);
    const pct = Number(a.percent_complete) || 0;
    const completed = pct >= 100 || !!a.actual_finish;
    const started = !!a.actual_start || pct > 0;
    const forecastFinish = a.actual_finish || (r ? r.earlyFinish : null);
    return {
      id: a.id, code: a.code, name: a.name, isMilestone: !!a.is_milestone,
      started, completed,
      actualStart: a.actual_start || null, actualFinish: a.actual_finish || null,
      percentComplete: pct,
      remaining: a.remaining_duration_days ?? null,
      earlyStart: r ? r.earlyStart : (a.actual_start || dataDate),
      earlyFinish: r ? r.earlyFinish : (a.actual_finish || dataDate),
      totalFloat: r ? r.totalFloat : 0,
      freeFloat: r ? r.freeFloat : 0,
      critical: r ? r.isCritical : false,
      forecastFinish: forecastFinish || null,
      outOfSequence: r ? r.outOfSequence : false,
      drivingPredecessors: r && r.drivingPredecessorIds ? [...r.drivingPredecessorIds] : [],
    };
  });
  const statusById = new Map(statused.map((s) => [s.id, s]));

  // --- §4 variances vs baseline ---
  const baselineByAct = new Map(baselines.map((b) => [b.activity_id, b]));
  const variances: ActivityVariance[] = statused.map((s) => {
    const act = actById.get(s.id) as Activity;
    const b = baselineByAct.get(s.id);
    const cal = rulerCal(act, calendarType);
    const currentStart = s.actualStart || s.earlyStart;
    const currentFinish = s.actualFinish || s.earlyFinish;
    const baselineFloat = b && typeof b.total_float === 'number' && Number.isFinite(b.total_float)
      ? b.total_float : null;
    let durationVarianceWd: number | null = null;
    if (b) {
      if (s.completed && isIsoDate(s.actualStart) && isIsoDate(s.actualFinish)) {
        durationVarianceWd = countWorkingDays(s.actualStart as string, s.actualFinish as string, cal)
          - Number(b.duration_days || 0);
      } else {
        durationVarianceWd = Number(act.duration_days || 0) - Number(b.duration_days || 0);
      }
    }
    return {
      id: s.id, code: s.code, hasBaseline: !!b,
      baselineStart: b ? b.early_start : null,
      baselineFinish: b ? b.early_finish : null,
      baselineDuration: b ? Number(b.duration_days) : null,
      currentStart, currentFinish,
      startVarianceWd: b ? workingDayDelta(b.early_start, currentStart, cal) : null,
      finishVarianceWd: b ? workingDayDelta(b.early_finish, currentFinish, cal) : null,
      durationVarianceWd,
      baselineFloat,
      currentFloat: s.totalFloat,
      floatChange: baselineFloat !== null ? round1(s.totalFloat - baselineFloat) : null,
    };
  });
  const varById = new Map(variances.map((v) => [v.id, v]));

  let baselineFinish: string | null = null;
  for (const b of baselines) {
    if (isIsoDate(b.early_finish) && (baselineFinish === null || b.early_finish > baselineFinish)) {
      baselineFinish = b.early_finish;
    }
  }
  // Never surface the canonical engine's degenerate fallback: with no activities there is no
  // forecast, and the report says so (N/A) instead of echoing a seed date.
  const forecastFinish = activities.length > 0 && cpm && isIsoDate(cpm.projectEarlyFinish)
    ? cpm.projectEarlyFinish : null;
  const projectRuler = getCalendar(calendarType);
  const totalDelayWd = baselineFinish && forecastFinish
    ? workingDayDelta(baselineFinish, forecastFinish, projectRuler) : null;
  const delayVsPreviousWd = previousSnapshot && isIsoDate(previousSnapshot.forecast_finish) && forecastFinish
    ? workingDayDelta(previousSnapshot.forecast_finish as string, forecastFinish, projectRuler) : null;

  let durNum = 0;
  let durDen = 0;
  for (const a of activities) {
    const d = Number(a.duration_days) || 0;
    if (d > 0) {
      durNum += d * (Number(a.percent_complete) || 0);
      durDen += d;
    }
  }
  const override = input.progressPctOverride;
  const progressPct = override !== undefined && override !== null && Number.isFinite(override)
    ? round3(override)
    : durDen > 0 ? round3(durNum / durDen) : null;
  const progressSource = override !== undefined && override !== null && Number.isFinite(override)
    ? 'override' : durDen > 0 ? 'duration_weighted' : 'unavailable';

  const criticalCount = statused.filter((s) => s.critical).length;
  const nearCriticalList: NearCriticalItem[] = [];
  for (const s of statused) {
    if (s.completed || s.totalFloat <= 0 || s.totalFloat > NEAR_CRITICAL_TF_DAYS) continue;
    const prev = prevActivityOf(previousSnapshot, s.id);
    const prevTf = prev && typeof prev.tf === 'number' ? prev.tf : null;
    const erosion = prevTf !== null ? round1(prevTf - s.totalFloat) : null;
    let daysUntilCritical: number | null = null;
    if (erosion !== null && erosion > 0 && prevDD) {
      const elapsed = workingDayDelta(prevDD, dataDate, rulerCal(actById.get(s.id) as Activity, calendarType));
      if (elapsed !== null && elapsed > 0) {
        daysUntilCritical = Math.ceil(s.totalFloat / (erosion / elapsed));
      }
    }
    nearCriticalList.push({
      id: s.id, code: s.code, name: s.name, tf: s.totalFloat,
      prevTf, erosion, daysUntilCritical,
    });
  }

  // --- §5 migration vs previous update ---
  const prevDetails = previousSnapshot && previousSnapshot.details && previousSnapshot.details.version === 1
    ? previousSnapshot.details : null;
  const prevDriving = new Set(prevDetails ? prevDetails.drivingLinkIds : []);
  const enteredCritical: string[] = [];
  const leftCritical: string[] = [];
  const erosionAll: CriticalMigration['floatErosion'] = [];
  for (const s of statused) {
    const prev = prevActivityOf(previousSnapshot, s.id);
    const wasCritical = prev ? prev.critical : false;
    if (!prevDetails) continue;
    // Finished work does not migrate: it leaves criticality by completion, not by float.
    if (s.completed) continue;
    if (s.critical && !wasCritical) enteredCritical.push(s.code);
    if (!s.critical && wasCritical) leftCritical.push(s.code);
    if (prev && typeof prev.tf === 'number') {
      erosionAll.push({ id: s.id, code: s.code, prevTf: prev.tf, curTf: s.totalFloat, erosion: round1(prev.tf - s.totalFloat) });
    }
  }
  enteredCritical.sort();
  leftCritical.sort();
  erosionAll.sort((a, b) => b.erosion - a.erosion || (a.code < b.code ? -1 : 1));
  const drivingLinkIdList = [...drivingLinkIds].sort();
  // With no previous update there is no migration: every set below is honestly empty.
  const newDrivingLinkIds = prevDetails ? drivingLinkIdList.filter((id) => !prevDriving.has(id)) : [];
  const migration: CriticalMigration = {
    hasPrevious: !!prevDetails,
    enteredCritical, leftCritical, newDrivingLinkIds,
    floatErosion: erosionAll,
  };

  // --- §7 milestones ---
  const milestones: MilestoneStatus[] = statused
    .filter((s) => s.isMilestone)
    .map((s) => {
      const b = baselineByAct.get(s.id);
      const baselineDate = b && isIsoDate(b.early_finish) ? b.early_finish : null;
      const forecastDate = s.actualFinish || s.forecastFinish;
      const varianceWd = baselineDate && forecastDate
        ? workingDayDelta(baselineDate, forecastDate, rulerCal(actById.get(s.id) as Activity, calendarType))
        : null;
      const state: MilestoneState = s.actualFinish
        ? 'achieved'
        : !baselineDate ? 'unknown'
        : varianceWd === null ? 'unknown'
        : varianceWd <= 0 ? 'on_track'
        : varianceWd <= MILESTONE_AT_RISK_WD ? 'at_risk' : 'slipped';
      return { id: s.id, code: s.code, name: s.name, baselineDate, forecastDate, varianceWd, state };
    });

  // --- §8 evidence-only attribution (delayed vs baseline only) ---
  const attribution: DelayAttribution[] = [];
  const delayedVars = variances
    .filter((v) => v.finishVarianceWd !== null && (v.finishVarianceWd as number) > 0)
    .sort((a, b) => (b.finishVarianceWd as number) - (a.finishVarianceWd as number) || (a.code < b.code ? -1 : 1));
  for (const v of delayedVars) {
    const act = actById.get(v.id) as Activity;
    const st = statusById.get(v.id) as StatusedActivity;
    const cal = rulerCal(act, calendarType);
    const b = baselineByAct.get(v.id);
    const causes: DelayAttribution['causes'] = [];

    const drivingResLinks = (drivingBySucc.get(v.id) || []).filter((l) => l.origin === 'resource_leveling');
    if (drivingResLinks.length > 0) {
      causes.push({
        cause: 'resource_constraint',
        evidence: drivingResLinks.map((l) => {
          const pred = codeById.get(l.predecessor_id) || l.predecessor_id;
          return `driving resource-leveling link ${pred} -> ${v.code} (link ${l.id})`;
        }),
      });
    }
    const delayedPreds = st.drivingPredecessors
      .map((pid) => ({ pid, fv: varById.get(pid)?.finishVarianceWd ?? null }))
      .filter((x): x is { pid: string; fv: number } => x.fv !== null && x.fv > 0)
      .sort((a, b) => b.fv - a.fv);
    if (delayedPreds.length > 0) {
      causes.push({
        cause: 'predecessor_delay',
        evidence: delayedPreds.map((x) =>
          `driving predecessor ${codeById.get(x.pid) || x.pid} finished +${x.fv}d vs baseline`),
      });
    }
    if (b && isIsoDate(act.actual_start)) {
      const lateStart = workingDayDelta(b.early_start, act.actual_start as string, cal);
      if (lateStart !== null && lateStart > 0) {
        causes.push({
          cause: 'late_actual_start',
          evidence: [`actual_start ${act.actual_start} is +${lateStart}d vs baseline start ${b.early_start}`],
        });
      }
    }
    if (!st.completed && isIsoDate(act.actual_start)
      && act.remaining_duration_days !== undefined && act.remaining_duration_days !== null) {
      const elapsed = workingDayDelta(act.actual_start as string, dataDate, cal);
      const duration = Number(act.duration_days) || 0;
      if (elapsed !== null && elapsed >= 0 && duration > 0) {
        const implied = Math.max(0, duration - elapsed);
        const stated = Number(act.remaining_duration_days);
        if (Number.isFinite(stated) && stated - implied > 0) {
          causes.push({
            cause: 'remaining_increase',
            evidence: [
              `stated remaining ${stated}d exceeds plan-implied ${implied}d (duration ${duration}d, elapsed ${elapsed}d since ${act.actual_start})`,
            ],
          });
        }
      }
    }
    if (!st.completed && isIsoDate(act.actual_start)) {
      const plannedQty = Number(act.planned_quantity);
      const actualQty = Number(act.actual_quantity);
      const duration = Number(act.duration_days) || 0;
      const elapsed = workingDayDelta(act.actual_start as string, dataDate, cal);
      if (plannedQty > 0 && duration > 0 && elapsed !== null && elapsed > 0
        && Number.isFinite(actualQty)) {
        const unitsPp = (actualQty / plannedQty) * 100;
        const timePp = (elapsed / duration) * 100;
        if (timePp - unitsPp > LOW_PRODUCTION_TOLERANCE_PP) {
          causes.push({
            cause: 'low_production',
            evidence: [
              `quantity ${actualQty}/${plannedQty} (${round1(unitsPp)}%) trails elapsed time ${elapsed}/${duration}d (${round1(timePp)}%)`,
            ],
          });
        }
      }
    }
    const prev = prevActivityOf(previousSnapshot, v.id);
    if (prev) {
      const nowSig = linkSignature(v.id, links);
      if (nowSig !== prev.linkSig) {
        causes.push({
          cause: 'logic_change',
          evidence: [`incoming logic signature changed since ${previousSnapshot?.data_date}: "${prev.linkSig}" -> "${nowSig}"`],
        });
      }
      const nowCt = act.calendar_type || null;
      const nowCid = act.calendar_id || null;
      if (nowCt !== prev.ct || nowCid !== prev.cid) {
        causes.push({
          cause: 'calendar_change',
          evidence: [
            `execution calendar changed since ${previousSnapshot?.data_date} (type ${prev.ct} -> ${nowCt}, id ${prev.cid} -> ${nowCid})`,
          ],
        });
      }
    }
    attribution.push({
      activityId: v.id, code: v.code, finishVarianceWd: v.finishVarianceWd as number,
      causes, primary: causes.length > 0 ? causes[0].cause : 'unattributed',
    });
  }

  // --- §11 lookahead (2/4/6 weeks from the Data Date, CPM dates only) ---
  const lookahead = { w14: [] as LookaheadItem[], w28: [] as LookaheadItem[], w42: [] as LookaheadItem[] };
  const windows: Array<{ key: 'w14' | 'w28' | 'w42'; days: number }> = [
    { key: 'w14', days: 14 }, { key: 'w28', days: 28 }, { key: 'w42', days: 42 },
  ];
  for (const w of windows) {
    const end = addCalendarDays(dataDate, w.days);
    if (!end) continue;
    const items: LookaheadItem[] = [];
    for (const s of statused) {
      if (s.completed) continue;
      const startsInWindow = s.earlyStart > dataDate && s.earlyStart <= end;
      const finishesInWindow = s.earlyFinish > dataDate && s.earlyFinish <= end;
      if (!startsInWindow && !finishesInWindow) continue;
      const blockers: LookaheadBlocker[] = [];
      for (const pid of s.drivingPredecessors) {
        const pst = statusById.get(pid);
        if (!pst || pst.completed) continue;
        blockers.push({
          code: pst.code,
          forecastFinish: pst.actualFinish || pst.forecastFinish,
          delaysSuccessorStart: !!pst.forecastFinish && !!s.earlyStart && pst.forecastFinish > s.earlyStart,
        });
      }
      blockers.sort((a, b) => a.code < b.code ? -1 : 1);
      items.push({
        id: s.id, code: s.code, name: s.name,
        earlyStart: s.earlyStart, earlyFinish: s.earlyFinish,
        remaining: resultById.get(s.id)?.remainingDuration ?? 0,
        tf: s.totalFloat, critical: s.critical,
        nearCritical: !s.critical && s.totalFloat > 0 && s.totalFloat <= NEAR_CRITICAL_TF_DAYS,
        startsInWindow, finishesInWindow, blockers,
      });
    }
    items.sort((a, b) => a.earlyStart < b.earlyStart ? -1 : a.earlyStart > b.earlyStart ? 1 : byCode(a, b));
    lookahead[w.key] = items;
  }

  // --- §10 forecast accuracy vs previous update ---
  const completedSince: number[] = [];
  let matched = 0;
  let lateVsForecast = 0;
  let earlyVsForecast = 0;
  if (prevDetails) {
    for (const s of statused) {
      if (!s.actualFinish) continue;
      const prev = prevActivityOf(previousSnapshot, s.id);
      if (!prev || !isIsoDate(prev.ef)) continue;
      const err = workingDayDelta(prev.ef as string, s.actualFinish, rulerCal(actById.get(s.id) as Activity, calendarType));
      if (err === null) continue;
      completedSince.push(err);
      if (Math.abs(err) <= FORECAST_MATCH_TOLERANCE_WD) matched += 1;
      else if (err > 0) lateVsForecast += 1;
      else earlyVsForecast += 1;
    }
  }
  const meanAbsErrWd = completedSince.length > 0
    ? round1(completedSince.reduce((t, e) => t + Math.abs(e), 0) / completedSince.length) : null;
  let bias: ForecastAccuracy['bias'] = 'insufficient';
  if (completedSince.length >= 3) {
    if (lateVsForecast > completedSince.length / 2) bias = 'optimistic';
    else if (earlyVsForecast > completedSince.length / 2) bias = 'pessimistic';
    else bias = 'neutral';
  }
  const accuracy: ForecastAccuracy = {
    hasPrevious: !!prevDetails,
    driftWd: delayVsPreviousWd,
    completedSince: completedSince.length,
    matched, lateVsForecast, earlyVsForecast,
    meanAbsErrWd, bias,
  };

  // --- §12 Top-5 decision actions (evidence-traced, deterministic) ---
  const actions: ControlAction[] = [];
  const errorCount = integrity.filter((f) => f.severity === 'error').length;
  if (errorCount > 0) {
    const firstCodes = [...new Set(integrity.filter((f) => f.severity === 'error')
      .map((f) => f.activityCode || '?'))].slice(0, 3).join(', ');
    actions.push({
      rank: 0,
      issue: `${errorCount} data-date violation(s) make this update untrustworthy.`,
      evidence: [`${errorCount} integrity error(s), e.g. ${firstCodes}`],
      impact: 'Forecasts and variances computed over illegal actuals cannot be trusted.',
      action: 'Correct or remove the future-dated actuals/progress, then re-run the update.',
      confidence: 'High',
    });
  }
  const slipped = milestones.filter((m) => m.state === 'slipped')
    .sort((a, b) => (b.varianceWd as number) - (a.varianceWd as number) || (a.code < b.code ? -1 : 1));
  for (const m of slipped) {
    const st = statusById.get(m.id);
    const preds = (st?.drivingPredecessors || []).map((p) => codeById.get(p) || p).join(', ') || 'none driving';
    actions.push({
      rank: 0,
      issue: `Milestone ${m.code} slipped +${m.varianceWd}d vs baseline.`,
      evidence: [`baseline ${m.baselineDate} -> forecast ${m.forecastDate}`, `driving predecessors: ${preds}`],
      impact: `Contractual milestone at risk by ${m.varianceWd} working days.`,
      action: 'Crash or fast-track the driving chain into the milestone, or re-plan its date.',
      confidence: m.baselineDate && st && st.drivingPredecessors.length > 0 ? 'High' : 'Medium',
    });
  }
  const entered = [...enteredCritical]
    .map((code) => statused.find((s) => s.code === code) as StatusedActivity)
    .sort((a, b) => a.code < b.code ? -1 : 1);
  for (const s of entered) {
    const prev = prevActivityOf(previousSnapshot, s.id);
    actions.push({
      rank: 0,
      issue: `Activity ${s.code} joined the critical path.`,
      evidence: prev && typeof prev.tf === 'number'
        ? [`TF ${prev.tf} -> ${s.totalFloat} since ${previousSnapshot?.data_date}`]
        : ['first update carrying this activity as critical'],
      impact: 'Any slip on this activity now slips the project finish.',
      action: 'Protect it: lock resources, clear blockers, and track daily.',
      confidence: prev ? 'High' : 'Medium',
    });
  }
  const resourced = attribution.filter((a) => a.primary === 'resource_constraint');
  for (const a of resourced) {
    actions.push({
      rank: 0,
      issue: `Activity ${a.code} delayed +${a.finishVarianceWd}d by resource contention.`,
      evidence: a.causes[0].evidence,
      impact: `+${a.finishVarianceWd} working days vs baseline on a resource-driven wait.`,
      action: 'Resolve the pool contention (add capacity or re-sequence the competing work).',
      confidence: 'High',
    });
  }
  const eroding = nearCriticalList
    .filter((n) => n.erosion !== null && (n.erosion as number) > 0)
    .sort((a, b) => (b.erosion as number) - (a.erosion as number) || (a.code < b.code ? -1 : 1));
  for (const n of eroding) {
    actions.push({
      rank: 0,
      issue: `Near-critical ${n.code} eroding (TF ${n.tf}d${n.prevTf !== null ? `, was ${n.prevTf}d` : ''}).`,
      evidence: n.daysUntilCritical !== null
        ? [`eroding ${n.erosion}d/update, critical in ~${n.daysUntilCritical}d at this rate`]
        : [`eroded ${n.erosion}d since previous update`],
      impact: n.daysUntilCritical !== null
        ? `Joins the critical path in ~${n.daysUntilCritical} working days if the trend holds.`
        : 'Trending toward the critical path.',
      action: 'Intervene on its driving predecessors before the float burns out.',
      confidence: n.daysUntilCritical !== null ? 'High' : 'Medium',
    });
  }
  const slow = attribution.filter((a) => a.primary === 'low_production' || a.primary === 'remaining_increase');
  for (const a of slow) {
    actions.push({
      rank: 0,
      issue: `Activity ${a.code} delayed +${a.finishVarianceWd}d (${a.primary === 'low_production' ? 'low production' : 'remaining growth'}).`,
      evidence: a.causes[0].evidence,
      impact: `+${a.finishVarianceWd} working days vs baseline from execution pace.`,
      action: 'Raise output (crew/hours) or re-estimate the remaining duration honestly.',
      confidence: 'Medium',
    });
  }
  const atRisk = milestones.filter((m) => m.state === 'at_risk')
    .sort((a, b) => (b.varianceWd as number) - (a.varianceWd as number) || (a.code < b.code ? -1 : 1));
  for (const m of atRisk) {
    actions.push({
      rank: 0,
      issue: `Milestone ${m.code} at risk (+${m.varianceWd}d vs baseline).`,
      evidence: [`baseline ${m.baselineDate} -> forecast ${m.forecastDate}`],
      impact: 'Slips further without intervention on its driving chain.',
      action: 'Expedite the driving predecessors and confirm the milestone date.',
      confidence: 'Medium',
    });
  }
  const unattributed = attribution.filter((a) => a.primary === 'unattributed')
    .sort((a, b) => b.finishVarianceWd - a.finishVarianceWd || (a.code < b.code ? -1 : 1));
  for (const a of unattributed.slice(0, 2)) {
    actions.push({
      rank: 0,
      issue: `Activity ${a.code} delayed +${a.finishVarianceWd}d with no provable cause.`,
      evidence: [`finish variance +${a.finishVarianceWd}d vs baseline`, 'no evidence rule matched'],
      impact: 'Unexplained delay hides the real constraint.',
      action: 'Investigate on site and record the cause before the next update.',
      confidence: 'Low',
    });
  }
  const top5 = actions.slice(0, 5);
  top5.forEach((a, i) => { a.rank = i + 1; });

  // --- §13 confidence per KPI ---
  const withBaseline = variances.filter((v) => v.hasBaseline).length;
  const coverage = activities.length > 0 ? withBaseline / activities.length : 0;
  const startedCount = statused.filter((s) => s.started).length;
  let latestEvidence: string | null = null;
  for (const u of progressUpdates) {
    if (u.status !== 'approved' || !isIsoDate(u.update_date)) continue;
    if (isAfterDataDate(u.update_date, dataDate)) continue;
    if (latestEvidence === null || u.update_date > latestEvidence) latestEvidence = u.update_date;
  }
  const staleGap = latestEvidence ? calendarDaysBetween(latestEvidence, dataDate) : null;
  const stale = startedCount > 0 && (staleGap === null || staleGap > UPDATE_STALENESS_DAYS);
  const errorFree = errorCount === 0;

  const confidence: ScheduleControlReport['confidence'] = {
    forecastFinish: {
      level: coverage === 1 && errorFree && !stale ? 'High' : coverage >= 0.8 && errorFree ? 'Medium' : 'Low',
      sources: ['canonical statused CPM', 'stored actuals'],
      notes: [
        `baseline coverage ${withBaseline}/${activities.length}`,
        errorFree ? 'no integrity errors' : `${errorCount} integrity error(s)`,
        stale ? 'progress evidence is stale or missing' : 'progress evidence is current',
      ],
    },
    totalDelay: {
      level: coverage === 1 && errorFree ? 'High' : coverage >= 0.5 && errorFree ? 'Medium' : 'Low',
      sources: ['active baseline', 'canonical statused CPM'],
      notes: [
        baselineFinish ? `baseline finish ${baselineFinish}` : 'no baseline finish available',
        errorFree ? 'no integrity errors' : `${errorCount} integrity error(s)`,
      ],
    },
    criticalPath: {
      level: errorFree && links.length > 0 ? 'High' : errorFree ? 'Medium' : 'Low',
      sources: ['canonical statused CPM'],
      notes: [
        `${links.length} logic link(s) in the current network`,
        errorFree ? 'no integrity errors' : `${errorCount} integrity error(s)`,
      ],
    },
    milestones: {
      level: milestones.length === 0
        ? 'Medium'
        : milestones.every((m) => m.baselineDate) ? 'High'
        : milestones.filter((m) => m.baselineDate).length >= milestones.length / 2 ? 'Medium' : 'Low',
      sources: ['milestone activities', 'active baseline'],
      notes: milestones.length === 0
        ? ['no milestones defined in the plan']
        : [`${milestones.filter((m) => m.baselineDate).length}/${milestones.length} milestones carry a baseline date`],
    },
    progressPct: {
      level: progressPct === null ? 'Low' : errorFree ? 'High' : 'Medium',
      sources: [progressSource === 'override' ? 'caller-supplied progress' : 'duration-weighted percent complete'],
      notes: progressPct === null ? ['no durations to weight'] : [`progress = ${progressPct}% (${progressSource})`],
    },
  };

  return {
    dataDate, statusLogic, integrity, drivingLinkIds: drivingLinkIdList, statused,
    project: {
      baselineFinish, forecastFinish, totalDelayWd, delayVsPreviousWd,
      criticalCount, nearCriticalCount: nearCriticalList.length,
      progressPct, progressSource,
    },
    variances, migration, nearCritical: nearCriticalList, milestones,
    attribution, lookahead, accuracy, actions: top5, confidence,
  };
}

// ---------------------------------------------------------------------------
// §9 — deterministic update snapshot payload
// ---------------------------------------------------------------------------

/**
 * §9: build the deterministic snapshot payload for this update. Key order, link order and
 * rounding are fixed so the same report always serializes to the same bytes.
 */
export function buildUpdateSnapshot(
  projectId: string,
  report: ScheduleControlReport,
  activities: Activity[],
  links: ActivityLink[],
): ScheduleSnapshotPayload {
  const details: ScheduleSnapshotDetails = { version: 1, activities: {}, drivingLinkIds: [...report.drivingLinkIds] };
  const actById = new Map(activities.map((a) => [a.id, a]));
  const sorted = [...report.statused].sort(byCode);
  for (const s of sorted) {
    const act = actById.get(s.id);
    details.activities[s.id] = {
      ef: s.forecastFinish,
      tf: s.totalFloat,
      critical: s.critical,
      ct: act?.calendar_type || null,
      cid: act?.calendar_id || null,
      linkSig: linkSignature(s.id, links),
      pct: s.percentComplete,
    };
  }
  return {
    project_id: projectId,
    data_date: report.dataDate,
    forecast_finish: report.project.forecastFinish,
    progress_pct: report.project.progressPct,
    critical_count: report.project.criticalCount,
    near_critical_count: report.project.nearCriticalCount,
    total_delay_days: report.project.totalDelayWd,
    delay_vs_previous_days: report.project.delayVsPreviousWd,
    milestones_slipped: report.milestones.filter((m) => m.state === 'slipped').length,
    details,
  };
}

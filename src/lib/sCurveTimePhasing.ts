import type {
  Activity,
  ActivityBoqAllocation,
  BaselineActivity,
  BoqItem,
  BudgetLine,
  CalendarType,
  CostTransaction,
  ProgressUpdate,
  WbsNode,
} from '@/types';
import { analyzeCostControl } from '@/lib/costControlEngine';
import { isIsoDate } from '@/lib/chronologyGuard';

/**
 * F9.6 (Cross-Surface Control Reconciliation) — time-phased adapter over the CANONICAL cost engine.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The financial S-Curve needs PV / EV / AC "as of" an arbitrary cutoff T, including cutoffs in the
 * past. F6 (`analyzeCostControl`) already owns the canonical definitions of all three and already
 * takes an explicit `dataDate` — it never reads a clock. What F6 does NOT do is phase an activity's
 * `percent_complete` backwards in time: it reads the persisted current value, because at the governed
 * Data Date that persisted value *is* the current status.
 *
 * So the adapter's only job is to hand F6 the right INPUTS for the cutoff being evaluated, and then
 * let F6 do all the arithmetic. There is deliberately **no second PV formula, no second EV formula
 * and no second AC rule anywhere in this module** — it calls `analyzeCostControl` and reads its
 * published `bac` / `pv` / `ev` / `ac`. That is what makes the Data Date point reconcile to canonical
 * F6 by construction rather than by coincidence, and it is why the superseded
 * `planningEngine.calculateProjectEvmAtDataDate` weighting is no longer the curve's source.
 *
 * PHASING RULES (all deterministic; no machine clock is read anywhere)
 * --------------------------------------------------------------------
 *  1. `T >= governedDataDate` — CURRENT. Activities are passed through UNCHANGED, so their persisted
 *     `percent_complete` is used exactly as F6 uses it. The persisted value is not a guess about the
 *     future: under a governed Data Date the stored project state *is* the status as of that date.
 *     This is the reconciliation anchor — evaluating here is the same call the caller already made,
 *     so `pv` / `ev` / `ac` are bit-for-bit the canonical current facts.
 *  2. `T < governedDataDate` — HISTORICAL, EVIDENCE ONLY. An activity's percent is the
 *     `percent_complete` of the LATEST APPROVED progress update dated on or before T, because that is
 *     how the application defines recorded progress (`approve_progress_update` assigns
 *     `activity.percent_complete = update.percent_complete`, latest approved wins, absolute not
 *     cumulative). With no approved update at or before T the activity earns ZERO: today's progress
 *     is never retro-written into an earlier period, and no elapsed-time interpolation invents
 *     earned value where no evidence exists.
 *  3. Updates whose `update_date` is missing or not a valid ISO date are NOT evidence. Treating an
 *     undated record as "always in history" would fabricate a date for it, so it is excluded and the
 *     period simply reports less earned value.
 *  4. AC needs no phasing here: F6 already restricts actual cost to APPROVED transactions dated on or
 *     before the `dataDate` it is given, so passing the cutoff as `dataDate` and the full transaction
 *     list yields exactly "approved cost as of T". The rule is F6's, stated once.
 *  5. PV needs no phasing either: F6 prorates each activity's baseline `planned_cost` over its own
 *     window in WORKING DAYS on the project calendar, evaluated at the `dataDate` it is given. That is
 *     already a time-phased planned-value curve, and at a cutoff on or after every finish each
 *     fraction is 1, so cumulative PV closes on BAC exactly.
 *
 * THE LATE CURVE
 * --------------
 * `BaselineActivity` carries only `early_start` / `early_finish` — there are no baseline late dates in
 * the schema. PV Late therefore keeps the canonical baseline COST weights (BAC allocation is
 * date-independent) but phases them over each activity's LATE window (`late_start` / `late_finish`,
 * falling back to its early window when a late date is absent). It is a secondary display series: only
 * `pv` is read from that call, and it never feeds a canonical metric.
 */

/** Structural subset of `Project` that F6 consumes. Kept narrow so the adapter stays harness-bundleable. */
export interface TimePhasedProjectInput {
  id: string;
  contract_value?: number | null;
  data_date?: string | null;
}

export interface TimePhasedEvmSources {
  project: TimePhasedProjectInput;
  activities: Activity[];
  /** Approved baseline rows — the canonical BAC basis and the canonical PV/EV weighting. */
  baselines: BaselineActivity[];
  budgetLines: BudgetLine[];
  costTransactions: CostTransaction[];
  progressUpdates: ProgressUpdate[];
  boqItems?: BoqItem[];
  wbsNodes?: WbsNode[];
  allocations?: ActivityBoqAllocation[];
  calendarType?: CalendarType;
  /** The governed Data Date of the current project state. Rule 1 anchors on it. */
  governedDataDate: string;
  /** Passed through to F6 unchanged; affects ETC/EAC only, never the PV/EV/AC read here. */
  manualEtc?: number | null;
}

/** One canonical F6 evaluation at one cutoff. */
export interface TimePhasedEvmPoint {
  /** The cutoff this evaluation answers to (`YYYY-MM-DD`). */
  cutoff: string;
  /**
   * True only when the cutoff IS the governed Data Date — the single point that must reconcile to the
   * canonical current EVM. Deliberately strict equality: a cutoff AFTER the Data Date also uses the
   * persisted current status (there is no later evidence to phase back to), but it is a forecast
   * bucket, not the current point, and the curve publishes no EV/AC for it.
   */
  isCurrent: boolean;
  bac: number | null;
  bacSource: string;
  pv: number | null;
  ev: number | null;
  ac: number;
  acSource: 'approved_transactions' | 'none_recorded';
  pvMethod: string;
  /**
   * True when this point's percent-complete came from evidence phasing (rule 2) rather than from the
   * persisted current status (rule 1). Lets a consumer or a test tell history from the current point
   * without re-deriving the rule.
   */
  evidencePhased: boolean;
}

/**
 * Percent-complete of an activity as of `cutoff`, from approved progress evidence only.
 *
 * Returns the persisted `percent_complete` unchanged when `cutoff` is at or after the governed Data
 * Date (rule 1). Otherwise the latest approved, validly dated update at or before `cutoff` (rule 2),
 * or 0 when there is none. Never reads a clock, never interpolates.
 */
export function phasePercentCompleteAsOf(
  activity: Activity,
  progressUpdates: ProgressUpdate[],
  cutoff: string,
  governedDataDate: string,
): { percent: number; evidencePhased: boolean } {
  if (!isIsoDate(cutoff) || cutoff >= governedDataDate) {
    return { percent: Number(activity.percent_complete) || 0, evidencePhased: false };
  }
  let latest: ProgressUpdate | null = null;
  for (const u of progressUpdates) {
    if (u.activity_id !== activity.id) continue;
    if (u.status !== 'approved') continue;
    if (!isIsoDate(u.update_date)) continue; // rule 3: an undated record is not evidence
    if (u.update_date > cutoff) continue; // rule 2: no future progress
    if (latest === null || u.update_date > (latest.update_date as string)) latest = u;
  }
  return { percent: latest ? Number(latest.percent_complete) || 0 : 0, evidencePhased: true };
}

/**
 * Activities phased to `cutoff` (rules 1–3). At or after the governed Data Date this returns the
 * input rows untouched, which is what makes the Data Date evaluation identical to the canonical call.
 */
export function phaseActivitiesAsOf(
  activities: Activity[],
  progressUpdates: ProgressUpdate[],
  cutoff: string,
  governedDataDate: string,
): { activities: Activity[]; evidencePhased: boolean } {
  if (!isIsoDate(cutoff) || cutoff >= governedDataDate) {
    return { activities, evidencePhased: false };
  }
  let anyPhased = false;
  const phased = activities.map((a) => {
    const { percent, evidencePhased } = phasePercentCompleteAsOf(a, progressUpdates, cutoff, governedDataDate);
    if (evidencePhased) anyPhased = true;
    return percent === a.percent_complete ? a : { ...a, percent_complete: percent };
  });
  return { activities: phased, evidencePhased: anyPhased };
}

/**
 * Baseline rows re-windowed onto each activity's LATE dates, for the secondary PV Late series.
 * Costs (`planned_cost`) are never touched: only the proration window changes. Baselines with no
 * matching activity, or whose activity has no late dates, are passed through unchanged.
 */
export function phaseBaselinesForLateCurve(
  baselines: BaselineActivity[],
  activities: Activity[],
): BaselineActivity[] {
  const byId = new Map(activities.map((a) => [a.id, a]));
  return baselines.map((b) => {
    const act = byId.get(b.activity_id);
    if (!act) return b;
    const start = isIsoDate(act.late_start) ? (act.late_start as string) : b.early_start;
    const finish = isIsoDate(act.late_finish) ? (act.late_finish as string) : b.early_finish;
    return start === b.early_start && finish === b.early_finish ? b : { ...b, early_start: start, early_finish: finish };
  });
}

/** Same re-windowing applied to activities, so F6's CPM-proxy fallback also follows the late window. */
export function phaseActivitiesForLateCurve(activities: Activity[]): Activity[] {
  return activities.map((a) => {
    const start = isIsoDate(a.late_start) ? a.late_start : a.early_start;
    const finish = isIsoDate(a.late_finish) ? a.late_finish : a.early_finish;
    return start === a.early_start && finish === a.early_finish ? a : { ...a, early_start: start, early_finish: finish };
  });
}

/**
 * Evaluate the canonical F6 cost report at one cutoff and read its published BAC / PV / EV / AC.
 *
 * `late: true` re-windows the proration onto late dates (PV Late only). Everything else — BAC basis,
 * approved-baseline weighting, progress evidence rules, approved-cost cutoff, working-day chronology —
 * is F6's own, unmodified.
 */
export function evaluateTimePhasedEvm(
  sources: TimePhasedEvmSources,
  cutoff: string,
  options: { late?: boolean } = {},
): TimePhasedEvmPoint {
  const late = options.late === true;
  const { activities: phasedActivities, evidencePhased } = phaseActivitiesAsOf(
    sources.activities,
    sources.progressUpdates,
    cutoff,
    sources.governedDataDate,
  );
  const activities = late ? phaseActivitiesForLateCurve(phasedActivities) : phasedActivities;
  const baselines = late
    ? phaseBaselinesForLateCurve(sources.baselines, phasedActivities)
    : sources.baselines;

  const report = analyzeCostControl({
    project: sources.project,
    activities,
    baselines,
    budgetLines: sources.budgetLines,
    costTransactions: sources.costTransactions,
    progressUpdates: sources.progressUpdates,
    wbsNodes: sources.wbsNodes || [],
    boqItems: sources.boqItems || [],
    allocations: sources.allocations || [],
    dataDate: cutoff,
    calendarType: sources.calendarType,
    manualEtc: sources.manualEtc ?? null,
  });

  return {
    cutoff,
    isCurrent: cutoff === sources.governedDataDate,
    bac: report.project.bac,
    bacSource: report.bac.source,
    pv: report.project.pv,
    ev: report.project.ev,
    ac: report.project.ac,
    acSource: report.project.acSource,
    pvMethod: report.pvMethod,
    evidencePhased,
  };
}

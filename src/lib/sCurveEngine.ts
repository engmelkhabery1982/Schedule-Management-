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
import type { ComprehensiveProjectEvm } from '@/lib/planningEngine';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import { evaluateTimePhasedEvm, type TimePhasedEvmSources } from '@/lib/sCurveTimePhasing';

/**
 * Financial S-Curve engine (planned / earned / actual / forecast cumulative curves).
 *
 * F9.6 (Cross-Surface Control Reconciliation) — CANONICAL SOURCE
 * --------------------------------------------------------------
 * Every monetary point on this curve is produced by **F6 (`costControlEngine.analyzeCostControl`)**
 * through the pure time-phased adapter `@/lib/sCurveTimePhasing`. This module owns the BUCKET
 * SCHEDULE and nothing else: it decides which cutoffs to evaluate, then asks F6 for BAC / PV / EV /
 * AC at each one. There is no PV formula, no EV formula and no AC rule in this file.
 *
 * That replaces `planningEngine.calculateProjectEvmAtDataDate`, which this engine used to call at
 * every cutoff. An earlier revision of this docblock called that route "the canonical EVM … the single
 * evaluation path". Since F9.4/F9.5 that statement was false, and the divergence was visible: on the
 * pilot project at the governed Data Date 2026-09-09 the curve plotted PV 245,022 / EV 93,342 while
 * canonical F6 — quoted on the same screen, from the same data — published PV 715,014.29 / EV 752,900.
 * Two causes, both in the superseded derivation:
 *   - PV: it weights activities by CBS budget lines matched on `wbs_node_id` (one line handed in full
 *     to every activity in the node, then re-scaled) and prorates in calendar time, whereas F6 weights
 *     by the APPROVED BASELINE's `planned_cost` and prorates in WORKING DAYS on the project calendar.
 *   - EV: it applies that same non-canonical weighting to the evidence percent, whereas F6 applies the
 *     baseline weighting to the governed current `percent_complete`.
 * The superseded derivation is no longer imported here at all, not even as a diagnostic: a financial
 * S-Curve is a user-facing canonical surface, and publishing a second set of PV/EV numbers on it —
 * however labelled — is what produced the reported contradiction. The divergence is instead pinned by
 * regression S19-Q, which calls the legacy engine directly in the harness.
 *
 * Note that `baselineActivities` was already a parameter of `generateSCurveData` before F9.6 and was
 * never used in the body: the canonical weights were being passed in and ignored. They are now the
 * weighting basis, via F6.
 *
 * TIME-PHASED SEMANTICS — one convention, documented because every invariant below depends on it:
 *
 *  1. Bucket frequency is adaptive to the project span: 7-day buckets up to 120 days, 14-day
 *     buckets up to 360 days, 30-day buckets beyond that. The governed Data Date is ALWAYS
 *     inserted as a bucket of its own, so the actual series ends exactly on the Data Date rather
 *     than on whichever bucket happens to be nearest.
 *  2. A bucket date is a PERIOD END / CUTOFF. Every cumulative value on that bucket means
 *     "as of the end of that calendar day".
 *  3. Cumulative PV / EV / AC are INCLUSIVE through the cutoff: a record dated exactly on the
 *     cutoff belongs to that bucket (`record_date <= cutoff`, compared as ISO date strings).
 *  4. Data Date cutoff rule: a bucket is ACTUAL iff `bucketDate <= dataDate`. There is no
 *     half-bucket grace — a bucket after the Data Date is never reported as actual.
 *  5. Forecast buckets are exactly those strictly after the Data Date. On actual buckets
 *     `forecastCumulative` is null; on forecast buckets `evCumulative` / `acCumulative` are null,
 *     so actual history and forecast can never be mixed inside one series.
 *  6. THE DATA DATE POINT IS THE CURRENT POINT. At the governed Data Date the adapter passes the
 *     activities through unchanged, so F6 is being asked the same question with the same inputs the
 *     caller already asked it: `pvEarlyCumulative`, `evCumulative` and `acCumulative` on that bucket
 *     are therefore the canonical F6 PV / EV / AC to the cent, not an approximation of them. The
 *     `currentPv` / `currentEv` / `currentAc` scalars published alongside the series are the same
 *     numbers, so the chart can never headline one "current" value while its visible Data Date point
 *     shows another.
 *  7. Final cumulative PV closes on BAC exactly: at a cutoff on or after every activity finish each
 *     F6 proration fraction is 1, so PV is the sum of the baseline `planned_cost` rows, which is BAC.
 *
 * HISTORICAL BUCKETS (GAP-024, GAP-025) — history is evidence only, and stays historical:
 *  - EV at cutoff T < Data Date is F6 applied to activities whose `percent_complete` has been phased
 *    back to the LATEST APPROVED progress update dated `<= T` (absolute percent, latest wins — the
 *    same rule `approve_progress_update` applies to the stored column), or ZERO when there is none.
 *    Today's progress is never retro-written into an earlier period, and no elapsed-time
 *    interpolation invents earned value where no evidence exists.
 *  - AC at cutoff T is F6's own rule: approved transactions dated on or before T, and zero when there
 *    are none. No current-state AC estimate is backcast into history.
 *  - An earlier bucket is therefore expected to differ from the Data Date bucket; a curve whose history
 *    equals its endpoint has been flattened and is wrong.
 *  - Where evidence is insufficient a period reports the smaller honest number rather than a
 *    fabricated one. The curve does not interpolate between evidence points.
 *
 * PRECISION — deliberate decision (F9.6):
 *  Monetary values are kept at F6's own published precision (2 decimal places) inside the series and
 *  are NOT rounded to whole SAR. Rounding to integers here used to make the Data Date point publish PV
 *  715,014 while canonical F6 published 715,014.29, so the two could not be reconciled even when the
 *  underlying maths agreed. Rounding is a RENDERING concern and belongs to `SCurveChart`, which formats
 *  for display; the data model stays exact. Period increments are floored at zero so an approved
 *  downward correction in a cumulative series cannot render as negative work in a bar chart, while the
 *  cumulative series still shows it.
 *
 * No machine clock is read anywhere in this file (GAP-007): same project + same governed Data Date =>
 * the same curve, always.
 */

export interface SCurvePoint {
  date: string; // 'YYYY-MM-DD'
  label: string; // Arabic display e.g. 'أكتوبر 2026' or 'W1-Oct'
  pvEarlyCumulative: number;
  pvLateCumulative: number;
  evCumulative: number | null; // null for future periods
  acCumulative: number | null; // null for future periods
  forecastCumulative: number | null; // projection for future
  periodPv: number;
  periodEv: number | null;
  periodAc: number | null;
  /**
   * F9.6: true on the single bucket whose date is the governed Data Date. That bucket is the current
   * canonical point (semantic 6); every other actual bucket is evidence-phased history.
   */
  isDataDate: boolean;
}

export interface SCurveData {
  points: SCurvePoint[];
  bac: number;
  /** Canonical F6 scalars at the governed Data Date — identical to the Data Date bucket's values. */
  currentPv: number | null;
  currentEv: number;
  currentAc: number;
  forecastEac: number;
  dataDate: string;
  /** Index of the governed Data Date bucket in `points`, or -1 when the series is empty. */
  dataDateIndex: number;
  /** F6's BAC basis for the curve, so a consumer can state where the weights came from. */
  bacSource: string;
}

/**
 * Source data the canonical F6 evaluation needs at each cutoff.
 *
 * `baselines` is the important one: it is F6's BAC basis and its PV/EV weighting. Without it F6 falls
 * back to budget-line totals, which is a different (unfrozen) plan and would put the curve back out of
 * reconciliation with the canonical cards on the same screen.
 */
export interface SCurveCanonicalSources {
  /** Structural subset of `Project` consumed by F6 (identity, contract value and dates). */
  project?: {
    id?: string;
    contract_value?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    data_date?: string | null;
  } | null;
  /** CBS budget lines — F6's BAC fallback when no approved baseline rows are supplied. */
  budgetLines?: BudgetLine[];
  /** BOQ items — F6's last-resort BAC basis. */
  boqItems?: BoqItem[];
  /** F9.6: ACTIVE APPROVED baseline rows — the canonical BAC basis and PV/EV weighting. */
  baselines?: BaselineActivity[];
  /** F9.6: project calendar for F6's working-day PV proration. Defaults to F6's own default. */
  calendarType?: CalendarType;
  wbsNodes?: WbsNode[];
  allocations?: ActivityBoqAllocation[];
  manualEtc?: number | null;
}

function parseDate(d: string): number {
  return new Date(`${d}T00:00:00Z`).getTime();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

/** 2-decimal money, matching F6's own published precision. Non-finite input becomes 0, never NaN. */
function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function finite(n: unknown, fallback = 0): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

export function generateSCurveData(
  activities: Activity[],
  baselineActivities: BaselineActivity[],
  progressUpdates: ProgressUpdate[],
  costTransactions: CostTransaction[],
  evm: ComprehensiveProjectEvm,
  projectStartDate?: string | null,
  projectEndDate?: string | null,
  customDataDate?: string | null,
  canonicalSources: SCurveCanonicalSources = {},
): SCurveData {
  // Governed Data Date resolution: explicit cutoff -> the canonical EVM's own resolved data date
  // -> the governed constant. `new Date()` is never used as the cutoff, so the curve cannot drift
  // with the machine clock (GAP-007).
  const effectiveDataDate = customDataDate || evm.dataDate || DEFAULT_DATA_DATE;
  const effectiveDataDateTime = parseDate(effectiveDataDate);

  // Canonical BAC is authoritative. It is never replaced by a quantity-derived synthetic value.
  const totalBac = finite(evm.bac, 0);

  // The baselines the caller already fetched for F6. Prefer the explicit source (which is what the
  // canonical cards used) and fall back to the positional argument — the two are the same governed
  // ACTIVE APPROVED rows in every caller, and using them is what makes the weights canonical.
  const baselines = canonicalSources.baselines ?? baselineActivities ?? [];

  const emptyResult = (bacSource: string): SCurveData => ({
    points: [],
    bac: totalBac,
    currentPv: evm.pv ?? null,
    currentEv: finite(evm.ev),
    currentAc: finite(evm.ac),
    forecastEac: finite(evm.eac),
    dataDate: effectiveDataDate,
    dataDateIndex: -1,
    bacSource,
  });

  if (activities.length === 0) return emptyResult('unavailable');

  const budgetLines = canonicalSources.budgetLines || [];
  const boqItems = canonicalSources.boqItems || [];
  // F6 requires a project identity; without one it would resolve its own BAC fallback, so supply the
  // canonical BAC the caller already computed to keep the curve reconciled to it.
  const canonicalProject = canonicalSources.project ?? {
    id: 'scurve-unscoped',
    contract_value: totalBac,
    start_date: projectStartDate ?? null,
    end_date: projectEndDate ?? null,
    data_date: effectiveDataDate,
  };

  const phasedSources: TimePhasedEvmSources = {
    project: {
      id: canonicalProject.id ?? 'scurve-unscoped',
      contract_value: canonicalProject.contract_value ?? null,
      data_date: canonicalProject.data_date ?? effectiveDataDate,
    },
    activities,
    baselines,
    budgetLines,
    costTransactions,
    progressUpdates,
    boqItems,
    wbsNodes: canonicalSources.wbsNodes || [],
    allocations: canonicalSources.allocations || [],
    calendarType: canonicalSources.calendarType,
    governedDataDate: effectiveDataDate,
    manualEtc: canonicalSources.manualEtc ?? null,
  };

  // Determine overall project date span
  let minTime = Infinity;
  let maxTime = -Infinity;

  activities.forEach((act) => {
    if (act.early_start) minTime = Math.min(minTime, parseDate(act.early_start));
    if (act.early_finish) maxTime = Math.max(maxTime, parseDate(act.early_finish));
    if (act.late_finish) maxTime = Math.max(maxTime, parseDate(act.late_finish));
  });

  if (projectStartDate) minTime = Math.min(minTime, parseDate(projectStartDate));
  if (projectEndDate) maxTime = Math.max(maxTime, parseDate(projectEndDate));

  if (minTime === Infinity || maxTime === -Infinity) {
    minTime = effectiveDataDateTime;
    maxTime = effectiveDataDateTime + 90 * 86400000;
  }

  // Generate weekly/bi-weekly cut-off points
  const DAY_MS = 86400000;
  const totalDurationDays = Math.max(14, Math.round((maxTime - minTime) / DAY_MS));
  // Step size: 7 days if short project (< 120 days), 14 days if medium, 30 days if long (> 360 days)
  const stepDays = totalDurationDays > 360 ? 30 : totalDurationDays > 120 ? 14 : 7;
  const stepMs = stepDays * DAY_MS;

  const cutOffDates: number[] = [];
  let currentCutoff = minTime;
  while (currentCutoff <= maxTime + stepMs) {
    cutOffDates.push(currentCutoff);
    currentCutoff += stepMs;
  }
  // The Data Date is always a bucket: the actual series must END on the Data Date and the forecast
  // must BEGIN after it, and the planned value on that bucket must equal the canonical F6 PV/EV/AC.
  if (!cutOffDates.includes(effectiveDataDateTime)) {
    cutOffDates.push(effectiveDataDateTime);
  }
  cutOffDates.sort((a, b) => a - b);

  const points: SCurvePoint[] = [];
  let dataDateIndex = -1;
  let bacSource = 'unavailable';

  for (let i = 0; i < cutOffDates.length; i++) {
    const cutoff = cutOffDates[i];
    const cutoffStr = formatDate(cutoff);
    const d = new Date(cutoff);
    const label = d.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' });

    // ONE canonical evaluation per cutoff (plus one for the secondary late-window PV series). F6 does
    // all the arithmetic; the adapter only phases the inputs. See `sCurveTimePhasing` rules 1-5.
    const atCutoff = evaluateTimePhasedEvm(phasedSources, cutoffStr);
    const atCutoffLate = evaluateTimePhasedEvm(phasedSources, cutoffStr, { late: true });
    bacSource = atCutoff.bacSource;

    const pvEarly = round2(finite(atCutoff.pv, 0));
    const pvLate = round2(finite(atCutoffLate.pv, pvEarly));

    // A bucket is actual iff it is on or before the Data Date (no half-step grace).
    const isPastOrPresent = cutoff <= effectiveDataDateTime;
    const isDataDate = cutoff === effectiveDataDateTime;
    if (isDataDate) dataDateIndex = i;

    let evVal: number | null = null;
    let acVal: number | null = null;
    let forecastVal: number | null = null;

    if (isPastOrPresent) {
      // Evidence-only earned value below the Data Date; the governed current value at it (semantic 6).
      evVal = atCutoff.ev === null ? null : round2(finite(atCutoff.ev, 0));
      // Evidence-only actual cost: F6's approved-and-not-after-cutoff rule. Zero when there are none,
      // because the canonical current-state AC estimate must not be backcast into history.
      acVal = round2(finite(atCutoff.ac, 0));
    } else {
      // Forecast: canonical EAC less canonical AC at the Data Date, spread over the remaining
      // planned span. It starts from the canonical current cost, never from fabricated history.
      const remainingTime = maxTime - effectiveDataDateTime;
      const currentOffset = cutoff - effectiveDataDateTime;
      const progressFactor = remainingTime > 0 ? Math.min(1, Math.max(0, currentOffset / remainingTime)) : 1;
      const remainingCost = Math.max(0, finite(evm.eac) - finite(evm.ac));
      forecastVal = round2(finite(evm.ac) + remainingCost * progressFactor);
    }

    const prevPv = i > 0 ? points[i - 1].pvEarlyCumulative : 0;
    const prevEv = i > 0 && points[i - 1].evCumulative !== null ? (points[i - 1].evCumulative as number) : 0;
    const prevAc = i > 0 && points[i - 1].acCumulative !== null ? (points[i - 1].acCumulative as number) : 0;

    points.push({
      date: cutoffStr,
      label,
      pvEarlyCumulative: pvEarly,
      pvLateCumulative: pvLate,
      evCumulative: evVal,
      acCumulative: acVal,
      forecastCumulative: forecastVal,
      // Incremental periods are floored at zero so an approved downward correction in a cumulative
      // series cannot render as negative work in a bar chart; the cumulative series still shows it.
      periodPv: Math.max(0, round2(pvEarly - prevPv)),
      periodEv: evVal !== null ? Math.max(0, round2(evVal - prevEv)) : null,
      periodAc: acVal !== null ? Math.max(0, round2(acVal - prevAc)) : null,
      isDataDate,
    });
  }

  return {
    points,
    bac: totalBac,
    dataDateIndex,
    bacSource,
    // Canonical scalars at the Data Date (SSOT). Semantic 6 guarantees the Data Date bucket carries
    // these same values, so the headline and the plotted point cannot disagree.
    currentPv: evm.pv ?? null,
    currentEv: finite(evm.ev),
    currentAc: finite(evm.ac),
    forecastEac: finite(evm.eac),
    dataDate: effectiveDataDate,
  };
}

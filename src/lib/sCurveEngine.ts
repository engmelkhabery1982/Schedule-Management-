import type { Activity, BaselineActivity, BoqItem, CostTransaction, ProgressUpdate, EvmMetrics } from '@/types';
import { calculateProjectEvmAtDataDate, type EvmBudgetLineInput } from '@/lib/planningEngine';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';

/**
 * Financial S-Curve engine (planned / earned / actual / forecast cumulative curves).
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
 *  6. Final cumulative PV reconciles to BAC by construction: PV is evaluated by the canonical
 *     EVM engine (`calculateProjectEvmAtDataDate`) at each cutoff, and the last cutoff is at or
 *     after every activity finish and the project end date, where the canonical engine has
 *     already normalised the per-activity cost allocation to sum exactly to BAC.
 *
 * Cost weighting (GAP-006): the curve is weighted by the CANONICAL cost allocation — CBS budget
 * lines matched to activities through `wbs_node_id`, falling back to an even `BAC / activityCount`
 * share for an activity with no budget line, then normalised to BAC. Physical quantities are never
 * used as financial weights: `planned_quantity` values carry heterogeneous units (m3, m2, points,
 * tons, lots) and summing them invents an exchange rate between units. There is likewise no
 * hidden SAR-per-unit conversion: BAC is the canonical EVM BAC, never `quantity * 100`.
 *
 * Historical EV / AC (GAP-024, GAP-025): history is evidence only.
 *  - EV at cutoff T is the canonical earned-value roll-up of APPROVED progress updates dated
 *    `<= T`. An activity with no approved update at T contributes ZERO, never its current
 *    `percent_complete` — today's progress is not retroactively written into earlier periods.
 *  - AC at cutoff T is the sum of APPROVED cost transactions dated `<= T`, and ZERO when there
 *    are none. The canonical engine's current-state AC estimate (used when a project has no
 *    transactions yet) is deliberately NOT backcast into history, and no `timeRatio` linear
 *    interpolation is used anywhere: an empty period reports an empty period.
 * The canonical EV / AC / EAC scalars at the Data Date remain the authoritative "current" values
 * returned as `currentEv` / `currentAc` / `forecastEac`.
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
}

export interface SCurveData {
  points: SCurvePoint[];
  bac: number;
  currentEv: number;
  currentAc: number;
  forecastEac: number;
  dataDate: string;
}

/**
 * Source data the canonical EVM needs in order to evaluate the planned curve at arbitrary cutoffs.
 *
 * Both are the SAME inputs the caller already passed to `calculateProjectEvmAtDataDate`, which is
 * what makes the final cumulative PV reconcile to `evm.bac` exactly instead of approximately.
 */
export interface SCurveCanonicalSources {
  /** Structural subset of `Project` consumed by the canonical EVM (contract value and dates). */
  project?: {
    contract_value?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    data_date?: string | null;
  } | null;
  /** CBS budget lines — the legitimate per-activity cost allocation, matched by `wbs_node_id`. */
  budgetLines?: EvmBudgetLineInput[];
  /** BOQ items — canonical BAC fallback when there is neither a contract value nor budget lines. */
  boqItems?: BoqItem[];
}

function parseDate(d: string): number {
  return new Date(`${d}T00:00:00Z`).getTime();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

export function generateSCurveData(
  activities: Activity[],
  baselineActivities: BaselineActivity[],
  progressUpdates: ProgressUpdate[],
  costTransactions: CostTransaction[],
  evm: EvmMetrics & { dataDate?: string },
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
  const totalBac = Number(evm.bac || 0);

  if (activities.length === 0) {
    return {
      points: [],
      bac: totalBac,
      currentEv: evm.ev,
      currentAc: evm.ac,
      forecastEac: evm.eac,
      dataDate: effectiveDataDate,
    };
  }

  const budgetLines = canonicalSources.budgetLines || [];
  const boqItems = canonicalSources.boqItems || [];
  // Without a project the canonical engine would resolve its own BAC fallback; supplying the
  // canonical BAC the caller already computed keeps the curve reconciled to it exactly.
  const canonicalProject = canonicalSources.project ?? {
    contract_value: totalBac,
    start_date: projectStartDate ?? null,
    end_date: projectEndDate ?? null,
    data_date: effectiveDataDate,
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
  // must BEGIN after it, and the planned value on that bucket must equal the canonical EV/PV state.
  if (!cutOffDates.includes(effectiveDataDateTime)) {
    cutOffDates.push(effectiveDataDateTime);
  }
  cutOffDates.sort((a, b) => a - b);

  // The canonical EVM is the single evaluation path for the planned curve. Evaluating it at each
  // cutoff reuses BOTH its cost allocation and its planned-value progression, so no second PV
  // formula exists here. Earned value on the same call is evidence-only because the activities are
  // passed with `percent_complete` zeroed: only approved progress updates dated on or before the
  // cutoff can then contribute, which is exactly the GAP-024 rule.
  const evidenceActivities = activities.map((act) => ({ ...act, percent_complete: 0 }));
  const lateEvidenceActivities = evidenceActivities.map((act) => ({
    ...act,
    early_start: act.late_start || act.early_start,
    early_finish: act.late_finish || act.early_finish,
  }));

  const approvedCosts = [...costTransactions]
    .filter((c) => c.status === 'approved')
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));

  const points: SCurvePoint[] = [];

  for (let i = 0; i < cutOffDates.length; i++) {
    const cutoff = cutOffDates[i];
    const cutoffStr = formatDate(cutoff);
    const d = new Date(cutoff);
    const label = d.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' });

    const atCutoff = calculateProjectEvmAtDataDate(
      canonicalProject,
      evidenceActivities,
      budgetLines,
      boqItems,
      [],
      progressUpdates,
      cutoffStr,
    );
    const atCutoffLate = calculateProjectEvmAtDataDate(
      canonicalProject,
      lateEvidenceActivities,
      budgetLines,
      boqItems,
      [],
      progressUpdates,
      cutoffStr,
    );

    const pvEarly = atCutoff.pv;
    const pvLate = atCutoffLate.pv;

    // A bucket is actual iff it is on or before the Data Date (no half-step grace).
    const isPastOrPresent = cutoff <= effectiveDataDateTime;

    let evVal: number | null = null;
    let acVal: number | null = null;
    let forecastVal: number | null = null;

    if (isPastOrPresent) {
      // Evidence-only earned value: approved progress updates dated <= cutoff, valued with the
      // canonical cost allocation. No current `percent_complete`, no time interpolation.
      evVal = Math.round(atCutoff.ev);
      // Evidence-only actual cost: approved transactions dated <= cutoff. Zero when there are none,
      // because the canonical current-state AC estimate must not be backcast into history.
      acVal = Math.round(
        approvedCosts
          .filter((c) => c.transaction_date <= cutoffStr)
          .reduce((sum, c) => sum + Number(c.amount || 0), 0),
      );
    } else {
      // Forecast: canonical EAC less canonical AC at the Data Date, spread over the remaining
      // planned span. It starts from the canonical current cost, never from fabricated history.
      const remainingTime = maxTime - effectiveDataDateTime;
      const currentOffset = cutoff - effectiveDataDateTime;
      const progressFactor = remainingTime > 0 ? Math.min(1, Math.max(0, currentOffset / remainingTime)) : 1;
      const remainingCost = Math.max(0, Number(evm.eac || 0) - Number(evm.ac || 0));
      forecastVal = Math.round(Number(evm.ac || 0) + remainingCost * progressFactor);
    }

    const prevPv = i > 0 ? points[i - 1].pvEarlyCumulative : 0;
    const prevEv = i > 0 && points[i - 1].evCumulative !== null ? (points[i - 1].evCumulative as number) : 0;
    const prevAc = i > 0 && points[i - 1].acCumulative !== null ? (points[i - 1].acCumulative as number) : 0;

    points.push({
      date: cutoffStr,
      label,
      pvEarlyCumulative: Math.round(pvEarly),
      pvLateCumulative: Math.round(pvLate),
      evCumulative: evVal,
      acCumulative: acVal,
      forecastCumulative: forecastVal,
      // Incremental periods are floored at zero so an approved downward correction in a cumulative
      // series cannot render as negative work in a bar chart; the cumulative series still shows it.
      periodPv: Math.max(0, Math.round(pvEarly - prevPv)),
      periodEv: evVal !== null ? Math.max(0, Math.round(evVal - prevEv)) : null,
      periodAc: acVal !== null ? Math.max(0, Math.round(acVal - prevAc)) : null,
    });
  }

  return {
    points,
    bac: totalBac,
    // Canonical scalars at the Data Date (SSOT), not the evidence-only roll-up and not a fallback
    // chain that would silently substitute one for the other.
    currentEv: evm.ev,
    currentAc: evm.ac,
    forecastEac: evm.eac,
    dataDate: effectiveDataDate,
  };
}

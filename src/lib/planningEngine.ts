// `EvmMetrics` and `BudgetLine` are no longer imported: Wave 2 removed the two functions that
// used them (`calculateEvmMetrics`, `calculateQuantityBasedEvm`). The canonical engine types its
// budget input as `EvmBudgetLineInput` and returns `ComprehensiveProjectEvm`.
import type {
  ParsedBoqRow,
  Activity,
  Risk,
  BoqItem,
  BaselineActivity,
  CostTransaction,
  ProgressUpdate,
} from '@/types';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';

export interface ProductivityRule {
  category: string;
  daily_output: number;
  crew_size: number;
  difficulty_factor: number;
}

export interface SmartActivityPlan {
  code: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  duration_days: number;
  planned_cost: number;
  early_start: string;
  early_finish: string;
  predecessor_code: string | null;
}

const DEFAULT_PRODUCTIVITY: Record<string, ProductivityRule> = {
  Foundations: { category: 'Foundations', daily_output: 25, crew_size: 6, difficulty_factor: 1 },
  Earthworks: { category: 'Earthworks', daily_output: 120, crew_size: 5, difficulty_factor: 1 },
  'Concrete Works': { category: 'Concrete Works', daily_output: 40, crew_size: 8, difficulty_factor: 1 },
  'Reinforcement Steel': { category: 'Reinforcement Steel', daily_output: 2.5, crew_size: 5, difficulty_factor: 1 },
  Masonry: { category: 'Masonry', daily_output: 35, crew_size: 6, difficulty_factor: 1 },
  'Roofing & Insulation': { category: 'Roofing & Insulation', daily_output: 60, crew_size: 5, difficulty_factor: 1 },
  Plastering: { category: 'Plastering', daily_output: 80, crew_size: 5, difficulty_factor: 1 },
  'Tiling & Flooring': { category: 'Tiling & Flooring', daily_output: 45, crew_size: 5, difficulty_factor: 1 },
  'Doors & Windows': { category: 'Doors & Windows', daily_output: 8, crew_size: 4, difficulty_factor: 1 },
  Electrical: { category: 'Electrical', daily_output: 12, crew_size: 5, difficulty_factor: 1 },
  'Plumbing & Drainage': { category: 'Plumbing & Drainage', daily_output: 10, crew_size: 5, difficulty_factor: 1 },
  HVAC: { category: 'HVAC', daily_output: 4, crew_size: 4, difficulty_factor: 1 },
  Painting: { category: 'Painting', daily_output: 100, crew_size: 5, difficulty_factor: 1 },
  General: { category: 'General', daily_output: 20, crew_size: 4, difficulty_factor: 1 },
};

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + Math.max(0, days));
  return result;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function getProductivityRule(category: string, rules: ProductivityRule[] = []): ProductivityRule {
  return rules.find((rule) => rule.category === category) || DEFAULT_PRODUCTIVITY[category] || DEFAULT_PRODUCTIVITY.General;
}

export function calculateProductionDuration(quantity: number, category: string, rules: ProductivityRule[] = []): number {
  const rule = getProductivityRule(category, rules);
  if (quantity <= 0) return 1;
  return Math.max(1, Math.ceil((quantity / rule.daily_output) * rule.difficulty_factor));
}

export function generateSmartActivityPlans(
  rows: ParsedBoqRow[],
  startDate: string,
  rules: ProductivityRule[] = [],
): SmartActivityPlan[] {
  let cursor = new Date(startDate);
  let predecessorCode: string | null = null;

  return rows.map((row, index) => {
    const category = row.category || 'General';
    const duration = calculateProductionDuration(row.quantity, category, rules);
    const start = new Date(cursor);
    const finish = addDays(start, duration);
    const plan: SmartActivityPlan = {
      code: `SMART-ACT-${String(index + 1).padStart(3, '0')}`,
      name: row.description.substring(0, 100),
      category,
      quantity: row.quantity,
      unit: row.unit,
      duration_days: duration,
      planned_cost: row.total_price,
      early_start: formatDate(start),
      early_finish: formatDate(finish),
      predecessor_code: predecessorCode,
    };
    predecessorCode = plan.code;
    cursor = addDays(finish, 1);
    return plan;
  });
}

/**
 * Canonical result of the project-control EVM engine (SSOT — GAP-044).
 *
 * Every derived index in this shape is produced by `assessEvmRatios`; no other module may
 * re-implement these formulas. Fields marked as compatibility aliases keep existing consumers
 * compiling and are scheduled for migration in a later wave.
 */
export interface ComprehensiveProjectEvm {
  bac: number;
  dataDate: string;
  /**
   * Canonical earned project progress (GAP-045): `EV / BAC * 100` when `BAC > 0`, otherwise 0.
   * This — not an activity `percent_complete` average — is the project-control progress metric.
   */
  earnedProgressPercent: number;
  /**
   * @deprecated Compatibility alias of `earnedProgressPercent` (identical value, kept so current
   * consumers keep compiling). Migrate reads to `earnedProgressPercent`.
   */
  actualProgressPercent: number;
  /** Planned progress: `PV / BAC * 100` when `BAC > 0`, otherwise 0. */
  plannedProgressPercent: number;
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  spi: number;
  /** Data-quality status of `spi` (UG-049). Read this before presenting `spi`. */
  spiStatus: EvmRatioStatus;
  cpi: number;
  /** Data-quality status of `cpi` (UG-049). Read this before presenting `cpi`. */
  cpiStatus: EvmRatioStatus;
  eac: number;
  etc: number;
  vac: number;
  tcpi: number;
  /** Boundary status of `tcpi` (GAP-042). Read this before presenting `tcpi`. */
  tcpiStatus: TcpiStatus;
}

/**
 * Status of a performance ratio whose denominator can legitimately be zero (UG-049).
 *
 * The distinction that matters: an empty project (nothing earned, nothing planned/spent) is a
 * normal state, whereas earned value existing with no planned value or no actual cost is a
 * data-quality anomaly that must never be presented as healthy `1.0` performance.
 */
export type EvmRatioStatus =
  | 'valid' // denominator > 0 — the ratio is a measured value
  | 'empty_no_data' // numerator === 0 and denominator <= 0 — legitimate empty state
  | 'anomalous_zero_denominator'; // numerator > 0 and denominator <= 0 — data-quality anomaly

/**
 * Status of the To-Complete Performance Index (GAP-042).
 *
 * `BAC - AC` is the funds remaining; when it is zero the index is mathematically undefined, and
 * when it is negative the budget is already exhausted so the remaining-work target is
 * unachievable. Neither case may be reported as `1.0`, which would falsely communicate that
 * normal planned efficiency is still sufficient.
 */
export type TcpiStatus =
  | 'valid' // BAC - AC > 0
  | 'undefined_zero_denominator' // BAC - AC === 0
  | 'overrun_budget_exhausted'; // BAC - AC < 0

/**
 * Compatibility value used when a ratio is undefined in a legitimate EMPTY state (0/0).
 * Neutral by convention and always paired with `spiStatus`/`cpiStatus === 'empty_no_data'`, so a
 * consumer can render "—" instead. Preserves the pre-Wave-2 numeric behaviour of empty states.
 */
export const RATIO_EMPTY_STATE_VALUE = 1;

/**
 * Compatibility value used when earned value exists but the denominator does not (UG-049).
 * Deliberately not a healthy-looking `1.0`: an anomaly must never read as "on plan / on budget".
 * Finite by design — NaN and Infinity are never exposed to UI-facing values.
 */
export const RATIO_ANOMALY_VALUE = 0;

/**
 * Compatibility value for a TCPI that is undefined (no remaining budget) or unachievable
 * (overrun). The required efficiency is unbounded there, so a finite, unmistakably non-healthy
 * ceiling is reported instead of `1.0`, `NaN` or `Infinity`. The authoritative signal is
 * `tcpiStatus`; UI must render "—" / "Overrun" from it.
 *
 * Transitional: no consumer currently reads the engine's `tcpi` field (BudgetView computes its
 * own local TCPI, tracked as a deferred consumer migration), so this sentinel is safe to adopt.
 */
export const TCPI_UNACHIEVABLE_SENTINEL = 9.99;

/** Derived EVM indices produced by the single shared formula set. */
export interface EvmAssessment {
  sv: number;
  cv: number;
  spi: number;
  spiStatus: EvmRatioStatus;
  cpi: number;
  cpiStatus: EvmRatioStatus;
  eac: number;
  etc: number;
  vac: number;
  tcpi: number;
  tcpiStatus: TcpiStatus;
  /** Canonical earned progress (GAP-045): `EV / BAC * 100` when `BAC > 0`, else 0. */
  earnedProgressPercent: number;
  /** Planned progress: `PV / BAC * 100` when `BAC > 0`, else 0. */
  plannedProgressPercent: number;
}

/**
 * The single formula set for derived EVM indices — SSOT for GAP-044, GAP-042, GAP-045, UG-049.
 *
 * Every EVM producer in this module delegates here; no other function may re-implement SPI, CPI,
 * EAC, ETC, VAC, TCPI or the progress percentages. Rounding policy is the canonical engine's
 * existing one and is unchanged: SPI/CPI/TCPI to 2 decimals, progress percentages to 1 decimal,
 * EAC/ETC to whole currency units.
 *
 * Zero-denominator policy (the point of this wave):
 * - denominator > 0                      -> measured value, status `valid`
 * - numerator === 0 and denominator <= 0 -> `RATIO_EMPTY_STATE_VALUE`, status `empty_no_data`
 * - numerator > 0 and denominator <= 0   -> `RATIO_ANOMALY_VALUE`, status
 *                                           `anomalous_zero_denominator` (never a silent 1.0)
 * - TCPI with BAC - AC <= 0              -> `TCPI_UNACHIEVABLE_SENTINEL` plus an explicit status
 *
 * For every input where PV, EV, AC and BAC are all positive the returned numbers are identical to
 * the previous implementation (CASE E); only the undefined/anomalous boundaries changed.
 */
export function assessEvmRatios(bac: number, pv: number, ev: number, ac: number): EvmAssessment {
  const sv = ev - pv;
  const cv = ev - ac;

  const spiStatus: EvmRatioStatus = pv > 0 ? 'valid' : ev > 0 ? 'anomalous_zero_denominator' : 'empty_no_data';
  const cpiStatus: EvmRatioStatus = ac > 0 ? 'valid' : ev > 0 ? 'anomalous_zero_denominator' : 'empty_no_data';

  const spi =
    spiStatus === 'valid'
      ? Number((ev / pv).toFixed(2))
      : spiStatus === 'empty_no_data'
        ? RATIO_EMPTY_STATE_VALUE
        : RATIO_ANOMALY_VALUE;

  const cpi =
    cpiStatus === 'valid'
      ? Number((ev / ac).toFixed(2))
      : cpiStatus === 'empty_no_data'
        ? RATIO_EMPTY_STATE_VALUE
        : RATIO_ANOMALY_VALUE;

  // EAC = BAC / CPI (unchanged formula). When CPI is not a measured value the sentinel keeps the
  // pre-existing outcome: EAC falls back to BAC rather than dividing by a non-measured index.
  const eac = cpi > 0 ? Math.round(bac / cpi) : bac;
  const etc = Math.max(0, eac - ac);
  const vac = bac - eac;

  const remainingBudget = bac - ac;
  const tcpiStatus: TcpiStatus =
    remainingBudget > 0 ? 'valid' : remainingBudget === 0 ? 'undefined_zero_denominator' : 'overrun_budget_exhausted';
  const tcpi =
    tcpiStatus === 'valid' ? Number(((bac - ev) / remainingBudget).toFixed(2)) : TCPI_UNACHIEVABLE_SENTINEL;

  const earnedProgressPercent = bac > 0 ? Number(((ev / bac) * 100).toFixed(1)) : 0;
  const plannedProgressPercent = bac > 0 ? Number(((pv / bac) * 100).toFixed(1)) : 0;

  return {
    sv,
    cv,
    spi,
    spiStatus,
    cpi,
    cpiStatus,
    eac,
    etc,
    vac,
    tcpi,
    tcpiStatus,
    earnedProgressPercent,
    plannedProgressPercent,
  };
}

/**
 * Minimum legitimate budget-line structure required by `calculateProjectEvmAtDataDate`.
 *
 * These are exactly the fields the engine reads: `planned_cost` and `approved_budget`
 * (BAC from CBS budget lines), `wbs_node_id` (matching an activity to its budget line) and
 * `actual_cost` (AC cross-check).
 *
 * The identity fields `project_id` and `wbs_node_id` are REQUIRED on purpose. They are what a
 * genuine CBS budget line always has and what a baseline activity snapshot never has, so an
 * invalid business-data relationship — passing `BaselineActivity[]` where budget lines are
 * expected (GAP-036) — is a compile error instead of silently computing BAC/AC from the wrong
 * table. `BudgetLine` satisfies this contract structurally; no caller has to change.
 *
 * Type-position only: no formula, fallback, or ordering inside the engine is altered.
 */
export type EvmBudgetLineInput = {
  /** Row identity — a CBS budget line always belongs to a project. */
  project_id: string;
  /** CBS/WBS anchor used by the engine to match an activity to its budget line. */
  wbs_node_id: string | null;
  planned_cost: number;
  approved_budget?: number;
  actual_cost?: number;
};

/** Internal helper for compile-time assertions; emits no JavaScript. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time regression guard for GAP-036.
 *
 * Resolves to `true` as long as a `BaselineActivity` cannot masquerade as an EVM budget line.
 * If `EvmBudgetLineInput` is ever loosened again (e.g. by making `project_id`/`wbs_node_id`
 * optional), this alias becomes `AssertTrue<false>` and compilation fails with
 * "Type 'false' does not satisfy the constraint 'true'".
 */
export type EvmBudgetInputExcludesBaselineActivity = AssertTrue<
  BaselineActivity extends EvmBudgetLineInput ? false : true
>;

/**
 * Percent-complete sanitizer for the earned-value path (GAP-005).
 *
 * A recorded `0` stays `0` — it is real evidence of "nothing earned". `null`, `undefined` and any
 * non-finite value resolve to `0`, which is the legitimate business default: no earned value is
 * claimed without evidence, progress is never fabricated, and a malformed row can never leak
 * `NaN` into SPI/CPI/TCPI or into a UI-facing value.
 */
function finiteOrZero(percent: number | null | undefined): number {
  const value = Number(percent ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * CANONICAL project-control EVM engine — the single source of truth (GAP-044).
 *
 * This is the only function that assembles project EVM from operational data: it derives BAC,
 * computes PV and EV at the governed data date from the CPM activities, budget lines, BOQ items,
 * approved cost transactions and approved progress updates, then delegates every derived index
 * (SPI, CPI, EAC, ETC, VAC, TCPI, progress percentages and their statuses) to `assessEvmRatios`.
 *
 * Do not add a second EVM implementation. Views and engines that need project EVM must call this
 * function; helpers that only reshape already-known scalars must delegate to `assessEvmRatios`.
 *
 * Earned-value precedence per activity (GAP-005):
 *   1. the latest approved `ProgressUpdate` dated on or before the data date; otherwise
 *   2. the activity's own recorded `percent_complete`, where a recorded 0% stays 0% and a
 *      missing value resolves to 0% — progress is never fabricated from elapsed time or from a
 *      falsy-to-100 fallback.
 */
export function calculateProjectEvmAtDataDate(
  // Structural subset of `Project`. The date/value fields accept `null` because `Project`
  // declares them as `string | null` / nullable numbers; every use below already guards with
  // `||` fallbacks, so no calculation changes.
  project: {
    contract_value?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    data_date?: string | null;
  },
  activities: Activity[],
  budgetLines: EvmBudgetLineInput[] = [],
  boqItems: BoqItem[] = [],
  costTransactions: CostTransaction[] = [],
  progressUpdates: ProgressUpdate[] = [],
  overrideDataDate?: string,
): ComprehensiveProjectEvm {
  // Governed data-date resolution (GAP-004): explicit override -> project data date -> the
  // single governed default. The previously hardcoded '2026-11-15' literal is removed from the
  // central EVM path; view-level literals are separate consumer GAPs and are untouched here.
  const dataDateStr = overrideDataDate || project.data_date || DEFAULT_DATA_DATE;
  const dataDateMs = new Date(dataDateStr).getTime();

  // 1. Calculate BAC
  const bgtSum = budgetLines.reduce((s, b) => s + Number(b.planned_cost || b.approved_budget || 0), 0);
  const boqSum = boqItems.reduce((s, b) => s + Number(b.total_price || 0), 0);
  const bac = Number(project.contract_value || bgtSum || boqSum || 1000000);

  const totalActs = Math.max(1, activities.length);

  // Map each activity to its budget cost
  const actCostMap = new Map<string, number>();
  activities.forEach((act) => {
    let cost = 0;
    if (act.wbs_node_id) {
      const bLine = budgetLines.find((b) => b.wbs_node_id === act.wbs_node_id);
      if (bLine) cost = Number(bLine.planned_cost || 0);
    }
    if (cost <= 0) {
      cost = bac / totalActs;
    }
    actCostMap.set(act.id, cost);
  });

  // Normalize activity costs to exactly sum to BAC
  const rawCostSum = Array.from(actCostMap.values()).reduce((s, c) => s + c, 0);
  const costScale = rawCostSum > 0 ? bac / rawCostSum : 1;
  activities.forEach((act) => {
    actCostMap.set(act.id, (actCostMap.get(act.id) || 0) * costScale);
  });

  // 2. Compute Planned Value (PV) at dataDate
  let totalPv = 0;
  activities.forEach((act) => {
    const actCost = actCostMap.get(act.id) || (bac / totalActs);
    const startMs = new Date(act.early_start || project.start_date || '2026-09-15').getTime();
    const finishMs = new Date(act.early_finish || project.end_date || '2027-04-30').getTime();

    if (dataDateMs <= startMs) {
      // Not planned to start yet
    } else if (dataDateMs >= finishMs) {
      // Planned to be 100% complete
      totalPv += actCost;
    } else {
      // In progress
      const duration = Math.max(86400000, finishMs - startMs);
      const elapsed = Math.max(0, dataDateMs - startMs);
      const ratio = Math.min(1.0, elapsed / duration);
      totalPv += actCost * ratio;
    }
  });

  // 3. Compute Earned Value (EV) at dataDate
  // Get approved progress updates up to dataDate
  const updatesByAct = new Map<string, ProgressUpdate>();
  progressUpdates
    .filter((p) => p.status === 'approved' && (!p.update_date || p.update_date <= dataDateStr))
    .sort((a, b) => (a.update_date || '').localeCompare(b.update_date || ''))
    .forEach((p) => {
      updatesByAct.set(p.activity_id, p);
    });

  let totalEv = 0;

  activities.forEach((act) => {
    const actCost = actCostMap.get(act.id) || (bac / totalActs);
    const startMs = new Date(act.early_start || project.start_date || '2026-09-15').getTime();

    let actPct = 0;
    const update = updatesByAct.get(act.id);
    if (update) {
      // An approved progress record is the authoritative earned source for this activity.
      actPct = finiteOrZero(update.percent_complete);
    } else if (dataDateMs >= startMs) {
      // No approved progress record: fall back to the activity's own recorded physical percent.
      //
      // GAP-005 (Critical): explicit nullish handling replaces the former `|| 100` fallback,
      // which turned a genuine 0% activity into 100% and fabricated earned value out of elapsed
      // time. `Activity.percent_complete` is typed as a required number, so the null branch is
      // purely defensive against untyped runtime rows.
      //   - recorded 0%            -> 0% earned (invariant: no evidence, no earned value)
      //   - recorded null/undefined -> 0% earned (legitimate default; never 100% by accident)
      //   - recorded N%            -> N% earned (unchanged)
      const recordedPct = finiteOrZero(act.percent_complete);
      const finishMs = new Date(act.early_finish || project.end_date || '2027-04-30').getTime();
      if (dataDateMs >= finishMs) {
        actPct = recordedPct;
      } else {
        const dur = Math.max(86400000, finishMs - startMs);
        const elp = Math.max(0, dataDateMs - startMs);
        actPct = Math.min(100, Math.round((elp / dur) * recordedPct));
      }
    }

    totalEv += actCost * (actPct / 100);
  });

  // 4. Compute Actual Cost (AC) at dataDate
  const approvedTxns = costTransactions.filter(
    (t) => t.status === 'approved' && (!t.transaction_date || t.transaction_date <= dataDateStr),
  );
  let totalAc = approvedTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);

  if (totalAc === 0) {
    // If no transactions logged for this project yet, estimate realistically from budget lines and progress
    const bgtAc = budgetLines.reduce((s, b) => s + Number(b.actual_cost || 0), 0);
    totalAc = bgtAc > 0 ? Math.round(bgtAc * Math.min(1, totalEv / Math.max(1, bac))) : Math.round(totalEv * 0.95);
  }

  // 5. Final Metrics & Variances — delegated to the single shared formula set (GAP-044).
  // The aggregates are rounded exactly as before, so for any project where BAC, PV, EV and AC are
  // all positive every derived number is unchanged (CASE E). Only the undefined / anomalous
  // boundaries behave differently, and they now carry an explicit status instead of a silent 1.0.
  const pv = Math.round(totalPv);
  const ev = Math.round(totalEv);
  const ac = Math.round(totalAc);

  const assessment = assessEvmRatios(bac, pv, ev, ac);

  return {
    bac,
    dataDate: dataDateStr,
    earnedProgressPercent: assessment.earnedProgressPercent,
    // Compatibility alias carrying the same canonical value (GAP-045); consumers migrate later.
    actualProgressPercent: assessment.earnedProgressPercent,
    plannedProgressPercent: assessment.plannedProgressPercent,
    pv,
    ev,
    ac,
    sv: assessment.sv,
    cv: assessment.cv,
    spi: assessment.spi,
    spiStatus: assessment.spiStatus,
    cpi: assessment.cpi,
    cpiStatus: assessment.cpiStatus,
    eac: assessment.eac,
    etc: assessment.etc,
    vac: assessment.vac,
    tcpi: assessment.tcpi,
    tcpiStatus: assessment.tcpiStatus,
  };
}

/**
 * Low-level helper for callers that already hold EVM scalars — NOT a project EVM engine.
 *
 * Scope (GAP-044): it performs no data-date filtering, no BAC derivation and no traversal of
 * activities, budget lines, transactions or progress updates. It converts a BAC plus two 0..1
 * progress ratios and an actual cost into PV/EV, then delegates every derived index to
 * `assessEvmRatios` — the same single formula set used by the canonical
 * `calculateProjectEvmAtDataDate`. It therefore implements no divergent business formula and must
 * never acquire one.
 *
 * Intended for empty-state / demo / fallback paths that have no project data yet (e.g. the
 * Dashboard before a project is selected). Replaces the former `calculateEvmMetrics`, which was a
 * competing mini-engine: it duplicated SPI/CPI/EAC with a different zero-denominator policy
 * (silent `1`) and no rounding, and it returned no progress or status information.
 */
export function deriveEvmFromScalars(
  bac: number,
  plannedProgress: number,
  actualProgress: number,
  actualCost: number,
  dataDate: string = DEFAULT_DATA_DATE,
): ComprehensiveProjectEvm {
  const pv = bac * Math.max(0, Math.min(plannedProgress, 1));
  const ev = bac * Math.max(0, Math.min(actualProgress, 1));
  const assessment = assessEvmRatios(bac, pv, ev, actualCost);

  return {
    bac,
    dataDate,
    earnedProgressPercent: assessment.earnedProgressPercent,
    actualProgressPercent: assessment.earnedProgressPercent,
    plannedProgressPercent: assessment.plannedProgressPercent,
    pv,
    ev,
    ac: actualCost,
    sv: assessment.sv,
    cv: assessment.cv,
    spi: assessment.spi,
    spiStatus: assessment.spiStatus,
    cpi: assessment.cpi,
    cpiStatus: assessment.cpiStatus,
    eac: assessment.eac,
    etc: assessment.etc,
    vac: assessment.vac,
    tcpi: assessment.tcpi,
    tcpiStatus: assessment.tcpiStatus,
  };
}

/**
 * Activity/task completion average — NOT earned project progress (GAP-045).
 *
 * Returns a cost-weighted (or, when no weights are supplied, unweighted arithmetic) average of
 * activity `percent_complete` as a 0..1 fraction. That is a task-completion statistic: it ignores
 * budget distribution across the schedule and therefore must never be presented as the project
 * progress metric. The canonical project-control progress is
 * `ComprehensiveProjectEvm.earnedProgressPercent` (EV / BAC * 100) produced by
 * `calculateProjectEvmAtDataDate`.
 *
 * Formerly exported as `calculateWeightedProgress`; renamed so the name cannot masquerade as
 * earned progress. Formula unchanged.
 */
export function calculateActivityCompletionAverage(

  activities: Activity[],
  weights: Map<string, number>,
): number {
  if (activities.length === 0) return 0;
  let weightedValue = 0;
  let totalWeight = 0;
  activities.forEach((activity) => {
    const weight = Math.max(0, weights.get(activity.id) || 0);
    weightedValue += weight * Math.max(0, Math.min(100, Number(activity.percent_complete || 0)));
    totalWeight += weight;
  });
  return totalWeight > 0
    ? weightedValue / totalWeight / 100
    : activities.reduce((sum, activity) => sum + Number(activity.percent_complete || 0), 0) / activities.length / 100;
}

export function forecastFinishDate(
  plannedFinish: string | null,
  spi: number,
  today = new Date(),
): string | null {
  if (!plannedFinish) return null;
  if (spi <= 0) return null;
  const planned = new Date(`${plannedFinish}T00:00:00Z`);
  const remainingDays = Math.max(0, Math.ceil((planned.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));
  const forecast = new Date(today);
  forecast.setUTCDate(forecast.getUTCDate() + Math.ceil(remainingDays / spi));
  return forecast.toISOString().split('T')[0];
}

export interface ForecastScenarios {
  optimistic: string | null;
  realistic: string | null;
  pessimistic: string | null;
}

export interface ForecastAnalysis {
  scenarios: ForecastScenarios;
  cost: {
    optimistic: number;
    realistic: number;
    pessimistic: number;
  };
  confidence: number;
  volatility: number;
  riskExposure: {
    cost: number;
    days: number;
  };
}

export function forecastFinishScenarios(
  plannedStart: string | null,
  plannedFinish: string | null,
  actualProgress: number,
  spi: number,
  today = new Date(),
): ForecastScenarios {
  if (!plannedStart || !plannedFinish || actualProgress >= 1) {
    return { optimistic: plannedFinish, realistic: plannedFinish, pessimistic: plannedFinish };
  }

  const start = new Date(`${plannedStart}T00:00:00Z`);
  const finish = new Date(`${plannedFinish}T00:00:00Z`);
  const totalDays = Math.max(1, Math.ceil((finish.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
  const remainingDays = Math.max(0, totalDays * (1 - Math.max(0, Math.min(1, actualProgress))));
  const calculate = (performanceIndex: number): string => {
    const forecast = new Date(today);
    forecast.setUTCDate(forecast.getUTCDate() + Math.ceil(remainingDays / Math.max(0.25, performanceIndex)));
    return forecast.toISOString().split('T')[0];
  };
  return {
    optimistic: calculate(Math.max(1, spi)),
    realistic: calculate(spi),
    pessimistic: calculate(Math.min(0.75, spi)),
  };
}

export function analyzeForecast(
  plannedStart: string | null,
  plannedFinish: string | null,
  bac: number,
  actualCost: number,
  actualProgress: number,
  spi: number,
  cpi: number,
  criticalCount: number,
  nearCriticalCount: number,
  risks: Risk[] = [],
): ForecastAnalysis {
  const safeCpi = Math.max(0.25, cpi || 1);
  const safeSpi = Math.max(0.25, spi || 1);
  const volatility = Math.min(1, Math.abs(1 - safeSpi) * 0.6 + Math.abs(1 - safeCpi) * 0.4);
  const confidence = Math.round(Math.max(0, Math.min(100, 100 - volatility * 70 - criticalCount * 2 - nearCriticalCount)));
  const remaining = Math.max(0, 1 - Math.max(0, Math.min(1, actualProgress)));
  const openRisks = risks.filter((risk) => risk.status === 'open');
  const riskExposure = openRisks.reduce((exposure, risk) => ({
    cost: exposure.cost + bac * (Math.max(0, Math.min(5, Number(risk.probability || 0))) / 5)
      * (Math.max(0, Math.min(5, Number(risk.impact || 0))) / 5) * 0.05,
    days: exposure.days + (Math.max(0, Math.min(5, Number(risk.probability || 0))) / 5)
      * (Math.max(0, Math.min(5, Number(risk.impact || 0))) / 5) * 5,
  }), { cost: 0, days: 0 });
  return {
    scenarios: forecastFinishScenarios(plannedStart, plannedFinish, actualProgress, safeSpi),
    cost: {
      optimistic: actualCost + (bac * remaining) / Math.max(1, safeCpi * 1.15),
      realistic: actualCost + (bac * remaining) / safeCpi,
      pessimistic: actualCost + (bac * remaining) / Math.max(0.25, safeCpi * 0.8),
    },
    confidence,
    volatility,
    riskExposure,
  };
}

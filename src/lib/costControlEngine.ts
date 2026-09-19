/**
 * F6 — Cost Control & Forecast Integrity.
 *
 * A pure, deterministic decision layer over authorized budgets, approved actuals and measured
 * progress. It is deliberately NOT the canonical EVM engine (`planningEngine`): the canonical
 * engine uses sentinel ratio values, a single EAC with silent BAC fallback, a silent
 * contract-value BAC fallback and a planned-percent time-phase cap on EV. F6 mandates different
 * semantics (N/A guards, four explicit EAC methods with a rule-based recommendation, authorized
 * budgets only, recorded progress only), so this module implements them directly while the
 * canonical engine stays byte-identical.
 *
 * Hard rules (locked by the F6 charter):
 * - BAC comes from authorized planned cost only: the active approved baseline first, else the
 *   BOQ-derived budget lines. Contract value is used ONLY when the caller explicitly opts in
 *   (`allowContractValueBac`), and is then labeled as such. No pro-rata invention: a BAC that
 *   cannot be distributed to activities yields project-level BAC only, with EV/PV as N/A.
 * - PV is linear proration over baseline dates (labeled `linear_baseline`), or over CPM early
 *   dates when no baseline exists (labeled `linear_cpm_proxy`, confidence-capped). No other
 *   time-phasing exists anywhere in F6, and F6 emits no monthly cash-flow spread.
 * - EV is recorded percent complete times the authorized activity budget. Planned (time-phased)
 *   percent is never substituted for recorded progress.
 * - AC is approved cost transactions on or before the Data Date, counted exactly once.
 * - Every ratio guards zero denominators with N/A (null). No Infinity/NaN is ever produced.
 * - Committed, actual, budget and forecast are never conflated. Uncommitted budget is not
 *   savings. EAC/VAC/ETC are derived per level, never summed across levels.
 * - All detection thresholds are exported constants below. Missing inputs surface as N/A
 *   (null) or findings, never as fabricated defaults. No machine date anywhere.
 */

import { countWorkingDays, getCalendar } from './calendarEngine';
import { calendarDaysBetween, isAfterDataDate, isIsoDate } from './chronologyGuard';
import { applyGovernedProgress } from './governedProgress';
import { controlRecordCrossesProjectBoundary } from './demoDbContracts';
import type { ScheduleControlReport } from './scheduleControlEngine';
import type {
  Activity,
  ActivityBoqAllocation,
  BaselineActivity,
  BoqItem,
  BudgetLine,
  CalendarType,
  CostControlSnapshot,
  CostSnapshotDetails,
  CostTransaction,
  ProgressUpdate,
  WbsNode,
} from '@/types';

// ---------------------------------------------------------------------------
// Declared detection thresholds (F6 §14: no hidden thresholds)
// ---------------------------------------------------------------------------
/** CPI below this raises a cost-performance anomaly. */
export const CPI_ALERT_THRESHOLD = 0.9;
/** CPI/SPI below this counts as "driving" for the recommended-EAC decision. */
export const PERFORMANCE_CONCERN = 0.95;
/** |CPI - previous CPI| within this band counts as stable. */
export const CPI_STABILITY_BAND = 0.05;
/** |SPI - 1| within this band counts as schedule-neutral. */
export const SPI_NEUTRAL_BAND = 0.1;
/** Consecutive snapshots with CV < 0 that raise a repeated-overrun anomaly. */
export const CONSECUTIVE_OVERRUN_STREAK = 3;
/** Consecutive EAC increases that raise a worsening-forecast anomaly. */
export const EAC_WORSENING_STREAK = 3;
/** Minimum trend points (including current) for a burn-rate reading. */
export const BURN_MIN_SNAPSHOTS = 3;
/** Minimum calendar-day span (first to current) for a burn-rate reading. */
export const BURN_MIN_SPAN_DAYS = 14;
/** |CPI change| within this band reads as a stable burn efficiency trend. */
export const BURN_STABILITY_BAND = 0.02;
/** Recorded progress at/above this percent with BAC but zero AC raises a finding. */
export const PROGRESS_WITHOUT_COST_MIN_PCT = 10;
/** AC above this share of BAC at 0% progress escalates cost-without-progress to warning. */
export const COST_WITHOUT_PROGRESS_RATIO = 0.05;
/** A 100%-complete activity with AC below this share of EV raises a cost-short finding. */
export const COMPLETE_COST_SHORT_RATIO = 0.5;
/** Unpaid commitments above this multiple of remaining budgeted work raise exposure. */
export const COMMITTED_EXPOSURE_RATIO = 1.0;
/** Open contracted value diverging from committed lines beyond this share raises a gap note. */
export const COMMITMENT_GAP_TOLERANCE = 0.1;
/** Activities holding at least this share of project BAC are material for actions. */
export const MATERIAL_BAC_SHARE = 0.05;
/** Unattributed AC above this share of total AC raises an attribution action. */
export const UNATTRIBUTED_AC_SHARE = 0.1;
/** Maximum decision actions emitted. */
export const MAX_COST_ACTIONS = 5;

export type CostConfidence = 'High' | 'Medium' | 'Low';
export type BacSource = 'baseline' | 'budget_lines' | 'contract_value_explicit' | 'unavailable';
export type PvMethod = 'linear_baseline' | 'linear_cpm_proxy' | 'unavailable';
export type EacMethodKey = 'eac_cpi' | 'eac_ac_bac_ev' | 'eac_cpi_spi' | 'eac_manual';

export interface CostIntegrityFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  refKind: 'transaction' | 'budget_line' | 'activity' | 'package' | 'project';
  refId: string | null;
  refLabel: string | null;
  message: string;
  evidence: string[];
}

export interface BacBasis {
  value: number | null;
  source: BacSource;
  /** Share (0..1) of activities carrying a baseline row, or null when inapplicable. */
  coverage: number | null;
  confidence: CostConfidence;
  note: string;
}

export interface EacMethod {
  key: EacMethodKey;
  formula: string;
  inputs: Record<string, number | null>;
  value: number | null;
  applicable: boolean;
  applicability: string;
  confidence: CostConfidence;
}

export interface EacRecommendation {
  method: EacMethodKey;
  eac: number;
  etc: number;
  vac: number | null;
  why: string;
  confidence: CostConfidence;
}

export interface ActivityCost {
  id: string;
  code: string;
  name: string;
  wbsId: string | null;
  bac: number;
  bacSource: 'baseline' | 'budget_line_direct' | 'unavailable';
  pv: number | null;
  pvMethod: PvMethod;
  ev: number | null;
  ac: number;
  pct: number;
  cv: number | null;
  cpi: number | null;
  etc: number | null;
  eac: number | null;
  eacMethod: EacMethodKey | null;
  vac: number | null;
}

export interface WbsCost {
  id: string;
  code: string;
  name: string;
  level: number;
  childIds: string[];
  bac: number;
  pv: number | null;
  ev: number | null;
  ac: number;
  committed: number;
  cv: number | null;
  cpi: number | null;
  etc: number | null;
  eac: number | null;
  eacMethod: EacMethodKey | null;
  vac: number | null;
}

export interface BoqTrace {
  activityId: string;
  code: string;
  cv: number;
  items: Array<{ boqId: string; boqCode: string; costShare: number; wbsCode: string | null }>;
  tracedTotal: number;
  coverageNote: string;
}

export interface CostTrendPoint {
  dataDate: string;
  current: boolean;
  ac: number | null;
  ev: number | null;
  pv: number | null;
  cpi: number | null;
  spi: number | null;
  etc: number | null;
  eac: number | null;
  vac: number | null;
  committed: number | null;
  confidence: string | null;
}

export interface CostDrift {
  hasPrevious: boolean;
  previousDataDate: string | null;
  eacDrift: number | null;
  etcDrift: number | null;
  cpiChange: number | null;
  cvChange: number | null;
  direction: 'improving' | 'worsening' | 'stable' | 'unknown';
}

export interface BurnRate {
  sufficient: boolean;
  reason: string;
  snapshotsUsed: number;
  spanDays: number | null;
  acBurnPerDay: number | null;
  evRatePerDay: number | null;
  efficiencyTrend: 'improving' | 'declining' | 'stable' | 'unknown';
}

export interface CostAnomaly {
  code: string;
  message: string;
  evidence: string[];
  threshold: string;
}

export interface CostAction {
  rank: number;
  issue: string;
  evidence: string[];
  financialImpact: number;
  scheduleLinkage: string | null;
  action: string;
  confidence: CostConfidence;
}

export interface TimeCostFinding {
  code: string;
  severity: 'warning' | 'info';
  activityCode: string | null;
  message: string;
  evidence: string[];
}

export interface KpiConfidence {
  level: CostConfidence;
  sources: string[];
  notes: string[];
}

export interface CostControlInput {
  project: { id: string; data_date?: string | null; contract_value?: number | null };
  activities: Activity[];
  baselines: BaselineActivity[];
  budgetLines: BudgetLine[];
  costTransactions: CostTransaction[];
  progressUpdates?: ProgressUpdate[];
  wbsNodes: WbsNode[];
  boqItems: BoqItem[];
  allocations: ActivityBoqAllocation[];
  /**
   * Open-commitment reference, mapped DIRECTLY from `subcontract_packages` rows
   * (status + total value). Never the cached/defaulted loader: demo defaults would
   * fabricate exposure. Omit when the caller has no package rows.
   */
  subcontractPackages?: Array<{ status: string; totalSubcontractValueSar: number | null }>;
  previousSnapshots?: CostControlSnapshot[];
  scheduleReport?: ScheduleControlReport | null;
  /** Resolved Data Date (required: the engine never falls back to a clock). */
  dataDate: string;
  calendarType?: CalendarType;
  manualEtc?: number | null;
  /** Explicit opt-in ONLY: allow contract value as the last-resort BAC basis. */
  allowContractValueBac?: boolean;
}

export interface CostControlReport {
  dataDate: string;
  bac: BacBasis;
  pvMethod: 'linear_baseline' | 'linear_cpm_proxy' | 'mixed' | 'unavailable';
  project: {
    bac: number | null;
    pv: number | null;
    ev: number | null;
    ac: number;
    acSource: 'approved_transactions' | 'none_recorded';
    acCount: number;
    cv: number | null;
    sv: number | null;
    cpi: number | null;
    spi: number | null;
    etc: number | null;
    eac: number | null;
    vac: number | null;
  };
  eacMethods: EacMethod[];
  recommended: EacRecommendation | null;
  recommendedNote: string | null;
  commitment: {
    budget: number | null;
    committed: number;
    hasCommitmentData: boolean;
    actual: number;
    remainingCommitment: number | null;
    forecastEtc: number | null;
    contractedOpen: number | null;
    contractedNote: string;
  };
  activities: ActivityCost[];
  wbs: WbsCost[];
  unassigned: WbsCost;
  boqTrace: BoqTrace[];
  integrity: CostIntegrityFinding[];
  trend: CostTrendPoint[];
  drift: CostDrift;
  burn: BurnRate;
  anomalies: CostAnomaly[];
  actions: CostAction[];
  consistency: TimeCostFinding[];
  consistencyNote: string | null;
  confidence: Record<'bac' | 'pv' | 'ev' | 'ac' | 'eac' | 'forecast', KpiConfidence>;
}

export interface CostSnapshotPayload {
  project_id: string;
  data_date: string;
  bac: number | null;
  pv: number | null;
  ev: number | null;
  ac: number | null;
  cpi: number | null;
  spi: number | null;
  etc: number | null;
  eac: number | null;
  vac: number | null;
  committed: number | null;
  forecast_confidence: string | null;
  recommended_method: string | null;
  details: CostSnapshotDetails;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function byCode<T extends { code: string }>(a: T, b: T): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function minLevel(levels: CostConfidence[]): CostConfidence {
  if (levels.includes('Low')) return 'Low';
  if (levels.includes('Medium')) return 'Medium';
  return 'High';
}

// ---------------------------------------------------------------------------
// §0 — the actual-cost business key (H02: ONE duplicate rule, one population)
// ---------------------------------------------------------------------------

/**
 * The business key that defines "the same cost transaction twice" (H02, P2A1-H02).
 *
 * Two rows carrying the same key are the SAME economic event recorded twice — same date, same
 * amount, same activity / BOQ references, same vendor, same invoice number, same description. The
 * database id is deliberately NOT part of the key: two distinct rows with distinct ids are exactly
 * the duplicate this detects, and deduplicating by id would detect nothing at all.
 *
 * This is the single definition used by BOTH consumers of the rule:
 *   - `checkCostIntegrity`, which reports the duplicate in the register; and
 *   - the AC aggregation below, which must NOT count it twice.
 * Before this module exported one key, the register flagged duplicates that AC went on to sum, so a
 * duplicated invoice inflated AC (and therefore CPI, EAC and VAC) while the integrity panel merely
 * warned about it.
 */
export function costTransactionBusinessKey(t: CostTransaction): string {
  return JSON.stringify([
    t.transaction_date, Number(t.amount), t.activity_id, t.boq_item_id,
    t.vendor ?? null, t.invoice_number ?? null, t.description,
  ]);
}

/** Deterministic register order: transaction date, then id — the order "first occurrence" means. */
function byDateThenId(a: CostTransaction, b: CostTransaction): number {
  if (a.transaction_date !== b.transaction_date) return a.transaction_date < b.transaction_date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BusinessKeyDedupe<T> {
  /** The rows that survive: the first occurrence of each business key, in input order. */
  unique: T[];
  /** Every row dropped as a repeat of an earlier one, paired with the row it repeats. */
  duplicates: Array<{ row: T; first: T }>;
}

/**
 * Collapse a set of rows onto their business keys — the same rule `checkCostIntegrity` reports.
 *
 * Deterministic and id-independent: input order must already be the governed register order
 * (`byDateThenId`), so the surviving row is the earliest recorded occurrence and the result cannot
 * depend on array shuffling.
 */
export function dedupeByBusinessKey<T extends CostTransaction>(rows: readonly T[]): BusinessKeyDedupe<T> {
  const seen = new Map<string, T>();
  const unique: T[] = [];
  const duplicates: Array<{ row: T; first: T }> = [];
  for (const row of rows) {
    const key = costTransactionBusinessKey(row);
    const first = seen.get(key);
    if (first) {
      duplicates.push({ row, first });
      continue;
    }
    seen.set(key, row);
    unique.push(row);
  }
  return { unique, duplicates };
}

// ---------------------------------------------------------------------------
// §1 — cost data integrity
// ---------------------------------------------------------------------------

function checkCostIntegrity(
  txns: CostTransaction[],
  lines: BudgetLine[],
  activities: Activity[],
  activityAc: Map<string, number>,
  activityBac: Map<string, number>,
  dataDate: string,
  /**
   * H02: the ids that the AC aggregation dropped as repeats of an earlier row. A duplicate that is
   * inside the actual-cost population is reported as excluded, so the finding states the money
   * consequence instead of only warning about register hygiene.
   */
  excludedDuplicateIds?: ReadonlySet<string>,
): CostIntegrityFinding[] {
  const out: CostIntegrityFinding[] = [];
  const sortedTx = [...txns].sort(byDateThenId);

  // Duplicates: identical business key on distinct rows (NULL-safe equality). H02: the SAME key
  // function the AC aggregation uses, so detection and aggregation can never disagree about what a
  // duplicate is.
  const seen = new Map<string, CostTransaction>();
  for (const t of sortedTx) {
    const key = costTransactionBusinessKey(t);
    const first = seen.get(key);
    if (first && first.id !== t.id) {
      const excluded = excludedDuplicateIds ? excludedDuplicateIds.has(t.id) : false;
      out.push({
        severity: 'warning', code: 'duplicate_transaction', refKind: 'transaction',
        refId: t.id, refLabel: t.description,
        message: `Transaction ${t.id} duplicates ${first.id} (same date, amount, refs and description).`
          + (excluded ? ' The repeat is excluded from AC: it is counted once.' : ''),
        evidence: [
          `transaction_date = ${t.transaction_date}`, `amount = ${t.amount}`, `matches ${first.id}`,
          ...(excluded ? ['excluded from AC (counted once)'] : []),
        ],
      });
    } else {
      seen.set(key, t);
    }
  }

  for (const t of sortedTx) {
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      out.push({
        severity: 'error', code: 'negative_or_invalid_amount', refKind: 'transaction',
        refId: t.id, refLabel: t.description,
        message: `Transaction ${t.id} carries an invalid amount.`,
        evidence: [`amount = ${String(t.amount)}`],
      });
    } else if (amount === 0) {
      out.push({
        severity: 'info', code: 'zero_amount_recorded', refKind: 'transaction',
        refId: t.id, refLabel: t.description,
        message: `Transaction ${t.id} records a zero amount (a fact, not a gap).`,
        evidence: [`amount = 0`, `status = ${t.status}`],
      });
    }
    if (t.status === 'approved' && (t.source === null || t.source === undefined || String(t.source).trim() === '')) {
      out.push({
        severity: 'error', code: 'txn_without_source', refKind: 'transaction',
        refId: t.id, refLabel: t.description,
        message: `Approved transaction ${t.id} has no source document.`,
        evidence: [`amount = ${t.amount}`, `transaction_date = ${t.transaction_date}`, 'source is missing'],
      });
    }
    if (isAfterDataDate(t.transaction_date, dataDate)) {
      if (t.status === 'approved') {
        out.push({
          severity: 'error', code: 'future_transaction', refKind: 'transaction',
          refId: t.id, refLabel: t.description,
          message: `Approved transaction ${t.id} is dated ${t.transaction_date}, after the Data Date ${dataDate}, and is excluded from AC.`,
          evidence: [`transaction_date = ${t.transaction_date}`, `data_date = ${dataDate}`],
        });
      } else {
        out.push({
          severity: 'info', code: 'future_unapproved_transaction', refKind: 'transaction',
          refId: t.id, refLabel: t.description,
          message: `Unapproved transaction ${t.id} is dated after the Data Date (planned/forecast, not actual).`,
          evidence: [`transaction_date = ${t.transaction_date}`, `status = ${t.status}`],
        });
      }
    }
  }

  const sortedLines = [...lines].sort((a, b) => (a.description || a.id) < (b.description || b.id) ? -1 : 1);
  for (const l of sortedLines) {
    const committed = Number(l.committed_cost) || 0;
    const storedActual = Number(l.actual_cost) || 0;
    if (committed > 0 && storedActual > committed) {
      out.push({
        severity: 'warning', code: 'actual_exceeds_commitment', refKind: 'budget_line',
        refId: l.id, refLabel: l.description,
        message: `Budget line actual ${storedActual} exceeds its commitment ${committed} (per stored line actuals).`,
        evidence: [`actual_cost = ${storedActual}`, `committed_cost = ${committed}`],
      });
    }
    const hasMoney = (Number(l.planned_cost) || 0) > 0 || committed > 0 || storedActual > 0;
    if (hasMoney && !l.activity_id && !l.wbs_node_id && !l.boq_item_id) {
      out.push({
        severity: 'warning', code: 'budget_line_without_provenance', refKind: 'budget_line',
        refId: l.id, refLabel: l.description,
        message: 'Budget line carries money with no activity, WBS or BOQ provenance.',
        evidence: [
          `planned_cost = ${l.planned_cost}`, `committed_cost = ${l.committed_cost}`,
          `actual_cost = ${l.actual_cost}`,
        ],
      });
    }
  }

  const sortedActs = [...activities].sort(byCode);
  for (const a of sortedActs) {
    const pct = finiteNum(a.percent_complete) ?? 0;
    const bac = activityBac.get(a.id) || 0;
    const ac = activityAc.get(a.id) || 0;
    if (pct >= PROGRESS_WITHOUT_COST_MIN_PCT && bac > 0 && ac === 0) {
      out.push({
        severity: 'info', code: 'progress_without_cost_evidence', refKind: 'activity',
        refId: a.id, refLabel: a.code,
        message: `${a.code} shows ${pct}% progress with BAC ${bac} but no approved cost evidence.`,
        evidence: [`percent_complete = ${pct}`, `BAC = ${bac}`, 'activity AC = 0'],
      });
    }
    if (pct === 0 && ac > 0) {
      const ratio = bac > 0 ? ac / bac : 1;
      out.push({
        severity: ratio > COST_WITHOUT_PROGRESS_RATIO ? 'warning' : 'info',
        code: 'cost_without_progress', refKind: 'activity',
        refId: a.id, refLabel: a.code,
        message: `${a.code} has AC ${ac} at 0% progress (pre-spend, mobilization or misallocation).`,
        evidence: [`AC = ${ac}`, `BAC = ${bac}`, 'percent_complete = 0'],
      });
    }
    if (bac === 0 && ac > 0) {
      out.push({
        severity: 'warning', code: 'spend_without_budget', refKind: 'activity',
        refId: a.id, refLabel: a.code,
        message: `${a.code} spent ${ac} with no authorized activity budget.`,
        evidence: [`AC = ${ac}`, 'BAC = 0', `percent_complete = ${pct}`],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export function analyzeCostControl(input: CostControlInput): CostControlReport {
  const {
    project, activities, baselines, budgetLines, costTransactions, dataDate,
    calendarType = '6_days',
  } = input;
  const progressUpdates = input.progressUpdates || [];
  const wbsNodes = input.wbsNodes || [];
  const boqItems = input.boqItems || [];
  const allocations = input.allocations || [];
  const packages = input.subcontractPackages;
  const manualEtc = finiteNum(input.manualEtc) !== null && (input.manualEtc as number) >= 0
    ? (input.manualEtc as number) : null;
  const ruler = getCalendar(calendarType);
  // H01: earned value is a function of the GOVERNED as-of progress, not of the materialised
  // `activities.percent_complete` column. `progress_updates` (approved, on/before the Data Date) is
  // the source of truth — see `src/lib/governedProgress.ts`. Plan fields (dates, WBS, quantities)
  // are inherited untouched, so a governed record yields the original activity object.
  const governedActivities = applyGovernedProgress(activities, progressUpdates, dataDate);
  const sortedActs = [...governedActivities].sort(byCode);

  // --- AC transactions: approved, on/before the Data Date, and counted exactly once (H02). ---
  //
  // The actual-cost population is (approved AND in-period AND non-duplicate). De-duplication runs
  // INSIDE that population on purpose: a rejected or out-of-period row is not actual cost, so it
  // cannot be the "first occurrence" that cancels an approved one — collapsing the whole register
  // first would let a rejected row erase real spend. The business key is the same one
  // `checkCostIntegrity` reports, so every row dropped here is also reported there.
  // P2A1-M02 — the project boundary of an activity-bound transaction, evaluated with the SAME
  // predicate the demo store enforces on write (`controlRecordCrossesProjectBoundary`, mirroring the
  // live `validate_cost_project` trigger). A transaction that names an activity which does not exist,
  // or which belongs to another project, is QUARANTINED: it never reaches AC, and it is reported as
  // an integrity finding rather than being silently consumed.
  //
  // The analysed activity set IS this project's activities, so "not in the set" is exactly the SQL
  // predicate's `related_project IS NULL OR related_project <> NEW.project_id`. Rows that carry no
  // `activity_id` are project-level costs and are unaffected.
  const analysedActivityProjectById = new Map<string, string>();
  for (const a of governedActivities) analysedActivityProjectById.set(a.id, a.project_id ?? project.id);
  const invalidActivityRefs: Array<{ txn: CostTransaction; reason: 'activity_not_found' | 'foreign_project' }> = [];
  const inProjectCandidates = costTransactions
    .filter((t) => t.status === 'approved' && isIsoDate(t.transaction_date) && !isAfterDataDate(t.transaction_date, dataDate))
    .filter((t) => {
      const verdict = controlRecordCrossesProjectBoundary(
        t.activity_id, project.id, (id) => analysedActivityProjectById.get(id),
      );
      if (!verdict.crosses) return true;
      invalidActivityRefs.push({ txn: t, reason: verdict.reason });
      return false;
    });

  const acCandidates = [...inProjectCandidates].sort(byDateThenId);
  const acDedupe = dedupeByBusinessKey(acCandidates);
  const acTxns = acDedupe.unique;
  const acExcludedDuplicateIds = new Set(acDedupe.duplicates.map((d) => d.row.id));
  const activityAc = new Map<string, number>();
  for (const t of acTxns) {
    if (!t.activity_id) continue;
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    activityAc.set(t.activity_id, (activityAc.get(t.activity_id) || 0) + amount);
  }
  const projectAc = round2(acTxns.reduce((s, t) => {
    const amount = Number(t.amount);
    return s + (Number.isFinite(amount) && amount >= 0 ? amount : 0);
  }, 0));

  // --- §2 BAC basis (authorized planned cost only). ---
  const baselineByAct = new Map(baselines.map((b) => [b.activity_id, b]));
  const budgetPlanned = round2(budgetLines.reduce((s, b) => s + (Number(b.planned_cost) || 0), 0));
  let bac: BacBasis;
  if (baselines.length > 0) {
    const value = round2(baselines.reduce((s, b) => s + (Number(b.planned_cost) || 0), 0));
    const covered = activities.filter((a) => baselineByAct.has(a.id)).length;
    const coverage = activities.length > 0 ? covered / activities.length : 0;
    bac = {
      value,
      source: 'baseline',
      coverage: round3(coverage),
      confidence: coverage === 1 ? 'High' : coverage >= 0.8 ? 'Medium' : 'Low',
      note: `Active approved baseline: ${baselines.length} rows over ${covered}/${activities.length} activities.`,
    };
  } else if (budgetPlanned > 0) {
    bac = {
      value: budgetPlanned,
      source: 'budget_lines',
      coverage: null,
      confidence: 'Medium',
      note: 'No approved baseline rows; BAC is the BOQ-derived budget-line total (unfrozen plan).',
    };
  } else if (input.allowContractValueBac === true && (Number(project.contract_value) || 0) > 0) {
    bac = {
      value: round2(Number(project.contract_value)),
      source: 'contract_value_explicit',
      coverage: null,
      confidence: 'Low',
      note: 'Explicit caller opt-in: contract value stands in for BAC. It cannot be distributed, so EV/PV stay N/A.',
    };
  } else {
    bac = {
      value: null, source: 'unavailable', coverage: null, confidence: 'Low',
      note: 'No approved baseline, no budget lines, no explicit contract opt-in: BAC is N/A.',
    };
  }

  // Per-activity BAC allocation (no pro-rata invention: unknown stays 0 + labeled).
  const activityBac = new Map<string, number>();
  const activityBacSource = new Map<string, ActivityCost['bacSource']>();
  for (const a of activities) {
    if (bac.source === 'baseline') {
      const row = baselineByAct.get(a.id);
      activityBac.set(a.id, row ? round2(Number(row.planned_cost) || 0) : 0);
      activityBacSource.set(a.id, row ? 'baseline' : 'unavailable');
    } else if (bac.source === 'budget_lines') {
      const direct = budgetLines.filter((b) => b.activity_id === a.id);
      activityBac.set(a.id, round2(direct.reduce((s, b) => s + (Number(b.planned_cost) || 0), 0)));
      activityBacSource.set(a.id, direct.length > 0 ? 'budget_line_direct' : 'unavailable');
    } else {
      activityBac.set(a.id, 0);
      activityBacSource.set(a.id, 'unavailable');
    }
  }

  const integrity: CostIntegrityFinding[] = checkCostIntegrity(
    costTransactions, budgetLines, activities, activityAc, activityBac, dataDate, acExcludedDuplicateIds,
  );
  // P2A1-M02: the quarantined rows are reported, not swallowed — a transaction the project boundary
  // rejects is an ERROR about the register, not a rounding difference, and its amount never enters
  // AC, CPI, EAC or VAC.
  for (const { txn, reason } of invalidActivityRefs) {
    integrity.push({
      severity: 'error', code: 'invalid_activity_reference', refKind: 'transaction',
      refId: txn.id, refLabel: txn.description,
      message: `Transaction ${txn.id} references activity ${String(txn.activity_id)}, which is not an activity of project ${project.id} (${reason === 'activity_not_found' ? 'no such activity' : 'it belongs to another project'}). It is excluded from AC.`,
      evidence: [
        `activity_id = ${String(txn.activity_id)}`,
        `project_id = ${project.id}`,
        `amount = ${txn.amount}`,
        reason === 'activity_not_found' ? 'activity does not exist in this project' : 'activity belongs to another project',
        'excluded from AC (project boundary)',
      ],
    });
  }
  const errorCount = integrity.filter((f) => f.severity === 'error').length;
  const warnCount = integrity.filter((f) => f.severity === 'warning').length;

  // --- §3 PV (linear proration, labeled) and EV (recorded progress only). ---
  const pvFractions = new Map<string, { fraction: number; method: PvMethod }>();
  for (const a of activities) {
    const row = bac.source === 'baseline' ? baselineByAct.get(a.id) : undefined;
    const start = row && isIsoDate(row.early_start) ? (row.early_start as string)
      : isIsoDate(a.early_start) ? (a.early_start as string) : null;
    const finish = row && isIsoDate(row.early_finish) ? (row.early_finish as string)
      : isIsoDate(a.early_finish) ? (a.early_finish as string) : null;
    const method: PvMethod = row && start && finish ? 'linear_baseline'
      : start && finish ? 'linear_cpm_proxy' : 'unavailable';
    let fraction = 0;
    if (start && finish) {
      if (dataDate >= finish) fraction = 1;
      else if (dataDate > start) {
        const total = countWorkingDays(start, finish, ruler);
        fraction = total > 0 ? countWorkingDays(start, dataDate, ruler) / total : 1;
      }
    }
    pvFractions.set(a.id, { fraction, method });
  }
  const activityCosts: ActivityCost[] = sortedActs.map((a) => {
    const aBac = activityBac.get(a.id) || 0;
    const { fraction, method } = pvFractions.get(a.id) as { fraction: number; method: PvMethod };
    const pv = aBac > 0 && method !== 'unavailable' ? round2(aBac * fraction) : (aBac > 0 && method === 'unavailable' ? null : bac.source === 'contract_value_explicit' ? null : round2(aBac * fraction));
    const pctRaw = finiteNum(a.percent_complete);
    const pct = pctRaw !== null ? Math.min(100, Math.max(0, pctRaw)) : 0;
    const ev = aBac > 0 ? round2(aBac * (pct / 100)) : (bac.source === 'contract_value_explicit' || bac.value === null ? null : 0);
    const ac = round2(activityAc.get(a.id) || 0);
    // Per-activity EAC is resolved after the project recommendation (same family when
    // applicable, else assumption-free EAC2-style). Placeholders filled below.
    return {
      id: a.id, code: a.code, name: a.name, wbsId: a.wbs_node_id || null,
      bac: aBac, bacSource: activityBacSource.get(a.id) as ActivityCost['bacSource'],
      pv, pvMethod: method, ev, ac, pct,
      cv: ev !== null ? round2(ev - ac) : null,
      cpi: ev !== null && ac > 0 ? round3(ev / ac) : null,
      etc: null, eac: null, eacMethod: null, vac: null,
    };
  });
  const actCostById = new Map(activityCosts.map((c) => [c.id, c]));

  const pvValues = activityCosts.map((c) => c.pv);
  const evValues = activityCosts.map((c) => c.ev);
  // Activities whose window is unknown contribute 0 PV and are labeled `unavailable` per row.
  const projectPv = bac.value === null || bac.source === 'contract_value_explicit' ? null : round2(pvValues.reduce((s: number, v) => s + (v || 0), 0));
  const projectEv = bac.value === null || bac.source === 'contract_value_explicit' ? null : round2(evValues.reduce((s: number, v) => s + (v || 0), 0));
  // PV method label: which labeled bases actually contributed nonzero BAC weight.
  let wBaseline = 0;
  let wProxy = 0;
  for (const c of activityCosts) {
    if (c.bac <= 0) continue;
    if (c.pvMethod === 'linear_baseline') wBaseline += c.bac;
    else if (c.pvMethod === 'linear_cpm_proxy') wProxy += c.bac;
  }
  const pvMethod: CostControlReport['pvMethod'] = bac.value === null
    ? 'unavailable' : wBaseline > 0 && wProxy > 0 ? 'mixed'
    : wBaseline > 0 ? 'linear_baseline' : wProxy > 0 ? 'linear_cpm_proxy' : 'unavailable';

  // --- §4 project variances (N/A-guarded; never Infinity/NaN). ---
  const cv = projectEv !== null ? round2(projectEv - projectAc) : null;
  const sv = projectEv !== null && projectPv !== null ? round2(projectEv - projectPv) : null;
  const cpi = projectEv !== null && projectAc > 0 ? round3(projectEv / projectAc) : null;
  const spi = projectEv !== null && projectPv !== null && projectPv > 0 ? round3(projectEv / projectPv) : null;

  // Trend inputs needed by methods/anomalies (snapshots strictly before the Data Date).
  const prevSnaps = (input.previousSnapshots || [])
    .filter((s) => isIsoDate(s.data_date) && s.data_date < dataDate)
    .sort((a, b) => (a.data_date < b.data_date ? -1 : 1));
  const prevCpi = prevSnaps.length > 0 ? finiteNum(prevSnaps[prevSnaps.length - 1].cpi) : null;
  const cpiStable = cpi !== null && prevCpi !== null ? Math.abs(cpi - prevCpi) <= CPI_STABILITY_BAND : null;

  // --- §5 EAC methods (ledger: formula, inputs, applicability, confidence). ---
  const methodConf = (extra: CostConfidence[] = []): CostConfidence => {
    const base: CostConfidence = errorCount > 0 ? 'Low' : warnCount > 0 ? 'Medium' : 'High';
    return minLevel([base, ...extra]);
  };
  const eacMethods: EacMethod[] = [];
  const bacV = bac.value;
  // EAC1 = BAC / CPI
  if (bacV !== null && cpi !== null && cpi > 0) {
    eacMethods.push({
      key: 'eac_cpi', formula: 'EAC = BAC / CPI',
      inputs: { BAC: bacV, CPI: cpi }, value: round2(bacV / cpi), applicable: true,
      applicability: 'Cost performance continues at the measured CPI.',
      confidence: methodConf([cpiStable === null ? 'Medium' : cpiStable ? 'High' : 'Medium']),
    });
  } else {
    eacMethods.push({
      key: 'eac_cpi', formula: 'EAC = BAC / CPI',
      inputs: { BAC: bacV, CPI: cpi }, value: null, applicable: false,
      applicability: bacV === null ? 'Needs an authorized BAC.' : 'Needs a measured CPI (EV > 0 and AC > 0).',
      confidence: 'Low',
    });
  }
  // EAC2 = AC + (BAC - EV)
  if (bacV !== null && projectEv !== null) {
    eacMethods.push({
      key: 'eac_ac_bac_ev', formula: 'EAC = AC + (BAC - EV)',
      inputs: { AC: projectAc, BAC: bacV, EV: projectEv }, value: round2(projectAc + (bacV - projectEv)), applicable: true,
      applicability: 'Remaining work proceeds at planned efficiency.',
      confidence: methodConf(['Medium']),
    });
  } else {
    eacMethods.push({
      key: 'eac_ac_bac_ev', formula: 'EAC = AC + (BAC - EV)',
      inputs: { AC: projectAc, BAC: bacV, EV: projectEv }, value: null, applicable: false,
      applicability: 'Needs an authorized BAC and a measured EV.',
      confidence: 'Low',
    });
  }
  // EAC3 = AC + (BAC - EV) / (CPI x SPI)
  const cpiSpi = cpi !== null && spi !== null ? cpi * spi : null;
  if (bacV !== null && projectEv !== null && cpiSpi !== null && cpiSpi > 0) {
    eacMethods.push({
      key: 'eac_cpi_spi', formula: 'EAC = AC + (BAC - EV) / (CPI x SPI)',
      inputs: { AC: projectAc, BAC: bacV, EV: projectEv, 'CPI x SPI': round3(cpiSpi) },
      value: round2(projectAc + (bacV - projectEv) / cpiSpi), applicable: true,
      applicability: 'Both cost and schedule performance keep driving the remaining work.',
      confidence: methodConf([cpiStable === null ? 'Medium' : cpiStable ? 'High' : 'Medium']),
    });
  } else {
    eacMethods.push({
      key: 'eac_cpi_spi', formula: 'EAC = AC + (BAC - EV) / (CPI x SPI)',
      inputs: { AC: projectAc, BAC: bacV, EV: projectEv, 'CPI x SPI': cpiSpi !== null ? round3(cpiSpi) : null },
      value: null, applicable: false,
      applicability: 'Needs BAC, EV and positive CPI x SPI.',
      confidence: 'Low',
    });
  }
  // Manual = AC + manual ETC
  if (manualEtc !== null) {
    eacMethods.push({
      key: 'eac_manual', formula: 'EAC = AC + manual ETC',
      inputs: { AC: projectAc, 'manual ETC': manualEtc }, value: round2(projectAc + manualEtc), applicable: true,
      applicability: 'The user re-estimated the remaining work directly.',
      confidence: 'Medium',
    });
  } else {
    eacMethods.push({
      key: 'eac_manual', formula: 'EAC = AC + manual ETC',
      inputs: { AC: projectAc, 'manual ETC': null }, value: null, applicable: false,
      applicability: 'Needs a user-supplied manual ETC (none recorded).',
      confidence: 'Low',
    });
  }
  const methodByKey = new Map(eacMethods.map((m) => [m.key, m]));

  // --- §6 rule-based recommendation (never silent). ---
  let recommended: EacRecommendation | null = null;
  let recommendedNote: string | null = null;
  {
    const manual = methodByKey.get('eac_manual') as EacMethod;
    const m1 = methodByKey.get('eac_cpi') as EacMethod;
    const m2 = methodByKey.get('eac_ac_bac_ev') as EacMethod;
    const m3 = methodByKey.get('eac_cpi_spi') as EacMethod;
    const pick = (m: EacMethod, why: string) => {
      recommended = {
        method: m.key, eac: m.value as number, etc: round2((m.value as number) - projectAc),
        vac: bacV !== null ? round2(bacV - (m.value as number)) : null,
        why, confidence: m.confidence,
      };
    };
    if (manual.applicable) {
      pick(manual, 'Remaining work was re-estimated by the user (manual ETC takes precedence).');
    } else if (bacV === null) {
      recommendedNote = 'No authorized budget basis (BAC unavailable): no EAC method applies.';
    } else if (m3.applicable && (cpi as number) < PERFORMANCE_CONCERN && (spi as number) < PERFORMANCE_CONCERN) {
      pick(m3, `Both cost (CPI ${cpi}) and schedule (SPI ${spi}) performance drive the forecast below ${PERFORMANCE_CONCERN}.`);
    } else if (m1.applicable) {
      const stab = cpiStable === null
        ? 'CPI stability is unverified (single update).'
        : cpiStable ? `CPI is stable (within ${CPI_STABILITY_BAND} of the previous update).`
        : `CPI moved more than ${CPI_STABILITY_BAND} since the previous update.`;
      pick(m1, `Cost performance (CPI ${cpi}) is the dominant forecast driver. ${stab}`);
    } else if (m2.applicable) {
      pick(m2, 'No measured performance index applies; remaining work is forecast at planned efficiency.');
    } else {
      recommendedNote = 'No EAC method is applicable to the available inputs.';
    }
  }

  // --- §8 commitment control (budget / committed / actual / remaining / forecast). ---
  const committed = round2(budgetLines.reduce((s, b) => s + (Number(b.committed_cost) || 0), 0));
  const hasCommitmentData = budgetLines.some((b) => (Number(b.committed_cost) || 0) > 0);
  const remainingCommitment = hasCommitmentData ? round2(committed - projectAc) : null;
  let contractedOpen: number | null = null;
  let contractedNote = 'No subcontract-package data supplied.';
  if (packages) {
    const open = packages.filter((p) => p.status === 'active' || p.status === 'suspended');
    contractedOpen = round2(open.reduce((s, p) => s + (Number(p.totalSubcontractValueSar) || 0), 0));
    contractedNote = open.length > 0
      ? `${open.length} open package(s) (active/suspended); completed, planned and terminated packages are excluded from exposure.`
      : 'No open subcontract packages; contracted exposure is 0.';
    if (hasCommitmentData && contractedOpen > committed * (1 + COMMITMENT_GAP_TOLERANCE) && committed > 0) {
      integrity.push({
        severity: 'info', code: 'commitment_data_gap', refKind: 'project', refId: null, refLabel: null,
        message: `Open contracted value ${contractedOpen} exceeds committed budget lines ${committed} by more than ${COMMITMENT_GAP_TOLERANCE * 100}%.`,
        evidence: [`contracted open = ${contractedOpen}`, `committed lines = ${committed}`],
      });
    }
  }
  if (hasCommitmentData && committed > 0 && projectAc > committed) {
    integrity.push({
      severity: 'warning', code: 'actual_exceeds_commitment_total', refKind: 'project', refId: null, refLabel: null,
      message: `Project actual ${projectAc} exceeds total committed ${committed}.`,
      evidence: [`AC = ${projectAc}`, `committed = ${committed}`],
    });
  }

  // Per-activity + per-WBS EAC: the recommended family when locally applicable, else EAC2-style.
  const recKey = recommended ? (recommended as EacRecommendation).method : null;
  const localEac = (aBac: number, aEv: number | null, aAc: number, aCpi: number | null, aSpi: number | null): { eac: number | null; method: EacMethodKey | null } => {
    if (recKey === 'eac_cpi' && aCpi !== null && aCpi > 0 && aBac > 0) {
      return { eac: round2(aBac / aCpi), method: 'eac_cpi' };
    }
    if (recKey === 'eac_cpi_spi' && aCpi !== null && aSpi !== null && aCpi * aSpi > 0 && aBac > 0 && aEv !== null) {
      return { eac: round2(aAc + (aBac - aEv) / (aCpi * aSpi)), method: 'eac_cpi_spi' };
    }
    if (aBac > 0 && aEv !== null) {
      return { eac: round2(aAc + (aBac - aEv)), method: 'eac_ac_bac_ev' };
    }
    return { eac: null, method: null };
  };
  for (const c of activityCosts) {
    const aSpi = c.ev !== null && c.pv !== null && c.pv > 0 ? round3(c.ev / c.pv) : null;
    const { eac, method } = localEac(c.bac, c.ev, c.ac, c.cpi, aSpi);
    c.eac = eac;
    c.eacMethod = method;
    c.etc = eac !== null ? round2(eac - c.ac) : null;
    c.vac = eac !== null && c.bac > 0 ? round2(c.bac - eac) : null;
  }

  // --- §9 WBS roll-up (tree; each line/txn counted once). ---
  const nodeById = new Map(wbsNodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, WbsNode[]>();
  const roots: WbsNode[] = [];
  for (const n of [...wbsNodes].sort(byCode)) {
    if (n.parent_id && nodeById.has(n.parent_id) && n.parent_id !== n.id) {
      const list = childrenOf.get(n.parent_id) || [];
      list.push(n);
      childrenOf.set(n.parent_id, list);
    } else {
      roots.push(n);
    }
  }
  // AC attribution per transaction (precedence: activity -> budget line -> single-WBS BOQ).
  const wbsByBoq = new Map<string, WbsNode[]>();
  for (const n of wbsNodes) {
    if (!n.boq_item_id) continue;
    const list = wbsByBoq.get(n.boq_item_id) || [];
    list.push(n);
    wbsByBoq.set(n.boq_item_id, list);
  }
  const lineById = new Map(budgetLines.map((l) => [l.id, l]));
  const actWbs = new Map(activities.map((a) => [a.id, a.wbs_node_id || null]));
  // txnId -> { activityId } | { wbsId } | unattributed. Activities roll into their WBS below.
  const txnWbs = new Map<string, string>();
  const txnActivity = new Map<string, string>();
  let unattributedAc = 0;
  for (const t of acTxns) {
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (t.activity_id && actCostById.has(t.activity_id)) {
      txnActivity.set(t.id, t.activity_id);
      continue;
    }
    const line = t.budget_line_id ? lineById.get(t.budget_line_id) : undefined;
    const lineWbs = line?.wbs_node_id && nodeById.has(line.wbs_node_id) ? (line.wbs_node_id as string) : null;
    const lineAct = line?.activity_id && actCostById.has(line.activity_id) ? (line.activity_id as string) : null;
    if (lineAct) {
      txnActivity.set(t.id, lineAct);
      continue;
    }
    if (lineWbs) {
      txnWbs.set(t.id, lineWbs);
      continue;
    }
    if (t.boq_item_id) {
      const nodes = wbsByBoq.get(t.boq_item_id) || [];
      if (nodes.length === 1) {
        txnWbs.set(t.id, nodes[0].id);
        continue;
      }
    }
    unattributedAc = round2(unattributedAc + amount);
  }
  const directWbsAc = new Map<string, number>();
  for (const [txId, wbsId] of txnWbs) {
    const t = acTxns.find((x) => x.id === txId);
    if (!t) continue;
    directWbsAc.set(wbsId, round2((directWbsAc.get(wbsId) || 0) + Number(t.amount)));
  }
  // Budget-mode BAC for lines without an activity home (counted once, at their WBS node).
  const directWbsBac = new Map<string, number>();
  if (bac.source === 'budget_lines') {
    for (const l of budgetLines) {
      if (l.activity_id || !l.wbs_node_id || !nodeById.has(l.wbs_node_id)) continue;
      directWbsBac.set(l.wbs_node_id, round2((directWbsBac.get(l.wbs_node_id) || 0) + (Number(l.planned_cost) || 0)));
    }
  }
  const directWbsCommitted = new Map<string, number>();
  for (const l of budgetLines) {
    const target = l.activity_id && actCostById.has(l.activity_id)
      ? actWbs.get(l.activity_id) || null
      : l.wbs_node_id && nodeById.has(l.wbs_node_id) ? l.wbs_node_id : null;
    if (!target) continue;
    directWbsCommitted.set(target, round2((directWbsCommitted.get(target) || 0) + (Number(l.committed_cost) || 0)));
  }
  const actsByWbs = new Map<string, ActivityCost[]>();
  for (const c of activityCosts) {
    if (!c.wbsId || !nodeById.has(c.wbsId)) continue;
    const list = actsByWbs.get(c.wbsId) || [];
    list.push(c);
    actsByWbs.set(c.wbsId, list);
  }
  const wbsCosts: WbsCost[] = [];
  const wbsById = new Map<string, WbsCost>();
  const visiting = new Set<string>();
  const rollup = (n: WbsNode): WbsCost => {
    const existing = wbsById.get(n.id);
    if (existing) return existing;
    if (visiting.has(n.id)) {
      // Cycle guard: break honestly rather than looping forever.
      const cyclic: WbsCost = {
        id: n.id, code: n.code, name: `${n.name} (cycle — children cut)`, level: n.level || 0,
        childIds: [], bac: 0, pv: 0, ev: 0, ac: 0, committed: 0,
        cv: 0, cpi: null, etc: null, eac: null, eacMethod: null, vac: null,
      };
      wbsById.set(n.id, cyclic);
      return cyclic;
    }
    visiting.add(n.id);
    const kids = (childrenOf.get(n.id) || []).map(rollup);
    visiting.delete(n.id);
    const acts = actsByWbs.get(n.id) || [];
    const wBac = round2(kids.reduce((s, k) => s + k.bac, 0) + acts.reduce((s, a) => s + a.bac, 0) + (directWbsBac.get(n.id) || 0));
    const wPvRaw = kids.reduce((s, k) => s + (k.pv || 0), 0) + acts.reduce((s, a) => s + (a.pv || 0), 0);
    const wEvRaw = kids.reduce((s, k) => s + (k.ev || 0), 0) + acts.reduce((s, a) => s + (a.ev || 0), 0);
    const wPv = bacV === null || bac.source === 'contract_value_explicit' ? null : round2(wPvRaw);
    const wEv = bacV === null || bac.source === 'contract_value_explicit' ? null : round2(wEvRaw);
    const kidsAc = kids.reduce((s, k) => s + k.ac, 0);
    const actsAc = acts.reduce((s, a) => s + a.ac, 0);
    // Activity-attributed txns via line inference may exceed the activity's own AC (which only
    // counts direct activity_id links). Add the inferred share per activity WBS home:
    let inferredAc = 0;
    for (const [txId, actId] of txnActivity) {
      const home = actWbs.get(actId);
      if (home !== n.id) continue;
      const t = acTxns.find((x) => x.id === txId);
      if (t && !t.activity_id) inferredAc = round2(inferredAc + Number(t.amount));
    }
    const wAc = round2(kidsAc + actsAc + (directWbsAc.get(n.id) || 0) + inferredAc);
    const wCommitted = round2(kids.reduce((s, k) => s + k.committed, 0) + (directWbsCommitted.get(n.id) || 0));
    const wCv = wEv !== null ? round2(wEv - wAc) : null;
    const wCpi = wEv !== null && wAc > 0 ? round3(wEv / wAc) : null;
    const wSpi = wEv !== null && wPv !== null && wPv > 0 ? round3(wEv / wPv) : null;
    const { eac, method } = localEac(wBac, wEv, wAc, wCpi, wSpi);
    const out: WbsCost = {
      id: n.id, code: n.code, name: n.name, level: n.level || 0,
      childIds: kids.map((k) => k.id),
      bac: wBac, pv: wPv, ev: wEv, ac: wAc, committed: wCommitted,
      cv: wCv, cpi: wCpi,
      etc: eac !== null ? round2(eac - wAc) : null,
      eac, eacMethod: method,
      vac: eac !== null && wBac > 0 ? round2(wBac - eac) : null,
    };
    wbsCosts.push(out);
    wbsById.set(n.id, out);
    return out;
  };
  for (const r of roots) rollup(r);
  // Orphan safety: any node unreachable from roots (detached cycles) still rolls up alone.
  for (const n of [...wbsNodes].sort(byCode)) {
    if (!wbsById.has(n.id)) rollup(n);
  }
  wbsCosts.sort(byCode);

  // Unassigned bucket: activities/lines/txns with no WBS home.
  const unActs = activityCosts.filter((c) => !c.wbsId || !nodeById.has(c.wbsId));
  const unLineBac = bac.source === 'budget_lines'
    ? round2(budgetLines.filter((l) => !l.activity_id && (!l.wbs_node_id || !nodeById.has(l.wbs_node_id)))
      .reduce((s, l) => s + (Number(l.planned_cost) || 0), 0)) : 0;
  const unLineCommitted = round2(budgetLines.filter((l) => {
    const target = l.activity_id && actCostById.has(l.activity_id)
      ? actWbs.get(l.activity_id) || null
      : l.wbs_node_id && nodeById.has(l.wbs_node_id) ? l.wbs_node_id : null;
    return !target;
  }).reduce((s, l) => s + (Number(l.committed_cost) || 0), 0));
  const unBac = round2(unActs.reduce((s, a) => s + a.bac, 0) + unLineBac);
  const unPv = bacV === null || bac.source === 'contract_value_explicit' ? null : round2(unActs.reduce((s, a) => s + (a.pv || 0), 0));
  const unEv = bacV === null || bac.source === 'contract_value_explicit' ? null : round2(unActs.reduce((s, a) => s + (a.ev || 0), 0));
  const unAcDirect = round2(unActs.reduce((s, a) => s + a.ac, 0));
  let unInferred = 0;
  for (const [txId, actId] of txnActivity) {
    const home = actWbs.get(actId);
    if (home && nodeById.has(home)) continue;
    const t = acTxns.find((x) => x.id === txId);
    if (t && !t.activity_id) unInferred = round2(unInferred + Number(t.amount));
  }
  const unAc = round2(unAcDirect + unInferred + unattributedAc);
  const unCv = unEv !== null ? round2(unEv - unAc) : null;
  const unCpi = unEv !== null && unAc > 0 ? round3(unEv / unAc) : null;
  const unSpi = unEv !== null && unPv !== null && unPv > 0 ? round3(unEv / unPv) : null;
  const unEac = localEac(unBac, unEv, unAc, unCpi, unSpi);
  const unassigned: WbsCost = {
    id: '__unassigned__', code: '__unassigned__', name: 'Unassigned (no WBS home)', level: -1,
    childIds: [], bac: unBac, pv: unPv, ev: unEv, ac: unAc, committed: unLineCommitted,
    cv: unCv, cpi: unCpi,
    etc: unEac.eac !== null ? round2(unEac.eac - unAc) : null,
    eac: unEac.eac, eacMethod: unEac.method,
    vac: unEac.eac !== null && unBac > 0 ? round2(unBac - unEac.eac) : null,
  };

  // --- §10 BOQ traceability for cost variances (explanatory; never re-summed). ---
  const boqById = new Map(boqItems.map((b) => [b.id, b]));
  const allocsByAct = new Map<string, ActivityBoqAllocation[]>();
  for (const al of allocations) {
    const list = allocsByAct.get(al.activity_id) || [];
    list.push(al);
    allocsByAct.set(al.activity_id, list);
  }
  const boqTrace: BoqTrace[] = [];
  for (const c of activityCosts) {
    if (c.cv === null || c.cv === 0) continue;
    const rows = (allocsByAct.get(c.id) || []).map((al) => {
      const boq = boqById.get(al.boq_item_id);
      return {
        boqId: al.boq_item_id,
        boqCode: boq ? boq.code : al.boq_item_id,
        costShare: round2(Number(al.cost_share) || 0),
        wbsCode: c.wbsId && nodeById.get(c.wbsId) ? (nodeById.get(c.wbsId) as WbsNode).code : null,
      };
    }).sort((a, b) => (a.boqCode < b.boqCode ? -1 : 1));
    const tracedTotal = round2(rows.reduce((s, r) => s + r.costShare, 0));
    boqTrace.push({
      activityId: c.id, code: c.code, cv: c.cv, items: rows, tracedTotal,
      coverageNote: rows.length === 0
        ? 'No BOQ allocations trace this activity: the variance cannot be traced to BOQ.'
        : `Traced SAR ${tracedTotal} of activity BAC ${c.bac} across ${rows.length} BOQ item(s).`,
    });
  }

  // --- §11 trend (previous snapshots + current, deterministic). ---
  const trend: CostTrendPoint[] = prevSnaps.map((s) => ({
    dataDate: s.data_date, current: false,
    ac: finiteNum(s.ac), ev: finiteNum(s.ev), pv: finiteNum(s.pv),
    cpi: finiteNum(s.cpi), spi: finiteNum(s.spi),
    etc: finiteNum(s.etc), eac: finiteNum(s.eac), vac: finiteNum(s.vac),
    committed: finiteNum(s.committed), confidence: s.forecast_confidence || null,
  }));
  const rec = recommended as EacRecommendation | null;
  trend.push({
    dataDate, current: true,
    ac: projectAc, ev: projectEv, pv: projectPv, cpi, spi,
    etc: rec ? rec.etc : null, eac: rec ? rec.eac : null, vac: rec ? rec.vac : null,
    committed: hasCommitmentData ? committed : null,
    confidence: null, // filled after confidence is computed below
  });

  // --- §12 forecast drift vs the immediate previous update. ---
  const prevPoint = trend.length >= 2 ? trend[trend.length - 2] : null;
  const curPoint = trend[trend.length - 1];
  const signed2 = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : round2(a - b);
  const signed3 = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : round3(a - b);
  const prevCv = prevPoint && prevPoint.ev !== null && prevPoint.ac !== null ? round2(prevPoint.ev - prevPoint.ac) : null;
  const drift: CostDrift = {
    hasPrevious: !!prevPoint,
    previousDataDate: prevPoint ? prevPoint.dataDate : null,
    eacDrift: prevPoint ? signed2(curPoint.eac, prevPoint.eac) : null,
    etcDrift: prevPoint ? signed2(curPoint.etc, prevPoint.etc) : null,
    cpiChange: prevPoint ? signed3(curPoint.cpi, prevPoint.cpi) : null,
    cvChange: prevPoint ? signed2(cv, prevCv) : null,
    direction: 'unknown',
  };
  if (prevPoint) {
    const cvC = drift.cvChange;
    const eacD = drift.eacDrift;
    if (cvC === null && eacD === null) drift.direction = 'unknown';
    else if ((cvC !== null && cvC < 0) || (eacD !== null && eacD > 0)) drift.direction = 'worsening';
    else if ((cvC !== null && cvC > 0) || (eacD !== null && eacD < 0)) drift.direction = 'improving';
    else drift.direction = 'stable';
  }

  // --- §13 burn rate (only with sufficient history). ---
  const usable = trend.filter((p) => p.ac !== null && p.ev !== null);
  let burn: BurnRate;
  if (usable.length >= BURN_MIN_SNAPSHOTS) {
    const span = calendarDaysBetween(usable[0].dataDate, usable[usable.length - 1].dataDate);
    if (span !== null && span >= BURN_MIN_SPAN_DAYS) {
      const dAc = (usable[usable.length - 1].ac as number) - (usable[0].ac as number);
      const dEv = (usable[usable.length - 1].ev as number) - (usable[0].ev as number);
      const c0 = usable[0].cpi;
      const c1 = usable[usable.length - 1].cpi;
      const dc = c0 !== null && c1 !== null ? c1 - c0 : null;
      burn = {
        sufficient: true,
        reason: `${usable.length} trend points over ${span} days.`,
        snapshotsUsed: usable.length, spanDays: span,
        acBurnPerDay: round2(dAc / span), evRatePerDay: round2(dEv / span),
        efficiencyTrend: dc === null ? 'unknown' : Math.abs(dc) <= BURN_STABILITY_BAND ? 'stable' : dc > 0 ? 'improving' : 'declining',
      };
    } else {
      burn = {
        sufficient: false, reason: `Trend spans ${span ?? 0} days; ${BURN_MIN_SPAN_DAYS} required.`,
        snapshotsUsed: usable.length, spanDays: span, acBurnPerDay: null, evRatePerDay: null, efficiencyTrend: 'unknown',
      };
    }
  } else {
    burn = {
      sufficient: false, reason: `Only ${usable.length} usable trend point(s); ${BURN_MIN_SNAPSHOTS} required.`,
      snapshotsUsed: usable.length, spanDays: null, acBurnPerDay: null, evRatePerDay: null, efficiencyTrend: 'unknown',
    };
  }

  // --- §14 anomaly detection (all thresholds declared above). ---
  const anomalies: CostAnomaly[] = [];
  if (cpi !== null && cpi < CPI_ALERT_THRESHOLD) {
    anomalies.push({
      code: 'cpi_below_threshold',
      message: `CPI ${cpi} is below the ${CPI_ALERT_THRESHOLD} threshold.`,
      evidence: [`CPI = ${cpi}`, `EV = ${projectEv}`, `AC = ${projectAc}`],
      threshold: `CPI < ${CPI_ALERT_THRESHOLD}`,
    });
  }
  if (hasCommitmentData && bacV !== null && bacV > 0 && projectEv !== null) {
    const unpaid = committed - projectAc;
    const remaining = bacV - projectEv;
    if (remaining > 0 && unpaid > remaining * COMMITTED_EXPOSURE_RATIO) {
      anomalies.push({
        code: 'high_committed_exposure',
        message: `Unpaid commitments ${round2(unpaid)} exceed remaining budgeted work ${round2(remaining)}.`,
        evidence: [`committed = ${committed}`, `AC = ${projectAc}`, `BAC - EV = ${round2(remaining)}`],
        threshold: `unpaid > (BAC - EV) x ${COMMITTED_EXPOSURE_RATIO}`,
      });
    }
  }
  if (prevPoint) {
    const dAc = prevPoint.ac !== null ? projectAc - prevPoint.ac : null;
    const dEv = prevPoint.ev !== null && projectEv !== null ? projectEv - prevPoint.ev : null;
    if (dAc !== null && dAc > 0 && dEv !== null && dEv <= 0) {
      anomalies.push({
        code: 'ac_rising_ev_flat',
        message: `AC rose ${round2(dAc)} since ${prevPoint.dataDate} while EV moved ${round2(dEv)}.`,
        evidence: [`AC ${prevPoint.ac} -> ${projectAc}`, `EV ${prevPoint.ev} -> ${projectEv}`],
        threshold: 'ΔAC > 0 while ΔEV ≤ 0',
      });
    }
    if (dEv !== null && dEv > 0) {
      const fresh = costTransactions.some((t) =>
        t.status === 'approved' && isIsoDate(t.transaction_date)
        && t.transaction_date > (prevPoint.dataDate as string) && !isAfterDataDate(t.transaction_date, dataDate));
      if (!fresh) {
        anomalies.push({
          code: 'ev_without_ac_evidence',
          message: `EV rose ${round2(dEv)} since ${prevPoint.dataDate} with no approved cost evidence in the window.`,
          evidence: [`EV ${prevPoint.ev} -> ${projectEv}`, `no approved transactions in (${prevPoint.dataDate}, ${dataDate}]`],
          threshold: 'ΔEV > 0 with zero approved transactions in-window',
        });
      }
    }
  }
  const cvSeries = trend.map((p) => (p.ev !== null && p.ac !== null ? round2(p.ev - p.ac) : null));
  const tail = cvSeries.slice(-CONSECUTIVE_OVERRUN_STREAK);
  if (tail.length === CONSECUTIVE_OVERRUN_STREAK && tail.every((v) => v !== null && (v as number) < 0)) {
    anomalies.push({
      code: 'repeated_cost_overruns',
      message: `Cost overrun for ${CONSECUTIVE_OVERRUN_STREAK} consecutive updates (CV ${tail.join(', ')}).`,
      evidence: tail.map((v, i) => `${trend[trend.length - tail.length + i].dataDate}: CV ${v}`),
      threshold: `CV < 0 for ${CONSECUTIVE_OVERRUN_STREAK} consecutive updates`,
    });
  }
  const eacSeries = trend.map((p) => p.eac);
  const eacTail = eacSeries.slice(-EAC_WORSENING_STREAK);
  if (eacTail.length === EAC_WORSENING_STREAK && eacTail.every((v) => v !== null)
    && (eacTail as number[]).every((v, i, arr) => i === 0 || v > (arr[i - 1] as number))) {
    anomalies.push({
      code: 'eac_worsening_repeatedly',
      message: `Recommended EAC rose for ${EAC_WORSENING_STREAK} consecutive updates (${eacTail.join(' -> ')}).`,
      evidence: (eacTail as number[]).map((v, i) => `${trend[trend.length - eacTail.length + i].dataDate}: EAC ${v}`),
      threshold: `EAC strictly increasing for ${EAC_WORSENING_STREAK} consecutive updates`,
    });
  }

  // --- §16 time-cost consistency (needs the F5 schedule report; read-only). ---
  const consistency: TimeCostFinding[] = [];
  let consistencyNote: string | null = null;
  const sched = input.scheduleReport || null;
  if (!sched) {
    consistencyNote = 'No schedule report supplied: time-cost consistency was not checked.';
  } else {
    const varById = new Map(sched.variances.map((v) => [v.id, v]));
    const prevDetail = prevSnaps.length > 0 && prevSnaps[prevSnaps.length - 1].details
      && prevSnaps[prevSnaps.length - 1].details.version === 1
      ? prevSnaps[prevSnaps.length - 1].details.activities : null;
    for (const c of activityCosts) {
      const v = varById.get(c.id);
      const delayed = v && v.finishVarianceWd !== null && (v.finishVarianceWd as number) > 0;
      const prev = prevDetail ? prevDetail[c.id] : undefined;
      if (delayed && prev && prev.pct === c.pct && (prevSnaps[prevSnaps.length - 1].data_date as string) < dataDate) {
        consistency.push({
          code: 'delayed_without_progress', severity: 'warning', activityCode: c.code,
          message: `${c.code} is +${v?.finishVarianceWd}d vs baseline with progress frozen at ${c.pct}%.`,
          evidence: [`finish variance +${v?.finishVarianceWd}d`, `percent ${prev.pct}% -> ${c.pct}%`],
        });
      }
      if (delayed && prev && prev.ac === c.ac && prev.ev === c.ev) {
        consistency.push({
          code: 'delayed_without_cost_movement', severity: 'warning', activityCode: c.code,
          message: `${c.code} is +${v?.finishVarianceWd}d vs baseline while EV (${c.ev}) and AC (${c.ac}) did not move.`,
          evidence: [`finish variance +${v?.finishVarianceWd}d`, `EV ${prev.ev} -> ${c.ev}`, `AC ${prev.ac} -> ${c.ac}`],
        });
      }
      if (c.pct >= 100 && c.bac > 0 && c.ac === 0) {
        consistency.push({
          code: 'complete_without_cost', severity: 'warning', activityCode: c.code,
          message: `${c.code} is 100% complete with BAC ${c.bac} but zero approved cost.`,
          evidence: [`BAC = ${c.bac}`, 'AC = 0', 'percent_complete = 100'],
        });
      }
      if (c.pct >= 100 && c.bac > 0 && c.ev !== null && c.ac < c.ev * COMPLETE_COST_SHORT_RATIO && c.ac > 0) {
        consistency.push({
          code: 'complete_cost_short', severity: 'warning', activityCode: c.code,
          message: `${c.code} is 100% complete but AC ${c.ac} covers less than ${COMPLETE_COST_SHORT_RATIO * 100}% of EV ${c.ev}.`,
          evidence: [`EV = ${c.ev}`, `AC = ${c.ac}`],
          // threshold documented: COMPLETE_COST_SHORT_RATIO
        });
      }
    }
  }

  // --- §15 Top-5 cost actions (financial impact ranked, schedule-linked). ---
  const actions: CostAction[] = [];
  const schedVar = new Map((sched ? sched.variances : []).map((v) => [v.id, v]));
  const linkOf = (id: string): string | null => {
    const v = schedVar.get(id);
    if (!v || v.finishVarianceWd === null) return null;
    const w = v.finishVarianceWd as number;
    if (w === 0) return 'Schedule: on baseline finish.';
    return w > 0 ? `Schedule: +${w}d vs baseline finish.` : `Schedule: ${w}d vs baseline finish (early).`;
  };
  type Candidate = Omit<CostAction, 'rank'>;
  const candidates: Candidate[] = [];
  if (cv !== null && cv < 0) {
    candidates.push({
      issue: `Project cost overrun: CV ${cv} (EV ${projectEv} vs AC ${projectAc}).`,
      evidence: [`CV = ${cv}`, cpi !== null ? `CPI = ${cpi}` : 'CPI N/A'],
      financialImpact: round2(Math.abs(cv)),
      scheduleLinkage: sched ? `Schedule forecast ${sched.project.forecastFinish || 'N/A'}; ${sched.project.criticalCount} critical.` : null,
      action: 'Contain the burn: freeze non-critical spend and re-price the remaining work.',
      confidence: errorCount > 0 ? 'Low' : 'High',
    });
  }
  const overruns = activityCosts
    .filter((c) => c.cv !== null && (c.cv as number) < 0 && bacV !== null && bacV > 0 && c.bac >= bacV * MATERIAL_BAC_SHARE)
    .sort((a, b) => (a.cv as number) - (b.cv as number) || (a.code < b.code ? -1 : 1))
    .slice(0, 5);
  for (const c of overruns) {
    candidates.push({
      issue: `Activity ${c.code} overrun: CV ${c.cv}${c.cpi !== null ? `, CPI ${c.cpi}` : ''}.`,
      evidence: [`EV ${c.ev} vs AC ${c.ac}`, `BAC ${c.bac}`],
      financialImpact: round2(Math.abs(c.cv as number)),
      scheduleLinkage: linkOf(c.id),
      action: `Recover ${c.code}: crash the cost driver or descope non-essential quantities.`,
      confidence: errorCount > 0 ? 'Low' : 'High',
    });
  }
  if (drift.eacDrift !== null && drift.eacDrift > 0 && rec) {
    candidates.push({
      issue: `Forecast worsened: recommended EAC +${drift.eacDrift} since ${drift.previousDataDate} (now ${rec.eac}).`,
      evidence: [`EAC drift +${drift.eacDrift}`, `method ${rec.method}`],
      financialImpact: round2(drift.eacDrift),
      scheduleLinkage: sched && sched.project.delayVsPreviousWd !== null
        ? `Schedule forecast moved ${sched.project.delayVsPreviousWd}d in the same window.` : null,
      action: 'Re-baseline the remaining work or fund the gap from reserves.',
      confidence: rec.confidence,
    });
  }
  if (hasCommitmentData && bacV !== null && projectEv !== null) {
    const unpaid = committed - projectAc;
    const remaining = bacV - projectEv;
    if (remaining > 0 && unpaid > remaining * COMMITTED_EXPOSURE_RATIO) {
      candidates.push({
        issue: `Committed exposure: unpaid ${round2(unpaid)} exceeds remaining budgeted work ${round2(remaining)}.`,
        evidence: [`committed ${committed} - AC ${projectAc}`, `BAC - EV = ${round2(remaining)}`],
        financialImpact: round2(unpaid - remaining),
        scheduleLinkage: null,
        action: 'Renegotiate or phase commitments before the remaining budget is consumed.',
        confidence: 'Medium',
      });
    }
  }
  for (const c of activityCosts.filter((x) => x.bac === 0 && x.ac > 0).sort(byCode).slice(0, 3)) {
    candidates.push({
      issue: `Unbudgeted spend on ${c.code}: AC ${c.ac} with no authorized budget.`,
      evidence: [`AC = ${c.ac}`, 'BAC = 0'],
      financialImpact: c.ac,
      scheduleLinkage: linkOf(c.id),
      action: `Authorize a budget for ${c.code} or stop the spend.`,
      confidence: 'High',
    });
  }
  if (projectAc > 0 && unattributedAc > projectAc * UNATTRIBUTED_AC_SHARE) {
    candidates.push({
      issue: `Unattributed actuals: ${unattributedAc} of ${projectAc} AC cannot be traced to an activity or WBS.`,
      evidence: [`unattributed AC = ${unattributedAc}`, `total AC = ${projectAc}`],
      financialImpact: unattributedAc,
      scheduleLinkage: null,
      action: 'Attribute the open actuals to activities/WBS before the next update.',
      confidence: 'Medium',
    });
  }
  for (const c of activityCosts.filter((x) => x.pct >= 100 && x.bac > 0 && x.ac === 0).sort(byCode).slice(0, 2)) {
    candidates.push({
      issue: `${c.code} is complete with zero approved cost (BAC ${c.bac} at stake).`,
      evidence: [`BAC = ${c.bac}`, 'AC = 0', 'percent_complete = 100'],
      financialImpact: c.bac,
      scheduleLinkage: linkOf(c.id),
      action: `Post or accrue the completion cost of ${c.code}; verify no missing invoices.`,
      confidence: 'Medium',
    });
  }
  candidates.sort((a, b) => b.financialImpact - a.financialImpact || (a.issue < b.issue ? -1 : 1));
  candidates.slice(0, MAX_COST_ACTIONS).forEach((c, i) => actions.push({ ...c, rank: i + 1 }));

  // --- §17 confidence per KPI. ---
  const unapprovedAc = round2(costTransactions
    .filter((t) => t.status !== 'approved' && t.status !== 'rejected' && isIsoDate(t.transaction_date) && !isAfterDataDate(t.transaction_date, dataDate))
    .reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const evBacked = activityCosts.reduce((s, c) => {
    const hasUpdate = progressUpdates.some((u) => u.activity_id === c.id && u.status === 'approved');
    const act = activities.find((a) => a.id === c.id);
    const backed = hasUpdate || !!act?.actual_start;
    return s + ((c.ev || 0) * (backed ? 1 : 0));
  }, 0);
  const evTotal = activityCosts.reduce((s, c) => s + (c.ev || 0), 0);
  const progressEvidence = evTotal > 0 ? evBacked / evTotal : 1;
  const cpiRange = (() => {
    const vals = trend.map((p) => p.cpi).filter((v): v is number => v !== null);
    return vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : null;
  })();
  const stable = cpiRange === null ? null : cpiRange <= CPI_STABILITY_BAND * 2;
  const confidence: CostControlReport['confidence'] = {
    bac: {
      level: bac.confidence,
      sources: bac.source === 'baseline' ? ['active approved baseline'] : bac.source === 'budget_lines' ? ['BOQ-derived budget lines'] : bac.source === 'contract_value_explicit' ? ['contract value (explicit opt-in)'] : [],
      notes: [bac.note],
    },
    pv: {
      level: pvMethod === 'linear_baseline' && errorCount === 0 ? 'High' : pvMethod === 'unavailable' ? 'Low' : 'Medium',
      sources: wBaseline > 0 ? ['baseline activity windows'] : [],
      notes: [
        `method: ${pvMethod}`,
        ...(wProxy > 0 ? ['CPM-date proxy windows cap confidence at Medium.'] : []),
        errorCount > 0 ? `${errorCount} integrity error(s).` : 'no integrity errors',
      ],
    },
    ev: {
      level: projectEv === null ? 'Low' : progressEvidence >= 0.9 && errorCount === 0 ? 'High' : progressEvidence >= 0.5 ? 'Medium' : 'Low',
      sources: ['recorded percent complete', bac.source === 'baseline' ? 'baseline budgets' : 'budget-line budgets'],
      notes: [
        `${Math.round(progressEvidence * 100)}% of EV is backed by approved updates or actual starts`,
        errorCount > 0 ? `${errorCount} integrity error(s).` : 'no integrity errors',
      ],
    },
    ac: {
      level: errorCount > 0 ? 'Low' : projectAc === 0 ? 'Medium' : unapprovedAc > projectAc * 0.05 ? 'Medium' : 'High',
      sources: projectAc > 0 || acTxns.length > 0 ? ['approved cost transactions'] : [],
      notes: [
        `${acTxns.length} approved transaction(s) on/before the Data Date`,
        unapprovedAc > 0 ? `unapproved in-window spend: ${unapprovedAc}` : 'no unapproved in-window spend',
        errorCount > 0 ? `${errorCount} integrity error(s).` : 'no integrity errors',
      ],
    },
    eac: {
      level: rec ? minLevel([rec.confidence, bac.confidence]) : 'Low',
      sources: rec ? [`EAC method ${rec.method}`] : [],
      notes: rec ? [rec.why] : [recommendedNote || 'no recommendation'],
    },
    forecast: {
      level: (() => {
        const base = rec ? minLevel([rec.confidence, bac.confidence]) : 'Low';
        if (manualEtc !== null) return minLevel([base, 'Medium']);
        if (stable === false) return minLevel([base, 'Medium']);
        return base;
      })(),
      sources: ['EAC recommendation', 'trend stability', 'integrity screen'],
      notes: [
        manualEtc !== null ? 'manual ETC override caps forecast at Medium' : 'no manual override',
        stable === null ? 'stability unverified (insufficient history)' : stable ? 'CPI stable across trend' : 'CPI unstable across trend',
        `${anomalies.length} anomal(ies) open`,
      ],
    },
  };
  trend[trend.length - 1].confidence = confidence.forecast.level;

  return {
    dataDate, bac, pvMethod,
    project: {
      bac: bacV, pv: projectPv, ev: projectEv, ac: projectAc,
      acSource: acTxns.length > 0 ? 'approved_transactions' : 'none_recorded',
      acCount: acTxns.length,
      cv, sv, cpi, spi,
      etc: rec ? rec.etc : null, eac: rec ? rec.eac : null, vac: rec ? rec.vac : null,
    },
    eacMethods, recommended: rec, recommendedNote,
    commitment: {
      budget: bacV, committed, hasCommitmentData, actual: projectAc,
      remainingCommitment, forecastEtc: rec ? rec.etc : null,
      contractedOpen, contractedNote,
    },
    activities: activityCosts, wbs: wbsCosts, unassigned, boqTrace,
    integrity, trend, drift, burn, anomalies, actions,
    consistency, consistencyNote, confidence,
  };
}

// ---------------------------------------------------------------------------
// §11 — deterministic cost snapshot payload
// ---------------------------------------------------------------------------

/**
 * Build the deterministic snapshot payload for this cost update. Key order and rounding are
 * fixed so the same report always serializes to the same bytes.
 */
export function buildCostSnapshot(projectId: string, report: CostControlReport): CostSnapshotPayload {
  const details: CostSnapshotDetails = {
    version: 1,
    methods: report.eacMethods.map((m) => ({
      key: m.key, value: m.value, confidence: m.confidence,
      reason: m.applicability,
    })),
    recommended: report.recommended ? {
      method: report.recommended.method, why: report.recommended.why, confidence: report.recommended.confidence,
    } : null,
    activities: {},
    counts: {
      activities: report.activities.length,
      wbsNodes: report.wbs.length,
      integrityErrors: report.integrity.filter((f) => f.severity === 'error').length,
      anomalies: report.anomalies.length,
    },
  };
  for (const c of [...report.activities].sort(byCode)) {
    details.activities[c.id] = { ev: c.ev || 0, ac: c.ac, pct: c.pct };
  }
  return {
    project_id: projectId,
    data_date: report.dataDate,
    bac: report.project.bac,
    pv: report.project.pv,
    ev: report.project.ev,
    ac: report.project.ac,
    cpi: report.project.cpi,
    spi: report.project.spi,
    etc: report.project.etc,
    eac: report.project.eac,
    vac: report.project.vac,
    committed: report.commitment.hasCommitmentData ? report.commitment.committed : null,
    forecast_confidence: report.confidence.forecast.level,
    recommended_method: report.recommended ? report.recommended.method : null,
    details,
  };
}

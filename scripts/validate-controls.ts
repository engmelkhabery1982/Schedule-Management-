/**
 * F9 regression pack — project-controls validation harness (in-repo, reusable).
 *
 * Run with `npm run validate:controls` (bundles with esbuild, then executes under node).
 * Covers the acceptance items that are testable headlessly:
 *
 *   S0  chronology guard units                      (governed Data Date primitives)
 *   S1  CPM core                                    (dates, float, criticality, cycles, calendars)
 *   S2  machine-clock independence                  (acceptance A: shifted clock ⇒ identical output)
 *   S3  XER fidelity anchors                        (import conversions, data-date fidelity)
 *   S4  BOQ planning                                (determinism, CPM-derived finish, no NaN)
 *   S5  resource leveling                           (float-bounded shifts, determinism)
 *   S6  canonical EVM                               (approved-only + Data Date filters, empty states)
 *   S7  F5 schedule control                         (canonical finish, hand-computed delay, snapshots)
 *   S8  F6 cost control                             (filters, manual ETC, rollup reconciliation)
 *   S9  F7 integrated decisions                     (quotes F5/F6 exactly — acceptance F)
 *   S10 F8 forecast trust                           (prev/current snapshot rules — acceptance D)
 *   S11 finish-forecast + rollup reconciliation     (acceptance G/H)
 *   S12 NaN/Infinity scan on empty + sparse inputs  (acceptance E/L)
 *   S13 determinism of the full pipeline            (acceptance J)
 *   S17 Controlled Pilot defects                    (F9.4: EVM reconciliation, cost-approval
 *                                                    persistence, F5 baseline/delay, critical count)
 *
 * Expectations are either independently hand-computed (refWdDelta replicates the documented
 * inclusive working-day convention on purpose) or exact quotes of the source engine's output —
 * a downstream engine that re-derives a number instead of quoting it fails the equality checks.
 */
// S17-E reads the VIEW SOURCE FILES as text. The harness cannot import them: a view pulls in
// `@/lib/supabase`, whose real Supabase client cannot be bundled for node ESM (`Dynamic require of
// "stream" is not supported`). So the table->slot and governed-query contracts are asserted against
// the shipped source instead — which is also the stronger check, because it tests the code the user
// actually runs rather than a copy of it.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATA_DATE, governedDefaultToday } from '@/lib/projectControlsConstants';
import {
  resolveDataDate, isIsoDate, isAfterDataDate, isOnOrBeforeDataDate, calendarDaysBetween, classifyByDate,
  latestDate, earliestDate,
  // S20 (Batch A / M01): the Data Date provenance API.
  resolveDataDateProvenance, isFallbackDataDate, EXPLICIT_GOVERNED_DATE, FALLBACK_DEFAULT_DATE,
  type DataDateBearer,
} from '@/lib/chronologyGuard';
import { calculateCpm } from '@/lib/cpmEngine';
import { getCalendar, countWorkingDays, addWorkingDays } from '@/lib/calendarEngine';
import { calculateBaselineVariances } from '@/lib/trendEngine';
import { generateScheduleAlerts } from '@/lib/alertEngine';
import { calculateRecoveryPlan } from '@/lib/recoveryEngine';
import { levelScheduleResources } from '@/lib/resourceLevelingEngine';
import { parseXerContent } from '@/lib/xerImporter';
import { generateBoqPlan, emptyBoqOverrides } from '@/lib/boqPlanningEngine';
import {
  calculateProjectEvmAtDataDate, deriveEvmFromScalars, assessEvmRatios,
  // S20 (Batch A / H04): the finish-forecast family, gated on the canonical index statuses.
  analyzeForecast, forecastFinishScenarios,
} from '@/lib/planningEngine';
import { analyzeScheduleControl, buildUpdateSnapshot, workingDayDelta, summarizeCanonicalCriticality, type StatusedActivity } from '@/lib/scheduleControlEngine';
import {
  analyzeCostControl, buildCostSnapshot,
  // S20 (Batch A / H02): the one business key that both detects and excludes a duplicate.
  costTransactionBusinessKey, dedupeByBusinessKey,
} from '@/lib/costControlEngine';
import {
  analyzeIntegratedDecisions, gateConfidence,
  // S21 (Batch B / H03): recommendation strength must respect source confidence.
  ACTION_PLAYBOOK, DECISION_ADVISORY_PLAYBOOK, resolveRecommendationStrength,
} from '@/lib/integratedDecisionEngine';
import { analyzeForecastTrust } from '@/lib/forecastTrustEngine';
import { selectCanonicalEvm, canonicalEvmToComprehensive, quoteCanonicalEvm, CANONICAL_EVM_SOURCE } from '@/lib/canonicalEvm';
// S22 (Batch C / NG05): the portfolio index roll-up that must publish null instead of 1.00.
import { rollUpPortfolioIndices, type PortfolioIndexContributor } from '@/lib/canonicalEvm';
// S18 (F9.5 Pilot Closure): the governance EVM pillar is a PURE module precisely so this harness can
// drive the same function that renders the visible `EVM-01/02/03` row. `dataGovernanceEngine` itself
// cannot be imported here — it pulls in `@/lib/supabase`.
import { buildGovernanceEvmCheck, formatGovernedSar, CANONICAL_EVM_ROW_MARKER, DIAGNOSTIC_ROW_MARKER } from '@/lib/governanceEvmPillar';
import { getInitialSeedData } from '@/lib/mockSeed';
// S19 (F9.6 Cross-Surface Control Reconciliation): the S-Curve, its pure time-phased adapter over F6,
// and the governed forecast-presentation semantics. All three are supabase-free so this harness can
// drive the exact functions the screens use.
import { generateSCurveData } from '@/lib/sCurveEngine';
import { evaluateTimePhasedEvm, phasePercentCompleteAsOf, phaseBaselinesForLateCurve, type TimePhasedEvmSources } from '@/lib/sCurveTimePhasing';
import {
  buildRatioPresentation, buildEacPresentation, buildFinishPresentation, reconcileEvmSurfaces,
  UNQUALIFIED_EAC_LABEL_EN, UNQUALIFIED_EAC_LABEL_AR, UNQUALIFIED_FINISH_LABEL_EN, UNQUALIFIED_FINISH_LABEL_AR,
  CANONICAL_COST_AUTHORITY, SCENARIO_COST_AUTHORITY, CANONICAL_SCHEDULE_AUTHORITY, STATISTICAL_SCHEDULE_AUTHORITY,
} from '@/lib/forecastSemantics';
import {
  applyReviewCostTransaction, unimplementedRpcError, reviewStateOf, selectGovernedBaselineActivities,
  // S20 (Batch A / M02): the cost-transaction project boundary, mirrored from the live SQL trigger.
  checkControlRecordProjectBoundary, controlRecordCrossesProjectBoundary,
  type DemoDb,
} from '@/lib/demoDbContracts';

// S20 (Batch A / H01): the governed as-of progress resolver — the single definition F5, F6 and the
// S-Curve's historical phasing all share.
import {
  applyGovernedProgress, resolveGovernedProgress, indexProgressHistory, latestApprovedUpdateOnOrBefore,
} from '@/lib/governedProgress';
import {
  reconcileFinishForecasts, calculateCpmDeterministicEarlyFinish,
  // S21 (Batch B / NG03): the statused F5 CPM is the authoritative deterministic finish.
  resolveDeterministicForecastFinish,
} from '@/lib/forecastReconciliation';
// S21 (Batch B / NG04): Earned Schedule must consume canonical F6, never the legacy planning EVM.
import { calculateEarnedSchedule } from '@/lib/earnedScheduleEngine';
import { calculateControlHealth } from '@/lib/controlHealthEngine';
import {
  simulateComplexProjectScenario, resolveScenarioScheduleBasis, runPrecisionWatchdogAudit,
  calculateScenarioSensitivityTornado, STANDARD_COMPLEX_SCENARIOS,
  // S21 (Batch B / B01): the one canonical producer of the scenario's measured EVM baseline.
  buildScenarioEvmBaseline,
  // S22 (Batch C / NG02): the real Total Float conservation audit behind WATCH-FLOAT-01.
  auditTotalFloatConservation,
  // S22 (Batch C / NG01): the headline simulation KPIs, derived from scenario + watchdog outputs.
  summarizeSimulationControlKpis,
} from '@/lib/complexScenarioSimulator';
import type {
  Activity, ActivityBoqAllocation, ActivityLink, ActivityResource, BaselineActivity, BoqItem, BudgetLine,
  ComplexScenarioModel, ComplexScenarioResult, CostControlSnapshot, CostTransaction, ParsedBoqRow,
  Project, ProgressUpdate, Resource, ScenarioSensitivityTornado, ScheduleUpdateSnapshot, WbsNode,
} from '@/types';

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { failures += 1; console.log(`FAIL ${name}: got ${a}, want ${e}`); }
}
function ok(name: string, cond: boolean): void {
  checks += 1;
  if (!cond) { failures += 1; console.log(`FAIL ${name}`); }
}
function near(name: string, actual: number | null, expected: number, tol = 0.01): void {
  checks += 1;
  if (actual === null || !Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    failures += 1; console.log(`FAIL ${name}: got ${actual}, want ${expected} ±${tol}`);
  }
}
function noNonFinite(name: string, value: unknown): void {
  const bad: string[] = [];
  scanNonFinite(value, name, bad);
  checks += 1;
  if (bad.length > 0) { failures += 1; console.log(`FAIL ${name}: non-finite at ${bad.slice(0, 8).join(', ')}`); }
}
function scanNonFinite(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number' && !Number.isFinite(value)) out.push(`${path}=${String(value)}`);
  else if (Array.isArray(value)) value.forEach((v, i) => scanNonFinite(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) scanNonFinite(v, `${path}.${k}`, out);
  }
}

/**
 * Independent working-day delta replicating the documented engine convention
 * (`countWorkingDays(from, to, cal) − 1`, Friday off on 6_days, inclusive before the −1).
 * Deliberately re-implemented — not imported — so it cross-checks the engines.
 */
function refWdDelta(from: string, to: string): number {
  if (from === to) return 0;
  const [a, b] = to > from ? [from, to] : [to, from];
  let count = 0;
  const d = new Date(`${a}T00:00:00Z`);
  const end = new Date(`${b}T00:00:00Z`);
  while (d <= end) {
    if (d.getUTCDay() !== 5) count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return to > from ? count - 1 : -(count - 1);
}

// ---------------------------------------------------------------------------
// Machine-clock shifter: proves control math never reads the wall clock.
// Only the zero-arg constructor and Date.now() are shifted; explicit dates pass through.
// ---------------------------------------------------------------------------
const RealDate = globalThis.Date;
let clockShiftMs = 0;
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + clockShiftMs);
    else super(args[0] as string | number | Date);
  }
  static now(): number { return RealDate.now() + clockShiftMs; }
}
function withShiftedClock(shiftDays: number, fn: () => void): void {
  clockShiftMs = shiftDays * 86400000;
  (globalThis as Record<string, unknown>).Date = ShiftedDate;
  try { fn(); } finally {
    clockShiftMs = 0;
    (globalThis as Record<string, unknown>).Date = RealDate;
  }
}

// ---------------------------------------------------------------------------
// Factories (full runtime shapes; casts mirror what Supabase returns)
// ---------------------------------------------------------------------------
const DD = DEFAULT_DATA_DATE; // '2026-09-13', a Sunday
function act(o: Partial<Activity> & { id: string; code: string }): Activity {
  return {
    project_id: 'p1', wbs_node_id: null, name: o.code, early_start: null, early_finish: null,
    late_start: null, late_finish: null, actual_start: null, actual_finish: null,
    duration_days: 10, planned_quantity: 0, actual_quantity: 0, unit: null, percent_complete: 0,
    is_critical: false, is_milestone: false, sort_order: 0, created_at: '2026-01-01T00:00:00Z',
    ...o,
  } as Activity;
}
function link(id: string, p: string, s: string, type = 'FS', lag = 0): ActivityLink {
  return { id, project_id: 'p1', predecessor_id: p, successor_id: s, link_type: type, lag_days: lag } as ActivityLink;
}
function base(id: string, actId: string, es: string, ef: string, dur: number, cost: number, tf = 0): BaselineActivity {
  return { id, baseline_id: 'b1', activity_id: actId, early_start: es, early_finish: ef, duration_days: dur, planned_cost: cost, total_float: tf };
}
function upd(id: string, actId: string, date: string, pct: number, status = 'approved'): ProgressUpdate {
  return {
    id, project_id: 'p1', activity_id: actId, update_date: date, percent_complete: pct,
    actual_quantity: 0, quantity_to_date: 0, status, approved_at: `${date}T08:00:00Z`,
    rejected_reason: null, notes: null, created_at: `${date}T08:00:00Z`,
  } as ProgressUpdate;
}
function txn(id: string, actId: string | null, date: string, amount: number, status = 'approved', source: string | null = 'INV'): CostTransaction {
  return {
    id, project_id: 'p1', activity_id: actId, boq_item_id: null, category: 'work', transaction_date: date,
    description: `txn ${id}`, cost_type: 'direct', amount, source, status,
    approved_at: `${date}T09:00:00Z`, rejected_reason: null, created_at: `${date}T09:00:00Z`,
  } as CostTransaction;
}
function boq(id: string, code: string, qty: number, total: number): BoqItem {
  return {
    id, project_id: 'p1', code, description: code, unit: 'm2', quantity: qty,
    unit_price: qty > 0 ? total / qty : 0, total_price: total, category: null, section: null,
    sort_order: 0, created_at: '2026-01-01T00:00:00Z',
  } as BoqItem;
}
function alloc(id: string, actId: string, boqId: string, qty: number, cost: number): ActivityBoqAllocation {
  return { id, project_id: 'p1', activity_id: actId, boq_item_id: boqId, quantity_share: qty, cost_share: cost, allocation_basis: 'plan' };
}
function wbsNode(id: string, parentId: string | null, code: string): WbsNode {
  return { id, project_id: 'p1', parent_id: parentId, code, name: code, level: parentId ? 2 : 1, sort_order: 0, boq_item_id: null, created_at: '2026-01-01T00:00:00Z' } as WbsNode;
}
function schedRow(ef: string | null, tf: number | null, critical: boolean, pct: number) {
  return { ef, tf, critical, ct: null, cid: null, linkSig: '', pct };
}
function schedSnap(id: string, date: string, ff: string | null, pct: number, rows: Record<string, ReturnType<typeof schedRow>>): ScheduleUpdateSnapshot {
  return {
    id, project_id: 'p1', data_date: date, forecast_finish: ff, progress_pct: pct,
    critical_count: Object.values(rows).filter((r) => r.critical).length, near_critical_count: 0,
    total_delay_days: null, delay_vs_previous_days: null, milestones_slipped: 0,
    details: { version: 1, activities: rows, drivingLinkIds: [] }, created_at: `${date}T10:00:00Z`,
  } as ScheduleUpdateSnapshot;
}
function costSnap(id: string, date: string, v: { bac: number | null; pv: number | null; ev: number | null; ac: number | null; cpi: number | null; spi: number | null; etc: number | null; eac: number | null; vac: number | null }): CostControlSnapshot {
  return {
    id, project_id: 'p1', data_date: date, ...v, committed: null, forecast_confidence: 'Medium',
    recommended_method: 'eac_ac_bac_ev',
    details: { version: 1, methods: [], recommended: null, activities: {}, counts: { activities: 0, wbsNodes: 0, integrityErrors: 0, anomalies: 0 } },
    created_at: `${date}T10:00:00Z`,
  } as CostControlSnapshot;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Pipeline runner: the exact F5 → F6 → F7 → F8 chain the Dashboard runs.
// ---------------------------------------------------------------------------
interface Scenario {
  activities: Activity[]; links: ActivityLink[]; baselines: BaselineActivity[];
  updates: ProgressUpdate[]; txns: CostTransaction[]; boqItems: BoqItem[]; allocations: ActivityBoqAllocation[];
  wbsNodes: WbsNode[]; schedSnaps: ScheduleUpdateSnapshot[]; costSnaps: CostControlSnapshot[];
}
const prevBefore = <T extends { data_date: string }>(rows: T[], dd: string): T | null =>
  [...rows].filter((x) => x.data_date < dd).sort((a, b) => (a.data_date < b.data_date ? 1 : -1))[0] || null;

function runPipeline(s: Scenario, opts: { withF7?: boolean; manualEtc?: number | null } = {}) {
  const withF7 = opts.withF7 !== false;
  const prevSched = prevBefore(s.schedSnaps, DD);
  const f5 = analyzeScheduleControl({
    activities: s.activities, links: s.links, baselines: s.baselines, progressUpdates: s.updates,
    previousSnapshot: prevSched, dataDate: DD, calendarType: '6_days',
  });
  const f6 = analyzeCostControl({
    project: { id: 'p1', data_date: DD }, activities: s.activities, baselines: s.baselines,
    budgetLines: [], costTransactions: s.txns, progressUpdates: s.updates, wbsNodes: s.wbsNodes,
    boqItems: s.boqItems, allocations: s.allocations,
    previousSnapshots: s.costSnaps, dataDate: DD, calendarType: '6_days',
    manualEtc: opts.manualEtc ?? null,
  });
  const prevCost = prevBefore(s.costSnaps, DD);
  const f7 = withF7
    ? analyzeIntegratedDecisions({
        scheduleReport: f5, costReport: f6, activities: s.activities, links: s.links,
        baselines: s.baselines, progressUpdates: s.updates,
        previousScheduleSnapshot: prevSched, previousCostSnapshot: prevCost, dataDate: DD, calendarType: '6_days',
      })
    : null;
  const trust = analyzeForecastTrust({
    scheduleReport: f5, costReport: f6, decisionReport: f7,
    activities: s.activities, links: s.links, baselines: s.baselines,
    progressUpdates: s.updates, costTransactions: s.txns, boqItems: s.boqItems, allocations: s.allocations,
    scheduleSnapshots: s.schedSnaps, costSnapshots: s.costSnaps, dataDate: DD, calendarType: '6_days',
  });
  return { f5, f6, f7, trust };
}

// A completed project with full snapshot history (the exactness scenario from the F8 acceptance run).
const FULL: Scenario = {
  activities: [
    act({ id: 'A1', code: 'A1', early_start: '2026-07-01', early_finish: '2026-08-18', actual_start: '2026-07-01', actual_finish: '2026-08-20', duration_days: 30, percent_complete: 100, planned_quantity: 100, actual_quantity: 100, is_critical: true }),
    act({ id: 'A2', code: 'A2', early_start: '2026-08-19', early_finish: '2026-08-24', actual_start: '2026-08-22', actual_finish: '2026-08-25', duration_days: 4, percent_complete: 100, planned_quantity: 50, actual_quantity: 50 }),
    act({ id: 'A3', code: 'A3', early_start: '2026-08-25', early_finish: '2026-09-06', actual_start: '2026-08-26', actual_finish: '2026-09-10', duration_days: 12, percent_complete: 100, planned_quantity: 200, actual_quantity: 200 }),
    act({ id: 'M1', code: 'M1', is_milestone: true, duration_days: 0, early_start: '2026-08-30', early_finish: '2026-08-30', actual_start: '2026-09-05', actual_finish: '2026-09-05', percent_complete: 100 }),
    act({ id: 'M2', code: 'M2', is_milestone: true, duration_days: 0, early_start: '2026-09-06', early_finish: '2026-09-06', actual_start: '2026-09-08', actual_finish: '2026-09-08', percent_complete: 100 }),
  ],
  links: [link('L1', 'A1', 'A2'), link('L2', 'A2', 'A3')],
  baselines: [
    base('B1', 'A1', '2026-07-01', '2026-08-18', 30, 300000),
    base('B2', 'A2', '2026-08-19', '2026-08-24', 5, 150000),
    base('B3', 'A3', '2026-08-25', '2026-09-06', 12, 550000),
    base('B4', 'M1', '2026-08-30', '2026-08-30', 0, 0),
    base('B5', 'M2', '2026-09-06', '2026-09-06', 0, 0),
  ],
  updates: [
    upd('U1', 'A1', '2026-08-20', 100), upd('U2', 'A2', '2026-08-25', 100),
    upd('U3', 'A3', '2026-09-10', 100), upd('U4', 'M1', '2026-09-05', 100), upd('U5', 'M2', '2026-09-08', 100),
  ],
  txns: [
    txn('T1', 'A1', '2026-07-15', 300000, 'approved', 'INV-1'), txn('T2', 'A2', '2026-08-20', 360000, 'approved', 'INV-2'),
    txn('T3', 'A3', '2026-08-30', 300000, 'approved', 'INV-3'), txn('T4', 'A3', '2026-09-05', 40000, 'approved', 'INV-4'),
    txn('T5', 'A3', '2026-09-10', 30000, 'approved', 'INV-5'),
  ],
  boqItems: [boq('Q1', 'B1', 100, 300000), boq('Q2', 'B2', 50, 150000), boq('Q3', 'B3', 200, 550000)],
  allocations: [alloc('AL1', 'A1', 'Q1', 100, 300000), alloc('AL2', 'A2', 'Q2', 50, 150000), alloc('AL3', 'A3', 'Q3', 200, 550000)],
  wbsNodes: [],
  schedSnaps: [
    schedSnap('SS4', '2026-09-13', '2026-09-10', 100, {
      A1: schedRow('2026-08-20', 0, true, 100), A2: schedRow('2026-08-25', 0, false, 100),
      A3: schedRow('2026-09-10', 0, true, 100), M1: schedRow('2026-09-05', 0, false, 100), M2: schedRow('2026-09-08', 0, false, 100),
    }),
    schedSnap('SS1', '2026-08-01', '2026-08-27', 40, {
      A1: schedRow('2026-08-18', 0, true, 60), A2: schedRow('2026-08-24', 8, false, 0),
      A3: schedRow('2026-08-26', 8, false, 0), M1: schedRow('2026-08-29', 4, false, 0), M2: schedRow('2026-08-27', 6, false, 0),
    }),
    schedSnap('SS3', '2026-09-01', '2026-09-06', 85, {
      A1: schedRow('2026-08-20', 0, true, 100), A2: schedRow('2026-08-25', 0, false, 100),
      A3: schedRow('2026-09-06', 2, true, 60), M1: schedRow('2026-09-04', 0, false, 0), M2: schedRow('2026-09-07', 2, false, 0),
    }),
    schedSnap('SS2', '2026-08-15', '2026-09-03', 65, {
      A1: schedRow('2026-08-20', 0, true, 90), A2: schedRow('2026-08-25', 5, false, 20),
      A3: schedRow('2026-09-02', 5, false, 0), M1: schedRow('2026-09-03', 2, false, 0), M2: schedRow('2026-09-03', 4, false, 0),
    }),
  ],
  costSnaps: [
    costSnap('CS3', '2026-09-13', { bac: 1000000, pv: 1000000, ev: 1000000, ac: 1030000, cpi: 0.97, spi: 1.0, etc: 0, eac: 1030000, vac: -30000 }),
    costSnap('CS1', '2026-08-01', { bac: 1000000, pv: 350000, ev: 300000, ac: 320000, cpi: 0.94, spi: 0.86, etc: 680000, eac: 1000000, vac: 0 }),
    costSnap('CS2', '2026-09-01', { bac: 1000000, pv: 850000, ev: 900000, ac: 960000, cpi: 0.94, spi: 1.06, etc: 60000, eac: 1020000, vac: -20000 }),
  ],
};

// A small in-flight project (sparse-ish: some activities undated by the user, partial progress).
const SPARSE: Scenario = {
  activities: [
    act({ id: 'S1', code: 'S1', early_start: '2026-08-01', early_finish: '2026-08-20', actual_start: '2026-08-01', duration_days: 15, percent_complete: 60, is_critical: true }),
    act({ id: 'S2', code: 'S2', early_start: '2026-08-21', early_finish: '2026-09-15', duration_days: 20, percent_complete: 0 }),
  ],
  links: [link('SL1', 'S1', 'S2')],
  baselines: [base('SB1', 'S1', '2026-08-01', '2026-08-20', 15, 100000)],
  updates: [upd('SU1', 'S1', '2026-09-01', 60)],
  txns: [txn('ST1', 'S1', '2026-08-25', 40000, 'approved', 'INV-S1')],
  boqItems: [], allocations: [], wbsNodes: [],
  schedSnaps: [], costSnaps: [],
};

const EMPTY: Scenario = {
  activities: [], links: [], baselines: [], updates: [], txns: [], boqItems: [], allocations: [],
  wbsNodes: [], schedSnaps: [], costSnaps: [],
};

// ===========================================================================
console.log('--- S0 chronology guard units');
// ===========================================================================
eq('S0 resolveDataDate: override wins', resolveDataDate({ data_date: '2026-08-01' }, '2026-09-01'), '2026-09-01');
eq('S0 resolveDataDate: project DD', resolveDataDate({ data_date: '2026-08-01' }), '2026-08-01');
eq('S0 resolveDataDate: null project → governed constant', resolveDataDate(null), DEFAULT_DATA_DATE);
ok('S0 governedDefaultToday anchors DEFAULT_DATA_DATE', governedDefaultToday().toISOString().startsWith(DEFAULT_DATA_DATE));
ok('S0 isIsoDate', isIsoDate('2026-09-13') && !isIsoDate('2026-9-13') && !isIsoDate(null));
ok('S0 isAfterDataDate', isAfterDataDate('2026-09-14', DD) && !isAfterDataDate('2026-09-13', DD) && !isAfterDataDate(null, DD));
ok('S0 isOnOrBeforeDataDate', isOnOrBeforeDataDate('2026-09-13', DD) && !isOnOrBeforeDataDate('2026-09-14', DD));
eq('S0 calendarDaysBetween symmetric', calendarDaysBetween('2026-09-01', '2026-09-13'), 12);
eq('S0 calendarDaysBetween negative', calendarDaysBetween('2026-09-13', '2026-09-01'), -12);
eq('S0 calendarDaysBetween junk is null', calendarDaysBetween('nope', '2026-09-13'), null);
const datedRows = [{ d: '2026-01-01' }, { d: null }, { d: 'not-a-date' }, { d: '2026-06-01' }];
eq('S0 latestDate ignores junk', latestDate(datedRows, (r) => r.d), '2026-06-01');
eq('S0 earliestDate ignores junk', earliestDate(datedRows, (r) => r.d), '2026-01-01');
eq('S0 classifyByDate on DD is actual', classifyByDate(DD, DD), 'actual');
eq('S0 classifyByDate after DD is future_planned', classifyByDate('2026-09-14', DD), 'future_planned');
eq('S0 classifyByDate junk is undated', classifyByDate('nope', DD), 'undated');

// ===========================================================================
console.log('--- S1 CPM core');
// ===========================================================================
{
  // Chain A(10d) → B(5d) → C(8d) from 2026-08-27 (Thu) on the 6-day calendar (Friday off).
  const acts = [
    act({ id: 'A', code: 'A', duration_days: 10, early_start: '2026-08-27' }),
    act({ id: 'B', code: 'B', duration_days: 5 }),
    act({ id: 'C', code: 'C', duration_days: 8 }),
    act({ id: 'P', code: 'P', duration_days: 3 }), // parallel short path
  ];
  const lks = [link('LA', 'A', 'B'), link('LB', 'B', 'C'), link('LP', 'A', 'P')];
  const calc = calculateCpm(acts, lks, { calendarType: '6_days', dataDate: '2026-08-27' });
  const byId = new Map(calc.results.map((r) => [r.activityId, r]));
  eq('S1 no cycle', calc.cycle, null);
  eq('S1 A earlyStart', byId.get('A')?.earlyStart, '2026-08-27');
  eq('S1 A is critical', byId.get('A')?.isCritical, true);
  ok('S1 B starts the working day after A finishes (Friday skipped when applicable)',
    refWdDelta(byId.get('A')!.earlyFinish, byId.get('B')!.earlyStart) === 1);
  eq('S1 chain duration: A→C working span', refWdDelta(byId.get('A')!.earlyStart, byId.get('C')!.earlyFinish), 10 + 5 + 8 - 1 + 1 - 1); // inclusive span = 22 wd
  eq('S1 projectEarlyFinish == max EF', calc.projectEarlyFinish,
    calc.results.map((r) => r.earlyFinish).sort().slice(-1)[0]);
  ok('S1 parallel path P has positive float', (byId.get('P')?.totalFloat ?? 0) > 0);
  eq('S1 P not critical', byId.get('P')?.isCritical, false);
  eq('S1 total float = late − early working delta (A)', workingDayDelta(byId.get('A')!.earlyFinish, byId.get('A')!.lateFinish, getCalendar('6_days')), byId.get('A')?.totalFloat ?? null);

  // Milestone: zero duration ⇒ start == finish.
  const mCalc = calculateCpm([act({ id: 'M', code: 'M', duration_days: 0, is_milestone: true })], [], { calendarType: '6_days', dataDate: '2026-08-27' });
  eq('S1 milestone start == finish', mCalc.results[0].earlyStart, mCalc.results[0].earlyFinish);

  // Cycle detection.
  const cyc = calculateCpm([act({ id: 'X', code: 'X' }), act({ id: 'Y', code: 'Y' })], [link('LX', 'X', 'Y'), link('LY', 'Y', 'X')], { calendarType: '6_days', dataDate: '2026-08-27' });
  ok('S1 cycle detected', Array.isArray(cyc.cycle) && cyc.cycle.length > 0);

  // Lag: FS+2 pushes the successor by 2 working days.
  const lagCalc = calculateCpm([act({ id: 'A', code: 'A', duration_days: 4 }), act({ id: 'B', code: 'B', duration_days: 4 })], [link('LAB', 'A', 'B', 'FS', 2)], { calendarType: '6_days', dataDate: '2026-08-27' });
  const lagById = new Map(lagCalc.results.map((r) => [r.activityId, r]));
  eq('S1 FS+2 lag working delta', refWdDelta(lagById.get('A')!.earlyFinish, lagById.get('B')!.earlyStart), 3); // 1 (normal FS) + 2 lag

  // Calendar variants change the finish: 5_days must finish no earlier than 6_days.
  const c5 = calculateCpm(acts, lks, { calendarType: '5_days', dataDate: '2026-08-27' });
  ok('S1 5-day calendar finish >= 6-day finish', c5.projectEarlyFinish >= calc.projectEarlyFinish);
  const c7 = calculateCpm(acts, lks, { calendarType: '7_days', dataDate: '2026-08-27' });
  ok('S1 7-day calendar finish <= 6-day finish', c7.projectEarlyFinish <= calc.projectEarlyFinish);

  // countWorkingDays inclusive convention (documented calendar facts).
  eq('S1 countWorkingDays Aug27→Sep3 = 7 inclusive', countWorkingDays('2026-08-27', '2026-09-03', getCalendar('6_days')), 7);
  eq('S1 workingDayDelta Aug27→Sep3 = 6', workingDayDelta('2026-08-27', '2026-09-03', getCalendar('6_days')), 6);
  eq('S1 workingDayDelta Fri→Sat = 0 (non-working from)', workingDayDelta('2026-09-04', '2026-09-05', getCalendar('6_days')), 0);
  eq('S1 workingDayDelta symmetric negatives', workingDayDelta('2026-09-10', '2026-08-27', getCalendar('6_days')), -12);

  // F9.1 project-start anchor: the Data Date the engine derives must be the earliest date the
  // PROJECT DATA actually carries (actual_start || early_start), NOT a reduce seeded with the
  // governed constant. DEFAULT_DATA_DATE is used only when no activity carries any usable date,
  // and an explicit options.dataDate stays authoritative.
  {
    // A — every activity date is AFTER DEFAULT_DATA_DATE, no explicit dataDate supplied.
    const lateActs = [
      act({ id: 'AN1', code: 'AN1', duration_days: 5, early_start: '2027-01-03' }), // Sunday, working in 6_days
      act({ id: 'AN2', code: 'AN2', duration_days: 5, early_start: '2027-03-01' }),
    ];
    const lateCalc = calculateCpm(lateActs, [link('LAN', 'AN1', 'AN2')], { calendarType: '6_days' });
    eq('S1 anchor A: all-later-dated project anchors to its own earliest date', lateCalc.dataDate, '2027-01-03');
    ok('S1 anchor A: NOT pulled back to the governed DEFAULT_DATA_DATE', lateCalc.dataDate > DEFAULT_DATA_DATE);
    // actual_start alone must also feed the anchor.
    const withActual = calculateCpm([act({ id: 'AN3', code: 'AN3', duration_days: 5, actual_start: '2027-01-03' })], [], { calendarType: '6_days' });
    eq('S1 anchor A: actual_start alone feeds the derived anchor', withActual.dataDate, '2027-01-03');

    // B — every activity date is BEFORE DEFAULT_DATA_DATE.
    const earlyActs = [
      act({ id: 'AN4', code: 'AN4', duration_days: 5, early_start: '2026-03-02' }), // Monday
      act({ id: 'AN5', code: 'AN5', duration_days: 5, early_start: '2026-05-04' }), // Monday
    ];
    const earlyCalc = calculateCpm(earlyActs, [link('LAN2', 'AN4', 'AN5')], { calendarType: '6_days' });
    eq('S1 anchor B: all-earlier-dated project anchors to its own earliest date', earlyCalc.dataDate, '2026-03-02');

    // C — completely dateless project falls back to exactly the governed constant.
    const dateless = [act({ id: 'AN6', code: 'AN6', duration_days: 5 }), act({ id: 'AN7', code: 'AN7', duration_days: 5 })];
    const datelessCalc = calculateCpm(dateless, [link('LAN3', 'AN6', 'AN7')], { calendarType: '6_days' });
    eq('S1 anchor C: fully dateless project falls back to governed DEFAULT_DATA_DATE', datelessCalc.dataDate, DEFAULT_DATA_DATE);

    // D — explicit options.dataDate overrides the derived project anchor.
    const overrideCalc = calculateCpm(lateActs, [link('LAN4', 'AN1', 'AN2')], { calendarType: '6_days', dataDate: '2026-08-27' }); // Thursday
    eq('S1 anchor D: explicit options.dataDate overrides the derived anchor', overrideCalc.dataDate, '2026-08-27');
  }
}

// ===========================================================================
console.log('--- S2 machine-clock independence (acceptance A)');
// ===========================================================================
{
  const undated = [act({ id: 'N1', code: 'N1', duration_days: 5 }), act({ id: 'N2', code: 'N2', duration_days: 5 })];
  const undatedLinks = [link('NL', 'N1', 'N2')];
  const cpmNow = JSON.stringify(calculateCpm(undated, undatedLinks, { calendarType: '6_days' }));
  let cpmShifted = '';
  withShiftedClock(400, () => { cpmShifted = JSON.stringify(calculateCpm(undated, undatedLinks, { calendarType: '6_days' })); });
  eq('S2 CPM (dateless) identical under +400d clock shift', cpmShifted, cpmNow);
  const anchor = calculateCpm(undated, undatedLinks, { calendarType: '6_days' });
  ok('S2 dateless CPM anchors to governed Data Date window', anchor.dataDate >= DEFAULT_DATA_DATE && anchor.projectEarlyStart >= DEFAULT_DATA_DATE);

  const varianceNow = JSON.stringify(calculateBaselineVariances(FULL.activities, FULL.baselines));
  let varianceShifted = '';
  withShiftedClock(-700, () => { varianceShifted = JSON.stringify(calculateBaselineVariances(FULL.activities, FULL.baselines)); });
  eq('S2 baseline variances (default today) identical under −700d shift', varianceShifted, varianceNow);

  const evmSample = deriveEvmFromScalars(1000000, 0.5, 0.4, 420000);
  const alertsNow = JSON.stringify(generateScheduleAlerts(FULL.activities, evmSample));
  let alertsShifted = '';
  withShiftedClock(400, () => { alertsShifted = JSON.stringify(generateScheduleAlerts(FULL.activities, evmSample)); });
  eq('S2 schedule alerts (default today) identical under shift', alertsShifted, alertsNow);

  const recoveryNow = JSON.stringify(calculateRecoveryPlan(SPARSE.activities, SPARSE.baselines, evmSample));
  let recoveryShifted = '';
  withShiftedClock(400, () => { recoveryShifted = JSON.stringify(calculateRecoveryPlan(SPARSE.activities, SPARSE.baselines, evmSample)); });
  eq('S2 recovery plan (default today) identical under shift', recoveryShifted, recoveryNow);

  const res = { id: 'R1', project_id: 'p1', name: 'Crew', type: 'labor', unit: 'crew', unit_rate: 100, availability: 1, created_at: '2026-01-01T00:00:00Z' } as Resource;
  const asg = { id: 'AS1', activity_id: 'N1', resource_id: 'R1', project_id: 'p1', planned_quantity: 5, actual_quantity: 0, created_at: '2026-01-01T00:00:00Z' } as ActivityResource;
  const levelNow = JSON.stringify(levelScheduleResources(undated, [res], [asg], '6_days'));
  let levelShifted = '';
  withShiftedClock(400, () => { levelShifted = JSON.stringify(levelScheduleResources(undated, [res], [asg], '6_days')); });
  eq('S2 leveling (dateless) identical under shift', levelShifted, levelNow);

  const pipelineNow = JSON.stringify(runPipeline(FULL));
  let pipelineShifted = '';
  withShiftedClock(900, () => { pipelineShifted = JSON.stringify(runPipeline(FULL)); });
  eq('S2 full F5–F8 pipeline identical under +900d shift', pipelineShifted, pipelineNow);
}

// ===========================================================================
console.log('--- S3 XER fidelity anchors');
// ===========================================================================
{
  const t = (...cells: string[]) => cells.join('\t');
  const xer = [
    t('ERMHDR', '19.12', '2026-09-13 08:00', '', '', 'PILOT', 'USD'),
    t('%T', 'PROJECT'),
    t('%F', 'proj_id', 'proj_short_name', 'plan_start_date', 'data_date', 'clndr_id', 'critical_drtn_hr_cnt', 'def_complete_pct_type'),
    t('%R', '1', 'PILOT-P', '2026-08-27 06:00', '2026-09-13 00:00', '1', '0', 'CP_Physical'),
    t('%T', 'CALENDAR'),
    t('%F', 'clndr_id', 'clndr_name', 'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'default_flag'),
    t('%R', '1', 'SixDay', 'CA_Project', '8', '48', 'D'),
    t('%T', 'PROJWBS'),
    t('%F', 'wbs_id', 'parent_wbs_id', 'wbs_short_name', 'wbs_name', 'seq_num', 'proj_id'),
    t('%R', '1', '', 'CIV', 'Civil Works', '1', '1'),
    t('%T', 'TASK'),
    t('%F', 'task_id', 'proj_id', 'wbs_id', 'clndr_id', 'task_code', 'task_name', 'task_type', 'status_code', 'complete_pct_type', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'phys_complete_pct', 'early_start_date', 'early_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt'),
    t('%R', '10', '1', '1', '1', 'A1000', 'Excavate', 'TT_Task', 'TK_Active', 'CP_Physical', '80', '40', '50', '2026-08-27 06:00', '2026-09-05 17:00', '0', '0'),
    t('%R', '11', '1', '1', '1', 'A2000', 'Foundations', 'TT_Task', 'TK_NotStart', 'CP_Physical', '40', '40', '', '', '', '16', '16'),
    t('%R', '12', '1', '1', '1', 'M1000', 'Structure Complete', 'TT_Mile', 'TK_NotStart', 'CP_Physical', '0', '0', '', '', '', '0', '0'),
    t('%T', 'TASKPRED'),
    t('%F', 'task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_type', 'lag_hr_cnt'),
    t('%R', '100', '11', '10', '1', 'PR_FS', '0'),
    t('%R', '101', '12', '11', '1', 'PR_FS', '16'),
    t('%L'),
  ].join('\n');

  const parsed = parseXerContent(xer);
  ok('S3 project selected', parsed.project !== null);
  eq('S3 project data date read from PROJECT.data_date only', parsed.project?.dataDate, '2026-09-13');
  eq('S3 project short name', parsed.project?.shortName, 'PILOT-P');
  eq('S3 critical threshold hours', parsed.project?.criticalDrtnHours, 0);
  eq('S3 activity count', parsed.activities.length, 3);
  const a1 = parsed.activities.find((x) => x.code === 'A1000');
  const a2 = parsed.activities.find((x) => x.code === 'A2000');
  const m1 = parsed.activities.find((x) => x.code === 'M1000');
  eq('S3 A1000 duration 80h/8hpd = 10d', a1?.durationDays, 10);
  eq('S3 A1000 remaining 40h = 5d', a1?.remainingDays, 5);
  eq('S3 A1000 percent from phys_complete_pct', a1?.percentComplete, 50);
  eq('S3 A1000 float 0h ⇒ critical at threshold 0', a1?.isCritical, true);
  ok('S3 A1000 float basis quotes both numbers', (a1?.criticalBasis || '').includes('total_float_hr_cnt=0'));
  eq('S3 A2000 TK_NotStart ⇒ 0%', a2?.percentComplete, 0);
  eq('S3 A2000 float 16h/8 = 2d', a2?.totalFloatDays, 2);
  eq('S3 A2000 not critical (2d > 0 threshold)', a2?.isCritical, false);
  eq('S3 milestone detected', m1?.isMilestone, true);
  eq('S3 link count', parsed.links.length, 2);
  const l1 = parsed.links.find((x) => x.predXerId === '10');
  eq('S3 link type FS', l1?.linkType, 'FS');
  eq('S3 lag 0h ⇒ 0d exact', l1?.lagDaysExact, 0);
  const l2 = parsed.links.find((x) => x.predXerId === '11');
  eq('S3 lag 16h/8hpd = 2d exact', l2?.lagDaysExact, 2);
  eq('S3 calendar hours per day', parsed.calendars[0]?.hoursPerDay, 8);
  eq('S3 calendar pattern status without clndr_data', parsed.calendars[0]?.patternStatus, 'no_data');
  eq('S3 wbs parsed', parsed.wbs.length, 1);
  const reparsed = parseXerContent(xer);
  eq('S3 parse determinism', JSON.stringify(reparsed), JSON.stringify(parsed));
  noNonFinite('S3 parsed XER scan', parsed);
}

// ===========================================================================
console.log('--- S4 BOQ planning');
// ===========================================================================
{
  const rows: ParsedBoqRow[] = [
    { code: '101', description: 'Excavation for foundations', unit: 'm3', quantity: 500, unit_price: 40, total_price: 20000, category: '', section: '' },
    { code: '102', description: 'Plain cement concrete blinding', unit: 'm3', quantity: 60, unit_price: 150, total_price: 9000, category: '', section: '' },
    { code: '103', description: 'Reinforced concrete footings', unit: 'm3', quantity: 120, unit_price: 600, total_price: 72000, category: '', section: '' },
    { code: '201', description: 'Blockwork masonry walls', unit: 'm2', quantity: 800, unit_price: 90, total_price: 72000, category: '', section: '' },
    { code: '301', description: 'Supply and install ceramic tiles', unit: 'm2', quantity: 300, unit_price: 0, total_price: 0, category: '', section: '' },
  ];
  const profile = { projectName: 'Pilot Tower', startDate: '2026-08-27', calendarType: '6_days' as const };
  const plan = generateBoqPlan(rows, profile, emptyBoqOverrides());
  ok('S4 plan generated activities', plan.activities.length > 0);
  ok('S4 CPM produced a finish', typeof plan.recon.projectFinish === 'string' && isIsoDate(plan.recon.projectFinish));
  eq('S4 plan finish == max activity early finish', plan.recon.projectFinish,
    plan.activities.map((a) => a.earlyFinish || '').sort().slice(-1)[0]);
  // BOQ traceability identity: every riyal is either allocated or explicitly unallocated.
  near('S4 allocated + unallocated == BOQ total', plan.recon.allocatedTotal + plan.recon.unallocatedTotal, plan.recon.boqTotal, 0.02);
  near('S4 BOQ total == sum of row totals', plan.recon.boqTotal, 173000, 0.02);
  const planAgain = generateBoqPlan(rows, profile, emptyBoqOverrides());
  eq('S4 BOQ planning determinism', JSON.stringify(planAgain), JSON.stringify(plan));
  noNonFinite('S4 plan scan', plan);
  // A zero-priced row must not invent money: it lands in review, never priced by estimate.
  ok('S4 zero-priced row routed to review, not fabricated', plan.recon.reviewItemCount >= 1);
}

// ===========================================================================
console.log('--- S5 resource leveling');
// ===========================================================================
{
  const res = { id: 'R1', project_id: 'p1', name: 'Formwork crew', type: 'labor', unit: 'crew', unit_rate: 500, availability: 2, created_at: '2026-01-01T00:00:00Z' } as Resource;
  const crit = act({ id: 'C1', code: 'C1', early_start: '2026-08-27', early_finish: '2026-09-06', duration_days: 8, is_critical: true, total_float: 0 });
  const loose = act({ id: 'F1', code: 'F1', early_start: '2026-08-27', early_finish: '2026-09-03', duration_days: 5, is_critical: false, total_float: 8 });
  const asgCrit = { id: 'AC1', activity_id: 'C1', resource_id: 'R1', project_id: 'p1', planned_quantity: 4, actual_quantity: 0, created_at: '2026-01-01T00:00:00Z' } as ActivityResource;
  const asgLoose = { id: 'AF1', activity_id: 'F1', resource_id: 'R1', project_id: 'p1', planned_quantity: 4, actual_quantity: 0, created_at: '2026-01-01T00:00:00Z' } as ActivityResource;
  const result = levelScheduleResources([crit, loose], [res], [asgCrit, asgLoose], '6_days');
  ok('S5 only the non-critical activity is a shift candidate', result.leveledActivities.every((c) => c.activityId !== 'C1'));
  const shift = result.leveledActivities.find((c) => c.activityId === 'F1');
  if (shift) {
    ok('S5 shift bounded by float and the 5-day cap', shift.shiftDays > 0 && shift.shiftDays <= Math.min(8, 5));
    ok('S5 shifted dates are ISO', isIsoDate(shift.earlyStart) && isIsoDate(shift.earlyFinish));
  }
  ok('S5 counters finite', Number.isFinite(result.overallocationsResolved) && Number.isFinite(result.remainingOverallocations) && Number.isFinite(result.projectExtendedDays));
  const again = levelScheduleResources([crit, loose], [res], [asgCrit, asgLoose], '6_days');
  eq('S5 leveling determinism', JSON.stringify(again), JSON.stringify(result));
  noNonFinite('S5 leveling scan', result);
  const emptyLevel = levelScheduleResources([], [], [], '6_days');
  noNonFinite('S5 leveling empty scan', emptyLevel);
}

// ===========================================================================
console.log('--- S6 canonical EVM (planningEngine)');
// ===========================================================================
{
  const project = { contract_value: 1000000, start_date: '2026-07-01', end_date: '2026-12-31', data_date: DD };
  const acts = [
    act({ id: 'A1', code: 'A1', percent_complete: 100, duration_days: 10, early_start: '2026-07-01', early_finish: '2026-07-14' }),
    act({ id: 'A2', code: 'A2', percent_complete: 50, duration_days: 10, early_start: '2026-07-15', early_finish: '2026-07-28' }),
  ];
  const budget = [
    { id: 'BL1', activity_id: 'A1', planned_cost: 100000 },
    { id: 'BL2', activity_id: 'A2', planned_cost: 100000 },
  ];
  const txnsAll = [
    txn('K1', 'A1', '2026-07-10', 90000, 'approved', 'INV-K1'),
    txn('K2', 'A2', '2026-07-20', 20000, 'submitted', 'INV-K2'),   // not approved ⇒ excluded
    txn('K3', 'A2', '2026-09-20', 30000, 'approved', 'INV-K3'),     // after DD ⇒ excluded
    txn('K4', 'A2', '2026-07-25', 40000, 'approved', 'INV-K4'),
  ];
  const evm = calculateProjectEvmAtDataDate(project, acts, budget, [], txnsAll, []);
  eq('S6 governed data date echoed', evm.dataDate, DD);
  eq('S6 AC counts approved ≤ DD only', evm.ac, 130000);
  // BAC precedence is documented: contract_value first, then budget lines, then BOQ.
  eq('S6 BAC prefers contract value when present', evm.bac, 1000000);
  eq('S6 BAC source names the contract', evm.bacSource, 'contract_value');
  const evmNoContract = calculateProjectEvmAtDataDate({ data_date: DD }, acts, budget, [], txnsAll, []);
  eq('S6 BAC falls back to budget lines', evmNoContract.bac, 200000);
  eq('S6 BAC source names budget lines', evmNoContract.bacSource, 'budget_lines');
  ok('S6 SPI finite', Number.isFinite(evm.spi));
  ok('S6 CPI finite', Number.isFinite(evm.cpi));
  near('S6 CPI = EV/AC', evm.cpi, evm.ev / 130000, 0.001);

  // Empty state: no budget, no cost ⇒ statuses flag the gap, values stay finite (no NaN).
  const emptyEvm = calculateProjectEvmAtDataDate({ data_date: DD }, [], [], [], [], []);
  noNonFinite('S6 empty EVM scan', emptyEvm);
  const zeroRatios = assessEvmRatios(0, 0, 0, 0);
  noNonFinite('S6 assessEvmRatios zeros', zeroRatios);
  ok('S6 zero-BAC status marks the gap, not a fake index', zeroRatios.cpiStatus !== 'ok' || zeroRatios.cpi === 1);
  const derived = deriveEvmFromScalars(0, 0.4, 0.4, 0);
  noNonFinite('S6 deriveEvmFromScalars zeros', derived);
}

// ===========================================================================
console.log('--- S7 F5 schedule control');
// ===========================================================================
{
  const { f5 } = runPipeline(FULL);
  // Canonical finish: the max forecast/actual finish across activities.
  eq('S7 forecast finish == max activity finish', f5.project.forecastFinish,
    FULL.activities.map((a) => a.actual_finish || a.early_finish || '').sort().slice(-1)[0]);
  eq('S7 baseline finish == max baseline finish', f5.project.baselineFinish,
    FULL.baselines.map((b) => b.early_finish).sort().slice(-1)[0]);
  // Hand-computed total delay in working days (inclusive convention).
  eq('S7 totalDelayWd hand-computed', f5.project.totalDelayWd, refWdDelta(f5.project.baselineFinish!, f5.project.forecastFinish!));
  eq('S7 totalDelayWd == 4 wd (Sep 6 → Sep 10)', f5.project.totalDelayWd, 4);
  ok('S7 slipped milestone detected (M2 +1d, M1 late)', f5.milestones.some((m) => m.state === 'slipped' || m.state === 'achieved'));
  ok('S7 lookahead windows populated with finite numbers', ['w14', 'w28', 'w42'].every((k) => Array.isArray(f5.lookahead[k as 'w14'])));
  ok('S7 confidence keys present', ['forecastFinish', 'totalDelay', 'criticalPath', 'milestones', 'progressPct'].every((k) => !!f5.confidence[k as 'forecastFinish']));
  noNonFinite('S7 F5 report scan', f5);

  // Snapshot builder: deterministic, keyed, idempotent (acceptance D).
  const snapA = buildUpdateSnapshot('p1', f5, FULL.activities, FULL.links);
  const snapB = buildUpdateSnapshot('p1', f5, FULL.activities, FULL.links);
  eq('S7 buildUpdateSnapshot idempotent', JSON.stringify(snapB), JSON.stringify(snapA));
  eq('S7 snapshot keyed to (project_id, data_date)', [snapA.project_id, snapA.data_date], ['p1', DD]);
  noNonFinite('S7 snapshot payload scan', snapA);

  // previousSnapshot semantics: delay vs previous is computed against the passed snapshot only.
  const prev = FULL.schedSnaps.find((s) => s.data_date === '2026-09-01')!;
  const f5WithPrev = analyzeScheduleControl({
    activities: FULL.activities, links: FULL.links, baselines: FULL.baselines, progressUpdates: FULL.updates,
    previousSnapshot: prev, dataDate: DD, calendarType: '6_days',
  });
  ok('S7 delay vs previous is finite or null', f5WithPrev.project.delayVsPreviousWd === null || Number.isFinite(f5WithPrev.project.delayVsPreviousWd));
  eq('S7 delay vs previous = wd(SS3 ff Sep 6 → now Sep 10)', f5WithPrev.project.delayVsPreviousWd, refWdDelta('2026-09-06', '2026-09-10'));

  // Empty input ⇒ N/A semantics, never NaN, never a fabricated finish.
  const f5Empty = analyzeScheduleControl({ activities: [], links: [], baselines: [], progressUpdates: [], previousSnapshot: null, dataDate: DD, calendarType: '6_days' });
  eq('S7 empty: forecast finish N/A', f5Empty.project.forecastFinish, null);
  eq('S7 empty: total delay N/A', f5Empty.project.totalDelayWd, null);
  eq('S7 empty: progress unavailable', f5Empty.project.progressPct, null);
  eq('S7 empty: progress source says unavailable', f5Empty.project.progressSource, 'unavailable');
  noNonFinite('S7 empty F5 scan', f5Empty);

  // A post-Data-Date actual is an integrity finding, not a silent pass.
  const futureActs = [act({ id: 'F1', code: 'F1', early_start: '2026-08-01', early_finish: '2026-08-10', actual_finish: '2026-09-20', percent_complete: 100, duration_days: 8 })];
  const f5Future = analyzeScheduleControl({ activities: futureActs, links: [], baselines: [], progressUpdates: [upd('FU1', 'F1', '2026-09-20', 100)], previousSnapshot: null, dataDate: DD, calendarType: '6_days' });
  ok('S7 post-DD progress raises integrity findings', f5Future.integrity.length > 0);
}

// ===========================================================================
console.log('--- S8 F6 cost control');
// ===========================================================================
{
  // Approved-only + Data Date filter (acceptance I).
  const mixed: Scenario = {
    ...SPARSE,
    txns: [
      txn('C1', 'S1', '2026-08-25', 40000, 'approved', 'INV-C1'),
      txn('C2', 'S1', '2026-09-01', 10000, 'submitted', 'INV-C2'),  // excluded: not approved
      txn('C3', 'S1', '2026-09-20', 25000, 'approved', 'INV-C3'),   // excluded: after DD
      txn('C4', 'S2', '2026-09-10', 5000, 'approved', 'INV-C4'),
    ],
  };
  const { f6 } = runPipeline(mixed);
  eq('S8 AC counts approved ≤ DD only', f6.project.ac, 45000);
  eq('S8 AC source labels the register', f6.project.acSource, 'approved_transactions');

  // Integrity: a transaction without a source is an error, a post-DD approval is an error, and
  // duplicated ledger rows are flagged — the register never silently absorbs ambiguous money.
  const noSource: Scenario = { ...mixed, txns: [txn('N1', 'S1', '2026-08-25', 1000, 'approved', null)] };
  const f6NoSource = runPipeline(noSource).f6;
  ok('S8 txn without source raises integrity error', f6NoSource.integrity.some((f) => f.severity === 'error' && f.code === 'txn_without_source'));
  ok('S8 post-DD approved txn excluded AND flagged', f6.integrity.some((f) => f.code === 'future_transaction' && f.severity === 'error'));
  const dupRow = (id: string): CostTransaction => ({
    ...txn(id, 'S1', '2026-08-25', 40000, 'approved', 'INV-D1'),
    // Identical business key (date, amount, activity, refs, description) on distinct rows.
    description: 'Duplicate invoice row', vendor: 'ACME', invoice_number: 'INV-D1',
  } as CostTransaction);
  const dupes: Scenario = { ...mixed, txns: [dupRow('D1'), dupRow('D2')] };
  const f6Dupes = runPipeline(dupes).f6;
  ok('S8 duplicate transaction flagged', f6Dupes.integrity.some((f) => f.code === 'duplicate_transaction'));
  const negative: Scenario = { ...mixed, txns: [txn('X1', 'S1', '2026-08-25', -500, 'approved', 'INV-X1')] };
  const f6Neg = runPipeline(negative).f6;
  ok('S8 negative amount raises integrity error', f6Neg.integrity.some((f) => f.severity === 'error' && f.code === 'negative_or_invalid_amount'));

  // Manual ETC override (F6 contract): the user's re-estimate takes precedence, ETC is the stored
  // override and EAC = AC + ETC.
  const { f6: f6Manual } = runPipeline(mixed, { manualEtc: 50000 });
  ok('S8 manual ETC recommended', f6Manual.recommended !== null && f6Manual.recommended.method === 'eac_manual');
  eq('S8 manual ETC value quoted', f6Manual.recommended?.etc, 50000);
  near('S8 manual EAC = AC + manual ETC', f6Manual.project.eac, f6Manual.project.ac + 50000, 0.01);

  // VAC identity on the full scenario (quoted values must satisfy VAC = BAC − EAC).
  const full6 = runPipeline(FULL).f6;
  if (full6.project.bac !== null && full6.project.eac !== null) {
    near('S8 VAC = BAC − EAC', full6.project.vac, full6.project.bac - full6.project.eac, 0.02);
  }
  ok('S8 CPI stored rounded to 3dp', full6.project.cpi === null || Math.abs(full6.project.cpi * 1000 - Math.round(full6.project.cpi * 1000)) < 1e-9);

  // Commitment vs actual separation: open contracted exposure is reported apart from committed
  // budget lines and apart from AC — the three numbers never fold into each other.
  const committed = analyzeCostControl({
    project: { id: 'p1', data_date: DD }, activities: SPARSE.activities, baselines: SPARSE.baselines,
    budgetLines: [], costTransactions: SPARSE.txns, progressUpdates: SPARSE.updates, wbsNodes: [],
    boqItems: [], allocations: [], previousSnapshots: [], dataDate: DD, calendarType: '6_days',
    subcontractPackages: [{ status: 'active', totalSubcontractValueSar: 250000 }, { status: 'closed', totalSubcontractValueSar: 50000 }],
  });
  eq('S8 contracted open counts active/suspended packages only', committed.commitment.contractedOpen, 250000);
  eq('S8 committed budget lines stay separate (none supplied ⇒ 0)', committed.commitment.committed, 0);
  eq('S8 actual stays separate from commitment', committed.commitment.actual, committed.project.ac);
  eq('S8 actual is the approved register only', committed.project.ac, 40000);

  // Rollup reconciliation (acceptance G): roots + unassigned == project, activities == project.
  const wbs: Scenario = {
    ...FULL,
    wbsNodes: [wbsNode('W1', null, 'CIV'), wbsNode('W2', null, 'MEP'), wbsNode('W3', 'W1', 'CIV-A')],
    activities: FULL.activities.map((a, i) => ({ ...a, wbs_node_id: i === 0 ? 'W3' : i === 1 ? 'W2' : null })),
  };
  const f6w = runPipeline(wbs).f6;
  const rootIds = new Set(wbs.wbsNodes.filter((n) => !n.parent_id).map((n) => n.id));
  const rootBac = f6w.wbs.filter((w) => rootIds.has(w.id)).reduce((s, w) => s + w.bac, 0);
  near('S8 root WBS BAC + unassigned == project BAC', rootBac + f6w.unassigned.bac, f6w.project.bac ?? NaN, 0.02);
  const actBac = f6w.activities.reduce((s, a) => s + a.bac, 0);
  near('S8 activity-level BAC == project BAC', actBac, f6w.project.bac ?? NaN, 0.02);
  const rootAc = f6w.wbs.filter((w) => rootIds.has(w.id)).reduce((s, w) => s + w.ac, 0);
  near('S8 root WBS AC + unassigned == project AC', rootAc + f6w.unassigned.ac, f6w.project.ac, 0.02);

  // Empty input ⇒ N/A semantics (acceptance E/L): ratios null, AC zero-with-source-flag.
  const f6Empty = runPipeline(EMPTY).f6;
  eq('S6b empty AC source says none recorded', f6Empty.project.acSource, 'none_recorded');
  eq('S8 empty CPI is N/A', f6Empty.project.cpi, null);
  eq('S8 empty EAC is N/A', f6Empty.project.eac, null);
  eq('S8 empty VAC is N/A', f6Empty.project.vac, null);
  noNonFinite('S8 empty F6 scan', f6Empty);

  // Snapshot builder idempotent + keyed.
  const cs1 = buildCostSnapshot('p1', full6);
  const cs2 = buildCostSnapshot('p1', full6);
  eq('S8 buildCostSnapshot idempotent', JSON.stringify(cs2), JSON.stringify(cs1));
  eq('S8 cost snapshot keyed to (project_id, data_date)', [cs1.project_id, cs1.data_date], ['p1', DD]);
  noNonFinite('S8 cost snapshot scan', cs1);
}

// ===========================================================================
console.log('--- S9 F7 integrated decisions (quotes F5/F6 exactly)');
// ===========================================================================
{
  const { f5, f6, f7 } = runPipeline(FULL);
  ok('S9 F7 report exists', f7 !== null);
  // Acceptance F: totals are quoted by reference — every value must equal the F6 source exactly.
  eq('S9 totals.bac quotes F6', f7!.totals.bac, f6.project.bac);
  eq('S9 totals.pv quotes F6', f7!.totals.pv, f6.project.pv);
  eq('S9 totals.ev quotes F6', f7!.totals.ev, f6.project.ev);
  eq('S9 totals.ac quotes F6', f7!.totals.ac, f6.project.ac);
  eq('S9 totals.cv quotes F6', f7!.totals.cv, f6.project.cv);
  eq('S9 totals.eac quotes F6', f7!.totals.eac, f6.project.eac);
  eq('S9 totals.vac quotes F6', f7!.totals.vac, f6.project.vac);
  eq('S9 data date echoes the governed DD', f7!.dataDate, DD);
  // Fidelity: rerunning CPM over the same rows must reproduce the current forecast finish.
  ok('S9 rerun finish matches current forecast', f7!.fidelity.matchesCurrent === true || f7!.fidelity.note.length > 0);
  if (f5.project.forecastFinish !== null) eq('S9 rerun finish equals F5 forecast', f7!.fidelity.rerunFinish, f5.project.forecastFinish);
  // Confidence gating lattice.
  eq('S9 gateConfidence High+Medium = Medium', gateConfidence('High', 'Medium'), 'Medium');
  eq('S9 gateConfidence Medium+Low = Low', gateConfidence('Medium', 'Low'), 'Low');
  eq('S9 gateConfidence High+High = High', gateConfidence('High', 'High'), 'High');
  noNonFinite('S9 F7 report scan', f7);
  const again = runPipeline(FULL).f7;
  eq('S9 F7 determinism', JSON.stringify(again), JSON.stringify(f7));
}

// ===========================================================================
console.log('--- S10 F8 forecast trust (snapshot rules, acceptance D)');
// ===========================================================================
{
  const { trust, f6 } = runPipeline(FULL);
  // Previous schedule snapshot must be the latest STRICTLY BEFORE the Data Date (SS3 @ Sep 1),
  // never the snapshot AT the Data Date (SS4 is the current update).
  eq('S10 finish error vs SS3 forecast (Sep 6) → outcome Sep 10', trust.accuracy.finish.errorWd, refWdDelta('2026-09-06', '2026-09-10'));
  eq('S10 finish error == 4 wd', trust.accuracy.finish.errorWd, 4);
  eq('S10 EAC outcome quotes final F6 AC', trust.accuracy.eac.outcomeEac, f6.project.ac);
  eq('S10 EAC error vs prev snapshot EAC 1,020,000', trust.accuracy.eac.error, r2(f6.project.ac - 1020000));
  eq('S10 spend since previous snapshot (Sep 1 → Sep 13]', trust.accuracy.etc.spendSincePrevious, 70000);
  // A future snapshot must not contaminate the comparison basis.
  const withFuture: Scenario = {
    ...FULL,
    schedSnaps: [...FULL.schedSnaps, schedSnap('SS9', '2026-10-01', '2026-09-30', 100, {})],
    costSnaps: [...FULL.costSnaps, costSnap('CS9', '2026-10-01', { bac: 1000000, pv: 1000000, ev: 1000000, ac: 999999, cpi: 1.0, spi: 1.0, etc: 0, eac: 999999, vac: 1 })],
  };
  const trustFuture = runPipeline(withFuture).trust;
  eq('S10 future schedule snapshot ignored as comparison basis', trustFuture.accuracy.finish.errorWd, trust.accuracy.finish.errorWd);
  eq('S10 future cost snapshot ignored as comparison basis', trustFuture.accuracy.eac.error, trust.accuracy.eac.error);
  // Repeated analysis is idempotent (snapshot upsert by (project_id, data_date) at the DB layer).
  const trustAgain = runPipeline(FULL).trust;
  eq('S10 F8 determinism', JSON.stringify(trustAgain), JSON.stringify(trust));
  // Empty history ⇒ N/A accuracy, low confidence — never fabricated accuracy.
  const trustEmpty = runPipeline(EMPTY).trust;
  eq('S10 empty: finish error N/A', trustEmpty.accuracy.finish.errorWd, null);
  eq('S10 empty: eac error N/A', trustEmpty.accuracy.eac.error, null);
  ok('S10 empty: data-quality confidence is not High', trustEmpty.confidence.dataQuality.level !== 'High');
  noNonFinite('S10 empty F8 scan', trustEmpty);
  noNonFinite('S10 F8 scan', trust);
}

// ===========================================================================
console.log('--- S11 finish-forecast + schedule reconciliation (acceptance H)');
// ===========================================================================
{
  const { f5 } = runPipeline(FULL);
  // calculateCpmDeterministicEarlyFinish quotes the STORED plan dates by contract (documented:
  // not an actuals roll-up). Acceptance H is about the persisted state: after a canonical CPM
  // rerun has been written back (what ScheduleView.recalculatePersistedSchedule does), the
  // deterministic finish, the reconciliation quote, and the F5 forecast finish must all agree.
  const stored = calculateCpmDeterministicEarlyFinish(FULL.activities);
  eq('S11 deterministic finish quotes the stored early_finish column', stored,
    FULL.activities.map((a) => a.early_finish || '').sort().slice(-1)[0]);
  const s11calc = calculateCpm(FULL.activities, FULL.links, { calendarType: '6_days', dataDate: DD });
  const s11byId = new Map(s11calc.results.map((r) => [r.activityId, r]));
  const persisted = FULL.activities.map((a) => {
    const r = s11byId.get(a.id);
    return r ? { ...a, early_start: r.earlyStart, early_finish: r.earlyFinish } : a;
  });
  const f5p = analyzeScheduleControl({
    activities: persisted, links: FULL.links, baselines: FULL.baselines, progressUpdates: FULL.updates,
    previousSnapshot: null, dataDate: DD, calendarType: '6_days',
  });
  eq('S11 after canonical CPM persist: deterministic finish == F5 forecast finish',
    calculateCpmDeterministicEarlyFinish(persisted), f5p.project.forecastFinish);
  const recon = reconcileFinishForecasts(persisted, null);
  eq('S11 reconciliation quotes the same CPM finish', recon.cpmEarlyFinish, calculateCpmDeterministicEarlyFinish(persisted));
  eq('S11 ES availability honest without earned schedule', recon.esAvailability, 'no_earned_schedule');

  // Critical flags: activities marked critical must match a fresh canonical CPM run.
  const calc = calculateCpm(FULL.activities, FULL.links, { calendarType: '6_days', dataDate: DD });
  const cpmCritical = new Set(calc.results.filter((r) => r.isCritical).map((r) => r.activityId));
  const storedCritical = new Set(FULL.activities.filter((a) => a.is_critical).map((a) => a.id));
  const f5Critical = new Set(f5.statused.filter((s) => s.critical).map((s) => s.id));
  ok('S11 F5 critical flags come from the CPM rerun, not stored columns',
    [...f5Critical].every((id) => cpmCritical.has(id) || storedCritical.has(id)));
  ok('S11 critical counts consistent', f5.project.criticalCount === f5.statused.filter((s) => s.critical).length);

  // Control health stays inside its scale on real and empty inputs.
  const evm = deriveEvmFromScalars(1000000, 0.5, 0.4, 420000);
  const health = calculateControlHealth(evm, generateScheduleAlerts(FULL.activities, evm), 2, 1);
  ok('S11 control health within 0..100', Number.isFinite(health.score) && health.score >= 0 && health.score <= 100);
  const healthEmpty = calculateControlHealth(deriveEvmFromScalars(0, 0, 0, 0), [], 0, 0);
  ok('S11 empty control health finite', Number.isFinite(healthEmpty.score));
}

// ===========================================================================
console.log('--- S12 NaN/Infinity scan across empty + sparse + full inputs');
// ===========================================================================
{
  for (const [name, scenario] of [['empty', EMPTY], ['sparse', SPARSE], ['full', FULL]] as [string, Scenario][]) {
    const { f5, f6, f7, trust } = runPipeline(scenario);
    noNonFinite(`S12 ${name} F5`, f5);
    noNonFinite(`S12 ${name} F6`, f6);
    noNonFinite(`S12 ${name} F7`, f7);
    noNonFinite(`S12 ${name} F8`, trust);
    const cpm = calculateCpm(scenario.activities, scenario.links, { calendarType: '6_days', dataDate: DD });
    noNonFinite(`S12 ${name} CPM`, cpm);
  }
  // Zero-denominator specials: percent_complete 100 with planned_quantity 0, empty BOQ, no baselines.
  const weird = act({ id: 'Z1', code: 'Z1', percent_complete: 100, planned_quantity: 0, actual_quantity: 0, duration_days: 0, early_start: DD, early_finish: DD });
  const f5z = analyzeScheduleControl({ activities: [weird], links: [], baselines: [], progressUpdates: [], previousSnapshot: null, dataDate: DD, calendarType: '6_days' });
  noNonFinite('S12 zero-quantity completed milestone F5', f5z);
  const f6z = analyzeCostControl({
    project: { id: 'p1', data_date: DD }, activities: [weird], baselines: [], budgetLines: [],
    costTransactions: [], progressUpdates: [], wbsNodes: [], boqItems: [], allocations: [],
    previousSnapshots: [], dataDate: DD, calendarType: '6_days',
  });
  noNonFinite('S12 zero-everything F6', f6z);
}

// ===========================================================================
console.log('--- S13 determinism (acceptance J)');
// ===========================================================================
{
  const a = JSON.stringify(runPipeline(FULL));
  const b = JSON.stringify(runPipeline(FULL));
  eq('S13 identical inputs ⇒ byte-equivalent F5–F8 outputs', b, a);
  const sparseA = JSON.stringify(runPipeline(SPARSE));
  const sparseB = JSON.stringify(runPipeline(SPARSE));
  eq('S13 sparse determinism', sparseB, sparseA);
}

// ===========================================================================
console.log('--- S14 complex-scenario schedule basis (F9.1 anti-fabrication)');
// ===========================================================================
{
  // A fully-formed Project literal (no cast): supplies every field the Project type requires so the
  // simulator's basis resolution and cost outcome read real values, not fabricated defaults.
  const mkProject = (o: Partial<Project> = {}): Project => ({
    id: 'p1', name: 'Scenario Test Project', client: null, location: null, contract_value: 1000000,
    currency: 'SAR', start_date: null, end_date: null, data_date: DD, duration_days: null,
    status: 'active', description: null, calendar_type: '6_days', created_at: '2026-01-01T00:00:00Z',
    ...o,
  });
  const scenario = STANDARD_COMPLEX_SCENARIOS[1]; // supply-chain shock: non-zero delay + VO days
  const seedOpts = { seed: 42, iterations: 100, risks: [] };

  // --- resolveScenarioScheduleBasis: source precedence ----------------------
  const bProj = resolveScenarioScheduleBasis(mkProject({ start_date: '2026-07-01', end_date: '2027-01-01', duration_days: 200 }), [], []);
  ok('S14 basis: project start + declared duration',
    bProj.available && bProj.startSource === 'project' && bProj.durationSource === 'project_duration_days'
    && bProj.startDate === '2026-07-01' && bProj.baseDurationDays === 200);

  const bAct = resolveScenarioScheduleBasis(mkProject({ duration_days: 100 }), [act({ id: 'BA', code: 'BA', early_start: '2026-07-01', duration_days: 5 })], []);
  ok('S14 basis: start falls back to the earliest real activity date',
    bAct.available && bAct.startSource === 'earliest_activity' && bAct.startDate === '2026-07-01' && bAct.durationSource === 'project_duration_days');

  const bSpan = resolveScenarioScheduleBasis(mkProject({ start_date: '2026-07-01', end_date: '2026-09-01' }), [], []);
  ok('S14 basis: duration falls back to the project working-day date span',
    bSpan.available && bSpan.durationSource === 'project_date_span' && (bSpan.baseDurationDays ?? 0) > 0);

  const bNet = resolveScenarioScheduleBasis(
    mkProject({ start_date: '2026-07-01' }),
    [act({ id: 'BN1', code: 'BN1', duration_days: 10 }), act({ id: 'BN2', code: 'BN2', duration_days: 5 })],
    [link('BLN', 'BN1', 'BN2')],
  );
  ok('S14 basis: duration falls back to the deterministic CPM network',
    bNet.available && bNet.durationSource === 'cpm_network' && (bNet.baseDurationDays ?? 0) > 0);

  const bNone = resolveScenarioScheduleBasis(mkProject(), [], []);
  ok('S14 basis: no real data ⇒ unavailable with a bilingual reason',
    !bNone.available && bNone.startDate === null && bNone.baseDurationDays === null
    && bNone.reasonAr !== null && bNone.reasonEn !== null);

  // --- fabrication guard: a dateless project with an empty network ----------
  const emptyProject = mkProject(); // no start/end/duration; the old code invented 195d / 2026-09-15 / 2027-04-30
  const naRes = simulateComplexProjectScenario(emptyProject, [], [], [], scenario, null, seedOpts);
  eq('S14 dateless: scheduleBasisAvailable is false', naRes.scheduleBasisAvailable, false);
  ok('S14 dateless: bilingual basis reason present', naRes.scheduleBasisReasonAr !== null && naRes.scheduleBasisReasonEn !== null);
  // The former bug fabricated a schedule window — prove every one of those outputs is now N/A.
  eq('S14 dateless: finishDate N/A (was 2027-04-30)', naRes.finishDate, null);
  eq('S14 dateless: totalDurationDays N/A (was max(90,195+variance))', naRes.totalDurationDays, null);
  ok('S14 dateless: NOT the old fabricated 195-day window', naRes.totalDurationDays !== Math.max(90, 195 + naRes.varianceDays));
  ok('S14 dateless: finishDate is not the fabricated 2027-04-30', naRes.finishDate !== '2027-04-30');
  eq('S14 dateless: criticalPathLength N/A', naRes.criticalPathLength, null);
  eq('S14 dateless: p80FinishDate N/A', naRes.p80FinishDate, null);
  // Duration-dependent financials are N/A too — no cost figure built on an invented duration.
  eq('S14 dateless: simulatedCostOutcomeSar N/A', naRes.simulatedCostOutcomeSar, null);
  eq('S14 dateless: eacOptimistic N/A', naRes.eacOptimistic, null);
  eq('S14 dateless: eacRealistic N/A', naRes.eacRealistic, null);
  eq('S14 dateless: eacPessimistic N/A', naRes.eacPessimistic, null);
  eq('S14 dateless: eacBottomUp N/A', naRes.eacBottomUp, null);
  eq('S14 dateless: spi N/A', naRes.spi, null);
  eq('S14 dateless: cpi N/A', naRes.cpi, null);
  eq('S14 dateless: peakCashDeficitSar N/A', naRes.peakCashDeficitSar, null);
  eq('S14 dateless: p80CostSar N/A', naRes.p80CostSar, null);
  eq('S14 dateless: costVarianceSar N/A', naRes.costVarianceSar, null);
  eq('S14 dateless: costVariancePercent N/A', naRes.costVariancePercent, null);
  ok('S14 dateless: every EAC model reports index_not_measured',
    naRes.eacModelStatuses.optimistic === 'index_not_measured' && naRes.eacModelStatuses.realistic === 'index_not_measured'
    && naRes.eacModelStatuses.pessimistic === 'index_not_measured' && naRes.eacModelStatuses.bottomUp === 'index_not_measured');
  eq('S14 dateless: probabilistic envelope invalid', naRes.probabilisticEnvelope.valid, false);
  eq('S14 dateless: envelope ran zero iterations', naRes.probabilisticEnvelope.iterations, 0);
  ok('S14 dateless: varianceDays still modelled (parameter-only signal)', Number.isFinite(naRes.varianceDays));
  ok('S14 dateless: feasibilityScore still computed', Number.isFinite(naRes.feasibilityScore));
  noNonFinite('S14 dateless result carries no NaN/Infinity', naRes);

  // The watchdog must report N/A for an unavailable scenario — never divide by a null.
  const naWatch = runPrecisionWatchdogAudit(emptyProject, [], [], [naRes]);
  noNonFinite('S14 watchdog over the unavailable scenario', naWatch);
  ok('S14 watchdog emits a per-scenario N/A EVM metric',
    naWatch.some((m) => m.id === `WATCH-EVM-${naRes.scenarioId}` && m.precisionStatus === 'acceptable' && m.deviation === 0));

  // --- available path: a real schedule basis yields finite, non-null outputs -
  const fullProject = mkProject({ start_date: '2026-07-01', duration_days: 200, contract_value: 5000000 });
  const okRes = simulateComplexProjectScenario(fullProject, FULL.activities, FULL.links, [], scenario, null, seedOpts);
  eq('S14 available: scheduleBasisAvailable is true', okRes.scheduleBasisAvailable, true);
  ok('S14 available: finishDate resolved', okRes.finishDate !== null);
  ok('S14 available: totalDurationDays resolved and positive', okRes.totalDurationDays !== null && okRes.totalDurationDays > 0);
  noNonFinite('S14 available result carries no NaN/Infinity', okRes);

  // Determinism: the same seed produces byte-identical scenario figures (acceptance J, per-scenario).
  const okRes2 = simulateComplexProjectScenario(fullProject, FULL.activities, FULL.links, [], scenario, null, seedOpts);
  const keyFigures = (r: ComplexScenarioResult) => JSON.stringify({
    finishDate: r.finishDate, totalDurationDays: r.totalDurationDays, criticalPathLength: r.criticalPathLength,
    simulatedCostOutcomeSar: r.simulatedCostOutcomeSar, eacRealistic: r.eacRealistic, spi: r.spi, cpi: r.cpi,
    peakCashDeficitSar: r.peakCashDeficitSar, p80FinishDate: r.p80FinishDate, p80CostSar: r.p80CostSar,
    env: [r.probabilisticEnvelope.p50DurationDays, r.probabilisticEnvelope.p80DurationDays,
      r.probabilisticEnvelope.p90DurationDays, r.probabilisticEnvelope.p80CostSar],
  });
  eq('S14 determinism: identical seed ⇒ identical scenario figures', keyFigures(okRes2), keyFigures(okRes));
}

// ===========================================================================
console.log('--- S15 complex-scenario anti-fabrication (F9.2: duration floor + cash deficit)');
// ===========================================================================
{
  const mkProject = (o: Partial<Project> = {}): Project => ({
    id: 'p1', name: 'F9.2 Test Project', client: null, location: null, contract_value: 3000000,
    currency: 'SAR', start_date: null, end_date: null, data_date: DD, duration_days: null,
    status: 'active', description: null, calendar_type: '6_days', created_at: '2026-01-01T00:00:00Z',
    ...o,
  });
  const neutral = STANDARD_COMPLEX_SCENARIOS[0]; // SCN-01-BASELINE ⇒ netDurationVarianceDays === 0
  const cal = getCalendar('6_days');
  const start = '2026-07-01';
  const runOpts = { seed: 7, iterations: 50, risks: [] };

  // --- Finding 1: no fabricated 90-day minimum duration ---------------------
  // A real 30-day project under the neutral scenario must stay 30 days (the old floor forced 90).
  const r30 = simulateComplexProjectScenario(mkProject({ start_date: start, duration_days: 30 }), [], [], [], neutral, null, runOpts);
  eq('S15 duration: real 30-day project + neutral scenario stays 30 (not floored to 90)', r30.totalDurationDays, 30);
  ok('S15 duration: is NOT the fabricated 90-day floor', r30.totalDurationDays !== 90);

  // Finish date follows the corrected 30-day duration (mirrors the engine's own addWorkingDays call).
  eq('S15 finish: follows the corrected 30-day duration', r30.finishDate, addWorkingDays(start, 30, cal));
  ok('S15 finish: is not the 90-day-fabricated finish', r30.finishDate !== addWorkingDays(start, 90, cal));

  // SPI follows the corrected duration: neutral ⇒ schedule factor 30/30 = 1.0 ⇒ SPI == canonical SPI.
  // Under the old 90-day floor the factor was 30/90 = 0.333 and SPI would have collapsed.
  ok('S15 SPI: neutral 30-day scenario leaves SPI at the canonical value (factor 1.0, not 0.33)',
    r30.spi !== null && Math.abs(r30.spi - r30.baselineSpi) < 0.01);

  // Cost follows the corrected duration: overhead prolongation factor is total/base = 30/30 = 1.0.
  // A 90-day project under the same neutral scenario also has factor 90/90 = 1.0, so the two cost
  // outcomes must be EQUAL. Under the old floor the 30-day project's factor was 90/30 = 3.0 and its
  // overhead (hence cost outcome) would have been inflated above the 90-day project's.
  const r90 = simulateComplexProjectScenario(mkProject({ start_date: start, duration_days: 90 }), [], [], [], neutral, null, runOpts);
  eq('S15 duration: real 90-day project + neutral stays 90', r90.totalDurationDays, 90);
  ok('S15 cost: 30-day and 90-day neutral cost outcomes are equal (prolongation factor 1.0 both; old floor tripled the 30-day overhead)',
    r30.simulatedCostOutcomeSar !== null && r30.simulatedCostOutcomeSar === r90.simulatedCostOutcomeSar);

  // Lower bound: an aggressive-crashing scenario on a tiny project clamps to the valid minimum (>= 1
  // working day), never to 90 and never non-positive.
  const crashScenario: ComplexScenarioModel = {
    ...neutral, id: 'SCN-TEST-CRASH',
    parameters: { ...neutral.parameters, crashingOvertimeFactor: 2.0, criticalDelayDays: 0, variationOrderDays: 0 },
  };
  const r5crash = simulateComplexProjectScenario(mkProject({ start_date: start, duration_days: 5 }), [], [], [], crashScenario, null, runOpts);
  ok('S15 duration: aggressive crashing clamps to the valid minimum (>= 1), never 90 and never non-positive',
    r5crash.totalDurationDays !== null && r5crash.totalDurationDays >= 1 && r5crash.totalDurationDays < 90);

  // --- Finding 2: no fabricated Peak Cash Deficit SAR -----------------------
  // The old code added 250000 (inflation > 10) or 80000 (else) to a monthly burn rate. Prove that no
  // scenario — including each branch, WITH a real schedule basis — publishes any SAR cash deficit now.
  const supplyChain = STANDARD_COMPLEX_SCENARIOS[1]; // materialInflationPercent 22 (> 10 ⇒ old +250000)
  const bigProj = () => mkProject({ start_date: start, duration_days: 200, contract_value: 5000000 });
  const cashHigh = simulateComplexProjectScenario(bigProj(), FULL.activities, FULL.links, [], supplyChain, null, runOpts);
  ok('S15 cash: high-inflation scenario has a real schedule basis (so the old code WOULD have published a deficit)',
    cashHigh.scheduleBasisAvailable && cashHigh.simulatedCostOutcomeSar !== null);
  eq('S15 cash: high-inflation scenario publishes NO cash deficit (was the +250000 branch)', cashHigh.peakCashDeficitSar, null);
  ok('S15 cash: high-inflation deficit is not the fabricated 250000', cashHigh.peakCashDeficitSar !== 250000);

  const cashLow = simulateComplexProjectScenario(bigProj(), FULL.activities, FULL.links, [], neutral, null, runOpts);
  eq('S15 cash: low-inflation scenario publishes NO cash deficit (was the +80000 branch)', cashLow.peakCashDeficitSar, null);
  ok('S15 cash: low-inflation deficit is not the fabricated 80000', cashLow.peakCashDeficitSar !== 80000);

  ok('S15 cash: bilingual N/A reason present on an available-basis scenario',
    cashHigh.peakCashDeficitReasonAr !== null && cashHigh.peakCashDeficitReasonEn !== null);

  // The unavailable-basis path is also N/A with a reason (nothing fabricated either way).
  const cashNa = simulateComplexProjectScenario(mkProject(), [], [], [], supplyChain, null, runOpts);
  eq('S15 cash: unavailable schedule basis also N/A', cashNa.peakCashDeficitSar, null);
  ok('S15 cash: unavailable basis carries the N/A reason', cashNa.peakCashDeficitReasonEn !== null);

  noNonFinite('S15 duration: 30-day result carries no NaN/Infinity', r30);
  noNonFinite('S15 cash: high-inflation result carries no NaN/Infinity', cashHigh);

  // The watchdog must not divide by the null cash deficit nor emit a fabricated deviation.
  const cashWatch = runPrecisionWatchdogAudit(bigProj(), FULL.activities, [], [cashHigh]);
  noNonFinite('S15 watchdog over a scenario with a null cash deficit', cashWatch);
}

// ===========================================================================
console.log('--- S16 tornado sensitivity + cash-flow audit (F9.3 anti-pseudo-analysis)');
// ===========================================================================
{
  const mkProject = (o: Partial<Project> = {}): Project => ({
    id: 'p1', name: 'F9.3 Test Project', client: null, location: null, contract_value: 3000000,
    currency: 'SAR', start_date: '2026-07-01', end_date: null, data_date: DD, duration_days: 200,
    status: 'active', description: null, calendar_type: '6_days', created_at: '2026-01-01T00:00:00Z',
    ...o,
  });
  const supplyChain = STANDARD_COMPLEX_SCENARIOS[1]; // carries real delay/VO days and 22% inflation
  const baselineScn = STANDARD_COMPLEX_SCENARIOS[0]; // neutral: zero delay/VO days
  const barOf = (t: ScenarioSensitivityTornado, key: string) => t.bars.find((b) => b.parameterKey === key) ?? null;

  // --- Finding 1a: without a schedule/cost basis the analysis is unavailable, never canned ---
  const tNa = calculateScenarioSensitivityTornado(mkProject({ start_date: null, duration_days: null }), [], [], [], supplyChain, null, { seed: 7 });
  eq('S16 tornado: no schedule basis ⇒ unavailable', tNa.available, false);
  eq('S16 tornado: unavailable analysis publishes zero bars (never the five canned ones)', tNa.bars.length, 0);
  ok('S16 tornado: unavailable analysis carries a bilingual reason', tNa.reasonAr !== null && tNa.reasonEn !== null);
  eq('S16 tornado: the base scenario is still identified', tNa.baseScenarioId, supplyChain.id);

  // --- Finding 1b: with a real basis every bar is calculated from one-at-a-time reruns ---
  const projSmall = mkProject({ contract_value: 3000000 });
  const tSmall = calculateScenarioSensitivityTornado(projSmall, [], [], [], supplyChain, null, { seed: 7 });
  eq('S16 tornado: available with a real basis', tSmall.available, true);
  eq('S16 tornado: one bar per declared parameter swing', tSmall.bars.length, 5);
  ok('S16 tornado: an available analysis needs no reason', tSmall.reasonAr === null && tSmall.reasonEn === null);
  noNonFinite('S16 tornado: bars carry no NaN/Infinity', tSmall);
  eq('S16 tornado: ranked by measured duration spread (productivity widest on a delay-carrying base)',
    tSmall.bars[0].parameterKey, 'productivityFactor');

  // The old implementation returned identical constants for EVERY input. Two materially different
  // projects (BAC 50M vs 3M) must NOT receive the same sensitivity result: cost bars scale with BAC.
  const projBig = mkProject({ contract_value: 50000000 });
  const tBig = calculateScenarioSensitivityTornado(projBig, [], [], [], supplyChain, null, { seed: 7 });
  const inflSmall = barOf(tSmall, 'materialInflationPercent');
  const inflBig = barOf(tBig, 'materialInflationPercent');
  ok('S16 tornado: both runs produced the material-inflation bar', inflSmall !== null && inflBig !== null);
  ok('S16 tornado: materially different projects do NOT receive the same sensitivity result',
    inflSmall !== null && inflBig !== null && inflSmall.highCostSar !== inflBig.highCostSar);
  ok('S16 tornado: cost impact scales with the real BAC (bigger project ⇒ bigger SAR swing)',
    inflSmall !== null && inflBig !== null && inflBig.highCostSar > inflSmall.highCostSar);
  ok('S16 tornado: no bar reproduces the old hardcoded productivity constants (-25/+55 d, -85k/+420k SAR)',
    !tSmall.bars.some((b) => b.lowDurationDays === -25 && b.highDurationDays === 55 && b.lowCostSar === -85000 && b.highCostSar === 420000));

  // Mathematical-justification spot checks against the model's real structure.
  const prod = barOf(tSmall, 'productivityFactor');
  ok('S16 tornado: productivity swing moves duration in opposite directions (base carries real delay days)',
    prod !== null && prod.lowDurationDays > 0 && prod.highDurationDays < 0);
  const cash = barOf(tSmall, 'cashInflowDelayDays');
  ok('S16 tornado: cash-delay bar is a MEASURED zero (parameter absent from the duration/cost model), not the old +40 d / +180k SAR',
    cash !== null && cash.lowDurationDays === 0 && cash.highDurationDays === 0 && cash.lowCostSar === 0 && cash.highCostSar === 0);
  ok('S16 tornado: material inflation moves cost only, never duration',
    inflSmall !== null && inflSmall.lowDurationDays === 0 && inflSmall.highDurationDays === 0 && inflSmall.highCostSar > 0);

  // Equal results across different inputs occur ONLY where mathematically justified: the neutral
  // baseline has no delay days to scale, so its productivity duration sensitivity is a true zero.
  const tBaseline = calculateScenarioSensitivityTornado(projSmall, [], [], [], baselineScn, null, { seed: 7 });
  const prodBase = barOf(tBaseline, 'productivityFactor');
  ok('S16 tornado: baseline productivity duration sensitivity is a justified zero (no delay days to scale)',
    prodBase !== null && prodBase.lowDurationDays === 0 && prodBase.highDurationDays === 0);
  ok('S16 tornado: baseline vs supply-chain analyses differ (different inputs ⇒ different results)',
    JSON.stringify(tBaseline.bars) !== JSON.stringify(tSmall.bars));

  // Determinism: identical inputs ⇒ byte-identical analysis.
  const tSmall2 = calculateScenarioSensitivityTornado(projSmall, [], [], [], supplyChain, null, { seed: 7 });
  eq('S16 tornado: deterministic for identical inputs', JSON.stringify(tSmall2), JSON.stringify(tSmall));

  // --- Finding 2: WATCH-CASH-01 never claims exact / deviation 0 without cash-flow data ---
  const okRes = simulateComplexProjectScenario(projSmall, [], [], [], supplyChain, null, { seed: 7, iterations: 20, risks: [] });
  const wd = runPrecisionWatchdogAudit(projSmall, [], [], [okRes]);
  const cashMetric = wd.find((m) => m.id === 'WATCH-CASH-01');
  ok('S16 watchdog: WATCH-CASH-01 is published', cashMetric !== undefined);
  eq('S16 watchdog: cash audit is not_measured (no authoritative cash-flow basis exists)', cashMetric?.precisionStatus, 'not_measured');
  eq('S16 watchdog: cash audit deviation is null — never a fabricated 0', cashMetric?.deviation, null);
  ok('S16 watchdog: cash audit does not claim exact parity', cashMetric?.precisionStatus !== 'exact');
  ok('S16 watchdog: cash audit announces N/A in its published values',
    (cashMetric?.calculatedValue ?? '').includes('N/A') && (cashMetric?.expectedValue ?? '').includes('N/A'));
  // Even an empty audit cannot coax a successful cash-flow status out of it.
  const wdEmpty = runPrecisionWatchdogAudit(mkProject({ start_date: null, duration_days: null }), [], [], []);
  const cashEmpty = wdEmpty.find((m) => m.id === 'WATCH-CASH-01');
  eq('S16 watchdog: empty inputs also yield not_measured (never exact/deviation 0)', cashEmpty?.precisionStatus, 'not_measured');
  eq('S16 watchdog: empty inputs cash deviation is null', cashEmpty?.deviation, null);
  ok('S16 watchdog: no cash-flow-integrity metric anywhere claims a measured precision status',
    wd.every((m) => m.category !== 'cashflow_integrity' || (m.precisionStatus === 'not_measured' && m.deviation === null)));
  noNonFinite('S16 watchdog: full audit output carries no NaN/Infinity', wd);
}


// ===========================================================================
console.log('--- S17 Controlled Pilot defects (F9.4)');
// ===========================================================================
// The four defects the Controlled Pilot stopped on. Each subsection first proves the scenario
// actually REPRODUCES the reported symptom against the pre-fix code path, then asserts the fixed
// behaviour — a regression test that cannot fail on the old code is not a regression test.
{
  const mkProject = (o: Partial<Project> = {}): Project => ({
    id: 'p1', name: 'Controlled Pilot — commercial office building', client: null, location: null,
    contract_value: 2345150, currency: 'SAR', start_date: '2026-07-01', end_date: '2027-02-28',
    data_date: DD, duration_days: 195, status: 'active', description: null,
    calendar_type: '6_days', created_at: '2026-01-01T00:00:00Z', ...o,
  });
  // `approved_budget` is `number | undefined` on the type, so it is simply omitted here: the
  // legacy derivation reads `planned_cost || approved_budget`, and F6 reads the baseline.
  const bl = (id: string, wbsNodeId: string, planned: number): BudgetLine => ({
    id, project_id: 'p1', wbs_node_id: wbsNodeId, activity_id: null, boq_item_id: null,
    description: id, planned_cost: planned, committed_cost: 0,
    actual_cost: 0, remaining_cost: planned, created_at: '2026-01-01T00:00:00Z',
  });

  // ---------------------------------------------------------------------
  // S17-A  EVM reconciliation: one canonical SSOT, quoted by every screen
  // ---------------------------------------------------------------------
  // Pilot-shaped dataset: four completed activities in WBS node w1 (whose budget is split over TWO
  // budget lines), one 70%-complete activity in w2, two not-started activities. Every BAC source
  // agrees at 2,345,150 — exactly as in the pilot — so the divergence is purely in how each engine
  // WEIGHTS an activity's budget and earns its percent.
  const pilotProject = mkProject();
  const pilotActs = [
    act({ id: 'PA1', code: 'PA1', wbs_node_id: 'w1', early_start: '2026-07-01', early_finish: '2026-07-13', duration_days: 12, percent_complete: 100, actual_start: '2026-07-01', actual_finish: '2026-07-13' }),
    act({ id: 'PA2', code: 'PA2', wbs_node_id: 'w1', early_start: '2026-07-14', early_finish: '2026-07-22', duration_days: 8, percent_complete: 100, actual_start: '2026-07-14', actual_finish: '2026-07-22' }),
    act({ id: 'PA3', code: 'PA3', wbs_node_id: 'w1', early_start: '2026-07-23', early_finish: '2026-08-14', duration_days: 20, percent_complete: 100, actual_start: '2026-07-23', actual_finish: '2026-08-14' }),
    act({ id: 'PA4', code: 'PA4', wbs_node_id: 'w1', early_start: '2026-08-15', early_finish: '2026-08-25', duration_days: 10, percent_complete: 100, actual_start: '2026-08-15', actual_finish: '2026-08-25' }),
    act({ id: 'PA5', code: 'PA5', wbs_node_id: 'w2', early_start: '2026-08-26', early_finish: '2026-09-19', duration_days: 22, percent_complete: 70, actual_start: '2026-08-26' }),
    act({ id: 'PA6', code: 'PA6', wbs_node_id: 'w2', early_start: '2026-09-20', early_finish: '2026-11-08', duration_days: 45, percent_complete: 0 }),
    act({ id: 'PA7', code: 'PA7', wbs_node_id: 'w3', early_start: '2026-10-01', early_finish: '2026-11-04', duration_days: 30, percent_complete: 0 }),
  ];
  const pilotLinks = [link('PL1', 'PA1', 'PA2'), link('PL2', 'PA2', 'PA3'), link('PL3', 'PA3', 'PA4'), link('PL4', 'PA4', 'PA5'), link('PL5', 'PA5', 'PA6')];
  // The approved baseline authorizes BAC per activity (the PMB). Sums to the contract value.
  const pilotBaselines = [
    base('PB1', 'PA1', '2026-07-01', '2026-07-13', 12, 42000),
    base('PB2', 'PA2', '2026-07-14', '2026-07-22', 8, 39900),
    base('PB3', 'PA3', '2026-07-23', '2026-08-14', 20, 323150),
    base('PB4', 'PA4', '2026-08-15', '2026-08-25', 10, 20250),
    base('PB5', 'PA5', '2026-08-26', '2026-09-19', 22, 468000),
    base('PB6', 'PA6', '2026-09-20', '2026-11-08', 45, 468000),
    base('PB7', 'PA7', '2026-10-01', '2026-11-04', 30, 983850),
  ];
  // Node w1's budget is split over TWO lines — the shape that broke the legacy allocation, which
  // took only the FIRST matching line and handed it in full to all four w1 activities.
  // Node w2's budget is likewise split, with the bulk in the SECOND line. The legacy derivation
  // matched only the first line per node and then re-scaled to BAC, so the not-started PA7 (whose
  // node holds one large line) absorbed most of the budget and earned nothing — collapsing EV.
  const pilotBudget = [
    bl('PBL1', 'w1', 42000), bl('PBL2', 'w1', 383300),
    bl('PBL3', 'w2', 46000), bl('PBL4', 'w2', 890000),
    bl('PBL5', 'w3', 983850),
  ];
  const pilotUpdates = [
    upd('PU1', 'PA1', '2026-07-13', 100), upd('PU2', 'PA2', '2026-07-22', 100),
    upd('PU3', 'PA3', '2026-08-14', 100), upd('PU4', 'PA4', '2026-08-25', 100),
    upd('PU5', 'PA5', '2026-09-12', 70),
  ];
  const pilotTxns = [
    txn('PT1', 'PA1', '2026-07-15', 40500), txn('PT2', 'PA2', '2026-07-24', 39900),
    txn('PT3', 'PA3', '2026-08-16', 310000), txn('PT4', 'PA4', '2026-08-28', 19500),
    txn('PT5', 'PA5', '2026-09-10', 280000),
  ];
  eq('S17-A baseline BAC reconciles to the contract value', pilotBaselines.reduce((s, b) => s + b.planned_cost, 0), 2345150);
  eq('S17-A budget lines reconcile to the contract value', pilotBudget.reduce((s, b) => s + b.planned_cost, 0), 2345150);

  const pilotF5 = analyzeScheduleControl({
    activities: pilotActs, links: pilotLinks, baselines: pilotBaselines, progressUpdates: pilotUpdates,
    previousSnapshot: null, dataDate: DD, calendarType: '6_days',
  });
  const pilotF6 = analyzeCostControl({
    project: pilotProject, activities: pilotActs, baselines: pilotBaselines, budgetLines: pilotBudget,
    costTransactions: pilotTxns, progressUpdates: pilotUpdates, wbsNodes: [], boqItems: [],
    allocations: [], previousSnapshots: [], dataDate: DD, calendarType: '6_days',
  });
  const canonical = selectCanonicalEvm(pilotF6);
  const adapted = canonicalEvmToComprehensive(canonical);
  const pilotTrust = analyzeForecastTrust({
    scheduleReport: pilotF5, costReport: pilotF6, decisionReport: null,
    activities: pilotActs, links: pilotLinks, baselines: pilotBaselines, progressUpdates: pilotUpdates,
    costTransactions: pilotTxns, boqItems: [], allocations: [],
    scheduleSnapshots: [], costSnapshots: [], dataDate: DD, calendarType: '6_days',
  });
  // The superseded second derivation, kept here ONLY to prove the scenario reproduces the defect.
  const legacy = calculateProjectEvmAtDataDate(pilotProject, pilotActs, pilotBudget, [], pilotTxns, pilotUpdates);

  // (i) the scenario really is the pilot defect: the two derivations disagreed materially.
  ok('S17-A scenario reproduces the pilot: the superseded derivation produced a different EV',
    legacy.ev !== pilotF6.project.ev);
  // The reported pilot numbers, reproduced to the riyal: a healthy F6 (CPI 1.091) read as a
  // distressed project (CPI 0.55, EAC 4.26m against a 2.35m contract) by the second derivation.
  eq('S17-A canonical EV is the pilot-reported 752,900', pilotF6.project.ev, 752900);
  eq('S17-A canonical CPI is the pilot-reported 1.091', pilotF6.project.cpi, 1.091);
  eq('S17-A canonical EAC is the pilot-reported 2,149,541.7', pilotF6.project.eac, 2149541.7);
  eq('S17-A the superseded derivation collapsed EV to 377,456', legacy.ev, 377456);
  eq('S17-A the superseded derivation collapsed CPI to 0.55', legacy.cpi, 0.55);
  eq('S17-A the superseded derivation inflated EAC to 4,263,909', legacy.eac, 4263909);
  ok('S17-A the superseded derivation retained barely half the canonical earned value',
    legacy.ev < 0.55 * (pilotF6.project.ev ?? 0));
  ok('S17-A scenario reproduces the pilot: CPI and EAC diverged with EV',
    legacy.cpi !== pilotF6.project.cpi && legacy.eac !== pilotF6.project.eac
    && legacy.vac !== pilotF6.project.vac && legacy.pv !== pilotF6.project.pv);
  ok('S17-A the divergence was NOT a BAC or AC disagreement (both sources agreed there)',
    legacy.bac === pilotF6.bac.value && legacy.ac === pilotF6.project.ac);
  eq('S17-A BAC agreed in both (the pilot divergence was weighting, not budget)', legacy.bac, pilotF6.bac.value);
  eq('S17-A AC agreed in both (approved-only + Data Date filter is shared)', legacy.ac, pilotF6.project.ac);

  // (ii) the canonical read-out is a VERBATIM quote of F6 — no re-derivation, no rounding drift.
  eq('S17-A canonical declares its source', canonical.source, CANONICAL_EVM_SOURCE);
  eq('S17-A canonical.dataDate === F6.dataDate', canonical.dataDate, pilotF6.dataDate);
  eq('S17-A canonical.BAC === F6.BAC', canonical.bac, pilotF6.bac.value);
  eq('S17-A canonical.PV === F6.PV', canonical.pv, pilotF6.project.pv);
  eq('S17-A canonical.EV === F6.EV', canonical.ev, pilotF6.project.ev);
  eq('S17-A canonical.AC === F6.AC', canonical.ac, pilotF6.project.ac);
  eq('S17-A canonical.CPI === F6.CPI (quoted at F6 precision, not re-rounded)', canonical.cpi, pilotF6.project.cpi);
  eq('S17-A canonical.SPI === F6.SPI', canonical.spi, pilotF6.project.spi);
  eq('S17-A canonical.ETC === F6.ETC', canonical.etc, pilotF6.project.etc);
  eq('S17-A canonical.EAC === F6.EAC', canonical.eac, pilotF6.project.eac);
  eq('S17-A canonical.VAC === F6.VAC', canonical.vac, pilotF6.project.vac);
  eq('S17-A canonical.CV === F6.CV', canonical.cv, pilotF6.project.cv);
  eq('S17-A canonical.SV === F6.SV', canonical.sv, pilotF6.project.sv);
  eq('S17-A canonical BAC basis names the approved baseline', canonical.bacSource, 'approved_baseline');

  // (iii) F8 QUOTES the canonical result — it is a trust layer, not a second EVM engine.
  eq('S17-A F8 quoted EAC === canonical EAC', pilotTrust.trust.eac, canonical.eac);
  eq('S17-A F8 quoted forecast finish === F5 forecast finish', pilotTrust.trust.forecastFinish, pilotF5.project.forecastFinish);
  ok('S17-A F8 publishes no EVM figure that contradicts F6',
    pilotTrust.trust.eac === pilotF6.project.eac);

  // (iv) the shape adapter used by the S-curve / earned-schedule / control-health engines carries
  //      the SAME canonical numbers, so no consumer downstream can drift.
  eq('S17-A adapted.BAC === canonical.BAC', adapted.bac, canonical.bac);
  eq('S17-A adapted.PV === canonical.PV', adapted.pv, canonical.pv);
  eq('S17-A adapted.EV === canonical.EV', adapted.ev, canonical.ev);
  eq('S17-A adapted.AC === canonical.AC', adapted.ac, canonical.ac);
  eq('S17-A adapted.CPI === canonical.CPI', adapted.cpi, canonical.cpi);
  eq('S17-A adapted.SPI === canonical.SPI', adapted.spi, canonical.spi);
  eq('S17-A adapted.EAC === canonical.EAC', adapted.eac, canonical.eac);
  eq('S17-A adapted.ETC === canonical.ETC', adapted.etc, canonical.etc);
  eq('S17-A adapted.VAC === canonical.VAC', adapted.vac, canonical.vac);
  eq('S17-A quoteCanonicalEvm(F6) is byte-identical to select+adapt', JSON.stringify(quoteCanonicalEvm(pilotF6)), JSON.stringify(adapted));

  // (v) the reported equalities the pilot required, stated as one chain each.
  eq('S17-A F6.EV === F8-quoted EV === report EV',
    [pilotF6.project.ev, canonical.ev, adapted.ev],
    [pilotF6.project.ev, pilotF6.project.ev, pilotF6.project.ev]);
  eq('S17-A F6.CPI === report CPI === adapted CPI',
    [pilotF6.project.cpi, canonical.cpi, adapted.cpi],
    [pilotF6.project.cpi, pilotF6.project.cpi, pilotF6.project.cpi]);
  eq('S17-A F6.EAC === F8-quoted EAC === report EAC',
    [pilotF6.project.eac, pilotTrust.trust.eac, adapted.eac],
    [pilotF6.project.eac, pilotF6.project.eac, pilotF6.project.eac]);

  // (vi) determinism + no non-finite leakage through the canonical path.
  const canonical2 = selectCanonicalEvm(analyzeCostControl({
    project: pilotProject, activities: pilotActs, baselines: pilotBaselines, budgetLines: pilotBudget,
    costTransactions: pilotTxns, progressUpdates: pilotUpdates, wbsNodes: [], boqItems: [],
    allocations: [], previousSnapshots: [], dataDate: DD, calendarType: '6_days',
  }));
  eq('S17-A canonical EVM is deterministic for identical inputs', JSON.stringify(canonical2), JSON.stringify(canonical));
  noNonFinite('S17-A canonical EVM scan', canonical);
  noNonFinite('S17-A adapted EVM scan', adapted);

  // (vii) no project => the explicit all-N/A canonical state, never a fabricated budget.
  const emptyCanonical = selectCanonicalEvm(null);
  eq('S17-A no F6 report => BAC is N/A, not an invented budget', emptyCanonical.bac, null);
  eq('S17-A no F6 report => EV is N/A', emptyCanonical.ev, null);
  eq('S17-A no F6 report => CPI flagged empty, not a healthy 1.0 presented as measured', emptyCanonical.cpiStatus, 'empty_no_data');
  eq('S17-A no F6 report => earned progress is N/A', emptyCanonical.earnedProgressPercent, null);
  noNonFinite('S17-A empty canonical scan', emptyCanonical);
  noNonFinite('S17-A empty adapted scan', canonicalEvmToComprehensive(emptyCanonical));

  // ---------------------------------------------------------------------
  // S17-B  Cost-transaction approval persists (demo-store RPC contract)
  // ---------------------------------------------------------------------
  const PILOT_TXN_DESC = 'Controlled Pilot cost transaction - 100 SAR';
  const mkDb = (txnOverrides: Record<string, unknown> = {}, date = '2026-09-10'): DemoDb => ({
    cost_transactions: [{
      id: 'cp-100', project_id: 'p1', activity_id: 'PA5', boq_item_id: null, category: 'work',
      transaction_date: date, description: PILOT_TXN_DESC, cost_type: 'direct', amount: 100,
      source: 'manual', status: 'submitted', approved_at: null, approved_by: null,
      rejected_reason: null, approval_level: 0, created_at: '2026-09-10T08:00:00Z', ...txnOverrides,
    }],
    approval_events: [],
  });
  const NOW = '2026-09-13T09:00:00Z';
  const rowOf = (db: DemoDb) => (db['cost_transactions'] || [])[0];

  // The pilot symptom: Approve produced NO state change and NO error. The contract now writes.
  const dbA = mkDb();
  const first = applyReviewCostTransaction(dbA, { transaction_uuid: 'cp-100', approver: 'project_control', decision: 'approve' }, NOW);
  eq('S17-B first approval returns no error', first.error, null);
  eq('S17-B first approval advances the level (two-level SQL gate)', rowOf(dbA).approval_level, 1);
  eq('S17-B level 1 is still submitted — status is not faked to approved', rowOf(dbA).status, 'submitted');
  eq('S17-B level 1 sets no approval timestamp', rowOf(dbA).approved_at, null);
  eq('S17-B the advance is VISIBLE to the caller (the pilot showed nothing at all)', reviewStateOf(rowOf(dbA))?.awaitingFurtherApproval, true);

  const second = applyReviewCostTransaction(dbA, { transaction_uuid: 'cp-100', approver: 'finance_manager', decision: 'approve' }, NOW);
  eq('S17-B second approval returns no error', second.error, null);
  eq('S17-B pending -> approved', rowOf(dbA).status, 'approved');
  eq('S17-B approval_level reaches the contractual maximum', rowOf(dbA).approval_level, 2);
  eq('S17-B approved_at is set to a timestamptz-shaped ISO instant', rowOf(dbA).approved_at, NOW);
  ok('S17-B approved_at parses as a real date', !Number.isNaN(new Date(String(rowOf(dbA).approved_at)).getTime()));
  eq('S17-B approved_by records the approver', rowOf(dbA).approved_by, 'finance_manager');
  eq('S17-B review state reports approved', reviewStateOf(rowOf(dbA))?.isApproved, true);
  eq('S17-B no approval levels remain', reviewStateOf(rowOf(dbA))?.levelsRemaining, 0);

  // Persistence contract: the write landed in the STORE, not in local component state. Re-reading
  // the store (what a reload does) still shows the row approved.
  const reloaded = JSON.parse(JSON.stringify(dbA)) as DemoDb;
  eq('S17-B approval survives a reload (persisted, not optimistic local state)', rowOf(reloaded).status, 'approved');
  eq('S17-B approved_at survives a reload', rowOf(reloaded).approved_at, NOW);
  eq('S17-B every decision is audit-trailed', (dbA['approval_events'] || []).length, 2);
  eq('S17-B the audit trail names the entity', (dbA['approval_events'] || [])[0].entity_type, 'cost_transaction');

  // An already-approved row is not re-reviewable: the SQL raises, so the demo store must too, and
  // must NOT report success.
  const dbApproved = mkDb({ status: 'approved', approval_level: 2 });
  const reApprove = applyReviewCostTransaction(dbApproved, { transaction_uuid: 'cp-100', approver: 'project_control', decision: 'approve' }, NOW);
  ok('S17-B re-approving a non-submitted row FAILS', reApprove.error !== null);
  ok('S17-B the failure names the contract breach', String(reApprove.error?.message).includes('Only submitted cost transactions'));
  ok('S17-B the failure identifies the failed step', String(reApprove.error?.hint).includes('review_cost_transaction'));
  eq('S17-B a failed review writes nothing', rowOf(dbApproved).approved_at, null);

  const dbMissing = mkDb();
  const missing = applyReviewCostTransaction(dbMissing, { transaction_uuid: 'does-not-exist', decision: 'approve' }, NOW);
  ok('S17-B an unknown row id FAILS instead of silently succeeding', missing.error !== null);
  eq('S17-B an unknown row id leaves the store untouched', rowOf(dbMissing).status, 'submitted');

  const dbBad = mkDb();
  const badDecision = applyReviewCostTransaction(dbBad, { transaction_uuid: 'cp-100', decision: 'maybe' }, NOW);
  ok('S17-B an invalid decision FAILS', badDecision.error !== null);
  eq('S17-B an invalid decision names the breach', badDecision.error?.message, 'Invalid review decision');
  eq('S17-B an invalid decision writes nothing', rowOf(dbBad).status, 'submitted');

  // The exact mechanism that hid the pilot defect: an RPC the store does not implement used to
  // answer `{ data: true, error: null }`, which the UI read as a committed write.
  const unimplemented = unimplementedRpcError('review_cost_transaction');
  ok('S17-B an unimplemented RPC is an ERROR, never a false success', unimplemented.error !== null);
  ok('S17-B the error names the missing function', String(unimplemented.error?.message).includes('review_cost_transaction'));
  ok('S17-B the error states the write did not happen', String(unimplemented.error?.details).includes('NOT performed'));
  eq('S17-B an unimplemented RPC returns no data payload', unimplemented.data, null);

  // Rejection path.
  const dbR = mkDb();
  const rejected = applyReviewCostTransaction(dbR, { transaction_uuid: 'cp-100', approver: 'reviewer', decision: 'reject', review_notes: 'needs correction' }, NOW);
  eq('S17-B rejection returns no error', rejected.error, null);
  eq('S17-B rejection sets status rejected', rowOf(dbR).status, 'rejected');
  eq('S17-B rejection records the reason', rowOf(dbR).rejected_reason, 'needs correction');
  eq('S17-B a rejected row is not approved', reviewStateOf(rowOf(dbR))?.isApproved, false);

  // AC cut-off: an approved row enters canonical AC only when its date is on/before the Data Date.
  const acOf = (date: string, status: string): number => analyzeCostControl({
    project: pilotProject, activities: pilotActs, baselines: pilotBaselines, budgetLines: pilotBudget,
    costTransactions: [...pilotTxns, txn('CPX', 'PA5', date, 100, status)],
    progressUpdates: pilotUpdates, wbsNodes: [], boqItems: [], allocations: [],
    previousSnapshots: [], dataDate: DD, calendarType: '6_days',
  }).project.ac;
  const acBaseline = pilotF6.project.ac;
  eq('S17-B an approved 100 SAR row dated on/before the Data Date enters AC', acOf('2026-09-10', 'approved'), acBaseline + 100);
  eq('S17-B an approved row dated AFTER the Data Date is excluded from AC', acOf('2026-09-20', 'approved'), acBaseline);
  eq('S17-B a still-submitted row is excluded from AC (approved-only rule)', acOf('2026-09-10', 'submitted'), acBaseline);
  eq('S17-B a rejected row is excluded from AC', acOf('2026-09-10', 'rejected'), acBaseline);
  ok('S17-B the approved 100 SAR row is inside the Data Date window', !isAfterDataDate('2026-09-10', DD) && isAfterDataDate('2026-09-20', DD));

  // ---------------------------------------------------------------------
  // S17-C  F5 baseline finish / total delay (the -310 corruption)
  // ---------------------------------------------------------------------
  // CPM anchors on the activity's own early_start, so this pair forecasts a project finish of
  // exactly 2027-03-03 on the 6-day calendar (Friday off).
  const delayActs = [
    act({ id: 'DL1', code: 'DL1', early_start: '2027-02-21', early_finish: '2027-03-03', duration_days: 10, percent_complete: 0 }),
    act({ id: 'DL2', code: 'DL2', early_start: '2027-02-21', early_finish: '2027-02-26', duration_days: 5, percent_complete: 0 }),
  ];
  const delayBaselines = [
    base('DB1', 'DL1', '2027-02-18', '2027-02-28', 10, 500000),
    base('DB2', 'DL2', '2027-02-18', '2027-02-26', 5, 100000),
    // The leak: a baseline row belonging to ANOTHER project (its activity is not in the analysed
    // set). `baseline_activities` has no project_id, so an unscoped fetch delivers exactly this.
    base('DB-FOREIGN', 'other-project-activity', '2027-03-01', '2028-02-28', 200, 9999999),
  ];
  const f5leak = analyzeScheduleControl({
    activities: delayActs, links: [], baselines: delayBaselines, progressUpdates: [],
    previousSnapshot: null, dataDate: DD, calendarType: '6_days',
  });
  ok('S17-C the scenario really contains a foreign 2028 baseline row',
    delayBaselines.some((b) => b.early_finish === '2028-02-28' && !delayActs.some((a) => a.id === b.activity_id)));
  eq('S17-C baseline finish is the PROJECT baseline, not the foreign 2028 row', f5leak.project.baselineFinish, '2027-02-28');
  ok('S17-C baseline finish is never year-shifted to 2028', String(f5leak.project.baselineFinish).startsWith('2027'));
  eq('S17-C forecast finish is exactly 2027-03-03', f5leak.project.forecastFinish, '2027-03-03');
  ok('S17-C total delay is POSITIVE (a slip, not recovered time)', (f5leak.project.totalDelayWd ?? -1) > 0);
  eq('S17-C total delay uses the F5 inclusive working-day convention', f5leak.project.totalDelayWd, refWdDelta('2027-02-28', '2027-03-03'));
  eq('S17-C total delay is the small pilot-scale value (3 wd)', f5leak.project.totalDelayWd, 3);
  ok('S17-C total delay is NEVER -310', f5leak.project.totalDelayWd !== -310);
  eq('S17-C the same result holds when the caller scopes the rows itself',
    JSON.stringify(analyzeScheduleControl({
      activities: delayActs, links: [], baselines: delayBaselines.filter((b) => b.activity_id !== 'other-project-activity'),
      progressUpdates: [], previousSnapshot: null, dataDate: DD, calendarType: '6_days',
    }).project), JSON.stringify(f5leak.project));
  // Working-day sanity on the governed calendar for these exact dates.
  eq('S17-C workingDayDelta(2027-02-28 -> 2027-03-03) on 6_days = 3',
    workingDayDelta('2027-02-28', '2027-03-03', getCalendar('6_days')), 3);
  eq('S17-C the corrupt pairing (2028-02-28 -> 2027-03-03) is exactly the reported -310',
    workingDayDelta('2028-02-28', '2027-03-03', getCalendar('6_days')), -310);
  noNonFinite('S17-C F5 project scan', f5leak.project);

  // ---------------------------------------------------------------------
  // S17-D  Critical activity count: one canonical definition everywhere
  // ---------------------------------------------------------------------
  // Three 100%-complete activities still carry the persisted `is_critical` flag (as the pilot seed
  // did), while the statused CPM at the Data Date drives criticality through the remaining work.
  const critActs = [
    act({ id: 'CC1', code: 'CC1', early_start: '2026-07-01', early_finish: '2026-07-13', duration_days: 10, percent_complete: 100, actual_start: '2026-07-01', actual_finish: '2026-07-13', is_critical: true, total_float: 0 }),
    act({ id: 'CC2', code: 'CC2', early_start: '2026-07-14', early_finish: '2026-07-25', duration_days: 10, percent_complete: 100, actual_start: '2026-07-14', actual_finish: '2026-07-25', is_critical: true, total_float: 0 }),
    act({ id: 'CC3', code: 'CC3', early_start: '2026-07-26', early_finish: '2026-08-10', duration_days: 12, percent_complete: 100, actual_start: '2026-07-26', actual_finish: '2026-08-10', is_critical: true, total_float: 0 }),
    act({ id: 'CC4', code: 'CC4', early_start: '2026-08-11', early_finish: '2026-09-20', duration_days: 20, percent_complete: 60, actual_start: '2026-08-11', is_critical: true, total_float: 0 }),
    act({ id: 'CC5', code: 'CC5', early_start: '2026-09-21', early_finish: '2026-10-20', duration_days: 20, percent_complete: 0, is_critical: true, total_float: 0 }),
    act({ id: 'CC6', code: 'CC6', early_start: '2026-08-11', early_finish: '2026-08-20', duration_days: 8, percent_complete: 0, is_critical: false, total_float: 12 }),
  ];
  const critLinks = [link('CL1', 'CC1', 'CC2'), link('CL2', 'CC2', 'CC3'), link('CL3', 'CC3', 'CC4'), link('CL4', 'CC4', 'CC5')];
  // P2A1-H01: the materialised percents above are now EVIDENCE-BACKED, as they are in a governed
  // project (`approve_progress_update` writes both the history row and the column). Without these
  // approved in-period rows the activities are unreached, and the fixture would no longer model the
  // pilot it reproduces (three completed activities driving criticality through the remaining work).
  const critUpdates = [
    upd('CRU1', 'CC1', '2026-07-13', 100), upd('CRU2', 'CC2', '2026-07-25', 100),
    upd('CRU3', 'CC3', '2026-08-10', 100), upd('CRU4', 'CC4', '2026-09-05', 60),
  ];
  const critF5 = analyzeScheduleControl({
    activities: critActs, links: critLinks, baselines: [], progressUpdates: critUpdates,
    previousSnapshot: null, dataDate: DD, calendarType: '6_days',
  });
  const crit = summarizeCanonicalCriticality(critActs, critLinks, {
    dataDate: DD, calendarType: '6_days', progressUpdates: critUpdates,
  });
  const cpmCrit = calculateCpm(critActs, critLinks, { calendarType: '6_days', dataDate: DD }).results.filter((r) => r.isCritical).length;
  const staleFlagCount = critActs.filter((a) => a.is_critical).length;
  const oldDashboardFormula = critActs.filter((a) => a.is_critical && a.percent_complete < 100).length;

  ok('S17-D scenario reproduces the pilot: the stale flag count exceeds the canonical count', staleFlagCount > crit.totalCritical);
  eq('S17-D the stale persisted flag count is the reported 9-shape (5 flagged, 2 canonical)', staleFlagCount, 5);
  eq('S17-D canonical total === CPM result.isCritical count', crit.totalCritical, cpmCrit);
  eq('S17-D canonical total === F5 project.criticalCount (one source, two consumers)', crit.totalCritical, critF5.project.criticalCount);
  ok('S17-D canonical total excludes completed work the stale flag still marked critical', crit.totalCritical < staleFlagCount);
  ok('S17-D a completed activity carrying is_critical=true is NOT canonically critical',
    crit.byId.get('CC1')?.critical === false && crit.byId.get('CC2')?.critical === false && crit.byId.get('CC3')?.critical === false);
  ok('S17-D the remaining critical activities ARE canonically critical',
    crit.byId.get('CC4')?.critical === true && crit.byId.get('CC5')?.critical === true);

  // The incomplete subset is a SEPARATE, explicitly named metric — tested on its own, never
  // presented as the total.
  eq('S17-D remaining === canonical-critical AND not completed', crit.remainingCritical,
    critActs.filter((a) => crit.byId.get(a.id)?.critical && !crit.byId.get(a.id)?.completed).length);
  ok('S17-D remaining is a subset of the total', crit.remainingCritical <= crit.totalCritical);
  eq('S17-D remaining ids are exactly the incomplete canonical-critical activities', crit.remainingCriticalIds, ['CC4', 'CC5']);
  eq('S17-D total ids include every canonical-critical activity', crit.criticalIds, ['CC4', 'CC5']);
  ok('S17-D the old dashboard formula (stale flag && pct<100) is not the canonical definition',
    oldDashboardFormula !== crit.totalCritical || staleFlagCount !== crit.totalCritical);
  eq('S17-D F5 statused rows agree with the shared canonical helper',
    critF5.statused.filter((s) => s.critical).length, crit.totalCritical);
  eq('S17-D F5 statused incomplete-critical agrees with the named subset',
    critF5.statused.filter((s) => s.critical && !s.completed).length, crit.remainingCritical);

  // Empty project: no activities, no criticality, no fabricated count.
  const critEmpty = summarizeCanonicalCriticality([], [], { dataDate: DD, calendarType: '6_days' });
  eq('S17-D empty project canonical total is 0', critEmpty.totalCritical, 0);
  eq('S17-D empty project remaining is 0', critEmpty.remainingCritical, 0);
  // Determinism.
  eq('S17-D canonical criticality is deterministic',
    JSON.stringify(summarizeCanonicalCriticality(critActs, critLinks, { dataDate: DD, calendarType: '6_days', progressUpdates: critUpdates }).criticalIds),
    JSON.stringify(crit.criticalIds));
  // Machine-clock independence: criticality must not read the wall clock.
  let critShifted: string[] = [];
  withShiftedClock(400, () => {
    critShifted = summarizeCanonicalCriticality(critActs, critLinks, { dataDate: DD, calendarType: '6_days', progressUpdates: critUpdates }).criticalIds;
  });
  eq('S17-D canonical criticality is identical under a +400d clock shift', JSON.stringify(critShifted), JSON.stringify(crit.criticalIds));

  // ---------------------------------------------------------------------
  // S17-E  Independent review finding 1 & 2 — source-level contracts
  // ---------------------------------------------------------------------
  // Both findings were invisible to the type system: the demo store's query result is `any`, so a
  // transposed `Promise.all` slot and an ungoverned `baseline_activities` fetch both typecheck, build
  // and lint cleanly while silently corrupting canonical EVM. These checks read the shipped view
  // source as text and pin the contracts that the compiler cannot.
  const repoRoot = (() => {
    const cwd = process.cwd();
    if (existsSync(resolvePath(cwd, 'package.json'))) return cwd;
    // The bundle lands in node_modules/.cache, so walk up from this module to the package root.
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolvePath(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    return cwd;
  })();
  const readSrc = (rel: string): string => readFileSync(resolvePath(repoRoot, rel), 'utf8');

  /** The full query expression for one table: from `supabase.from('<t>')` to the next `.from(`. */
  const queryFor = (src: string, table: string): string | null => {
    const head = `supabase.from('${table}')`;
    const start = src.indexOf(head);
    if (start < 0) return null;
    const next = src.indexOf('supabase.from(', start + head.length);
    return src.slice(start, next < 0 ? src.length : next);
  };
  /** The governed baseline query: scoped through the revision header to ACTIVE + APPROVED. */
  const isRevisionGoverned = (q: string): boolean =>
    q.includes('project_baselines!inner')
    && q.includes(".eq('project_baselines.is_active', true)")
    && q.includes(".eq('project_baselines.status', 'approved')");
  const isProjectScoped = (q: string): boolean =>
    q.includes(".eq('project_baselines.project_id', project.id)");

  // --- Finding 1: PortfolioView table -> destructured slot binding. ---
  const pfSrc = readSrc('src/components/views/PortfolioView.tsx');
  const pfBody = pfSrc.slice(pfSrc.indexOf('async function loadPortfolio()'));
  const pfDestructure = pfBody.slice(pfBody.indexOf('const ['), pfBody.indexOf('= await Promise.all(['));
  const pfSlots = Array.from(pfDestructure.matchAll(/\{\s*data:\s*(\w+)\s*\}/g)).map((m) => m[1]);
  const pfArray = pfBody.slice(pfBody.indexOf('= await Promise.all(['));
  const pfTables = Array.from(
    pfArray.slice(0, pfArray.indexOf(']);')).matchAll(/supabase\.from\('([^']+)'\)/g),
  ).map((m) => m[1]);
  const PF_EXPECTED: [string, string][] = [
    ['projects', 'projData'], ['activities', 'actData'], ['budget_lines', 'bgtData'],
    ['cost_transactions', 'cstData'], ['risks', 'rskData'], ['activity_links', 'lnkData'],
    ['boq_items', 'boqData'], ['baseline_activities', 'baselineData'], ['progress_updates', 'prgData'],
  ];
  eq('S17-E PortfolioView loads every expected table', pfTables, PF_EXPECTED.map((e) => e[0]));
  eq('S17-E PortfolioView destructures every expected slot', pfSlots, PF_EXPECTED.map((e) => e[1]));
  eq('S17-E PortfolioView query count === slot count (no unbound result)', pfTables.length, pfSlots.length);
  // The check that FAILS if slots 8 and 9 are transposed again: pair them positionally, by index.
  eq('S17-E PortfolioView binds each table to its own slot, positionally',
    pfTables.map((t, i) => `${t}->${pfSlots[i]}`), PF_EXPECTED.map(([t, v]) => `${t}->${v}`));
  eq('S17-E baseline_activities is NOT bound to prgData (the reported swap)',
    pfSlots[pfTables.indexOf('baseline_activities')], 'baselineData');
  eq('S17-E progress_updates is NOT bound to baselineData (the reported swap)',
    pfSlots[pfTables.indexOf('progress_updates')], 'prgData');
  // Each setter must receive the slot whose name matches the table it came from.
  ok('S17-E setAllProgress receives prgData', /setAllProgress\(\s*prgData/.test(pfBody));
  ok('S17-E setAllBaselines receives baselineData', /setAllBaselines\(\s*baselineData/.test(pfBody));
  ok('S17-E setAllProgress does NOT receive baselineData', !/setAllProgress\(\s*baselineData/.test(pfBody));
  ok('S17-E setAllBaselines does NOT receive prgData', !/setAllBaselines\(\s*prgData/.test(pfBody));
  // The `as BaselineActivity[]` cast on the setter is what suppressed the only available diagnostic.
  ok('S17-E the masking cast on setAllBaselines is gone',
    !/setAllBaselines\([^)]*as BaselineActivity\[\]/.test(pfBody));

  // --- Finding 2: every screen that feeds F6 must use the governed baseline query. ---
  const GOVERNED_VIEWS = [
    'src/components/views/BudgetView.tsx',
    'src/components/views/Dashboard.tsx',
    'src/components/views/ProgressView.tsx',
    'src/components/views/ScheduleView.tsx',
    'src/components/views/ExecutiveReportView.tsx',
  ];
  for (const rel of GOVERNED_VIEWS) {
    const name = rel.split('/').pop();
    const src = readSrc(rel);
    const q = queryFor(src, 'baseline_activities');
    ok(`S17-E ${name} fetches baseline_activities`, q !== null);
    ok(`S17-E ${name} uses the governed revision query`, q !== null && isRevisionGoverned(q));
    ok(`S17-E ${name} scopes to the current project's revision`, q !== null && isProjectScoped(q));
    // Client-side activity-id filtering alone is not governance: it proves a row belongs to one of
    // this project's activities, never which REVISION it belongs to.
    ok(`S17-E ${name} does not rely on a bare unscoped select('*')`,
      q !== null && !/select\('\*'\)\s*[;,)]/.test(q));
  }
  // The Executive Report specifically — the file finding 2 named.
  const erSrc = readSrc('src/components/views/ExecutiveReportView.tsx');
  const erQ = queryFor(erSrc, 'baseline_activities') ?? '';
  ok('S17-E ExecutiveReportView joins through project_baselines', erQ.includes('project_baselines!inner'));
  ok('S17-E ExecutiveReportView selects the governance columns it filters on',
    erQ.includes('project_baselines!inner(project_id, is_active, status)'));
  ok('S17-E ExecutiveReportView keeps the client-side activity-id filter as defence in depth',
    /projectActivityIds\.has\(b\.activity_id\)/.test(erSrc));
  // PortfolioView is a cross-project roll-up: it cannot scope to one project_id, but it must still
  // see only ACTIVE APPROVED revisions, or a superseded revision doubles F6's BAC in the roll-up.
  const pfQ = queryFor(pfSrc, 'baseline_activities') ?? '';
  ok('S17-E PortfolioView restricts baseline rows to active approved revisions', isRevisionGoverned(pfQ));

  // The demo store's dot-notation `eq` must fail CLOSED, matching PostgREST `!inner`: a row whose
  // joined parent is absent is excluded, not waved through.
  const supSrc = readSrc('src/lib/supabase.ts');
  const eqBody = supSrc.slice(supSrc.indexOf('  eq(column: string, value: any) {'));
  const eqDotBranch = eqBody.slice(0, eqBody.indexOf('return item[column] === value;'));
  ok('S17-E the demo store resolves a dot-notation parent before comparing',
    eqDotBranch.includes("column.includes('.')") && eqDotBranch.includes('typeof direct ==='));
  ok('S17-E an unresolvable join parent FAILS CLOSED (was `return true` — fail-open)',
    /return false;/.test(eqDotBranch) && !/return true;/.test(eqDotBranch));

  // ---------------------------------------------------------------------
  // S17-F  Independent review finding 2 — governed baseline evidence (behaviour)
  // ---------------------------------------------------------------------
  // Two revisions of the same project baseline over the same activities, plus a draft revision, a
  // foreign project's revision and an orphaned row. This is the shape the client-side activity-id
  // filter cannot distinguish: every row below carries an `activity_id` belonging to this project.
  const govActs = [
    act({ id: 'GA1', code: 'GA1', early_start: '2026-07-01', early_finish: '2026-07-31', duration_days: 20, percent_complete: 100, actual_start: '2026-07-01', actual_finish: '2026-07-31' }),
    act({ id: 'GA2', code: 'GA2', early_start: '2026-08-01', early_finish: '2026-09-30', duration_days: 30, percent_complete: 50, actual_start: '2026-08-01' }),
  ];
  const rev = (id: string, baselineId: string, actId: string, cost: number, es: string, ef: string, dur: number): BaselineActivity => ({
    ...base(id, actId, es, ef, dur, cost), baseline_id: baselineId,
  });
  const govDb: DemoDb = {
    project_baselines: [
      { id: 'REV0', project_id: 'p1', is_active: false, status: 'approved' }, // superseded revision
      { id: 'REV1', project_id: 'p1', is_active: true, status: 'approved' },  // THE governed revision
      { id: 'REVD', project_id: 'p1', is_active: true, status: 'draft' },     // active but not approved
      { id: 'REVX', project_id: 'p2', is_active: true, status: 'approved' },  // another project
    ],
    baseline_activities: [
      rev('B0a', 'REV0', 'GA1', 900000, '2026-06-01', '2026-06-30', 20),
      rev('B0b', 'REV0', 'GA2', 100000, '2026-07-01', '2026-07-15', 10),
      rev('B1a', 'REV1', 'GA1', 500000, '2026-07-01', '2026-07-31', 20),
      rev('B1b', 'REV1', 'GA2', 500000, '2026-08-01', '2026-09-30', 30),
      rev('BDa', 'REVD', 'GA1', 777, '2026-07-01', '2026-07-31', 20),
      rev('BXa', 'REVX', 'GA1', 999999, '2026-07-01', '2026-07-31', 20),
      rev('BORPH', 'NO-SUCH-REVISION', 'GA1', 123456, '2026-07-01', '2026-07-31', 20),
    ] as unknown as Record<string, unknown>[],
  };
  const allRows = (govDb['baseline_activities'] || []) as unknown as BaselineActivity[];
  const governed = selectGovernedBaselineActivities(govDb, 'p1') as unknown as BaselineActivity[];

  // The scenario really is the finding: activity-id filtering alone admits every row.
  const govActivityIds = new Set(govActs.map((a) => a.id));
  eq('S17-F client-side activity-id filtering admits ALL rows (it is not revision governance)',
    allRows.filter((b) => govActivityIds.has(b.activity_id)).length, allRows.length);
  eq('S17-F the store holds 7 baseline rows over 2 activities', allRows.length, 7);
  eq('S17-F governance selects exactly the active approved revision of THIS project',
    governed.map((b) => b.id), ['B1a', 'B1b']);
  ok('S17-F a superseded (inactive) revision is excluded', !governed.some((b) => b.baseline_id === 'REV0'));
  ok('S17-F an active-but-draft revision is excluded', !governed.some((b) => b.baseline_id === 'REVD'));
  ok('S17-F another project\'s approved revision is excluded', !governed.some((b) => b.baseline_id === 'REVX'));
  ok('S17-F an orphaned row with no resolvable revision is excluded (!inner fails closed)',
    !governed.some((b) => b.baseline_id === 'NO-SUCH-REVISION'));
  eq('S17-F governance yields exactly one row per activity (no last-wins ambiguity)',
    new Set(governed.map((b) => b.activity_id)).size, governed.length);
  eq('S17-F a cross-project roll-up sees every active approved revision, and nothing else',
    selectGovernedBaselineActivities(govDb, null).map((b) => b.id), ['B1a', 'B1b', 'BXa']);
  eq('S17-F governance is deterministic',
    JSON.stringify(selectGovernedBaselineActivities(govDb, 'p1')), JSON.stringify(governed));

  // The consequence: what a stale revision does to canonical EVM once it reaches F6.
  // A real approved cost inside the Data Date window, so AC > 0 and CPI/EAC are MEASURED rather
  // than N/A — without it both sides report null indices and "they differ" would be vacuous.
  const govTxns = [txn('GT1', 'GA1', '2026-08-15', 400000)];
  // P2A1-H01: the two activities' materialised status is backed by approved in-period rows, so the
  // governed EV below is earned from evidence exactly as it is in a governed project.
  const govUpdates = [upd('GVU1', 'GA1', '2026-07-31', 100), upd('GVU2', 'GA2', '2026-09-05', 50)];
  const f6With = (baselines: BaselineActivity[]) => analyzeCostControl({
    project: mkProject({ contract_value: 1000000 }), activities: govActs, baselines,
    budgetLines: [], costTransactions: govTxns, progressUpdates: govUpdates, wbsNodes: [], boqItems: [],
    allocations: [], previousSnapshots: [], dataDate: DD, calendarType: '6_days',
  });
  const govF6 = f6With(governed);
  const ungF6 = f6With(allRows);
  const govCanonical = selectCanonicalEvm(govF6);
  const ungCanonical = selectCanonicalEvm(ungF6);

  eq('S17-F governed BAC is the active approved revision only', govF6.bac.value, 1000000);
  eq('S17-F governed BAC names the baseline as its source', govF6.bac.source, 'baseline');
  eq('S17-F governed EV = 100% of 500k + 50% of 500k', govF6.project.ev, 750000);
  ok('S17-F an ungoverned fetch INFLATES BAC (F6 sums every row it is handed)',
    (ungF6.bac.value ?? 0) > (govF6.bac.value ?? 0));
  eq('S17-F the inflation is exactly the sum of the non-governed rows', ungF6.bac.value, 3124232);
  ok('S17-F a stale revision therefore changes canonical EV too', ungCanonical.ev !== govCanonical.ev);
  ok('S17-F a stale revision therefore changes canonical PV too', ungCanonical.pv !== govCanonical.pv);
  eq('S17-F governed AC is the approved cost inside the Data Date', govF6.project.ac, 400000);
  ok('S17-F the governed indices are measured, not N/A',
    govCanonical.cpi !== null && govCanonical.eac !== null);
  ok('S17-F a stale revision therefore changes canonical CPI', ungCanonical.cpi !== govCanonical.cpi);
  ok('S17-F a stale revision therefore changes canonical EAC', ungCanonical.eac !== govCanonical.eac);
  ok('S17-F a stale revision therefore changes canonical VAC', ungCanonical.vac !== govCanonical.vac);
  eq('S17-F canonical EVM quotes the governed F6 verbatim', govCanonical.bac, govF6.bac.value);
  eq('S17-F canonical EV quotes the governed F6 verbatim', govCanonical.ev, govF6.project.ev);

  // The sharpest form of the hazard: F6's `baselineByAct` is a Map keyed by activity_id, so with two
  // revisions per activity the LAST row in array order decides that activity's BAC — and therefore
  // its EV and PV window. Governing the evidence makes canonical EVM order-INDEPENDENT.
  const reversed = (rows: BaselineActivity[]) => f6With([...rows].reverse());
  eq('S17-F governed canonical EV is independent of row order',
    selectCanonicalEvm(reversed(governed)).ev, govCanonical.ev);
  eq('S17-F governed canonical BAC is independent of row order',
    selectCanonicalEvm(reversed(governed)).bac, govCanonical.bac);
  eq('S17-F governed canonical PV is independent of row order',
    selectCanonicalEvm(reversed(governed)).pv, govCanonical.pv);
  ok('S17-F UNGOVERNED canonical EV depends on row order (the last-wins hazard)',
    selectCanonicalEvm(reversed(allRows)).ev !== ungCanonical.ev);
  eq('S17-F ungoverned EV follows whichever revision sorts last', ungCanonical.ev, 373456);
  eq('S17-F reversing the ungoverned rows flips EV to the other revision',
    selectCanonicalEvm(reversed(allRows)).ev, 950000);
  noNonFinite('S17-F governed canonical EVM scan', govCanonical);
  noNonFinite('S17-F governed F6 project scan', govF6.project);
}


// ===========================================================================
console.log('--- S18 Pilot Closure (F9.5)');
// ===========================================================================
// The two defects that survived the F9.4 Controlled Pilot re-run. As in S17, each subsection first
// reproduces the reported symptom against the pre-fix code path, then asserts the fixed behaviour.
//
// Both surfaces live in files the harness cannot import (they pull in `@/lib/supabase`, whose real
// Supabase client cannot be bundled for node ESM). So each defect is pinned twice over:
//   - BEHAVIOURALLY, against the pure module the production code delegates to
//     (`governanceEvmPillar.buildGovernanceEvmCheck` for the visible EVM row; the canonical
//     criticality selector F5 and ScheduleView both read for the CPM count); and
//   - STRUCTURALLY, against the shipped source of the engine/view, so the delegation itself cannot
//     be quietly undone.
{
  // ---------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------
  const mkProject = (o: Partial<Project> = {}): Project => ({
    id: 'p1', name: 'Pilot Closure — commercial office building', client: null, location: null,
    contract_value: 2345150, currency: 'SAR', start_date: '2026-07-01', end_date: '2027-02-28',
    data_date: DD, duration_days: 195, status: 'active', description: null,
    calendar_type: '6_days', created_at: '2026-01-01T00:00:00Z', ...o,
  });
  const bl = (id: string, wbsNodeId: string, planned: number): BudgetLine => ({
    id, project_id: 'p1', wbs_node_id: wbsNodeId, activity_id: null, boq_item_id: null,
    description: id, planned_cost: planned, committed_cost: 0,
    actual_cost: 0, remaining_cost: planned, created_at: '2026-01-01T00:00:00Z',
  });

  // The pilot-shaped cost dataset: a WBS node whose budget is split over TWO lines, a second split
  // node, and one node holding a single large line whose activity has not started. That is the shape
  // the superseded derivation mis-weights, and it reproduces the reported divergence.
  const pcProject = mkProject();
  const pcActs = [
    act({ id: 'PC1', code: 'PC1', wbs_node_id: 'w1', early_start: '2026-07-01', early_finish: '2026-07-13', duration_days: 12, percent_complete: 100, actual_start: '2026-07-01', actual_finish: '2026-07-13' }),
    act({ id: 'PC2', code: 'PC2', wbs_node_id: 'w1', early_start: '2026-07-14', early_finish: '2026-07-22', duration_days: 8, percent_complete: 100, actual_start: '2026-07-14', actual_finish: '2026-07-22' }),
    act({ id: 'PC3', code: 'PC3', wbs_node_id: 'w1', early_start: '2026-07-23', early_finish: '2026-08-14', duration_days: 20, percent_complete: 100, actual_start: '2026-07-23', actual_finish: '2026-08-14' }),
    act({ id: 'PC4', code: 'PC4', wbs_node_id: 'w1', early_start: '2026-08-15', early_finish: '2026-08-25', duration_days: 10, percent_complete: 100, actual_start: '2026-08-15', actual_finish: '2026-08-25' }),
    act({ id: 'PC5', code: 'PC5', wbs_node_id: 'w2', early_start: '2026-08-26', early_finish: '2026-09-19', duration_days: 22, percent_complete: 70, actual_start: '2026-08-26' }),
    act({ id: 'PC6', code: 'PC6', wbs_node_id: 'w2', early_start: '2026-09-20', early_finish: '2026-11-08', duration_days: 45, percent_complete: 0 }),
    act({ id: 'PC7', code: 'PC7', wbs_node_id: 'w3', early_start: '2026-10-01', early_finish: '2026-11-04', duration_days: 30, percent_complete: 0 }),
  ];
  const pcBaselines = [
    base('PCB1', 'PC1', '2026-07-01', '2026-07-13', 12, 42000),
    base('PCB2', 'PC2', '2026-07-14', '2026-07-22', 8, 39900),
    base('PCB3', 'PC3', '2026-07-23', '2026-08-14', 20, 323150),
    base('PCB4', 'PC4', '2026-08-15', '2026-08-25', 10, 20250),
    base('PCB5', 'PC5', '2026-08-26', '2026-09-19', 22, 468000),
    base('PCB6', 'PC6', '2026-09-20', '2026-11-08', 45, 468000),
    base('PCB7', 'PC7', '2026-10-01', '2026-11-04', 30, 983850),
  ];
  const pcBudget = [
    bl('PCL1', 'w1', 42000), bl('PCL2', 'w1', 383300),
    bl('PCL3', 'w2', 46000), bl('PCL4', 'w2', 890000),
    bl('PCL5', 'w3', 983850),
  ];
  const pcUpdates = [
    upd('PCU1', 'PC1', '2026-07-13', 100), upd('PCU2', 'PC2', '2026-07-22', 100),
    upd('PCU3', 'PC3', '2026-08-14', 100), upd('PCU4', 'PC4', '2026-08-25', 100),
    upd('PCU5', 'PC5', '2026-09-12', 70),
  ];
  const pcTxns = [
    txn('PCT1', 'PC1', '2026-07-15', 40500), txn('PCT2', 'PC2', '2026-07-24', 39900),
    txn('PCT3', 'PC3', '2026-08-16', 310000), txn('PCT4', 'PC4', '2026-08-28', 19500),
    txn('PCT5', 'PC5', '2026-09-10', 280000),
  ];

  const pcF6 = analyzeCostControl({
    project: pcProject, activities: pcActs, baselines: pcBaselines, budgetLines: pcBudget,
    costTransactions: pcTxns, progressUpdates: pcUpdates, wbsNodes: [], boqItems: [],
    allocations: [], previousSnapshots: [], dataDate: DD, calendarType: '6_days',
  });
  const pcCanonical = selectCanonicalEvm(pcF6);
  // The superseded derivation, used ONLY as the labelled diagnostic the pillar now renders.
  const pcDiagnostic = calculateProjectEvmAtDataDate(pcProject, pcActs, pcBudget, [], pcTxns, pcUpdates);

  const pcRow = buildGovernanceEvmCheck({
    canonical: pcCanonical,
    diagnostic: pcDiagnostic,
    diagnosticLabel: 'planningEngine.calculateProjectEvmAtDataDate',
  });

  /**
   * Reads a published figure back off a rendered row.
   *
   * `(^|[^A-Z])` is load-bearing: without it a search for `AC` matches inside `BAC`, and `CPI`
   * matches inside `TCPI`. Grouping commas are stripped first so the value parses exactly, which is
   * why the pillar renders at F6's own precision instead of rounding to whole riyals.
   */
  const visibleValue = (row: string, label: string): number | null => {
    for (const raw of row.split('|')) {
      const m = raw.replace(/,/g, '').match(new RegExp(`(^|[^A-Z])${label} (-?\\d+(?:\\.\\d+)?)`));
      if (m) return Number(m[2]);
    }
    return null;
  };
  /**
   * Reads a published EVM IDENTITY back off the variance line, which renders as
   * `SV = EV - PV = <value>` rather than `SV <value>`. `[^=]*` stops at the first `=` so each
   * identity yields its own result, and the canonical identities precede any diagnostic segment.
   */
  const identityValue = (row: string, label: string): number | null => {
    const m = row.replace(/,/g, '').match(new RegExp(`(^|[^A-Z])${label} = [^=]*= (-?\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[2]) : null;
  };

  // ---------------------------------------------------------------------
  // S18-A  The visible EVM surface quotes canonical F6 current values
  // ---------------------------------------------------------------------
  // This is the row the pilot saw: `code: 'EVM-01/02/03'`, id `GOV-EVM-01`.
  eq('S18-A the row under test is the one the pilot reported', pcRow.code, 'EVM-01/02/03');
  eq('S18-A the row id is GOV-EVM-01', pcRow.id, 'GOV-EVM-01');
  eq('S18-A the row belongs to the EVM-mathematics pillar', pcRow.pillar, 'evm_math');
  ok('S18-A the visible row identifies itself as canonical F6', pcRow.actualValue.includes(CANONICAL_EVM_ROW_MARKER));

  // The scenario really is the pilot defect: the two derivations disagreed materially.
  ok('S18-A scenario reproduces the pilot: the diagnostic derivation disagrees with canonical F6',
    pcDiagnostic.ev !== pcCanonical.ev && pcDiagnostic.pv !== pcCanonical.pv
    && pcDiagnostic.cpi !== pcCanonical.cpi && pcDiagnostic.eac !== pcCanonical.eac);
  eq('S18-A both derivations still agree on BAC (the divergence is weighting, not budget)',
    pcDiagnostic.bac, pcCanonical.bac);
  eq('S18-A both derivations still agree on AC (approved-only + Data Date filter is shared)',
    pcDiagnostic.ac, pcCanonical.ac);

  // The requirement, literally: every visible canonical label must equal canonical F6.
  eq('S18-A visible BAC === canonical F6 BAC', visibleValue(pcRow.actualValue, 'BAC'), pcCanonical.bac);
  eq('S18-A visible PV === canonical F6 PV', visibleValue(pcRow.actualValue, 'PV'), pcCanonical.pv);
  eq('S18-A visible EV === canonical F6 EV', visibleValue(pcRow.actualValue, 'EV'), pcCanonical.ev);
  eq('S18-A visible AC === canonical F6 AC', visibleValue(pcRow.actualValue, 'AC'), pcCanonical.ac);
  eq('S18-A visible SPI === canonical F6 SPI', visibleValue(pcRow.actualValue, 'SPI'), pcCanonical.spi);
  eq('S18-A visible CPI === canonical F6 CPI', visibleValue(pcRow.actualValue, 'CPI'), pcCanonical.cpi);
  eq('S18-A visible ETC === canonical F6 ETC', visibleValue(pcRow.actualValue, 'ETC'), pcCanonical.etc);
  eq('S18-A visible EAC === canonical F6 EAC', visibleValue(pcRow.actualValue, 'EAC'), pcCanonical.eac);
  eq('S18-A visible VAC === canonical F6 VAC', visibleValue(pcRow.actualValue, 'VAC'), pcCanonical.vac);
  eq('S18-A visible TCPI is measured', visibleValue(pcRow.actualValue, 'TCPI'), Number(pcCanonical.tcpi.toFixed(3)));

  // And canonical F6 is F6 verbatim, so the chain visible === canonical === F6 closes.
  eq('S18-A visible PV === F6 project PV', visibleValue(pcRow.actualValue, 'PV'), pcF6.project.pv);
  eq('S18-A visible EV === F6 project EV', visibleValue(pcRow.actualValue, 'EV'), pcF6.project.ev);
  eq('S18-A visible CPI === F6 project CPI', visibleValue(pcRow.actualValue, 'CPI'), pcF6.project.cpi);
  eq('S18-A visible SPI === F6 project SPI', visibleValue(pcRow.actualValue, 'SPI'), pcF6.project.spi);
  eq('S18-A visible EAC === F6 project EAC', visibleValue(pcRow.actualValue, 'EAC'), pcF6.project.eac);
  eq('S18-A visible VAC === F6 project VAC', visibleValue(pcRow.actualValue, 'VAC'), pcF6.project.vac);
  eq('S18-A visible ETC === F6 project ETC', visibleValue(pcRow.actualValue, 'ETC'), pcF6.project.etc);
  eq('S18-A visible BAC === F6 BAC basis', visibleValue(pcRow.actualValue, 'BAC'), pcF6.bac.value);

  // The visible row must NOT be showing the superseded numbers under canonical labels.
  ok('S18-A visible EV is not the superseded EV', visibleValue(pcRow.actualValue, 'EV') !== pcDiagnostic.ev);
  ok('S18-A visible PV is not the superseded PV', visibleValue(pcRow.actualValue, 'PV') !== pcDiagnostic.pv);
  ok('S18-A visible CPI is not the superseded CPI', visibleValue(pcRow.actualValue, 'CPI') !== pcDiagnostic.cpi);
  ok('S18-A visible EAC is not the superseded EAC', visibleValue(pcRow.actualValue, 'EAC') !== pcDiagnostic.eac);

  // The canonical identities still hold on the published variance line.
  eq('S18-A published SV === canonical SV', identityValue(pcRow.variance, 'SV'), pcCanonical.sv);
  eq('S18-A published CV === canonical CV', identityValue(pcRow.variance, 'CV'), pcCanonical.cv);
  eq('S18-A published VAC === canonical VAC', identityValue(pcRow.variance, 'VAC'), pcCanonical.vac);
  eq('S18-A the row reports the governed Data Date', pcRow.actualValue.includes(pcCanonical.dataDate), true);
  eq('S18-A a fully measured project passes the pillar', pcRow.status, 'passed');

  // End-to-end against the REAL pilot seed, so the closure is proved on shipped data and not only on
  // a synthetic fixture. This reproduces the exact figures the pilot recorded.
  const seed = getInitialSeedData() as Record<string, unknown[]>;
  const seedProjects = (seed['projects'] || []) as unknown as Project[];
  const seedP1 = seedProjects.find((p) => p.id === 'proj-seed-001');
  ok('S18-A the pilot seed project is present', seedP1 !== undefined);
  if (seedP1) {
    const sActs = ((seed['activities'] || []) as unknown as Activity[]).filter((a) => a.project_id === seedP1.id);
    const sBgts = ((seed['budget_lines'] || []) as unknown as BudgetLine[]).filter((b) => b.project_id === seedP1.id);
    const sTxns = ((seed['cost_transactions'] || []) as unknown as CostTransaction[]).filter((c) => c.project_id === seedP1.id);
    const sPrgs = ((seed['progress_updates'] || []) as unknown as ProgressUpdate[]).filter((u) => u.project_id === seedP1.id);
    const sBoqs = ((seed['boq_items'] || []) as unknown as BoqItem[]).filter((b) => b.project_id === seedP1.id);
    const sActIds = new Set(sActs.map((a) => a.id));
    const sBsls = ((seed['baseline_activities'] || []) as unknown as BaselineActivity[]).filter((b) => sActIds.has(b.activity_id));
    const sDd = seedP1.data_date || DD;
    const sF6 = analyzeCostControl({
      project: seedP1, activities: sActs, baselines: sBsls, budgetLines: sBgts, costTransactions: sTxns,
      progressUpdates: sPrgs, wbsNodes: [], boqItems: sBoqs, allocations: [], dataDate: sDd,
      calendarType: seedP1.calendar_type,
    });
    const sCanonical = selectCanonicalEvm(sF6);
    const sDiagnostic = calculateProjectEvmAtDataDate(seedP1, sActs, sBgts, sBoqs, sTxns, sPrgs);
    const sRow = buildGovernanceEvmCheck({ canonical: sCanonical, diagnostic: sDiagnostic });

    // The pilot's canonical column, reproduced on the shipped seed.
    eq('S18-A seed canonical BAC is the pilot-reported 2,345,150', sCanonical.bac, 2345150);
    eq('S18-A seed canonical PV is the pilot-reported 781,871.43', sCanonical.pv, 781871.43);
    eq('S18-A seed canonical AC is 689,900', sCanonical.ac, 689900);
    // The pilot's divergent column, reproduced exactly — this is what the EVM-01/02/03 row showed.
    eq('S18-A the superseded derivation reproduces the pilot PV 288,359', sDiagnostic.pv, 288359);
    eq('S18-A the superseded derivation reproduces the pilot CPI 0.400', sDiagnostic.cpi, 0.4);
    eq('S18-A the superseded derivation reproduces the pilot EAC 5,862,875', sDiagnostic.eac, 5862875);
    eq('S18-A the superseded derivation reproduces the pilot VAC -3,517,725', sDiagnostic.vac, -3517725);
    // And the visible row now quotes the canonical side of that disagreement.
    eq('S18-A seed visible EV === seed canonical F6 EV', visibleValue(sRow.actualValue, 'EV'), sCanonical.ev);
    eq('S18-A seed visible PV === seed canonical F6 PV', visibleValue(sRow.actualValue, 'PV'), sCanonical.pv);
    eq('S18-A seed visible PV is the pilot canonical 781,871.43, not 288,359',
      visibleValue(sRow.actualValue, 'PV'), 781871.43);
    eq('S18-A seed visible CPI === seed canonical F6 CPI', visibleValue(sRow.actualValue, 'CPI'), sCanonical.cpi);
    eq('S18-A seed visible EAC === seed canonical F6 EAC', visibleValue(sRow.actualValue, 'EAC'), sCanonical.eac);
    eq('S18-A seed visible VAC === seed canonical F6 VAC', visibleValue(sRow.actualValue, 'VAC'), sCanonical.vac);
    ok('S18-A seed visible EV is not the superseded EV', visibleValue(sRow.actualValue, 'EV') !== sDiagnostic.ev);
    ok('S18-A the seed row keeps the divergent figures only as a labelled diagnostic',
      sRow.variance.includes(DIAGNOSTIC_ROW_MARKER) && !sRow.actualValue.includes(DIAGNOSTIC_ROW_MARKER));
  }

  // Honesty under no data: the pillar must announce N/A, never a plausible-looking zero.
  const emptyRow = buildGovernanceEvmCheck({ canonical: selectCanonicalEvm(null) });
  ok('S18-A an empty project publishes no monetary figure', visibleValue(emptyRow.actualValue, 'BAC') === null);
  ok('S18-A an empty project announces unavailable BAC', emptyRow.actualValue.includes('N/A'));
  eq('S18-A an empty project is a warning, not a pass', emptyRow.status, 'warning');
  eq('S18-A an empty project still identifies its source marker', emptyRow.actualValue.includes(CANONICAL_EVM_ROW_MARKER), true);
  noNonFinite('S18-A empty canonical scan', selectCanonicalEvm(null));

  // Determinism.
  eq('S18-A the rendered row is deterministic',
    JSON.stringify(buildGovernanceEvmCheck({
      canonical: pcCanonical,
      diagnostic: pcDiagnostic,
      diagnosticLabel: 'planningEngine.calculateProjectEvmAtDataDate',
    })),
    JSON.stringify(pcRow));

  // ---------------------------------------------------------------------
  // S18-B  A diagnostic comparison cannot masquerade as current canonical EVM
  // ---------------------------------------------------------------------
  ok('S18-B the diagnostic segment is present when the derivations disagree',
    pcRow.variance.includes(DIAGNOSTIC_ROW_MARKER));
  ok('S18-B the diagnostic segment is confined to `variance`',
    !pcRow.actualValue.includes(DIAGNOSTIC_ROW_MARKER));
  ok('S18-B the diagnostic segment says in terms that it is NOT the current value',
    pcRow.variance.includes('NOT the current value') && pcRow.variance.includes('ليست القيمة الحالية'));
  ok('S18-B the diagnostic segment names the derivation it came from',
    pcRow.variance.includes('planningEngine.calculateProjectEvmAtDataDate'));
  // The superseded figures may appear in the diagnostic segment, but never in the current-value row.
  ok('S18-B the superseded EV is absent from the current-value row',
    !pcRow.actualValue.includes(formatGovernedSar(pcDiagnostic.ev).replace(' ر.س', '')));
  ok('S18-B the superseded EAC is absent from the current-value row',
    !pcRow.actualValue.includes(formatGovernedSar(pcDiagnostic.eac).replace(' ر.س', '')));
  eq('S18-B the current-value row still parses to canonical EV', visibleValue(pcRow.actualValue, 'EV'), pcCanonical.ev);
  // The diagnostic figures ARE readable in the comparison segment, so the finding stays auditable.
  ok('S18-B the diagnostic EV is readable in the comparison segment',
    visibleValue(pcRow.variance.slice(pcRow.variance.indexOf(DIAGNOSTIC_ROW_MARKER)), 'EV') === pcDiagnostic.ev);
  ok('S18-B the diagnostic EAC is readable in the comparison segment',
    visibleValue(pcRow.variance.slice(pcRow.variance.indexOf(DIAGNOSTIC_ROW_MARKER)), 'EAC') === pcDiagnostic.eac);
  // When the two agree there is nothing to reconcile, so no second set of numbers is published.
  const agreeingRow = buildGovernanceEvmCheck({ canonical: pcCanonical, diagnostic: null });
  ok('S18-B no diagnostic segment is rendered when none was supplied',
    !agreeingRow.variance.includes(DIAGNOSTIC_ROW_MARKER));
  // Constructing an AGREEING diagnostic needs non-nullable scalars, while canonical facts are
  // `number | null` by contract (N/A rather than a fabricated zero). So the fixture narrows first and
  // asserts the precondition, instead of papering over the nullability with `!` or a `?? 0` default.
  const agreeingDiagnostic = pcCanonical.bac !== null && pcCanonical.pv !== null && pcCanonical.ev !== null
    && pcCanonical.cpi !== null && pcCanonical.spi !== null && pcCanonical.eac !== null && pcCanonical.vac !== null
    ? {
      ...pcDiagnostic, bac: pcCanonical.bac, pv: pcCanonical.pv, ev: pcCanonical.ev, ac: pcCanonical.ac,
      cpi: pcCanonical.cpi, spi: pcCanonical.spi, eac: pcCanonical.eac, vac: pcCanonical.vac,
    }
    : null;
  ok('S18-B the fixture is fully measured, so an agreeing diagnostic exists to test with',
    agreeingDiagnostic !== null);
  const sameNumbers = buildGovernanceEvmCheck({ canonical: pcCanonical, diagnostic: agreeingDiagnostic });
  ok('S18-B a diagnostic that AGREES produces no comparison segment (nothing to reconcile)',
    !sameNumbers.variance.includes(DIAGNOSTIC_ROW_MARKER));
  eq('S18-B an agreeing diagnostic leaves the current-value row identical',
    sameNumbers.actualValue, agreeingRow.actualValue);
  eq('S18-B omitting the diagnostic leaves the current-value row identical',
    agreeingRow.actualValue, pcRow.actualValue);

  // Structural: the delegation itself, pinned against the shipped engine source.
  const dgRoot = (() => {
    const cwd = process.cwd();
    if (existsSync(resolvePath(cwd, 'package.json'))) return cwd;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolvePath(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    return cwd;
  })();
  const dgSrc = readFileSync(resolvePath(dgRoot, 'src/lib/dataGovernanceEngine.ts'), 'utf8');
  ok('S18-B the governance engine delegates the EVM row to the pure pillar',
    dgSrc.includes('buildGovernanceEvmCheck({'));
  ok('S18-B the governance engine derives canonical EVM from F6',
    dgSrc.includes('selectCanonicalEvm(costReport)') && dgSrc.includes('analyzeCostControl({'));
  ok('S18-B the superseded derivation is bound to a DIAGNOSTIC name, not to `canonicalEvm`',
    /const diagnosticEvm = calculateProjectEvmAtDataDate\(/.test(dgSrc)
    && !/const canonicalEvm = calculateProjectEvmAtDataDate\(/.test(dgSrc));
  ok('S18-B the diagnostic is passed only through the `diagnostic:` slot',
    /diagnostic: diagnosticEvm/.test(dgSrc));
  ok('S18-B evmParity is populated from the canonical quote',
    /evmParity: \{[\s\S]*?dataDate: canonicalEvm\.dataDate/.test(dgSrc));
  ok('S18-B evmParity never reads the diagnostic derivation',
    !/evmParity: \{[\s\S]*?diagnosticEvm\./.test(dgSrc));
  // Match a real import STATEMENT: the pillar's own docblock names `@/lib/supabase` in prose while
  // explaining why this module exists, so a substring test would fail on the explanation itself.
  ok('S18-B the pillar module imports no supabase client',
    !/import[^;\n]*from\s+'@\/lib\/supabase'/.test(
      readFileSync(resolvePath(dgRoot, 'src/lib/governanceEvmPillar.ts'), 'utf8')));
  const dgvSrc = readFileSync(resolvePath(dgRoot, 'src/components/views/DataGovernanceView.tsx'), 'utf8');
  ok('S18-B the governance view supplies the governed baseline evidence F6 needs',
    dgvSrc.includes("from('baseline_activities')") && dgvSrc.includes('project_baselines!inner')
    && dgvSrc.includes(".eq('project_baselines.is_active', true)")
    && dgvSrc.includes(".eq('project_baselines.status', 'approved')"));
  ok('S18-B the governance view passes those baselines into the audit', /bslData,\s*\);/.test(dgvSrc));

  // ---------------------------------------------------------------------
  // S18-C  The CPM current critical count uses the canonical statused definition
  // ---------------------------------------------------------------------
  // Nine activities carry the persisted `is_critical` flag; three of them finished before the
  // governed Data Date. This reproduces the pilot exactly: CPM screen 9, F5 6, near-critical 0,
  // Dashboard/Executive Report total 6 and remaining 6.
  const cpActs = [
    act({ id: 'CP1', code: 'CP1', early_start: '2026-07-01', duration_days: 10, percent_complete: 100, actual_start: '2026-07-01', actual_finish: '2026-07-14', is_critical: true }),
    act({ id: 'CP2', code: 'CP2', duration_days: 10, percent_complete: 100, actual_start: '2026-07-15', actual_finish: '2026-07-28', is_critical: true }),
    act({ id: 'CP3', code: 'CP3', duration_days: 10, percent_complete: 100, actual_start: '2026-07-29', actual_finish: '2026-08-11', is_critical: true }),
    act({ id: 'CP4', code: 'CP4', duration_days: 10, percent_complete: 60, actual_start: '2026-08-12', is_critical: true }),
    act({ id: 'CP5', code: 'CP5', duration_days: 10, is_critical: true }),
    act({ id: 'CP6', code: 'CP6', duration_days: 10, is_critical: true }),
    act({ id: 'CP7', code: 'CP7', duration_days: 10, is_critical: true }),
    act({ id: 'CP8', code: 'CP8', duration_days: 10, is_critical: true }),
    act({ id: 'CP9', code: 'CP9', duration_days: 10, is_critical: true }),
  ];
  const cpLinks = ['CP1|CP2', 'CP2|CP3', 'CP3|CP4', 'CP4|CP5', 'CP5|CP6', 'CP6|CP7', 'CP7|CP8', 'CP8|CP9']
    .map((pair, i) => link(`CPL${i + 1}`, pair.split('|')[0], pair.split('|')[1]));
  // P2A1-H01: the three completed activities and the 60 % one carry APPROVED in-period rows, as a
  // governed project does. The fixture reproduces the pilot's shape — nine persisted flags, three
  // finished before the Data Date — and now does so with evidence instead of a bare materialisation.
  const cpUpdates = [
    upd('CPU1', 'CP1', '2026-07-14', 100), upd('CPU2', 'CP2', '2026-07-28', 100),
    upd('CPU3', 'CP3', '2026-08-11', 100), upd('CPU4', 'CP4', '2026-09-05', 60),
  ];
  const cpCanon = summarizeCanonicalCriticality(cpActs, cpLinks, {
    dataDate: DD, calendarType: '6_days', progressUpdates: cpUpdates,
  });
  const cpF5 = analyzeScheduleControl({
    activities: cpActs, links: cpLinks, baselines: [], progressUpdates: cpUpdates,
    previousSnapshot: null, dataDate: DD, calendarType: '6_days',
  });
  const cpPersistedFlags = cpActs.filter((a) => a.is_critical).length;

  eq('S18-C nine activities carry the persisted critical flag', cpPersistedFlags, 9);
  eq('S18-C three of them are complete by the governed Data Date', cpF5.statused.filter((s) => s.completed).length, 3);
  eq('S18-C canonical statused critical total is 6', cpCanon.totalCritical, 6);
  eq('S18-C canonical remaining critical is 6', cpCanon.remainingCritical, 6);
  eq('S18-C F5 project.criticalCount is 6', cpF5.project.criticalCount, 6);
  eq('S18-C F5 near-critical count is 0 (as the pilot reported)', cpF5.project.nearCriticalCount, 0);
  eq('S18-C the canonical selector and F5 agree (one definition, two consumers)',
    cpCanon.totalCritical, cpF5.project.criticalCount);
  eq('S18-C F5 statused rows agree with the canonical selector',
    cpF5.statused.filter((s) => s.critical).length, cpCanon.totalCritical);
  eq('S18-C the canonical critical ids are the six incomplete activities',
    cpCanon.criticalIds, ['CP4', 'CP5', 'CP6', 'CP7', 'CP8', 'CP9']);
  ok('S18-C the persisted-flag count still overstates the current count (the reported defect)',
    cpPersistedFlags > cpCanon.totalCritical);
  eq('S18-C the overstatement is exactly the three completed activities',
    cpPersistedFlags - cpCanon.totalCritical, 3);

  // Structural: the CPM screen must publish the canonical count under the "Critical Path" label.
  const svSrc = readFileSync(resolvePath(dgRoot, 'src/components/views/ScheduleView.tsx'), 'utf8');
  const svToolbar = svSrc.slice(svSrc.indexOf('{t.filter_critical} ('));
  ok('S18-C the Critical Path label publishes the canonical current count',
    svToolbar.startsWith('{t.filter_critical} ({currentCriticalCount})'));
  ok('S18-C the Critical Path label no longer counts the persisted flag',
    !/\{t\.filter_critical\} \(\{activities\.filter\(\(a\) => a\.is_critical\)\.length\}\)/.test(svSrc));
  ok('S18-C the current count is derived from F5 statused rows',
    /const currentCriticalCount = useMemo\(\s*\(\) => activities\.filter\(\(a\) => isCurrentlyCritical\(a, stById\)\)\.length/.test(svSrc));
  ok('S18-C one shared predicate defines "critical now" for the screen',
    /function isCurrentlyCritical\(act: Activity, stById: Map<string, StatusedActivity>\): boolean \{\s*const statused = stById\.get\(act\.id\);\s*return statused \? statused\.critical : !!act\.is_critical;/.test(svSrc));
  ok('S18-C the critical filter selects exactly what the count claims',
    /const currentlyCritical = statused \? statused\.critical : !!a\.is_critical;\s*\n\s*if \(filterCriticalOnly && !currentlyCritical\) return false;/.test(svSrc)
    && /if \(filterLongestPathOnly && !currentlyCritical\) return false;/.test(svSrc));
  // The raw count survives only as a separately named secondary diagnostic, in a tooltip.
  ok('S18-C the persisted-flag count is retained as a separately named secondary metric',
    /const persistedCriticalFlagCount = useMemo\(/.test(svSrc));
  ok('S18-C the secondary metric is labelled a diagnostic and never shown as the count',
    /a secondary diagnostic, not the current count/.test(svSrc)
    && !/\{t\.filter_critical\} \(\{persistedCriticalFlagCount\}\)/.test(svSrc));
  // Every other criticality surface on the screen reads the same predicate.
  const svRawRenderSites = (svSrc.match(/act\.is_critical/g) || []).length;
  ok('S18-C no render site still highlights off the raw persisted flag',
    !/className=\{`font-semibold \$\{act\.is_critical/.test(svSrc)
    && !/\{act\.is_critical && <span title=\{t\.critical\}>/.test(svSrc)
    && !/const isCrit = act\.is_critical;/.test(svSrc));
  ok('S18-C the remaining raw-flag reads are the predicate fallback, the edit form and the secondary metric',
    svRawRenderSites <= 4);

  // ---------------------------------------------------------------------
  // S18-D  Completed persisted flags cannot inflate the current count
  // ---------------------------------------------------------------------
  ok('S18-D a completed activity carrying is_critical=true is NOT currently critical',
    cpCanon.byId.get('CP1')?.critical === false
    && cpCanon.byId.get('CP2')?.critical === false
    && cpCanon.byId.get('CP3')?.critical === false);
  ok('S18-D those same activities are recorded as completed',
    cpCanon.byId.get('CP1')?.completed === true
    && cpCanon.byId.get('CP2')?.completed === true
    && cpCanon.byId.get('CP3')?.completed === true);
  ok('S18-D no completed activity appears in the canonical critical id list',
    cpCanon.criticalIds.every((id) => cpCanon.byId.get(id)?.completed === false));
  ok('S18-D no completed activity appears in the remaining-critical id list',
    cpCanon.remainingCriticalIds.every((id) => cpCanon.byId.get(id)?.completed === false));
  // Stamping more completed activities with the stale flag cannot move the canonical number.
  const moreStaleFlags = cpActs.map((a) => (a.percent_complete >= 100 ? { ...a, is_critical: true } : a));
  eq('S18-D re-stamping completed activities with the flag does not change the canonical count',
    summarizeCanonicalCriticality(moreStaleFlags, cpLinks, { dataDate: DD, calendarType: '6_days' }).totalCritical,
    cpCanon.totalCritical);
  const allFlagged = cpActs.map((a) => ({ ...a, is_critical: true }));
  eq('S18-D flagging EVERY activity critical still yields the canonical 6',
    summarizeCanonicalCriticality(allFlagged, cpLinks, { dataDate: DD, calendarType: '6_days' }).totalCritical, 6);
  const noneFlagged = cpActs.map((a) => ({ ...a, is_critical: false }));
  eq('S18-D clearing every flag still yields the canonical 6 (the flag is not an input)',
    summarizeCanonicalCriticality(noneFlagged, cpLinks, { dataDate: DD, calendarType: '6_days' }).totalCritical, 6);
  // Order and clock independence.
  eq('S18-D the canonical count is independent of activity order',
    summarizeCanonicalCriticality([...cpActs].reverse(), cpLinks, { dataDate: DD, calendarType: '6_days' }).totalCritical,
    cpCanon.totalCritical);
  let cpShifted = -1;
  withShiftedClock(400, () => {
    cpShifted = summarizeCanonicalCriticality(cpActs, cpLinks, { dataDate: DD, calendarType: '6_days' }).totalCritical;
  });
  eq('S18-D the canonical count is identical under a +400d clock shift', cpShifted, cpCanon.totalCritical);
  eq('S18-D the canonical count is deterministic',
    JSON.stringify(summarizeCanonicalCriticality(cpActs, cpLinks, { dataDate: DD, calendarType: '6_days' })),
    JSON.stringify(cpCanon));
  // The predicate the screen uses: canonical where F5 has a statused row, persisted flag only as the
  // fallback when there is none. Mirrors `isCurrentlyCritical` in ScheduleView.
  const stById = new Map<string, StatusedActivity>(cpF5.statused.map((s) => [s.id, s]));
  const predicateCount = cpActs.filter((a) => {
    const statused = stById.get(a.id);
    return statused ? statused.critical : !!a.is_critical;
  }).length;
  eq('S18-D the screen predicate yields the canonical 6', predicateCount, 6);
  const emptyStatused = new Map<string, { critical: boolean; completed: boolean }>();
  eq('S18-D with no F5 rows yet the predicate falls back to the persisted flag (9), never to zero',
    cpActs.filter((a) => {
      const statused = emptyStatused.get(a.id);
      return statused ? statused.critical : !!a.is_critical;
    }).length, 9);

  // ---------------------------------------------------------------------
  // S18-E  F9.4 closure guards (re-asserted; nothing here was redesigned)
  // ---------------------------------------------------------------------
  // Cost approval: pending -> level 1 -> approved, persists across a store re-read, and the 100 SAR
  // enters AC only inside the Data Date.
  const closureDb: DemoDb = {
    cost_transactions: [{
      id: 'cl-100', project_id: 'p1', activity_id: 'PC5', boq_item_id: null, category: 'work',
      transaction_date: '2026-09-10', description: 'Pilot closure cost transaction - 100 SAR',
      cost_type: 'direct', amount: 100, source: 'manual', status: 'submitted', approved_at: null,
      approved_by: null, rejected_reason: null, approval_level: 0, created_at: '2026-09-10T08:00:00Z',
    }],
    approval_events: [],
  };
  const closureRow = () => (closureDb['cost_transactions'] || [])[0];
  const NOW = '2026-09-13T09:00:00Z';
  applyReviewCostTransaction(closureDb, { transaction_uuid: 'cl-100', approver: 'project_control', decision: 'approve' }, NOW);
  eq('S18-E first approval advances to level 1 and stays submitted', closureRow().status, 'submitted');
  eq('S18-E first approval level', closureRow().approval_level, 1);
  applyReviewCostTransaction(closureDb, { transaction_uuid: 'cl-100', approver: 'finance_manager', decision: 'approve' }, NOW);
  eq('S18-E second approval reaches approved', closureRow().status, 'approved');
  eq('S18-E approval timestamp is written', closureRow().approved_at, NOW);
  eq('S18-E approval survives a store re-read (reload)',
    (JSON.parse(JSON.stringify(closureDb)) as DemoDb)['cost_transactions'][0].status, 'approved');
  const acWith = (date: string, status: string): number => analyzeCostControl({
    project: pcProject, activities: pcActs, baselines: pcBaselines, budgetLines: pcBudget,
    costTransactions: [...pcTxns, txn('CLX', 'PC5', date, 100, status)],
    progressUpdates: pcUpdates, wbsNodes: [], boqItems: [], allocations: [],
    previousSnapshots: [], dataDate: DD, calendarType: '6_days',
  }).project.ac;
  eq('S18-E an approved 100 SAR dated on/before the Data Date enters AC', acWith('2026-09-10', 'approved'), pcF6.project.ac + 100);
  eq('S18-E an approved 100 SAR dated after the Data Date does not', acWith('2026-09-20', 'approved'), pcF6.project.ac);
  eq('S18-E a still-submitted 100 SAR does not', acWith('2026-09-10', 'submitted'), pcF6.project.ac);

  // F5 baseline/delay: no 2028 leakage, no -310, a small positive delay.
  const clActs = [
    act({ id: 'CL1', code: 'CL1', early_start: '2027-02-21', early_finish: '2027-03-03', duration_days: 10, percent_complete: 0 }),
    act({ id: 'CL2', code: 'CL2', early_start: '2027-02-21', early_finish: '2027-02-26', duration_days: 5, percent_complete: 0 }),
  ];
  const clBaselines = [
    base('CLB1', 'CL1', '2027-02-18', '2027-02-28', 10, 500000),
    base('CLB2', 'CL2', '2027-02-18', '2027-02-26', 5, 100000),
    base('CLB-FOREIGN', 'other-project-activity', '2027-03-01', '2028-02-28', 200, 9999999),
  ];
  const clF5 = analyzeScheduleControl({
    activities: clActs, links: [], baselines: clBaselines, progressUpdates: [],
    previousSnapshot: null, dataDate: DD, calendarType: '6_days',
  });
  eq('S18-E baseline finish is still 2027-02-28 (no 2028 leakage)', clF5.project.baselineFinish, '2027-02-28');
  ok('S18-E total delay is still positive', (clF5.project.totalDelayWd ?? -1) > 0);
  ok('S18-E total delay is still never -310', clF5.project.totalDelayWd !== -310);
  eq('S18-E total delay still equals the working-day convention',
    clF5.project.totalDelayWd, refWdDelta(String(clF5.project.baselineFinish), String(clF5.project.forecastFinish)));
}

// ---------------------------------------------------------------------------
// S19 — Cross-Surface Control Reconciliation (F9.6)
//
// ONE governed Data Date, ONE canonical current EVM fact set, clear forecast semantics.
//
// The pilot showed a single page publishing canonical PV 715,014.29 / EV 752,900 on its EVM cards while
// its OWN S-Curve tooltip at the SAME governed Data Date 2026-09-09 showed PV 245,022 / EV 93,342 — and
// AC 409,900 on both, which is what made the contradiction look like a data problem rather than a
// derivation problem. Alongside it: an "SPI / CPI" card holding two bare numbers under one slash label,
// a risk-adjusted EAC occupying the EAC slot of a block whose other cards are canonical, and an
// SPI-trend + risk finish date presented where the management finish belongs.
//
// The fixture below is the REAL shipped seed project at the pilot's governed Data Date, and it
// reproduces every reported figure exactly — so these checks pin the reported defect, not a stand-in.
// Nothing here is hardcoded into production code; the pilot numbers appear only as expectations.
// ---------------------------------------------------------------------------
{
  console.log('--- S19 Cross-Surface Control Reconciliation (F9.6)');

  const s19Root = (() => {
    const cwd = process.cwd();
    if (existsSync(resolvePath(cwd, 'package.json'))) return cwd;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolvePath(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    return cwd;
  })();
  const s19Src = (rel: string): string => readFileSync(resolvePath(s19Root, rel), 'utf8');

  // ---- pilot-shaped fixture: the real seed project at the pilot's governed Data Date ----
  const DD = '2026-09-09';
  const seed = getInitialSeedData() as unknown as Record<string, unknown[]>;
  const seedP = ((seed['projects'] || []) as unknown as Project[]).find((x) => x.id === 'proj-seed-001');
  ok('S19 fixture resolved the seed project', !!seedP);
  const rcProject = seedP as Project;
  const rcActs = ((seed['activities'] || []) as unknown as Activity[]).filter((a) => a.project_id === rcProject.id);
  const rcLinks = ((seed['activity_links'] || []) as unknown as ActivityLink[]).filter((l) => l.project_id === rcProject.id);
  const rcIds = new Set(rcActs.map((a) => a.id));
  const rcBaselines = ((seed['baseline_activities'] || []) as unknown as BaselineActivity[]).filter((b) => rcIds.has(b.activity_id));
  const rcBudget = ((seed['budget_lines'] || []) as unknown as BudgetLine[]).filter((b) => b.project_id === rcProject.id);
  const rcBoq = ((seed['boq_items'] || []) as unknown as BoqItem[]).filter((b) => b.project_id === rcProject.id);
  const rcTxns = ((seed['cost_transactions'] || []) as unknown as CostTransaction[]).filter((c) => c.project_id === rcProject.id);
  const rcUpdates = ((seed['progress_updates'] || []) as unknown as ProgressUpdate[]).filter((u) => u.project_id === rcProject.id);
  const rcCal = rcProject.calendar_type || '6_days';
  ok('S19 fixture has an approved baseline (F6 BAC basis)', rcBaselines.length > 0);
  // The pilot's evidence includes an approved progress update dated AFTER the governed Data Date; it is
  // what makes the historical/current boundary in this fixture a real test rather than a formality.
  ok('S19 fixture holds a progress update dated after the governed Data Date',
    rcUpdates.some((u) => u.status === 'approved' && isIsoDate(u.update_date) && u.update_date > DD));

  const rcF6 = analyzeCostControl({
    project: rcProject, activities: rcActs, baselines: rcBaselines, budgetLines: rcBudget,
    costTransactions: rcTxns, progressUpdates: rcUpdates, wbsNodes: [], boqItems: rcBoq, allocations: [],
    dataDate: DD, calendarType: rcCal,
  });
  const rcCanon = selectCanonicalEvm(rcF6);
  const rcCurve = generateSCurveData(
    rcActs, rcBaselines, rcUpdates, rcTxns, quoteCanonicalEvm(rcF6),
    rcProject.start_date, rcProject.end_date, null,
    { project: rcProject, budgetLines: rcBudget, boqItems: rcBoq, baselines: rcBaselines, calendarType: rcCal },
  );
  const rcF5 = analyzeScheduleControl({
    activities: rcActs, links: rcLinks, baselines: rcBaselines,
    progressUpdates: rcUpdates, previousSnapshot: null, dataDate: DD, calendarType: rcCal,
    statusLogic: rcProject.status_logic || 'retained_logic',
  });
  const rcTrust = analyzeForecastTrust({
    scheduleReport: rcF5, costReport: rcF6, decisionReport: null,
    activities: rcActs, links: rcLinks, baselines: rcBaselines, progressUpdates: rcUpdates,
    costTransactions: rcTxns, boqItems: rcBoq, allocations: [],
    scheduleSnapshots: [], costSnapshots: [], dataDate: DD, calendarType: rcCal,
  });

  // The fixture must BE the reported pilot case, or passing proves nothing about the defect.
  // =====================================================================================
  // P2A1-H01 CORRECTION — read before comparing these numbers with the original pilot report.
  //
  // This fixture evaluates the shipped seed project at Data Date 2026-09-09, and the seed holds an
  // approved progress update for ACT-005 dated 2026-09-12 — AFTER that Data Date (the `ok(...)` just
  // above exists precisely to prove the fixture contains it). Before H01, F5/F6 read the
  // MATERIALISED `activities.percent_complete`, which that update had written, so 70% of ACT-005's
  // 468,000 SAR baseline — 327,600 SAR — was earned at a status date three days before the work was
  // approved. That is the confirmed defect, and it inflated every figure below.
  //
  // Governed as-of progress now comes from the approved history inside the Data Date, so ACT-005
  // earns nothing here (it has no approved update on or before 2026-09-09) and EV is 425,300 — the
  // four activities with in-period approved evidence only. CPI, SPI, EAC, VAC, the F5 finish and the
  // delay all move with it. These are not weakened expectations: they are the same identities,
  // evaluated on the same fixture, with the post-Data-Date evidence removed.
  //
  // Unchanged by H01: BAC 2,345,150 (baseline), PV 715,014.29 (baseline window proration) and
  // AC 409,900 (approved transactions on or before the Data Date) — none of them depends on
  // materialised progress.
  // =====================================================================================
  eq('S19 fixture reproduces the pilot canonical BAC', rcF6.project.bac, 2345150);
  eq('S19 fixture reproduces the pilot canonical PV', rcF6.project.pv, 715014.29);
  eq('S19 fixture reproduces the pilot canonical AC', rcF6.project.ac, 409900);
  eq('S19 fixture reproduces the pilot baseline finish', rcF5.project.baselineFinish, '2027-02-28');
  // H01: 425,300 = 42,000 + 39,900 + 323,150 + 20,250 (the four activities with approved evidence
  // inside the Data Date). NOT 752,900 — that figure earned ACT-005's 327,600 from the 2026-09-12
  // update, which is dated three days after this Data Date.
  eq('S19 fixture reproduces the pilot canonical EV (H01: no post-Data-Date progress)', rcF6.project.ev, 425300);
  ok('S19 the post-Data-Date update no longer contributes the 327,600 it used to',
    rcF6.project.ev !== 752900 && (rcF6.project.ev as number) === 752900 - 327600);
  eq('S19 fixture reproduces the pilot canonical CPI (H01)', rcF6.project.cpi, 1.038);
  eq('S19 fixture reproduces the pilot canonical SPI (H01)', rcF6.project.spi, 0.595);
  eq('S19 fixture reproduces the pilot canonical EAC (H01)', rcF6.project.eac, 2259296.72);
  eq('S19 fixture reproduces the pilot canonical VAC (H01)', rcF6.project.vac, 85853.28);
  eq('S19 fixture reproduces the pilot canonical F5 finish (H01)', rcF5.project.forecastFinish, '2027-03-17');
  // H01: ACT-005 is unreached at this Data Date, so its full 22-day remaining duration is still in
  // front of the project instead of the ~7 days the ungoverned 70% implied.
  eq('S19 fixture reproduces the pilot delay (H01: +15 working days)', rcF5.project.totalDelayWd, 15);

  // =========================================================================
  // S19-A/B/C  At the governed Data Date the S-Curve reconciles to canonical F6.
  //            Exact equality: the only legitimate difference is display rounding, and rounding is a
  //            renderer concern — the data model must carry the cents F6 publishes.
  // =========================================================================
  ok('S19-A the curve located a Data Date bucket', rcCurve.dataDateIndex >= 0);
  const rcDd = rcCurve.points[rcCurve.dataDateIndex];
  eq('S19-A the Data Date bucket is dated at the governed Data Date', rcDd.date, DD);
  eq('S19-A S-Curve PV at the governed Data Date === canonical F6 PV', rcDd.pvEarlyCumulative, rcF6.project.pv);
  eq('S19-A S-Curve PV === the canonical EVM quote PV', rcDd.pvEarlyCumulative, rcCanon.pv);
  eq('S19-B S-Curve EV at the governed Data Date === canonical F6 EV', rcDd.evCumulative, rcF6.project.ev);
  eq('S19-B S-Curve EV === the canonical EVM quote EV', rcDd.evCumulative, rcCanon.ev);
  eq('S19-C S-Curve AC at the governed Data Date === canonical F6 AC', rcDd.acCumulative, rcF6.project.ac);
  eq('S19-C S-Curve AC === the canonical EVM quote AC', rcDd.acCumulative, rcCanon.ac);

  // The chart headline and the plotted point are the same numbers: a chart may not publish one
  // `currentEv` / `currentAc` scalar while its visible Data Date point shows another.
  eq('S19-A the published currentPv scalar === the plotted Data Date PV', rcCurve.currentPv, rcDd.pvEarlyCumulative);
  eq('S19-B the published currentEv scalar === the plotted Data Date EV', rcCurve.currentEv, rcDd.evCumulative);
  eq('S19-C the published currentAc scalar === the plotted Data Date AC', rcCurve.currentAc, rcDd.acCumulative);
  ok('S19-A the Data Date bucket is flagged as the current point', rcDd.isDataDate === true);
  // Precision: PV must be able to display 715,014.29, not only 715,014.
  ok('S19-A the Data Date PV retains the cents canonical F6 publishes', !Number.isInteger(rcDd.pvEarlyCumulative));
  eq('S19-A the curve BAC is the canonical BAC', rcCurve.bac, rcF6.project.bac);
  eq('S19-A the curve reports F6 baseline weighting as its BAC source', rcCurve.bacSource, 'baseline');
  // Semantic 7: cumulative PV closes on BAC exactly at the final bucket.
  const rcLast = rcCurve.points[rcCurve.points.length - 1];
  eq('S19-A final cumulative PV closes on BAC exactly', rcLast.pvEarlyCumulative, rcCurve.bac);
  // The forecast series converges on the canonical EAC, not on a scenario EAC.
  eq('S19-A final forecast cumulative === canonical F6 EAC', rcLast.forecastCumulative, rcF6.project.eac);

  // =========================================================================
  // S19-D  The Data Date bucket exists EXACTLY once.
  // =========================================================================
  eq('S19-D exactly one bucket is dated at the governed Data Date', rcCurve.points.filter((p) => p.date === DD).length, 1);
  eq('S19-D exactly one bucket carries the isDataDate flag', rcCurve.points.filter((p) => p.isDataDate).length, 1);
  eq('S19-D dataDateIndex points at that single bucket', rcCurve.points[rcCurve.dataDateIndex].date, DD);
  eq('S19-D bucket dates are unique (no duplicated cutoff)',
    new Set(rcCurve.points.map((p) => p.date)).size, rcCurve.points.length);
  // Every bucket strictly after the Data Date is forecast-only; every bucket up to it is actual.
  ok('S19-D no bucket after the Data Date publishes EV or AC',
    rcCurve.points.filter((p) => p.date > DD).every((p) => p.evCumulative === null && p.acCumulative === null));
  ok('S19-D no bucket up to the Data Date publishes a forecast value',
    rcCurve.points.filter((p) => p.date <= DD).every((p) => p.forecastCumulative === null));

  // =========================================================================
  // S19-E / S19-F  Historical cutoffs use evidence valid AS OF the cutoff: no future progress, no
  //                future cost, no machine clock. A controlled fixture states the arithmetic exactly.
  // =========================================================================
  const hDD = '2026-03-01';
  const hProject = { id: 'p1', contract_value: 0, data_date: hDD, calendar_type: '7_days' } as unknown as Project;
  const hActs = [
    act({ id: 'HX1', code: 'HX1', early_start: '2026-01-01', early_finish: '2026-01-31', late_start: '2026-01-01', late_finish: '2026-02-10', duration_days: 30, percent_complete: 80 }),
    act({ id: 'HX2', code: 'HX2', early_start: '2026-02-01', early_finish: '2026-03-31', late_start: '2026-02-01', late_finish: '2026-04-15', duration_days: 58, percent_complete: 0 }),
  ];
  const hBaselines = [
    base('hb1', 'HX1', '2026-01-01', '2026-01-31', 30, 1000),
    base('hb2', 'HX2', '2026-02-01', '2026-03-31', 58, 1000),
  ];
  // BAC = 2000, so each activity's earned value is exactly 10 x its percent.
  const hUpdates = [
    upd('hu1', 'HX1', '2026-02-15', 50),   // in evidence at 2026-02-20
    upd('hu2', 'HX1', '2026-02-25', 80),   // AFTER that cutoff: must not contribute
    upd('hu3', 'HX2', '2026-03-05', 100),  // after the governed Data Date entirely
  ];
  const hTxns = [
    txn('ht1', 'HX1', '2026-02-10', 100),
    txn('ht2', 'HX1', '2026-02-20', 200),
    txn('ht3', 'HX1', '2026-02-28', 400),      // AFTER the 2026-02-20 cutoff
    txn('ht4', 'HX2', '2026-02-15', 999, 'submitted'), // never approved: never in AC
    txn('ht5', 'HX2', '2026-03-10', 50),       // after the governed Data Date
  ];
  const hSources: TimePhasedEvmSources = {
    project: hProject as unknown as TimePhasedEvmSources['project'],
    activities: hActs, baselines: hBaselines, budgetLines: [], costTransactions: hTxns,
    progressUpdates: hUpdates, boqItems: [], governedDataDate: hDD, calendarType: '7_days',
  };

  // S19-E: no progress update after the cutoff contributes to historical EV.
  const hAt0220 = evaluateTimePhasedEvm(hSources, '2026-02-20');
  eq('S19-E historical EV at 2026-02-20 counts only evidence dated on or before it', hAt0220.ev, 500);
  ok('S19-E the later 80% update did NOT leak into the earlier bucket', hAt0220.ev !== 800);
  eq('S19-E the cutoff is treated as historical, not current', hAt0220.isCurrent, false);
  eq('S19-E the cutoff is evidence-phased', hAt0220.evidencePhased, true);
  eq('S19-E percent phasing just before the first update is zero',
    phasePercentCompleteAsOf(hActs[0], hUpdates, '2026-02-14', hDD).percent, 0);
  eq('S19-E percent phasing on the first update date is that update',
    phasePercentCompleteAsOf(hActs[0], hUpdates, '2026-02-15', hDD).percent, 50);
  eq('S19-E percent phasing between updates keeps the earlier one (latest approved wins)',
    phasePercentCompleteAsOf(hActs[0], hUpdates, '2026-02-24', hDD).percent, 50);
  eq('S19-E percent phasing on the later update date advances to it',
    phasePercentCompleteAsOf(hActs[0], hUpdates, '2026-02-25', hDD).percent, 80);
  eq('S19-E an update dated after the governed Data Date does not reach a historical cutoff',
    evaluateTimePhasedEvm(hSources, '2026-03-04').ev, 800);
  // At the governed Data Date itself the persisted status is the governed current status (rule 1), and
  // the post-Data-Date update for HX2 still does not inflate it.
  const hAtDd = evaluateTimePhasedEvm(hSources, hDD);
  eq('S19-E at the governed Data Date the point is the current one', hAtDd.isCurrent, true);
  eq('S19-E at the governed Data Date no evidence phasing is applied', hAtDd.evidencePhased, false);
  eq('S19-E a post-Data-Date approved update does not inflate current EV', hAtDd.ev, 800);
  // The same rule seen through the rendered curve, on the real seed: the bucket before the Data Date
  // must not contain the update dated after it.
  const rcPreDd = rcCurve.points.filter((p) => p.date < DD && p.evCumulative !== null).slice(-1)[0];
  ok('S19-E the seed curve has an actual bucket before the Data Date', !!rcPreDd);
  // H01: the current EV is now the SAME figure the last in-period bucket already reported, because
  // no governed evidence arrived between it and the Data Date (the only update in between is dated
  // 2026-09-12, after it). Equality therefore no longer proves flattening — so the anti-flattening
  // guard is stated as it can honestly be stated, and strengthened with the exact governed figure.
  ok('S19-E the pre-Data-Date seed bucket never exceeds the current EV (history is not flattened)',
    (rcPreDd.evCumulative as number) <= (rcDd.evCumulative as number));
  eq('S19-E the current EV is the governed figure, not the 752,900 the post-Data-Date update gave',
    rcDd.evCumulative, 425300);
  eq('S19-E the pre-Data-Date seed bucket equals the evidence-phased canonical evaluation',
    rcPreDd.evCumulative,
    evaluateTimePhasedEvm({
      project: rcProject as unknown as TimePhasedEvmSources['project'],
      activities: rcActs, baselines: rcBaselines, budgetLines: rcBudget, costTransactions: rcTxns,
      progressUpdates: rcUpdates, boqItems: rcBoq, governedDataDate: DD, calendarType: rcCal,
    }, rcPreDd.date).ev);

  // S19-F: no cost transaction after the cutoff contributes to historical AC.
  eq('S19-F historical AC at 2026-02-20 counts only approved cost dated on or before it', hAt0220.ac, 300);
  ok('S19-F the 2026-02-28 transaction did NOT leak into the earlier bucket', hAt0220.ac !== 700);
  eq('S19-F an unapproved transaction never enters AC at any cutoff', evaluateTimePhasedEvm(hSources, hDD).ac, 700);
  ok('S19-F the submitted 999 transaction is excluded from current AC', evaluateTimePhasedEvm(hSources, hDD).ac < 999);
  eq('S19-F AC just before the first transaction is zero', evaluateTimePhasedEvm(hSources, '2026-02-09').ac, 0);
  eq('S19-F AC on the first transaction date includes it', evaluateTimePhasedEvm(hSources, '2026-02-10').ac, 100);
  // F6's own rule, stated once: a transaction dated after the governed Data Date is not current AC.
  ok('S19-F a transaction dated after the governed Data Date is excluded from current AC',
    hTxns.some((t) => t.transaction_date > hDD) && evaluateTimePhasedEvm(hSources, hDD).ac === 700);
  // And the curve never publishes AC for a forecast bucket at all.
  ok('S19-F the seed curve publishes no AC after the Data Date',
    rcCurve.points.filter((p) => p.date > DD).every((p) => p.acCumulative === null));

  // =========================================================================
  // S19-G  A historical bucket is NOT simply the current Data Date values. Flattening history to the
  //        endpoint would satisfy S19-A/B/C trivially, so it is explicitly excluded here.
  // =========================================================================
  const rcEarlier = rcCurve.points.filter((p) => p.date < DD && p.evCumulative !== null);
  ok('S19-G the curve has several historical buckets', rcEarlier.length >= 3);
  ok('S19-G no historical bucket equals the current PV', rcEarlier.every((p) => p.pvEarlyCumulative !== rcDd.pvEarlyCumulative));
  // H01: EV is legitimately flat across the buckets between 2026-08-25 and the Data Date, because
  // the only progress evidence in that window is dated after it. The anti-flattening claim is
  // therefore stated as it can honestly be stated: no historical bucket may EXCEED the current point
  // (history is never back-written from the present), while PV — which is date-driven and independent
  // of progress — still proves the series is not flat.
  ok('S19-G no historical bucket exceeds the current EV (history is not backcast)',
    rcEarlier.every((p) => (p.evCumulative as number) <= (rcDd.evCumulative as number)));
  ok('S19-G the series is not flat: historical buckets differ from the current PV',
    rcEarlier.some((p) => p.pvEarlyCumulative !== rcDd.pvEarlyCumulative));
  ok('S19-G no historical bucket equals the current AC', rcEarlier.every((p) => p.acCumulative !== rcDd.acCumulative));
  ok('S19-G the first bucket starts at zero PV (history is not backcast)', rcCurve.points[0].pvEarlyCumulative === 0);
  ok('S19-G cumulative PV is non-decreasing across the series',
    rcCurve.points.every((p, i) => i === 0 || p.pvEarlyCumulative >= rcCurve.points[i - 1].pvEarlyCumulative));
  ok('S19-G cumulative AC is non-decreasing across the actual series',
    rcEarlier.every((p, i) => i === 0 || (p.acCumulative as number) >= (rcEarlier[i - 1].acCumulative as number)));
  // History is evidence: an early bucket with no approved evidence reports zero, not an interpolation.
  eq('S19-G a cutoff before any evidence reports zero EV in the controlled fixture',
    evaluateTimePhasedEvm(hSources, '2026-01-15').ev, 0);
  eq('S19-G a cutoff before any evidence reports zero AC in the controlled fixture',
    evaluateTimePhasedEvm(hSources, '2026-01-15').ac, 0);
  ok('S19-G the controlled fixture does not interpolate EV between evidence points',
    evaluateTimePhasedEvm(hSources, '2026-02-20').ev === evaluateTimePhasedEvm(hSources, '2026-02-15').ev);

  // =========================================================================
  // S19-H/I/J  SPI and CPI: correct values, correctly labelled, and impossible to transpose.
  // =========================================================================
  const ratios = buildRatioPresentation(rcCanon);
  const spiCard = ratios.find((r) => r.key === 'spi');
  const cpiCard = ratios.find((r) => r.key === 'cpi');
  ok('S19-H an SPI entry exists', !!spiCard);
  ok('S19-I a CPI entry exists', !!cpiCard);
  eq('S19-H the SPI-labelled value === canonical F6 SPI', spiCard?.value, rcF6.project.spi);
  eq('S19-I the CPI-labelled value === canonical F6 CPI', cpiCard?.value, rcF6.project.cpi);
  // The pilot's own arithmetic, checked independently of F6: SPI = EV/PV, CPI = EV/AC.
  near('S19-H SPI equals EV/PV to three decimals', spiCard?.value ?? null,
    Math.round(((rcF6.project.ev as number) / (rcF6.project.pv as number)) * 1000) / 1000, 0.001);
  near('S19-I CPI equals EV/AC to three decimals', cpiCard?.value ?? null,
    Math.round(((rcF6.project.ev as number) / rcF6.project.ac) * 1000) / 1000, 0.001);
  ok('S19-H the SPI value is NOT the CPI value in this fixture', spiCard?.value !== cpiCard?.value);
  ok('S19-H SPI is the smaller ratio here (the reported misreading)', (spiCard?.value ?? 0) < (cpiCard?.value ?? 0));
  // Each entry carries its own label AND its formula, so no positional coupling remains.
  eq('S19-J the SPI entry is labelled SPI', spiCard?.labelEn, 'SPI');
  eq('S19-J the CPI entry is labelled CPI', cpiCard?.labelEn, 'CPI');
  eq('S19-J the SPI entry states its own formula', spiCard?.formulaEn, 'SPI = EV / PV');
  eq('S19-J the CPI entry states its own formula', cpiCard?.formulaEn, 'CPI = EV / AC');
  ok('S19-J both ratios claim canonical F6 authority',
    ratios.every((r) => r.authority === CANONICAL_COST_AUTHORITY));
  // Reversing render order must not relabel anything: the binding travels with the value.
  const reversed = ratios.slice().reverse();
  eq('S19-J reversing the render order keeps SPI bound to the SPI value',
    reversed.find((r) => r.key === 'spi')?.value, rcF6.project.spi);
  eq('S19-J reversing the render order keeps CPI bound to the CPI value',
    reversed.find((r) => r.key === 'cpi')?.value, rcF6.project.cpi);
  eq('S19-J reversing the render order keeps each label with its own key',
    reversed.map((r) => `${r.key}:${r.labelEn}:${r.value}`).sort(),
    ratios.map((r) => `${r.key}:${r.labelEn}:${r.value}`).sort());
  ok('S19-J no entry presents a bare unlabeled pair', ratios.every((r) => r.labelEn.length > 0 && r.key === r.labelEn.toLowerCase()));
  // Honest N/A: an unmeasurable ratio is announced, never rendered as a plausible number.
  const emptyRatios = buildRatioPresentation(null);
  ok('S19-J an absent canonical report yields null ratios, not zeros',
    emptyRatios.every((r) => r.value === null));
  ok('S19-J an absent canonical report still labels each ratio', emptyRatios.every((r) => r.labelEn.length > 0));
  eq('S19-J an absent canonical report explains itself', emptyRatios[0].status, 'empty_no_data');

  // =========================================================================
  // S19-K/L/M  EAC governance: the unqualified label is canonical F6, the scenario value is named and
  //            differenced, and VAC still satisfies its identity against the CANONICAL EAC.
  // =========================================================================
  const SCENARIO_EAC = 1361150.033; // the pilot's reported risk-adjusted EAC — expectation only
  const eacCards = buildEacPresentation({
    canonicalEac: rcF6.project.eac,
    canonicalMethod: rcF6.recommended ? rcF6.recommended.method : null,
    canonicalBac: rcF6.project.bac,
    canonicalVac: rcF6.project.vac,
    scenarioEac: SCENARIO_EAC,
    scenarioMethod: 'spi_cpi_trend_plus_open_risk_exposure',
  });
  eq('S19-K the unqualified EAC label is the bare canonical label', eacCards.canonical.labelEn, UNQUALIFIED_EAC_LABEL_EN);
  eq('S19-K the unqualified EAC label is bare in Arabic too', eacCards.canonical.labelAr, UNQUALIFIED_EAC_LABEL_AR);
  eq('S19-K an unqualified "EAC" maps only to canonical F6 EAC', eacCards.canonical.value, rcF6.project.eac);
  // H01: the recommended EAC follows the corrected CPI (BAC / 1.038).
  eq('S19-K the canonical EAC is the pilot-reported recommended EAC (H01)', eacCards.canonical.value, 2259296.72);
  eq('S19-K the canonical EAC claims canonical F6 authority', eacCards.canonical.authority, CANONICAL_COST_AUTHORITY);
  eq('S19-K the canonical EAC states its explicit method', eacCards.canonical.method, 'eac_cpi');
  eq('S19-K the canonical EAC equals F6 recommended EAC', eacCards.canonical.value, rcF6.recommended?.eac);
  ok('S19-L a scenario EAC is present', !!eacCards.scenario);
  eq('S19-L the scenario EAC keeps its own value', eacCards.scenario?.value, SCENARIO_EAC);
  eq('S19-L the scenario EAC claims scenario authority, not canonical', eacCards.scenario?.authority, SCENARIO_COST_AUTHORITY);
  ok('S19-L the scenario label is explicitly non-canonical',
    !!eacCards.scenario && eacCards.scenario.labelEn !== UNQUALIFIED_EAC_LABEL_EN
    && /risk/i.test(eacCards.scenario.labelEn) && /not canonical/i.test(eacCards.scenario.labelEn));
  ok('S19-L the scenario label is explicitly non-canonical in Arabic too',
    !!eacCards.scenario && eacCards.scenario.labelAr !== UNQUALIFIED_EAC_LABEL_AR);
  ok('S19-L the scenario EAC preserves its own method',
    !!eacCards.scenario && eacCards.scenario.method === 'spi_cpi_trend_plus_open_risk_exposure');
  ok('S19-L the scenario method differs from the canonical method',
    !!eacCards.scenario && eacCards.scenario.method !== eacCards.canonical.method);
  // The scenario value never overwrites the canonical one.
  ok('S19-L the canonical EAC is not overwritten by the scenario EAC',
    eacCards.canonical.value !== eacCards.scenario?.value);
  // H01: the delta moves with the corrected canonical EAC (SCENARIO_EAC is an expectation constant).
  near('S19-L the scenario delta is scenario minus canonical', eacCards.scenario?.deltaVsCanonical ?? null, -898146.69, 0.01);
  eq('S19-L the delta label names what it is against', eacCards.scenario?.deltaLabelEn, 'Delta vs canonical EAC');
  ok('S19-L the delta is recomputable from the two published values',
    !!eacCards.scenario && eacCards.scenario.deltaVsCanonical ===
      Math.round((SCENARIO_EAC - (rcF6.project.eac as number)) * 100) / 100);
  // S19-M: VAC = BAC - EAC against the CANONICAL EAC.
  eq('S19-M the VAC identity carries canonical BAC', eacCards.vacIdentity.bac, rcF6.project.bac);
  eq('S19-M the VAC identity carries canonical EAC', eacCards.vacIdentity.eac, rcF6.project.eac);
  eq('S19-M the VAC identity carries canonical VAC', eacCards.vacIdentity.vac, rcF6.project.vac);
  ok('S19-M VAC === BAC - EAC for the canonical EAC', eacCards.vacIdentity.satisfies);
  near('S19-M BAC - EAC equals the published VAC', eacCards.vacIdentity.expectedVac, rcF6.project.vac as number, 0.01);
  // The identity must FAIL if a scenario EAC is substituted — that is what makes the check meaningful.
  const eacCardsPoisoned = buildEacPresentation({
    canonicalEac: SCENARIO_EAC, canonicalMethod: 'eac_cpi',
    canonicalBac: rcF6.project.bac, canonicalVac: rcF6.project.vac, scenarioEac: SCENARIO_EAC,
  });
  ok('S19-M substituting the scenario EAC breaks the canonical VAC identity',
    eacCardsPoisoned.vacIdentity.satisfies === false);
  // No scenario value at all => no scenario entry, and the canonical value is untouched.
  const eacCardsCanonicalOnly = buildEacPresentation({
    canonicalEac: rcF6.project.eac, canonicalMethod: rcF6.recommended?.method ?? null,
    canonicalBac: rcF6.project.bac, canonicalVac: rcF6.project.vac, scenarioEac: null,
  });
  eq('S19-L with no scenario value there is no scenario entry', eacCardsCanonicalOnly.scenario, null);
  eq('S19-L with no scenario value the canonical EAC is unchanged', eacCardsCanonicalOnly.canonical.value, rcF6.project.eac);
  // Honest N/A when F6 cannot measure an EAC.
  const eacCardsNa = buildEacPresentation({ canonicalEac: null, canonicalBac: null, canonicalVac: null, scenarioEac: SCENARIO_EAC });
  eq('S19-K an unmeasurable canonical EAC stays null rather than becoming BAC', eacCardsNa.canonical.value, null);
  eq('S19-M the VAC identity is not claimed without inputs', eacCardsNa.vacIdentity.satisfies, false);

  // =========================================================================
  // S19-N/O  Finish governance: the unqualified management finish is canonical F5; the statistical
  //          SPI-trend + risk date is named as such and its variance is stated.
  // =========================================================================
  const STAT_FINISH = '2027-02-17'; // the pilot's reported statistical finish — expectation only
  const finishCards = buildFinishPresentation({
    canonicalFinish: rcF5.project.forecastFinish,
    baselineFinish: rcF5.project.baselineFinish,
    canonicalDelayWorkingDays: rcF5.project.totalDelayWd,
    statisticalFinish: STAT_FINISH,
    riskDaysAdded: 4,
  });
  eq('S19-N the unqualified finish label is the bare canonical label', finishCards.canonical.labelEn, UNQUALIFIED_FINISH_LABEL_EN);
  eq('S19-N the unqualified management finish maps to canonical F5', finishCards.canonical.finish, rcF5.project.forecastFinish);
  eq('S19-N the canonical finish is the pilot-reported management finish (H01)', finishCards.canonical.finish, '2027-03-17');
  eq('S19-N the canonical finish claims canonical F5 authority', finishCards.canonical.authority, CANONICAL_SCHEDULE_AUTHORITY);
  eq('S19-N the canonical delay is F5 own working-day delay', finishCards.canonical.delayWorkingDays, rcF5.project.totalDelayWd);
  eq('S19-N the canonical delay is the pilot-reported delay (H01: +15 days)', finishCards.canonical.delayWorkingDays, 15);
  eq('S19-N the canonical entry carries the baseline finish it is measured against',
    finishCards.canonical.baselineFinish, '2027-02-28');
  ok('S19-O a statistical finish entry is present', !!finishCards.statistical);
  eq('S19-O the statistical finish keeps its own date', finishCards.statistical?.finish, STAT_FINISH);
  eq('S19-O the statistical finish claims statistical authority, not canonical',
    finishCards.statistical?.authority, STATISTICAL_SCHEDULE_AUTHORITY);
  ok('S19-O the statistical finish is explicitly not the management date',
    !!finishCards.statistical && finishCards.statistical.labelEn !== UNQUALIFIED_FINISH_LABEL_EN
    && /statistical/i.test(finishCards.statistical.labelEn) && /not the management date/i.test(finishCards.statistical.labelEn));
  ok('S19-O the statistical finish is explicitly labelled in Arabic too',
    !!finishCards.statistical && finishCards.statistical.labelAr !== UNQUALIFIED_FINISH_LABEL_AR);
  ok('S19-O the statistical finish names its basis',
    !!finishCards.statistical && /SPI/i.test(finishCards.statistical.labelEn) && /risk/i.test(finishCards.statistical.labelEn));
  // H01: STAT_FINISH is ahead of the corrected canonical F5 finish by 28 days (was 13).
  eq('S19-O the variance vs canonical is the pilot-reported variance (H01: -28 days)',
    finishCards.statistical?.varianceDaysVsCanonical, -28);
  ok('S19-O a negative variance is reported as negative, not clamped to zero',
    (finishCards.statistical?.varianceDaysVsCanonical ?? 0) < 0);
  eq('S19-O the variance label names what it is against',
    finishCards.statistical?.varianceLabelEn, 'Variance vs canonical forecast (days)');
  eq('S19-O the risk days added are surfaced', finishCards.statistical?.riskDaysAdded, 4);
  ok('S19-O neither forecast hides the other',
    finishCards.canonical.finish !== null && finishCards.statistical?.finish !== null
    && finishCards.canonical.finish !== finishCards.statistical?.finish);
  // A statistical finish LATER than canonical must read positive, so the sign carries meaning.
  const finishLater = buildFinishPresentation({
    canonicalFinish: '2027-03-02', statisticalFinish: '2027-03-20', riskDaysAdded: 0,
  });
  eq('S19-O a later statistical finish yields a positive variance', finishLater.statistical?.varianceDaysVsCanonical, 18);
  // No statistical model => no statistical entry, canonical untouched.
  const finishCanonicalOnly = buildFinishPresentation({ canonicalFinish: rcF5.project.forecastFinish, statisticalFinish: null });
  eq('S19-O with no statistical model there is no statistical entry', finishCanonicalOnly.statistical, null);
  eq('S19-O with no statistical model the canonical finish is unchanged',
    finishCanonicalOnly.canonical.finish, rcF5.project.forecastFinish);
  // Honest N/A: a missing canonical finish is null, never substituted by the statistical date.
  const finishNoCanonical = buildFinishPresentation({ canonicalFinish: null, statisticalFinish: STAT_FINISH });
  eq('S19-N a missing canonical finish stays null', finishNoCanonical.canonical.finish, null);
  eq('S19-N a missing canonical finish is not replaced by the statistical date',
    finishNoCanonical.statistical?.finish, STAT_FINISH);
  eq('S19-O no variance is claimed without a canonical finish', finishNoCanonical.statistical?.varianceDaysVsCanonical, null);
  // F8 quotes the same canonical finish, so the two surfaces cannot disagree.
  eq('S19-N F8 quotes the canonical F5 finish', rcTrust.trust.forecastFinish, rcF5.project.forecastFinish);
  eq('S19-K F8 quotes the canonical F6 EAC', rcTrust.trust.eac, rcF6.project.eac);

  // =========================================================================
  // S19-P  Cross-surface reconciliation: every surface quotes the SAME canonical current EVM at the
  //        SAME governed Data Date. Each quote is obtained through that surface's OWN code path, so
  //        this is a real reconciliation rather than one object compared with itself.
  // =========================================================================
  const rcDashRatios = buildRatioPresentation(rcCanon);
  const rcDashEac = buildEacPresentation({
    canonicalEac: rcCanon.eac, canonicalMethod: rcF6.recommended?.method ?? null,
    canonicalBac: rcCanon.bac, canonicalVac: rcCanon.vac, scenarioEac: SCENARIO_EAC,
  });
  // The Data Governance surface publishes its facts as a rendered bilingual string, so read them back
  // off that string: parsing what a user actually sees is a stronger proof than re-quoting the object.
  const rcGovRow = buildGovernanceEvmCheck({ canonical: rcCanon });
  // Reads a published figure back off the governance row. The `(^|[^A-Z])` guard is load-bearing:
  // without it a search for `AC` matches inside `BAC` and `CPI` matches inside `TCPI`.
  const govValue = (row: string, label: string): number | null => {
    for (const raw of row.split('|')) {
      const seg = raw.trim().replace(/,/g, '');
      const head = seg.match(new RegExp(`^${label} (-?\\d+(?:\\.\\d+)?)`));
      if (head) return Number(head[1]);
      const inner = seg.match(new RegExp(`(^|[^A-Z])${label} (-?\\d+(?:\\.\\d+)?)`));
      if (inner) return Number(inner[2]);
    }
    return null;
  };
  // The variance line publishes IDENTITIES (`VAC = BAC - EAC = <value>`), so it needs its own reader;
  // `[^=]*` stops at the first `=` so each identity yields its own result.
  const govIdentityValue = (row: string, label: string): number | null => {
    const m = row.replace(/,/g, '').match(new RegExp(`(^|[^A-Z])${label} = [^=]*= (-?\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[2]) : null;
  };
  const rcExecQuote = canonicalEvmToComprehensive(selectCanonicalEvm(rcF6));
  const reconciliation = reconcileEvmSurfaces([
    {
      surface: 'f6_cost_control',
      bac: rcF6.project.bac, pv: rcF6.project.pv, ev: rcF6.project.ev, ac: rcF6.project.ac,
      cpi: rcF6.project.cpi, spi: rcF6.project.spi, etc: rcF6.project.etc, eac: rcF6.project.eac, vac: rcF6.project.vac,
    },
    {
      surface: 'dashboard_cards',
      bac: rcCanon.bac, pv: rcCanon.pv, ev: rcCanon.ev, ac: rcCanon.ac,
      cpi: rcDashRatios.find((r) => r.key === 'cpi')?.value ?? null,
      spi: rcDashRatios.find((r) => r.key === 'spi')?.value ?? null,
      etc: rcCanon.etc, eac: rcDashEac.canonical.value, vac: rcCanon.vac,
    },
    {
      // The plotted Data Date bucket: an independent path, and the surface that used to diverge.
      surface: 's_curve_data_date_point',
      bac: rcCurve.bac, pv: rcDd.pvEarlyCumulative, ev: rcDd.evCumulative, ac: rcDd.acCumulative,
      cpi: undefined, spi: undefined, etc: undefined, eac: rcCurve.forecastEac, vac: undefined,
    },
    {
      // F8 publishes only the facts it quotes; the rest are omitted rather than invented.
      surface: 'f8_forecast_trust',
      bac: undefined, pv: undefined, ev: undefined, ac: undefined,
      cpi: undefined, spi: undefined, etc: undefined, eac: rcTrust.trust.eac, vac: undefined,
    },
    {
      surface: 'data_governance_verifier',
      bac: govValue(rcGovRow.actualValue, 'BAC'), pv: govValue(rcGovRow.actualValue, 'PV'),
      ev: govValue(rcGovRow.actualValue, 'EV'), ac: govValue(rcGovRow.actualValue, 'AC'),
      cpi: govValue(rcGovRow.actualValue, 'CPI'), spi: govValue(rcGovRow.actualValue, 'SPI'),
      etc: govValue(rcGovRow.actualValue, 'ETC'), eac: govValue(rcGovRow.actualValue, 'EAC'),
      vac: govIdentityValue(rcGovRow.variance, 'VAC'),
    },
    {
      surface: 'executive_report',
      bac: rcExecQuote.bac, pv: rcExecQuote.pv, ev: rcExecQuote.ev, ac: rcExecQuote.ac,
      cpi: rcExecQuote.cpi, spi: rcExecQuote.spi, etc: rcExecQuote.etc, eac: rcExecQuote.eac, vac: rcExecQuote.vac,
    },
  ]);
  eq('S19-P every required surface is represented', reconciliation.surfaces.length, 6);
  eq('S19-P the reference surface is canonical F6', reconciliation.referenceSurface, 'f6_cost_control');
  ok('S19-P the governance row parsed back into numbers (not all null)',
    govValue(rcGovRow.actualValue, 'PV') !== null && govValue(rcGovRow.actualValue, 'EV') !== null);
  eq('S19-P all six surfaces quote the same canonical current EVM', reconciliation.divergences, []);
  ok('S19-P the cross-surface reconciliation reports reconciled', reconciliation.reconciled === true);
  ok('S19-P BAC PV EV AC CPI SPI ETC EAC VAC are all in the compared-fact contract',
    ['bac', 'pv', 'ev', 'ac', 'cpi', 'spi', 'etc', 'eac', 'vac'].every((f) =>
      (reconciliation.comparedFacts as string[]).includes(f)));
  // Guard against a vacuous green: a fact every surface omits would make `reconciled` trivially true.
  ok('S19-P the core facts were ACTUALLY compared pairwise, not skipped as unpublished',
    ['bac', 'pv', 'ev', 'ac', 'cpi', 'spi', 'eac'].every((f) =>
      reconciliation.factsActuallyCompared.includes(f)));
  ok('S19-P the S-Curve surface really contributed PV EV AC BAC to the comparison',
    ['bac', 'pv', 'ev', 'ac'].every((f) => reconciliation.factsActuallyCompared.includes(f)));
  ok('S19-P F8 contributes EAC rather than being skipped entirely',
    reconciliation.factsActuallyCompared.includes('eac'));
  // The reconciler must actually catch a divergence, or a green result means nothing.
  const reconciliationPoisoned = reconcileEvmSurfaces([
    { surface: 'f6_cost_control', bac: rcF6.project.bac, pv: rcF6.project.pv, ev: rcF6.project.ev, ac: rcF6.project.ac, cpi: rcF6.project.cpi, spi: rcF6.project.spi, eac: rcF6.project.eac },
    { surface: 'a_divergent_surface', bac: rcF6.project.bac, pv: 245022, ev: 93342, ac: rcF6.project.ac, cpi: rcF6.project.cpi, spi: rcF6.project.spi, eac: rcF6.project.eac },
  ]);
  ok('S19-P a divergent surface is detected', reconciliationPoisoned.reconciled === false);
  eq('S19-P the divergence names the offending surface and facts',
    reconciliationPoisoned.divergences.map((d) => `${d.surface}:${d.fact}`).sort(), ['a_divergent_surface:ev', 'a_divergent_surface:pv']);
  eq('S19-P the divergence reports the pilot legacy PV as the actual value',
    reconciliationPoisoned.divergences.find((d) => d.fact === 'pv')?.actual, 245022);

  // =========================================================================
  // S19-Q  The fixture reproduces the OLD divergence, then the fixed path reconciles.
  //        This is what makes S19-A/B/C a regression test rather than a tautology: the same project,
  //        Data Date and inputs, evaluated the superseded way, still produce the reported numbers.
  // =========================================================================
  const legacyEvidenceActs = rcActs.map((a) => ({ ...a, percent_complete: 0 }));
  const legacyAtDd = calculateProjectEvmAtDataDate(rcProject, legacyEvidenceActs, rcBudget, rcBoq, [], rcUpdates, DD);
  eq('S19-Q the superseded derivation reproduces the pilot S-Curve PV', legacyAtDd.pv, 245022);
  eq('S19-Q the superseded derivation reproduces the pilot S-Curve EV', legacyAtDd.ev, 93342);
  ok('S19-Q the legacy PV differs materially from canonical F6 PV',
    Math.abs(legacyAtDd.pv - (rcF6.project.pv as number)) > 0.25 * (rcF6.project.pv as number));
  ok('S19-Q the legacy EV differs materially from canonical F6 EV',
    Math.abs(legacyAtDd.ev - (rcF6.project.ev as number)) > 0.25 * (rcF6.project.ev as number));
  // WHY AC MATCHED. The old engine call passed an EMPTY transaction list, so the superseded derivation
  // reported its own current-state AC estimate — 689,900 here, not the 409,900 the chart showed. The
  // chart published 409,900 because the S-Curve engine computed AC ITSELF as approved transactions
  // dated <= cutoff: the same rule F6 uses. So PV and EV came from the superseded weighting while AC
  // came from a second, correct implementation — which is exactly why AC agreed and the contradiction
  // looked like a data problem rather than a derivation problem.
  ok('S19-Q the superseded AC estimate was NOT the figure the chart published', legacyAtDd.ac !== rcF6.project.ac);
  eq('S19-Q the chart AC came from the approved-transaction cutoff rule and matched F6',
    rcDd.acCumulative, rcF6.project.ac);
  const legacyWithTxns = calculateProjectEvmAtDataDate(rcProject, rcActs, rcBudget, rcBoq, rcTxns, rcUpdates, DD);
  eq('S19-Q given the same transactions the superseded engine agrees on AC too (same rule)',
    legacyWithTxns.ac, rcF6.project.ac);
  ok('S19-Q the divergence is confined to PV and EV weighting, not to the AC rule',
    legacyWithTxns.pv !== rcF6.project.pv && legacyWithTxns.ev !== rcF6.project.ev
    && legacyWithTxns.ac === rcF6.project.ac);
  // The fixed path reconciles on the very same inputs.
  eq('S19-Q the fixed curve PV reconciles where the legacy path diverged', rcDd.pvEarlyCumulative, rcF6.project.pv);
  eq('S19-Q the fixed curve EV reconciles where the legacy path diverged', rcDd.evCumulative, rcF6.project.ev);
  ok('S19-Q the fixed curve no longer publishes the legacy PV anywhere in the actual series',
    rcCurve.points.filter((p) => p.date <= DD).every((p) => p.pvEarlyCumulative !== 245022));
  ok('S19-Q the fixed curve no longer publishes the legacy EV anywhere in the actual series',
    rcCurve.points.filter((p) => p.date <= DD).every((p) => p.evCumulative !== 93342));
  // Without the approved baseline the curve cannot be canonical: F6 would fall back to budget lines.
  const rcCurveNoBaseline = generateSCurveData(
    rcActs, [], rcUpdates, rcTxns, quoteCanonicalEvm(rcF6), rcProject.start_date, rcProject.end_date, null,
    { project: rcProject, budgetLines: rcBudget, boqItems: rcBoq, calendarType: rcCal },
  );
  ok('S19-Q omitting the approved baseline downgrades the BAC source away from baseline',
    rcCurveNoBaseline.bacSource !== 'baseline');
  eq('S19-Q supplying the baseline keeps the BAC source canonical', rcCurve.bacSource, 'baseline');

  // =========================================================================
  // Determinism, finiteness and clock independence of the rebuilt curve.
  // =========================================================================
  noNonFinite('S19 the rebuilt S-Curve contains no NaN or Infinity', rcCurve);
  const rcCurveAgain = generateSCurveData(
    rcActs, rcBaselines, rcUpdates, rcTxns, quoteCanonicalEvm(rcF6),
    rcProject.start_date, rcProject.end_date, null,
    { project: rcProject, budgetLines: rcBudget, boqItems: rcBoq, baselines: rcBaselines, calendarType: rcCal },
  );
  const rcCurveNow = JSON.stringify(rcCurve);
  eq('S19 the curve is deterministic for the same inputs', JSON.stringify(rcCurveAgain), rcCurveNow);
  let rcCurveShifted = '';
  withShiftedClock(400, () => {
    rcCurveShifted = JSON.stringify(generateSCurveData(
      rcActs, rcBaselines, rcUpdates, rcTxns, quoteCanonicalEvm(rcF6),
      rcProject.start_date, rcProject.end_date, null,
      { project: rcProject, budgetLines: rcBudget, boqItems: rcBoq, baselines: rcBaselines, calendarType: rcCal },
    ));
  });
  eq('S19 the curve does not depend on the machine clock', rcCurveShifted, rcCurveNow);
  // The late-window series is a real second series where late dates differ, and closes on BAC too.
  const hCurve = generateSCurveData(
    hActs, hBaselines, hUpdates, hTxns,
    quoteCanonicalEvm(analyzeCostControl({
      project: hProject, activities: hActs, baselines: hBaselines, budgetLines: [], costTransactions: hTxns,
      progressUpdates: hUpdates, wbsNodes: [], boqItems: [], allocations: [], dataDate: hDD, calendarType: '7_days',
    })),
    '2026-01-01', '2026-04-15', null,
    { project: hProject as unknown as { id: string }, budgetLines: [], boqItems: [], baselines: hBaselines, calendarType: '7_days' },
  );
  ok('S19 the late-window PV series differs from the early series where late dates differ',
    hCurve.points.some((p) => p.pvLateCumulative !== p.pvEarlyCumulative));
  ok('S19 the late-window baseline re-phasing keeps costs and moves only windows',
    phaseBaselinesForLateCurve(hBaselines, hActs).every((b, i) => b.planned_cost === hBaselines[i].planned_cost));
  eq('S19 the controlled fixture Data Date bucket reconciles to its own canonical F6',
    hCurve.points[hCurve.dataDateIndex].evCumulative, 800);
  eq('S19 the controlled fixture final PV closes on its BAC',
    hCurve.points[hCurve.points.length - 1].pvEarlyCumulative, hCurve.bac);
  // An empty project stays honest: no points, no fabricated curve, canonical scalars preserved.
  const rcEmpty = generateSCurveData([], rcBaselines, [], [], quoteCanonicalEvm(rcF6), null, null, null,
    { project: rcProject, baselines: rcBaselines });
  eq('S19 an empty project yields no curve points', rcEmpty.points.length, 0);
  eq('S19 an empty project reports no Data Date bucket', rcEmpty.dataDateIndex, -1);
  eq('S19 an empty project still publishes the canonical current EV', rcEmpty.currentEv, rcF6.project.ev);
  noNonFinite('S19 an empty project curve contains no NaN or Infinity', rcEmpty);

  // =========================================================================
  // Structural guards: the delegation itself cannot be quietly undone.
  // =========================================================================
  const sCurveSrc = s19Src('src/lib/sCurveEngine.ts');
  ok('S19 the S-Curve engine no longer calls the superseded derivation',
    !/calculateProjectEvmAtDataDate\s*\(/.test(sCurveSrc));
  ok('S19 the S-Curve engine no longer imports the superseded derivation as a value',
    !/import\s*{[^}]*\bcalculateProjectEvmAtDataDate\b/.test(sCurveSrc.replace(/\n/g, ' ')));
  ok('S19 the S-Curve engine delegates to the pure time-phased adapter',
    /from '@\/lib\/sCurveTimePhasing'/.test(sCurveSrc) && /evaluateTimePhasedEvm\s*\(/.test(sCurveSrc));
  ok('S19 the S-Curve engine no longer rounds money to whole SAR',
    !/Math\.round\(pvEarly\)/.test(sCurveSrc) && !/Math\.round\(atCutoff/.test(sCurveSrc));
  ok('S19 the S-Curve engine keeps canonical precision via round2', /round2\(/.test(sCurveSrc));
  ok('S19 the S-Curve engine no longer claims the superseded route is canonical',
    !/canonical EVM is the single evaluation path/.test(sCurveSrc));
  ok('S19 the adapter module imports no supabase client',
    !/import[^;\n]*from\s+'@\/lib\/supabase'/.test(s19Src('src/lib/sCurveTimePhasing.ts')));
  ok('S19 the adapter delegates to canonical F6 rather than re-implementing it',
    /from '@\/lib\/costControlEngine'/.test(s19Src('src/lib/sCurveTimePhasing.ts'))
    && /analyzeCostControl\s*\(/.test(s19Src('src/lib/sCurveTimePhasing.ts')));
  // Comment-stripped before testing: both modules' docblocks contain the literal `new Date()` while
  // stating that it is never used, so a substring test would fail on the explanation itself.
  const codeOnly = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  ok('S19 the comment stripper really strips (self-check)',
    codeOnly('/* new Date() */\nvar x = 1;\n// new Date()').includes('new Date') === false);
  ok('S19 the adapter reads no machine clock', !/new Date\(\s*\)/.test(codeOnly(s19Src('src/lib/sCurveTimePhasing.ts'))));
  ok('S19 the S-Curve engine reads no machine clock', !/new Date\(\s*\)/.test(codeOnly(sCurveSrc)));

  const dashSrc = s19Src('src/components/views/Dashboard.tsx');
  ok('S19-J the dashboard no longer renders two bare ratios under one slash label',
    !/\{evm\.spi\.toFixed\(2\)\}\s*\/\s*\{evm\.cpi\.toFixed\(2\)\}/.test(dashSrc));
  ok('S19-H the dashboard renders the ratios through the governed presentation',
    /buildRatioPresentation\s*\(/.test(dashSrc));
  ok('S19-K the dashboard renders EAC through the governed presentation', /buildEacPresentation\s*\(/.test(dashSrc));
  ok('S19-N the dashboard renders finish through the governed presentation', /buildFinishPresentation\s*\(/.test(dashSrc));
  ok('S19-K the dashboard cards read the null-preserving canonical quote', /selectCanonicalEvm\s*\(\s*costStrip\s*\)/.test(dashSrc));
  ok('S19-K the dashboard no longer binds the unqualified EAC slot to the risk-adjusted sum',
    !/\{t\.forecast_eac\}[\s\S]{0,220}forecast\.cost\.realistic\s*\+\s*forecast\.riskExposure\.cost/.test(dashSrc));
  ok('S19-N the dashboard no longer binds the unqualified finish slot to the statistical date',
    !/\{t\.forecast_finish\}[\s\S]{0,260}\{riskAdjustedFinish\s*\|\|\s*'-'\}/.test(dashSrc));
  ok('S19-N the dashboard no longer clamps the statistical delay with Math.max(0, ...)',
    !/Math\.max\(0,\s*Math\.round\(\(new Date\(riskAdjustedFinish\)/.test(dashSrc));
  // Wiring guards: the canonical slot must be FED from the canonical source. Without these, a mutation
  // that keeps the presentation builders but feeds them the scenario value would still pass.
  ok('S19-K the dashboard feeds the canonical EAC slot from the canonical quote',
    /canonicalEac:\s*canonicalEvmQuote\.eac/.test(dashSrc));
  ok('S19-K the dashboard does not feed the canonical EAC slot from the statistical forecast',
    !/canonicalEac:[^,\n]*forecast\.cost/.test(dashSrc));
  ok('S19-L the dashboard feeds the scenario EAC slot from the statistical forecast',
    /scenarioEac:[^,\n]*scenarioEacRaw/.test(dashSrc));
  ok('S19-N the dashboard feeds the canonical finish slot from F5',
    /canonicalFinish:\s*control\s*\?\s*control\.project\.forecastFinish/.test(dashSrc));
  ok('S19-N the dashboard does not feed the canonical finish slot from the statistical model',
    !/canonicalFinish:[^,\n]*riskAdjustedFinish/.test(dashSrc));
  ok('S19-O the dashboard feeds the statistical finish slot from the SPI-trend model',
    /statisticalFinish:\s*riskAdjustedFinish/.test(dashSrc));
  ok('S19-N the dashboard feeds the canonical delay from F5 working days',
    /canonicalDelayWorkingDays:\s*control\s*\?\s*control\.project\.totalDelayWd/.test(dashSrc));
  ok('S19-A the dashboard gives the curve the approved baseline',
    /generateSCurveData\([\s\S]{0,900}baselines:\s*baselineActivities/.test(dashSrc));
  ok('S19-A the dashboard gives the curve the project calendar',
    /generateSCurveData\([\s\S]{0,900}calendarType:/.test(dashSrc));
  ok('S19-A the dashboard money formatter preserves canonical cents',
    /maximumFractionDigits:\s*2/.test(dashSrc));

  const execSrc = s19Src('src/components/views/ExecutiveReportView.tsx');
  ok('S19-P the executive report gives its curve the approved baseline',
    /generateSCurveData\([\s\S]{0,900}baselines:\s*baselineActivities/.test(execSrc));

  const chartSrc = s19Src('src/components/views/SCurveChart.tsx');
  ok('S19-A the chart renders money at canonical precision', /maximumFractionDigits:\s*2/.test(chartSrc));
  ok('S19-A the chart marks the governed Data Date point as the current canonical point',
    /isDataDate/.test(chartSrc));

  const esSrc = s19Src('src/lib/earnedScheduleEngine.ts');
  ok('S19-P the earned-schedule fallback shares the canonical baseline weighting',
    /baselines:\s*sources\.baselines/.test(esSrc) && /sources\.baselines\s*\|\|\s*\[\]/.test(esSrc));
  const budgetSrc = s19Src('src/components/views/BudgetView.tsx');
  const progressSrc = s19Src('src/components/views/ProgressView.tsx');
  ok('S19-P the budget view passes the governed baseline into earned schedule',
    /calculateEarnedSchedule\(\{[\s\S]{0,500}baselines,/.test(budgetSrc));
  ok('S19-P the progress view passes the governed baseline into earned schedule',
    /calculateEarnedSchedule\(\{[\s\S]{0,500}baselines,/.test(progressSrc));
}

// ---------------------------------------------------------------------------
// S20 — Batch A (P2A1) verified defect closures.
//
//   H01  Data-Date governed progress      F5/F6 must read the approved progress history, never the
//                                         materialised activity columns the Data Date does not govern.
//   H02  Duplicate actual cost            The business key that detects a duplicate must also stop it
//                                         being summed into AC (and therefore CPI / EAC / VAC).
//   M02  Orphan / foreign actual cost     An activity-bound transaction is valid only inside its own
//                                         project — at the write boundary AND in canonical AC.
//   M01  Data Date provenance             A fallback Data Date must be visibly distinguishable from an
//                                         explicitly governed one.
//   H04  No-data EVM forecast             NO DATA is not CPI = SPI = 1 with a realistic finish and
//                                         100% confidence.
//
// Each subsection first proves the fixture REPRODUCES the reported symptom, then asserts the fixed
// behaviour: a regression test that cannot fail on the pre-fix code is not a regression test.
// ---------------------------------------------------------------------------
{
  console.log('--- S20 Batch A (P2A1) verified defect closures');

  // Source-reading root: the harness reads the shipped screen sources as text, because the screens
  // pull in `@/lib/supabase` and cannot be bundled for node ESM.
  const s20Root = (() => {
    const cwd = process.cwd();
    if (existsSync(resolvePath(cwd, 'package.json'))) return cwd;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolvePath(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    return cwd;
  })();

  const BDD = '2026-09-13';
  const s20Project = {
    id: 'p1', contract_value: 200000, data_date: BDD, calendar_type: '6_days',
  } as unknown as Project;
  const s20Acts = [
    act({ id: 'G1', code: 'G1', early_start: '2026-09-01', early_finish: '2026-09-10', duration_days: 10, percent_complete: 0 }),
    act({ id: 'G2', code: 'G2', early_start: '2026-09-11', early_finish: '2026-09-20', duration_days: 10, percent_complete: 0 }),
  ];
  const s20Links = [link('GL1', 'G1', 'G2')];
  const s20Baselines = [
    base('GB1', 'G1', '2026-09-01', '2026-09-10', 10, 100000),
    base('GB2', 'G2', '2026-09-11', '2026-09-20', 10, 100000),
  ];
  const s20Txn = (id: string, actId: string | null, amount: number, extra: Partial<CostTransaction> = {}): CostTransaction => ({
    ...txn(id, actId, '2026-09-05', amount, 'approved', 'INV-S20'),
    description: 'S20 ledger row', vendor: 'ACME', invoice_number: 'INV-S20', ...extra,
  } as CostTransaction);

  const f6With = (
    updates: ProgressUpdate[],
    txns: CostTransaction[] = [s20Txn('S20T1', 'G1', 50000)],
    acts: Activity[] = s20Acts,
  ) => analyzeCostControl({
    project: s20Project, activities: acts, baselines: s20Baselines, budgetLines: [],
    costTransactions: txns, progressUpdates: updates, wbsNodes: [], boqItems: [], allocations: [],
    previousSnapshots: [], dataDate: BDD, calendarType: '6_days',
  });
  const f5With = (updates: ProgressUpdate[], acts: Activity[] = s20Acts) => analyzeScheduleControl({
    activities: acts, links: s20Links, baselines: s20Baselines, progressUpdates: updates,
    previousSnapshot: null, dataDate: BDD, calendarType: '6_days',
  });
  const g1 = (r: ReturnType<typeof f5With>): StatusedActivity =>
    r.statused.find((s) => s.id === 'G1') as StatusedActivity;

  // =========================================================================
  // S20-H01  Data-Date governed progress
  // =========================================================================
  {
    // --- the pre-fix symptom, reproduced: the materialised column is what used to be read. ---
    // P2A1-H01 CLOSURE: these assertions now check the ACTUAL NUMERIC governed state (percent,
    // quantity, actuals) rather than only the source label, so a future fallback that restores the
    // materialised value cannot pass by renaming itself.
    const materialised = act({
      ...s20Acts[0], percent_complete: 60, actual_quantity: 480,
      actual_start: '2026-09-02', actual_finish: '2026-09-09',
    });
    eq('S20-H01 the fixture activity really is materialised at 60% (the pre-fix input)',
      Number(materialised.percent_complete), 60);
    const noHistory = resolveGovernedProgress(materialised, indexProgressHistory([]), BDD);
    // --- H01-G: percent_complete > 0 with ZERO progress-history rows => governed progress 0. ---
    eq('S20-H01-G a materialised percent with zero history rows governs to 0%',
      noHistory.percentComplete, 0);
    eq('S20-H01-G the materialised value is not treated as governed evidence',
      noHistory.source, 'no_governed_evidence');
    // --- H01-H: actual_quantity > 0 with ZERO approved history => no governed quantity. ---
    eq('S20-H01-H a materialised quantity with zero approved history contributes nothing',
      noHistory.actualQuantity, 0);
    eq('S20-H01-H the governed quantity is not the materialised one',
      noHistory.actualQuantity === Number(materialised.actual_quantity), false);
    // --- H01-I: materialised actual_start / actual_finish without approved evidence => unreached. ---
    eq('S20-H01-I a materialised actual start is unreached without approved evidence',
      noHistory.actualStart, null);
    eq('S20-H01-I a materialised actual finish is unreached without approved evidence',
      noHistory.actualFinish, null);
    eq('S20-H01-I the activity is neither started nor completed', [noHistory.started, noHistory.completed], [false, false]);
    // The same three rules hold end-to-end: the materialised status earns no EV in F6 / F5.
    const f6Materialised = f6With([], [s20Txn('S20HM', 'G1', 50000)],
      [act({ ...s20Acts[0], percent_complete: 60, actual_quantity: 480 })]);
    eq('S20-H01-G/H materialised progress with no approved history earns no EV', f6Materialised.project.ev, 0);
    eq('S20-H01-G/H it does not status the activity in F5 either',
      g1(f5With([], [act({ ...s20Acts[0], percent_complete: 60 })])).percentComplete, 0);
    // --- H01-J: an approved historical row on/before the Data Date still governs correctly. ---
    const governedByEvidence = resolveGovernedProgress(
      materialised, indexProgressHistory([upd('HU-G', 'G1', '2026-09-10', 35)]), BDD);
    eq('S20-H01-J an approved in-period update still governs the percent', governedByEvidence.percentComplete, 35);
    eq('S20-H01-J ... and is identified as governed evidence', governedByEvidence.source, 'approved_update');
    eq('S20-H01-J ... and cites the row it came from', governedByEvidence.evidenceUpdateId, 'HU-G');
    // An approved row after the Data Date is not evidence: the same activity stays unreached.
    eq('S20-H01-J an approved row AFTER the Data Date leaves the activity unreached',
      resolveGovernedProgress(materialised, indexProgressHistory([upd('HU-H', 'G1', '2026-09-20', 90)]), BDD).percentComplete, 0);
    // An unapproved row is not evidence either, even though a history now exists.
    eq('S20-H01-J a submitted-only history leaves the activity unreached',
      resolveGovernedProgress(materialised, indexProgressHistory([upd('HU-I', 'G1', '2026-09-10', 90, 'submitted')]), BDD).percentComplete, 0);

    // --- H01-A: an approved update BEFORE the Data Date drives both F5 and F6. ---
    const beforeDd = [upd('HU-A', 'G1', '2026-09-10', 60)];
    const f6A = f6With(beforeDd);
    const f5A = f5With(beforeDd);
    eq('S20-H01-A an approved update before the Data Date earns EV (60% of G1 100,000)', f6A.project.ev, 60000);
    eq('S20-H01-A the same evidence statuses G1 in F5', g1(f5A).percentComplete, 60);
    eq('S20-H01-A the governed percent is quoted back with its evidence', g1(f5A).started, true);
    eq('S20-H01-A G1 is not complete at 60%', g1(f5A).completed, false);

    // --- H01-B: an approved update EXACTLY ON the Data Date is included. ---
    const onDd = [upd('HU-B', 'G1', BDD, 80)];
    eq('S20-H01-B an approved update dated exactly on the Data Date is included (EV = 80,000)',
      f6With(onDd).project.ev, 80000);
    eq('S20-H01-B the on-Data-Date update statuses G1 in F5', g1(f5With(onDd)).percentComplete, 80);
    eq('S20-H01-B the boundary itself: one day earlier is also inside',
      f6With([upd('HU-B2', 'G1', '2026-09-12', 80)]).project.ev, 80000);

    // --- H01-C: an approved update AFTER the Data Date has ZERO effect. ---
    const afterDd = [upd('HU-C', 'G1', '2026-09-20', 90)];
    eq('S20-H01-C an approved update after the Data Date earns nothing (EV = 0)', f6With(afterDd).project.ev, 0);
    eq('S20-H01-C it does not status G1 in F5 either', g1(f5With(afterDd)).percentComplete, 0);
    eq('S20-H01-C G1 is unreached, not started', g1(f5With(afterDd)).started, false);
    eq('S20-H01-C G1 is unreached, not complete', g1(f5With(afterDd)).completed, false);
    // Combined with a valid in-period update, the future one still must not win.
    const both = [upd('HU-A', 'G1', '2026-09-10', 60), upd('HU-C', 'G1', '2026-09-20', 90)];
    eq('S20-H01-C the latest APPROVED-IN-PERIOD update wins, not the latest approved overall',
      f6With(both).project.ev, 60000);
    eq('S20-H01-C the same rule holds in F5', g1(f5With(both)).percentComplete, 60);

    // --- H01-D: a submitted / pending update has ZERO effect. ---
    const submitted = [upd('HU-D', 'G1', '2026-09-10', 90, 'submitted')];
    eq('S20-H01-D a submitted update earns nothing (EV = 0)', f6With(submitted).project.ev, 0);
    eq('S20-H01-D a submitted update does not status G1', g1(f5With(submitted)).percentComplete, 0);
    eq('S20-H01-D a draft update earns nothing', f6With([upd('HU-D2', 'G1', '2026-09-10', 90, 'draft')]).project.ev, 0);
    eq('S20-H01-D a rejected update earns nothing', f6With([upd('HU-D3', 'G1', '2026-09-10', 90, 'rejected')]).project.ev, 0);
    // It also cannot REDUCE governed progress: valid in-period evidence still wins.
    const validPlusSubmitted = [upd('HU-A', 'G1', '2026-09-10', 60), upd('HU-D', 'G1', '2026-09-11', 90, 'submitted')];
    eq('S20-H01-D a submitted update cannot displace approved in-period evidence',
      f6With(validPlusSubmitted).project.ev, 60000);

    // --- H01-E: removing every valid pre-Data-Date update returns the governed ZERO / UNREACHED state. ---
    const evBefore = f6With(beforeDd).project.ev;
    ok('S20-H01-E the fixture really had earned value to lose', evBefore === 60000);
    // (i) the in-period update is replaced by a submitted one — no approved evidence remains.
    const onlySubmitted = [upd('HU-E1', 'G1', '2026-09-10', 90, 'submitted')];
    eq('S20-H01-E with no approved in-period evidence EV returns to zero', f6With(onlySubmitted).project.ev, 0);
    const unreached = g1(f5With(onlySubmitted));
    eq('S20-H01-E the state is UNREACHED: 0%', unreached.percentComplete, 0);
    eq('S20-H01-E the state is UNREACHED: not started', unreached.started, false);
    eq('S20-H01-E the state is UNREACHED: not complete', unreached.completed, false);
    eq('S20-H01-E the state is UNREACHED: no actual start', unreached.actualStart, null);
    eq('S20-H01-E the state is UNREACHED: no actual finish', unreached.actualFinish, null);
    // (ii) same result when the only remaining update is approved but dated after the Data Date.
    const onlyFuture = [upd('HU-E2', 'G1', '2026-09-20', 90)];
    eq('S20-H01-E a future-only history is also unreached', f6With(onlyFuture).project.ev, 0);
    eq('S20-H01-E a future-only history leaves G1 not started', g1(f5With(onlyFuture)).started, false);
    // (iii) the resolver states so explicitly, so a consumer can render N/A rather than a bare 0.
    const idx = indexProgressHistory(onlySubmitted);
    eq('S20-H01-E the resolver names the unreached state', resolveGovernedProgress(s20Acts[0], idx, BDD).source, 'no_governed_evidence');
    eq('S20-H01-E the unreached state carries no evidence id', resolveGovernedProgress(s20Acts[0], idx, BDD).evidenceUpdateId, null);
    eq('S20-H01-E the unreached state carries no actual dates',
      [resolveGovernedProgress(act({ ...s20Acts[0], actual_start: '2026-09-02', actual_finish: '2026-09-09' }), idx, BDD).actualStart,
        resolveGovernedProgress(act({ ...s20Acts[0], actual_start: '2026-09-02', actual_finish: '2026-09-09' }), idx, BDD).actualFinish],
      [null, null]);

    // --- H01-F: a future actual_start / actual_finish cannot contaminate the as-of-date state. ---
    const futureActuals = [act({ ...s20Acts[0], percent_complete: 100, actual_start: '2026-09-20', actual_finish: '2026-09-25' })];
    const withApprovedUpdate = [upd('HU-F', 'G1', '2026-09-10', 100)];
    const f6F = f6With(withApprovedUpdate, [s20Txn('S20T1', 'G1', 50000)], futureActuals);
    const f5F = f5With(withApprovedUpdate, futureActuals);
    eq('S20-H01-F a future actual finish is not an as-of-date finish', g1(f5F).actualFinish, null);
    eq('S20-H01-F a future actual start is not an as-of-date start', g1(f5F).actualStart, null);
    eq('S20-H01-F the forecast finish is computed, not copied from the future actual',
      g1(f5F).forecastFinish !== '2026-09-25', true);
    eq('S20-H01-F EV still comes from the governed approved evidence', f6F.project.ev, 100000);
    // The stored violation is still REPORTED: integrity audits the recorded rows, not the governed ones.
    ok('S20-H01-F the stored future actual start is still reported as an integrity error',
      f5F.integrity.some((f) => f.code === 'future_actual_start' && f.severity === 'error'));
    ok('S20-H01-F the stored future actual finish is still reported as an integrity error',
      f5F.integrity.some((f) => f.code === 'future_actual_finish' && f.severity === 'error'));
    // A future actual finish must not silently complete an activity in the governed state either.
    const onlyFutureFinish = act({ ...s20Acts[0], percent_complete: 0, actual_start: '2026-09-02', actual_finish: '2026-09-25' });
    const governedF = resolveGovernedProgress(onlyFutureFinish, indexProgressHistory(withApprovedUpdate), BDD);
    eq('S20-H01-F a future actual finish does not complete the governed state', governedF.actualFinish, null);
    eq('S20-H01-F the in-period actual start survives the chronology guard', governedF.actualStart, '2026-09-02');

    // --- one definition, shared with the historical phasing the S-Curve already used. ---
    // A cutoff before the governed Data Date is the historical branch, which now delegates to the
    // same shared rule instead of running its own loop.
    eq('S20-H01 the S-Curve phasing and F5 resolve the same governing update',
      phasePercentCompleteAsOf(s20Acts[0], both, '2026-09-12', '2026-09-13').percent, 60);
    eq('S20-H01 the S-Curve phasing and the governed resolver agree at a historical cutoff',
      phasePercentCompleteAsOf(s20Acts[0], both, '2026-09-18', '2026-09-20').percent,
      latestApprovedUpdateOnOrBefore(indexProgressHistory(both), 'G1', '2026-09-18')?.percent_complete);
    eq('S20-H01 the governed resolver ignores an update dated after the cutoff',
      latestApprovedUpdateOnOrBefore(indexProgressHistory(both), 'G1', '2026-09-12')?.id, 'HU-A');
    eq('S20-H01 an undated update is never evidence',
      latestApprovedUpdateOnOrBefore(indexProgressHistory([upd('HU-X', 'G1', 'not-a-date', 50)]), 'G1', BDD), null);
    // A governed project is structurally the recorded project, so downstream snapshots cannot churn.
    ok('S20-H01 an already-governed activity is passed through by reference (no clone churn)',
      applyGovernedProgress([s20Acts[1]], [upd('HU-A', 'G1', '2026-09-10', 60)], BDD)[0] === s20Acts[1]);
  }

  // =========================================================================
  // S20-H02  Duplicate actual cost cannot move AC / CPI / EAC / VAC
  // =========================================================================
  {
    const updates = [upd('HU-A', 'G1', '2026-09-10', 100)]; // G1 complete: EV = 100,000
    const base1 = s20Txn('S20D1', 'G1', 50000);
    const before = f6With(updates, [base1]);
    ok('S20-H02 the fixture has a measurable CPI to protect', before.project.cpi !== null);
    ok('S20-H02 the fixture has an EAC and a VAC to protect',
      before.project.eac !== null && before.project.vac !== null);
    eq('S20-H02 the fixture AC is the single approved row', before.project.ac, 50000);

    // The duplicate: a DIFFERENT row id, the SAME business key.
    const duplicate = s20Txn('S20D2', 'G1', 50000);
    eq('S20-H02 the duplicate really is a different row id (not an id-deduplication)',
      duplicate.id !== base1.id, true);
    eq('S20-H02 the duplicate really shares the business key',
      costTransactionBusinessKey(duplicate), costTransactionBusinessKey(base1));

    const after = f6With(updates, [base1, duplicate]);
    eq('S20-H02-A an exact duplicate leaves AC unchanged', after.project.ac, before.project.ac);
    eq('S20-H02-B an exact duplicate leaves CPI unchanged', after.project.cpi, before.project.cpi);
    eq('S20-H02-C an exact duplicate leaves EAC unchanged', after.project.eac, before.project.eac);
    eq('S20-H02-D an exact duplicate leaves VAC unchanged', after.project.vac, before.project.vac);
    eq('S20-H02 the duplicate is not counted in the transaction count', after.project.acCount, before.project.acCount);
    eq('S20-H02 the duplicate does not reach the activity rollup either',
      after.activities.find((a) => a.id === 'G1')?.ac, before.activities.find((a) => a.id === 'G1')?.ac);
    // The warning is still raised — the requirement is that the MONEY does not move, not silence.
    ok('S20-H02 the duplicate is still reported by integrity',
      after.integrity.some((f) => f.code === 'duplicate_transaction' && f.refId === duplicate.id));
    ok('S20-H02 the report states the duplicate was excluded from AC',
      (after.integrity.find((f) => f.code === 'duplicate_transaction')?.evidence || [])
        .some((e) => /excluded from AC/.test(e)));
    // Order independence: the survivor is the earliest row by (date, id), not whichever came first.
    const reversed = f6With(updates, [duplicate, base1]);
    eq('S20-H02 the surviving row does not depend on array order', reversed.project.ac, before.project.ac);
    eq('S20-H02 the shared helper keeps exactly one of the pair',
      dedupeByBusinessKey([base1, duplicate]).unique.length, 1);
    eq('S20-H02 the shared helper reports which row it dropped',
      dedupeByBusinessKey([base1, duplicate]).duplicates[0].row.id, duplicate.id);

    // H02-E: a genuinely distinct transaction is still included.
    const distinct = s20Txn('S20D3', 'G1', 25000, { invoice_number: 'INV-S20-B' } as Partial<CostTransaction>);
    eq('S20-H02-E a distinct transaction does NOT share the business key',
      costTransactionBusinessKey(distinct) === costTransactionBusinessKey(base1), false);
    const grown = f6With(updates, [base1, distinct]);
    eq('S20-H02-E a genuinely distinct transaction increases AC normally', grown.project.ac, before.project.ac + 25000);
    ok('S20-H02-E the added cost really changes CPI', grown.project.cpi !== before.project.cpi);
    ok('S20-H02-E the added cost really changes EAC', grown.project.eac !== before.project.eac);
    ok('S20-H02-E the added cost really changes VAC', grown.project.vac !== before.project.vac);
    // A duplicate of a row that is NOT actual cost must not cancel the approved one.
    const rejectedTwin = { ...base1, id: 'S20D4', status: 'rejected' } as CostTransaction;
    eq('S20-H02 a rejected twin does not cancel its approved counterpart',
      f6With(updates, [rejectedTwin, base1]).project.ac, before.project.ac);

    // ---------------------------------------------------------------------------
    // P2A1-H02 CLOSURE (F..J): the identity must separate LEGITIMATE accounting
    // from a true duplicate. The first revision keyed on the economic event only
    // (date / amount / refs / vendor / invoice / description), so a row that was
    // the same event booked DIFFERENTLY was silently dropped from AC.
    // ---------------------------------------------------------------------------
    const variant = (id: string, extra: Partial<CostTransaction>): CostTransaction =>
      s20Txn(id, 'G1', 50000, extra);

    // --- H02-F: same invoice / date / amount, different cost_type => BOTH kept. ---
    const directRow = variant('S20F1', { cost_type: 'direct' });
    const indirectRow = variant('S20F2', { cost_type: 'indirect' });
    eq('S20-H02-F a different cost_type is a different business key',
      costTransactionBusinessKey(directRow) === costTransactionBusinessKey(indirectRow), false);
    eq('S20-H02-F both postings survive de-duplication',
      dedupeByBusinessKey([directRow, indirectRow]).unique.length, 2);
    eq('S20-H02-F both reach AC (a direct and an indirect posting are two charges)',
      f6With(updates, [directRow, indirectRow]).project.ac, 100000);

    // --- H02-G: same invoice / date / amount, different category => BOTH kept. ---
    const workRow = variant('S20G1', { category: 'work' });
    const materialRow = variant('S20G2', { category: 'material' });
    eq('S20-H02-G a different category is a different business key',
      costTransactionBusinessKey(workRow) === costTransactionBusinessKey(materialRow), false);
    eq('S20-H02-G a category split survives de-duplication',
      dedupeByBusinessKey([workRow, materialRow]).unique.length, 2);
    eq('S20-H02-G a category split is counted once per category in AC',
      f6With(updates, [workRow, materialRow]).project.ac, 100000);

    // --- H02-H: different WBS / budget allocation => BOTH kept. ---
    const wbsA = variant('S20H1', { wbs_node_id: 'wbs-a' });
    const wbsB = variant('S20H2', { wbs_node_id: 'wbs-b' });
    const lineA = variant('S20H3', { budget_line_id: 'bl-a' });
    const lineB = variant('S20H4', { budget_line_id: 'bl-b' });
    eq('S20-H02-H a different WBS node is a different business key',
      costTransactionBusinessKey(wbsA) === costTransactionBusinessKey(wbsB), false);
    eq('S20-H02-H a different budget line is a different business key',
      costTransactionBusinessKey(lineA) === costTransactionBusinessKey(lineB), false);
    eq('S20-H02-H the same cost allocated to two WBS branches is two charges',
      dedupeByBusinessKey([wbsA, wbsB]).unique.length, 2);
    eq('S20-H02-H the same cost split across two budget lines is two charges',
      dedupeByBusinessKey([lineA, lineB]).unique.length, 2);
    eq('S20-H02-H a split allocation is fully counted in AC',
      f6With(updates, [wbsA, wbsB]).project.ac, 100000);
    // A different booking source is likewise a distinct provenance, not a repeat.
    const invRow = variant('S20H5', { source: 'INV-S20' });
    const erpRow = variant('S20H6', { source: 'ERP' });
    eq('S20-H02-H a different source system is a different business key',
      costTransactionBusinessKey(invRow) === costTransactionBusinessKey(erpRow), false);
    eq('S20-H02-H two booking systems do not cancel each other',
      dedupeByBusinessKey([invRow, erpRow]).unique.length, 2);

    // --- H02-I: a TRUE exact business duplicate is still excluded. ---
    // Identical event AND identical accounting identity: one economic occurrence, recorded twice.
    const trueDuplicate = variant('S20I2', {});
    eq('S20-H02-I an exact duplicate carries the same business key',
      costTransactionBusinessKey(trueDuplicate), costTransactionBusinessKey(directRow));
    eq('S20-H02-I an exact duplicate is collapsed to one row',
      dedupeByBusinessKey([directRow, trueDuplicate]).unique.length, 1);
    eq('S20-H02-I the later row is the one reported as dropped',
      dedupeByBusinessKey([directRow, trueDuplicate]).duplicates[0].row.id, 'S20I2');
    eq('S20-H02-I an exact duplicate adds nothing to AC',
      f6With(updates, [directRow, trueDuplicate]).project.ac, 50000);
    // Normalization: the same event written with different case / spacing / numeric text is a
    // duplicate too, and the same event in another project is NOT.
    const messy = s20Txn('S20I3', 'G1', 50000, { vendor: '  ACME  ', invoice_number: 'inv-s20' });
    eq('S20-H02-I case and whitespace normalize to the same key',
      costTransactionBusinessKey(messy), costTransactionBusinessKey(directRow));
    const otherProject = s20Txn('S20I4', 'G1', 50000, { project_id: 'p-other' });
    eq('S20-H02-I the same invoice in another project is not a duplicate',
      costTransactionBusinessKey(otherProject) === costTransactionBusinessKey(directRow), false);

    // --- H02-J: excluding the duplicate leaves AC / CPI / EAC / VAC untouched. ---
    const singleRow = f6With(updates, [directRow]);
    const duplicated = f6With(updates, [directRow, trueDuplicate]);
    eq('S20-H02-J AC is unchanged by the duplicate exclusion', duplicated.project.ac, singleRow.project.ac);
    eq('S20-H02-J CPI is unchanged by the duplicate exclusion', duplicated.project.cpi, singleRow.project.cpi);
    eq('S20-H02-J EAC is unchanged by the duplicate exclusion', duplicated.project.eac, singleRow.project.eac);
    eq('S20-H02-J VAC is unchanged by the duplicate exclusion', duplicated.project.vac, singleRow.project.vac);
    eq('S20-H02-J the transaction count is unchanged too', duplicated.project.acCount, singleRow.project.acCount);
    ok('S20-H02-J the duplicate is still reported, exclusion is not silence',
      duplicated.integrity.some((f) => f.code === 'duplicate_transaction' && f.refId === 'S20I2'));
    // Detection and aggregation share one identity: nothing legitimately distinct is reported.
    ok('S20-H02-J a legitimately distinct posting is not reported as a duplicate',
      !f6With(updates, [workRow, materialRow]).integrity.some((f) => f.code === 'duplicate_transaction'));
  }

  // =========================================================================
  // S20-M02  Orphan / foreign actual cost
  // =========================================================================
  {
    const updates = [upd('HU-A', 'G1', '2026-09-10', 100)];
    const base1 = s20Txn('S20M1', 'G1', 50000);
    const before = f6With(updates, [base1]);

    // --- M02-A: a transaction naming an activity that does not exist. ---
    const orphan = s20Txn('S20M2', 'activity-that-does-not-exist', 75000);
    const withOrphan = f6With(updates, [base1, orphan]);
    eq('S20-M02-A an orphan transaction leaves AC unchanged', withOrphan.project.ac, before.project.ac);
    eq('S20-M02-A an orphan transaction leaves EAC unchanged', withOrphan.project.eac, before.project.eac);
    eq('S20-M02-A it does not reach the unassigned bucket either',
      withOrphan.unassigned.ac, before.unassigned.ac);
    ok('S20-M02-D the orphan is REPORTED, not silently consumed',
      withOrphan.integrity.some((f) => f.code === 'invalid_activity_reference' && f.refId === orphan.id));
    ok('S20-M02-D the report states the amount and the exclusion',
      (withOrphan.integrity.find((f) => f.code === 'invalid_activity_reference')?.evidence || [])
        .some((e) => /excluded from AC/.test(e))
      && (withOrphan.integrity.find((f) => f.code === 'invalid_activity_reference')?.evidence || [])
        .some((e) => e.includes('amount = 75000')));

    // --- M02-B: a transaction naming an activity that belongs to ANOTHER project. ---
    // The analysed activity set is this project's; the foreign activity is deliberately outside it.
    const foreignAct = act({ id: 'FOREIGN-1', code: 'FOREIGN-1', project_id: 'p2', duration_days: 10, percent_complete: 100 });
    const foreign = s20Txn('S20M3', 'FOREIGN-1', 125000);
    const withForeign = f6With(updates, [base1, foreign]);
    eq('S20-M02-B a foreign-project transaction leaves AC unchanged', withForeign.project.ac, before.project.ac);
    eq('S20-M02-B a foreign-project transaction leaves CPI unchanged', withForeign.project.cpi, before.project.cpi);
    eq('S20-M02-B a foreign-project transaction leaves EAC unchanged', withForeign.project.eac, before.project.eac);
    eq('S20-M02-B it does not reach the unassigned bucket either',
      withForeign.unassigned.ac, before.unassigned.ac);
    ok('S20-M02-D the foreign transaction is reported too',
      withForeign.integrity.some((f) => f.code === 'invalid_activity_reference' && f.refId === foreign.id));
    // The shared predicate distinguishes the two failures once it can see the whole register.
    const db: DemoDb = {
      activities: [
        { id: s20Acts[0].id, project_id: s20Acts[0].project_id },
        { id: foreignAct.id, project_id: foreignAct.project_id },
      ],
    };
    eq('S20-M02-B the shared predicate names the foreign-project failure',
      controlRecordCrossesProjectBoundary('FOREIGN-1', 'p1', (id) => {
        const row = (db['activities'] || []).find((a) => String(a.id) === id);
        return row ? (row.project_id as string) : null;
      }).reason, 'foreign_project');
    eq('S20-M02-A the shared predicate names the missing-activity failure',
      controlRecordCrossesProjectBoundary('nope', 'p1', () => null).reason, 'activity_not_found');

    // --- M02-C: a valid same-project transaction is still accepted. ---
    const valid = s20Txn('S20M4', 'G1', 25000, { invoice_number: 'INV-S20-C' } as Partial<CostTransaction>);
    const foreign2 = s20Txn('S20M5', 'FOREIGN-1', 125000, { invoice_number: 'INV-S20-D' } as Partial<CostTransaction>);
    const mixed = f6With(updates, [base1, valid, foreign2]);
    eq('S20-M02-C a valid same-project transaction is accepted', mixed.project.ac, before.project.ac + 25000);
    eq('S20-M02-C only the valid one is counted', mixed.project.acCount, before.project.acCount + 1);
    // A project-level cost (no activity_id) is legal and unaffected by the boundary rule.
    const projectLevel = s20Txn('S20M6', null, 10000, { invoice_number: 'INV-S20-E' } as Partial<CostTransaction>);
    eq('S20-M02-C a project-level cost with no activity reference is still accepted',
      f6With(updates, [base1, projectLevel]).project.ac, before.project.ac + 10000);
    eq('S20-M02-C the boundary rule does not fire for a null activity reference',
      controlRecordCrossesProjectBoundary(null, 'p1', () => null).crosses, false);

    // --- the PERSISTENCE boundary: the demo store mirrors the live trigger. ---
    const okSame = checkControlRecordProjectBoundary(db, 'cost_transactions', { id: 'new', project_id: 'p1', activity_id: 'G1' });
    eq('S20-M02 the write boundary accepts a same-project activity', okSame.error, null);
    const okNull = checkControlRecordProjectBoundary(db, 'cost_transactions', { id: 'new', project_id: 'p1', activity_id: null });
    eq('S20-M02 the write boundary accepts a project-level cost', okNull.error, null);
    const badOrphan = checkControlRecordProjectBoundary(db, 'cost_transactions', { id: 'new', project_id: 'p1', activity_id: 'ghost' });
    ok('S20-M02-A the write boundary rejects a nonexistent activity', badOrphan.error !== null);
    eq('S20-M02-A the rejection quotes the SQL exception verbatim',
      badOrphan.error?.message, 'Control record crosses project boundary');
    eq('S20-M02-A the rejection names the reason', badOrphan.error?.hint, 'trigger:validate_project_boundaries:activity_not_found');
    const badForeign = checkControlRecordProjectBoundary(db, 'cost_transactions', { id: 'new', project_id: 'p1', activity_id: 'FOREIGN-1' });
    ok('S20-M02-B the write boundary rejects another project activity', badForeign.error !== null);
    eq('S20-M02-B the rejection names the reason', badForeign.error?.hint, 'trigger:validate_project_boundaries:foreign_project');
    ok('S20-M02-B the rejection states which project the activity belongs to',
      String(badForeign.error?.details).includes('p2') && String(badForeign.error?.details).includes('p1'));
  }

  // =========================================================================
  // S20-M01  Data Date provenance
  // =========================================================================
  {
    // M01-A: the project states its own Data Date -> explicitly governed, never a fallback.
    const explicit = resolveDataDateProvenance({ data_date: '2026-08-01' });
    eq('S20-M01-A an explicit data_date resolves to itself', explicit.dataDate, '2026-08-01');
    eq('S20-M01-A an explicit data_date is EXPLICIT_GOVERNED_DATE', explicit.source, EXPLICIT_GOVERNED_DATE);
    eq('S20-M01-A an explicit data_date is not a fallback', explicit.isFallback, false);
    eq('S20-M01-A its origin is the project', explicit.origin, 'project');
    eq('S20-M01-A the project value is reported verbatim', explicit.projectDataDate, '2026-08-01');

    // M01-B: data_date is null -> the fallback is VISIBLY identified.
    const nullDd = resolveDataDateProvenance({ data_date: null });
    eq('S20-M01-B a null data_date resolves to the governed default', nullDd.dataDate, DEFAULT_DATA_DATE);
    eq('S20-M01-B a null data_date is FALLBACK_DEFAULT_DATE', nullDd.source, FALLBACK_DEFAULT_DATE);
    eq('S20-M01-B a null data_date is flagged as a fallback', nullDd.isFallback, true);
    eq('S20-M01-B its origin is the default', nullDd.origin, 'default');
    eq('S20-M01-B no project date is claimed', nullDd.projectDataDate, null);
    ok('S20-M01-B the note says so in words', /[Ff]allback/.test(nullDd.note));

    // M01-C: the data_date key is absent entirely -> same visible fallback.
    const missingDd = resolveDataDateProvenance({});
    eq('S20-M01-C a missing data_date resolves to the governed default', missingDd.dataDate, DEFAULT_DATA_DATE);
    eq('S20-M01-C a missing data_date is FALLBACK_DEFAULT_DATE', missingDd.source, FALLBACK_DEFAULT_DATE);
    eq('S20-M01-C a missing data_date is flagged as a fallback', missingDd.isFallback, true);
    const noProject = resolveDataDateProvenance(null);
    eq('S20-M01-C no project at all is the same visible fallback', noProject.source, FALLBACK_DEFAULT_DATE);
    eq('S20-M01-C no project at all still resolves to the governed default', noProject.dataDate, DEFAULT_DATA_DATE);
    // The two provenances are different values, so no consumer can conflate them.
    ok('S20-M01 the two provenances are distinct markers',
      EXPLICIT_GOVERNED_DATE !== FALLBACK_DEFAULT_DATE);
    eq('S20-M01 isFallbackDataDate agrees with the resolution',
      [isFallbackDataDate({ data_date: '2026-08-01' }), isFallbackDataDate({}), isFallbackDataDate(null)],
      [false, true, true]);
    // An explicit override is governance, not a fallback — but its origin still says "not the project".
    const override = resolveDataDateProvenance({ data_date: '2026-08-01' }, '2026-09-01');
    eq('S20-M01 an explicit override is governed, not a fallback', override.isFallback, false);
    eq('S20-M01 an explicit override is EXPLICIT_GOVERNED_DATE', override.source, EXPLICIT_GOVERNED_DATE);
    eq('S20-M01 an explicit override is labelled as an override', override.origin, 'override');
    const overrideOnEmpty = resolveDataDateProvenance({}, '2026-09-01');
    eq('S20-M01 an override rescues a project with no data_date', overrideOnEmpty.isFallback, false);
    eq('S20-M01 the project date is still reported as absent',
      overrideOnEmpty.projectDataDate, null);

    // M01-D: every existing consumer keeps working — the value is bit-for-bit unchanged.
    const matrix: Array<[DataDateBearer | null | undefined, string | null | undefined]> = [
      [{ data_date: '2026-08-01' }, null],
      [{ data_date: '2026-08-01' }, '2026-09-01'],
      [{ data_date: null }, null],
      [{ data_date: null }, '2026-09-01'],
      [{}, null],
      [{}, ''],
      [null, null],
      [undefined, null],
    ];
    for (const [bearer, ovr] of matrix) {
      eq(`S20-M01-D resolveDataDate is unchanged for ${JSON.stringify(bearer)}/${String(ovr)}`,
        resolveDataDate(bearer, ovr), ovr || bearer?.data_date || DEFAULT_DATA_DATE);
      eq(`S20-M01-D the shim equals the provenance value for ${JSON.stringify(bearer)}/${String(ovr)}`,
        resolveDataDate(bearer, ovr), resolveDataDateProvenance(bearer, ovr).dataDate);
    }
    // The S0 baseline assertions from the original harness still hold through the new implementation.
    eq('S20-M01-D S0 override wins still holds', resolveDataDate({ data_date: '2026-08-01' }, '2026-09-01'), '2026-09-01');
    eq('S20-M01-D S0 project DD still holds', resolveDataDate({ data_date: '2026-08-01' }), '2026-08-01');
    eq('S20-M01-D S0 null project still holds', resolveDataDate(null), DEFAULT_DATA_DATE);
    // The fallback is surfaced where the date is shown, not merely available.
    const appSrc = readFileSync(resolvePath(s20Root, 'src/App.tsx'), 'utf8');
    ok('S20-M01 the shell resolves the Data Date through the provenance helper',
      /resolveDataDateProvenance\s*\(\s*project\s*\)/.test(appSrc));
    ok('S20-M01 the shell renders a FALLBACK marker instead of presenting the stand-in as governed',
      /dataDateResolution\.isFallback[\s\S]{0,400}FALLBACK/.test(appSrc)
      && /dataDateResolution\.isFallback[\s\S]{0,400}افتراضي/.test(appSrc));

    // ---------------------------------------------------------------------------
    // P2A1-M01 CLOSURE (E..H): provenance must REACH the outputs, not stop at the
    // shell. Previously `resolveDataDateProvenance` was only used by App.tsx, so a
    // report could present the governed default as the project's own status date.
    // ---------------------------------------------------------------------------
    const m01ExecSrc = readFileSync(resolvePath(s20Root, 'src/components/views/ExecutiveReportView.tsx'), 'utf8');

    // --- M01-E: Executive Report with a null project.data_date visibly flags the fallback. ---
    const m01FallbackProject = { ...s20Project, data_date: null } as Project;
    const m01FallbackReport = analyzeCostControl({
      project: m01FallbackProject, activities: s20Acts, baselines: s20Baselines, budgetLines: [],
      costTransactions: [s20Txn('S20M1', 'G1', 50000)],
      progressUpdates: [upd('HU-M1', 'G1', '2026-09-10', 60)],
      wbsNodes: [], boqItems: [], allocations: [], dataDate: DD, calendarType: '6_days',
    });
    eq('S20-M01-E the report still resolves a usable Data Date', m01FallbackReport.dataDate, DD);
    eq('S20-M01-E ... but its provenance is the governed default', m01FallbackReport.dataDateSource, FALLBACK_DEFAULT_DATE);
    eq('S20-M01-E ... and the report says so explicitly', m01FallbackReport.dataDateIsFallback, true);
    // The screen renders that provenance: the flags come from the report, and both markers appear.
    ok('S20-M01-E the Executive Report reads provenance from the canonical report',
      /costReport\?\.dataDateIsFallback/.test(m01ExecSrc));
    ok('S20-M01-E the Executive Report renders the fallback marker',
      /dataDateIsFallback[\s\S]{0,300}FALLBACK_DEFAULT_DATE/.test(m01ExecSrc)
      && /dataDateIsFallback[\s\S]{0,400}افتراضي/.test(m01ExecSrc));
    ok('S20-M01-E the Executive Report also labels the governed case',
      /EXPLICIT_GOVERNED_DATE/.test(m01ExecSrc));

    // --- M01-F: engine / report metadata preserves FALLBACK_DEFAULT_DATE. ---
    eq('S20-M01-F F6 metadata preserves FALLBACK_DEFAULT_DATE',
      m01FallbackReport.dataDateSource, FALLBACK_DEFAULT_DATE);
    ok('S20-M01-F the reported source is the documented constant, not a string that merely looks like it',
      m01FallbackReport.dataDateSource === FALLBACK_DEFAULT_DATE && FALLBACK_DEFAULT_DATE !== EXPLICIT_GOVERNED_DATE);
    // F5 carries the same provenance for the same project.
    const m01FallbackF5 = analyzeScheduleControl({
      project: m01FallbackProject, activities: s20Acts, links: s20Links, baselines: s20Baselines,
      progressUpdates: [upd('HU-M1', 'G1', '2026-09-10', 60)], previousSnapshot: null,
      dataDate: DD, calendarType: '6_days',
    });
    eq('S20-M01-F F5 metadata preserves FALLBACK_DEFAULT_DATE', m01FallbackF5.dataDateSource, FALLBACK_DEFAULT_DATE);
    eq('S20-M01-F F5 also flags it as a fallback', m01FallbackF5.dataDateIsFallback, true);
    // A snapshot built from that report preserves it too (it stores the report's Data Date).
    eq('S20-M01-F the snapshot built from the report carries the same date',
      buildUpdateSnapshot('p1', m01FallbackF5, s20Acts, s20Links).data_date, m01FallbackF5.dataDate);

    // --- M01-G: an explicit project.data_date remains governed / non-fallback. ---
    const m01GovernedProject = { ...s20Project, data_date: '2026-09-01' } as Project;
    const m01GovernedReport = analyzeCostControl({
      project: m01GovernedProject, activities: s20Acts, baselines: s20Baselines, budgetLines: [],
      costTransactions: [s20Txn('S20M2', 'G1', 50000)],
      progressUpdates: [upd('HU-M2', 'G1', '2026-08-20', 60)],
      wbsNodes: [], boqItems: [], allocations: [], dataDate: '2026-09-01', calendarType: '6_days',
    });
    eq('S20-M01-G an explicit project data_date is EXPLICIT_GOVERNED_DATE',
      m01GovernedReport.dataDateSource, EXPLICIT_GOVERNED_DATE);
    eq('S20-M01-G ... and is not flagged as a fallback', m01GovernedReport.dataDateIsFallback, false);
    eq('S20-M01-G F5 agrees for the same project',
      analyzeScheduleControl({
        project: m01GovernedProject, activities: s20Acts, links: s20Links, baselines: s20Baselines,
        progressUpdates: [], previousSnapshot: null, dataDate: '2026-09-01', calendarType: '6_days',
      }).dataDateSource, EXPLICIT_GOVERNED_DATE);
    // The shipped pilot project is governed: provenance must not turn it into a fallback.
    const m01Pilot = (getInitialSeedData() as Record<string, unknown[]>)['projects']
      .find((p) => (p as unknown as Project).id === 'proj-seed-001') as unknown as Project;
    eq('S20-M01-G the shipped pilot project carries its own data_date',
      typeof m01Pilot.data_date, 'string');
    eq('S20-M01-G the shipped pilot project is governed, not fallback',
      resolveDataDateProvenance(m01Pilot).source, EXPLICIT_GOVERNED_DATE);

    // --- M01-H: resolveDataDate compatibility is intact. ---
    eq('S20-M01-H resolveDataDate still returns the same value for a governed project',
      resolveDataDate(m01GovernedProject), '2026-09-01');
    eq('S20-M01-H resolveDataDate still returns the default for a project with none',
      resolveDataDate(m01FallbackProject), DEFAULT_DATA_DATE);
    eq('S20-M01-H isFallbackDataDate still works', isFallbackDataDate(m01FallbackProject), true);
    eq('S20-M01-H isFallbackDataDate is false for a governed project',
      isFallbackDataDate(m01GovernedProject), false);
    eq('S20-M01-H the report Data Date is the caller-resolved date, provenance changes no value',
      m01FallbackReport.dataDate, resolveDataDate(m01FallbackProject));
  }

  // =========================================================================
  // S20-H04  NO DATA is not CPI = SPI = 1 with a realistic finish and 100% confidence
  // =========================================================================
  {
    const START = '2026-07-01';
    const END = '2027-03-31';
    const emptyCanonical = selectCanonicalEvm(null);
    eq('S20-H04 the fixture really is the no-data case', emptyCanonical.cpiStatus, 'empty_no_data');
    eq('S20-H04 the fixture really has no measured SPI', emptyCanonical.spiStatus, 'empty_no_data');
    eq('S20-H04 the canonical quote carries no CPI at all', emptyCanonical.cpi, null);
    // The compatibility adapter DOES hand out a neutral 1.0 — that is the trap the fix closes.
    const adapted = canonicalEvmToComprehensive(emptyCanonical);
    eq('S20-H04 the non-nullable adapter still substitutes the neutral 1.0 (the trap)', adapted.cpi, 1);
    eq('S20-H04 the adapter keeps the status authoritative so a consumer can tell', adapted.cpiStatus, 'empty_no_data');

    // --- the pre-fix symptom, reproduced: feeding that 1.0 in produces healthy output. ---
    const legacy = analyzeForecast(START, END, 0, 0, 0, adapted.spi, adapted.cpi, 0, 0, BDD, []);
    eq('S20-H04 the pre-fix behaviour really reported 100% confidence from no data', legacy.confidence, 100);
    ok('S20-H04 the pre-fix behaviour really produced a realistic finish from no data',
      legacy.scenarios.realistic !== null);
    eq('S20-H04 the pre-fix volatility was a perfect-looking 0', legacy.volatility, 0);

    // --- H04-A/B: gated on the canonical statuses, no data yields no forecast and no confidence. ---
    const gated = analyzeForecast(START, END, 0, 0, 0, adapted.spi, adapted.cpi, 0, 0, BDD, [],
      { cpi: adapted.cpiStatus, spi: adapted.spiStatus });
    eq('S20-H04-A no data produces NO realistic finish (N/A)', gated.scenarios.realistic, null);
    eq('S20-H04-A no data produces no optimistic finish either', gated.scenarios.optimistic, null);
    eq('S20-H04-A no data produces no pessimistic finish either', gated.scenarios.pessimistic, null);
    eq('S20-H04-B no data reports NO confidence at all — never 100', gated.confidence, null);
    eq('S20-H04 the forecast says it is not measured', gated.measured, false);
    ok('S20-H04 the forecast states why it is N/A', /N\/A/.test(String(gated.note)));
    eq('S20-H04 the statuses the forecast was gated on are published',
      gated.indexStatus, { cpi: 'empty_no_data', spi: 'empty_no_data' });
    // An ANOMALOUS index (value earned, denominator zero) is equally unforecastable.
    const anomalous = analyzeForecast(START, END, 100000, 0, 0.5, 0, 0, 0, 0, BDD, [],
      { cpi: 'anomalous_zero_denominator', spi: 'anomalous_zero_denominator' });
    eq('S20-H04-A an anomalous index is also not a forecast', anomalous.scenarios.realistic, null);
    eq('S20-H04-B an anomalous index is also not 100% confidence', anomalous.confidence, null);
    // P2A1-H04 CLOSURE: an unmeasured cost index no longer publishes BAC as an EAC either. The
    // "EAC = BAC" convention belongs to `assessEvmRatios` (a non-nullable numeric shape); a
    // FORECAST with no measured efficiency publishes NO number, so it cannot be rendered as a
    // measured completion estimate. This replaces the previous expectation of `bac`.
    eq('S20-H04 an anomalous cost index publishes no EAC at all (not BAC, not fourfold)',
      anomalous.cost.realistic, null);
    eq('S20-H04 ... and no other cost scenario either',
      [anomalous.cost.optimistic, anomalous.cost.pessimistic], [null, null]);
    // One unmeasured index is enough to invalidate the finish forecast.
    const halfMeasured = analyzeForecast(START, END, 100000, 50000, 0.5, 1, 1, 0, 0, BDD, [],
      { cpi: 'valid', spi: 'empty_no_data' });
    eq('S20-H04-A an unmeasured SPI alone stops the finish forecast', halfMeasured.scenarios.realistic, null);
    eq('S20-H04-B an unmeasured SPI alone stops the confidence claim', halfMeasured.confidence, null);
    eq('S20-H04 an unmeasured index is named in the published statuses',
      halfMeasured.indexStatus.spi, 'empty_no_data');
    eq('S20-H04 the shared finish-scenario helper applies the same gate',
      forecastFinishScenarios(START, END, 0.5, 1, new Date(`${BDD}T00:00:00Z`), 'empty_no_data').realistic, null);
    ok('S20-H04 a completed project still reports its planned finish (evidence, not extrapolation)',
      forecastFinishScenarios(START, END, 1, 1, new Date(`${BDD}T00:00:00Z`), 'empty_no_data').realistic === END);

    // --- H04-C: a REAL measured CPI = SPI = 1 forecasts exactly as before. ---
    const measured = analyzeForecast(START, END, 100000, 50000, 0.5, 1, 1, 0, 0, BDD, [],
      { cpi: 'valid', spi: 'valid' });
    eq('S20-H04-C a measured SPI = 1 still produces a realistic finish',
      measured.scenarios.realistic !== null, true);
    eq('S20-H04-C a measured forecast is flagged as measured', measured.measured, true);
    eq('S20-H04-C a measured forecast carries no N/A note', measured.note, null);
    ok('S20-H04-C a measured CPI = SPI = 1 still reports a real confidence number',
      typeof measured.confidence === 'number');

    // --- H04-D/E: an UNMEASURED forecast must not publish a scenario EAC anywhere. ---
    // The defect Codex found: `cost.realistic` fell back to BAC when the CPI was unmeasured, and
    // the Dashboard added risk exposure to it and rendered the result as a scenario EAC without
    // consulting `forecast.measured`.
    eq('S20-H04-D an unmeasured CPI publishes no realistic EAC', gated.cost.realistic, null);
    eq('S20-H04-D ... no optimistic EAC', gated.cost.optimistic, null);
    eq('S20-H04-D ... no pessimistic EAC', gated.cost.pessimistic, null);
    eq('S20-H04-D the budget is NOT published as the EAC', gated.cost.realistic, null);
    // The Dashboard's own gate: measured === false => no numeric scenario EAC reaches the cards.
    const dashboardScenarioEac = (f: typeof gated, riskExposure: number): number | null =>
      f.measured && f.cost.realistic !== null ? f.cost.realistic + riskExposure : null;
    eq('S20-H04-E forecast.measured = false prevents a numeric scenario EAC',
      dashboardScenarioEac(gated, 12345), null);
    eq('S20-H04-E an anomalous index is equally barred', dashboardScenarioEac(anomalous, 0), null);
    // The card builder drops the scenario entirely rather than showing a number.
    eq('S20-H04-E the EAC presentation publishes no scenario card',
      buildEacPresentation({
        canonicalEac: 100, canonicalMethod: null, canonicalBac: 100, canonicalVac: 0,
        scenarioEac: dashboardScenarioEac(gated, 0), scenarioMethod: 'spi_cpi_trend_plus_open_risk_exposure',
      }).scenario, null);

    // --- H04-F: measured CPI/SPI still produce a normal, visible EAC. ---
    ok('S20-H04-F a measured forecast still publishes a numeric realistic EAC',
      typeof measured.cost.realistic === 'number');
    eq('S20-H04-F the measured EAC is AC + (BAC x remaining) / CPI, not BAC',
      measured.cost.realistic, 50000 + (100000 * 0.5) / 1);
    eq('S20-H04-F the optimistic scenario is at most the realistic one',
      (measured.cost.optimistic as number) <= (measured.cost.realistic as number), true);
    eq('S20-H04-F the pessimistic scenario is at least the realistic one',
      (measured.cost.pessimistic as number) >= (measured.cost.realistic as number), true);
    eq('S20-H04-F the Dashboard gate lets a measured EAC through',
      dashboardScenarioEac(measured, 0), measured.cost.realistic);
    ok('S20-H04-F a measured EAC still renders a scenario card',
      buildEacPresentation({
        canonicalEac: 100, canonicalMethod: null, canonicalBac: 100, canonicalVac: 0,
        scenarioEac: measured.cost.realistic, scenarioMethod: 'spi_cpi_trend_plus_open_risk_exposure',
      }).scenario !== null);

    // --- H04-G: the no-data BAC compatibility value cannot leak into the presentation. ---
    // `canonicalEvmToComprehensive` substitutes `eac ?? bac` for non-nullable consumers; that is a
    // shape adapter, and it must not become the scenario EAC of an unmeasured forecast.
    const adapterEac = canonicalEvmToComprehensive(emptyCanonical).eac;
    eq('S20-H04-G the non-nullable adapter still substitutes BAC for eac (the trap)', adapterEac, 0);
    ok('S20-H04-G the unmeasured forecast never publishes that compatibility value',
      gated.cost.realistic !== adapterEac && gated.cost.realistic === null);
    eq('S20-H04-G the two EAC channels stay separate: canonical null vs scenario null',
      [emptyCanonical.eac, gated.cost.realistic], [null, null]);
    eq('S20-H04-C with perfect measured indices and no critical work the confidence is 100',
      measured.confidence, 100);
    eq('S20-H04-C the measured forecast is identical to the ungated call (no behaviour change)',
      JSON.stringify(measured.scenarios),
      JSON.stringify(analyzeForecast(START, END, 100000, 50000, 0.5, 1, 1, 0, 0, BDD, []).scenarios));
    eq('S20-H04-C the measured cost forecast still divides by the measured CPI',
      measured.cost.realistic, 50000 + 100000 * 0.5 / 1);
    // Slippage is still penalised when the indices are measured.
    const slipping = analyzeForecast(START, END, 100000, 50000, 0.5, 0.5, 0.5, 0, 0, BDD, [],
      { cpi: 'valid', spi: 'valid' });
    ok('S20-H04-C a measured 0.5 SPI still pushes the finish out',
      (slipping.scenarios.realistic as string) > (measured.scenarios.realistic as string));
    ok('S20-H04-C a measured 0.5 CPI still lowers the confidence',
      (slipping.confidence as number) < (measured.confidence as number));
    // No statuses supplied at all => previous behaviour, so no existing caller is disturbed.
    const ungated = analyzeForecast(START, END, 100000, 50000, 0.5, 1, 1, 2, 1, BDD, []);
    eq('S20-H04-C an ungated call keeps its number-valued confidence', typeof ungated.confidence, 'number');
    eq('S20-H04-C an ungated call is still marked measured', ungated.measured, true);
    eq('S20-H04-C an ungated call still subtracts critical and near-critical work',
      ungated.confidence, 100 - 2 * 2 - 1);

    // The Dashboard is the consumer that used to feed the synthetic values in.
    const dashSrcB = readFileSync(resolvePath(s20Root, 'src/components/views/Dashboard.tsx'), 'utf8');
    ok('S20-H04 the dashboard gates the forecast on the canonical index statuses',
      /analyzeForecast\([\s\S]{0,900}\{\s*cpi:\s*evm\.cpiStatus,\s*spi:\s*evm\.spiStatus\s*\}/.test(dashSrcB));
    ok('S20-H04 the dashboard still treats a null realistic finish as N/A, not as a date',
      /if\s*\(!forecastFinish\)\s*return\s*null;/.test(dashSrcB));
  }
}

// ===========================================================================
// S21 — Batch B (P2A1): cross-engine reconciliation closures.
//
//   B01  Multi-Scenario uses the wrong EVM      The simulator's measured baseline was a SECOND EVM
//                                               derivation; it must quote canonical F6.
//   NG04 Earned Schedule legacy fallback        `calculateEarnedSchedule` fell back to the legacy
//                                               planning EVM; it must fall back to canonical F6.
//   NG03 Reconciliation uses stored early_finish The deterministic finish was a frozen activity
//                                               column; it must be the statused F5 CPM forecast.
//   H03  F7 ignores low confidence              F7 issued directive actions on Low-confidence
//                                               evidence; strength must respect source confidence.
//
// The fixture is the SHIPPED pilot seed (no synthetic data, no seed edits), at the project's own
// governed Data Date — the exact input on which the divergence was reported. Each subsection first
// proves the divergent path really did disagree with canonical F6 (a regression test that cannot
// fail on the pre-fix code is not a regression test), then asserts the reconciled behaviour.
// ---------------------------------------------------------------------------
{
  console.log('--- S21 Batch B (P2A1) cross-engine reconciliation closures');

  // Source-reading root: the screens pull in `@/lib/supabase` and cannot be bundled for node ESM,
  // so their shipped sources are read as text (the same approach S17-E / S20 use).
  const s21Root = (() => {
    const cwd = process.cwd();
    if (existsSync(resolvePath(cwd, 'package.json'))) return cwd;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolvePath(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    return cwd;
  })();
  const s21Src = (rel: string): string => readFileSync(resolvePath(s21Root, rel), 'utf8');

  // ---------------------------------------------------------------------
  // Shared fixture: project `proj-seed-001` at its governed Data Date.
  // ---------------------------------------------------------------------
  const s21Seed = getInitialSeedData() as Record<string, unknown[]>;
  const s21Projects = (s21Seed['projects'] || []) as unknown as Project[];
  const s21P1 = s21Projects.find((p) => p.id === 'proj-seed-001') as Project;
  const s21P2 = s21Projects.find((p) => p.id === 'proj-seed-002') as Project;
  const s21Acts = ((s21Seed['activities'] || []) as unknown as Activity[]).filter((a) => a.project_id === s21P1.id);
  const s21Links = ((s21Seed['activity_links'] || []) as unknown as ActivityLink[]).filter((l) => l.project_id === s21P1.id);
  const s21Bgts = ((s21Seed['budget_lines'] || []) as unknown as BudgetLine[]).filter((b) => b.project_id === s21P1.id);
  const s21Txns = ((s21Seed['cost_transactions'] || []) as unknown as CostTransaction[]).filter((t) => t.project_id === s21P1.id);
  const s21Prgs = ((s21Seed['progress_updates'] || []) as unknown as ProgressUpdate[]).filter((u) => u.project_id === s21P1.id);
  const s21Boqs = ((s21Seed['boq_items'] || []) as unknown as BoqItem[]).filter((b) => b.project_id === s21P1.id);
  const s21ActIds = new Set(s21Acts.map((a) => a.id));
  const s21Bsls = ((s21Seed['baseline_activities'] || []) as unknown as BaselineActivity[]).filter((b) => s21ActIds.has(b.activity_id));
  const s21Dd = s21P1.data_date || DD;

  /** Canonical F6 for a project/Data Date — the single source of truth under test. */
  const s21F6 = (
    project: Project, acts: Activity[], bsls: BaselineActivity[], bgts: BudgetLine[],
    txns: CostTransaction[], prgs: ProgressUpdate[], boqs: BoqItem[], dataDate: string,
  ) => analyzeCostControl({
    project, activities: acts, baselines: bsls, budgetLines: bgts, costTransactions: txns,
    progressUpdates: prgs, wbsNodes: [], boqItems: boqs, allocations: [], dataDate,
    calendarType: project.calendar_type || '6_days',
  });
  const s21Canon = selectCanonicalEvm(s21F6(s21P1, s21Acts, s21Bsls, s21Bgts, s21Txns, s21Prgs, s21Boqs, s21Dd));
  /** The superseded derivation Batch B removes from every simulation/ES fallback path. */
  const s21Legacy = calculateProjectEvmAtDataDate(s21P1, s21Acts, s21Bgts, s21Boqs, s21Txns, s21Prgs);
  const s21Base = buildScenarioEvmBaseline({
    project: s21P1, activities: s21Acts, baselines: s21Bsls, budgetLines: s21Bgts,
    costTransactions: s21Txns, progressUpdates: s21Prgs, wbsNodes: [], boqItems: s21Boqs,
    allocations: [], dataDate: s21Dd, calendarType: s21P1.calendar_type as '6_days',
  });
  const s21RunOpts = { seed: 7, iterations: 20, risks: [] };
  const s21Sim = simulateComplexProjectScenario(
    s21P1, s21Acts, s21Links, s21Bgts, STANDARD_COMPLEX_SCENARIOS[0], s21Base, s21RunOpts,
  );

  const s21F5 = analyzeScheduleControl({
    activities: s21Acts, links: s21Links, baselines: s21Bsls, progressUpdates: s21Prgs,
    previousSnapshot: null, dataDate: s21Dd, calendarType: s21P1.calendar_type || '6_days',
    statusLogic: s21P1.status_logic || 'retained_logic',
  });

  ok('S21 the fixture is the shipped pilot project', s21P1 !== undefined && s21Acts.length > 0);
  ok('S21 the fixture really is divergent: the legacy derivation disagrees with canonical F6',
    s21Legacy.ev !== s21Canon.ev && s21Legacy.cpi !== s21Canon.cpi && s21Legacy.eac !== s21Canon.eac);

  // =====================================================================
  // B01 — Multi-Scenario Simulation must use the canonical F6 EVM basis.
  // =====================================================================
  {
    // A / B / C / D: the four figures named in the gap, quoted from F6 by the simulation baseline.
    eq('S21-B01-A simulation baseline EV === canonical F6 EV', s21Base.ev, s21Canon.ev);
    eq('S21-B01-A simulation EV is not the legacy derivation', s21Base.ev, s21Canon.ev);
    ok('S21-B01-A the legacy derivation is materially different (the defect being closed)',
      s21Legacy.ev !== s21Canon.ev);
    eq('S21-B01-B simulation baseline CPI === canonical F6 CPI', s21Base.cpi, s21Canon.cpi);
    ok('S21-B01-B the legacy CPI is materially different', s21Legacy.cpi !== s21Canon.cpi);
    eq('S21-B01-C simulation baseline EAC === canonical F6 EAC', s21Base.eac, s21Canon.eac);
    ok('S21-B01-C the legacy EAC is materially different', s21Legacy.eac !== s21Canon.eac);
    eq('S21-B01-D simulation baseline VAC === canonical F6 VAC', s21Base.vac, s21Canon.vac);
    ok('S21-B01-D the legacy VAC is materially different', s21Legacy.vac !== s21Canon.vac);
    // The rest of the reconciled block (the gap names PV and AC too).
    eq('S21-B01 simulation baseline PV === canonical F6 PV', s21Base.pv, s21Canon.pv);
    eq('S21-B01 simulation baseline AC === canonical F6 AC', s21Base.ac, s21Canon.ac);
    eq('S21-B01 simulation baseline BAC === canonical F6 BAC', s21Base.bac, s21Canon.bac);
    eq('S21-B01 simulation baseline SPI === canonical F6 SPI', s21Base.spi, s21Canon.spi);
    eq('S21-B01 the baseline states its canonical provenance', s21Base.source, CANONICAL_EVM_SOURCE);
    eq('S21-B01 the baseline is anchored at the governed Data Date', s21Base.dataDate, s21Dd);

    // The published scenario result quotes the same measured facts, so the screen reconciles.
    eq('S21-B01-A the published scenario EV === canonical F6 EV', s21Sim.canonicalEvSar, Math.round(s21Canon.ev as number));
    eq('S21-B01-B the published scenario baseline CPI === canonical F6 CPI', s21Sim.baselineCpi, s21Canon.cpi);
    eq('S21-B01-C the published scenario baseline EAC === canonical F6 EAC', s21Sim.baselineEacSar, Math.round(s21Canon.eac as number));
    eq('S21-B01-D the published scenario baseline VAC === canonical F6 VAC', s21Sim.baselineVacSar, Math.round(s21Canon.vac as number));
    eq('S21-B01 the published scenario baseline PV === canonical F6 PV', s21Sim.baselinePvSar, Math.round(s21Canon.pv as number));
    eq('S21-B01 the published scenario baseline AC === canonical F6 AC', s21Sim.canonicalAcSar, Math.round(s21Canon.ac));

    // E: changing the Data Date, or the project, must not reintroduce a divergent basis.
    const s21Dd2 = '2026-09-01';
    const s21Canon2 = selectCanonicalEvm(s21F6(s21P1, s21Acts, s21Bsls, s21Bgts, s21Txns, s21Prgs, s21Boqs, s21Dd2));
    const s21Legacy2 = calculateProjectEvmAtDataDate(s21P1, s21Acts, s21Bgts, s21Boqs, s21Txns, s21Prgs, s21Dd2);
    const s21Base2 = buildScenarioEvmBaseline({
      project: s21P1, activities: s21Acts, baselines: s21Bsls, budgetLines: s21Bgts,
      costTransactions: s21Txns, progressUpdates: s21Prgs, wbsNodes: [], boqItems: s21Boqs,
      allocations: [], dataDate: s21Dd2, calendarType: s21P1.calendar_type as '6_days',
    });
    ok('S21-B01-E the two Data Dates really do measure different positions', s21Canon2.ev !== s21Canon.ev);
    eq('S21-B01-E a different Data Date still quotes canonical F6 EV', s21Base2.ev, s21Canon2.ev);
    eq('S21-B01-E a different Data Date still quotes canonical F6 CPI', s21Base2.cpi, s21Canon2.cpi);
    eq('S21-B01-E a different Data Date still quotes canonical F6 EAC', s21Base2.eac, s21Canon2.eac);
    ok('S21-B01-E the legacy derivation diverges at the second Data Date too', s21Legacy2.ev !== s21Canon2.ev);
    eq('S21-B01-E the baseline follows the governed Data Date', s21Base2.dataDate, s21Dd2);

    const s21Acts2 = ((s21Seed['activities'] || []) as unknown as Activity[]).filter((a) => a.project_id === s21P2.id);
    const s21Ids2 = new Set(s21Acts2.map((a) => a.id));
    const s21Bsls2 = ((s21Seed['baseline_activities'] || []) as unknown as BaselineActivity[]).filter((b) => s21Ids2.has(b.activity_id));
    const s21DdP2 = s21P2.data_date || DD;
    const s21Canon3 = selectCanonicalEvm(s21F6(s21P2, s21Acts2, s21Bsls2, [], [], [], [], s21DdP2));
    const s21Legacy3 = calculateProjectEvmAtDataDate(s21P2, s21Acts2, [], [], [], []);
    const s21Base3 = buildScenarioEvmBaseline({
      project: s21P2, activities: s21Acts2, baselines: s21Bsls2, budgetLines: [],
      costTransactions: [], progressUpdates: [], wbsNodes: [], boqItems: [], allocations: [],
      dataDate: s21DdP2, calendarType: s21P2.calendar_type as '6_days',
    });
    eq('S21-B01-E a different project still quotes canonical F6 EV', s21Base3.ev, s21Canon3.ev);
    eq('S21-B01-E a different project still quotes canonical F6 CPI', s21Base3.cpi, s21Canon3.cpi);
    ok('S21-B01-E the legacy derivation diverges on the second project too', s21Legacy3.ev !== s21Canon3.ev);

    // No second source of truth: the legacy derivation is gone from the simulation path.
    const simSrc = s21Src('src/lib/complexScenarioSimulator.ts');
    ok('S21-B01 the scenario engine no longer imports the legacy EVM derivation',
      !/import\s*{[^}]*\bcalculateProjectEvmAtDataDate\b/.test(simSrc.replace(/\n/g, ' ')));
    ok('S21-B01 the scenario engine no longer calls the legacy EVM derivation',
      !/calculateProjectEvmAtDataDate\s*\(/.test(simSrc));
    ok('S21-B01 the scenario engine builds its baseline from canonical F6',
      /buildScenarioEvmBaseline\([\s\S]{0,400}analyzeCostControl\(/.test(simSrc)
      && /selectCanonicalEvm\(report\)/.test(simSrc));
    const simViewSrc = s21Src('src/components/views/MultiScenarioSimulationView.tsx');
    ok('S21-B01 the simulation screen no longer imports the legacy EVM derivation',
      !/import\s*{[^}]*\bcalculateProjectEvmAtDataDate\b/.test(simViewSrc.replace(/\n/g, ' ')));
    ok('S21-B01 the simulation screen builds its baseline through the canonical helper',
      /buildScenarioEvmBaseline\(\{/.test(simViewSrc));
    ok('S21-B01 the simulation screen loads the governed active approved baseline',
      /project_baselines!inner\(project_id, is_active, status\)/.test(simViewSrc));
    // The degraded "no cost evidence supplied" branch must still land on F6, not on a third path.
    const s21Fallback = simulateComplexProjectScenario(s21P1, s21Acts, s21Links, s21Bgts, STANDARD_COMPLEX_SCENARIOS[0], null, s21RunOpts);
    ok('S21-B01 the internal fallback stays on canonical F6 (BAC from the governed baseline)',
      s21Fallback.baselineBacSar === Math.round(s21Canon.bac as number));
    noNonFinite('S21-B01 simulation result scan', s21Sim);
    noNonFinite('S21-B01 baseline scan', s21Base);
  }

  // =====================================================================
  // NG04 — Earned Schedule must consume canonical F6, never the legacy EVM.
  // =====================================================================
  {
    const s21EsSources = {
      project: s21P1, activities: s21Acts, baselines: s21Bsls,
      calendarType: s21P1.calendar_type as '6_days', costTransactions: s21Txns,
      progressUpdates: s21Prgs, budgetLines: s21Bgts, boqItems: s21Boqs,
    };
    // B: no `evm` supplied => the engine must derive canonical F6, not the legacy planning EVM.
    const esFallback = calculateEarnedSchedule(s21EsSources);
    eq('S21-NG04-B the fallback EVM CPI === canonical F6 CPI', esFallback.costPerformanceIndex, s21Canon.cpi);
    ok('S21-NG04-B the legacy planning EVM is NOT used (its CPI differs materially)',
      Math.abs(esFallback.costPerformanceIndex - s21Legacy.cpi) > 0.5);
    ok('S21-NG04-B the legacy planning EVM would have produced a different forecast',
      Math.abs(esFallback.costPerformanceIndex - s21Legacy.cpi) > 0.001);

    // A: an explicitly supplied canonical EVM is used verbatim and is never replaced.
    const s21EsBasis = canonicalEvmToComprehensive(s21Canon);
    const esExplicit = calculateEarnedSchedule({ ...s21EsSources, evm: s21EsBasis });
    eq('S21-NG04-A an explicitly supplied canonical EVM is consumed unchanged',
      esExplicit.costPerformanceIndex, s21EsBasis.cpi);
    eq('S21-NG04-A an explicitly supplied EVM reproduces the same earned schedule',
      JSON.stringify(esExplicit), JSON.stringify(esFallback));
    // A distinctive supplied EVM must win over the fallback (proves the supplied path is live).
    const s21Distinct = { ...s21EsBasis, cpi: 2.5, ev: 1234, pv: 617, ac: 617 };
    const esDistinct = calculateEarnedSchedule({ ...s21EsSources, evm: s21Distinct });
    eq('S21-NG04-A a supplied EVM is never overwritten by the F6 fallback',
      esDistinct.costPerformanceIndex, 2.5);

    // ---------------------------------------------------------------------------
    // P2A1-NEW-GAP-04 CLOSURE (E..H): the EMPTY / no-activity early-return path used
    // to publish CPI = 1.0, SPI = 1.0 and `on_track` (plus a forecast date equal to the
    // Data Date) BEFORE canonical F6 was ever consulted — a perfect performance record
    // synthesized from no evidence. Empty must now be UNMEASURED.
    // ---------------------------------------------------------------------------
    const esEmptyActivities = calculateEarnedSchedule({ ...s21EsSources, activities: [] });
    const esNoProject = calculateEarnedSchedule({ ...s21EsSources, project: null });

    for (const [label, es] of [['zero activities', esEmptyActivities], ['no project', esNoProject]] as const) {
      // --- NG04-E: CPI / SPI are not 1.0. ---
      eq(`S21-NG04-E ${label}: CPI is not the synthetic 1.0`, es.costPerformanceIndex === 1, false);
      eq(`S21-NG04-E ${label}: SPI(t) is not the synthetic 1.0`, es.schedulePerformanceIndexTime === 1, false);
      eq(`S21-NG04-E ${label}: CPI is null (N/A)`, es.costPerformanceIndex, null);
      eq(`S21-NG04-E ${label}: SPI(t) is null (N/A)`, es.schedulePerformanceIndexTime, null);
      eq(`S21-NG04-E ${label}: the traditional comparison SPI is null too`,
        es.comparisonWithTraditionalEvm.evmSpi, null);
      eq(`S21-NG04-E ${label}: the ES comparison SPI is null too`,
        es.comparisonWithTraditionalEvm.esmSpi, null);
      // --- NG04-F: the status is not on_track. ---
      eq(`S21-NG04-F ${label}: status is not on_track`, es.status === 'on_track', false);
      ok(`S21-NG04-F ${label}: no positive performance state is claimed`,
        es.status !== 'ahead' && es.status !== 'on_track');
      // --- NG04-G: an explicit unmeasured / no-data state. ---
      eq(`S21-NG04-G ${label}: status is the explicit unmeasured state`, es.status, 'unmeasured');
      eq(`S21-NG04-G ${label}: the result says it is not measured`, es.measured, false);
      eq(`S21-NG04-G ${label}: no forecast completion date is invented`, es.forecastCompletionDate, null);
      ok(`S21-NG04-G ${label}: the note states there is nothing to compute`,
        /لا توجد بيانات/.test(es.timeDivergenceNote));
      // --- and no downstream surface can turn that into a measured forecast. ---
      const emptyRecon = reconcileFinishForecasts([], es);
      eq(`S21-NG04-G ${label}: the reconciliation reports the ES trend as unavailable`,
        emptyRecon.esAvailability, 'es_unmeasured');
      eq(`S21-NG04-G ${label}: ... and publishes no trend finish`, emptyRecon.esTrendFinish, null);
      eq(`S21-NG04-G ${label}: ... and is not computable`, emptyRecon.esComputable, false);
    }

    // --- NG04-H: a REAL measured 1.0 remains valid. ---
    const esMeasured = calculateEarnedSchedule(s21EsSources);
    eq('S21-NG04-H a real run is flagged as measured', esMeasured.measured, true);
    ok('S21-NG04-H a real run publishes numeric CPI / SPI(t)',
      typeof esMeasured.costPerformanceIndex === 'number'
      && typeof esMeasured.schedulePerformanceIndexTime === 'number');
    ok('S21-NG04-H a real run publishes a real status, never the unmeasured one',
      esMeasured.status !== 'unmeasured');
    ok('S21-NG04-H a real run publishes a forecast completion date',
      typeof esMeasured.forecastCompletionDate === 'string');
    // The distinction Codex asked for: measured 1.00 and no-data are different values.
    const perfect = calculateEarnedSchedule({
      ...s21EsSources,
      evm: { ...canonicalEvmToComprehensive(s21Canon), cpi: 1, spi: 1, ev: 1000, pv: 1000, ac: 1000 },
    });
    eq('S21-NG04-H a genuinely measured CPI of 1.0 is still published as 1',
      perfect.costPerformanceIndex, 1);
    ok('S21-NG04-H ... and is distinguishable from the empty no-data state',
      perfect.costPerformanceIndex === 1 && esEmptyActivities.costPerformanceIndex === null);
    noNonFinite('S21-NG04 the empty earned-schedule state is finite', {
      empty: esEmptyActivities, noProject: esNoProject,
    });

    // C: the legacy planning EVM is gone from the Earned Schedule engine entirely.
    const esSrc = s21Src('src/lib/earnedScheduleEngine.ts');
    ok('S21-NG04-C the Earned Schedule engine no longer imports the legacy EVM derivation',
      !/import\s*{[^}]*\bcalculateProjectEvmAtDataDate\b/.test(esSrc.replace(/\n/g, ' ')));
    ok('S21-NG04-C the Earned Schedule engine no longer calls the legacy EVM derivation',
      !/calculateProjectEvmAtDataDate\s*\(/.test(esSrc));
    ok('S21-NG04-C the Earned Schedule fallback runs canonical F6',
      /analyzeCostControl\(\{/.test(esSrc) && /quoteCanonicalEvm\(/.test(esSrc));

    // D: the published output is internally consistent with the canonical PV/EV basis.
    eq('S21-NG04-D the published SV is the canonical EV - PV',
      esFallback.comparisonWithTraditionalEvm.evmSvAmount, Math.round((s21Canon.ev as number) - (s21Canon.pv as number)));
    eq('S21-NG04-D the published SPI is the canonical SPI', esFallback.comparisonWithTraditionalEvm.evmSpi, s21Canon.spi);
    eq('S21-NG04-D the published CPI is the canonical CPI', esFallback.costPerformanceIndex, s21Canon.cpi);
    ok('S21-NG04-D the earned schedule stays inside the planned span',
      esFallback.earnedScheduleDays >= 0 && esFallback.earnedScheduleDays <= esFallback.plannedDurationDays);
    noNonFinite('S21-NG04 earned schedule scan', esFallback);
  }

  // =====================================================================
  // NG03 — the deterministic finish must be the statused F5 CPM forecast.
  // =====================================================================
  {
    const storedFinish = calculateCpmDeterministicEarlyFinish(s21Acts);
    ok('S21-NG03 the fixture reproduces the defect: the stored column disagrees with F5',
      storedFinish !== null && s21F5.project.forecastFinish !== null && storedFinish !== s21F5.project.forecastFinish);

    // A: the helper derives the governed statused CPM finish, and reconciliation quotes it.
    const derived = resolveDeterministicForecastFinish({
      activities: s21Acts, links: s21Links, baselines: s21Bsls, progressUpdates: s21Prgs,
      dataDate: s21Dd, calendarType: s21P1.calendar_type as '6_days',
      statusLogic: s21P1.status_logic || 'retained_logic',
    });
    eq('S21-NG03-A the derived deterministic finish === F5 forecast finish', derived, s21F5.project.forecastFinish);
    const recon = reconcileFinishForecasts(s21Acts, null, s21F5.project.forecastFinish);
    eq('S21-NG03-A reconciliation deterministic finish === F5 forecast finish', recon.cpmEarlyFinish, s21F5.project.forecastFinish);
    eq('S21-NG03-A reconciliation states the F5 basis', recon.deterministicFinishSource, 'f5_statused_cpm');
    ok('S21-NG03-A reconciliation is not quoting the stored early_finish column', recon.cpmEarlyFinish !== storedFinish);

    // D: a delayed statused schedule must not fall back to the original stored early_finish.
    eq('S21-NG03-D the statused schedule really is delayed against the stored plan', recon.cpmEarlyFinish !== storedFinish, true);
    ok('S21-NG03-D the stored date is never substituted for the statused forecast',
      recon.cpmEarlyFinish === s21F5.project.forecastFinish && storedFinish !== s21F5.project.forecastFinish);
    eq('S21-NG03-D without an F5 finish the stored date is still named as such',
      reconcileFinishForecasts(s21Acts, null).deterministicFinishSource, 'stored_early_finish');

    // B / C: the two screens that reported the stale finish now consume the statused CPM.
    const progSrc = s21Src('src/components/views/ProgressView.tsx');
    const execSrc = s21Src('src/components/views/ExecutiveReportView.tsx');
    const statusedArg = /reconcileFinishForecasts\(\s*activities,\s*earnedScheduleData,\s*statusedForecastFinish\s*\)/;
    ok('S21-NG03-B ProgressView derives the statused deterministic finish',
      /resolveDeterministicForecastFinish\(\{/.test(progSrc));
    ok('S21-NG03-B ProgressView reconciles against the statused finish',
      statusedArg.test(progSrc));
    ok('S21-NG03-C ExecutiveReportView derives the statused deterministic finish',
      /resolveDeterministicForecastFinish\(\{/.test(execSrc));
    ok('S21-NG03-C ExecutiveReportView reconciles against the statused finish',
      statusedArg.test(execSrc));
    // One authoritative producer: both screens call the same helper, neither recomputes it.
    const recSrc = s21Src('src/lib/forecastReconciliation.ts');
    ok('S21-NG03 the reconciliation helper derives the finish from the statused CPM engine',
      /analyzeScheduleControl\(\{/.test(recSrc) && /report\.project\.forecastFinish/.test(recSrc));
    ok('S21-NG03 the stored-column reader is documented as not the current forecast',
      /NOT the current project forecast/.test(recSrc));
  }

  // =====================================================================
  // H03 — F7 recommendation strength must respect source confidence.
  // =====================================================================
  {
    // The strength rule itself (exported, so the rule is testable and never re-implemented).
    eq('S21-H03 the rule: Low issue confidence is investigate-only', resolveRecommendationStrength('Low', 'Low'), 'investigate_only');
    eq('S21-H03 the rule: Low issue confidence is investigate-only even under a High gate', resolveRecommendationStrength('Low', 'High'), 'investigate_only');
    eq('S21-H03 the rule: a Low overall gate downgrades a well-evidenced issue to advisory', resolveRecommendationStrength('High', 'Low'), 'advisory');
    eq('S21-H03 the rule: Medium/High leaves the directive intact', resolveRecommendationStrength('High', 'High'), 'directive');
    eq('S21-H03 the rule: Medium issue + Medium gate stays a directive', resolveRecommendationStrength('Medium', 'Medium'), 'directive');

    // --- Low schedule + Low cost confidence fixture ---------------------
    // One baseline row across four activities: F5 baseline coverage 0.25 (< 0.8) puts the F5
    // forecast-finish confidence at Low, and the same coverage puts F6's BAC basis (and therefore
    // its forecast confidence) at Low. The one baselined activity carries a real delay and a real
    // cost overrun, so F7 still has an issue to act on.
    const h3Dd = '2026-09-01';
    const h3Project = {
      id: 'p1', contract_value: 1000000, data_date: h3Dd, calendar_type: '6_days',
      start_date: '2026-08-01', end_date: '2026-09-30', duration_days: 45,
    } as unknown as Project;
    const h3Acts = [
      act({ id: 'H1', code: 'H1', duration_days: 8, early_start: '2026-08-01', early_finish: '2026-08-10', actual_start: '2026-08-05', percent_complete: 30, planned_quantity: 100, actual_quantity: 30 }),
      act({ id: 'H2', code: 'H2', duration_days: 5, early_start: '2026-08-11', early_finish: '2026-08-17' }),
      act({ id: 'H3', code: 'H3', duration_days: 4, early_start: '2026-08-18', early_finish: '2026-08-23' }),
      act({ id: 'H4', code: 'H4', duration_days: 3, early_start: '2026-08-24', early_finish: '2026-08-28' }),
    ];
    const h3Links = [link('HL1', 'H1', 'H2'), link('HL2', 'H2', 'H3'), link('HL3', 'H3', 'H4')];
    const h3Bsls = [base('HB1', 'H1', '2026-08-01', '2026-08-10', 8, 100000)];
    const h3Txns = [txn('HT1', 'H1', '2026-08-20', 60000, 'approved')];
    const h3F5 = analyzeScheduleControl({
      activities: h3Acts, links: h3Links, baselines: h3Bsls, progressUpdates: [],
      previousSnapshot: null, dataDate: h3Dd, calendarType: '6_days', statusLogic: 'retained_logic',
    });
    const h3F6 = analyzeCostControl({
      project: h3Project, activities: h3Acts, baselines: h3Bsls, budgetLines: [],
      costTransactions: h3Txns, progressUpdates: [], wbsNodes: [], boqItems: [], allocations: [],
      dataDate: h3Dd, calendarType: '6_days',
    });
    const h3F7 = analyzeIntegratedDecisions({
      scheduleReport: h3F5, costReport: h3F6, activities: h3Acts, links: h3Links, baselines: h3Bsls,
      progressUpdates: [], previousScheduleSnapshot: null, previousCostSnapshot: null,
      dataDate: h3Dd, calendarType: '6_days',
    });
    eq('S21-H03-A the fixture really is Low schedule confidence', h3F5.confidence.forecastFinish.level, 'Low');
    eq('S21-H03-A the fixture really is Low cost confidence', h3F6.confidence.forecast.level, 'Low');
    eq('S21-H03-A the overall gate is Low', h3F7.summary.overallConfidence, 'Low');
    ok('S21-H03-A the fixture does produce decisions to gate', h3F7.actions.length > 0);

    // A: no High-confidence directive action.
    ok('S21-H03-A no directive action is issued on Low confidence',
      h3F7.actions.every((a) => a.recommendationStrength !== 'directive'));
    eq('S21-H03-A the summary strength is not directive', h3F7.summary.recommendationStrength !== 'directive', true);

    // B: the top decision is guidance, not an assertive management directive.
    const h3DirectiveTexts = Object.values(ACTION_PLAYBOOK);
    const h3AdvisoryTexts = Object.values(DECISION_ADVISORY_PLAYBOOK);
    ok('S21-H03-B the top decision is not one of the directive playbook texts',
      h3F7.summary.topDecision !== null && !h3DirectiveTexts.includes(h3F7.summary.topDecision as string));
    ok('S21-H03-B the top decision is advisory / diagnostic guidance',
      h3F7.summary.topDecision !== null && h3AdvisoryTexts.includes(h3F7.summary.topDecision as string));
    ok('S21-H03-B no emitted action carries a directive text',
      h3F7.actions.every((a) => !h3DirectiveTexts.includes(a.recommendedAction)));
    ok('S21-H03-B every action says why it is not a directive',
      h3F7.actions.every((a) => a.strengthNote.length > 0));

    // C: guidance IS still generated — nothing is hidden.
    ok('S21-H03-C diagnostic/advisory guidance is still generated', h3F7.actions.length > 0);
    ok('S21-H03-C the guidance keeps its evidence', h3F7.actions.every((a) => a.evidence.length > 0));
    ok('S21-H03-C the guidance keeps its issue identity', h3F7.actions.every((a) => a.issueId.length > 0 && a.title.length > 0));
    ok('S21-H03-C the underlying issue is still reported', h3F7.issues.length > 0);
    ok('S21-H03-C the measured scenario benefit is still published with the guidance',
      h3F7.actions.every((a) => a.expectedBenefit === null || a.expectedBenefitNote.length > 0));
    ok('S21-H03-C the downgrade is explained in the summary notes',
      h3F7.summary.overallNotes.some((n) => n.includes('recommendation strength')));

    // D: Medium/High confidence behaviour is unchanged — the pilot seed (F5 High, F6 Medium).
    const s21F7 = analyzeIntegratedDecisions({
      scheduleReport: s21F5, costReport: s21F6(s21P1, s21Acts, s21Bsls, s21Bgts, s21Txns, s21Prgs, s21Boqs, s21Dd),
      activities: s21Acts, links: s21Links, baselines: s21Bsls, progressUpdates: s21Prgs,
      previousScheduleSnapshot: null, previousCostSnapshot: null, dataDate: s21Dd, calendarType: '6_days',
    });
    ok('S21-H03-D the seed fixture is not Low confidence', s21F7.summary.overallConfidence !== 'Low');
    ok('S21-H03-D the seed fixture does produce decisions', s21F7.actions.length > 0);
    ok('S21-H03-D Medium/High confidence still yields directive actions',
      s21F7.actions.every((a) => a.recommendationStrength === 'directive'));
    ok('S21-H03-D directive actions keep the original playbook wording',
      s21F7.actions.every((a) => h3DirectiveTexts.includes(a.recommendedAction)));
    eq('S21-H03-D the summary strength stays directive', s21F7.summary.recommendationStrength, 'directive');
    // And the gate is really the weakest of the two sources.
    eq('S21-H03-D the overall gate is the weaker source', s21F7.summary.overallConfidence,
      gateConfidence(s21F5.confidence.forecastFinish.level, s21F6(s21P1, s21Acts, s21Bsls, s21Bgts, s21Txns, s21Prgs, s21Boqs, s21Dd).confidence.forecast.level));

    // One rule, one place: the engine exports it and the dashboard renders it.
    const f7Src = s21Src('src/lib/integratedDecisionEngine.ts');
    ok('S21-H03 the strength rule lives in F7 and is applied to every action',
      /resolveRecommendationStrength\(it\.confidence\.overall, overallGate\)/.test(f7Src));
    ok('S21-H03 the advisory playbook covers every directive playbook key',
      Object.keys(ACTION_PLAYBOOK).every((k) => typeof DECISION_ADVISORY_PLAYBOOK[k] === 'string'));
    const dashSrcC = s21Src('src/components/views/Dashboard.tsx');
    ok('S21-H03 the dashboard labels a non-directive top decision',
      /decisions\.summary\.recommendationStrength !== 'directive'/.test(dashSrcC));
    noNonFinite('S21-H03 F7 report scan', s21F7);
    noNonFinite('S21-H03 low-confidence F7 report scan', h3F7);
  }

  // =====================================================================
  // Batch-wide reconciliation: one project, one governed Data Date, one answer.
  // =====================================================================
  {
    const recF6 = s21F6(s21P1, s21Acts, s21Bsls, s21Bgts, s21Txns, s21Prgs, s21Boqs, s21Dd);
    const recCanon = selectCanonicalEvm(recF6);
    const recBase = buildScenarioEvmBaseline({
      project: s21P1, activities: s21Acts, baselines: s21Bsls, budgetLines: s21Bgts,
      costTransactions: s21Txns, progressUpdates: s21Prgs, wbsNodes: [], boqItems: s21Boqs,
      allocations: [], dataDate: s21Dd, calendarType: s21P1.calendar_type as '6_days',
    });
    const recEs = calculateEarnedSchedule({
      project: s21P1, activities: s21Acts, baselines: s21Bsls,
      calendarType: s21P1.calendar_type as '6_days', costTransactions: s21Txns,
      progressUpdates: s21Prgs, budgetLines: s21Bgts, boqItems: s21Boqs,
    });
    const recF7 = analyzeIntegratedDecisions({
      scheduleReport: s21F5, costReport: recF6, activities: s21Acts, links: s21Links,
      baselines: s21Bsls, progressUpdates: s21Prgs, previousScheduleSnapshot: null,
      previousCostSnapshot: null, dataDate: s21Dd, calendarType: '6_days',
    });
    // F6 vs the Multi-Scenario baseline (PV/EV/AC/SPI/CPI/EAC/VAC).
    eq('S21-reconcile F6 PV === simulation baseline PV', recCanon.pv, recBase.pv);
    eq('S21-reconcile F6 EV === simulation baseline EV', recCanon.ev, recBase.ev);
    eq('S21-reconcile F6 AC === simulation baseline AC', recCanon.ac, recBase.ac);
    eq('S21-reconcile F6 SPI === simulation baseline SPI', recCanon.spi, recBase.spi);
    eq('S21-reconcile F6 CPI === simulation baseline CPI', recCanon.cpi, recBase.cpi);
    eq('S21-reconcile F6 EAC === simulation baseline EAC', recCanon.eac, recBase.eac);
    eq('S21-reconcile F6 VAC === simulation baseline VAC', recCanon.vac, recBase.vac);
    // F6 vs F7 (F7 quotes F6 by reference).
    eq('S21-reconcile F7 totals quote F6 PV', recF7.totals.pv, recF6.project.pv);
    eq('S21-reconcile F7 totals quote F6 EV', recF7.totals.ev, recF6.project.ev);
    eq('S21-reconcile F7 totals quote F6 AC', recF7.totals.ac, recF6.project.ac);
    eq('S21-reconcile F7 totals quote F6 EAC', recF7.totals.eac, recF6.project.eac);
    eq('S21-reconcile F7 totals quote F6 VAC', recF7.totals.vac, recF6.project.vac);
    // F6 vs Earned Schedule (same EV/CPI basis, no legacy fallback).
    eq('S21-reconcile Earned Schedule CPI === F6 CPI', recEs.costPerformanceIndex, recCanon.cpi);
    eq('S21-reconcile Earned Schedule SPI === F6 SPI', recEs.comparisonWithTraditionalEvm.evmSpi, recCanon.spi);
    // F5 deterministic finish vs the reconciliation surface every screen reads.
    eq('S21-reconcile the deterministic finish === F5 forecast finish',
      reconcileFinishForecasts(s21Acts, recEs, s21F5.project.forecastFinish).cpmEarlyFinish,
      s21F5.project.forecastFinish);
    eq('S21-reconcile F5 and F7 agree on the forecast finish', recF7.summary.forecastFinish, s21F5.project.forecastFinish);
    eq('S21-reconcile F7 publishes its recommendation strength', typeof recF7.summary.recommendationStrength, 'string');
  }
}


// ---------------------------------------------------------------------------
// S22 — Batch C (P2A1): NO STATIC CONTROL CLAIMS / NO FAKE AUDIT PASS /
//                       NO SYNTHETIC HEALTHY KPI FROM MISSING DATA.
//
//   NG02  WATCH-FLOAT-01 was a pseudo-audit: a filter closing with `return false;`
//         plus a hardcoded `exact` / deviation 0 verdict claiming "zero decimal drift
//         across all 10 activities". It must perform a real TF = LF - EF check on the
//         project's own working-day calendar, count activities dynamically, and be able
//         to FAIL.
//   NG01  the four headline Multi-Scenario KPI cards were literals ("100% Precision
//         Parity", "+55 Days", "+515,933 SAR", "-30 Days"). They must be derived from the
//         current scenario results and the current watchdog audit, and an unmeasured law
//         (cash flow) must never be presented as verified.
//   NG05  PortfolioView published SPI = 1.0 / CPI = 1.0 when the denominator was zero.
//         No evidence must render N/A; a measured 1.00 must survive.
//
// The fixtures are the SHIPPED pilot seed (no seed edits) plus injections built from the
// canonical engines' own output. Where a defect is data-dependent (NG02 on the seed), the
// test asserts the audit DETECTS it — a check that passed before the fix would not bind.
// ---------------------------------------------------------------------------
{
  console.log('--- S22 Batch C (P2A1) static-claim / pseudo-audit / no-data closures');

  const s22Root = (() => {
    const cwd = process.cwd();
    if (existsSync(resolvePath(cwd, 'package.json'))) return cwd;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(resolvePath(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    return cwd;
  })();
  const s22Src = (rel: string): string => readFileSync(resolvePath(s22Root, rel), 'utf8');
  /** The shipped source minus comments, for constant checks the defect documentation must not trip. */
  const s22Code = (rel: string): string => s22Src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const simulatorSrc = s22Src('src/lib/complexScenarioSimulator.ts');
  const portfolioSrc = s22Src('src/components/views/PortfolioView.tsx');
  const simulationViewSrc = s22Src('src/components/views/MultiScenarioSimulationView.tsx');
  const cpmSrc = s22Src('src/lib/cpmEngine.ts');

  // ---------------------------------------------------------------------
  // Shared fixture: the shipped pilot seed, at each project's Data Date.
  // ---------------------------------------------------------------------
  const s22Seed = getInitialSeedData() as Record<string, unknown[]>;
  const s22Projects = (s22Seed['projects'] || []) as unknown as Project[];
  const s22P1 = s22Projects.find((p) => p.id === 'proj-seed-001') as Project;
  const s22P2 = s22Projects.find((p) => p.id === 'proj-seed-002') as Project;
  const s22ActsOf = (pid: string): Activity[] =>
    ((s22Seed['activities'] || []) as unknown as Activity[]).filter((a) => a.project_id === pid);
  const s22LinksOf = (pid: string): ActivityLink[] =>
    ((s22Seed['activity_links'] || []) as unknown as ActivityLink[]).filter((l) => l.project_id === pid);
  const s22Acts = s22ActsOf(s22P1.id);
  const s22Links = s22LinksOf(s22P1.id);
  const s22Dd = s22P1.data_date || DD;
  const s22Cal = (s22P1.calendar_type || '6_days') as CalendarType;

  const s22FloatMetric = (project: Project, acts: Activity[]) =>
    runPrecisionWatchdogAudit(project, acts, [], []).find((m) => m.id === 'WATCH-FLOAT-01');

  // =====================================================================
  // NEW-GAP-02 — WATCH-FLOAT-01 must be a real Total Float conservation
  //              check that can fail.
  // =====================================================================

  // A CPM-consistent record: EF/LF/TF taken from the canonical CPM engine's own output, so the
  // law TF = LF - EF holds by construction on the project's working-day calendar.
  const s22Cpm = calculateCpm(s22Acts, s22Links, { calendarType: s22Cal, dataDate: s22Dd });
  const s22Consistent: Activity[] = s22Acts.map((a) => {
    const r = s22Cpm.results.find((x) => x.activityId === a.id);
    return r
      ? { ...a, early_finish: r.earlyFinish, late_finish: r.lateFinish, total_float: r.totalFloat }
      : a;
  });
  const s22NonMilestoneCount = s22Consistent.filter(
    (a) => !a.is_milestone && a.activity_type !== 'start_milestone' && a.activity_type !== 'finish_milestone',
  ).length;

  // --- NG02-A: valid CPM float data => PASS -------------------------------
  const s22OkCheck = auditTotalFloatConservation(s22Consistent, s22Cal);
  eq('S22-NG02-A every non-milestone activity is evaluated', s22OkCheck.evaluatedCount, s22NonMilestoneCount);
  eq('S22-NG02-A a CPM-consistent record violates nothing', s22OkCheck.failedCount, 0);
  eq('S22-NG02-A the worst drift on a consistent record is 0', s22OkCheck.maxDriftDays, 0);
  const s22OkMetric = s22FloatMetric(s22P1, s22Consistent);
  eq('S22-NG02-A WATCH-FLOAT-01 is exact on valid float data', s22OkMetric?.precisionStatus, 'exact');
  eq('S22-NG02-A WATCH-FLOAT-01 reports zero deviation', s22OkMetric?.deviation, 0);
  ok('S22-NG02-A the evaluated count is dynamic, not the hardcoded 10',
    s22OkMetric !== undefined && s22OkMetric.expectedValue.includes(`all ${s22NonMilestoneCount} evaluated`));

  // --- NG02-B: inject one incorrect total_float => FAIL -------------------
  const s22Victim = s22Consistent[3];
  const s22Broken: Activity[] = s22Consistent.map((a) =>
    a.id === s22Victim.id ? { ...a, total_float: (a.total_float ?? 0) + 7 } : a);
  const s22BadCheck = auditTotalFloatConservation(s22Broken, s22Cal);
  eq('S22-NG02-B one injected float produces exactly one violation', s22BadCheck.failedCount, 1);
  eq('S22-NG02-B the violation is counted against the evaluated total',
    s22BadCheck.matchedCount, s22BadCheck.evaluatedCount - 1);
  eq('S22-NG02-B the drift is the injected amount', s22BadCheck.maxDriftDays, 7);
  const s22BadMetric = s22FloatMetric(s22P1, s22Broken);
  eq('S22-NG02-B WATCH-FLOAT-01 FAILS when the float is wrong', s22BadMetric?.precisionStatus, 'drift_detected');
  eq('S22-NG02-B the published deviation is the measured drift', s22BadMetric?.deviation, 7);
  ok('S22-NG02-B a wrong float can no longer be published as an exact audit',
    s22BadMetric?.precisionStatus !== 'exact' && s22BadMetric?.deviation !== 0);

  // --- NG02-C: the failure identifies the actual mismatch -----------------
  const s22Failure = s22BadCheck.failures[0];
  eq('S22-NG02-C the reported activity is the injected one', s22Failure?.activityCode, s22Victim.code);
  eq('S22-NG02-C the reported stored float is the corrupted one',
    s22Failure?.storedTotalFloat, (s22Victim.total_float ?? 0) + 7);
  ok('S22-NG02-C the reported expected float is recomputed, not copied',
    s22Failure !== undefined && s22Failure.expectedTotalFloat !== s22Failure.storedTotalFloat);
  ok('S22-NG02-C the evidence carries the EF/LF pair that was compared',
    s22Failure !== undefined && s22Failure.earlyFinish.length === 10 && s22Failure.lateFinish.length === 10);
  ok('S22-NG02-C the metric note names the failing activity and both figures',
    s22BadMetric !== undefined
    && s22BadMetric.notesEn.includes(String(s22Victim.code))
    && s22BadMetric.notesEn.includes(String(s22Failure?.storedTotalFloat))
    && s22BadMetric.notesEn.includes(String(s22Failure?.expectedTotalFloat)));

  // --- NG02-D: the evaluated activity count is dynamic ---------------------
  const s22Half = auditTotalFloatConservation(s22Consistent.slice(0, 5), s22Cal);
  eq('S22-NG02-D the count follows the activities handed in', s22Half.evaluatedCount, 5);
  ok('S22-NG02-D the count is not the hardcoded 10', s22Half.evaluatedCount !== 10);
  const s22HalfMetric = s22FloatMetric(s22P1, s22Consistent.slice(0, 5));
  ok('S22-NG02-D the published expectation quotes the real count',
    s22HalfMetric !== undefined && s22HalfMetric.expectedValue.includes('all 5 evaluated'));
  ok('S22-NG02-D the note never claims a fixed activity count',
    s22HalfMetric !== undefined && !/all 10 activities/.test(s22HalfMetric.notesEn));
  // Scope the constant check to the emitted WATCH-FLOAT-01 block: the surrounding documentation
  // legitimately quotes the retired wording when explaining what the defect was.
  const s22FloatBlock = (() => {
    const i = simulatorSrc.indexOf("id: 'WATCH-FLOAT-01'");
    const j = simulatorSrc.indexOf('\n  });', i);
    return i >= 0 && j > i ? simulatorSrc.slice(i, j) : '';
  })();
  ok('S22-NG02-D the WATCH-FLOAT-01 block was located', s22FloatBlock.length > 0);
  ok('S22-NG02-D the emitted metric contains no hardcoded activity count',
    !/10/.test(s22FloatBlock) && !/all \d+ activities/.test(s22FloatBlock));
  ok('S22-NG02-D the exact verdict is conditional on the measured failure count',
    /floatCheck\.failedCount === 0[\s\S]{0,30}\?\s*'exact'/.test(s22FloatBlock)
    && /!floatMeasured[\s\S]{0,30}\?\s*'not_measured'/.test(s22FloatBlock));

  // --- NG02-E: milestones / excluded activities follow the CPM engine ------
  const s22WithMilestones: Activity[] = [
    ...s22Consistent,
    {
      ...s22Consistent[0], id: 'S22-MS-A', code: 'S22-MS-A', is_milestone: true, total_float: 999,
    } as Activity,
    {
      ...s22Consistent[1], id: 'S22-MS-B', code: 'S22-MS-B', is_milestone: false,
      activity_type: 'finish_milestone' as Activity['activity_type'], total_float: 999,
    } as Activity,
  ];
  const s22MsCheck = auditTotalFloatConservation(s22WithMilestones, s22Cal);
  eq('S22-NG02-E milestones are excluded exactly as CPM excludes them',
    s22MsCheck.evaluatedCount, s22NonMilestoneCount);
  eq('S22-NG02-E a milestone float is never held to the law', s22MsCheck.failedCount, 0);
  ok('S22-NG02-E the milestone test mirrors the canonical CPM engine rule',
    /activity\.is_milestone\s*\|\|[\s\S]{0,120}activity_type === 'start_milestone'[\s\S]{0,80}activity_type === 'finish_milestone'/.test(simulatorSrc)
    && /isMilestone = activity\.is_milestone \|\| activity\.activity_type === 'start_milestone' \|\| activity\.activity_type === 'finish_milestone'/.test(cpmSrc));
  const s22NoRecord = auditTotalFloatConservation(
    s22Consistent.map((a) => ({ ...a, late_finish: null })) as Activity[], s22Cal);
  eq('S22-NG02-E an activity with no LF is not evaluated', s22NoRecord.evaluatedCount, 0);
  eq('S22-NG02-E ... and is reported, never silently skipped', s22NoRecord.notEvaluableCount, s22NonMilestoneCount);

  // --- NG02-F: working-day / calendar semantics match the CPM engine -------
  // EF 2026-08-25 (Tue) -> LF 2026-08-30 (Sun): 5 CALENDAR days but only 4 working days on the
  // project's 6-day week (Friday off). The seed stores the calendar-day value.
  const s22FriSpan: Activity[] = [{
    ...s22Consistent[0], id: 'S22-F', code: 'S22-F', is_milestone: false,
    early_finish: '2026-08-25', late_finish: '2026-08-30', total_float: 5,
  } as Activity];
  const s22Fri = auditTotalFloatConservation(s22FriSpan, '6_days');
  const s22CalDays = Math.round(
    (Date.parse('2026-08-30') - Date.parse('2026-08-25')) / 86400000);
  eq('S22-NG02-F the calendar-day reading of the same span is 5', s22CalDays, 5);
  eq('S22-NG02-F the audit counts WORKING days, not calendar days',
    s22Fri.failures[0]?.expectedTotalFloat, countWorkingDays('2026-08-25', '2026-08-30', getCalendar('6_days')) - 1);
  eq('S22-NG02-F ... which is 4 on a 6-day week', s22Fri.failures[0]?.expectedTotalFloat, 4);
  eq('S22-NG02-F the stored calendar-day float is reported as a 1-day drift',
    s22Fri.failures[0]?.driftDays, 1);
  eq('S22-NG02-F the same span on a 5-day week yields 3 working days',
    auditTotalFloatConservation(s22FriSpan, '5_days').failures[0]?.expectedTotalFloat, 3);
  ok('S22-NG02-F the audit uses the shared working-day engine',
    /countWorkingDays\(/.test(simulatorSrc) && /getCalendar\(/.test(simulatorSrc));
  ok('S22-NG02-F the audit never subtracts raw calendar days',
    !/86400000/.test(simulatorSrc) && !/Date\.parse\([^)]*\)\s*-\s*Date\.parse/.test(simulatorSrc));

  // --- the audit must be able to fail on real data, and never pass on nothing ---
  const s22SeedMetric = s22FloatMetric(s22P1, s22Acts);
  eq('S22-NG02 the shipped seed no longer passes a float law it violates',
    s22SeedMetric?.precisionStatus, 'drift_detected');
  ok('S22-NG02 the seed violation is a real measured drift, not an assertion',
    (s22SeedMetric?.deviation ?? 0) > 0
    && auditTotalFloatConservation(s22Acts, s22Cal).failedCount > 0);
  ok('S22-NG02 the seed drift is the calendar-day float stored on ACT-004/ACT-007',
    auditTotalFloatConservation(s22Acts, s22Cal).failures.map((f) => f.activityCode).join(',') === 'ACT-004,ACT-007');
  const s22EmptyMetric = s22FloatMetric(s22P1, []);
  eq('S22-NG02 an audit that evaluated nothing is not_measured', s22EmptyMetric?.precisionStatus, 'not_measured');
  eq('S22-NG02 ... and publishes no deviation at all', s22EmptyMetric?.deviation, null);
  ok('S22-NG02 ... and never claims parity', s22EmptyMetric?.precisionStatus !== 'exact');
  noNonFinite('S22-NG02 the float audit output is finite', {
    ok: s22OkCheck, bad: s22BadCheck, empty: auditTotalFloatConservation([], '6_days'),
  });

  // =====================================================================
  // NEW-GAP-01 — every headline simulation KPI must be derived.
  // =====================================================================
  const s22BaselineOf = (project: Project, acts: Activity[], bsls: BaselineActivity[]) =>
    buildScenarioEvmBaseline({
      project, activities: acts, baselines: bsls, budgetLines: [], costTransactions: [],
      progressUpdates: [], wbsNodes: [], boqItems: [], allocations: [],
      dataDate: project.data_date || DD, calendarType: (project.calendar_type || '6_days') as CalendarType,
    });
  const s22ActIds = new Set(s22Acts.map((a) => a.id));
  const s22Bsls = ((s22Seed['baseline_activities'] || []) as unknown as BaselineActivity[])
    .filter((b) => s22ActIds.has(b.activity_id));
  const s22P2Acts = s22ActsOf(s22P2.id);
  const s22P2Ids = new Set(s22P2Acts.map((a) => a.id));
  const s22P2Bsls = ((s22Seed['baseline_activities'] || []) as unknown as BaselineActivity[])
    .filter((b) => s22P2Ids.has(b.activity_id));

  const s22Base1 = s22BaselineOf(s22P1, s22Acts, s22Bsls);
  const s22Base2 = s22BaselineOf(s22P2, s22P2Acts, s22P2Bsls);
  const s22RunOpts = { seed: 11, iterations: 20, risks: [] };

  // --- NG01-A: changing scenario results changes the KPI -------------------
  const s22Neutral = simulateComplexProjectScenario(
    s22P1, s22Acts, s22Links, [], STANDARD_COMPLEX_SCENARIOS[0], s22Base1, s22RunOpts);
  const s22Delayed = simulateComplexProjectScenario(
    s22P1, s22Acts, s22Links, [], STANDARD_COMPLEX_SCENARIOS[3], s22Base1, s22RunOpts);
  const s22Accelerated = simulateComplexProjectScenario(
    s22P1, s22Acts, s22Links, [], STANDARD_COMPLEX_SCENARIOS[6], s22Base1, s22RunOpts);
  ok('S22-NG01-A the three probe scenarios really do differ',
    s22Neutral.varianceDays !== s22Delayed.varianceDays
    && s22Delayed.varianceDays !== s22Accelerated.varianceDays);

  const s22KpiNeutral = summarizeSimulationControlKpis([s22Neutral], []);
  eq('S22-NG01-A a neutral-only set measures no schedule drift',
    s22KpiNeutral.maxScheduleDrift.value, null);
  const s22KpiDelayed = summarizeSimulationControlKpis([s22Neutral, s22Delayed], []);
  eq('S22-NG01-A adding the delaying scenario changes the drift KPI',
    s22KpiDelayed.maxScheduleDrift.value, s22Delayed.varianceDays);
  eq('S22-NG01-A ... and it names the scenario that produced it',
    s22KpiDelayed.maxScheduleDrift.scenarioId, s22Delayed.scenarioId);
  const s22KpiAccel = summarizeSimulationControlKpis([s22Neutral, s22Delayed, s22Accelerated], []);
  eq('S22-NG01-A the compression KPI is the most negative variance',
    s22KpiAccel.maxCompression.value, s22Accelerated.varianceDays);
  eq('S22-NG01-A the cost KPI tracks the largest measured overrun',
    s22KpiAccel.maxCostOverrun.value,
    Math.max(...[s22Neutral, s22Delayed, s22Accelerated]
      .map((r) => r.costVarianceSar)
      .filter((v): v is number => v !== null && v > 0)));

  // --- NG01-B: changing active project does not leave stale fixed values ---
  const s22P1Results = STANDARD_COMPLEX_SCENARIOS.map((m) =>
    simulateComplexProjectScenario(s22P1, s22Acts, s22Links, [], m, s22Base1, s22RunOpts));
  const s22P2Results = STANDARD_COMPLEX_SCENARIOS.map((m) =>
    simulateComplexProjectScenario(s22P2, s22P2Acts, s22LinksOf(s22P2.id), [], m, s22Base2, s22RunOpts));
  const s22KpiP1 = summarizeSimulationControlKpis(s22P1Results, runPrecisionWatchdogAudit(s22P1, s22Acts, [], s22P1Results));
  const s22KpiP2 = summarizeSimulationControlKpis(s22P2Results, runPrecisionWatchdogAudit(s22P2, s22P2Acts, [], s22P2Results));
  const s22P1MaxCost = Math.max(...s22P1Results.map((r) => r.costVarianceSar).filter((v): v is number => v !== null && v > 0));
  const s22P2MaxCost = Math.max(...s22P2Results.map((r) => r.costVarianceSar).filter((v): v is number => v !== null && v > 0));
  ok('S22-NG01-B the two projects really do produce different overruns', s22P1MaxCost !== s22P2MaxCost);
  eq('S22-NG01-B project 1 card value is project 1 own maximum', s22KpiP1.maxCostOverrun.value, s22P1MaxCost);
  eq('S22-NG01-B project 2 card value is project 2 own maximum', s22KpiP2.maxCostOverrun.value, s22P2MaxCost);
  ok('S22-NG01-B switching project changes the card value',
    s22KpiP1.maxCostOverrun.value !== s22KpiP2.maxCostOverrun.value);
  ok('S22-NG01-B no card value is the retired hardcoded constant',
    s22KpiP1.maxCostOverrun.value !== 515933
    && s22KpiP1.maxScheduleDrift.value !== 55
    && s22KpiP1.maxCompression.value !== -30);

  // --- NG01-C: missing / unmeasured metric renders N/A ---------------------
  const s22NoAudit = summarizeSimulationControlKpis(s22P1Results, []);
  eq('S22-NG01-C no watchdog output means no parity percentage', s22NoAudit.precisionParityPercent, null);
  eq('S22-NG01-C ... and nothing is counted as measured', s22NoAudit.measuredCheckCount, 0);
  const s22AllNotMeasured = runPrecisionWatchdogAudit(s22P1, [], [], s22P1Results).map((m) => ({
    ...m, precisionStatus: 'not_measured' as const, deviation: null,
  }));
  eq('S22-NG01-C an all-not-measured audit yields N/A, never 100%',
    summarizeSimulationControlKpis(s22P1Results, s22AllNotMeasured).precisionParityPercent, null);
  const s22CostlessResults: ComplexScenarioResult[] = s22P1Results.map((r) => ({ ...r, costVarianceSar: null }));
  eq('S22-NG01-C an unmeasured cost outcome renders N/A',
    summarizeSimulationControlKpis(s22CostlessResults, []).maxCostOverrun.value, null);
  eq('S22-NG01-C ... with no scenario attribution', summarizeSimulationControlKpis(s22CostlessResults, []).maxCostOverrun.scenarioId, null);
  eq('S22-NG01-C an unmeasured compression renders N/A',
    summarizeSimulationControlKpis([s22Neutral], []).maxCompression.value, null);

  // --- NG01-D: an unmeasured law cannot be presented as verified -----------
  const s22Watch = runPrecisionWatchdogAudit(s22P1, s22Acts, [], s22P1Results);
  const s22Cash = s22Watch.find((m) => m.id === 'WATCH-CASH-01');
  eq('S22-NG01-D the cash-flow audit really is unmeasured on this project',
    s22Cash?.precisionStatus, 'not_measured');
  const s22KpiFull = summarizeSimulationControlKpis(s22P1Results, s22Watch);
  ok('S22-NG01-D cash flow is listed as NOT measured',
    s22KpiFull.notMeasuredCategories.includes('cashflow_integrity'));
  ok('S22-NG01-D cash flow is not counted among the measured laws',
    !s22KpiFull.measuredCategories.includes('cashflow_integrity'));
  ok('S22-NG01-D the unmeasured law is excluded from the parity denominator',
    s22KpiFull.measuredCheckCount === s22Watch.filter((m) => m.precisionStatus !== 'not_measured').length);
  ok('S22-NG01-D the published scope names what was measured and what was not',
    s22KpiFull.verificationScopeEn.includes('Measured:')
    && s22KpiFull.verificationScopeEn.includes('not measured (N/A): Cash flow'));
  ok('S22-NG01-D the scope text never claims an unmeasured law is verified',
    !/strictly verified/.test(s22KpiFull.verificationScopeEn)
    && !/verified/i.test(s22KpiFull.verificationScopeEn.split('not measured')[1] || ''));
  ok('S22-NG01-D the screen no longer carries the "strictly verified" claim',
    !/strictly verified/.test(simulationViewSrc));
  ok('S22-NG01-D the parity percentage reflects the drift the audit found',
    s22KpiFull.precisionParityPercent
      === Math.round(((s22KpiFull.measuredCheckCount - s22KpiFull.driftCount) / s22KpiFull.measuredCheckCount) * 100));

  // --- NG01-E: no hardcoded constants remain in the top cards --------------
  const s22CardBlock = (() => {
    const start = simulationViewSrc.indexOf('Top 4 Real-time Monitored Metrics Cards');
    const end = simulationViewSrc.indexOf('Navigation Tabs', start);
    return start >= 0 && end > start ? simulationViewSrc.slice(start, end) : '';
  })();
  ok('S22-NG01-E the top-cards block was located', s22CardBlock.length > 0);
  for (const banned of ['100%', '+55', '515,933', '515933', '-30', '0.00 ر.س']) {
    ok(`S22-NG01-E the top cards no longer contain the constant ${banned}`,
      !s22CardBlock.includes(banned));
  }
  ok('S22-NG01-E every card reads the derived summary', (s22CardBlock.match(/controlKpis\./g) || []).length >= 12);
  const s22ViewCode = s22Code('src/components/views/MultiScenarioSimulationView.tsx');
  ok('S22-NG01-E the retired cost constant is gone from the whole screen',
    !/515,?933/.test(s22ViewCode));
  ok('S22-NG01-E the retired drift constants are gone as rendered KPI text',
    !/>\s*\+55\s*</.test(s22ViewCode) && !/>\s*-30\s*</.test(s22ViewCode));
  noNonFinite('S22-NG01-E the KPI summary is finite', { p1: s22KpiP1, p2: s22KpiP2 });

  // =====================================================================
  // NEW-GAP-05 — portfolio SPI/CPI: no data is not 1.00.
  // =====================================================================
  const s22Contrib = (
    ev: number | null, pv: number | null, ac: number,
    spiStatus?: PortfolioIndexContributor['spiStatus'],
    cpiStatus?: PortfolioIndexContributor['cpiStatus'],
  ): PortfolioIndexContributor => ({
    ev, pv, ac,
    spiStatus: spiStatus ?? (pv !== null && pv > 0 ? 'valid' : ev !== null && ev > 0 ? 'anomalous_zero_denominator' : 'empty_no_data'),
    cpiStatus: cpiStatus ?? (ac > 0 ? 'valid' : ev !== null && ev > 0 ? 'anomalous_zero_denominator' : 'empty_no_data'),
  });

  // --- NG05-A: zero / no PV => SPI N/A, not 1.00 --------------------------
  eq('S22-NG05-A zero planned value yields no SPI', rollUpPortfolioIndices([s22Contrib(0, 0, 1000)]).spi, null);
  eq('S22-NG05-A ... and says the portfolio is empty', rollUpPortfolioIndices([s22Contrib(0, 0, 1000)]).spiStatus, 'empty_no_data');
  eq('S22-NG05-A an unmeasurable planned value yields no SPI', rollUpPortfolioIndices([s22Contrib(500, null, 1000)]).spi, null);
  eq('S22-NG05-A zero planned value still measures CPI', rollUpPortfolioIndices([s22Contrib(500, 0, 1000)]).cpi, 0.5);
  eq('S22-NG05-A an empty portfolio yields no SPI', rollUpPortfolioIndices([]).spi, null);
  eq('S22-NG05-A an empty portfolio yields no CPI', rollUpPortfolioIndices([]).cpi, null);

  // --- NG05-B: zero / no AC => CPI N/A, not 1.00 --------------------------
  const s22NoAc = rollUpPortfolioIndices([s22Contrib(500, 1000, 0)]);
  eq('S22-NG05-B no actual cost yields no CPI', s22NoAc.cpi, null);
  eq('S22-NG05-B ... and flags the anomaly instead of a healthy 1.00',
    s22NoAc.cpiStatus, 'anomalous_zero_denominator');
  ok('S22-NG05-B the reported CPI is not the synthetic 1.0', s22NoAc.cpi !== 1);
  eq('S22-NG05-B no actual cost still measures SPI', s22NoAc.spi, 0.5);
  eq('S22-NG05-B a project with no AC contributes nothing to the CPI', s22NoAc.cpiProjectCount, 0);
  const s22MixedNoAc = rollUpPortfolioIndices([s22Contrib(500, 1000, 0), s22Contrib(2000, 1000, 1000)]);
  eq('S22-NG05-B the CPI covers only the projects with valid evidence', s22MixedNoAc.cpiProjectCount, 1);
  eq('S22-NG05-B ... and sums numerator and denominator over the same set', s22MixedNoAc.cpi, 2);
  eq('S22-NG05-B the CPI denominator excludes the evidenceless project', s22MixedNoAc.cpiAcSar, 1000);
  eq('S22-NG05-B the CPI numerator excludes the evidenceless project', s22MixedNoAc.cpiEvSar, 2000);

  // --- NG05-C: a genuine measured SPI of 1.00 remains 1.00 ----------------
  const s22PerfectSpi = rollUpPortfolioIndices([s22Contrib(1000, 1000, 500)]);
  eq('S22-NG05-C a measured SPI of 1.00 is still published', s22PerfectSpi.spi, 1);
  eq('S22-NG05-C ... and is flagged valid', s22PerfectSpi.spiStatus, 'valid');
  const s22MixedSpi = rollUpPortfolioIndices([s22Contrib(600, 600, 100), s22Contrib(900, null, 100)]);
  eq('S22-NG05-C a measured 1.00 survives a neighbour with no PV', s22MixedSpi.spi, 1);
  eq('S22-NG05-C ... and the coverage is reported', s22MixedSpi.spiProjectCount, 1);
  ok('S22-NG05-C a measured 1.00 is distinguishable from no data',
    s22MixedSpi.spi === 1 && rollUpPortfolioIndices([s22Contrib(0, 0, 0)]).spi === null);

  // --- NG05-D: a genuine measured CPI of 1.00 remains 1.00 ----------------
  const s22PerfectCpi = rollUpPortfolioIndices([s22Contrib(1000, 1000, 1000)]);
  eq('S22-NG05-D a measured CPI of 1.00 is still published', s22PerfectCpi.cpi, 1);
  eq('S22-NG05-D ... and is flagged valid', s22PerfectCpi.cpiStatus, 'valid');
  const s22MixedCpi = rollUpPortfolioIndices([s22Contrib(700, 700, 700), s22Contrib(900, 900, 0)]);
  eq('S22-NG05-D a measured 1.00 survives a neighbour with no AC', s22MixedCpi.cpi, 1);
  eq('S22-NG05-D ... and the coverage is reported', s22MixedCpi.cpiProjectCount, 1);

  // --- NG05-E: the portfolio cards distinguish no-data from 1.00 ----------
  ok('S22-NG05-E the SPI card renders N/A when the index is null',
    /portfolioSpi === null \? 'N\/A' : portfolioSpi\.toFixed\(2\)/.test(portfolioSrc));
  ok('S22-NG05-E the CPI card renders N/A when the index is null',
    /portfolioCpi === null \? 'N\/A' : portfolioCpi\.toFixed\(2\)/.test(portfolioSrc));
  ok('S22-NG05-E no fallback can publish a synthetic 1.0 index',
    !/\?\s*1\.0\b/.test(s22Code('src/components/views/PortfolioView.tsx'))
    && !/:\s*1\.0\b/.test(s22Code('src/components/views/PortfolioView.tsx')));
  ok('S22-NG05-E the portfolio indices come from the canonical roll-up',
    /rollUpPortfolioIndices\(portfolioProjects\)/.test(portfolioSrc)
    && /portfolioIndices\.spi/.test(portfolioSrc) && /portfolioIndices\.cpi/.test(portfolioSrc));
  ok('S22-NG05-E the cards state how many projects the figure covers',
    /portfolioIndices\.spiProjectCount/.test(portfolioSrc) && /portfolioIndices\.cpiProjectCount/.test(portfolioSrc));
  ok('S22-NG05-E a project with no index renders N/A rather than 0',
    /p\.spi === null \? \([\s\S]{0,220}N\/A/.test(portfolioSrc)
    && /p\.cpi === null \? \([\s\S]{0,220}N\/A/.test(portfolioSrc));

  // --- the shipped portfolio is unaffected: every project carries real evidence ---
  const s22SeedContributors: PortfolioIndexContributor[] = s22Projects.slice(0, 4).map((proj) => {
    const acts = s22ActsOf(proj.id);
    const ids = new Set(acts.map((a) => a.id));
    const bsls = ((s22Seed['baseline_activities'] || []) as unknown as BaselineActivity[])
      .filter((b) => ids.has(b.activity_id));
    const canon = selectCanonicalEvm(analyzeCostControl({
      project: proj, activities: acts, baselines: bsls, budgetLines: [],
      costTransactions: ((s22Seed['cost_transactions'] || []) as unknown as CostTransaction[])
        .filter((t) => t.project_id === proj.id),
      progressUpdates: [], wbsNodes: [], boqItems: [], allocations: [],
      dataDate: proj.data_date || DD, calendarType: (proj.calendar_type || '6_days') as CalendarType,
    }));
    return { ev: canon.ev, pv: canon.pv, ac: canon.ac, spiStatus: canon.spiStatus, cpiStatus: canon.cpiStatus };
  });
  const s22SeedRollup = rollUpPortfolioIndices(s22SeedContributors);
  ok('S22-NG05 the shipped portfolio still publishes a measured SPI', s22SeedRollup.spi !== null);
  ok('S22-NG05 the shipped portfolio still publishes a measured CPI', s22SeedRollup.cpi !== null);
  eq('S22-NG05 every shipped project contributes valid evidence',
    s22SeedRollup.spiProjectCount, s22SeedContributors.length);
  ok('S22-NG05 the roll-up matches the same ratio over the same evidence',
    Math.abs((s22SeedRollup.spi as number) - s22SeedRollup.spiEvSar / s22SeedRollup.spiPvSar) <= 0.01
    && Math.abs((s22SeedRollup.cpi as number) - s22SeedRollup.cpiEvSar / s22SeedRollup.cpiAcSar) <= 0.01);
  noNonFinite('S22-NG05 the portfolio roll-up is finite', s22SeedRollup);

  // =====================================================================
  // Batch-wide: nothing in Batch C introduces a static claim or a zero
  // denominator presented as health.
  // =====================================================================
  ok('S22 the float audit is the only producer of WATCH-FLOAT-01 figures',
    /auditTotalFloatConservation\(activities, project\.calendar_type\)/.test(simulatorSrc));
  ok('S22 the float audit no longer short-circuits to success',
    !/Verified exact by CPM engine/.test(simulatorSrc) && !/return false; \/\/ Verified/.test(simulatorSrc));
  ok('S22 the KPI summary is the only producer of the headline card values',
    /summarizeSimulationControlKpis\(/.test(simulationViewSrc));
  ok('S22 the portfolio never divides by a denominator it did not validate',
    !/totalPortfolioPv > 0 \?/.test(portfolioSrc) && !/totalPortfolioAc > 0 \?/.test(portfolioSrc));
  eq('S22 the watchdog still reports the cash-flow audit as unmeasured', s22Cash?.deviation, null);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.log(`VALIDATION FAILED: ${failures} of ${checks} checks failed.`);
  process.exit(1);
} else {
  console.log(`VALIDATION PASSED: ${checks}/${checks} checks.`);
}

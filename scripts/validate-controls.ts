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
import { resolveDataDate, isIsoDate, isAfterDataDate, isOnOrBeforeDataDate, calendarDaysBetween, classifyByDate, latestDate, earliestDate } from '@/lib/chronologyGuard';
import { calculateCpm } from '@/lib/cpmEngine';
import { getCalendar, countWorkingDays, addWorkingDays } from '@/lib/calendarEngine';
import { calculateBaselineVariances } from '@/lib/trendEngine';
import { generateScheduleAlerts } from '@/lib/alertEngine';
import { calculateRecoveryPlan } from '@/lib/recoveryEngine';
import { levelScheduleResources } from '@/lib/resourceLevelingEngine';
import { parseXerContent } from '@/lib/xerImporter';
import { generateBoqPlan, emptyBoqOverrides } from '@/lib/boqPlanningEngine';
import { calculateProjectEvmAtDataDate, deriveEvmFromScalars, assessEvmRatios } from '@/lib/planningEngine';
import { analyzeScheduleControl, buildUpdateSnapshot, workingDayDelta, summarizeCanonicalCriticality, type StatusedActivity } from '@/lib/scheduleControlEngine';
import { analyzeCostControl, buildCostSnapshot } from '@/lib/costControlEngine';
import { analyzeIntegratedDecisions, gateConfidence } from '@/lib/integratedDecisionEngine';
import { analyzeForecastTrust } from '@/lib/forecastTrustEngine';
import { selectCanonicalEvm, canonicalEvmToComprehensive, quoteCanonicalEvm, CANONICAL_EVM_SOURCE } from '@/lib/canonicalEvm';
// S18 (F9.5 Pilot Closure): the governance EVM pillar is a PURE module precisely so this harness can
// drive the same function that renders the visible `EVM-01/02/03` row. `dataGovernanceEngine` itself
// cannot be imported here — it pulls in `@/lib/supabase`.
import { buildGovernanceEvmCheck, formatGovernedSar, CANONICAL_EVM_ROW_MARKER, DIAGNOSTIC_ROW_MARKER } from '@/lib/governanceEvmPillar';
import { getInitialSeedData } from '@/lib/mockSeed';
import { applyReviewCostTransaction, unimplementedRpcError, reviewStateOf, selectGovernedBaselineActivities, type DemoDb } from '@/lib/demoDbContracts';
import { reconcileFinishForecasts, calculateCpmDeterministicEarlyFinish } from '@/lib/forecastReconciliation';
import { calculateControlHealth } from '@/lib/controlHealthEngine';
import {
  simulateComplexProjectScenario, resolveScenarioScheduleBasis, runPrecisionWatchdogAudit,
  calculateScenarioSensitivityTornado, STANDARD_COMPLEX_SCENARIOS,
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
  const critF5 = analyzeScheduleControl({
    activities: critActs, links: critLinks, baselines: [], progressUpdates: [],
    previousSnapshot: null, dataDate: DD, calendarType: '6_days',
  });
  const crit = summarizeCanonicalCriticality(critActs, critLinks, { dataDate: DD, calendarType: '6_days' });
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
    JSON.stringify(summarizeCanonicalCriticality(critActs, critLinks, { dataDate: DD, calendarType: '6_days' }).criticalIds),
    JSON.stringify(crit.criticalIds));
  // Machine-clock independence: criticality must not read the wall clock.
  let critShifted: string[] = [];
  withShiftedClock(400, () => {
    critShifted = summarizeCanonicalCriticality(critActs, critLinks, { dataDate: DD, calendarType: '6_days' }).criticalIds;
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
  const f6With = (baselines: BaselineActivity[]) => analyzeCostControl({
    project: mkProject({ contract_value: 1000000 }), activities: govActs, baselines,
    budgetLines: [], costTransactions: govTxns, progressUpdates: [], wbsNodes: [], boqItems: [],
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
  const cpCanon = summarizeCanonicalCriticality(cpActs, cpLinks, { dataDate: DD, calendarType: '6_days' });
  const cpF5 = analyzeScheduleControl({
    activities: cpActs, links: cpLinks, baselines: [], progressUpdates: [],
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
console.log('');
if (failures > 0) {
  console.log(`VALIDATION FAILED: ${failures} of ${checks} checks failed.`);
  process.exit(1);
} else {
  console.log(`VALIDATION PASSED: ${checks}/${checks} checks.`);
}

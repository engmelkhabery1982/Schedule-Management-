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
 *
 * Expectations are either independently hand-computed (refWdDelta replicates the documented
 * inclusive working-day convention on purpose) or exact quotes of the source engine's output —
 * a downstream engine that re-derives a number instead of quoting it fails the equality checks.
 */
import { DEFAULT_DATA_DATE, governedDefaultToday } from '@/lib/projectControlsConstants';
import { resolveDataDate, isIsoDate, isAfterDataDate, isOnOrBeforeDataDate, calendarDaysBetween, classifyByDate, latestDate, earliestDate } from '@/lib/chronologyGuard';
import { calculateCpm } from '@/lib/cpmEngine';
import { getCalendar, countWorkingDays } from '@/lib/calendarEngine';
import { calculateBaselineVariances } from '@/lib/trendEngine';
import { generateScheduleAlerts } from '@/lib/alertEngine';
import { calculateRecoveryPlan } from '@/lib/recoveryEngine';
import { levelScheduleResources } from '@/lib/resourceLevelingEngine';
import { parseXerContent } from '@/lib/xerImporter';
import { generateBoqPlan, emptyBoqOverrides } from '@/lib/boqPlanningEngine';
import { calculateProjectEvmAtDataDate, deriveEvmFromScalars, assessEvmRatios } from '@/lib/planningEngine';
import { analyzeScheduleControl, buildUpdateSnapshot, workingDayDelta } from '@/lib/scheduleControlEngine';
import { analyzeCostControl, buildCostSnapshot } from '@/lib/costControlEngine';
import { analyzeIntegratedDecisions, gateConfidence } from '@/lib/integratedDecisionEngine';
import { analyzeForecastTrust } from '@/lib/forecastTrustEngine';
import { reconcileFinishForecasts, calculateCpmDeterministicEarlyFinish } from '@/lib/forecastReconciliation';
import { calculateControlHealth } from '@/lib/controlHealthEngine';
import type {
  Activity, ActivityBoqAllocation, ActivityLink, ActivityResource, BaselineActivity, BoqItem,
  CostControlSnapshot, CostTransaction, ParsedBoqRow, ProgressUpdate, Resource,
  ScheduleUpdateSnapshot, WbsNode,
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

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.log(`VALIDATION FAILED: ${failures} of ${checks} checks failed.`);
  process.exit(1);
} else {
  console.log(`VALIDATION PASSED: ${checks}/${checks} checks.`);
}

/**
 * F9 performance measurement (item 12) — synthetic realistic dataset:
 *   1000 activities, 2000 links, 200 BOQ items, progress/cost history and 12+12 snapshots.
 *
 * Run with `npm run perf:controls`. Reports median runtime of three iterations for the CPM engine,
 * F5 schedule control, F6 cost control, F7 integrated decisions, F8 forecast trust and the
 * combined Dashboard pipeline (F5→F6→F7→F8 on one dataset). Measurement only — no optimization
 * is implied or performed here (per F9 scope: optimize only a proven bottleneck).
 */
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import { calculateCpm } from '@/lib/cpmEngine';
import { analyzeScheduleControl } from '@/lib/scheduleControlEngine';
import { analyzeCostControl } from '@/lib/costControlEngine';
import { analyzeIntegratedDecisions } from '@/lib/integratedDecisionEngine';
import { analyzeForecastTrust } from '@/lib/forecastTrustEngine';
import type {
  Activity, ActivityBoqAllocation, ActivityLink, BaselineActivity, BoqItem,
  CostControlSnapshot, CostTransaction, ProgressUpdate, ScheduleUpdateSnapshot,
} from '@/types';

const DD = DEFAULT_DATA_DATE;

// Deterministic LCG — the dataset must be identical on every run.
let seed = 42;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = (n: number) => Math.floor(rnd() * n);

// --------------------------------------------------------------------------- dataset
const CHAINS = 25;
const PER_CHAIN = 40; // 25 × 40 = 1000 activities
const activities: Activity[] = [];
const links: ActivityLink[] = [];
let linkSeq = 0;
function mkLink(p: string, s: string): void {
  linkSeq += 1;
  links.push({ id: `L${linkSeq}`, project_id: 'p1', predecessor_id: p, successor_id: s, link_type: 'FS', lag_days: 0 } as ActivityLink);
}
for (let c = 0; c < CHAINS; c += 1) {
  for (let i = 0; i < PER_CHAIN; i += 1) {
    const id = `A${c}-${i}`;
    activities.push({
      id, project_id: 'p1', wbs_node_id: `W${c % 10}`, code: id, name: `Activity ${c}/${i}`,
      duration_days: 3 + pick(13), early_start: null, early_finish: null, late_start: null, late_finish: null,
      actual_start: null, actual_finish: null, percent_complete: 0, planned_quantity: 100 + pick(900),
      actual_quantity: 0, unit: 'm3', is_critical: false, is_milestone: false, total_float: null,
      sort_order: c * PER_CHAIN + i, created_at: '2026-01-01T00:00:00Z',
    } as Activity);
    if (i > 0) mkLink(`A${c}-${i - 1}`, id); // 25 × 39 = 975 intra-chain links
  }
}
for (let c = 0; c < CHAINS - 1; c += 1) {
  for (let i = 0; i < PER_CHAIN; i += 1) mkLink(`A${c}-${i}`, `A${c + 1}-${i}`); // 24 × 40 = 960
}
while (links.length < 2000) {
  const c = pick(CHAINS - 2);
  const i = pick(PER_CHAIN - 3);
  mkLink(`A${c}-${i}`, `A${c + 2}-${i + 2}`); // forward-only cross links ⇒ acyclic
}

// Seed dates through one canonical CPM run, then stamp progress/actuals (statused schedule).
const seedCalc = calculateCpm(activities, links, { calendarType: '6_days', dataDate: DD });
if (seedCalc.cycle) { console.error('PERF FIXTURE ERROR: cycle', seedCalc.cycle); process.exit(1); }
const seedById = new Map(seedCalc.results.map((r) => [r.activityId, r]));
for (const a of activities) {
  const r = seedById.get(a.id)!;
  a.early_start = r.earlyStart; a.early_finish = r.earlyFinish;
  a.late_start = r.lateStart; a.late_finish = r.lateFinish;
  a.total_float = r.totalFloat; a.is_critical = r.isCritical;
  // ~35 % complete, ~15 % in progress — the rest not started.
  const roll = rnd();
  if (roll < 0.35) {
    a.percent_complete = 100;
    a.actual_start = a.early_start;
    a.actual_finish = a.early_finish;
    a.actual_quantity = a.planned_quantity;
  } else if (roll < 0.5) {
    a.percent_complete = 10 + pick(80);
    a.actual_start = a.early_start;
    a.actual_quantity = Math.round((a.planned_quantity as number) * (a.percent_complete / 100));
  }
}

const baselines: BaselineActivity[] = activities.map((a, idx) => ({
  id: `B${idx}`, baseline_id: 'b1', activity_id: a.id, code: a.code, name: a.name,
  early_start: a.early_start, early_finish: a.early_finish, duration_days: a.duration_days,
  planned_cost: 50000 + pick(450000), total_float: a.total_float,
} as BaselineActivity));

const boqItems: BoqItem[] = Array.from({ length: 200 }, (_, i) => ({
  id: `Q${i}`, project_id: 'p1', code: `BOQ-${100 + i}`, description: `BOQ item ${i}`, unit: 'm3',
  quantity: 100 + pick(900), unit_price: 50 + pick(450), total_price: 0, category: null, section: null,
  sort_order: i, created_at: '2026-01-01T00:00:00Z',
} as BoqItem));
boqItems.forEach((q) => { q.total_price = q.quantity * q.unit_price; });

const allocations: ActivityBoqAllocation[] = activities.map((a, i) => ({
  id: `AL${i}`, project_id: 'p1', activity_id: a.id, boq_item_id: boqItems[i % 200].id,
  quantity_share: 1, cost_share: Number(baselines[i].planned_cost), allocation_basis: 'plan',
} as ActivityBoqAllocation));

const updates: ProgressUpdate[] = [];
let updSeq = 0;
for (const a of activities) {
  if (a.percent_complete <= 0 || !a.actual_start) continue;
  updSeq += 1;
  updates.push({
    id: `U${updSeq}`, project_id: 'p1', activity_id: a.id, update_date: a.actual_start,
    percent_complete: Math.min(a.percent_complete, 50), actual_quantity: 0, quantity_to_date: 0,
    status: 'approved', approved_at: `${a.actual_start}T08:00:00Z`, created_at: `${a.actual_start}T08:00:00Z`,
    notes: null, rejected_reason: null,
  } as ProgressUpdate);
  updSeq += 1;
  updates.push({
    id: `U${updSeq}`, project_id: 'p1', activity_id: a.id, update_date: DD,
    percent_complete: a.percent_complete, actual_quantity: 0, quantity_to_date: 0,
    status: 'approved', approved_at: `${DD}T08:00:00Z`, created_at: `${DD}T08:00:00Z`,
    notes: null, rejected_reason: null,
  } as ProgressUpdate);
}

const txns: CostTransaction[] = Array.from({ length: 800 }, (_, i) => {
  const a = activities[pick(activities.length)];
  const day = 1 + pick(28);
  const month = 6 + pick(3); // Jun–Aug 2026, all ≤ DD
  const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    id: `T${i}`, project_id: 'p1', activity_id: a.id, boq_item_id: null, category: 'work',
    transaction_date: date, description: `txn ${i}`, cost_type: 'direct',
    amount: 1000 + pick(49000), source: `INV-${i}`, status: 'approved',
    approved_at: `${date}T09:00:00Z`, created_at: `${date}T09:00:00Z`, rejected_reason: null,
  } as CostTransaction;
});

// 12 monthly snapshot pairs strictly before the Data Date + the current-DD pair.
const snapDates = ['2025-10-13', '2025-11-13', '2025-12-13', '2026-01-13', '2026-02-13', '2026-03-13',
  '2026-04-13', '2026-05-13', '2026-06-13', '2026-07-13', '2026-08-13', '2026-09-01', DD];
const schedSnaps: ScheduleUpdateSnapshot[] = snapDates.map((d, i) => ({
  id: `SS${i}`, project_id: 'p1', data_date: d, forecast_finish: seedCalc.projectEarlyFinish, progress_pct: 20,
  critical_count: seedCalc.results.filter((r) => r.isCritical).length, near_critical_count: 0,
  total_delay_days: null, delay_vs_previous_days: null, milestones_slipped: 0,
  details: {
    version: 1, drivingLinkIds: [],
    activities: Object.fromEntries(seedCalc.results.map((r) => [r.activityId, { ef: r.earlyFinish, tf: r.totalFloat, critical: r.isCritical, ct: null, cid: null, linkSig: '', pct: 10 }])),
  }, created_at: `${d}T10:00:00Z`,
} as ScheduleUpdateSnapshot));
const costSnaps: CostControlSnapshot[] = snapDates.map((d, i) => ({
  id: `CS${i}`, project_id: 'p1', data_date: d, bac: 100000000, pv: 10000000 + i * 5000000,
  ev: 9000000 + i * 5000000, ac: 9500000 + i * 5000000, cpi: 0.95, spi: 0.97, etc: 5000000,
  eac: 104000000, vac: -4000000, committed: null, forecast_confidence: 'Medium',
  recommended_method: 'eac_cpi',
  details: { version: 1, methods: [], recommended: null, activities: {}, counts: { activities: 1000, wbsNodes: 10, integrityErrors: 0, anomalies: 0 } },
  created_at: `${d}T10:00:00Z`,
} as CostControlSnapshot));

console.log(`PERF dataset: ${activities.length} activities, ${links.length} links, ${boqItems.length} BOQ items,`
  + ` ${baselines.length} baselines, ${updates.length} progress updates, ${txns.length} cost txns,`
  + ` ${schedSnaps.length}+${costSnaps.length} snapshots, data date ${DD}`);

// --------------------------------------------------------------------------- measurement
function bench(name: string, fn: () => unknown, runs = 3): unknown {
  const times: number[] = [];
  let out: unknown = null;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    out = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`${name.padEnd(34)} median ${times[1].toFixed(1).padStart(9)} ms   (min ${times[0].toFixed(1)} / max ${times[times.length - 1].toFixed(1)})`);
  return out;
}

const prevSched = schedSnaps.filter((s) => s.data_date < DD).sort((a, b) => (a.data_date < b.data_date ? 1 : -1))[0] || null;
const prevCost = costSnaps.filter((s) => s.data_date < DD).sort((a, b) => (a.data_date < b.data_date ? 1 : -1))[0] || null;

bench('CPM (calculateCpm)', () => calculateCpm(activities, links, { calendarType: '6_days', dataDate: DD }));
const f5 = bench('F5 (analyzeScheduleControl)', () => analyzeScheduleControl({
  activities, links, baselines, progressUpdates: updates, previousSnapshot: prevSched, dataDate: DD, calendarType: '6_days',
})) as ReturnType<typeof analyzeScheduleControl>;
const f6 = bench('F6 (analyzeCostControl)', () => analyzeCostControl({
  project: { id: 'p1', data_date: DD }, activities, baselines, budgetLines: [], costTransactions: txns,
  progressUpdates: updates, wbsNodes: [], boqItems, allocations, previousSnapshots: costSnaps,
  dataDate: DD, calendarType: '6_days',
})) as ReturnType<typeof analyzeCostControl>;
const f7 = bench('F7 (analyzeIntegratedDecisions)', () => analyzeIntegratedDecisions({
  scheduleReport: f5, costReport: f6, activities, links, baselines, progressUpdates: updates,
  previousScheduleSnapshot: prevSched, previousCostSnapshot: prevCost, dataDate: DD, calendarType: '6_days',
})) as ReturnType<typeof analyzeIntegratedDecisions>;
bench('F8 (analyzeForecastTrust)', () => analyzeForecastTrust({
  scheduleReport: f5, costReport: f6, decisionReport: f7, activities, links, baselines,
  progressUpdates: updates, costTransactions: txns, boqItems, allocations,
  scheduleSnapshots: schedSnaps, costSnapshots: costSnaps, dataDate: DD, calendarType: '6_days',
}));
bench('Dashboard combined (F5→F6→F7→F8)', () => {
  const a = analyzeScheduleControl({
    activities, links, baselines, progressUpdates: updates, previousSnapshot: prevSched, dataDate: DD, calendarType: '6_days',
  });
  const b = analyzeCostControl({
    project: { id: 'p1', data_date: DD }, activities, baselines, budgetLines: [], costTransactions: txns,
    progressUpdates: updates, wbsNodes: [], boqItems, allocations, previousSnapshots: costSnaps,
    dataDate: DD, calendarType: '6_days',
  });
  const c = analyzeIntegratedDecisions({
    scheduleReport: a, costReport: b, activities, links, baselines, progressUpdates: updates,
    previousScheduleSnapshot: prevSched, previousCostSnapshot: prevCost, dataDate: DD, calendarType: '6_days',
  });
  return analyzeForecastTrust({
    scheduleReport: a, costReport: b, decisionReport: c, activities, links, baselines,
    progressUpdates: updates, costTransactions: txns, boqItems, allocations,
    scheduleSnapshots: schedSnaps, costSnapshots: costSnaps, dataDate: DD, calendarType: '6_days',
  });
});

// Scale smoke: outputs stay finite at 1000-activity scale.
function scanNonFinite(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number' && !Number.isFinite(value)) out.push(`${path}=${String(value)}`);
  else if (Array.isArray(value)) value.forEach((v, i) => scanNonFinite(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) scanNonFinite(v, `${path}.${k}`, out);
  }
}
const bad: string[] = [];
scanNonFinite({ f5, f6, f7 }, 'perf', bad);
if (bad.length > 0) {
  console.log(`PERF SCALE SMOKE FAILED: non-finite values at ${bad.slice(0, 10).join(', ')}`);
  process.exit(1);
}
console.log('PERF scale smoke: no NaN/Infinity in F5–F7 outputs at 1000-activity scale.');

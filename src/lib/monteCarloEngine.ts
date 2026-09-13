import type { Activity, ActivityLink, Risk, CalendarType } from '@/types';
import { getCalendar, addWorkingDays } from './calendarEngine';
import { DEFAULT_DATA_DATE } from './projectControlsConstants';

/**
 * Monte Carlo schedule/cost simulation (GAP-027 / GAP-028 / GAP-031).
 *
 * ============================ SAMPLING MODEL (documented) ============================
 * Duration distribution family
 *   Triangular, per activity, unchanged from the accepted model:
 *     optimistic  = round(base duration x 0.85)          (min)
 *     most likely = base duration                        (mode)  -- the CPM duration is the mode
 *     pessimistic = round(base duration x risk loading)  (max)
 *   `risk loading` = 1 + (mean open-risk severity / 25) x 0.4, i.e. a fully severe open risk
 *   register (mean severity 25) widens the pessimistic bound by +40%. Milestones sample 0 days.
 *   Sampled durations are rounded to whole working days and floored at 1 day for real work.
 *
 * Activity uncertainty source
 *   The activity's own `duration_days` plus the project's OPEN risk register (`status === 'open'`,
 *   `severity = probability x impact`). No per-activity risk mapping exists in the schema, so the
 *   register widens every activity equally -- a documented limitation, not a fabricated mapping.
 *
 * Correlation / dependency assumptions
 *   NONE. Every activity is sampled independently in every iteration and no common-weather /
 *   common-market factor is applied. The schema carries no correlation data, so none is invented.
 *   Consequence: the simulated project-duration spread is narrower than a correlated model would
 *   produce. Reported in `validation` and in the wave report; deliberately not "fixed" here.
 *
 * Iterations
 *   Caller-supplied (RisksView uses 500 on load, 1000 on demand). `iterations <= 0` is a typed
 *   validation failure, never a silent zero-percentile result.
 *
 * Random source
 *   `Math.random` by default (stochastic runtime behaviour). An optional seed produces a
 *   deterministic mulberry32 stream (see `createSeededRandom`): same seed + same inputs => same
 *   samples, percentiles, bins and criticality counts. No seed is hardcoded for production.
 *
 * Network evaluation order (GAP-027)
 *   The activity network is topologically sorted ONCE per run (the logic does not change between
 *   iterations) with Kahn's algorithm and a stable tie-break on the caller's array index, so every
 *   predecessor is evaluated before its successor regardless of the input array order. A cyclic
 *   network is rejected with a typed validation result and produces NO duration output.
 *
 * Relationship + lag semantics (Wave 4 / 4.1 preserved)
 *   Simulation runs in a relative working-day OFFSET domain (integers), where an activity that
 *   starts at offset `es` with duration `d` finishes at the exclusive offset `ef = es + d`.
 *   `calendarEngine.calculateLinkDate` documents the accepted event pairs and the signed-lag rule;
 *   expressed in this offset domain they are exactly:
 *
 *     FS  EF_pred -> ES_succ : ES_succ = EF_pred + lag          (backward: LF_pred = LS_succ - lag)
 *     SS  ES_pred -> ES_succ : ES_succ = ES_pred + lag          (backward: LF_pred = LS_succ - lag + d_pred)
 *     FF  EF_pred -> EF_succ : ES_succ = EF_pred + lag - d_succ (backward: LF_pred = LF_succ - lag)
 *     SF  ES_pred -> EF_succ : ES_succ = ES_pred + lag - d_succ (backward: LF_pred = LF_succ - lag + d_pred)
 *
 *   The one-working-day FS gap the calendar engine applies is already contained in the exclusive
 *   finish offset, which is why FS needs no extra `+1` here. `lag` keeps its sign, so a negative
 *   lag remains a lead; a lead can never pull a successor before project start (offsets are
 *   clamped at 0), the same "only clamp" the calendar engine documents.
 *
 * Percentile policy
 *   Sorted samples + linear interpolation between the two nearest ranks (the "R-7" /
 *   PERCENTILE.INC / NumPy default method): rank h = (n - 1) x p, value = x[floor h] +
 *   (x[ceil h] - x[floor h]) x (h - floor h). It is monotonic in p by construction, so
 *   P50 <= P80 <= P90 always holds for both duration and cost. Percentiles are NOT mean + multiplier.
 *   Finish dates use `ceil(percentile days)` because a confidence date is a whole working day and
 *   rounding down would understate the commitment date.
 *
 * Cost simulation
 *   Unchanged family: project cost = total budget x Triangular(0.95, 1.00, 1.15 + (risk loading-1)),
 *   i.e. a -5% / +15% base envelope widened by the same open-risk loading used for durations. The
 *   budget passed in is the caller's authoritative value (RisksView passes the contract value; the
 *   scenario simulator passes its deterministic scenario cost outcome).
 * =====================================================================================
 */

/** A uniform [0,1) random source. Seeded sources make a run reproducible. */
export type RandomSource = () => number;

/** xmur3 string hash, so a seed may be a business key such as a scenario id. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/**
 * Deterministic PRNG (mulberry32). Same seed => same stream => same simulation result.
 * Accepts a number or a string (hashed), so callers can seed by project/scenario identity.
 */
export function createSeededRandom(seed: number | string): RandomSource {
  let state = typeof seed === 'string' ? hashSeed(seed) : Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) >>> 0 : 0;
  return function mulberry32(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Typed validation outcome, in the same style as `CpmCalculation.cycle`. */
export type MonteCarloValidationStatus =
  | 'ok'
  | 'no_activities'
  | 'cycle_detected'
  | 'invalid_iteration_count';

export interface MonteCarloValidation {
  status: MonteCarloValidationStatus;
  valid: boolean;
  /** Activity ids forming one detected cycle (cpm-engine style), null when acyclic. */
  cycle: string[] | null;
  /** The same cycle as business codes, for display without another lookup. */
  cycleCodes: string[] | null;
  /** Links whose predecessor or successor is not in the activity set: ignored, never guessed. */
  ignoredLinkIds: string[];
  messageAr: string | null;
  messageEn: string | null;
}

/** One histogram bin of the simulated project-duration distribution (GAP-031). */
export interface ScheduleDistributionBin {
  /** Inclusive lower boundary, in working days from project start. */
  binStart: number;
  /** Inclusive upper boundary, in working days from project start. */
  binEnd: number;
  /** Representative duration of the bin (its centre), whole working days. */
  days: number;
  /** Iterations whose duration fell in this bin -- each valid iteration lands in exactly one bin. */
  count: number;
  /** count / valid iterations, 0..1. All bins sum to 1 (within float rounding). */
  probability: number;
  /** probability x 100, 0..100. */
  percent: number;
  /** Running `percent` up to and including this bin -- the cumulative distribution. */
  cumulativePercent: number;
  /** Representative finish date for the bin's centre duration. */
  finishDate: string;
}

export interface MonteCarloOptions {
  /** Optional deterministic seed (number or string). Omitted => stochastic `Math.random`. */
  seed?: number | string | null;
  /**
   * Governed Data Date used when the network carries no date to anchor to. Resolution:
   * `options.dataDate` -> `DEFAULT_DATA_DATE`. The runtime machine clock is never used.
   */
  dataDate?: string | null;
  /** Target number of histogram bins (actual width is at least one day). Default 10. */
  binCount?: number;
  /** Include the raw sorted sample arrays, for verification and drill-down. Default false. */
  includeSamples?: boolean;
}

export interface MonteCarloResult {
  /** Iterations actually simulated; 0 when the run was rejected by validation. */
  iterations: number;
  /** Iterations that produced a usable duration sample -- the denominator of CI and of the bins. */
  validIterations: number;
  /** False when validation rejected the run; no duration/cost output is then fabricated. */
  valid: boolean;
  validation: MonteCarloValidation;
  /** Convenience mirror of `validation.cycle` (cpm-engine style). */
  cycle: string[] | null;
  /** Governing Data Date the run was anchored to. */
  dataDate: string;
  /** Anchor date the working-day offsets are converted from. */
  projectStart: string;
  /** Activity ids in the topological evaluation order used for every iteration (GAP-027). */
  topologicalOrder: string[];
  p50Finish: string;
  p80Finish: string;
  p90Finish: string;
  /** Interpolated percentile durations in working days (monotonic: P50 <= P80 <= P90). */
  p50Days: number;
  p80Days: number;
  p90Days: number;
  p50Cost: number;
  p80Cost: number;
  p90Cost: number;
  /** Mean of the simulated durations/costs -- reported separately from the percentiles. */
  meanDurationDays: number;
  meanCost: number;
  minDurationDays: number;
  maxDurationDays: number;
  /** Observed range of the sampled cost distribution, in the caller's currency. */
  minCost: number;
  maxCost: number;
  scheduleDistribution: ScheduleDistributionBin[];
  criticalityIndex: {
    activityCode: string;
    activityName: string;
    /** 0..100: share of valid iterations in which the activity was on a driving (zero-float) path. */
    probability: number;
    /** The raw count behind `probability`, so a consumer can re-derive it. */
    criticalIterations: number;
  }[];
  /** Present only when `options.includeSamples` is set. Sorted ascending. */
  durationSamples?: number[];
  costSamples?: number[];
  seed: number | string | null;
  randomSource: 'seeded' | 'stochastic';
}

/** Sample from a triangular distribution using the supplied random source. */
function sampleTriangular(min: number, mode: number, max: number, random: RandomSource): number {
  if (!Number.isFinite(min) || !Number.isFinite(mode) || !Number.isFinite(max)) return mode;
  if (max <= min) return Math.max(min, Math.min(mode, max));
  const u = random();
  const f = (mode - min) / Math.max(0.001, max - min);
  if (u <= f) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/**
 * Interpolated percentile of an ASCENDING sorted array (R-7 / PERCENTILE.INC).
 * Monotonic in `p`, so P50 <= P80 <= P90 holds by construction.
 */
export function percentileOfSorted(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, p));
  const h = (sorted.length - 1) * clamped;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

interface NetworkNode {
  id: string;
  code: string;
  name: string;
  index: number;
  /**
   * Canonical sort key (`code`, else `id`). The topological tie-break and the sampling order both use
   * it, so a permuted input array produces the SAME evaluation order and the SAME random draws --
   * the simulation result never depends on how the caller happened to order its activities.
   */
  sortKey: string;
  optimistic: number;
  mostLikely: number;
  pessimistic: number;
  isMilestone: boolean;
}

interface NetworkLink {
  predecessorId: string;
  successorId: string;
  linkType: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
}

function normaliseLinkType(value: string | undefined | null): 'FS' | 'SS' | 'FF' | 'SF' {
  const upper = String(value || 'FS').toUpperCase();
  return upper === 'SS' || upper === 'FF' || upper === 'SF' ? upper : 'FS';
}

/**
 * Extract one concrete cycle from a set of nodes that Kahn's algorithm could not place.
 * Depth-first, same shape as the frozen CPM engine's `findCycle`, so the reported path reads the
 * same way to a planner.
 */
function findCycleAmong(nodes: NetworkNode[], successorsOf: Map<string, NetworkLink[]>): string[] | null {
  const allowed = new Set(nodes.map((n) => n.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const link of successorsOf.get(id) || []) {
      if (!allowed.has(link.successorId)) continue;
      const cycle = visit(link.successorId);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Kahn topological sort with a stable tie-break on the caller's array index.
 * Returns the evaluation order, or the nodes that could not be placed (a cycle) when incomplete.
 */
function topologicalSort(
  nodes: NetworkNode[],
  successorsOf: Map<string, NetworkLink[]>,
): { order: NetworkNode[]; unplaced: NetworkNode[] } {
  const indegree = new Map<string, number>();
  nodes.forEach((n) => indegree.set(n.id, 0));
  successorsOf.forEach((links, predId) => {
    if (!indegree.has(predId)) return;
    links.forEach((link) => {
      if (!indegree.has(link.successorId)) return;
      indegree.set(link.successorId, (indegree.get(link.successorId) || 0) + 1);
    });
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ready = nodes.filter((n) => (indegree.get(n.id) || 0) === 0).map((n) => n.id);
  const order: NetworkNode[] = [];
  const placed = new Set<string>();

  while (ready.length > 0) {
    // Stable, input-order-independent choice: the ready node with the smallest canonical sort key.
    let pick = 0;
    for (let i = 1; i < ready.length; i += 1) {
      const candidateKey = byId.get(ready[i])?.sortKey ?? '';
      const pickKey = byId.get(ready[pick])?.sortKey ?? '';
      if (candidateKey < pickKey) pick = i;
    }
    const id = ready.splice(pick, 1)[0];
    const node = byId.get(id);
    if (!node || placed.has(id)) continue;
    placed.add(id);
    order.push(node);
    for (const link of successorsOf.get(id) || []) {
      if (!indegree.has(link.successorId) || placed.has(link.successorId)) continue;
      const next = (indegree.get(link.successorId) || 0) - 1;
      indegree.set(link.successorId, next);
      if (next === 0) ready.push(link.successorId);
    }
  }

  return { order, unplaced: nodes.filter((n) => !placed.has(n.id)) };
}

/**
 * The single shape returned when a run is rejected. Durations, dates and costs are empty/zero with
 * `valid: false` so a consumer renders the validation message instead of a fabricated number; the
 * caller's budget is deliberately NOT echoed back, because an invalid network has no cost result.
 */
function invalidResult(
  validation: MonteCarloValidation,
  dataDate: string,
  seed: number | string | null,
  randomSource: 'seeded' | 'stochastic',
): MonteCarloResult {
  return {
    iterations: 0,
    validIterations: 0,
    valid: false,
    validation,
    cycle: validation.cycle,
    dataDate,
    projectStart: dataDate,
    topologicalOrder: [],
    p50Finish: '',
    p80Finish: '',
    p90Finish: '',
    p50Days: 0,
    p80Days: 0,
    p90Days: 0,
    // No simulated money exists, so nothing is asserted: zero with `valid: false` tells the caller
    // to render the validation message instead of a number.
    p50Cost: 0,
    p80Cost: 0,
    p90Cost: 0,
    meanDurationDays: 0,
    meanCost: 0,
    minDurationDays: 0,
    maxDurationDays: 0,
    minCost: 0,
    maxCost: 0,
    scheduleDistribution: [],
    criticalityIndex: [],
    seed,
    randomSource,
  };
}

export function runMonteCarloSimulation(
  activities: Activity[],
  links: ActivityLink[],
  risks: Risk[],
  totalBudget: number,
  iterations = 500,
  calendarType: CalendarType = '6_days',
  options: MonteCarloOptions = {},
): MonteCarloResult {
  const calendar = getCalendar(calendarType);
  const seed = options.seed ?? null;
  const randomSourceKind: 'seeded' | 'stochastic' = seed === null || seed === undefined ? 'stochastic' : 'seeded';
  const random: RandomSource = randomSourceKind === 'seeded' ? createSeededRandom(seed as number | string) : Math.random;
  // Governed anchor: an explicit Data Date wins, else the governed default. Never the machine clock.
  const dataDate = String(options.dataDate || DEFAULT_DATA_DATE);

  if (!activities.length) {
    return invalidResult(
      {
        status: 'no_activities',
        valid: false,
        cycle: null,
        cycleCodes: null,
        ignoredLinkIds: [],
        messageAr: 'لا توجد أنشطة لمحاكاتها — لم يتم توليد أي نتائج احتمالية.',
        messageEn: 'No activities to simulate — no probabilistic result was generated.',
      },
      dataDate,
      seed,
      randomSourceKind,
    );
  }

  if (!Number.isFinite(iterations) || iterations <= 0) {
    return invalidResult(
      {
        status: 'invalid_iteration_count',
        valid: false,
        cycle: null,
        cycleCodes: null,
        ignoredLinkIds: [],
        messageAr: `عدد دورات المحاكاة غير صالح (${iterations}) — لم يتم توليد أي نتائج احتمالية.`,
        messageEn: `Invalid iteration count (${iterations}) — no probabilistic result was generated.`,
      },
      dataDate,
      seed,
      randomSourceKind,
    );
  }

  // ---------------------------------------------------------------- network preparation
  const nodes: NetworkNode[] = activities.map((act, index) => {
    const baseDuration = act.is_milestone ? 0 : Math.max(1, Number(act.duration_days) || 1);
    return {
      id: act.id,
      code: act.code,
      name: act.name,
      index,
      sortKey: String(act.code || act.id),
      optimistic: baseDuration,
      mostLikely: baseDuration,
      pessimistic: baseDuration,
      isMilestone: Boolean(act.is_milestone),
    };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Open-risk loading widens the pessimistic bound (documented model, unchanged).
  const openRisks = risks.filter((r) => r.status === 'open');
  const avgRiskMultiplier =
    1 + (openRisks.reduce((sum, r) => sum + Number(r.severity || 0), 0) / Math.max(1, openRisks.length * 25)) * 0.4;
  nodes.forEach((node) => {
    if (node.isMilestone) {
      node.optimistic = 0;
      node.mostLikely = 0;
      node.pessimistic = 0;
      return;
    }
    node.optimistic = Math.max(1, Math.round(node.mostLikely * 0.85));
    node.pessimistic = Math.max(node.mostLikely, Math.round(node.mostLikely * avgRiskMultiplier));
  });

  // Links that reference an activity outside the simulated set are ignored and reported: guessing a
  // relationship would fabricate logic.
  const ignoredLinkIds: string[] = [];
  const networkLinks: NetworkLink[] = [];
  links.forEach((link) => {
    if (!nodeById.has(link.predecessor_id) || !nodeById.has(link.successor_id)) {
      ignoredLinkIds.push(link.id);
      return;
    }
    if (link.predecessor_id === link.successor_id) {
      // A self-link is a one-node cycle: report it rather than silently dropping the activity.
      ignoredLinkIds.push(link.id);
      return;
    }
    networkLinks.push({
      predecessorId: link.predecessor_id,
      successorId: link.successor_id,
      linkType: normaliseLinkType(link.link_type),
      lag: Number(link.lag_days) || 0,
    });
  });

  const predecessorsOf = new Map<string, NetworkLink[]>();
  const successorsOf = new Map<string, NetworkLink[]>();
  networkLinks.forEach((link) => {
    predecessorsOf.set(link.successorId, [...(predecessorsOf.get(link.successorId) || []), link]);
    successorsOf.set(link.predecessorId, [...(successorsOf.get(link.predecessorId) || []), link]);
  });

  // GAP-027: stable topological order computed once; explicit cycle rejection.
  const { order, unplaced } = topologicalSort(nodes, successorsOf);
  if (unplaced.length > 0) {
    const cycle = findCycleAmong(unplaced, successorsOf) || unplaced.map((n) => n.id);
    const cycleCodes = cycle.map((id) => nodeById.get(id)?.code || id);
    return invalidResult(
      {
        status: 'cycle_detected',
        valid: false,
        cycle,
        cycleCodes,
        ignoredLinkIds,
        messageAr: `شبكة الأنشطة تحتوي على دورة منطقية مغلقة: ${cycleCodes.join(' ← ')}. لا يمكن تنفيذ المحاكاة الاحتمالية قبل فك التعارض، ولم يتم توليد أي مدد أو تواريخ.`,
        messageEn: `The activity network contains a logic cycle: ${cycleCodes.join(' <- ')}. Resolve the circular dependency before simulating; no durations or dates were generated.`,
      },
      dataDate,
      seed,
      randomSourceKind,
    );
  }

  const reverseOrder = [...order].reverse();

  // Anchor date: the earliest early_start in the network, else the governed Data Date.
  const projectStart = activities.reduce((earliest, a) => {
    const candidate = a.actual_start || a.early_start;
    if (!candidate) return earliest;
    return !earliest || candidate < earliest ? candidate : earliest;
  }, '' as string) || dataDate;

  // ---------------------------------------------------------------- simulation loop
  const durationResults: number[] = [];
  const costResults: number[] = [];
  const criticalCounts = new Map<string, number>();
  nodes.forEach((n) => criticalCounts.set(n.id, 0));

  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();
  const lateStart = new Map<string, number>();
  const lateFinish = new Map<string, number>();

  for (let iter = 0; iter < iterations; iter += 1) {
    // 1. Sample durations (independent per activity -- no correlation model exists). Drawn in the
    //    canonical topological order so the random stream is identical for any input permutation.
    const sampled = new Map<string, number>();
    order.forEach((node) => {
      if (node.isMilestone) {
        sampled.set(node.id, 0);
        return;
      }
      const value = Math.round(sampleTriangular(node.optimistic, node.mostLikely, node.pessimistic, random));
      sampled.set(node.id, Math.max(1, value));
    });

    // 2. Forward pass in topological order: every predecessor is already known.
    earlyStart.clear();
    earlyFinish.clear();
    let projectDuration = 0;
    order.forEach((node) => {
      const duration = sampled.get(node.id) || 0;
      let start = 0;
      for (const link of predecessorsOf.get(node.id) || []) {
        const predStart = earlyStart.get(link.predecessorId) || 0;
        const predFinish = earlyFinish.get(link.predecessorId) || 0;
        let candidate: number;
        switch (link.linkType) {
          case 'SS':
            candidate = predStart + link.lag;
            break;
          case 'FF':
            candidate = predFinish + link.lag - duration;
            break;
          case 'SF':
            candidate = predStart + link.lag - duration;
            break;
          case 'FS':
          default:
            candidate = predFinish + link.lag;
            break;
        }
        if (candidate > start) start = candidate;
      }
      // A lead may overlap its predecessor but never precede project start.
      if (start < 0) start = 0;
      earlyStart.set(node.id, start);
      earlyFinish.set(node.id, start + duration);
      if (start + duration > projectDuration) projectDuration = start + duration;
    });

    // 3. Backward pass in reverse topological order -> total float -> driving (critical) activities.
    //    GAP-028: EVERY zero-float activity of the iteration is counted, so co-critical paths all
    //    receive a hit; the index is no longer a "did this activity finish the project last" flag.
    lateFinish.clear();
    lateStart.clear();
    reverseOrder.forEach((node) => {
      const duration = sampled.get(node.id) || 0;
      let finish = projectDuration;
      const successorLinks = successorsOf.get(node.id) || [];
      if (successorLinks.length > 0) {
        let minFinish: number | null = null;
        for (const link of successorLinks) {
          const succStart = lateStart.get(link.successorId);
          const succFinish = lateFinish.get(link.successorId);
          if (succStart === undefined || succFinish === undefined) continue;
          let implied: number;
          switch (link.linkType) {
            case 'SS':
              implied = succStart - link.lag + duration;
              break;
            case 'FF':
              implied = succFinish - link.lag;
              break;
            case 'SF':
              implied = succFinish - link.lag + duration;
              break;
            case 'FS':
            default:
              implied = succStart - link.lag;
              break;
          }
          if (minFinish === null || implied < minFinish) minFinish = implied;
        }
        if (minFinish !== null) finish = Math.min(finish, minFinish);
      }
      lateFinish.set(node.id, finish);
      lateStart.set(node.id, finish - duration);
    });

    order.forEach((node) => {
      const float = (lateFinish.get(node.id) || 0) - (earlyFinish.get(node.id) || 0);
      if (float <= 0) {
        criticalCounts.set(node.id, (criticalCounts.get(node.id) || 0) + 1);
      }
    });

    durationResults.push(projectDuration);

    // 4. Cost sample: documented envelope around the caller's authoritative budget.
    const costVariation = sampleTriangular(0.95, 1.0, 1.15 + (avgRiskMultiplier - 1), random);
    costResults.push(Math.round(Number(totalBudget || 0) * costVariation));
  }

  const validIterations = durationResults.length;
  durationResults.sort((a, b) => a - b);
  costResults.sort((a, b) => a - b);

  // ---------------------------------------------------------------- percentiles
  const p50DaysRaw = percentileOfSorted(durationResults, 0.5);
  const p80DaysRaw = percentileOfSorted(durationResults, 0.8);
  const p90DaysRaw = percentileOfSorted(durationResults, 0.9);
  const p50Days = Math.ceil(p50DaysRaw);
  const p80Days = Math.ceil(p80DaysRaw);
  const p90Days = Math.ceil(p90DaysRaw);

  const p50Finish = addWorkingDays(projectStart, p50Days, calendar);
  const p80Finish = addWorkingDays(projectStart, p80Days, calendar);
  const p90Finish = addWorkingDays(projectStart, p90Days, calendar);

  // ---------------------------------------------------------------- histogram (GAP-031)
  // Equal-width bins over the observed [min, max] range, at least one day wide, so every valid
  // iteration falls in exactly one bin and the counts sum to `validIterations`.
  const scheduleDistribution: ScheduleDistributionBin[] = [];
  if (validIterations > 0) {
    const minDays = durationResults[0];
    const maxDays = durationResults[validIterations - 1];
    const targetBins = Math.max(1, Math.round(Number(options.binCount) || 10));
    const binWidth = Math.max(1, Math.ceil((maxDays - minDays + 1) / targetBins));
    const binTotal = Math.max(1, Math.ceil((maxDays - minDays + 1) / binWidth));
    const counts = new Array<number>(binTotal).fill(0);
    durationResults.forEach((days) => {
      const index = Math.min(binTotal - 1, Math.max(0, Math.floor((days - minDays) / binWidth)));
      counts[index] += 1;
    });
    let cumulative = 0;
    for (let b = 0; b < binTotal; b += 1) {
      const binStart = minDays + b * binWidth;
      const binEnd = Math.min(maxDays, binStart + binWidth - 1);
      const count = counts[b];
      cumulative += count;
      const centre = Math.round((binStart + binEnd) / 2);
      scheduleDistribution.push({
        binStart,
        binEnd,
        days: centre,
        count,
        probability: count / validIterations,
        percent: Number(((count / validIterations) * 100).toFixed(4)),
        cumulativePercent: Number(((cumulative / validIterations) * 100).toFixed(4)),
        finishDate: addWorkingDays(projectStart, centre, calendar),
      });
    }
  }

  // ---------------------------------------------------------------- criticality index
  const criticalityIndex = activities
    .map((a) => {
      const count = criticalCounts.get(a.id) || 0;
      return {
        activityCode: a.code,
        activityName: a.name,
        probability: validIterations > 0 ? Math.round((count / validIterations) * 100) : 0,
        criticalIterations: count,
      };
    })
    .sort((a, b) => b.probability - a.probability || a.activityCode.localeCompare(b.activityCode));

  const result: MonteCarloResult = {
    iterations: validIterations,
    validIterations,
    valid: true,
    validation: {
      status: 'ok',
      valid: true,
      cycle: null,
      cycleCodes: null,
      ignoredLinkIds,
      messageAr: ignoredLinkIds.length
        ? `تم تجاهل ${ignoredLinkIds.length} علاقة تربط أنشطة خارج نطاق مجموعة المحاكاة.`
        : null,
      messageEn: ignoredLinkIds.length
        ? `${ignoredLinkIds.length} link(s) referencing activities outside the simulated set were ignored.`
        : null,
    },
    cycle: null,
    dataDate,
    projectStart,
    topologicalOrder: order.map((n) => n.id),
    p50Finish,
    p80Finish,
    p90Finish,
    p50Days,
    p80Days,
    p90Days,
    p50Cost: Math.round(percentileOfSorted(costResults, 0.5)),
    p80Cost: Math.round(percentileOfSorted(costResults, 0.8)),
    p90Cost: Math.round(percentileOfSorted(costResults, 0.9)),
    meanDurationDays: Number(
      (durationResults.reduce((s, v) => s + v, 0) / Math.max(1, validIterations)).toFixed(2),
    ),
    meanCost: Math.round(costResults.reduce((s, v) => s + v, 0) / Math.max(1, validIterations)),
    minDurationDays: validIterations > 0 ? durationResults[0] : 0,
    maxDurationDays: validIterations > 0 ? durationResults[validIterations - 1] : 0,
    minCost: validIterations > 0 ? costResults[0] : 0,
    maxCost: validIterations > 0 ? costResults[validIterations - 1] : 0,
    scheduleDistribution,
    criticalityIndex,
    seed,
    randomSource: randomSourceKind,
  };

  if (options.includeSamples) {
    result.durationSamples = [...durationResults];
    result.costSamples = [...costResults];
  }

  return result;
}

/**
 * Deterministic (most-likely) network length in working days, using the same topological order and
 * relationship rules as the simulation. Consumers that need to anchor a probabilistic envelope to a
 * deterministic scenario duration use this as the unscaled reference.
 */
export function calculateDeterministicNetworkDuration(
  activities: Activity[],
  links: ActivityLink[],
): { durationDays: number; valid: boolean; cycle: string[] | null } {
  if (!activities.length) return { durationDays: 0, valid: false, cycle: null };
  const nodes: NetworkNode[] = activities.map((act, index) => ({
    id: act.id,
    code: act.code,
    name: act.name,
    index,
    sortKey: String(act.code || act.id),
    optimistic: 0,
    mostLikely: act.is_milestone ? 0 : Math.max(1, Number(act.duration_days) || 1),
    pessimistic: 0,
    isMilestone: Boolean(act.is_milestone),
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const networkLinks: NetworkLink[] = links
    .filter((l) => nodeById.has(l.predecessor_id) && nodeById.has(l.successor_id) && l.predecessor_id !== l.successor_id)
    .map((l) => ({
      predecessorId: l.predecessor_id,
      successorId: l.successor_id,
      linkType: normaliseLinkType(l.link_type),
      lag: Number(l.lag_days) || 0,
    }));
  const successorsOf = new Map<string, NetworkLink[]>();
  const predecessorsOf = new Map<string, NetworkLink[]>();
  networkLinks.forEach((link) => {
    successorsOf.set(link.predecessorId, [...(successorsOf.get(link.predecessorId) || []), link]);
    predecessorsOf.set(link.successorId, [...(predecessorsOf.get(link.successorId) || []), link]);
  });
  const { order, unplaced } = topologicalSort(nodes, successorsOf);
  if (unplaced.length > 0) {
    const cycle = findCycleAmong(unplaced, successorsOf) || unplaced.map((n) => n.id);
    return { durationDays: 0, valid: false, cycle };
  }
  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();
  let projectDuration = 0;
  order.forEach((node) => {
    const duration = node.mostLikely;
    let start = 0;
    for (const link of predecessorsOf.get(node.id) || []) {
      const predStart = earlyStart.get(link.predecessorId) || 0;
      const predFinish = earlyFinish.get(link.predecessorId) || 0;
      let candidate: number;
      switch (link.linkType) {
        case 'SS':
          candidate = predStart + link.lag;
          break;
        case 'FF':
          candidate = predFinish + link.lag - duration;
          break;
        case 'SF':
          candidate = predStart + link.lag - duration;
          break;
        case 'FS':
        default:
          candidate = predFinish + link.lag;
          break;
      }
      if (candidate > start) start = candidate;
    }
    if (start < 0) start = 0;
    earlyStart.set(node.id, start);
    earlyFinish.set(node.id, start + duration);
    if (start + duration > projectDuration) projectDuration = start + duration;
  });
  return { durationDays: projectDuration, valid: true, cycle: null };
}

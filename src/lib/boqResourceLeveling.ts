// =====================================================================================
// Phase F4 · Deterministic resource-constrained scheduling for BOQ plans.
//
// The leveler NEVER edits dates. It adds the minimal set of FS-0 resource sequencing
// links (origin "resource_leveling") and reruns the canonical CPM engine through an
// injected `rerun` callback (boqPlanningEngine.runBoqCpm — the same mapping + the same
// calculateCpm the unconstrained plan uses). No second date engine exists.
//
// Demand model (gang units, documented assumption):
//   - one resource pool per template resource code (crew-*, eq-*);
//   - an activity demands `crewCount` gangs from EVERY pool it requires
//     (each assigned gang needs its crew and its equipment unit);
//   - default pool capacity = max single-activity demand (min 1), so an isolated
//     activity is always feasible and conflicts arise purely from concurrency;
//   - user capacity overrides are in gangs and carry "user" provenance.
// Template headcount `count` values stay in assignments/persist untouched (Time+Cost).
//
// Priority order inside a pool (§4, all deterministic, no random):
//   1. user sequence override (front orderSeq, lower first)
//   2. hard predecessor readiness (current early start)
//   3. location/front sequence (orderSeq, then front id)
//   4. lower total float / more critical first
//   5. stable activity id tie-break
// =====================================================================================

import type { CalendarType } from "../types";
import type {
  PlannedActivity,
  PlannedAssignment,
  PlannedLink,
  PlannedResource,
} from "./boqPlanningEngine";
import { countWorkingDays, getCalendar, isWorkingDay } from "./calendarEngine";

export type LevelingPolicy = "logic-only" | "respect-resources";

export interface LevelingOptions {
  policy: LevelingPolicy;
  /** User capacity (gangs) by pool key. Absent = default (max single demand). */
  capacities: Record<string, number>;
  /** Optional review-only target finish (yyyy-mm-dd). Never invented. */
  targetFinish: string | null;
  /** Pool keys whose remaining over-allocation the user explicitly waived. */
  waivedPools: string[];
}

export interface PoolDemand {
  activityStableId: string;
  poolKey: string;
  /** Gangs demanded (activity crewCount). */
  units: number;
}

export interface PoolConflict {
  poolKey: string;
  capacity: number;
  peakDemand: number;
  peakDay: string | null;
  /** Members active on an over-capacity day (sorted stable ids). */
  activityStableIds: string[];
}

export interface LevelAttribution {
  linkStableId: string;
  fromActivityId: string;
  toActivityId: string;
  resourceKey: string;
  coResourceKeys: string[];
  capacity: number;
  reason: string;
  ruleCode: string;
  /** Successor early-start shift, working days (shared cause when >1 incoming). */
  delayDays: number;
  generated: true;
  priorityInverted: boolean;
}

export type PoolClassification = "normal" | "constrained" | "bottleneck";

export interface PoolBottleneck {
  poolKey: string;
  resourceName: string;
  resourceType: string;
  capacity: number;
  capacityProvenance: "default" | "user";
  /** Peak concurrent demand in gangs on UNCONSTRAINED dates. */
  peakDemand: number;
  conflictActivityCount: number;
  levelingLinksAdded: number;
  /** Max successor shift over this pool's leveling links (working days). */
  delayContributionDays: number;
  criticalAffected: number;
  nearCriticalAffected: number;
  classification: PoolClassification;
}

export interface CapacityRecommendation {
  poolKey: string;
  currentCapacity: number;
  candidateCapacity: number;
  newFinish: string | null;
  daysSaved: number;
  remainingConflicts: number;
  costImpact: "N/A — no authoritative rate";
  basis: "actual-rerun";
}

export interface LevelSnapshot {
  projectFinish: string | null;
  spanDays: number;
  criticalCount: number;
  criticalStableIds: string[];
  conflictCount: number;
  conflicts: PoolConflict[];
}

export interface ResourceLevelingReport {
  applied: boolean;
  policy: LevelingPolicy;
  unconstrained: LevelSnapshot;
  constrained: LevelSnapshot;
  /** Constrained finish minus unconstrained finish (working days, >= 0). */
  resourceDelayDays: number;
  criticalChanged: boolean;
  attributions: LevelAttribution[];
  pools: PoolBottleneck[];
  targetFinish: string | null;
  targetVarianceDays: number | null;
  targetMet: boolean | null;
  recommendations: CapacityRecommendation[];
  infeasible: Array<{ poolKey: string; aStableId: string; bStableId: string; reason: string }>;
  invalidCapacities: Array<{ poolKey: string; value: number }>;
}

/** §18: near-critical threshold (total float, working days). Ranking only. */
export const NEAR_CRITICAL_TF_DAYS = 5;
/** Deterministic iteration cap; residue becomes findings, never an exception. */
export const MAX_LEVELING_ITERATIONS = 50;

export function poolRuleCode(poolKey: string): string {
  return `RESOURCE_LEVEL_${poolKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Signed working-day distance: working days in (from, to] for to > from
 * (0 when equal). Endpoints need not be working days (user target dates).
 */
export function workingDayDelta(from: string | null, to: string | null, calendarType: CalendarType): number | null {
  if (!from || !to) return null;
  if (from === to) return 0;
  const cal = getCalendar(calendarType);
  if (to > from) return countWorkingDays(from, to, cal) - (isWorkingDay(from, cal) ? 1 : 0);
  return -(countWorkingDays(to, from, cal) - (isWorkingDay(to, cal) ? 1 : 0));
}

export function calendarSpanDays(start: string | null, finish: string | null): number {
  if (!start || !finish) return 0;
  return Math.round((new Date(finish).getTime() - new Date(start).getTime()) / 86400000) + 1;
}

// -------------------------------------------------------------------------------------
// Demands + capacities
// -------------------------------------------------------------------------------------

export function buildPoolDemands(
  activities: PlannedActivity[],
  assignments: PlannedAssignment[],
  resources: PlannedResource[]
): { demands: PoolDemand[]; pools: string[] } {
  const resByStable = new Map(resources.map((r) => [r.stableId, r]));
  const crewByAct = new Map(
    activities.filter((a) => !a.isMilestone).map((a) => [a.stableId, a.crewCount])
  );
  const seen = new Set<string>();
  const demands: PoolDemand[] = [];
  for (const asn of assignments) {
    const crews = crewByAct.get(asn.activityStableId);
    const res = resByStable.get(asn.resourceStableId);
    if (crews === undefined || !res || !(crews > 0)) continue;
    const key = `${asn.activityStableId}|${res.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    demands.push({ activityStableId: asn.activityStableId, poolKey: res.code, units: crews });
  }
  demands.sort((a, b) => a.poolKey.localeCompare(b.poolKey) || a.activityStableId.localeCompare(b.activityStableId));
  const pools = [...new Set(demands.map((d) => d.poolKey))].sort();
  return { demands, pools };
}

export function resolveCapacities(
  demands: PoolDemand[],
  pools: string[],
  userCaps: Record<string, number>
): {
  capacities: Map<string, number>;
  provenance: Map<string, "default" | "user">;
  invalid: Array<{ poolKey: string; value: number }>;
} {
  const capacities = new Map<string, number>();
  const provenance = new Map<string, "default" | "user">();
  const invalid: Array<{ poolKey: string; value: number }> = [];
  for (const p of pools) {
    const peak1 = Math.max(1, ...demands.filter((d) => d.poolKey === p).map((d) => d.units));
    const uv = userCaps[p];
    if (uv !== undefined && uv !== null && String(uv).trim() !== "") {
      const v = Math.floor(Number(uv));
      if (Number.isFinite(v) && v >= 1) {
        capacities.set(p, v);
        provenance.set(p, "user");
        continue;
      }
      invalid.push({ poolKey: p, value: Number(uv) });
    }
    capacities.set(p, peak1);
    provenance.set(p, "default");
  }
  return { capacities, provenance, invalid };
}

// -------------------------------------------------------------------------------------
// Exact conflict detection (date-overlap sweep per pool, gang-load aware)
// -------------------------------------------------------------------------------------

export function detectPoolConflicts(
  activities: PlannedActivity[],
  demands: PoolDemand[],
  capacities: Map<string, number>
): PoolConflict[] {
  const byId = new Map(activities.map((a) => [a.stableId, a]));
  const byPool = new Map<string, PoolDemand[]>();
  for (const d of demands) {
    if (!byPool.has(d.poolKey)) byPool.set(d.poolKey, []);
    byPool.get(d.poolKey)!.push(d);
  }
  const out: PoolConflict[] = [];
  for (const [poolKey, members] of [...byPool.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dated = members
      .map((m) => ({ m, a: byId.get(m.activityStableId)! }))
      .filter((x) => x.a && x.a.earlyStart && x.a.earlyFinish);
    const cap = capacities.get(poolKey) || 1;
    const days = [...new Set(dated.map((x) => x.a.earlyStart!))].sort();
    let peak = 0;
    let peakDay: string | null = null;
    const overMembers = new Set<string>();
    for (const day of days) {
      let load = 0;
      const active: string[] = [];
      for (const x of dated) {
        if (x.a.earlyStart! <= day && day <= x.a.earlyFinish!) {
          load += x.m.units;
          active.push(x.m.activityStableId);
        }
      }
      if (load > peak) { peak = load; peakDay = day; }
      if (load > cap) for (const id of active) overMembers.add(id);
    }
    // Single-activity over-capacity (demand > cap) with no concurrency still counts.
    const solo = dated.filter((x) => x.m.units > cap);
    for (const x of solo) {
      overMembers.add(x.m.activityStableId);
      if (x.m.units > peak) { peak = x.m.units; peakDay = x.a.earlyStart!; }
    }
    if (peak > cap) {
      out.push({
        poolKey, capacity: cap, peakDemand: peak, peakDay,
        activityStableIds: [...overMembers].sort(),
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------
// Deterministic lane packing + iterative leveling (links only, dates via canonical CPM)
// -------------------------------------------------------------------------------------

export interface LevelInput {
  /** Dated activities (unconstrained on first call). Never mutated — cloned inside. */
  activities: PlannedActivity[];
  /** Hard logic. Leveling links in the input are treated as hard (idempotence). */
  links: PlannedLink[];
  assignments: PlannedAssignment[];
  resources: PlannedResource[];
  /** frontId -> orderSeq (user sequence override, null = unordered). */
  frontOrder: Map<string, number | null>;
  capacities: Record<string, number>;
  calendarType: CalendarType;
  /**
   * Canonical CPM rerun: writes dates/float/critical onto `acts` in place.
   * Returns null on cycle/failure (caller drops the batch).
   */
  rerun: (acts: PlannedActivity[], links: PlannedLink[]) => { projectFinish: string | null } | null;
}

export interface LevelOutput {
  activities: PlannedActivity[];
  links: PlannedLink[];
  addedLinks: PlannedLink[];
  attributions: LevelAttribution[];
  demands: PoolDemand[];
  pools: string[];
  capacities: Map<string, number>;
  provenance: Map<string, "default" | "user">;
  conflictsBefore: PoolConflict[];
  conflictsAfter: PoolConflict[];
  infeasible: ResourceLevelingReport["infeasible"];
  invalidCapacities: ResourceLevelingReport["invalidCapacities"];
  iterations: number;
}

interface PackedMember {
  id: string;
  es: string;
  ef: string;
  tf: number | null;
  frontId: string;
  userSeq: number;
  units: number;
}

function prioritySort() {
  const INF = Number.MAX_SAFE_INTEGER;
  // §4 keys: user sequence (= front orderSeq, precomputed) → readiness ES →
  // front id → total float → stable id. Keys 1+3 share orderSeq by construction.
  return (x: PackedMember, y: PackedMember): number =>
    x.userSeq - y.userSeq
    || (x.es < y.es ? -1 : x.es > y.es ? 1 : 0)
    || x.frontId.localeCompare(y.frontId)
    || (x.tf === null ? INF : x.tf) - (y.tf === null ? INF : y.tf)
    || x.id.localeCompare(y.id);
}

/** Targeted reachability (type-blind, like the engine cycle tripwire). */
function reaches(from: string, to: string, succ: Map<string, string[]>): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const stack = [...(succ.get(from) || [])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(succ.get(n) || []));
  }
  return false;
}

function cloneActs(acts: PlannedActivity[]): PlannedActivity[] {
  return JSON.parse(JSON.stringify(acts)) as PlannedActivity[];
}

function cloneLinks(links: PlannedLink[]): PlannedLink[] {
  return JSON.parse(JSON.stringify(links)) as PlannedLink[];
}

export function levelBoqResources(input: LevelInput): LevelOutput {
  const acts = cloneActs(input.activities);
  const links = cloneLinks(input.links);
  const byId = new Map(acts.map((a) => [a.stableId, a]));
  const { demands, pools } = buildPoolDemands(acts, input.assignments, input.resources);
  const resolved = resolveCapacities(demands, pools, input.capacities);
  const conflictsBefore = detectPoolConflicts(acts, demands, resolved.capacities);
  const beforeByPool = new Map(conflictsBefore.map((c) => [c.poolKey, c]));

  const addedLinks: PlannedLink[] = [];
  const attributions: LevelAttribution[] = [];
  const attrByPair = new Map<string, LevelAttribution>();
  const infeasible: ResourceLevelingReport["infeasible"] = [];
  const infeasibleSeen = new Set<string>();
  const markInfeasible = (poolKey: string, a: string, b: string, reason: string) => {
    const k = `${poolKey}|${a}|${b}|${reason}`;
    if (infeasibleSeen.has(k)) return;
    infeasibleSeen.add(k);
    infeasible.push({ poolKey, aStableId: a, bStableId: b, reason });
  };

  // Successor map over hard + leveling links (incrementally extended per batch).
  const succ = new Map<string, string[]>();
  for (const l of links) {
    if (!succ.has(l.fromActivityId)) succ.set(l.fromActivityId, []);
    succ.get(l.fromActivityId)!.push(l.toActivityId);
  }
  const fsPairs = new Set(links.filter((l) => l.type === "FS").map((l) => `${l.fromActivityId}>${l.toActivityId}`));
  const ownPair = new Map<string, LevelAttribution>();
  for (const l of links) {
    if (l.origin !== "resource_leveling" || l.type !== "FS") continue;
    // Pre-existing leveling links (idempotent re-entry) co-govern under their pool.
    const attr: LevelAttribution = {
      linkStableId: l.stableId, fromActivityId: l.fromActivityId, toActivityId: l.toActivityId,
      resourceKey: l.resourceKey || "unknown", coResourceKeys: [],
      capacity: 0, reason: l.rule, ruleCode: l.ruleCode,
      delayDays: 0, generated: true, priorityInverted: false,
    };
    ownPair.set(`${l.fromActivityId}>${l.toActivityId}`, attr);
  }

  const byPool = new Map<string, PoolDemand[]>();
  for (const d of demands) {
    if (!byPool.has(d.poolKey)) byPool.set(d.poolKey, []);
    byPool.get(d.poolKey)!.push(d);
  }
  const sorter = prioritySort();
  let seq = links.filter((l) => l.origin === "resource_leveling").length;
  let iterations = 0;

  for (let iter = 0; iter < MAX_LEVELING_ITERATIONS; iter++) {
    iterations = iter + 1;
    const batch: PlannedLink[] = [];
    const batchAttr: LevelAttribution[] = [];
    for (const poolKey of pools) {
      const cap = resolved.capacities.get(poolKey) || 1;
      const members: PackedMember[] = [];
      for (const d of byPool.get(poolKey) || []) {
        const a = byId.get(d.activityStableId);
        if (!a || !a.earlyStart || !a.earlyFinish) continue;
        const ord = a.frontId ? input.frontOrder.get(a.frontId) : null;
        members.push({
          id: a.stableId, es: a.earlyStart, ef: a.earlyFinish, tf: a.totalFloat,
          frontId: a.frontId || "",
          userSeq: typeof ord === "number" && Number.isFinite(ord) ? ord : Number.MAX_SAFE_INTEGER,
          units: d.units,
        });
      }
      members.sort(sorter);
      // Fixed lane slots; empty slots (tailEF "") are free for every member.
      const lanes: Array<{ tailId: string; tailEF: string }> = [];
      for (let i = 0; i < cap; i++) lanes.push({ tailId: "", tailEF: "" });
      const occupy = (idx: number[], m: PackedMember) => {
        for (const i of idx) lanes[i] = { tailId: m.id, tailEF: m.ef };
      };
      const before = beforeByPool.get(poolKey);
      const peakNote = before ? ` (pool peak ${before.peakDemand} vs capacity ${cap}${before.peakDay ? ` on ${before.peakDay}` : ""})` : "";
      for (const m of members) {
        if (m.units > cap) {
          markInfeasible(poolKey, m.id, m.id, `demand ${m.units} gangs exceeds capacity ${cap} — no sequencing can fix a single-activity deficit`);
          continue;
        }
        const free: number[] = [];
        for (let i = 0; i < lanes.length && free.length < m.units; i++) {
          if (lanes[i].tailEF < m.es) free.push(i);
        }
        if (free.length === m.units) { occupy(free, m); continue; }
        // Conflict: victim = earliest-finishing lane (tie: smallest tail id).
        let v = 0;
        for (let i = 1; i < lanes.length; i++) {
          if (lanes[i].tailEF < lanes[v].tailEF || lanes[i].tailEF === lanes[v].tailEF && lanes[i].tailId < lanes[v].tailId) v = i;
        }
        const T = lanes[v].tailId;
        if (!T || T === m.id) continue; // empty lane would have been free; defensive only
        const tAct = byId.get(T);
        const mAct = byId.get(m.id);
        const pair = `${T}>${m.id}`;
        const revPair = `${m.id}>${T}`;
        const addLink = (from: string, to: string, inverted: boolean) => {
          seq++;
          const fromCode = byId.get(from)?.code || from;
          const toCode = byId.get(to)?.code || to;
          const reason = `Resource ${poolKey}: capacity ${cap}; ${fromCode} → ${toCode}${peakNote}${inverted ? " [priority inverted: forward direction would close a logic cycle]" : ""}`;
          const link: PlannedLink = {
            stableId: `lvl-${String(seq).padStart(4, "0")}`,
            fromActivityId: from, toActivityId: to, type: "FS", lagDays: 0,
            rule: reason, origin: "resource_leveling", resourceKey: poolKey,
            ruleCode: poolRuleCode(poolKey),
          };
          const attr: LevelAttribution = {
            linkStableId: link.stableId, fromActivityId: from, toActivityId: to,
            resourceKey: poolKey, coResourceKeys: [], capacity: cap,
            reason, ruleCode: link.ruleCode, delayDays: 0,
            generated: true, priorityInverted: inverted,
          };
          batch.push(link);
          batchAttr.push(attr);
          attrByPair.set(`${from}>${to}`, attr);
          ownPair.set(`${from}>${to}`, attr);
          fsPairs.add(`${from}>${to}`);
          if (!succ.has(from)) succ.set(from, []);
          succ.get(from)!.push(to);
        };
        const coGovern = (p: string) => {
          const ex = ownPair.get(p);
          if (ex && ex.resourceKey !== poolKey && !ex.coResourceKeys.includes(poolKey)) {
            ex.coResourceKeys.push(poolKey);
            ex.coResourceKeys.sort();
          }
        };
        if (fsPairs.has(pair)) {
          coGovern(pair);
          occupy([v, ...free].slice(0, m.units), m);
          continue;
        }
        if (!reaches(m.id, T, succ)) {
          addLink(T, m.id, false);
          occupy([v, ...free].slice(0, m.units), m);
          continue;
        }
        // Forward would cycle: try the reverse when acyclic.
        if (fsPairs.has(revPair)) {
          coGovern(revPair);
          continue;
        }
        if (!reaches(T, m.id, succ)) {
          addLink(m.id, T, true);
          continue;
        }
        markInfeasible(poolKey, T, m.id, `both ${tAct?.code || T} → ${mAct?.code || m.id} and the reverse would close a logic cycle`);
      }
    }
    if (batch.length === 0) break;
    links.push(...batch);
    addedLinks.push(...batch);
    attributions.push(...batchAttr);
    const rerun = input.rerun(acts, links);
    if (!rerun) {
      // Defensive: batch is cycle-checked, so this means the input was already bad.
      links.splice(links.length - batch.length, batch.length);
      addedLinks.splice(addedLinks.length - batch.length, batch.length);
      attributions.splice(attributions.length - batchAttr.length, batchAttr.length);
      for (const b of batch) {
        attrByPair.delete(`${b.fromActivityId}>${b.toActivityId}`);
        if (ownPair.get(`${b.fromActivityId}>${b.toActivityId}`)?.linkStableId === b.stableId) {
          ownPair.delete(`${b.fromActivityId}>${b.toActivityId}`);
        }
      }
      markInfeasible("batch", batch[0]?.fromActivityId || "", batch[0]?.toActivityId || "", "CPM rerun failed after adding leveling links — batch dropped");
      break;
    }
    byId.clear();
    for (const a of acts) byId.set(a.stableId, a);
  }

  const conflictsAfter = detectPoolConflicts(acts, demands, resolved.capacities);
  return {
    activities: acts, links, addedLinks, attributions, demands, pools,
    capacities: resolved.capacities, provenance: resolved.provenance,
    conflictsBefore, conflictsAfter, infeasible,
    invalidCapacities: resolved.invalid, iterations,
  };
}

// -------------------------------------------------------------------------------------
// Snapshots + bottleneck classification
// -------------------------------------------------------------------------------------

export function snapshotState(
  activities: PlannedActivity[],
  conflicts: PoolConflict[]
): LevelSnapshot {
  const core = activities.filter((a) => !a.isMilestone);
  const crit = core.filter((a) => a.isCritical).map((a) => a.stableId).sort();
  const finishes = activities.map((a) => a.earlyFinish).filter((x): x is string => !!x).sort();
  const starts = activities.map((a) => a.earlyStart).filter((x): x is string => !!x).sort();
  return {
    projectFinish: finishes.length > 0 ? finishes[finishes.length - 1] : null,
    spanDays: calendarSpanDays(starts[0] || null, finishes[finishes.length - 1] || null),
    criticalCount: crit.length,
    criticalStableIds: crit,
    conflictCount: conflicts.length,
    conflicts,
  };
}

export function classifyPools(
  pools: string[],
  resources: PlannedResource[],
  conflictsBefore: PoolConflict[],
  attributions: LevelAttribution[],
  capacities: Map<string, number>,
  provenance: Map<string, "default" | "user">,
  constrainedActs: PlannedActivity[]
): PoolBottleneck[] {
  const resByCode = new Map(resources.map((r) => [r.code, r]));
  const byId = new Map(constrainedActs.map((a) => [a.stableId, a]));
  const beforeByPool = new Map(conflictsBefore.map((c) => [c.poolKey, c]));
  const linksByPool = new Map<string, LevelAttribution[]>();
  for (const at of attributions) {
    if (!linksByPool.has(at.resourceKey)) linksByPool.set(at.resourceKey, []);
    linksByPool.get(at.resourceKey)!.push(at);
  }
  return pools.map((poolKey) => {
    const before = beforeByPool.get(poolKey);
    const mine = linksByPool.get(poolKey) || [];
    const succIds = [...new Set(mine.map((m) => m.toActivityId))];
    let criticalAffected = 0;
    let nearCriticalAffected = 0;
    for (const id of succIds) {
      const a = byId.get(id);
      if (!a) continue;
      if (a.isCritical) criticalAffected++;
      else if (a.totalFloat !== null && a.totalFloat <= NEAR_CRITICAL_TF_DAYS) nearCriticalAffected++;
    }
    const peak = before ? before.peakDemand : 0;
    const cap = capacities.get(poolKey) || 1;
    const classification: PoolClassification =
      peak <= cap ? "normal"
      : criticalAffected + nearCriticalAffected > 0 ? "bottleneck" : "constrained";
    const res = resByCode.get(poolKey);
    return {
      poolKey,
      resourceName: res?.name || poolKey,
      resourceType: res?.type || "",
      capacity: cap,
      capacityProvenance: provenance.get(poolKey) || "default",
      peakDemand: peak,
      conflictActivityCount: before ? before.activityStableIds.length : 0,
      levelingLinksAdded: mine.length,
      delayContributionDays: mine.reduce((mx, m) => Math.max(mx, m.delayDays), 0),
      criticalAffected,
      nearCriticalAffected,
      classification,
    };
  });
}

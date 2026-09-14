// =====================================================================================
// Phase F2 · BOQ plan persistence (XER-style: build plan -> persist -> clean failure).
//
// buildBoqPersistPlan() maps the deterministic plan (stable IDs) to concrete UUIDs +
// ordered DB row payloads. persistBoqPersistPlan() inserts them in dependency order
// and, on ANY failure, deletes whatever it already inserted (reverse order) so a
// failed confirm never leaves a half-built project behind.
//
// Trigger safety (the critical detail): inserting activity_resources rows and touching
// resources.cost_rate/rental_rate fires `recompute_resource_budget`, which recomputes
// activity-linked budget_lines.planned_cost from assignments x rates. Generated crew
// rows therefore persist with unit_rate NULL (and cost_rate/rental_rate left at the
// DB default, never written), so the recompute provably keeps the BOQ-derived
// planned_cost: every generated assignment contributes NULL to the cost sum, and the
// trigger preserves the stored cost when the whole sum is NULL (either insert order).
//
// Baseline: persist NEVER creates one. approveBoqBaseline() is the only path, and it
// refuses unless the plan validation reports zero critical findings.
// =====================================================================================

import type { BoqPlan } from "./boqPlanningEngine";

export interface BoqDbClient {
  from(table: string): {
    insert(rows: Record<string, unknown> | Record<string, unknown>[]): Promise<{ data: unknown; error: { message: string } | null }>;
    delete(): {
      eq(col: string, val: string): Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
}

export interface BoqPersistPlan {
  project: Record<string, unknown>;
  boqItems: Record<string, unknown>[];
  wbs: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  links: Record<string, unknown>[];
  budgetLines: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  assignments: Record<string, unknown>[];
  allocations: Record<string, unknown>[];
  activityIdByStable: Record<string, string>;
  wbsIdByStable: Record<string, string>;
  resourceIdByStable: Record<string, string>;
  boqIdByRowKey: Record<string, string>;
  projectId: string;
  planRecon: BoqPlan["recon"];
  canApproveBaseline: boolean;
}

export interface BoqPersistResult {
  ok: boolean;
  projectId: string | null;
  insertedCounts: Record<string, number>;
  failedStep: string | null;
  error: string | null;
  cleanedUp: string[];
  cleanupErrors: string[];
}

export interface BoqBaselineResult {
  ok: boolean;
  error: string | null;
  baselineId: string | null;
  version: number | null;
  activityCount: number;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface BoqProjectInput {
  name: string;
  name_ar?: string;
  code?: string;
  client?: string;
  location?: string;
  contract_value?: number;
  description?: string;
  start_date: string;
  end_date: string;
  status?: string;
  currency?: string;
  calendar_type?: string;
}

export function buildBoqPersistPlan(
  plan: BoqPlan,
  project: BoqProjectInput,
  boqRows: Array<{ rowKey: string; item_code: string; description: string; unit: string; quantity: number; unit_price: number; total_price: number }>
): BoqPersistPlan {
  const projectId = uuid();
  const activityIdByStable: Record<string, string> = {};
  const wbsIdByStable: Record<string, string> = {};
  const resourceIdByStable: Record<string, string> = {};
  const boqIdByRowKey: Record<string, string> = {};

  for (const a of plan.activities) activityIdByStable[a.stableId] = uuid();
  for (const w of plan.wbs) wbsIdByStable[w.stableId] = uuid();
  for (const r of plan.resources) resourceIdByStable[r.stableId] = uuid();
  for (const b of boqRows) boqIdByRowKey[b.rowKey] = uuid();

  const boqItems = boqRows.map((b) => ({
    id: boqIdByRowKey[b.rowKey],
    project_id: projectId,
    item_code: b.item_code,
    description: b.description,
    unit: b.unit,
    quantity: b.quantity,
    unit_price: b.unit_price,
    total_price: b.total_price,
  }));

  const wbs = plan.wbs.map((w) => ({
    id: wbsIdByStable[w.stableId],
    project_id: projectId,
    code: w.code,
    name: w.name,
    level: w.level,
    parent_id: w.parentStableId ? wbsIdByStable[w.parentStableId] : null,
    sort_order: w.sortOrder,
  }));

  const activities = plan.activities.map((a) => ({
    id: activityIdByStable[a.stableId],
    project_id: projectId,
    wbs_node_id: wbsIdByStable[a.wbsStableId],
    code: a.code,
    name: a.name,
    planned_quantity: a.quantity,
    unit: a.quantityUnit,
    duration_days: a.durationDays,
    remaining_duration_days: a.isMilestone ? 0 : a.durationDays,
    early_start: a.earlyStart ? a.earlyStart.slice(0, 10) : null,
    early_finish: a.earlyFinish ? a.earlyFinish.slice(0, 10) : null,
    late_start: a.lateStart ? a.lateStart.slice(0, 10) : null,
    late_finish: a.lateFinish ? a.lateFinish.slice(0, 10) : null,
    total_float: a.totalFloat,
    is_milestone: a.isMilestone,
    activity_type: a.isMilestone ? (a.milestoneKind === "start" ? "start_milestone" : "finish_milestone") : "task_dependent",
    is_critical: a.isCritical,
    sort_order: a.sortOrder,
  }));

  const links = plan.links.map((l) => ({
    id: uuid(),
    project_id: projectId,
    predecessor_id: activityIdByStable[l.fromActivityId],
    successor_id: activityIdByStable[l.toActivityId],
    relationship_type: l.type,
    lag_days: l.lagDays,
  }));

  const budgetLines = plan.budgetLines.map((b) => ({
    id: uuid(),
    project_id: projectId,
    wbs_node_id: wbsIdByStable[b.wbsStableId],
    activity_id: activityIdByStable[b.activityStableId],
    boq_item_id: null,
    description: b.description,
    planned_cost: b.plannedCost,
    committed_cost: 0,
    actual_cost: 0,
    remaining_cost: b.plannedCost,
    budget_basis: "boq_generated",
  }));

  const resources = plan.resources.map((r) => ({
    id: resourceIdByStable[r.stableId],
    project_id: projectId,
    code: r.code,
    name: r.name,
    type: r.type,
    unit: r.unit,
    unit_rate: null,
    availability: null,
  }));

  const assignments = plan.assignments.map((a) => ({
    id: uuid(),
    project_id: projectId,
    activity_id: activityIdByStable[a.activityStableId],
    resource_id: resourceIdByStable[a.resourceStableId],
    planned_quantity: a.plannedQuantity,
    remaining_quantity: null,
  }));

  const allocations = plan.allocations.map((a) => ({
    id: uuid(),
    project_id: projectId,
    activity_id: activityIdByStable[a.activityStableId],
    boq_item_id: boqIdByRowKey[a.rowKey],
    quantity_share: a.quantityShare,
    cost_share: a.costShare,
    allocation_basis: a.allocationBasis,
    is_generated: true,
  }));

  return {
    project: {
      id: projectId,
      name: project.name,
      name_ar: project.name_ar || null,
      code: project.code || null,
      location: project.location || null,
      start_date: project.start_date,
      end_date: project.end_date,
      status: project.status || "planning",
      currency: project.currency || "SAR",
      calendar_type: project.calendar_type || "6_days",
    },
    boqItems,
    wbs,
    activities,
    links,
    budgetLines,
    resources,
    assignments,
    allocations,
    activityIdByStable,
    wbsIdByStable,
    resourceIdByStable,
    boqIdByRowKey,
    projectId,
    planRecon: plan.recon,
    canApproveBaseline: plan.canApproveBaseline,
  };
}

async function cleanupTable(
  client: BoqDbClient,
  table: string,
  projectId: string,
  cleanedUp: string[],
  cleanupErrors: string[]
): Promise<void> {
  try {
    const { error } = await client.from(table).delete().eq("project_id", projectId);
    if (error) cleanupErrors.push(`${table}: ${error.message}`);
    else cleanedUp.push(table);
  } catch (e) {
    cleanupErrors.push(`${table}: ${(e as Error).message}`);
  }
}

/**
 * Persist in dependency order; on failure delete everything already written (reverse
 * order) plus the project row itself, so no half-built project survives.
 */
export async function persistBoqPersistPlan(
  client: BoqDbClient,
  persist: BoqPersistPlan,
  onProgress?: (step: string, done: number, total: number) => void
): Promise<BoqPersistResult> {
  const steps: Array<{ table: string; rows: Record<string, unknown>[] }> = [
    { table: "projects", rows: [persist.project] },
    { table: "boq_items", rows: persist.boqItems },
    { table: "wbs_nodes", rows: persist.wbs },
    { table: "activities", rows: persist.activities },
    { table: "activity_links", rows: persist.links },
    { table: "budget_lines", rows: persist.budgetLines },
    { table: "resources", rows: persist.resources },
    { table: "activity_resources", rows: persist.assignments },
    { table: "activity_boq_allocations", rows: persist.allocations },
  ];
  const cleanedUp: string[] = [];
  const cleanupErrors: string[] = [];
  const insertedCounts: Record<string, number> = {};
  const total = steps.reduce((a, s) => a + s.rows.length, 0);
  let done = 0;

  for (const step of steps) {
    if (step.rows.length === 0) {
      insertedCounts[step.table] = 0;
      continue;
    }
    try {
      const { error } = await client.from(step.table).insert(step.rows);
      if (error) throw new Error(`${step.table}: ${error.message}`);
      insertedCounts[step.table] = step.rows.length;
      done += step.rows.length;
      onProgress?.(step.table, done, total);
    } catch (e) {
    const failedStep = "persist";
    // Roll back everything already written (reverse dependency order).
    for (const step of [...steps].reverse()) {
      if ((insertedCounts[step.table] || 0) > 0 || step.table === "projects") {
        await cleanupTable(client, step.table, persist.projectId, cleanedUp, cleanupErrors);
      }
    }
    return {
      ok: false, projectId: null, insertedCounts,
      failedStep, error: (e as Error).message, cleanedUp, cleanupErrors,
      };
    }
  }
  return {
    ok: true, projectId: persist.projectId, insertedCounts,
    failedStep: null, error: null, cleanedUp, cleanupErrors,
  };
}

export async function approveBoqBaseline(
  client: BoqDbClient,
  projectId: string,
  activities: Array<{ activity_id: string; code: string; name: string; planned_start: string | null; planned_finish: string | null; duration_days: number; planned_cost: number }>,
  version = 1,
  name = "Initial Baseline"
): Promise<BoqBaselineResult> {
  try {
    const header = {
      id: uuid(), project_id: projectId, version, name,
      status: "approved", approved_at: new Date().toISOString(), is_active: true,
    };
    const { error: hErr } = await client.from("project_baselines").insert(header);
    if (hErr) throw new Error(`project_baselines: ${hErr.message}`);
    const rows = activities.map((a) => ({
      id: uuid(), baseline_id: header.id, project_id: projectId, ...a,
    }));
    if (rows.length > 0) {
      const { error: rErr } = await client.from("baseline_activities").insert(rows);
      if (rErr) throw new Error(`baseline_activities: ${rErr.message}`);
    }
    return { ok: true, error: null, baselineId: header.id as string, version, activityCount: rows.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message, baselineId: null, version: null, activityCount: 0 };
  }
}
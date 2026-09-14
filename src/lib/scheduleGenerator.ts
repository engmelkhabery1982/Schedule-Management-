// =====================================================================================
// Phase F2 · Compatibility wrapper over the BOQ planning engine.
//
// The legacy one-activity-per-BOQ-item generator (serial chain, category base
// durations, fabricated resource rates) is retired. generateSchedule() keeps its exact
// signature and return shape — now backed by generateBoqPlan() — so the single caller
// (ImportView) and any external consumer keep working. There is exactly ONE planning
// engine: boqPlanningEngine. This file only maps its output onto the legacy shape.
// =====================================================================================

import type { CalendarType, ParsedBoqRow } from '@/types';
import {
  EMPTY_BOQ_OVERRIDES,
  generateBoqPlan,
  type BoqPlanOverrides,
} from './boqPlanningEngine';
import type { ProductivityRule } from './planningEngine';

export interface GenWbsNode {
  code: string;
  name: string;
  level: number;
  parent_code: string | null;
  sort_order: number;
}

export interface GenActivity {
  wbs_node_code: string | null;
  code: string;
  name: string;
  early_start: string;
  early_finish: string;
  late_start: string;
  late_finish: string;
  duration_days: number;
  planned_quantity: number;
  actual_quantity: number;
  unit: string;
  percent_complete: number;
  is_critical: boolean;
  is_milestone: boolean;
  actual_start: string | null;
  actual_finish: string | null;
  sort_order: number;
}

export interface GenLink {
  predecessor_code: string;
  successor_code: string;
  link_type: string;
  lag_days: number;
}

export interface GenResource {
  code: string;
  name: string;
  type: string;
  unit: string;
  unit_rate: number;
  availability: number;
}

export interface GenActivityResource {
  activityCode: string;
  resourceCode: string;
  planned_quantity: number;
}

export interface GenBudgetLine {
  wbs_node_code: string;
  description: string;
  planned_cost: number;
  committed_cost: number;
  actual_cost: number;
  remaining_cost: number;
}

export interface GeneratedSchedule {
  wbsNodes: GenWbsNode[];
  activities: GenActivity[];
  links: GenLink[];
  resources: GenResource[];
  activityResources: GenActivityResource[];
  budgetLines: GenBudgetLine[];
}

export function generateSchedule(
  boqItems: ParsedBoqRow[],
  startDate: string,
  productivityRules: ProductivityRule[] = [],
  calendarType: CalendarType = '6_days',
): GeneratedSchedule {
  // Pass 1: plan with library rates so stable activity IDs exist, then translate the
  // legacy category-keyed productivity rules into engine rate/crew overrides for the
  // activities fed by matching BOQ rows (compat bridge — the interactive flow passes
  // overrides directly instead).
  const first = generateBoqPlan(
    boqItems,
    { projectName: '', startDate, calendarType },
    EMPTY_BOQ_OVERRIDES,
  );
  const overrides: BoqPlanOverrides = {
    ...EMPTY_BOQ_OVERRIDES,
    workType: {},
    confirmed: {},
    location: {},
    duration: {},
    rate: {},
    crews: {},
    wbs: {},
    removeLinks: [],
    addLinks: [],
  };
  if (productivityRules.length > 0) {
    const catByRow = new Map(first.classifications.map((c) => [c.rowKey, boqItems[Number(c.rowKey.slice(4)) - 1]?.category || '']));
    const actsByRow = new Map<string, string[]>();
    for (const al of first.allocations) {
      const list = actsByRow.get(al.rowKey) || [];
      list.push(al.activityStableId);
      actsByRow.set(al.rowKey, list);
    }
    for (const rule of productivityRules) {
      for (const [rowKey, cat] of catByRow) {
        if (cat !== rule.category) continue;
        for (const actId of actsByRow.get(rowKey) || []) {
          if (rule.daily_output > 0) overrides.rate[actId] = rule.daily_output;
          if (rule.crew_size > 0) overrides.crews[actId] = Math.round(rule.crew_size);
        }
      }
    }
  }

  const plan = productivityRules.length > 0
    ? generateBoqPlan(boqItems, { projectName: '', startDate, calendarType }, overrides)
    : first;

  const wbsCodeByStable = new Map(plan.wbs.map((w) => [w.stableId, w.code]));
  const actCodeByStable = new Map(plan.activities.map((a) => [a.stableId, a.code]));
  const resCodeByStable = new Map(plan.resources.map((r) => [r.stableId, r.code]));

  return {
    wbsNodes: plan.wbs.map((w) => ({
      code: w.code,
      name: w.name,
      level: w.level,
      parent_code: w.parentStableId ? (wbsCodeByStable.get(w.parentStableId) || null) : null,
      sort_order: w.sortOrder,
    })),
    activities: plan.activities.map((a) => ({
      wbs_node_code: wbsCodeByStable.get(a.wbsStableId) || null,
      code: a.code,
      name: a.name,
      early_start: (a.earlyStart || startDate).slice(0, 10),
      early_finish: (a.earlyFinish || startDate).slice(0, 10),
      late_start: (a.lateStart || startDate).slice(0, 10),
      late_finish: (a.lateFinish || startDate).slice(0, 10),
      duration_days: a.durationDays,
      planned_quantity: a.quantity || 0,
      actual_quantity: 0,
      unit: a.quantityUnit || '',
      percent_complete: 0,
      is_critical: a.isCritical,
      is_milestone: a.isMilestone,
      actual_start: null,
      actual_finish: null,
      sort_order: a.sortOrder,
    })),
    links: plan.links.map((l) => ({
      predecessor_code: actCodeByStable.get(l.fromActivityId) || l.fromActivityId,
      successor_code: actCodeByStable.get(l.toActivityId) || l.toActivityId,
      link_type: l.type,
      lag_days: l.lagDays,
    })),
    resources: plan.resources.map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      unit: r.unit,
      unit_rate: 0,
      availability: 0,
    })),
    activityResources: plan.assignments.map((a) => ({
      activityCode: actCodeByStable.get(a.activityStableId) || a.activityStableId,
      resourceCode: resCodeByStable.get(a.resourceStableId) || a.resourceStableId,
      planned_quantity: a.plannedQuantity,
    })),
    budgetLines: plan.budgetLines.map((b) => ({
      wbs_node_code: wbsCodeByStable.get(b.wbsStableId) || '',
      description: b.description,
      planned_cost: b.plannedCost,
      committed_cost: 0,
      actual_cost: 0,
      remaining_cost: b.plannedCost,
    })),
  };
}

// Legacy span helper retained for compatibility (no live callers in the repo). The F2
// flow takes the project finish from the canonical CPM result, never from this.
export function calculateProjectDuration(activities: { early_start: string | null; early_finish: string | null }[]): number {
  if (activities.length === 0) return 0;
  const starts = activities.map((a) => a.early_start).filter(Boolean) as string[];
  const finishes = activities.map((a) => a.early_finish).filter(Boolean) as string[];
  if (starts.length === 0 || finishes.length === 0) return 0;
  const minStart = new Date(Math.min(...starts.map((s) => new Date(s).getTime())));
  const maxFinish = new Date(Math.max(...finishes.map((s) => new Date(s).getTime())));
  return Math.ceil((maxFinish.getTime() - minStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

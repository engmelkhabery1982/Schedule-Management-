import type { Activity, BaselineActivity } from '@/types';

export interface ScenarioInput {
  productivityFactor: number;
  delayDays: number;
  resourceCapacityFactor: number;
  costFactor: number;
}

export interface ScenarioResult {
  finishDate: string | null;
  durationDays: number;
  incrementalCost: number;
  impactedActivities: number;
  feasibility: 'feasible' | 'strained' | 'infeasible';
}

export function simulateScenario(
  activities: Activity[],
  baselines: BaselineActivity[],
  input: ScenarioInput,
): ScenarioResult {
  const active = activities.filter((activity) => activity.percent_complete < 100);
  if (active.length === 0) return { finishDate: null, durationDays: 0, incrementalCost: 0, impactedActivities: 0, feasibility: 'feasible' };
  const baselineById = new Map(baselines.map((baseline) => [baseline.activity_id, baseline]));
  const finishes = active.map((activity) => {
    const baseline = baselineById.get(activity.id);
    const remaining = Math.max(0, Number(activity.duration_days || 0) * (1 - Number(activity.percent_complete || 0) / 100));
    const adjustedDuration = Math.ceil(remaining * (1 + Math.max(0, input.delayDays) / Math.max(1, Number(activity.duration_days || 1)))
      / Math.max(0.25, input.productivityFactor * input.resourceCapacityFactor));
    const anchor = activity.early_start || baseline?.early_start;
    if (!anchor) return null;
    const finish = new Date(`${anchor}T00:00:00Z`);
    finish.setUTCDate(finish.getUTCDate() + adjustedDuration);
    return finish;
  }).filter((value): value is Date => Boolean(value));
  const latestFinish = finishes.reduce((latest, value) => !latest || value > latest ? value : latest, null as Date | null);
  const plannedRemainingCost = active.reduce((sum, activity) => {
    const baseline = baselineById.get(activity.id);
    return sum + Number(baseline?.planned_cost || 0) * (1 - Number(activity.percent_complete || 0) / 100);
  }, 0);
  const incrementalCost = plannedRemainingCost * Math.max(0, input.costFactor - 1);
  const durationDays = latestFinish && finishes.length
    ? Math.ceil((latestFinish.getTime() - new Date().getTime()) / 86400000)
    : 0;
  const feasibility = input.productivityFactor * input.resourceCapacityFactor >= 1 && input.costFactor <= 1.15
    ? 'feasible'
    : input.productivityFactor * input.resourceCapacityFactor >= 0.8 && input.costFactor <= 1.35
      ? 'strained'
      : 'infeasible';
  return {
    finishDate: latestFinish?.toISOString().split('T')[0] || null,
    durationDays: Math.max(0, durationDays),
    incrementalCost,
    impactedActivities: active.filter((activity) => activity.is_critical || Number(activity.total_float || 0) <= 5).length,
    feasibility,
  };
}

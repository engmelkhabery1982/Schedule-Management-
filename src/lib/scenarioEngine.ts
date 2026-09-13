import type { Activity, BaselineActivity } from '@/types';
import { DEFAULT_DATA_DATE } from './projectControlsConstants';

export interface ScenarioInput {
  productivityFactor: number;
  resourceCapacityFactor: number;
  costFactor: number;
  delayDays: number;
}

export interface ScenarioResult {
  finishDate: string | null;
  durationDays: number;
  incrementalCost: number;
  impactedActivities: number;
  feasibility: 'feasible' | 'strained' | 'infeasible';
  /**
   * The governed Data Date this result was measured from (GAP-030). A remaining-duration metric is
   * only meaningful against a status date, so the engine reports the anchor it used.
   */
  dataDate: string;
}

/**
 * Resolve the governed Data Date for a scenario run (GAP-030).
 *
 * Order: an explicit `dataDate` argument -> the project's own `data_date` -> `DEFAULT_DATA_DATE`.
 * The runtime machine clock is never consulted: a schedule metric that moved with "today" could not
 * be reproduced, audited, or reconciled against the canonical EVM path, which resolves the same
 * chain (see `projectControlsConstants.DEFAULT_DATA_DATE`).
 */
export function resolveScenarioDataDate(
  dataDate?: string | null,
  project?: { data_date?: string | null } | null,
): string {
  const explicit = String(dataDate || '').trim();
  if (explicit) return explicit;
  const fromProject = String(project?.data_date || '').trim();
  if (fromProject) return fromProject;
  return DEFAULT_DATA_DATE;
}

/**
 * Simulate a productivity / delay / cost scenario over the remaining work.
 *
 * `dataDate` (or `project`) is optional so existing callers keep compiling, but the value is what
 * the remaining-duration metric is measured from; when neither is supplied the governed
 * `DEFAULT_DATA_DATE` applies instead of the runtime machine clock.
 */
export function simulateScenario(
  activities: Activity[],
  baselines: BaselineActivity[],
  input: ScenarioInput,
  dataDate?: string | null,
  project?: { data_date?: string | null } | null,
): ScenarioResult {
  const anchorDataDate = resolveScenarioDataDate(dataDate, project);
  const active = activities.filter((activity) => activity.percent_complete < 100);
  if (active.length === 0) {
    return {
      finishDate: null,
      durationDays: 0,
      incrementalCost: 0,
      impactedActivities: 0,
      feasibility: 'feasible',
      dataDate: anchorDataDate,
    };
  }
  const baselineById = new Map(baselines.map((baseline) => [baseline.activity_id, baseline]));
  const finishes = active
    .map((activity) => {
      const baseline = baselineById.get(activity.id);
      const remaining = Math.max(0, Number(activity.duration_days || 0) * (1 - Number(activity.percent_complete || 0) / 100));
      const adjustedDuration = Math.ceil(
        (remaining * (1 + Math.max(0, input.delayDays) / Math.max(1, Number(activity.duration_days || 1)))) /
          Math.max(0.25, input.productivityFactor * input.resourceCapacityFactor),
      );
      const anchor = activity.early_start || baseline?.early_start;
      if (!anchor) return null;
      const finish = new Date(`${anchor}T00:00:00Z`);
      finish.setUTCDate(finish.getUTCDate() + adjustedDuration);
      return finish;
    })
    .filter((value): value is Date => Boolean(value));
  const latestFinish = finishes.reduce((latest, value) => (!latest || value > latest ? value : latest), null as Date | null);
  const plannedRemainingCost = active.reduce((sum, activity) => {
    const baseline = baselineById.get(activity.id);
    return sum + Number(baseline?.planned_cost || 0) * (1 - Number(activity.percent_complete || 0) / 100);
  }, 0);
  const incrementalCost = plannedRemainingCost * Math.max(0, input.costFactor - 1);
  // Remaining duration = latest simulated finish minus the GOVERNED Data Date. It used to be
  // measured against the runtime machine clock, which made the metric depend on the browser's own
  // "today" and therefore unreproducible and unauditable (GAP-030).
  const anchorTime = new Date(`${anchorDataDate}T00:00:00Z`).getTime();
  const durationDays =
    latestFinish && finishes.length ? Math.ceil((latestFinish.getTime() - anchorTime) / 86400000) : 0;
  const feasibility =
    input.productivityFactor * input.resourceCapacityFactor >= 1 && input.costFactor <= 1.15
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
    dataDate: anchorDataDate,
  };
}

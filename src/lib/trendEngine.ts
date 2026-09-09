import type { Activity, BaselineActivity, CostTransaction, ProgressUpdate } from '@/types';
import type { GeneratedAlert } from '@/lib/alertEngine';

export interface PerformanceTrend {
  direction: 'improving' | 'stable' | 'deteriorating';
  progressVelocity: number;
  costVelocity: number;
  sampleSize: number;
}

export interface BaselineVariance {
  activityId: string;
  scheduleVarianceDays: number;
  quantityVariance: number;
  status: 'ahead' | 'on_track' | 'behind';
}

function dayDifference(actual: string, planned: string): number {
  return Math.round((new Date(`${actual}T00:00:00Z`).getTime() - new Date(`${planned}T00:00:00Z`).getTime()) / 86400000);
}

export function calculatePerformanceTrend(
  updates: ProgressUpdate[],
  transactions: CostTransaction[],
): PerformanceTrend {
  const progress = updates.filter((item) => item.status === 'approved').sort((a, b) => a.update_date.localeCompare(b.update_date));
  const costs = transactions.filter((item) => item.status === 'approved').sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  const progressVelocity = progress.length > 1
    ? (Number(progress[progress.length - 1].quantity_to_date) - Number(progress[0].quantity_to_date)) / Math.max(1, progress.length - 1)
    : 0;
  const costVelocity = costs.length > 1
    ? (Number(costs[costs.length - 1].amount) - Number(costs[0].amount)) / Math.max(1, costs.length - 1)
    : 0;
  const recent = progress.slice(-3);
  const prior = progress.slice(-6, -3);
  const recentDelta = recent.length ? Number(recent[recent.length - 1].percent_complete) - Number(recent[0].percent_complete) : 0;
  const priorDelta = prior.length ? Number(prior[prior.length - 1].percent_complete) - Number(prior[0].percent_complete) : recentDelta;
  const change = recentDelta - priorDelta;
  return {
    direction: change < -2 ? 'deteriorating' : change > 2 ? 'improving' : 'stable',
    progressVelocity,
    costVelocity,
    sampleSize: Math.max(progress.length, costs.length),
  };
}

export function calculateBaselineVariances(
  activities: Activity[],
  baselineActivities: BaselineActivity[],
  today = new Date(),
): BaselineVariance[] {
  const baselineByActivity = new Map(baselineActivities.map((item) => [item.activity_id, item]));
  return activities.map((activity) => {
    const baseline = baselineByActivity.get(activity.id);
    if (!baseline) return { activityId: activity.id, scheduleVarianceDays: 0, quantityVariance: 0, status: 'on_track' };
    const plannedDate = activity.percent_complete >= 100 && activity.actual_finish
      ? activity.actual_finish
      : today.toISOString().split('T')[0];
    const scheduleVarianceDays = activity.percent_complete >= 100 && activity.actual_finish
      ? dayDifference(plannedDate, baseline.early_finish)
      : dayDifference(plannedDate, baseline.early_finish);
    const quantityVariance = Number(activity.actual_quantity || 0) - Number(activity.planned_quantity || 0) * Math.max(0, Math.min(1, (today.getTime() - new Date(`${baseline.early_start}T00:00:00Z`).getTime()) / Math.max(1, new Date(`${baseline.early_finish}T00:00:00Z`).getTime() - new Date(`${baseline.early_start}T00:00:00Z`).getTime())));
    return {
      activityId: activity.id,
      scheduleVarianceDays,
      quantityVariance,
      status: scheduleVarianceDays > 2 || quantityVariance < -Math.max(1, Number(activity.planned_quantity) * 0.1) ? 'behind' : scheduleVarianceDays < -2 ? 'ahead' : 'on_track',
    };
  });
}

export function generateTrendAlerts(trend: PerformanceTrend, variances: BaselineVariance[]): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  if (trend.direction === 'deteriorating' && trend.sampleSize >= 3) {
    alerts.push({
      fingerprint: 'trend-performance-deteriorating',
      alert_type: 'schedule',
      severity: 'critical',
      title: 'تدهور في اتجاه الأداء',
      message: 'سرعة الإنجاز في آخر التحديثات أقل من الفترة السابقة. يلزم تحليل السبب وخطة تصحيح.',
      activity_id: null,
    });
  }
  variances.filter((item) => item.status === 'behind' && item.scheduleVarianceDays > 2).slice(0, 25).forEach((item) => {
    alerts.push({
      fingerprint: `baseline-variance-${item.activityId}`,
      alert_type: 'schedule',
      severity: item.scheduleVarianceDays > 7 ? 'critical' : 'warning',
      title: 'انحراف نشاط عن خط الأساس',
      message: `النشاط متأخر ${item.scheduleVarianceDays} يوم عن تاريخ خط الأساس.`,
      activity_id: item.activityId,
    });
  });
  return alerts;
}

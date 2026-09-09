import type { Activity, BaselineActivity, EvmMetrics } from '@/types';

export interface RecoveryAnalysis {
  requiredSpi: number;
  remainingQuantity: number;
  requiredDailyQuantity: number;
  costGap: number;
  feasibility: 'feasible' | 'strained' | 'unlikely' | 'not_required';
  action: string;
}

function daysUntil(date: string | null, today: Date): number {
  if (!date) return 0;
  return Math.max(0, Math.ceil((new Date(`${date}T00:00:00Z`).getTime() - today.getTime()) / 86400000));
}

export function calculateRecoveryPlan(
  activities: Activity[],
  baselines: BaselineActivity[],
  evm: EvmMetrics,
  today = new Date(),
): RecoveryAnalysis {
  const baselineByActivity = new Map(baselines.map((baseline) => [baseline.activity_id, baseline]));
  const openActivities = activities.filter((activity) => activity.percent_complete < 100);
  const remainingQuantity = openActivities.reduce((sum, activity) => sum + Math.max(0, Number(activity.planned_quantity || 0) - Number(activity.actual_quantity || 0)), 0);
  const latestFinish = baselines.reduce((max, baseline) => !max || baseline.early_finish > max ? baseline.early_finish : max, null as string | null);
  const daysRemaining = daysUntil(latestFinish, today);
  const requiredSpi = evm.spi >= 1 || daysRemaining === 0 ? 1 : 1 / Math.max(0.25, evm.spi);
  const requiredDailyQuantity = daysRemaining > 0 ? remainingQuantity / daysRemaining : remainingQuantity;
  const plannedRemainingCost = openActivities.reduce((sum, activity) => {
    const baseline = baselineByActivity.get(activity.id);
    return sum + Number(baseline?.planned_cost || 0) * (1 - Math.max(0, Math.min(1, Number(activity.percent_complete || 0) / 100)));
  }, 0);
  const costGap = Math.max(0, plannedRemainingCost / Math.max(0.25, evm.cpi || 1) - plannedRemainingCost);
  const feasibility = evm.spi >= 1 && evm.cpi >= 1
    ? 'not_required'
    : requiredSpi <= 1.15 && evm.cpi >= 0.9
      ? 'feasible'
      : requiredSpi <= 1.35 && evm.cpi >= 0.75
        ? 'strained'
        : 'unlikely';
  return {
    requiredSpi,
    remainingQuantity,
    requiredDailyQuantity,
    costGap,
    feasibility,
    action: feasibility === 'unlikely'
      ? 'التاريخ الأساسي غير واقعي دون تغيير نطاق أو موارد أو اعتماد تمديد موثق.'
      : feasibility === 'strained'
        ? 'يلزم رفع الإنتاجية أو زيادة الموارد مع اعتماد خطة تعافي ومراجعة أسبوعية.'
        : feasibility === 'feasible'
          ? 'يمكن استعادة الخطة عبر تركيز الموارد على المسار الحرج ومراقبة الإنتاجية يوميًا.'
          : 'لا توجد حاجة لخطة تعافي؛ استمر في المراقبة والاعتماد الدوري.',
  };
}

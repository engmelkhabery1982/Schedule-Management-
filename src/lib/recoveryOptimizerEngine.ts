import type {
  Activity,
  ActivityLink,
  CalendarType,
  RecoveryOption,
  RecoveryPlanResult,
} from '@/types';
import { calculateCpm } from './cpmEngine';
import { addWorkingDays, countWorkingDays, subtractWorkingDays, getCalendar } from './calendarEngine';

export function generateScheduleRecoveryPlan(
  activities: Activity[],
  links: ActivityLink[],
  targetFinishDate?: string | null,
  calendarType: CalendarType = '6_days',
): RecoveryPlanResult {
  const calendar = getCalendar(calendarType);
  const currentCpm = calculateCpm(activities, links, calendarType);
  const currentFinish = currentCpm.projectEarlyFinish;

  const targetFinish = targetFinishDate || subtractWorkingDays(currentFinish, 14, calendar);
  const requiredCompressionDays = Math.max(0, countWorkingDays(targetFinish, currentFinish, calendar) - 1);

  const options: RecoveryOption[] = [];

  // Filter uncompleted critical path activities
  const criticalActivities = activities.filter(
    (a) => a.is_critical && a.percent_complete < 100 && !a.is_milestone && (a.duration_days || 0) > 3,
  );

  criticalActivities.forEach((act) => {
    const duration = Number(act.duration_days || 1);
    const remDuration = act.remaining_duration_days || Math.max(1, Math.round(duration * (1 - (act.percent_complete || 0) / 100)));

    // 1. Crashing Option (Overtime / Night Shift)
    if (remDuration >= 6) {
      const daysSaved = Math.min(8, Math.round(remDuration * 0.35));
      const costPerDay = 1800; // SAR / day
      const additionalCost = daysSaved * costPerDay;

      options.push({
        id: `opt-crash-${act.id}`,
        activityId: act.id,
        activityCode: act.code,
        activityName: act.name,
        strategy: 'crashing',
        strategyAr: 'ضغط النشاط والعمل الإضافي (Crashing / Overtime)',
        daysSaved,
        additionalCost,
        costPerDay,
        feasibilityScore: 92,
        description: `تشغيل وردية عمل إضافية للنشاط لتقليص مدته بمقدار ${daysSaved} يوماً.`,
        selected: true,
      });
    }

    // 2. Crew Doubling Option (طواقم عمل إضافية)
    if (remDuration >= 10) {
      const daysSaved = Math.min(10, Math.round(remDuration * 0.45));
      const costPerDay = 2400; // SAR / day
      const additionalCost = daysSaved * costPerDay;

      options.push({
        id: `opt-crew-${act.id}`,
        activityId: act.id,
        activityCode: act.code,
        activityName: act.name,
        strategy: 'crew_doubling',
        strategyAr: 'مضاعفة طواقم التنفيذ (Crew Doubling)',
        daysSaved,
        additionalCost,
        costPerDay,
        feasibilityScore: 85,
        description: `استقدام طاقم تخصصي إضافي لمضاعفة معدل الإنتاجية اليومية.`,
        selected: false,
      });
    }

    // 3. Fast-Tracking Option (التتبع السريع وتداخل الأنشطة)
    const actLinks = links.filter((l) => l.predecessor_id === act.id && l.link_type === 'FS');
    if (actLinks.length > 0 && remDuration >= 8) {
      const daysSaved = Math.min(6, Math.round(remDuration * 0.3));
      const costPerDay = 500; // Minimal coordination cost
      const additionalCost = daysSaved * costPerDay;

      options.push({
        id: `opt-fast-${act.id}`,
        activityId: act.id,
        activityCode: act.code,
        activityName: act.name,
        strategy: 'fast_tracking',
        strategyAr: 'التتبع السريع (Fast-Tracking: FS → SS + Lag)',
        daysSaved,
        additionalCost,
        costPerDay,
        feasibilityScore: 88,
        description: `بدء النشاط اللاحق بعد إنجاز 40% من هذا النشاط بالتوازي بدلاً من الانتظار لنهايته.`,
        selected: true,
      });
    }
  });

  // Sort options by lowest cost per day saved (Cost-Efficiency)
  options.sort((a, b) => a.costPerDay - b.costPerDay);

  // Calculate total recovered from selected options
  const selectedOptions = options.filter((o) => o.selected);
  const totalDaysRecovered = selectedOptions.reduce((sum, o) => sum + o.daysSaved, 0);
  const totalRecoveryCost = selectedOptions.reduce((sum, o) => sum + o.additionalCost, 0);

  const newProjectFinishDate = totalDaysRecovered > 0
    ? subtractWorkingDays(currentFinish, totalDaysRecovered, calendar)
    : currentFinish;

  const feasibilityRating: RecoveryPlanResult['feasibilityRating'] =
    totalDaysRecovered >= requiredCompressionDays ? 'high' : totalDaysRecovered >= requiredCompressionDays * 0.6 ? 'moderate' : 'difficult';

  let summary = '';
  if (totalDaysRecovered >= requiredCompressionDays) {
    summary = `الخطة الاستدراكية كافية تماماً لتعويض التأخير بالكامل واستعادة موعد التسليم التعاقدي (${newProjectFinishDate}) بتكلفة إضافية قدرها ${totalRecoveryCost.toLocaleString()} ريال.`;
  } else {
    summary = `الخطة الاستدراكية المقترحة تسترجع ${totalDaysRecovered} يوماً من أصل ${requiredCompressionDays} يوماً مطلوبة. يُوصى بتفعيل خيارات التعجيل الإضافية.`;
  }

  return {
    targetFinishDate: targetFinish,
    currentFinishDate: currentFinish,
    requiredCompressionDays,
    totalDaysRecovered,
    totalRecoveryCost,
    newProjectFinishDate,
    options,
    feasibilityRating,
    summary,
  };
}

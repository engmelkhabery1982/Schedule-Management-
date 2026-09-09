import type { Activity, BaselineActivity, CalendarType, ScheduleDiffResult, ActivityDiffItem } from '@/types';
import { countWorkingDays, getCalendar } from './calendarEngine';

export function compareScheduleWithBaseline(
  currentActivities: Activity[],
  baselineActivities: BaselineActivity[],
  baselineName: string = 'خط الأساس المعتمد (Rev 0)',
  currentScheduleName: string = 'الجدول الحالي المحدث',
  calendarType: CalendarType = '6_days',
): ScheduleDiffResult {
  const calendar = getCalendar(calendarType);
  const baselineMap = new Map(baselineActivities.map((b) => [b.activity_id, b]));
  const currentMap = new Map(currentActivities.map((a) => [a.id, a]));

  const diffItems: ActivityDiffItem[] = [];
  let addedCount = 0;
  let deletedCount = 0;
  let modifiedCount = 0;
  let critShiftCount = 0;

  // Process current activities against baseline
  currentActivities.forEach((cur) => {
    const base = baselineMap.get(cur.id);

    if (!base) {
      // Added Activity
      addedCount += 1;
      diffItems.push({
        activityId: cur.id,
        code: cur.code,
        name: cur.name,
        diffType: 'added',
        startBaseline: null,
        startCurrent: cur.early_start,
        startVarianceDays: 0,
        finishBaseline: null,
        finishCurrent: cur.early_finish,
        finishVarianceDays: 0,
        durationBaseline: 0,
        durationCurrent: cur.duration_days,
        durationVarianceDays: cur.duration_days,
        totalFloatBaseline: 0,
        totalFloatCurrent: cur.total_float || 0,
        totalFloatVarianceDays: 0,
        criticalityBaseline: false,
        criticalityCurrent: cur.is_critical,
        criticalityShift: cur.is_critical ? 'became_critical' : 'unchanged',
        percentBaseline: 0,
        percentCurrent: cur.percent_complete,
      });
    } else {
      // Calculate Variances
      let startVar = 0;
      if (cur.early_start && base.early_start) {
        if (cur.early_start > base.early_start) {
          startVar = countWorkingDays(base.early_start, cur.early_start, calendar) - 1;
        } else if (cur.early_start < base.early_start) {
          startVar = -(countWorkingDays(cur.early_start, base.early_start, calendar) - 1);
        }
      }

      let finishVar = 0;
      if (cur.early_finish && base.early_finish) {
        if (cur.early_finish > base.early_finish) {
          finishVar = countWorkingDays(base.early_finish, cur.early_finish, calendar) - 1;
        } else if (cur.early_finish < base.early_finish) {
          finishVar = -(countWorkingDays(cur.early_finish, base.early_finish, calendar) - 1);
        }
      }

      const durationVar = Number(cur.duration_days || 0) - Number(base.duration_days || 0);
      const isBaseCritical = false; // Baseline activities default to non-critical unless specified
      const critShift =
        cur.is_critical && !isBaseCritical
          ? 'became_critical'
          : !cur.is_critical && isBaseCritical
          ? 'became_non_critical'
          : 'unchanged';

      if (critShift !== 'unchanged') critShiftCount += 1;

      const isModified = startVar !== 0 || finishVar !== 0 || durationVar !== 0 || critShift !== 'unchanged';
      if (isModified) modifiedCount += 1;

      diffItems.push({
        activityId: cur.id,
        code: cur.code,
        name: cur.name,
        diffType: isModified ? 'modified' : 'unchanged',
        startBaseline: base.early_start,
        startCurrent: cur.early_start,
        startVarianceDays: startVar,
        finishBaseline: base.early_finish,
        finishCurrent: cur.early_finish,
        finishVarianceDays: finishVar,
        durationBaseline: base.duration_days,
        durationCurrent: cur.duration_days,
        durationVarianceDays: durationVar,
        totalFloatBaseline: 0,
        totalFloatCurrent: cur.total_float || 0,
        totalFloatVarianceDays: cur.total_float || 0,
        criticalityBaseline: isBaseCritical,
        criticalityCurrent: cur.is_critical,
        criticalityShift: critShift,
        percentBaseline: 0,
        percentCurrent: cur.percent_complete,
      });
    }
  });

  // Calculate project-level finish variance
  const latestCurrentFinish = currentActivities.reduce((max, a) => {
    return !max || (a.early_finish && a.early_finish > max) ? a.early_finish || max : max;
  }, '');

  const latestBaseFinish = baselineActivities.reduce((max, b) => {
    return !max || (b.early_finish && b.early_finish > max) ? b.early_finish : max;
  }, '');

  let projectFinishVariance = 0;
  if (latestCurrentFinish && latestBaseFinish) {
    if (latestCurrentFinish > latestBaseFinish) {
      projectFinishVariance = countWorkingDays(latestBaseFinish, latestCurrentFinish, calendar) - 1;
    } else if (latestCurrentFinish < latestBaseFinish) {
      projectFinishVariance = -(countWorkingDays(latestCurrentFinish, latestBaseFinish, calendar) - 1);
    }
  }

  let summary = '';
  if (projectFinishVariance > 0) {
    summary = `الجدول الحالي متأخر بمقدار ${projectFinishVariance} يوم مقارنة بخط الأساس المعتمد (${baselineName}). يوجد ${modifiedCount} نشاط معدل.`;
  } else if (projectFinishVariance < 0) {
    summary = `الجدول الحالي متقدم بمقدار ${Math.abs(projectFinishVariance)} يوم مقارنة بخط الأساس المعتمد (${baselineName}).`;
  } else {
    summary = `تاريخ إنجاز المشروع مطابق تماماً لموعد خط الأساس المعتمد (${baselineName}).`;
  }

  return {
    baselineName,
    currentScheduleName,
    totalActivitiesCount: currentActivities.length,
    addedCount,
    deletedCount,
    modifiedCount,
    criticalityShiftCount: critShiftCount,
    projectFinishVarianceDays: projectFinishVariance,
    activities: diffItems,
    summary,
  };
}

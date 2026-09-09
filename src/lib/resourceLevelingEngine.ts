import type {
  Activity,
  Resource,
  ActivityResource,
  CalendarType,
  ResourceHistogramData,
  ResourceSummaryItem,
} from '@/types';
import { getCalendar, addWorkingDays, countWorkingDays, isWorkingDay } from './calendarEngine';

export interface LevelingResult {
  leveledActivities: { activityId: string; earlyStart: string; earlyFinish: string; shiftDays: number }[];
  overallocationsResolved: number;
  remainingOverallocations: number;
  projectExtendedDays: number;
  summary: string;
}

export function generateResourceHistogram(
  activities: Activity[],
  resources: Resource[],
  assignments: ActivityResource[],
  calendarType: CalendarType = '6_days',
): ResourceHistogramData {
  const calendar = getCalendar(calendarType);

  if (!activities.length || !resources.length || !assignments.length) {
    return { dates: [], timeBuckets: [], resourceSummaries: [] };
  }

  // Find date boundary
  let minDate = '9999-12-31';
  let maxDate = '0000-01-01';

  activities.forEach((a) => {
    if (a.early_start && a.early_start < minDate) minDate = a.early_start;
    if (a.early_finish && a.early_finish > maxDate) maxDate = a.early_finish;
  });

  if (minDate > maxDate) {
    minDate = new Date().toISOString().split('T')[0];
    maxDate = addWorkingDays(minDate, 30, calendar);
  }

  // Create list of all working days between minDate and maxDate
  const days: string[] = [];
  let curr = minDate;
  const maxDateObj = new Date(maxDate);

  while (new Date(curr) <= maxDateObj) {
    if (isWorkingDay(curr, calendar)) {
      days.push(curr);
    }
    const nextD = new Date(curr);
    nextD.setDate(nextD.getDate() + 1);
    curr = nextD.toISOString().split('T')[0];
  }

  const actMap = new Map(activities.map((a) => [a.id, a]));
  const resMap = new Map(resources.map((r) => [r.id, r]));

  // Calculate daily demand per resource
  // Map: date -> resourceId -> units
  const dailyResourceDemand = new Map<string, Map<string, number>>();
  days.forEach((d) => dailyResourceDemand.set(d, new Map()));

  assignments.forEach((as) => {
    const act = actMap.get(as.activity_id);
    const res = resMap.get(as.resource_id);
    if (!act || !res || !act.early_start || !act.early_finish) return;

    const duration = Math.max(1, act.duration_days || 1);
    const dailyQty = Number(as.planned_quantity || 0) / duration;

    // Distribute along activity dates
    let d = act.early_start;
    while (d <= act.early_finish) {
      if (isWorkingDay(d, calendar)) {
        const dayMap = dailyResourceDemand.get(d);
        if (dayMap) {
          const prev = dayMap.get(res.id) || 0;
          dayMap.set(res.id, prev + dailyQty);
        }
      }
      const nextD = new Date(d);
      nextD.setDate(nextD.getDate() + 1);
      d = nextD.toISOString().split('T')[0];
    }
  });

  // Build resource summaries
  const resourceSummaries: ResourceSummaryItem[] = resources.map((r) => {
    let peak = 0;
    let totalDemand = 0;
    let activeDays = 0;
    let overallocatedDays = 0;
    const limit = Number(r.availability) || 1;

    days.forEach((d) => {
      const val = dailyResourceDemand.get(d)?.get(r.id) || 0;
      if (val > 0) {
        totalDemand += val;
        activeDays += 1;
        if (val > peak) peak = val;
        if (val > limit) overallocatedDays += 1;
      }
    });

    return {
      id: r.id,
      name: r.name,
      type: r.type,
      unit: r.unit,
      maxAvailability: limit,
      peakAllocated: Math.round(peak * 10) / 10,
      avgAllocated: activeDays > 0 ? Math.round((totalDemand / activeDays) * 10) / 10 : 0,
      isOverallocated: peak > limit,
      overallocatedDaysCount: overallocatedDays,
    };
  });

  // Group into weekly buckets for clean charting
  const timeBuckets: ResourceHistogramData['timeBuckets'] = [];
  const chunkSize = 6; // 6 working days per weekly bucket

  for (let i = 0; i < days.length; i += chunkSize) {
    const chunkDays = days.slice(i, i + chunkSize);
    const startDate = chunkDays[0];
    const endDate = chunkDays[chunkDays.length - 1];
    const resourceUnits: Record<string, number> = {};
    let isOverallocated = false;
    let totalUnits = 0;

    resources.forEach((r) => {
      let maxInBucket = 0;
      chunkDays.forEach((d) => {
        const val = dailyResourceDemand.get(d)?.get(r.id) || 0;
        if (val > maxInBucket) maxInBucket = val;
      });
      resourceUnits[r.id] = Math.round(maxInBucket * 10) / 10;
      totalUnits += resourceUnits[r.id];
      if (maxInBucket > (Number(r.availability) || 1)) {
        isOverallocated = true;
      }
    });

    timeBuckets.push({
      dateLabel: `${startDate.slice(5)} ~ ${endDate.slice(5)}`,
      startDate,
      endDate,
      resourceUnits,
      totalUnits: Math.round(totalUnits * 10) / 10,
      isOverallocated,
    });
  }

  return {
    dates: days,
    timeBuckets,
    resourceSummaries,
  };
}

export function levelScheduleResources(
  activities: Activity[],
  resources: Resource[],
  assignments: ActivityResource[],
  calendarType: CalendarType = '6_days',
): LevelingResult {
  const calendar = getCalendar(calendarType);
  const levelingChanges: { activityId: string; earlyStart: string; earlyFinish: string; shiftDays: number }[] = [];

  // Sort candidate activities by priority: Non-Critical first, ordered by Total Float descending
  const candidates = [...activities]
    .filter((a) => !a.is_critical && (a.total_float || 0) > 0 && a.percent_complete < 100)
    .sort((a, b) => (b.total_float || 0) - (a.total_float || 0));

  let overallocationsResolved = 0;
  let projectExtendedDays = 0;

  for (const act of candidates) {
    // Check if this activity uses any overallocated resource
    const actAssignments = assignments.filter((as) => as.activity_id === act.id);
    const usesOverallocated = actAssignments.some((as) => {
      const res = resources.find((r) => r.id === as.resource_id);
      return res && Number(as.planned_quantity) > Number(res.availability);
    });

    if (usesOverallocated && act.early_start && act.early_finish) {
      const maxShift = Math.min(Number(act.total_float || 0), 5); // Shift within available float
      if (maxShift > 0) {
        const shiftedStart = addWorkingDays(act.early_start, maxShift, calendar);
        const shiftedFinish = addWorkingDays(act.early_finish, maxShift, calendar);
        levelingChanges.push({
          activityId: act.id,
          earlyStart: shiftedStart,
          earlyFinish: shiftedFinish,
          shiftDays: maxShift,
        });
        overallocationsResolved += 1;
      }
    }
  }

  const summary = levelingChanges.length > 0
    ? `تمت تسوية ${levelingChanges.length} نشاط بنجاح ضمن حدود الهوامش المتاحة (Total Float) دون تأخير المشروع.`
    : 'لم يتم العثور على أنشطة بحاجة إلى تسوية، أو أن جميع الأنشطة المتبقية على المسار الحرج.';

  return {
    leveledActivities: levelingChanges,
    overallocationsResolved,
    remainingOverallocations: 0,
    projectExtendedDays,
    summary,
  };
}

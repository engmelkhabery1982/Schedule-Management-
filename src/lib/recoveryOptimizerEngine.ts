import type {
  Activity,
  ActivityLink,
  CalendarType,
  RecoveryEvaluatedScenario,
  RecoveryOption,
  RecoveryPlanResult,
} from '@/types';
import { calculateCpm, type CpmOptions } from './cpmEngine';
import { countWorkingDays, getCalendar } from './calendarEngine';

export interface RecoveryOptionInput {
  /** Explicit user-entered remaining-duration reduction for crashing / extra crew. */
  durationReductionDays?: number | null;
  /** Explicit user-entered incremental premium. Blank means cost is unknown. */
  incrementalCostSar?: number | null;
}

export interface RecoveryPlanConfig {
  targetFinishDate?: string | null;
  cpmOptions?: CpmOptions;
  selectedOptions?: Record<string, boolean>;
  optionInputs?: Record<string, RecoveryOptionInput>;
}

export interface RecoveryActivityPatch {
  id: string;
  values: {
    duration_days?: number;
    remaining_duration_days?: number | null;
  };
}

export interface RecoveryLinkPatch {
  id: string;
  values: { link_type: string };
}

export interface RecoveryScenarioPatches {
  activities: RecoveryActivityPatch[];
  links: RecoveryLinkPatch[];
}

function positiveIntegerOrNull(value: number | null | undefined, maximum: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0 || maximum <= 0) {
    return null;
  }
  const normalized = Math.min(Math.floor(value), maximum);
  return normalized > 0 ? normalized : null;
}

function nonnegativeCostOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function recoveredWorkingDayDelta(currentFinish: string | null, scenarioFinish: string | null, calendarType: CalendarType): number | null {
  if (!currentFinish || !scenarioFinish) return null;
  if (scenarioFinish >= currentFinish) return 0;
  return Math.max(0, countWorkingDays(scenarioFinish, currentFinish, getCalendar(calendarType)) - 1);
}

function requiredWorkingDayCompression(targetFinish: string | null, currentFinish: string | null, calendarType: CalendarType): number | null {
  if (!targetFinish || !currentFinish) return null;
  if (currentFinish <= targetFinish) return 0;
  return Math.max(0, countWorkingDays(targetFinish, currentFinish, getCalendar(calendarType)) - 1);
}

/**
 * Evaluate recovery actions against independent in-memory clones and the canonical CPM engine.
 * Duration reductions and incremental premiums are explicit user assumptions; finish dates and
 * recovered working days always come from current/scenario CPM and the project calendar.
 */
export function generateScheduleRecoveryPlan(
  activities: Activity[],
  links: ActivityLink[],
  config: RecoveryPlanConfig = {},
): RecoveryPlanResult {
  const cpmOptions: CpmOptions = config.cpmOptions || { calendarType: '6_days' };
  const calendarType: CalendarType = cpmOptions.calendarType || '6_days';
  const targetFinishDate = config.targetFinishDate?.trim() || null;
  const currentCpm = calculateCpm(activities, links, cpmOptions);
  const currentFinishDate = currentCpm.cycle ? null : currentCpm.projectEarlyFinish || null;
  const currentResultById = new Map(currentCpm.results.map((result) => [result.activityId, result]));
  const currentCriticalIds = new Set(
    currentCpm.results.filter((result) => result.isCritical).map((result) => result.activityId),
  );
  const activitiesById = new Map(activities.map((activity) => [activity.id, activity]));
  const options: RecoveryOption[] = [];

  const makeOptionInput = (id: string, maxReductionDays: number | null) => {
    const input = config.optionInputs?.[id];
    const durationReductionDays = maxReductionDays === null
      ? null
      : positiveIntegerOrNull(input?.durationReductionDays, maxReductionDays);
    const additionalCost = nonnegativeCostOrNull(input?.incrementalCostSar);
    return { durationReductionDays, additionalCost };
  };

  if (!currentCpm.cycle) {
    for (const activity of activities) {
      const cpmResult = currentResultById.get(activity.id);
      if (
        !cpmResult?.isCritical
        || activity.is_milestone
        || activity.activity_type === 'start_milestone'
        || activity.activity_type === 'finish_milestone'
        || activity.percent_complete >= 100
        || Boolean(activity.actual_finish)
      ) continue;

      const maxDurationReductionDays = Math.max(0, Math.floor(cpmResult.remainingDuration) - 1);
      if (maxDurationReductionDays <= 0) continue;

      const durationActions: Pick<RecoveryOption, 'strategy' | 'strategyAr' | 'description'>[] = [
        {
          strategy: 'crashing',
          strategyAr: 'ضغط المدة / وردية إضافية (Crashing)',
          description: 'أدخل تخفيضاً معتمداً للمدة المتبقية؛ ستُعاد جدولة الشبكة كاملة عبر CPM.',
        },
        {
          strategy: 'crew_doubling',
          strategyAr: 'طاقم إضافي (Extra Crew)',
          description: 'أدخل تخفيضاً للمدة المتبقية الناتج عن الطاقم الإضافي؛ لا تُفترض إنتاجية تلقائياً.',
        },
      ];

      for (const action of durationActions) {
        const id = `recovery-${action.strategy}-${activity.id}`;
        const input = makeOptionInput(id, maxDurationReductionDays);
        options.push({
          id,
          activityId: activity.id,
          activityCode: activity.code,
          activityName: activity.name,
          strategy: action.strategy,
          strategyAr: action.strategyAr,
          affectedActivityIds: [activity.id],
          affectedLinkIds: [],
          linkId: null,
          fromLinkType: null,
          toLinkType: null,
          durationReductionDays: input.durationReductionDays,
          maxDurationReductionDays,
          additionalCost: input.additionalCost,
          selected: config.selectedOptions?.[id] === true,
          isApplicable: input.durationReductionDays !== null,
          appliedDurationReductionDays: null,
          description: action.description,
        });
      }
    }

    for (const link of links) {
      if (
        String(link.link_type).toUpperCase() !== 'FS'
        || !currentCriticalIds.has(link.predecessor_id)
        || !currentCriticalIds.has(link.successor_id)
      ) continue;
      const predecessor = activitiesById.get(link.predecessor_id);
      const successor = activitiesById.get(link.successor_id);
      if (!predecessor || !successor) continue;

      const id = `recovery-fast-track-${link.id}`;
      const input = makeOptionInput(id, null);
      options.push({
        id,
        activityId: successor.id,
        activityCode: successor.code,
        activityName: successor.name,
        strategy: 'fast_tracking',
        strategyAr: 'تداخل الأنشطة (FS → SS)',
        affectedActivityIds: [predecessor.id, successor.id],
        affectedLinkIds: [link.id],
        linkId: link.id,
        fromLinkType: link.link_type,
        toLinkType: 'SS',
        durationReductionDays: null,
        maxDurationReductionDays: null,
        additionalCost: input.additionalCost,
        selected: config.selectedOptions?.[id] === true,
        isApplicable: true,
        appliedDurationReductionDays: null,
        description: `تغيير العلاقة الفعلية من FS إلى SS مع الإبقاء على الـ Lag المسجل (${Number(link.lag_days || 0)} يوم).`,
      });
    }
  }

  // Build selected changes without altering the inputs. If two duration strategies are selected
  // for one activity, the remaining duration can never be reduced below one working day.
  const remainingReductionBudget = new Map<string, number>();
  for (const activity of activities) {
    const remaining = currentResultById.get(activity.id)?.remainingDuration || 0;
    remainingReductionBudget.set(activity.id, Math.max(0, Math.floor(remaining) - 1));
  }

  const durationReductionByActivity = new Map<string, number>();
  const evaluatedScenario: RecoveryEvaluatedScenario = {
    activities: activities.map((activity) => ({ ...activity })),
    links: links.map((link) => ({ ...link })),
    selectedOptionIds: [],
  };
  const scenarioLinkById = new Map(evaluatedScenario.links.map((link) => [link.id, link]));

  for (const option of options) {
    if (!option.selected || !option.isApplicable) continue;

    if (option.strategy === 'fast_tracking') {
      const scenarioLink = option.linkId ? scenarioLinkById.get(option.linkId) : undefined;
      if (scenarioLink && String(scenarioLink.link_type).toUpperCase() === 'FS') {
        scenarioLink.link_type = 'SS';
        evaluatedScenario.selectedOptionIds.push(option.id);
      }
      continue;
    }

    const requestedReduction = option.durationReductionDays || 0;
    const remainingBudget = remainingReductionBudget.get(option.activityId) || 0;
    const appliedReduction = Math.min(requestedReduction, remainingBudget);
    if (appliedReduction <= 0) continue;
    option.appliedDurationReductionDays = appliedReduction;
    remainingReductionBudget.set(option.activityId, remainingBudget - appliedReduction);
    durationReductionByActivity.set(
      option.activityId,
      (durationReductionByActivity.get(option.activityId) || 0) + appliedReduction,
    );
    evaluatedScenario.selectedOptionIds.push(option.id);
  }

  for (const [activityId, reductionDays] of durationReductionByActivity) {
    const scenarioActivity = evaluatedScenario.activities.find((activity) => activity.id === activityId);
    const originalActivity = activitiesById.get(activityId);
    const currentRemaining = currentResultById.get(activityId)?.remainingDuration;
    if (!scenarioActivity || !originalActivity || currentRemaining === undefined) continue;

    const nextRemaining = Math.max(1, Math.floor(currentRemaining) - reductionDays);
    const isCompleted = originalActivity.percent_complete >= 100 || Boolean(originalActivity.actual_finish);
    if (isCompleted) continue;

    const isStarted = Boolean(originalActivity.actual_start) || originalActivity.percent_complete > 0;
    if (isStarted) {
      // CPM consumes this field for started work; original duration / progress remain untouched.
      scenarioActivity.remaining_duration_days = nextRemaining;
    } else {
      // CPM uses duration_days as the remaining duration for not-yet-started work.
      scenarioActivity.duration_days = nextRemaining;
    }
  }

  const scenarioCpm = calculateCpm(evaluatedScenario.activities, evaluatedScenario.links, cpmOptions);
  const scenarioFinishDate = scenarioCpm.cycle ? null : scenarioCpm.projectEarlyFinish || null;
  const recoveredWorkingDays = recoveredWorkingDayDelta(currentFinishDate, scenarioFinishDate, calendarType);
  const requiredCompressionDays = requiredWorkingDayCompression(targetFinishDate, currentFinishDate, calendarType);
  // The target gap is measured from the scenario CPM finish itself, so it also stays correct if a
  // selected relationship change fails to improve (or worsens) the schedule.
  const remainingGapDays = requiredWorkingDayCompression(targetFinishDate, scenarioFinishDate, calendarType);
  const appliedOptions = options.filter((option) => evaluatedScenario.selectedOptionIds.includes(option.id));
  const incrementalCostSar = appliedOptions.length === 0
    ? null
    : appliedOptions.every((option) => option.additionalCost !== null)
      ? appliedOptions.reduce((sum, option) => sum + (option.additionalCost || 0), 0)
      : null;

  let recoveryStatus: RecoveryPlanResult['recoveryStatus'] = 'not_measured';
  if (!currentFinishDate || !scenarioFinishDate || recoveredWorkingDays === null) {
    recoveryStatus = 'not_measured';
  } else if (evaluatedScenario.selectedOptionIds.length === 0) {
    recoveryStatus = 'no_actions_selected';
  } else if (recoveredWorkingDays <= 0) {
    recoveryStatus = 'no_improvement';
  } else if (requiredCompressionDays === null) {
    recoveryStatus = 'improved';
  } else if (remainingGapDays === 0) {
    recoveryStatus = 'target_achieved';
  } else {
    recoveryStatus = 'improved_with_gap';
  }

  let summary: string;
  if (currentCpm.cycle) {
    summary = `تعذر تقييم الاستدراك: توجد حلقة علاقات حالية (${currentCpm.cycle.join(' ← ')}). لم تُجرَ أي كتابة على الجدول.`;
  } else if (scenarioCpm.cycle) {
    summary = `تعذر تقييم السيناريو: رصد CPM حلقة علاقات (${scenarioCpm.cycle.join(' ← ')}). لا يمكن تطبيق هذا السيناريو.`;
  } else if (!currentFinishDate || !scenarioFinishDate) {
    summary = 'لا تتوفر تواريخ CPM كافية لقياس نهاية المشروع أو أيام الاسترداد.';
  } else if (evaluatedScenario.selectedOptionIds.length === 0) {
    summary = 'لم يُقيّم أي إجراء محدد بعد. أدخل افتراض تخفيض المدة عند الحاجة؛ التحليل لا يكتب إلى الجدول.';
  } else if (recoveredWorkingDays === 0) {
    const gapText = remainingGapDays === null ? '' : ` الفجوة المتبقية عن الهدف ${remainingGapDays} يوم عمل.`;
    summary = `لم يُحسّن السيناريو تاريخ نهاية CPM (${currentFinishDate} → ${scenarioFinishDate})؛ الاسترداد الفعلي 0 يوم عمل.${gapText}`;
  } else if (requiredCompressionDays === null) {
    summary = `حسّن السيناريو نهاية CPM من ${currentFinishDate} إلى ${scenarioFinishDate}، باسترداد فعلي قدره ${recoveredWorkingDays} يوم عمل. لم يُدخل تاريخ مستهدف.`;
  } else if (remainingGapDays === 0) {
    summary = `حقق السيناريو تاريخ الهدف؛ نهاية CPM ${scenarioFinishDate}، والاسترداد الفعلي ${recoveredWorkingDays} يوم عمل.`;
  } else {
    summary = `نهاية CPM الحالية ${currentFinishDate}، ونهاية السيناريو ${scenarioFinishDate}؛ الاسترداد الفعلي ${recoveredWorkingDays} يوم عمل. لا يزال الهدف غير محقق، والفجوة المتبقية ${remainingGapDays} يوم عمل.`;
  }

  return {
    targetFinishDate,
    currentFinishDate,
    requiredCompressionDays,
    recoveredWorkingDays,
    incrementalCostSar,
    scenarioFinishDate,
    remainingGapDays,
    options,
    recoveryStatus,
    currentCycle: currentCpm.cycle,
    scenarioCycle: scenarioCpm.cycle,
    evaluatedScenario,
    summary,
  };
}

/**
 * Produce only the schedule assumptions changed by the evaluated scenario. CPM output fields are
 * intentionally excluded here; Apply saves those separately after one canonical CPM run.
 */
export function buildRecoveryScenarioPatches(
  baselineActivities: Activity[],
  baselineLinks: ActivityLink[],
  scenario: RecoveryEvaluatedScenario,
): RecoveryScenarioPatches {
  if (scenario.selectedOptionIds.length === 0) return { activities: [], links: [] };

  const baselineActivityById = new Map(baselineActivities.map((activity) => [activity.id, activity]));
  const activityPatches: RecoveryActivityPatch[] = [];
  for (const scenarioActivity of scenario.activities) {
    const baseline = baselineActivityById.get(scenarioActivity.id);
    if (!baseline) continue;
    const values: RecoveryActivityPatch['values'] = {};
    if (scenarioActivity.duration_days !== baseline.duration_days) {
      values.duration_days = scenarioActivity.duration_days;
    }
    if (scenarioActivity.remaining_duration_days !== baseline.remaining_duration_days) {
      values.remaining_duration_days = scenarioActivity.remaining_duration_days ?? null;
    }
    if (Object.keys(values).length > 0) activityPatches.push({ id: scenarioActivity.id, values });
  }

  const baselineLinkById = new Map(baselineLinks.map((link) => [link.id, link]));
  const linkPatches: RecoveryLinkPatch[] = [];
  for (const scenarioLink of scenario.links) {
    const baseline = baselineLinkById.get(scenarioLink.id);
    if (!baseline || scenarioLink.link_type === baseline.link_type) continue;
    linkPatches.push({ id: scenarioLink.id, values: { link_type: scenarioLink.link_type } });
  }

  return { activities: activityPatches, links: linkPatches };
}

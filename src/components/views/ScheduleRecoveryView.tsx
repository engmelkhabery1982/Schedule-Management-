import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  ActivityLink,
  P6Calendar,
  RecoveryPlanResult,
} from '@/types';
import {
  buildRecoveryScenarioPatches,
  generateScheduleRecoveryPlan,
  type RecoveryOptionInput,
} from '@/lib/recoveryOptimizerEngine';
import { calculateCpm, type CpmOptions } from '@/lib/cpmEngine';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import { assertDbWriteOk } from '@/lib/supabaseErrors';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  DollarSign,
  FastForward,
  Sliders,
  Zap,
} from 'lucide-react';

interface ScheduleRecoveryViewProps {
  project: Project | null;
}

function parseNumericInput(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDays(value: number | null): string {
  return value === null ? 'N/A' : `${value} يوم عمل`;
}

function formatCost(value: number | null): string {
  return value === null ? 'N/A' : `${value.toLocaleString()} SAR`;
}

export default function ScheduleRecoveryView({ project }: ScheduleRecoveryViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [calendars, setCalendars] = useState<P6Calendar[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetDate, setTargetDate] = useState<string>(project?.end_date || '');
  const [selectedOptionsMap, setSelectedOptionsMap] = useState<Record<string, boolean>>({});
  const [optionInputs, setOptionInputs] = useState<Record<string, RecoveryOptionInput>>({});
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'success' | 'info' | 'error'>('info');
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    setSelectedOptionsMap({});
    setOptionInputs({});
    setMessage('');
    if (project) {
      setTargetDate(project.end_date || '');
      void loadData();
    } else {
      setActivities([]);
      setLinks([]);
      setCalendars([]);
      setLoading(false);
    }
  }, [project]);

  async function loadData(): Promise<boolean> {
    if (!project) return false;
    setLoading(true);
    const [actRes, linkRes, calendarRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('calendars').select('*').eq('project_id', project.id),
    ]);

    const queryError = actRes.error || linkRes.error || calendarRes.error;
    if (queryError) {
      setActivities([]);
      setLinks([]);
      setCalendars([]);
      setMessage(`تعذر تحميل بيانات تحليل الاستدراك: ${queryError.message}`);
      setMessageTone('error');
      setLoading(false);
      return false;
    }

    setActivities((actRes.data || []) as Activity[]);
    setLinks((linkRes.data || []) as ActivityLink[]);
    setCalendars((calendarRes.data || []) as P6Calendar[]);
    setLoading(false);
    return true;
  }

  const cpmOptions = useMemo<CpmOptions>(() => ({
    calendarType: project?.calendar_type || '6_days',
    dataDate: project?.data_date || DEFAULT_DATA_DATE,
    statusLogic: project?.status_logic || 'retained_logic',
    calculateDrag: true,
    calendars,
  }), [project?.calendar_type, project?.data_date, project?.status_logic, calendars]);

  const plan: RecoveryPlanResult = useMemo(() => generateScheduleRecoveryPlan(
    activities,
    links,
    {
      targetFinishDate: targetDate || null,
      cpmOptions,
      selectedOptions: selectedOptionsMap,
      optionInputs,
    },
  ), [activities, links, targetDate, cpmOptions, selectedOptionsMap, optionInputs]);

  function toggleOption(optionId: string, selected: boolean) {
    const option = plan.options.find((candidate) => candidate.id === optionId);
    setSelectedOptionsMap((previous) => {
      const next = { ...previous, [optionId]: selected };
      // A single activity cannot receive two independent duration-reduction strategies in one plan.
      if (selected && option && option.strategy !== 'fast_tracking') {
        for (const sibling of plan.options) {
          if (sibling.activityId === option.activityId && sibling.strategy !== 'fast_tracking' && sibling.id !== optionId) {
            next[sibling.id] = false;
          }
        }
      }
      return next;
    });
  }

  function updateOptionInput(optionId: string, field: keyof RecoveryOptionInput, value: string) {
    const parsed = parseNumericInput(value);
    setOptionInputs((previous) => ({
      ...previous,
      [optionId]: { ...previous[optionId], [field]: parsed },
    }));
  }

  async function handleApplyPlan() {
    if (!project || plan.evaluatedScenario.selectedOptionIds.length === 0 || plan.scenarioCycle) return;
    setIsApplying(true);
    setMessage('');

    try {
      const patches = buildRecoveryScenarioPatches(activities, links, plan.evaluatedScenario);
      if (patches.activities.length === 0 && patches.links.length === 0) {
        throw new Error('لا توجد تغييرات قابلة للحفظ في السيناريو المُقيّم.');
      }

      // Calculate once from the exact evaluated clones, then send assumptions, relationships,
      // and this complete CPM result through one PostgreSQL RPC transaction. Any failure raises
      // from the function and rolls back every row touched by this Apply.
      const calculation = calculateCpm(plan.evaluatedScenario.activities, plan.evaluatedScenario.links, cpmOptions);
      if (calculation.cycle) {
        throw new Error(`تعذر حفظ نتائج CPM: رُصدت حلقة علاقات (${calculation.cycle.join(' ← ')}).`);
      }
      const cpmResults = calculation.results.map((result) => ({
        activityId: result.activityId,
        earlyStart: result.earlyStart,
        earlyFinish: result.earlyFinish,
        lateStart: result.lateStart,
        lateFinish: result.lateFinish,
        totalFloat: result.totalFloat,
        freeFloat: result.freeFloat,
        isCritical: result.isCritical,
        activityDrag: result.activityDrag,
      }));
      assertDbWriteOk(
        await supabase.rpc('apply_schedule_recovery_scenario', {
          p_project_id: project.id,
          p_activity_patches: patches.activities,
          p_link_patches: patches.links,
          p_cpm_results: cpmResults,
        }),
        'تطبيق سيناريو الاسترداد وحفظ نتائج CPM ذرياً',
      );

      if (!await loadData()) return;
      setSelectedOptionsMap({});
      setOptionInputs({});
      setMessage(plan.recoveredWorkingDays === 0
        ? `تم حفظ السيناريو وإعادة حساب CPM، لكن تاريخ النهاية لم يتحسن؛ لا تُسجّل أيام استرداد. نهاية CPM: ${plan.scenarioFinishDate || 'N/A'}.`
        : `تم حفظ السيناريو المُقيّم وإعادة حساب CPM مرة واحدة. الاسترداد الفعلي: ${formatDays(plan.recoveredWorkingDays)}. الفجوة المتبقية: ${formatDays(plan.remainingGapDays)}.`);
      setMessageTone(plan.recoveredWorkingDays === 0 ? 'info' : 'success');
    } catch (error: unknown) {
      setMessage(`تعذر تطبيق سيناريو الاسترداد: ${(error as Error)?.message || 'خطأ غير معروف'}`);
      setMessageTone('error');
    } finally {
      setIsApplying(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  const statusPresentation = {
    not_measured: { label: 'غير قابل للقياس', className: 'bg-slate-50 border-slate-200 text-slate-700' },
    no_actions_selected: { label: 'لا توجد إجراءات مطبقة في التحليل', className: 'bg-slate-50 border-slate-200 text-slate-700' },
    no_improvement: { label: 'لا يوجد تحسن فعلي في نهاية CPM', className: 'bg-amber-50 border-amber-200 text-amber-900' },
    improved: { label: 'تحسن مقاس عبر CPM', className: 'bg-emerald-50 border-emerald-200 text-emerald-900' },
    improved_with_gap: { label: 'تحسن مع فجوة متبقية', className: 'bg-amber-50 border-amber-200 text-amber-900' },
    target_achieved: { label: 'موعد الهدف متحقق في السيناريو', className: 'bg-emerald-50 border-emerald-200 text-emerald-900' },
  }[plan.recoveryStatus];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <FastForward className="text-blue-600" size={24} />
            تحليل استرداد الجدول (Schedule Recovery)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            يقيّم كل اختيار على نسخة مؤقتة من الشبكة وبإعادة حساب CPM؛ لا تُكتب أي تغييرات قبل الضغط على Apply.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs">
            <Calendar size={14} className="text-blue-600" />
            <span className="text-slate-600 font-semibold">تاريخ الهدف:</span>
            <input
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
              className="bg-transparent font-bold text-slate-900 outline-none cursor-pointer"
            />
          </label>
          <button
            onClick={() => void handleApplyPlan()}
            disabled={isApplying || plan.evaluatedScenario.selectedOptionIds.length === 0 || Boolean(plan.scenarioCycle)}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-4 py-2 rounded-lg text-xs font-bold shadow-md shadow-emerald-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Zap size={14} className={isApplying ? 'animate-spin' : ''} />
            <span>تطبيق السيناريو المُقيّم وإعادة حساب CPM</span>
          </button>
        </div>
      </div>

      {message && (
        <div className={`p-3.5 border rounded-lg text-xs flex items-center justify-between ${
          messageTone === 'error' ? 'bg-rose-50 border-rose-200 text-rose-800'
            : messageTone === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-slate-50 border-slate-200 text-slate-800'
        }`}>
          <span className="font-semibold">{message}</span>
          <button onClick={() => setMessage('')} className="font-bold text-sm opacity-70 hover:opacity-100">×</button>
        </div>
      )}

      <div className={`p-4 border rounded-xl flex items-start gap-3 ${statusPresentation.className}`}>
        {plan.recoveryStatus === 'target_achieved' || plan.recoveryStatus === 'improved'
          ? <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
          : <AlertTriangle size={18} className="mt-0.5 shrink-0" />}
        <div>
          <div className="font-bold text-sm">{statusPresentation.label}</div>
          <p className="text-xs mt-1">{plan.summary}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">نهاية CPM الحالية</span>
          <div className="text-lg font-mono font-bold text-slate-800 mt-1">{plan.currentFinishDate || 'N/A'}</div>
          <span className="text-[10px] text-slate-400">من الحساب الأساسي للشبكة</span>
        </div>
        <div className="bg-white p-4 rounded-xl border border-blue-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">نهاية CPM للسيناريو</span>
          <div className="text-lg font-mono font-bold text-blue-700 mt-1">{plan.scenarioFinishDate || 'N/A'}</div>
          <span className="text-[10px] text-slate-400">من إعادة CPM على النسخة المؤقتة</span>
        </div>
        <div className="bg-white p-4 rounded-xl border border-emerald-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">الاسترداد الفعلي</span>
          <div className="text-2xl font-black text-emerald-700 mt-1">{formatDays(plan.recoveredWorkingDays)}</div>
          <span className="text-[10px] text-slate-400">فرق تاريخي النهاية على تقويم المشروع</span>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">التكلفة الإضافية</span>
          <div className="text-xl font-black text-slate-800 mt-1 flex items-center gap-1">
            <DollarSign size={17} /> {formatCost(plan.incrementalCostSar)}
          </div>
          <span className="text-[10px] text-slate-400">N/A حتى إدخال تكلفة/علاوة موثقة لكل إجراء</span>
        </div>
        <div className="bg-white p-4 rounded-xl border border-amber-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">الفجوة المتبقية عن الهدف</span>
          <div className="text-xl font-black text-amber-700 mt-1">{formatDays(plan.remainingGapDays)}</div>
          <span className="text-[10px] text-slate-400">فرق أيام عمل من نتيجة CPM، لا من جمع الافتراضات</span>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
              <Sliders size={18} className="text-blue-600" />
              <span>إجراءات الاسترداد والأنشطة/العلاقات المتأثرة</span>
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              اختر إجراءً، أدخل افتراض المدة والتكلفة الإضافية إن توفرت، ثم راجع تاريخ CPM والفجوة قبل التطبيق.
            </p>
          </div>
          <span className="text-xs text-slate-500">{plan.options.length} إجراء قابل للتقييم</span>
        </div>

        {plan.options.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">لا توجد إجراءات على الأنشطة/العلاقات الحرجة الحالية قابلة للتقييم.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-xs">
              <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-semibold">
                <tr>
                  <th className="p-3 text-center">اختيار</th>
                  <th className="p-3 text-right">المتأثر</th>
                  <th className="p-3 text-right">الإجراء</th>
                  <th className="p-3 text-right">افتراض السيناريو</th>
                  <th className="p-3 text-right">التكلفة الإضافية المدخلة (SAR)</th>
                  <th className="p-3 text-right">آلية التقييم</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {plan.options.map((option) => {
                  const affectedActivities = option.affectedActivityIds
                    .map((id) => activities.find((activity) => activity.id === id))
                    .filter((activity): activity is Activity => Boolean(activity));
                  const link = option.linkId ? links.find((candidate) => candidate.id === option.linkId) : null;
                  const predecessor = link ? activities.find((activity) => activity.id === link.predecessor_id) : null;
                  const successor = link ? activities.find((activity) => activity.id === link.successor_id) : null;
                  const currentInput = optionInputs[option.id];
                  const needsDurationInput = option.strategy !== 'fast_tracking';

                  return (
                    <tr key={option.id} className={option.selected ? 'bg-blue-50/40' : 'hover:bg-slate-50'}>
                      <td className="p-3 text-center align-top">
                        <input
                          type="checkbox"
                          checked={option.selected}
                          onChange={(event) => toggleOption(option.id, event.target.checked)}
                          aria-label={`اختيار ${option.strategyAr} للنشاط ${option.activityCode}`}
                          className="w-4 h-4 text-blue-600 rounded cursor-pointer"
                        />
                      </td>
                      <td className="p-3 align-top min-w-[230px]">
                        <div className="font-semibold text-slate-800">
                          {affectedActivities.map((activity) => `${activity.code} — ${activity.name}`).join(' / ') || option.activityName}
                        </div>
                        {link && predecessor && successor && (
                          <div className="mt-1 text-[10px] text-slate-500">
                            علاقة {predecessor.code} → {successor.code} (ID: {link.id})
                          </div>
                        )}
                      </td>
                      <td className="p-3 align-top">
                        <span className="px-2 py-1 rounded font-bold text-[10px] bg-slate-100 text-slate-800 border">
                          {option.strategyAr}
                        </span>
                      </td>
                      <td className="p-3 align-top min-w-[190px]">
                        {needsDurationInput ? (
                          <>
                            <label className="block text-[10px] text-slate-500 mb-1">تخفيض المدة المتبقية (أيام عمل)</label>
                            <input
                              type="number"
                              min={1}
                              max={option.maxDurationReductionDays || undefined}
                              step={1}
                              value={currentInput?.durationReductionDays ?? ''}
                              onChange={(event) => updateOptionInput(option.id, 'durationReductionDays', event.target.value)}
                              className="w-28 border border-slate-300 rounded px-2 py-1 font-mono"
                              aria-label={`تخفيض المدة المتبقية لـ ${option.activityCode}`}
                            />
                            <div className="text-[10px] text-slate-400 mt-1">الحد الأقصى: {option.maxDurationReductionDays} يوم عمل</div>
                            {option.selected && !option.isApplicable && (
                              <div className="text-[10px] text-rose-600 mt-1">أدخل تخفيضاً صحيحاً لتقييم الإجراء.</div>
                            )}
                          </>
                        ) : (
                          <div className="font-mono font-bold text-blue-700">
                            {option.fromLinkType} → {option.toLinkType}; Lag محفوظ كما هو
                          </div>
                        )}
                      </td>
                      <td className="p-3 align-top min-w-[190px]">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={currentInput?.incrementalCostSar ?? ''}
                          onChange={(event) => updateOptionInput(option.id, 'incrementalCostSar', event.target.value)}
                          placeholder="N/A"
                          className="w-32 border border-slate-300 rounded px-2 py-1 font-mono"
                          aria-label={`التكلفة الإضافية المدخلة للإجراء ${option.activityCode}`}
                        />
                        <div className="text-[10px] text-slate-400 mt-1">فارغ = N/A؛ أدخل العلاوة/التكلفة الإضافية المعتمدة.</div>
                      </td>
                      <td className="p-3 align-top text-slate-600 max-w-sm">
                        {option.description}
                        {option.appliedDurationReductionDays !== null && (
                          <div className="mt-1 font-semibold text-emerald-700">
                            التخفيض المستخدم في السيناريو: {option.appliedDurationReductionDays} يوم عمل
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="p-3 border-t border-slate-100 bg-slate-50 text-[10px] text-slate-500 flex items-start gap-2">
          <DollarSign size={14} className="shrink-0 mt-0.5" />
          التكلفة لا تُقدّر من أسعار افتراضية؛ تُعرض N/A ما لم يُدخل المستخدم تكلفة/علاوة إضافية صريحة. تحليل الخيارات لا يحفظ تغييرات الجدول.
        </div>
      </div>
    </div>
  );
}

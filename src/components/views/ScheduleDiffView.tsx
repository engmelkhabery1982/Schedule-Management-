import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  BaselineActivity,
  ScheduleDiffResult,
  ActivityDiffItem,
} from '@/types';
import { getLanguage, translations, type Language } from '@/lib/i18n';
import { GitCompare, Search } from 'lucide-react';

interface ScheduleDiffViewProps {
  project: Project | null;
}

interface ComparisonActivity {
  id: string;
  code: string;
  name: string;
  duration_days: number;
  start_date: string | null;
  end_date: string | null;
  total_float: number | null;
  is_critical: boolean | null;
  percent_complete: number | null;
}

export default function ScheduleDiffView({ project }: ScheduleDiffViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<'all' | 'modified_only' | 'slippage_only' | 'critical_only'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [lang, setLang] = useState<Language>(getLanguage());
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const loadRequestId = useRef(0);

  useEffect(() => {
    if (project) {
      void loadData(project);
    } else {
      loadRequestId.current += 1;
      setActivities([]);
      setBaselineActivities([]);
      setLoadedProjectId(null);
      setLoading(false);
    }

    const handleLangChange = (e: Event) => {
      const nextLang = (e as CustomEvent<{ lang?: Language }>).detail?.lang;
      setLang(nextLang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => {
      loadRequestId.current += 1;
      window.removeEventListener('app-language-changed', handleLangChange);
    };
  }, [project]);

  async function loadData(projectToLoad: Project | null = project) {
    if (!projectToLoad) return;
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setActivities([]);
    setBaselineActivities([]);
    setLoadedProjectId(null);

    const [actRes, baselineRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', projectToLoad.id).order('sort_order'),
      // Match ScheduleView's governed baseline query: rows are scoped through the current project's
      // ACTIVE + APPROVED project_baselines header. baseline_activities has no project_id of its own.
      supabase.from('baseline_activities').select('*, project_baselines!inner(project_id, is_active, status)').eq('project_baselines.project_id', projectToLoad.id).eq('project_baselines.is_active', true).eq('project_baselines.status', 'approved'),
    ]);

    // Ignore out-of-order responses after a project change or a newer reload.
    if (requestId !== loadRequestId.current) return;
    setActivities((actRes.data || []) as Activity[]);
    setBaselineActivities((baselineRes.data || []) as BaselineActivity[]);
    setLoadedProjectId(projectToLoad.id);
    setLoading(false);
  }

  const t = translations[lang];
  const hasApprovedBaseline = baselineActivities.length > 0;

  const diffResult: ScheduleDiffResult | null = useMemo(() => {
    if (!hasApprovedBaseline) return null;

    const liveById = new Map(activities.map((activity) => [activity.id, activity]));
    const baselineRows: ComparisonActivity[] = baselineActivities.map((baseline) => {
      const liveActivity = liveById.get(baseline.activity_id);
      const baselineFloat = typeof baseline.total_float === 'number' ? baseline.total_float : null;
      return {
        id: baseline.activity_id,
        // The baseline row stores no code/name. Use the corresponding real activity when it still
        // exists; for a deleted activity, show its real activity_id rather than inventing a label.
        code: liveActivity?.code || baseline.activity_id,
        name: liveActivity?.name || baseline.activity_id,
        duration_days: baseline.duration_days,
        start_date: baseline.early_start || null,
        end_date: baseline.early_finish || null,
        total_float: baselineFloat,
        // Baseline criticality can only be derived where the approved baseline stored total float.
        is_critical: baselineFloat === null ? null : baselineFloat <= 0,
        // Approved baseline activities do not store a progress percentage.
        percent_complete: null,
      };
    });
    const liveRows: ComparisonActivity[] = activities.map((activity) => ({
      id: activity.id,
      code: activity.code,
      name: activity.name,
      duration_days: activity.duration_days,
      start_date: activity.early_start || null,
      end_date: activity.early_finish || null,
      total_float: typeof activity.total_float === 'number' ? activity.total_float : null,
      is_critical: typeof activity.is_critical === 'boolean' ? activity.is_critical : null,
      percent_complete: typeof activity.percent_complete === 'number' ? activity.percent_complete : null,
    }));

    const baselineName = lang === 'ar' ? 'خط الأساس المعتمد' : 'Approved Baseline';
    const currentScheduleName = lang === 'ar' ? 'الجدول الحي' : 'Live Schedule';
    const mapA = new Map(baselineRows.map((activity) => [activity.id, activity]));
    const mapB = new Map(liveRows.map((activity) => [activity.id, activity]));

    let addedCount = 0;
    let deletedCount = 0;
    let modifiedCount = 0;
    let measuredCriticalityShiftCount = 0;
    const diffItems: ActivityDiffItem[] = [];
    const allActivityIds = Array.from(new Set([...Array.from(mapA.keys()), ...Array.from(mapB.keys())]));

    allActivityIds.forEach((activityId) => {
      const actA = mapA.get(activityId);
      const actB = mapB.get(activityId);

      if (!actA && actB) {
        addedCount++;
        diffItems.push({
          activityId: actB.id,
          code: actB.code,
          name: actB.name,
          diffType: 'added',
          startBaseline: null,
          startCurrent: actB.start_date,
          startVarianceDays: null,
          finishBaseline: null,
          finishCurrent: actB.end_date,
          finishVarianceDays: null,
          durationBaseline: null,
          durationCurrent: actB.duration_days,
          durationVarianceDays: null,
          totalFloatBaseline: null,
          totalFloatCurrent: actB.total_float,
          totalFloatVarianceDays: null,
          criticalityBaseline: null,
          criticalityCurrent: actB.is_critical,
          criticalityShift: 'unknown',
          percentBaseline: null,
          percentCurrent: actB.percent_complete,
        });
      } else if (actA && !actB) {
        deletedCount++;
        diffItems.push({
          activityId: actA.id,
          code: actA.code,
          name: actA.name,
          diffType: 'deleted',
          startBaseline: actA.start_date,
          startCurrent: null,
          startVarianceDays: null,
          finishBaseline: actA.end_date,
          finishCurrent: null,
          finishVarianceDays: null,
          durationBaseline: actA.duration_days,
          durationCurrent: null,
          durationVarianceDays: null,
          totalFloatBaseline: actA.total_float,
          totalFloatCurrent: null,
          totalFloatVarianceDays: null,
          criticalityBaseline: actA.is_critical,
          criticalityCurrent: null,
          criticalityShift: 'unknown',
          percentBaseline: actA.percent_complete,
          percentCurrent: null,
        });
      } else if (actA && actB) {
        const startVar = actA.start_date && actB.start_date
          ? Math.round((new Date(actB.start_date).getTime() - new Date(actA.start_date).getTime()) / 86400000)
          : null;
        const finishVar = actA.end_date && actB.end_date
          ? Math.round((new Date(actB.end_date).getTime() - new Date(actA.end_date).getTime()) / 86400000)
          : null;
        const durationVar = actB.duration_days - actA.duration_days;
        const floatVar = actA.total_float !== null && actB.total_float !== null
          ? actB.total_float - actA.total_float
          : null;
        const isCritChanged = actA.is_critical !== null
          && actB.is_critical !== null
          && actA.is_critical !== actB.is_critical;
        if (isCritChanged) measuredCriticalityShiftCount++;

        // Baseline activities carry no progress percentage, so progress is not treated as a
        // baseline variance or allowed to inflate the modified-activity count.
        const isModified = (startVar !== null && startVar !== 0)
          || (finishVar !== null && finishVar !== 0)
          || durationVar !== 0
          || isCritChanged;
        if (isModified) modifiedCount++;

        diffItems.push({
          activityId: actB.id,
          code: actB.code,
          name: actB.name,
          diffType: isModified ? 'modified' : 'unchanged',
          startBaseline: actA.start_date,
          startCurrent: actB.start_date,
          startVarianceDays: startVar,
          finishBaseline: actA.end_date,
          finishCurrent: actB.end_date,
          finishVarianceDays: finishVar,
          durationBaseline: actA.duration_days,
          durationCurrent: actB.duration_days,
          durationVarianceDays: durationVar,
          totalFloatBaseline: actA.total_float,
          totalFloatCurrent: actB.total_float,
          totalFloatVarianceDays: floatVar,
          criticalityBaseline: actA.is_critical,
          criticalityCurrent: actB.is_critical,
          criticalityShift: actA.is_critical === null || actB.is_critical === null
            ? 'unknown'
            : !actA.is_critical && actB.is_critical
            ? 'became_critical'
            : actA.is_critical && !actB.is_critical
            ? 'became_non_critical'
            : 'unchanged',
          percentBaseline: actA.percent_complete,
          percentCurrent: actB.percent_complete,
        });
      }
    });

    const maxFinishA = baselineRows.reduce(
      (max, activity) => !activity.end_date ? max : !max || activity.end_date > max ? activity.end_date : max,
      null as string | null,
    );
    const maxFinishB = liveRows.reduce(
      (max, activity) => !activity.end_date ? max : !max || activity.end_date > max ? activity.end_date : max,
      null as string | null,
    );
    const projectFinishVarianceDays = maxFinishA && maxFinishB
      ? Math.round((new Date(maxFinishB).getTime() - new Date(maxFinishA).getTime()) / 86400000)
      : null;

    const summary = projectFinishVarianceDays === null
      ? (lang === 'ar'
        ? 'غير متاح (N/A): لا تتوفر تواريخ إنجاز من خط الأساس المعتمد والجدول الحي معاً.'
        : 'N/A — finish dates are not available in both the approved baseline and live schedule.')
      : projectFinishVarianceDays === 0
      ? (lang === 'ar'
        ? `تاريخ إنجاز المشروع في (${currentScheduleName}) متطابق مع (${baselineName}).`
        : `Project completion in (${currentScheduleName}) matches (${baselineName}).`)
      : projectFinishVarianceDays > 0
      ? (lang === 'ar'
        ? `يوجد تأخير كلي قدره +${projectFinishVarianceDays} يوماً في موعد إنهاء المشروع في (${currentScheduleName}) مقارنة بـ (${baselineName}).`
        : `Total project slippage of +${projectFinishVarianceDays} days in (${currentScheduleName}) compared to (${baselineName}).`)
      : (lang === 'ar'
        ? `المشروع متقدم بمقدار ${Math.abs(projectFinishVarianceDays)} يوماً في (${currentScheduleName}) مقارنة بـ (${baselineName}).`
        : `Project is ahead by ${Math.abs(projectFinishVarianceDays)} days in (${currentScheduleName}) compared to (${baselineName}).`);

    const hasCompleteBaselineCriticality = baselineRows.length > 0
      && baselineRows.every((activity) => activity.is_critical !== null);

    return {
      baselineName,
      currentScheduleName,
      totalActivitiesCount: allActivityIds.length,
      addedCount,
      deletedCount,
      modifiedCount,
      criticalityShiftCount: hasCompleteBaselineCriticality ? measuredCriticalityShiftCount : null,
      projectFinishVarianceDays,
      activities: diffItems,
      summary,
    };
  }, [activities, baselineActivities, hasApprovedBaseline, lang]);

  const filteredItems = useMemo(() => {
    if (!diffResult) return [];
    return diffResult.activities.filter((item) => {
      if (filterMode === 'modified_only' && item.diffType !== 'modified' && item.diffType !== 'added') return false;
      if (filterMode === 'slippage_only' && (item.finishVarianceDays === null || item.finishVarianceDays <= 0)) return false;
      if (filterMode === 'critical_only' && !item.criticalityCurrent) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return item.name.toLowerCase().includes(q) || item.code.toLowerCase().includes(q);
      }
      return true;
    });
  }, [diffResult, filterMode, searchQuery]);

  if (loading || (project ? loadedProjectId !== project.id : loadedProjectId !== null)) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  const comparisonUnavailable = !project || !diffResult;
  const finishVarianceClass = diffResult?.projectFinishVarianceDays == null
    ? 'text-slate-400'
    : diffResult.projectFinishVarianceDays > 0
    ? 'text-rose-600'
    : diffResult.projectFinishVarianceDays < 0
    ? 'text-emerald-600'
    : 'text-slate-600';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
              <GitCompare className="text-amber-500" size={24} />
              {t.diff_title}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              {lang === 'ar' ? 'خط الأساس المعتمد ↔ الجدول الحي' : 'Approved Baseline ↔ Live Schedule'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">{t.diff_subtitle}</p>
        </div>
      </div>

      {comparisonUnavailable ? (
        <div role="status" className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm text-center">
          <GitCompare size={32} className="mx-auto text-slate-300 mb-3" />
          <div className="text-2xl font-black text-slate-500 mb-2">N/A</div>
          <p className="text-sm font-bold text-slate-700">
            {!project
              ? (lang === 'ar' ? 'اختر مشروعاً لعرض مقارنة الجدول.' : 'Select a project to compare schedules.')
              : (lang === 'ar'
                ? 'لا توجد صفوف لخط أساس نشط ومعتمد لهذا المشروع. المقارنة غير متاحة حتى يتوفر خط أساس حقيقي معتمد.'
                : 'No active, approved baseline rows are available for this project. Comparison is N/A until a real approved baseline is available.')}
          </p>
        </div>
      ) : (
        <>
          {/* Fixed comparison: approved baseline versus the project's current live schedule. */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5">
              <span className="block text-xs font-bold text-slate-700">{t.rev_a_label}</span>
              <div className="text-sm font-black text-slate-900">{lang === 'ar' ? 'خط الأساس المعتمد' : 'Approved Baseline'}</div>
            </div>
            <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200 space-y-1.5">
              <span className="block text-xs font-bold text-amber-950">{t.rev_b_label}</span>
              <div className="text-sm font-black text-amber-950">{lang === 'ar' ? 'الجدول الحي' : 'Live Schedule'}</div>
            </div>
          </div>

          {/* Variance KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs text-slate-500 font-bold">{t.project_slip_var}</span>
              <div className={`text-2xl font-black mt-1 ${finishVarianceClass}`}>
                {diffResult.projectFinishVarianceDays === null
                  ? 'N/A'
                  : `${diffResult.projectFinishVarianceDays > 0 ? '+' : ''}${diffResult.projectFinishVarianceDays} ${lang === 'ar' ? 'يوم' : 'Days'}`}
              </div>
              <span className="text-[10px] text-slate-400">{lang === 'ar' ? 'خط الأساس المعتمد مقابل الجدول الحي' : 'Approved Baseline vs Live Schedule'}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs text-slate-500 font-bold">{t.modified_activities}</span>
              <div className="text-2xl font-black text-slate-900 mt-1">{diffResult.modifiedCount}</div>
              <span className="text-[10px] text-slate-400">{lang === 'ar' ? `من أصل ${diffResult.totalActivitiesCount} نشاط` : `out of ${diffResult.totalActivitiesCount}`}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs text-slate-500 font-bold">{t.critical_shifts}</span>
              <div className="text-2xl font-black text-amber-600 mt-1">{diffResult.criticalityShiftCount ?? 'N/A'}</div>
              <span className="text-[10px] text-slate-400">{lang === 'ar' ? 'غير متاح عند غياب الهامش المسجل في الأساس' : 'N/A when baseline float evidence is not recorded'}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs text-slate-500 font-bold">{t.added_activities}</span>
              <div className="text-2xl font-black text-emerald-600 mt-1">+{diffResult.addedCount}</div>
              <span className="text-[10px] text-slate-400">{lang === 'ar' ? 'أنشطة جديدة في الجدول الحالي' : 'New activities in the live schedule'}</span>
            </div>
          </div>

          {/* Summary Banner */}
          <div className="p-4 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-r-4 border-amber-500 rounded-xl bg-white shadow-sm flex items-center justify-between">
            <span className="font-bold text-slate-900 text-xs">{diffResult.summary}</span>
          </div>

          {/* Filter and Search Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={14} className="absolute right-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder={lang === 'ar' ? 'بحث في الأنشطة المعدلة...' : 'Search activities...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pr-8 pl-3 py-1.5 border border-slate-300 rounded-lg bg-white text-xs w-60 outline-none focus:border-amber-500 font-medium"
                />
              </div>

              <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-0.5">
                <button
                  onClick={() => setFilterMode('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${filterMode === 'all' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  {t.filter_all} ({diffResult.activities.length})
                </button>
                <button
                  onClick={() => setFilterMode('modified_only')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${filterMode === 'modified_only' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  {t.filter_modified} ({diffResult.modifiedCount})
                </button>
                <button
                  onClick={() => setFilterMode('slippage_only')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${filterMode === 'slippage_only' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  {t.filter_slippage}
                </button>
                <button
                  onClick={() => setFilterMode('critical_only')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${filterMode === 'critical_only' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  {t.filter_critical}
                </button>
              </div>
            </div>
          </div>

          {/* Approved Baseline vs Live Schedule Table */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-bold">
                  <tr>
                    <th className="p-3 text-right">{t.activity_code}</th>
                    <th className="p-3 text-right">{t.activity_name}</th>
                    <th className="p-3 text-right">{lang === 'ar' ? 'البداية (الأساس)' : 'Start (Baseline)'}</th>
                    <th className="p-3 text-right">{lang === 'ar' ? 'البداية (الحي)' : 'Start (Live)'}</th>
                    <th className="p-3 text-right">{lang === 'ar' ? 'النهاية (الأساس)' : 'Finish (Baseline)'}</th>
                    <th className="p-3 text-right">{lang === 'ar' ? 'النهاية (الحي)' : 'Finish (Live)'}</th>
                    <th className="p-3 text-right">{lang === 'ar' ? 'انحراف النهاية' : 'Finish Var'}</th>
                    <th className="p-3 text-right">{lang === 'ar' ? 'المدة (الأساس)' : 'Dur (Baseline)'}</th>
                    <th className="p-3 text-right">{lang === 'ar' ? 'المدة (الحي)' : 'Dur (Live)'}</th>
                    <th className="p-3 text-center">{t.critical}</th>
                    <th className="p-3 text-center">{lang === 'ar' ? 'حالة التغيير' : 'Diff Status'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {filteredItems.map((item) => (
                    <tr key={item.activityId} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-mono font-bold text-slate-700">{item.code}</td>
                      <td className="p-3 font-bold text-slate-800 max-w-xs truncate">{item.name}</td>
                      <td className="p-3 font-mono text-slate-500">{item.startBaseline || 'N/A'}</td>
                      <td className="p-3 font-mono text-slate-900 font-bold">{item.startCurrent || 'N/A'}</td>
                      <td className="p-3 font-mono text-slate-500">{item.finishBaseline || 'N/A'}</td>
                      <td className="p-3 font-mono text-slate-900 font-bold">{item.finishCurrent || 'N/A'}</td>
                      <td className="p-3 font-mono font-black">
                        {item.finishVarianceDays === null ? (
                          <span className="text-slate-400">N/A</span>
                        ) : item.finishVarianceDays > 0 ? (
                          <span className="text-rose-600">+{item.finishVarianceDays} {lang === 'ar' ? 'يوم' : 'd'}</span>
                        ) : item.finishVarianceDays < 0 ? (
                          <span className="text-emerald-600">{item.finishVarianceDays} {lang === 'ar' ? 'يوم' : 'd'}</span>
                        ) : (
                          <span className="text-slate-400">0 {lang === 'ar' ? 'يوم' : 'd'}</span>
                        )}
                      </td>
                      <td className="p-3 text-slate-500">{item.durationBaseline === null ? 'N/A' : `${item.durationBaseline} ${lang === 'ar' ? 'يوم' : 'd'}`}</td>
                      <td className="p-3 font-bold text-slate-900">{item.durationCurrent === null ? 'N/A' : `${item.durationCurrent} ${lang === 'ar' ? 'يوم' : 'd'}`}</td>
                      <td className="p-3 text-center">
                        {item.criticalityCurrent === null ? (
                          <span className="text-slate-400">N/A</span>
                        ) : item.criticalityCurrent ? (
                          <span className="px-2 py-0.5 rounded text-[10px] bg-rose-100 text-rose-700 font-bold">{t.critical}</span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        {item.diffType === 'added' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-800 font-bold">{lang === 'ar' ? 'مضاف' : 'Added'}</span>
                        ) : item.diffType === 'deleted' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] bg-rose-100 text-rose-800 font-bold">{lang === 'ar' ? 'محذوف' : 'Deleted'}</span>
                        ) : item.diffType === 'modified' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-800 font-bold">{lang === 'ar' ? 'معدل' : 'Modified'}</span>
                        ) : (
                          <span className="text-slate-400 text-[10px]">{lang === 'ar' ? 'مطابق' : 'Unchanged'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filteredItems.length === 0 && (
                    <tr>
                      <td colSpan={11} className="p-8 text-center text-sm text-slate-400">
                        {lang === 'ar' ? 'لا توجد أنشطة تطابق عوامل التصفية.' : 'No activities match the selected filters.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

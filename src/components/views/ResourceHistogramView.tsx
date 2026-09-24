import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Activity, ActivityLink, ActivityResource, P6Calendar, Project, Resource } from '@/types';
import { generateResourceHistogram, levelScheduleResources, type ResourceConflict, type ResourceLevelingScenario } from '@/lib/resourceLevelingEngine';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Ban,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Info,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from 'lucide-react';

interface ResourceHistogramViewProps {
  project: Project | null;
}

function formatDate(value: string | null): string {
  if (!value) return 'N/A';
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'N/A' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function conflictRows(conflicts: ResourceConflict[]) {
  return conflicts.map((conflict) => (
    <tr key={`${conflict.resourceId}:${conflict.date}`} className="border-t border-slate-100">
      <td className="px-3 py-2 font-medium text-slate-800">{conflict.resourceName}</td>
      <td className="px-3 py-2 whitespace-nowrap">{formatDate(conflict.date)}</td>
      <td className="px-3 py-2 text-right">{formatNumber(conflict.demand)} {conflict.unit}</td>
      <td className="px-3 py-2 text-right">{formatNumber(conflict.capacity)} {conflict.unit}</td>
      <td className="px-3 py-2 text-right text-red-700 font-semibold">+{formatNumber(conflict.overBy)} {conflict.unit}</td>
      <td className="px-3 py-2 text-slate-500">{conflict.activityIds.join(', ')}</td>
    </tr>
  ));
}

export default function ResourceHistogramView({ project }: ResourceHistogramViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [assignments, setAssignments] = useState<ActivityResource[]>([]);
  const [calendars, setCalendars] = useState<P6Calendar[]>([]);
  const [selectedResourceId, setSelectedResourceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [scenario, setScenario] = useState<ResourceLevelingScenario | null>(null);

  useEffect(() => {
    if (!project) {
      setActivities([]);
      setLinks([]);
      setResources([]);
      setAssignments([]);
      setCalendars([]);
      setLoading(false);
      return;
    }
    void loadData();
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    setLoadError('');
    const [actRes, linkRes, resRes, assignRes, calendarRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('resources').select('*').eq('project_id', project.id).order('name'),
      supabase.from('activity_resources').select('*').eq('project_id', project.id),
      supabase.from('calendars').select('*').eq('project_id', project.id),
    ]);
    const firstError = [actRes, linkRes, resRes, assignRes, calendarRes].find((result) => result.error)?.error;
    if (firstError) {
      setLoadError(firstError.message || 'Unable to load the complete schedule/resource evidence set.');
      setActivities([]);
      setLinks([]);
      setResources([]);
      setAssignments([]);
      setCalendars([]);
      setScenario(null);
      setLoading(false);
      return;
    }
    setActivities(actRes.data || []);
    setLinks(linkRes.data || []);
    setResources(resRes.data || []);
    setAssignments(assignRes.data || []);
    setCalendars(calendarRes.data || []);
    setScenario(null);
    setLoading(false);
  }

  useEffect(() => {
    if (resources.length && !resources.some((resource) => resource.id === selectedResourceId)) {
      setSelectedResourceId(resources[0].id);
    }
    if (!resources.length) setSelectedResourceId('');
  }, [resources, selectedResourceId]);

  const cpmOptions = useMemo(() => ({
    calendarType: project?.calendar_type || '6_days',
    customHolidays: [],
    dataDate: project?.data_date || DEFAULT_DATA_DATE,
    statusLogic: project?.status_logic || 'retained_logic',
    calculateDrag: true,
    calendars,
  }), [project?.calendar_type, project?.data_date, project?.status_logic, calendars]);

  const histogramData = useMemo(() => generateResourceHistogram({
    activities,
    links,
    resources,
    assignments,
    cpmOptions,
  }), [activities, links, resources, assignments, cpmOptions]);

  const selectedResource = useMemo(
    () => resources.find((resource) => resource.id === selectedResourceId) || null,
    [resources, selectedResourceId],
  );
  const selectedSummary = histogramData.resourceSummaries.find((item) => item.id === selectedResourceId) || null;
  const maxValInChart = useMemo(() => {
    if (!selectedResourceId || !histogramData.timeBuckets.length) return 1;
    const demandMax = Math.max(0, ...histogramData.timeBuckets.map((bucket) => bucket.resourceUnits[selectedResourceId] || 0));
    const capacity = selectedResource?.availability;
    const numericCapacity = capacity === null || capacity === undefined || !Number.isFinite(Number(capacity)) || Number(capacity) <= 0
      ? 0
      : Number(capacity);
    return Math.max(1, Math.ceil(Math.max(demandMax, numericCapacity) * 1.2));
  }, [histogramData, selectedResourceId, selectedResource]);

  function handleAnalyze() {
    if (!project || isAnalyzing || isApplying) return;
    setIsAnalyzing(true);
    setMessage('');
    const evaluated = levelScheduleResources({
      activities,
      links,
      resources,
      assignments,
      cpmOptions,
      projectControls: {
        calendar_type: project.calendar_type || null,
        data_date: project.data_date || null,
        status_logic: project.status_logic || null,
      },
    });
    setScenario(evaluated);
    setIsAnalyzing(false);
  }

  async function handleApply() {
    if (!project || !scenario || scenario.status !== 'ready' || isApplying || !scenario.scenarioCpm) return;
    const approvalMessage = `Apply the evaluated resource-leveling scenario for ${scenario.shiftedActivities.length} shifted activities? This writes the exact preview and CPM result atomically.`;
    if (!window.confirm(approvalMessage)) return;

    setIsApplying(true);
    setMessage('');
    const source = scenario.sourceSnapshot;
    const cpmResults = scenario.scenarioCpm.results.map((result) => ({
      activity_id: result.activityId,
      early_start: result.earlyStart,
      early_finish: result.earlyFinish,
      late_start: result.lateStart,
      late_finish: result.lateFinish,
      total_float: result.totalFloat,
      free_float: result.freeFloat,
      is_critical: result.isCritical,
      activity_drag: result.activityDrag,
    }));
    const activityPatches = scenario.manuallyShiftedActivityIds.map((activityId) => {
      const activity = scenario.scenarioActivities.find((item) => item.id === activityId);
      return { activity_id: activityId, early_start: activity?.early_start || null };
    });

    const { error } = await supabase.rpc('apply_resource_leveling_scenario', {
      p_project_id: project.id,
      p_expected_activities: source.activities,
      p_expected_links: source.links,
      p_expected_resources: source.resources,
      p_expected_assignments: source.assignments,
      p_expected_calendars: source.calendars,
      p_expected_controls: source.controls,
      p_activity_patches: activityPatches,
      p_cpm_results: cpmResults,
    });

    if (error) {
      setMessage(`Apply could not be confirmed. Validation/write errors roll back the RPC transaction; refresh and analyze again before retrying. ${error.message || ''}`);
      setScenario(null);
      setIsApplying(false);
      return;
    }

    setScenario(null);
    setMessage('The approved preview and its canonical CPM result were applied atomically.');
    await loadData();
    setIsApplying(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  const canApply = Boolean(
    scenario?.status === 'ready'
      && scenario.unresolvedConflicts.length === 0
      && scenario.manuallyShiftedActivityIds.length > 0
      && scenario.scenarioCpm,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Users className="text-blue-600" size={24} />
            منحنيات وتوزيع الموارد (Resource Histograms & Leveling)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            تحليل غير كتابي باستخدام التخصيصات والسعة المسجلة وتقويم المشروع؛ لا يتم حفظ أي تغيير قبل الموافقة على السيناريو.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleAnalyze}
            disabled={isAnalyzing || isApplying || loading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-semibold shadow-md shadow-blue-500/20 transition-all disabled:opacity-50"
          >
            <SlidersHorizontal size={14} className={isAnalyzing ? 'animate-spin' : ''} />
            تحليل ومعاينة (Analyze)
          </button>
          {scenario && (
            <button
              onClick={() => { setScenario(null); setMessage(''); }}
              disabled={isApplying}
              className="flex items-center gap-2 bg-white hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-lg text-xs font-semibold border border-slate-200 disabled:opacity-50"
            >
              <RefreshCw size={14} /> إلغاء المعاينة
            </button>
          )}
        </div>
      </div>

      {loadError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}
      {message && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-xs flex items-center gap-2">
          <Info size={15} className="shrink-0" /> <span>{message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {histogramData.resourceSummaries.map((resource) => {
          const isSelected = selectedResourceId === resource.id;
          const knownCapacity = resource.maxAvailability !== null && resource.maxAvailability > 0;
          return (
            <button
              type="button"
              key={resource.id}
              onClick={() => setSelectedResourceId(resource.id)}
              className={`text-left p-3.5 rounded-xl border transition-all shadow-sm ${isSelected ? 'bg-blue-50/70 border-blue-400 ring-2 ring-blue-500/20' : 'bg-white border-slate-200 hover:border-slate-300'}`}
            >
              <div className="flex items-center justify-between text-xs mb-2 gap-2">
                <span className="font-semibold text-slate-800 truncate">{resource.name}</span>
                {resource.isOverallocated === null ? (
                  <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5">N/A</span>
                ) : resource.isOverallocated ? (
                  <span className="w-2 h-2 rounded-full bg-red-500" title="تجاوز السعة" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-emerald-500" title="ضمن السعة المقاسة" />
                )}
              </div>
              <div className="space-y-1 text-[11px] text-slate-500">
                <div className="flex justify-between gap-2"><span>السعة المسجلة:</span><span className="font-bold text-slate-700">{knownCapacity ? `${formatNumber(resource.maxAvailability)} ${resource.unit}` : 'N/A / Insufficient data'}</span></div>
                <div className="flex justify-between gap-2"><span>أعلى طلب يومي:</span><span className={`font-bold ${resource.isOverallocated ? 'text-red-600' : 'text-slate-700'}`}>{resource.peakAllocated === null ? 'N/A' : `${formatNumber(resource.peakAllocated)} ${resource.unit}`}</span></div>
                <div className="flex justify-between gap-2"><span>متوسط الطلب اليومي:</span><span className="font-bold text-slate-700">{resource.avgAllocated === null ? 'N/A' : `${formatNumber(resource.avgAllocated)} ${resource.unit}`}</span></div>
              </div>
            </button>
          );
        })}
      </div>

      {histogramData.dataStatus === 'insufficient_data' && histogramData.dataIssues.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-xs">
          <strong>N/A / بيانات غير كافية:</strong>
          <ul className="list-disc pl-5 mt-1 space-y-1">{histogramData.dataIssues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200 text-xs">
        <span className="text-slate-500 font-medium px-2">عرض مورد واحد:</span>
        {resources.map((resource) => (
          <button
            key={resource.id}
            onClick={() => setSelectedResourceId(resource.id)}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${selectedResourceId === resource.id ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'}`}
          >
            {resource.name}
          </button>
        ))}
        <span className="text-slate-400 ml-auto">لا تُجمع وحدات موارد مختلفة في قيمة واحدة.</span>
      </div>

      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-4 gap-4">
          <div>
            <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
              <BarChart3 size={18} className="text-blue-600" />
              <span>ذروة الطلب اليومي حسب فترة العمل (Peak Daily Demand)</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {selectedResource
                ? `المورد: ${selectedResource.name} — السعة: ${selectedResource.availability !== null && Number(selectedResource.availability) > 0 ? `${formatNumber(Number(selectedResource.availability))} ${selectedResource.unit}` : 'N/A'}`
                : 'اختر مورداً لعرض الطلب المقاس.'}
            </p>
          </div>
          {selectedResource && selectedSummary?.maxAvailability !== null && selectedSummary?.maxAvailability !== undefined && selectedSummary.maxAvailability > 0 && (
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="inline-block w-4 h-0.5 border-t-2 border-dashed border-red-500" />
              <span className="text-slate-600">السعة المسجلة ({formatNumber(selectedSummary.maxAvailability)} {selectedResource.unit})</span>
            </div>
          )}
        </div>

        <div className="h-64 w-full relative">
          {(!selectedResource || !histogramData.timeBuckets.length) ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm text-center px-4">{histogramData.dataStatus === 'insufficient_data' ? 'N/A — لا يتوفر ملف طلب يومي موثوق لهذا المورد.' : 'لا توجد بيانات توزيع مستقبلية قابلة للعرض.'}</div>
          ) : (
            <svg className="w-full h-full" viewBox="0 0 1000 240" preserveAspectRatio="none" role="img" aria-label="Resource demand histogram">
              <line x1="40" y1="20" x2="980" y2="20" stroke="#f1f5f9" strokeWidth="1" />
              <line x1="40" y1="80" x2="980" y2="80" stroke="#f1f5f9" strokeWidth="1" />
              <line x1="40" y1="140" x2="980" y2="140" stroke="#f1f5f9" strokeWidth="1" />
              <line x1="40" y1="200" x2="980" y2="200" stroke="#e2e8f0" strokeWidth="1" />
              {selectedSummary?.maxAvailability !== null && selectedSummary?.maxAvailability !== undefined && selectedSummary.maxAvailability > 0 && (() => {
                const limitY = 200 - (selectedSummary.maxAvailability / maxValInChart) * 180;
                return <line x1="40" y1={limitY} x2="980" y2={limitY} stroke="#ef4444" strokeWidth="2" strokeDasharray="6,4" />;
              })()}
              {histogramData.timeBuckets.map((bucket, index) => {
                const count = histogramData.timeBuckets.length;
                const step = 940 / Math.max(1, count);
                const x = 40 + index * step + step * 0.15;
                const barWidth = Math.max(8, step * 0.7);
                const value = bucket.resourceUnits[selectedResourceId] || 0;
                const barHeight = (value / maxValInChart) * 180;
                const y = 200 - barHeight;
                const hasKnownCapacity = selectedSummary?.maxAvailability !== null && selectedSummary?.maxAvailability !== undefined && selectedSummary.maxAvailability > 0;
                const isOver = hasKnownCapacity ? value > selectedSummary!.maxAvailability! : null;
                return (
                  <g key={`${bucket.startDate}:${selectedResourceId}`} className="cursor-pointer group">
                    <rect x={x} y={y} width={barWidth} height={Math.max(2, barHeight)} rx={2} fill={isOver === null ? '#94a3b8' : isOver ? '#ef4444' : '#3b82f6'} className="transition-all opacity-85 group-hover:opacity-100">
                      <title>{`${bucket.dateLabel}\nPeak daily demand: ${formatNumber(value)} ${selectedResource.unit}\nCapacity: ${hasKnownCapacity ? `${formatNumber(selectedSummary!.maxAvailability)} ${selectedResource.unit}` : 'N/A / Insufficient data'}`}</title>
                    </rect>
                    <text x={x + barWidth / 2} y={220} fontSize="9" textAnchor="middle" fill="#64748b" fontFamily="monospace">{bucket.dateLabel.split(' – ')[0]}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <p className="text-[11px] text-slate-500 mt-2 flex items-start gap-2"><Info size={13} className="shrink-0 mt-0.5" />يُعرض الطلب اليومي فقط عند توفر ملف توزيع زمني موثوق لكل تخصيص. إجمالي الكمية المخططة/المتبقية وحده لا يحدد متى تُستخدم الموارد؛ لا نفترض توزيعاً ثابتاً، وتكون النتيجة N/A عند غياب الملف.</p>
      </div>

      {scenario && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className={`p-4 border-b flex items-start justify-between gap-4 ${scenario.status === 'ready' ? 'bg-emerald-50 border-emerald-100' : scenario.status === 'no_feasible_scenario' || scenario.status === 'invalid_schedule' ? 'bg-red-50 border-red-100' : scenario.status === 'insufficient_data' ? 'bg-amber-50 border-amber-100' : 'bg-blue-50 border-blue-100'}`}>
            <div className="flex gap-3">
              {scenario.status === 'ready' ? <CheckCircle2 className="text-emerald-700 mt-0.5" size={20} /> : scenario.status === 'no_feasible_scenario' || scenario.status === 'invalid_schedule' ? <Ban className="text-red-700 mt-0.5" size={20} /> : scenario.status === 'insufficient_data' ? <AlertTriangle className="text-amber-700 mt-0.5" size={20} /> : <Info className="text-blue-700 mt-0.5" size={20} />}
              <div>
                <h2 className="font-bold text-sm text-slate-900">
                  {scenario.status === 'ready' ? 'سيناريو قابل للتطبيق بعد المراجعة (Ready for approval)' : scenario.status === 'no_conflicts' ? 'لا توجد تعارضات سعة مقاسة' : scenario.status === 'insufficient_data' ? 'N/A / بيانات غير كافية' : 'لا يوجد سيناريو تسوية قابل للتطبيق / N/A'}
                </h2>
                <p className="text-xs text-slate-600 mt-1">{scenario.message}</p>
              </div>
            </div>
            {canApply && (
              <button
                onClick={() => void handleApply()}
                disabled={isApplying}
                className="shrink-0 flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg text-xs font-bold shadow-sm disabled:opacity-50"
              >
                <ShieldCheck size={15} className={isApplying ? 'animate-pulse' : ''} />
                {isApplying ? 'جارٍ التطبيق الذري…' : 'موافقة وتطبيق السيناريو (Apply)'}
              </button>
            )}
          </div>

          <div className="p-4 space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <Metric label="التعارضات قبل" value={scenario.conflictsBefore === null ? 'N/A' : String(scenario.conflictsBefore.length)} icon={<AlertTriangle size={14} />} />
              <Metric label="التعارضات بعد" value={scenario.conflictsAfter === null ? 'N/A' : String(scenario.conflictsAfter.length)} icon={<CheckCircle2 size={14} />} />
              <Metric label="نهاية الجدول الحالية" value={formatDate(scenario.currentProjectFinish)} icon={<CalendarDays size={14} />} />
              <Metric label="نهاية السيناريو" value={scenario.status === 'ready' || scenario.status === 'no_conflicts' ? formatDate(scenario.leveledProjectFinish) : 'N/A'} icon={<ArrowRight size={14} />} />
              <Metric label="فرق أيام العمل" value={scenario.finishVarianceWorkingDays === null ? 'N/A' : `${scenario.finishVarianceWorkingDays > 0 ? '+' : ''}${scenario.finishVarianceWorkingDays} يوم عمل`} icon={<Clock3 size={14} />} />
              <Metric label="الأنشطة المتغيرة" value={scenario.status === 'ready' ? String(scenario.shiftedActivities.length) : scenario.status === 'no_conflicts' ? '0' : 'N/A'} icon={<SlidersHorizontal size={14} />} />
            </div>

            {scenario.dataIssues.length > 0 && (
              <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900">
                <strong>أساس التحليل / نواقص البيانات:</strong>
                <ul className="list-disc pl-5 mt-1 space-y-1">{scenario.dataIssues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul>
              </div>
            )}

            {scenario.resourcesAffected.length > 0 && (
              <div>
                <h3 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-2"><Users size={14} />الموارد المتأثرة</h3>
                <div className="flex flex-wrap gap-2">{scenario.resourcesAffected.map((resource) => <span key={resource.id} className="text-[11px] bg-slate-100 border border-slate-200 rounded-full px-2.5 py-1 text-slate-700">{resource.name} ({resource.unit})</span>)}</div>
              </div>
            )}

            {scenario.criticalPathImpact && (
              <div className="rounded-lg border border-slate-200 p-3">
                <h3 className="text-xs font-bold text-slate-800 mb-2">أثر المسار الحرج (من CPM القانوني)</h3>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
                  <span>حرج قبل: <strong>{scenario.criticalPathImpact.baselineCriticalActivityIds.length}</strong></span>
                  <span>حرج بعد: <strong>{scenario.criticalPathImpact.leveledCriticalActivityIds.length}</strong></span>
                  <span>أصبح حرجاً: <strong>{scenario.criticalPathImpact.newlyCriticalActivityIds.length ? scenario.criticalPathImpact.newlyCriticalActivityIds.join(', ') : 'لا يوجد'}</strong></span>
                  <span>لم يعد حرجاً: <strong>{scenario.criticalPathImpact.noLongerCriticalActivityIds.length ? scenario.criticalPathImpact.noLongerCriticalActivityIds.join(', ') : 'لا يوجد'}</strong></span>
                </div>
              </div>
            )}

            {scenario.shiftedActivities.length > 0 && scenario.status === 'ready' && (
              <div>
                <h3 className="text-xs font-bold text-slate-800 mb-2">الأنشطة المتغيرة بعد إعادة حساب CPM</h3>
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">النشاط</th><th className="px-3 py-2">البداية الحالية</th><th className="px-3 py-2">بداية السيناريو</th><th className="px-3 py-2">النهاية الحالية</th><th className="px-3 py-2">نهاية السيناريو</th><th className="px-3 py-2">إزاحة العمل</th><th className="px-3 py-2">سبب التغيير</th></tr></thead>
                    <tbody>{scenario.shiftedActivities.map((activity) => <tr key={activity.activityId} className="border-t border-slate-100"><td className="px-3 py-2 font-medium text-slate-800">{activity.activityName}<span className="block text-[10px] text-slate-400">{activity.activityId}</span></td><td className="px-3 py-2 whitespace-nowrap">{formatDate(activity.currentStart)}</td><td className="px-3 py-2 whitespace-nowrap">{formatDate(activity.leveledStart)}</td><td className="px-3 py-2 whitespace-nowrap">{formatDate(activity.currentFinish)}</td><td className="px-3 py-2 whitespace-nowrap">{formatDate(activity.leveledFinish)}</td><td className="px-3 py-2">+{activity.shiftedWorkingDays} يوم عمل</td><td className="px-3 py-2">{activity.manuallyShifted ? 'تسوية مورد' : 'أثر علاقة / CPM'}</td></tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}

            {scenario.conflictsBefore && scenario.conflictsBefore.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-xs font-bold text-slate-800 flex items-center gap-2"><AlertTriangle size={14} className="text-amber-600" />التعارضات قبل التسوية ({scenario.conflictsBefore.length})</summary>
                <div className="overflow-x-auto border border-slate-200 rounded-lg mt-2">
                  <table className="w-full text-xs text-left"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">المورد</th><th className="px-3 py-2">التاريخ</th><th className="px-3 py-2 text-right">الطلب</th><th className="px-3 py-2 text-right">السعة</th><th className="px-3 py-2 text-right">الزيادة</th><th className="px-3 py-2">الأنشطة</th></tr></thead><tbody>{conflictRows(scenario.conflictsBefore)}</tbody></table>
                </div>
              </details>
            )}

            {scenario.unresolvedConflicts.length > 0 && (
              <div>
                <h3 className="text-xs font-bold text-red-800 mb-2 flex items-center gap-2"><AlertTriangle size={14} />تعارضات غير محلولة — لا يمكن تطبيق التسوية ({scenario.unresolvedConflicts.length})</h3>
                <div className="overflow-x-auto border border-red-200 rounded-lg">
                  <table className="w-full text-xs text-left"><thead className="bg-red-50 text-red-700"><tr><th className="px-3 py-2">المورد</th><th className="px-3 py-2">التاريخ</th><th className="px-3 py-2 text-right">الطلب</th><th className="px-3 py-2 text-right">السعة</th><th className="px-3 py-2 text-right">الزيادة</th><th className="px-3 py-2">الأنشطة</th></tr></thead><tbody>{conflictRows(scenario.unresolvedConflicts)}</tbody></table>
                </div>
              </div>
            )}

            {scenario.status === 'ready' && (
              <div className="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-100 p-3 text-xs text-blue-900">
                <ShieldCheck size={15} className="shrink-0 mt-0.5" />
                <span>المعاينة غير محفوظة. زر التطبيق يطلب موافقة صريحة، ثم يرسل التغييرات ونتيجة CPM الكاملة في معاملة ذرية واحدة. إذا تغيرت مدخلات الجدول منذ التحليل فسيُرفض التطبيق دون كتابة جزئية.</span>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="p-3 rounded-lg border border-slate-200 bg-white min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-1">{icon}<span>{label}</span></div>
      <div className="font-bold text-sm text-slate-900 truncate" title={value}>{value}</div>
    </div>
  );
}

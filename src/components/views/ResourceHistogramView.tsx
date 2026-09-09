import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, Resource, ActivityResource, CalendarType } from '@/types';
import { generateResourceHistogram, levelScheduleResources } from '@/lib/resourceLevelingEngine';
import { calculateCpm } from '@/lib/cpmEngine';
import {
  Users,
  Wrench,
  Sliders,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  BarChart3,
  Sparkles,
  Layers,
  RefreshCw,
} from 'lucide-react';

interface ResourceHistogramViewProps {
  project: Project | null;
}

export default function ResourceHistogramView({ project }: ResourceHistogramViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [assignments, setAssignments] = useState<ActivityResource[]>([]);
  const [selectedResourceId, setSelectedResourceId] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [isLeveling, setIsLeveling] = useState(false);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, resRes, assignRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('resources').select('*').eq('project_id', project.id).order('name'),
      supabase.from('activity_resources').select('*').eq('project_id', project.id),
    ]);
    setActivities(actRes.data || []);
    setResources(resRes.data || []);
    setAssignments(assignRes.data || []);
    setLoading(false);
  }

  const histogramData = useMemo(() => {
    return generateResourceHistogram(
      activities,
      resources,
      assignments,
      project?.calendar_type || '6_days',
    );
  }, [activities, resources, assignments, project?.calendar_type]);

  const selectedResource = useMemo(() => {
    return resources.find((r) => r.id === selectedResourceId) || null;
  }, [resources, selectedResourceId]);

  const maxValInChart = useMemo(() => {
    if (!histogramData.timeBuckets.length) return 10;
    let max = 0;
    histogramData.timeBuckets.forEach((b) => {
      const v = selectedResourceId === 'all' ? b.totalUnits : b.resourceUnits[selectedResourceId] || 0;
      if (v > max) max = v;
    });
    if (selectedResource && selectedResource.availability > max) {
      max = selectedResource.availability;
    }
    return Math.max(10, Math.ceil(max * 1.25));
  }, [histogramData, selectedResourceId, selectedResource]);

  async function handleAutoLeveling() {
    if (!project) return;
    setIsLeveling(true);
    const result = levelScheduleResources(
      activities,
      resources,
      assignments,
      project.calendar_type || '6_days',
    );

    if (result.leveledActivities.length === 0) {
      setMessage('لم يتم العثور على أنشطة تحتاج لتسوية (الأنشطة مستقرة بالفعل أو تقع على المسار الحرج).');
      setIsLeveling(false);
      return;
    }

    // Apply shifted dates
    for (const change of result.leveledActivities) {
      await supabase.from('activities').update({
        early_start: change.earlyStart,
        early_finish: change.earlyFinish,
      }).eq('id', change.activityId);
    }

    // Recalculate CPM network
    const linksRes = await supabase.from('activity_links').select('*').eq('project_id', project.id);
    const links = linksRes.data || [];
    const updatedActivitiesRes = await supabase.from('activities').select('*').eq('project_id', project.id);
    const updatedActivities = updatedActivitiesRes.data || [];

    const cpm = calculateCpm(updatedActivities, links, project.calendar_type || '6_days');
    for (const r of cpm.results) {
      await supabase.from('activities').update({
        early_start: r.earlyStart,
        early_finish: r.earlyFinish,
        late_start: r.lateStart,
        late_finish: r.lateFinish,
        total_float: r.totalFloat,
        free_float: r.freeFloat,
        is_critical: r.isCritical,
      }).eq('id', r.activityId);
    }

    await loadData();
    setIsLeveling(false);
    setMessage(result.summary);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Users className="text-blue-600" size={24} />
            منحنيات وتوزيع الموارد (Resource Histograms & Leveling)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            تحليل التوزيع الزمني للعمالة والمعدات، كشف التخصيص الزائد (Over-allocation)، وإجراء التسوية التلقائية.
          </p>
        </div>

        <button
          onClick={() => void handleAutoLeveling()}
          disabled={isLeveling}
          className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-semibold shadow-md shadow-blue-500/20 transition-all disabled:opacity-50"
        >
          <Sliders size={14} className={isLeveling ? 'animate-spin' : ''} />
          <span>تسوية الموارد التلقائية (Auto Leveling)</span>
        </button>
      </div>

      {message && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-xs flex items-center justify-between">
          <span>{message}</span>
          <button onClick={() => setMessage('')} className="text-blue-500 hover:text-blue-700 font-bold text-sm">×</button>
        </div>
      )}

      {/* Resource Cards Summary Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {histogramData.resourceSummaries.map((res) => {
          const isSelected = selectedResourceId === res.id;
          return (
            <div
              key={res.id}
              onClick={() => setSelectedResourceId(isSelected ? 'all' : res.id)}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all shadow-sm ${
                isSelected
                  ? 'bg-blue-50/70 border-blue-400 ring-2 ring-blue-500/20'
                  : 'bg-white border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-semibold text-slate-800 truncate">{res.name}</span>
                {res.isOverallocated ? (
                  <span className="w-2 h-2 rounded-full bg-red-500" title="تجاوز السعة" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-emerald-500" title="سعة منضبطة" />
                )}
              </div>

              <div className="space-y-1 text-[11px] text-slate-500">
                <div className="flex justify-between">
                  <span>الحد المتاح:</span>
                  <span className="font-bold text-slate-700">{res.maxAvailability} {res.unit}</span>
                </div>
                <div className="flex justify-between">
                  <span>أعلى طلب (Peak):</span>
                  <span className={`font-bold ${res.isOverallocated ? 'text-red-600' : 'text-slate-700'}`}>
                    {res.peakAllocated} {res.unit}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>متوسط الاستخدام:</span>
                  <span className="font-bold text-slate-700">{res.avgAllocated} {res.unit}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Resource Filter Tabs */}
      <div className="flex flex-wrap items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200 text-xs">
        <span className="text-slate-500 font-medium px-2">عرض منحنى:</span>
        <button
          onClick={() => setSelectedResourceId('all')}
          className={`px-3 py-1 rounded-md font-semibold transition-colors ${
            selectedResourceId === 'all'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
          }`}
        >
          كافة الموارد مجمعة (All)
        </button>
        {resources.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelectedResourceId(r.id)}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              selectedResourceId === r.id
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            {r.name}
          </button>
        ))}
      </div>

      {/* Interactive Histogram SVG Chart */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
              <BarChart3 size={18} className="text-blue-600" />
              <span>مخطط الطلب الزمني (Weekly Resource Demand)</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {selectedResource ? `المورد المعروض: ${selectedResource.name} (الحد المتاح: ${selectedResource.availability} ${selectedResource.unit})` : 'إجمالي كافة الموارد'}
            </p>
          </div>

          {selectedResource && (
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="inline-block w-4 h-0.5 border-t-2 border-dashed border-red-500" />
              <span className="text-slate-600">الحد الأقصى المتاح ({selectedResource.availability})</span>
            </div>
          )}
        </div>

        {/* SVG Histogram */}
        <div className="h-64 w-full relative">
          <svg className="w-full h-full" viewBox="0 0 1000 240" preserveAspectRatio="none">
            {/* Grid lines */}
            <line x1="40" y1="20" x2="980" y2="20" stroke="#f1f5f9" strokeWidth="1" />
            <line x1="40" y1="80" x2="980" y2="80" stroke="#f1f5f9" strokeWidth="1" />
            <line x1="40" y1="140" x2="980" y2="140" stroke="#f1f5f9" strokeWidth="1" />
            <line x1="40" y1="200" x2="980" y2="200" stroke="#e2e8f0" strokeWidth="1" />

            {/* Threshold line if single resource */}
            {selectedResource && (
              (() => {
                const limitY = 200 - (selectedResource.availability / maxValInChart) * 180;
                return (
                  <line
                    x1="40"
                    y1={limitY}
                    x2="980"
                    y2={limitY}
                    stroke="#ef4444"
                    strokeWidth="2"
                    strokeDasharray="6,4"
                  />
                );
              })()
            )}

            {/* Histogram Bars */}
            {histogramData.timeBuckets.map((bucket, i) => {
              const count = histogramData.timeBuckets.length;
              const step = 940 / Math.max(1, count);
              const x = 40 + i * step + step * 0.15;
              const barW = Math.max(8, step * 0.7);

              const val = selectedResourceId === 'all' ? bucket.totalUnits : bucket.resourceUnits[selectedResourceId] || 0;
              const barH = (val / maxValInChart) * 180;
              const y = 200 - barH;

              const isOver = selectedResource ? val > selectedResource.availability : bucket.isOverallocated;

              return (
                <g key={i} className="cursor-pointer group">
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={Math.max(2, barH)}
                    rx={2}
                    fill={isOver ? '#ef4444' : '#3b82f6'}
                    className="transition-all opacity-85 group-hover:opacity-100"
                  >
                    <title>{`${bucket.dateLabel}\nالطلب: ${val} وحدة\n${isOver ? '⚠️ تجاوز السعة القصوى' : 'ضمن الحد المتاح'}`}</title>
                  </rect>
                  <text
                    x={x + barW / 2}
                    y={220}
                    fontSize="9"
                    textAnchor="middle"
                    fill="#64748b"
                    fontFamily="monospace"
                  >
                    {bucket.dateLabel.split(' ~ ')[0]}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, ActivityLink, WbsNode, BaselineActivity, Resource, ActivityResource } from '@/types';
import { parseScheduleFile, validateImportedSchedule, type ImportedScheduleActivity } from '@/lib/scheduleImporter';
import { calculateCpm } from '@/lib/cpmEngine';
import { ChevronRight, ChevronDown, Zap, Flag, Clock, Upload, Save, Pencil, X } from 'lucide-react';

interface ScheduleViewProps {
  project: Project | null;
}

interface WbsTreeNode extends WbsNode {
  children: WbsTreeNode[];
  activities: Activity[];
}

export default function ScheduleView({ project }: ScheduleViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [wbsNodes, setWbsNodes] = useState<WbsNode[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [assignments, setAssignments] = useState<ActivityResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Activity>>({});
  const [importedActivities, setImportedActivities] = useState<ImportedScheduleActivity[]>([]);
  const [importFileName, setImportFileName] = useState('');
  const [message, setMessage] = useState('');
  const [linkForm, setLinkForm] = useState({ predecessor_id: '', successor_id: '', link_type: 'FS', lag_days: 0 });
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, wbsRes, baselineRes, linkRes, resourceRes, assignmentRes] = await Promise.all([
      supabase.from('activities').select('*, wbs_node:wbs_nodes(*)').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('wbs_nodes').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('baseline_activities').select('*, project_baselines!inner(project_id, is_active, status)').eq('project_baselines.project_id', project.id).eq('project_baselines.is_active', true).eq('project_baselines.status', 'approved'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('resources').select('*').eq('project_id', project.id).order('name'),
      supabase.from('activity_resources').select('*, resource:resources(*)').eq('project_id', project.id),
    ]);
    setActivities(actRes.data || []);
    setWbsNodes(wbsRes.data || []);
    setBaselineActivities((baselineRes.data || []) as BaselineActivity[]);
    setLinks((linkRes.data || []) as ActivityLink[]);
    setResources((resourceRes.data || []) as Resource[]);
    setAssignments((assignmentRes.data || []) as ActivityResource[]);
    // Expand all level 1 by default
    setExpandedNodes(new Set((wbsRes.data || []).filter((w) => w.level === 1).map((w) => w.id)));
    setLoading(false);
  }

  async function recalculatePersistedSchedule(nextActivities?: Activity[], nextLinks?: ActivityLink[]) {
    if (!project) return true;
    const calculation = calculateCpm(nextActivities || activities, nextLinks || links);
    if (calculation.cycle) {
      setMessage(`تم إيقاف إعادة الحساب: علاقة دائرية بين ${calculation.cycle.join(' ← ')}`);
      return false;
    }
    for (const result of calculation.results) {
      const { error } = await supabase.from('activities').update({
        early_start: result.earlyStart,
        early_finish: result.earlyFinish,
        late_start: result.lateStart,
        late_finish: result.lateFinish,
        total_float: result.totalFloat,
        is_critical: result.isCritical,
      }).eq('id', result.activityId);
      if (error) {
        setMessage(`تعذر حفظ إعادة حساب الجدول: ${error.message}`);
        return false;
      }
    }
    return true;
  }

  // Build WBS tree
  const tree = useMemo((): WbsTreeNode[] => {
    const nodeMap: Record<string, WbsTreeNode> = {};
    for (const w of wbsNodes) {
      nodeMap[w.id] = { ...w, children: [], activities: [] };
    }
    const roots: WbsTreeNode[] = [];
    for (const w of wbsNodes) {
      const node = nodeMap[w.id];
      if (w.parent_id && nodeMap[w.parent_id]) {
        nodeMap[w.parent_id].children.push(node);
      } else {
        roots.push(node);
      }
    }
    // Assign activities to WBS nodes
    for (const a of activities) {
      if (a.wbs_node_id && nodeMap[a.wbs_node_id]) {
        nodeMap[a.wbs_node_id].activities.push(a);
      }
    }
    return roots;
  }, [wbsNodes, activities]);

  // Calculate date range for Gantt
  const { minDate, maxDate, totalDays } = useMemo(() => {
    if (activities.length === 0) return { minDate: null, maxDate: null, totalDays: 0 };
    let min: Date | null = null;
    let max: Date | null = null;
    for (const a of activities) {
      if (a.early_start) {
        const d = new Date(a.early_start);
        if (!min || d < min) min = d;
      }
      if (a.early_finish) {
        const d = new Date(a.early_finish);
        if (!max || d > max) max = d;
      }
    }
    if (!min || !max) return { minDate: null, maxDate: null, totalDays: 0 };
    return { minDate: min, maxDate: max, totalDays: Math.round((max.getTime() - min.getTime()) / (1000 * 60 * 60 * 24)) + 1 };
  }, [activities]);

  // Generate month markers for Gantt header
  const monthMarkers = useMemo(() => {
    if (!minDate || !maxDate) return [];
    const markers: { label: string; offset: number }[] = [];
    const d = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    while (d <= maxDate) {
      const offset = Math.round((d.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24));
      markers.push({
        label: d.toLocaleDateString('ar-SA', { month: 'short', year: 'numeric' }),
        offset,
      });
      d.setMonth(d.getMonth() + 1);
    }
    return markers;
  }, [minDate, maxDate]);

  function toggleNode(id: string) {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function getBarStyle(act: Activity): { left: number; width: number } {
    if (!minDate || !act.early_start || !act.early_finish || totalDays === 0)
      return { left: 0, width: 0 };
    const start = new Date(act.early_start);
    const end = new Date(act.early_finish);
    const leftPct = ((start.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)) / totalDays * 100;
    const widthPct = Math.max(1, ((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) / totalDays * 100);
    return { left: leftPct, width: widthPct };
  }

  function getBaselineVariance(activity: Activity): number | null {
    const baseline = baselineActivities.find((item) => item.activity_id === activity.id);
    if (!baseline || !activity.early_finish) return null;
    return Math.round((new Date(activity.early_finish).getTime() - new Date(baseline.early_finish).getTime()) / (1000 * 60 * 60 * 24));
  }

  function startEdit(activity: Activity) {
    setEditingId(activity.id);
    setEditForm({
      name: activity.name,
      early_start: activity.early_start,
      early_finish: activity.early_finish,
      duration_days: activity.duration_days,
      planned_quantity: activity.planned_quantity,
      is_critical: activity.is_critical,
      is_milestone: activity.is_milestone,
    });
  }

  async function saveEdit() {
    if (!editingId || !editForm.name) return;
    const { error } = await supabase.from('activities').update({
      name: editForm.name,
      early_start: editForm.early_start || null,
      early_finish: editForm.early_finish || null,
      duration_days: Math.max(0, Number(editForm.duration_days) || 0),
      planned_quantity: Math.max(0, Number(editForm.planned_quantity) || 0),
      is_critical: Boolean(editForm.is_critical),
      is_milestone: Boolean(editForm.is_milestone),
    }).eq('id', editingId);
    if (error) {
      setMessage(`تعذر حفظ النشاط: ${error.message}`);
      return;
    }

    const changed = activities.map((activity) => activity.id === editingId ? {
      ...activity,
      ...editForm,
      duration_days: Number(editForm.duration_days || activity.duration_days),
    } : activity);
    if (!await recalculatePersistedSchedule(changed, links)) return;
    setEditingId(null);
    setMessage('تم حفظ تعديل النشاط وتسجيله في سجل التدقيق.');
    await loadData();
  }

  async function addRelationship() {
    if (!project || !linkForm.predecessor_id || !linkForm.successor_id || linkForm.predecessor_id === linkForm.successor_id) {
      setMessage('اختر نشاطين مختلفين لإضافة علاقة.');
      return;
    }
    const { data, error } = await supabase.from('activity_links').insert({
      project_id: project.id,
      predecessor_id: linkForm.predecessor_id,
      successor_id: linkForm.successor_id,
      link_type: linkForm.link_type,
      lag_days: Number(linkForm.lag_days) || 0,
    }).select().single();
    if (error) {
      setMessage(`تعذر حفظ العلاقة: ${error.message}`);
      return;
    }
    const nextLinks = [...links, data as ActivityLink];
    setLinks(nextLinks);
    if (await recalculatePersistedSchedule(activities, nextLinks)) {
      setLinkForm({ predecessor_id: '', successor_id: '', link_type: 'FS', lag_days: 0 });
      setMessage('تمت إضافة العلاقة وإعادة حساب CPM.');
      await loadData();
    }
  }

  async function removeRelationship(id: string) {
    const { error } = await supabase.from('activity_links').delete().eq('id', id);
    if (error) {
      setMessage(`تعذر حذف العلاقة: ${error.message}`);
      return;
    }
    const nextLinks = links.filter((link) => link.id !== id);
    setLinks(nextLinks);
    await recalculatePersistedSchedule(activities, nextLinks);
    await loadData();
  }

  async function handleScheduleFile(file: File) {
    setMessage('');
    try {
      const parsed = await parseScheduleFile(file);
      if (!parsed.length) throw new Error('لم يتم العثور على أنشطة صالحة في الملف');
      const validationErrors = validateImportedSchedule(parsed);
      if (validationErrors.length) throw new Error(validationErrors.slice(0, 3).join(' | '));
      setImportedActivities(parsed);
      setImportFileName(file.name);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'تعذر قراءة ملف الجدول');
    }
  }

  async function applyImportedSchedule() {
    if (!project || !importedActivities.length) return;
    const extension = importFileName.split('.').pop()?.toLowerCase() || 'unknown';
    const { data: revision, error: revisionError } = await supabase.from('schedule_revisions').insert({
      project_id: project.id,
      source_format: extension,
      source_filename: importFileName,
      activity_count: importedActivities.length,
      status: 'draft',
    }).select().single();
    if (revisionError || !revision) {
      setMessage(`تعذر تسجيل نسخة الجدول: ${revisionError?.message || 'خطأ غير معروف'}`);
      return;
    }
    const { error: revisionItemsError } = await supabase.from('schedule_revision_items').insert(
      importedActivities.map((activity) => ({
        revision_id: revision.id,
        activity_code: activity.code,
        payload: activity,
      })),
    );
    if (revisionItemsError) {
      setMessage(`تعذر حفظ تفاصيل نسخة الجدول: ${revisionItemsError.message}`);
      return;
    }
    const byCode = new Map(activities.map((activity) => [activity.code, activity]));
    const updates = importedActivities.filter((item) => byCode.has(item.code));
    const inserts = importedActivities.filter((item) => !byCode.has(item.code));
    for (const item of updates) {
      const existing = byCode.get(item.code);
      if (!existing) continue;
      const { error } = await supabase.from('activities').update({
        name: item.name,
        early_start: item.early_start,
        early_finish: item.early_finish,
        duration_days: item.duration_days,
        percent_complete: item.percent_complete,
        actual_start: item.actual_start,
        actual_finish: item.actual_finish,
        is_milestone: item.is_milestone,
      }).eq('id', existing.id);
      if (error) {
        setMessage(`تعذر تحديث النشاط ${item.code}: ${error.message}`);
        return;
      }
    }
    if (inserts.length) {
      const { error } = await supabase.from('activities').insert(inserts.map((item, index) => ({
        project_id: project.id,
        wbs_node_id: null,
        code: item.code,
        name: item.name,
        early_start: item.early_start,
        early_finish: item.early_finish,
        late_start: item.early_start,
        late_finish: item.early_finish,
        duration_days: item.duration_days,
        planned_quantity: 0,
        actual_quantity: 0,
        unit: null,
        percent_complete: item.percent_complete,
        is_critical: false,
        is_milestone: item.is_milestone,
        actual_start: item.actual_start,
        actual_finish: item.actual_finish,
        sort_order: activities.length + index,
      })));
      if (error) {
        setMessage(`تعذر إضافة الأنشطة الجديدة: ${error.message}`);
        return;
      }
    }
    const { data: refreshedActivities } = await supabase
      .from('activities')
      .select('id, code')
      .eq('project_id', project.id);
    const activityIds = new Map((refreshedActivities || []).map((activity) => [activity.code, activity.id]));
    const importedLinks = importedActivities.flatMap((item) => {
      const successorId = activityIds.get(item.code);
      if (!successorId) return [];
      return item.predecessor_codes.flatMap((predecessorCode) => {
        const predecessorId = activityIds.get(predecessorCode);
        return predecessorId ? [{ project_id: project.id, predecessor_id: predecessorId, successor_id: successorId, link_type: 'FS', lag_days: 0 }] : [];
      });
    });
    if (importedLinks.length) {
      const { error: linksError } = await supabase.from('activity_links').upsert(importedLinks, {
        onConflict: 'predecessor_id,successor_id,link_type',
        ignoreDuplicates: true,
      });
      if (linksError) {
        setMessage(`تم تطبيق الأنشطة لكن تعذر تطبيق بعض العلاقات: ${linksError.message}`);
      }
    }
    const { data: finalActivities } = await supabase.from('activities').select('*').eq('project_id', project.id);
    const { data: finalLinks } = await supabase.from('activity_links').select('*').eq('project_id', project.id);
    if (!await recalculatePersistedSchedule((finalActivities || []) as Activity[], (finalLinks || []) as ActivityLink[])) {
      await supabase.from('schedule_revisions').update({ status: 'rejected' }).eq('id', revision.id).eq('status', 'draft');
      return;
    }
    await supabase.from('schedule_revisions').update({
      status: 'applied',
      applied_at: new Date().toISOString(),
    }).eq('id', revision.id).eq('status', 'draft');
    setImportedActivities([]);
    setImportFileName('');
    setMessage(`تم تطبيق نسخة الجدول ${revision.id.slice(0, 8)}: تحديث ${updates.length} وإضافة ${inserts.length} نشاط.`);
    await loadData();
  }

  function renderWbsNode(node: WbsTreeNode, depth: number): React.ReactNode {
    const isExpanded = expandedNodes.has(node.id);
    return (
      <div key={node.id}>
        <div
          className="flex items-center hover:bg-slate-50 transition-colors border-b border-slate-100"
          style={{ paddingRight: `${depth * 20 + 12}px` }}
        >
          <div className="flex items-center gap-1 p-2 cursor-pointer min-w-0 flex-1" onClick={() => toggleNode(node.id)}>
            {node.children.length > 0 || node.activities.length > 0 ? (
              isExpanded ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />
            ) : (
              <div className="w-4" />
            )}
            <span className="text-xs text-slate-400 font-mono">{node.code}</span>
            <span className="text-sm text-slate-700 truncate">{node.name}</span>
          </div>
          {/* Gantt bar area for WBS summary */}
          <div className="relative h-8 flex-shrink-0" style={{ width: '50%' }} />
        </div>
        {isExpanded && (
          <>
            {node.children.map((child) => renderWbsNode(child, depth + 1))}
            {node.activities.map((act) => {
              const bar = getBarStyle(act);
              return (
                <div key={act.id} className="flex items-center hover:bg-slate-50 transition-colors border-b border-slate-100">
                  <div className="flex items-center gap-2 p-2 min-w-0 flex-1" style={{ paddingRight: `${(depth + 1) * 20 + 12}px` }}>
                    <div className="w-4" />
                    {act.is_milestone ? (
                      <Flag size={14} className="text-amber-500 flex-shrink-0" />
                    ) : act.is_critical ? (
                      <Zap size={14} className="text-red-500 flex-shrink-0" />
                    ) : (
                      <Clock size={14} className="text-blue-500 flex-shrink-0" />
                    )}
                    <span className="text-xs text-slate-400 font-mono">{act.code}</span>
                    <span className="text-sm text-slate-600 truncate">{act.name}</span>
                  </div>
                  {/* Gantt bar */}
                  <div className="relative h-8 flex-shrink-0 flex items-center" style={{ width: '50%' }}>
                    <div className="absolute h-5 rounded flex items-center overflow-hidden"
                      style={{
                        left: `${bar.left}%`,
                        width: `${bar.width}%`,
                        backgroundColor: act.is_milestone ? '#f59e0b' : act.is_critical ? '#ef4444' : '#3b82f6',
                      }}
                    >
                      <div
                        className="h-full bg-emerald-400 transition-all"
                        style={{ width: `${act.percent_complete}%` }}
                      />
                    </div>
                    <span className="absolute text-xs text-slate-500 px-1" style={{ left: `${bar.left + bar.width + 0.5}%` }}>
                      {act.percent_complete > 0 ? `${act.percent_complete}%` : `${act.duration_days}ي`}
                    </span>
                  </div>
                </div>

              );
            })}
          </>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent"></div>
      </div>
    );
  }

  if (!project) {
    return <div className="text-center text-slate-400 py-8">لا يوجد مشروع محدد</div>;
  }

  return (
    <div className="space-y-4">
      {message && <div className="p-3 bg-blue-50 border border-blue-200 text-blue-700 rounded-lg text-sm">{message}</div>}
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-800">الجدول الزمني</h1>
        <div className="flex flex-wrap items-center gap-4 mt-1 text-sm text-slate-500">
          <span>{activities.length} نشاط</span>
          <span>·</span>
          <span>المدة الإجمالية: {totalDays} يوم</span>
          {project.start_date && project.end_date && (
            <>
              <span>·</span>
              <span>{project.start_date} ← {project.end_date}</span>
            </>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-800">استيراد نسخة جدول</h3>
            <p className="text-xs text-slate-500 mt-1">يدعم Excel/CSV وPrimavera XER وMicrosoft Project XML. تتم مطابقة الأنشطة بالكود وتسجيل النسخة.</p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.txt,.xer,.xml"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleScheduleFile(file);
                event.target.value = '';
              }}
            />
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 bg-slate-800 text-white px-3 py-2 rounded-lg text-sm">
              <Upload size={16} /> اختيار ملف
            </button>
            {importedActivities.length > 0 && (
              <button onClick={() => void applyImportedSchedule()} className="flex items-center gap-2 bg-emerald-500 text-white px-3 py-2 rounded-lg text-sm">
                <Save size={16} /> تطبيق {importedActivities.length} نشاط
              </button>
            )}
          </div>
        </div>
        {importedActivities.length > 0 && (
          <div className="mt-3 p-3 bg-emerald-50 rounded-lg text-sm text-emerald-700">
            {importFileName}: تمت قراءة {importedActivities.length} نشاطاً. سيتم تحديث الأكواد المطابقة وإضافة الأكواد الجديدة، دون حذف بيانات المشروع.
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-red-500 rounded"></div>
          <span className="text-slate-600">مسار حرج</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-blue-500 rounded"></div>
          <span className="text-slate-600">عادي</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-amber-500 rounded"></div>
          <span className="text-slate-600">محطة رئيسية</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-emerald-400 rounded"></div>
          <span className="text-slate-600">منجز</span>
        </div>
      </div>

      {/* Gantt Chart */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="flex">
          {/* Left: WBS/Activity names */}
          <div className="w-1/2 border-l border-slate-200">
            <div className="bg-slate-50 p-2 border-b border-slate-200 font-medium text-sm text-slate-600">
              WBS / النشاط
            </div>

          </div>
          {/* Right: Timeline */}
          <div className="w-1/2 relative overflow-x-auto">
            <div className="bg-slate-50 border-b border-slate-200 h-10 relative" style={{ minWidth: `${Math.max(totalDays * 4, 400)}px` }}>
              {monthMarkers.map((m, i) => (
                <div key={i} className="absolute top-0 h-full border-l border-slate-200 flex items-center px-1 text-xs text-slate-500"
                  style={{ left: `${(m.offset / totalDays) * 100}%` }}
                >
                  <span className="whitespace-nowrap">{m.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-x-auto">
          <div style={{ minWidth: `${Math.max(totalDays * 4 + 400, 800)}px` }}>
            {tree.length > 0 ? tree.map((node) => renderWbsNode(node, 0)) : activities.map((act) => {
              const bar = getBarStyle(act);
              return <div key={act.id} className="flex items-center border-b border-slate-100 min-h-10">
                <div className="flex items-center gap-2 p-2 min-w-0 flex-1">
                  <span className="text-xs text-slate-400 font-mono">{act.code}</span>
                  <span className="text-sm text-slate-600 truncate">{act.name}</span>
                </div>
                <div className="relative h-8 flex-shrink-0 flex items-center" style={{ width: '50%' }}>
                  <div className="absolute h-5 rounded flex items-center overflow-hidden" style={{ left: `${bar.left}%`, width: `${bar.width}%`, backgroundColor: act.is_critical ? '#ef4444' : '#3b82f6' }}>
                    <div className="h-full bg-emerald-400" style={{ width: `${act.percent_complete}%` }} />
                  </div>
                </div>
              </div>;
            })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h3 className="font-semibold text-slate-800">شبكة العلاقات والتسلسل</h3>
            <p className="text-xs text-slate-500 mt-1">العلاقات المحفوظة فعليًا والمستخدمة في CPM.</p>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <select value={linkForm.predecessor_id} onChange={(event) => setLinkForm({ ...linkForm, predecessor_id: event.target.value })} className="px-2 py-1.5 border rounded text-xs bg-white"><option value="">النشاط السابق</option>{activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.code} - {activity.name}</option>)}</select>
              <select value={linkForm.successor_id} onChange={(event) => setLinkForm({ ...linkForm, successor_id: event.target.value })} className="px-2 py-1.5 border rounded text-xs bg-white"><option value="">النشاط اللاحق</option>{activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.code} - {activity.name}</option>)}</select>
              <select value={linkForm.link_type} onChange={(event) => setLinkForm({ ...linkForm, link_type: event.target.value })} className="px-2 py-1.5 border rounded text-xs bg-white"><option value="FS">FS - نهاية لبداية</option><option value="SS">SS - بداية لبداية</option><option value="FF">FF - نهاية لنهاية</option><option value="SF">SF - بداية لنهاية</option></select>
              <div className="flex gap-2"><input type="number" value={linkForm.lag_days} onChange={(event) => setLinkForm({ ...linkForm, lag_days: Number(event.target.value) || 0 })} className="w-20 px-2 py-1.5 border rounded text-xs" placeholder="Lag" /><button onClick={() => void addRelationship()} className="flex-1 bg-blue-600 text-white rounded text-xs">إضافة علاقة</button></div>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm"><thead className="bg-slate-50"><tr><th className="p-2 text-right">السابق</th><th className="p-2 text-right">العلاقة</th><th className="p-2 text-right">اللاحق</th><th className="p-2 text-right">Lag</th><th></th></tr></thead><tbody className="divide-y">{links.map((link) => <tr key={link.id}><td className="p-2">{activities.find((a) => a.id === link.predecessor_id)?.code || '-'}</td><td className="p-2 font-semibold text-blue-700">{link.link_type}</td><td className="p-2">{activities.find((a) => a.id === link.successor_id)?.code || '-'}</td><td className="p-2">{link.lag_days} يوم</td><td className="p-2"><button onClick={() => void removeRelationship(link.id)} className="text-red-600 text-xs">حذف</button></td></tr>)}</tbody></table>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h3 className="font-semibold text-slate-800">الموارد والتكلفة المخططة</h3>
            <p className="text-xs text-slate-500 mt-1">الكمية المخططة × معدل المورد، حسب الملكية.</p>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm"><thead className="bg-slate-50"><tr><th className="p-2 text-right">النشاط</th><th className="p-2 text-right">المورد</th><th className="p-2 text-right">النوع</th><th className="p-2 text-right">الكمية</th><th className="p-2 text-right">التكلفة</th></tr></thead><tbody className="divide-y">{assignments.map((assignment) => { const resource = assignment.resource || resources.find((item) => item.id === assignment.resource_id); const rate = Number(resource?.cost_rate || resource?.rental_rate || resource?.unit_rate || 0); return <tr key={assignment.id}><td className="p-2">{activities.find((a) => a.id === assignment.activity_id)?.code || '-'}</td><td className="p-2">{resource?.name || '-'}</td><td className="p-2">{resource?.ownership === 'rental' ? 'إيجار' : resource?.ownership === 'subcontractor' ? 'مقاول باطن' : 'ملك الشركة'}</td><td className="p-2">{assignment.planned_quantity}</td><td className="p-2 font-semibold">{(Number(assignment.planned_quantity || 0) * rate).toLocaleString()} ريال</td></tr>; })}</tbody></table>
          </div>
        </div>
      </div>

      {/* Activity table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-right p-3 font-medium">الكود</th>
                <th className="text-right p-3 font-medium">النشاط</th>
                <th className="text-right p-3 font-medium">WBS</th>
                <th className="text-right p-3 font-medium">البداية</th>
                <th className="text-right p-3 font-medium">النهاية</th>
                <th className="text-right p-3 font-medium">المدة</th>
                <th className="text-right p-3 font-medium">الإنجاز</th>
                <th className="text-right p-3 font-medium">الانحراف</th>
                <th className="text-right p-3 font-medium">الهامش</th>
                <th className="text-right p-3 font-medium">تحرير</th>
                <th className="text-right p-3 font-medium">حرج</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activities.map((act) => (
                <tr key={act.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 text-slate-500 font-mono text-xs">{act.code}</td>
                  <td className="p-3 text-slate-700 max-w-xs truncate">
                    {editingId === act.id ? (
                      <div className="space-y-2 min-w-52">
                        <input value={String(editForm.name || '')} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} className="w-full px-2 py-1 border rounded text-xs" />
                        <div className="grid grid-cols-2 gap-1">
                          <input type="date" value={String(editForm.early_start || '')} onChange={(event) => setEditForm({ ...editForm, early_start: event.target.value })} className="w-full px-1 py-1 border rounded text-[10px]" />
                          <input type="date" value={String(editForm.early_finish || '')} onChange={(event) => setEditForm({ ...editForm, early_finish: event.target.value })} className="w-full px-1 py-1 border rounded text-[10px]" />
                        </div>
                        <input type="number" min="0" value={Number(editForm.duration_days || 0)} onChange={(event) => setEditForm({ ...editForm, duration_days: Number(event.target.value) })} className="w-full px-2 py-1 border rounded text-xs" placeholder="المدة بالأيام" />
                        <div className="flex gap-1">
                          <button onClick={() => void saveEdit()} className="text-emerald-600"><Save size={14} /></button>
                          <button onClick={() => setEditingId(null)} className="text-slate-500"><X size={14} /></button>
                        </div>
                      </div>
                    ) : act.name}
                  </td>
                  <td className="p-3 text-slate-500 text-xs">{act.wbs_node?.code || '-'}</td>
                  <td className="p-3 text-slate-600 whitespace-nowrap">{act.early_start || '-'}</td>
                  <td className="p-3 text-slate-600 whitespace-nowrap">{act.early_finish || '-'}</td>
                  <td className="p-3 text-slate-600">{act.duration_days} يوم</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${act.percent_complete}%` }} />
                      </div>
                      <span className="text-xs text-slate-600">{act.percent_complete}%</span>
                    </div>
                  </td>
                  <td className={`p-3 ${Number(act.total_float || 0) <= 0 ? 'text-red-600 font-medium' : 'text-slate-600'}`}>
                    {Number(act.total_float || 0)} يوم
                  </td>
                  <td className="p-3">
                    {(() => {
                      const variance = getBaselineVariance(act);
                      if (variance === null) return <span className="text-slate-400">-</span>;
                      return (
                        <span className={variance > 0 ? 'text-red-600 font-medium' : 'text-emerald-600'}>
                          {variance > 0 ? `+${variance}` : variance} يوم
                        </span>
                      );
                    })()}
                  </td>
                  <td className="p-3">
                    <button onClick={() => startEdit(act)} className="text-blue-600 hover:text-blue-800" title="تحرير النشاط">
                      <Pencil size={15} />
                    </button>
                  </td>
                  <td className="p-3">
                    {act.is_critical && <Zap size={16} className="text-red-500" />}
                    {act.is_milestone && <Flag size={16} className="text-amber-500" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

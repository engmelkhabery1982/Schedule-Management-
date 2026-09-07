import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, WbsNode } from '@/types';
import { Calendar, ChevronRight, ChevronDown, Zap, Flag, Clock } from 'lucide-react';

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
  const [loading, setLoading] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, wbsRes] = await Promise.all([
      supabase.from('activities').select('*, wbs_node:wbs_nodes(*)').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('wbs_nodes').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
    ]);
    setActivities(actRes.data || []);
    setWbsNodes(wbsRes.data || []);
    // Expand all level 1 by default
    setExpandedNodes(new Set((wbsRes.data || []).filter((w) => w.level === 1).map((w) => w.id)));
    setLoading(false);
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

  if (activities.length === 0) {
    return (
      <div className="text-center py-12">
        <Calendar size={48} className="text-slate-300 mx-auto mb-3" />
        <p className="text-slate-500">لا يوجد جدول زمني. استورد المقايسة لإنشاء الجدول تلقائياً</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
            {tree.map((node) => renderWbsNode(node, 0))}
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
                <th className="text-right p-3 font-medium">حرج</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activities.map((act) => (
                <tr key={act.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 text-slate-500 font-mono text-xs">{act.code}</td>
                  <td className="p-3 text-slate-700 max-w-xs truncate">{act.name}</td>
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

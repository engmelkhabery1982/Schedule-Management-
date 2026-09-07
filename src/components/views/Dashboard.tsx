import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, Risk, Issue, BudgetLine, ProgressUpdate } from '@/types';
import {
  TrendingUp, TrendingDown, Clock, DollarSign, AlertTriangle,
  CheckCircle, Calendar, Activity as ActivityIcon, Zap, Target
} from 'lucide-react';

interface DashboardProps {
  project: Project | null;
  onNavigate: (view: import('@/types').ViewName) => void;
}

export default function Dashboard({ project, onNavigate }: DashboardProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, riskRes, issueRes, budgetRes, progRes] = await Promise.all([
      supabase.from('activities').select('*, wbs_node:wbs_nodes(*)').eq('project_id', project.id),
      supabase.from('risks').select('*').eq('project_id', project.id),
      supabase.from('issues').select('*').eq('project_id', project.id),
      supabase.from('budget_lines').select('*').eq('project_id', project.id),
      supabase.from('progress_updates').select('*').eq('project_id', project.id).order('update_date', { ascending: false }),
    ]);
    setActivities(actRes.data || []);
    setRisks(riskRes.data || []);
    setIssues(issueRes.data || []);
    setBudgetLines(budgetRes.data || []);
    setProgressUpdates(progRes.data || []);
    setLoading(false);
  }

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Target size={36} className="text-amber-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-800 mb-2">مرحباً بك</h2>
          <p className="text-slate-500 mb-6">ابدأ باستيراد عقد المشروع وجدول الكميات لإنشاء الجدول الزمني والميزانية تلقائياً</p>
          <button
            onClick={() => onNavigate('import')}
            className="bg-amber-500 text-slate-900 px-6 py-3 rounded-lg font-semibold hover:bg-amber-400 transition-colors"
          >
            استيراد مشروع جديد
          </button>
        </div>
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

  // Calculate KPIs
  const totalActivities = activities.length;
  const completedActivities = activities.filter((a) => a.percent_complete >= 100).length;
  const inProgress = activities.filter((a) => a.percent_complete > 0 && a.percent_complete < 100).length;
  const notStarted = activities.filter((a) => a.percent_complete === 0).length;
  const overallProgress = totalActivities > 0
    ? activities.reduce((sum, a) => sum + (a.percent_complete || 0), 0) / totalActivities
    : 0;

  const plannedBudget = budgetLines.reduce((sum, b) => sum + (b.planned_cost || 0), 0);
  const actualCost = budgetLines.reduce((sum, b) => sum + (b.actual_cost || 0), 0);
  const committedCost = budgetLines.reduce((sum, b) => sum + (b.committed_cost || 0), 0);
  const remainingBudget = plannedBudget - actualCost;
  const budgetUtilization = plannedBudget > 0 ? (actualCost / plannedBudget) * 100 : 0;

  const openRisks = risks.filter((r) => r.status === 'open').length;
  const highRisks = risks.filter((r) => r.severity >= 15).length;
  const openIssues = issues.filter((i) => i.status === 'open').length;

  const criticalActivities = activities.filter((a) => a.is_critical && a.percent_complete < 100).length;

  // Schedule dates
  const startDate = activities.length > 0
    ? activities.reduce((min, a) => {
        if (!a.early_start) return min;
        return !min || a.early_start < min ? a.early_start : min;
      }, null as string | null)
    : null;
  const endDate = activities.length > 0
    ? activities.reduce((max, a) => {
        if (!a.early_finish) return max;
        return !max || a.early_finish > max ? a.early_finish : max;
      }, null as string | null)
    : null;

  // Recent progress updates
  const recentUpdates = progressUpdates.slice(0, 5);

  const kpis = [
    {
      label: 'نسبة الإنجاز الكلية',
      value: `${overallProgress.toFixed(1)}%`,
      icon: TrendingUp,
      color: 'emerald',
      bg: 'bg-emerald-50',
      text: 'text-emerald-600',
      progress: overallProgress,
    },
    {
      label: 'الأنشطة المكتملة',
      value: `${completedActivities}/${totalActivities}`,
      icon: CheckCircle,
      color: 'blue',
      bg: 'bg-blue-50',
      text: 'text-blue-600',
      subtext: `${inProgress} قيد التنفيذ · ${notStarted} لم تبدأ`,
    },
    {
      label: 'الميزانية المستهلكة',
      value: `${budgetUtilization.toFixed(1)}%`,
      icon: DollarSign,
      color: 'amber',
      bg: 'bg-amber-50',
      text: 'text-amber-600',
      subtext: `${actualCost.toLocaleString()} / ${plannedBudget.toLocaleString()} ريال`,
      progress: budgetUtilization,
    },
    {
      label: 'الأنشطة الحرجة',
      value: `${criticalActivities}`,
      icon: Zap,
      color: 'red',
      bg: 'bg-red-50',
      text: 'text-red-600',
      subtext: 'على المسار الحرج',
    },
    {
      label: 'المخاطر المفتوحة',
      value: `${openRisks}`,
      icon: AlertTriangle,
      color: 'orange',
      bg: 'bg-orange-50',
      text: 'text-orange-600',
      subtext: `${highRisks} مخاطر عالية`,
    },
    {
      label: 'المشاكل المفتوحة',
      value: `${openIssues}`,
      icon: AlertTriangle,
      color: 'rose',
      bg: 'bg-rose-50',
      text: 'text-rose-600',
      subtext: 'تحتاج متابعة',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-slate-500">
            {project.client && <span>العميل: {project.client}</span>}
            {project.location && <span>الموقع: {project.location}</span>}
            <span className="px-2 py-0.5 bg-slate-100 rounded-full text-slate-600">
              {project.status === 'planning' ? 'تخطيط' : project.status === 'active' ? 'قيد التنفيذ' : project.status === 'completed' ? 'مكتمل' : project.status}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {startDate && endDate && (
            <div className="flex items-center gap-2 bg-slate-100 px-4 py-2 rounded-lg">
              <Calendar size={16} className="text-slate-500" />
              <span className="text-slate-600">{startDate} ← {endDate}</span>
            </div>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className={`w-12 h-12 ${kpi.bg} rounded-lg flex items-center justify-center`}>
                  <Icon size={24} className={kpi.text} />
                </div>
                <span className="text-2xl font-bold text-slate-800">{kpi.value}</span>
              </div>
              <p className="text-sm font-medium text-slate-600">{kpi.label}</p>
              {kpi.subtext && <p className="text-xs text-slate-400 mt-1">{kpi.subtext}</p>}
              {kpi.progress !== undefined && (
                <div className="mt-3">
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${kpi.text.replace('text-', 'bg-')} rounded-full transition-all duration-500`}
                      style={{ width: `${Math.min(kpi.progress, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Two column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity Status */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <ActivityIcon size={20} className="text-slate-500" />
            حالة الأنشطة
          </h3>
          <div className="space-y-3">
            {[
              { label: 'مكتملة', count: completedActivities, total: totalActivities, color: 'bg-emerald-500' },
              { label: 'قيد التنفيذ', count: inProgress, total: totalActivities, color: 'bg-blue-500' },
              { label: 'لم تبدأ', count: notStarted, total: totalActivities, color: 'bg-slate-300' },
            ].map((s) => (
              <div key={s.label}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-slate-600">{s.label}</span>
                  <span className="font-semibold text-slate-800">{s.count}</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${s.color} rounded-full transition-all duration-500`}
                    style={{ width: `${s.total > 0 ? (s.count / s.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">إجمالي الأنشطة</span>
              <span className="font-bold text-slate-800">{totalActivities}</span>
            </div>
          </div>
        </div>

        {/* Budget Summary */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <DollarSign size={20} className="text-slate-500" />
            ملخص الميزانية (ريال سعودي)
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
              <span className="text-sm text-slate-600">الميزانية المخططة</span>
              <span className="font-semibold text-slate-800">{plannedBudget.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
              <span className="text-sm text-blue-600">المبالغ الملتزمة</span>
              <span className="font-semibold text-blue-700">{committedCost.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-amber-50 rounded-lg">
              <span className="text-sm text-amber-600">التكلفة الفعلية</span>
              <span className="font-semibold text-amber-700">{actualCost.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-emerald-50 rounded-lg">
              <span className="text-sm text-emerald-600">المتبقي</span>
              <span className="font-semibold text-emerald-700">{remainingBudget.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Updates & Top Risks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Progress */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <Clock size={20} className="text-slate-500" />
            آخر تحديثات التقدم
          </h3>
          {recentUpdates.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">لا توجد تحديثات بعد</p>
          ) : (
            <div className="space-y-2">
              {recentUpdates.map((u) => {
                const act = activities.find((a) => a.id === u.activity_id);
                return (
                  <div key={u.id} className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg">
                    <div className={`w-2 h-2 rounded-full ${u.percent_complete >= 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-700 truncate">{act?.name || 'نشاط'}</p>
                      <p className="text-xs text-slate-400">{u.update_date} · {u.percent_complete}%</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top Risks */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <AlertTriangle size={20} className="text-slate-500" />
            أهم المخاطر
          </h3>
          {risks.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">لا توجد مخاطر مسجلة</p>
          ) : (
            <div className="space-y-2">
              {risks.sort((a, b) => b.severity - a.severity).slice(0, 5).map((r) => (
                <div key={r.id} className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg">
                  <div className={`w-2 h-2 rounded-full ${
                    r.severity >= 15 ? 'bg-red-500' : r.severity >= 9 ? 'bg-amber-500' : 'bg-emerald-500'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{r.title}</p>
                    <p className="text-xs text-slate-400">الخطورة: {r.severity}/25 · {r.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

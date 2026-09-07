import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, Risk, Issue, BudgetLine, ProgressUpdate, BaselineActivity, ProjectAlert, CostTransaction } from '@/types';
import { analyzeForecast, calculateEvmMetrics, calculateWeightedProgress } from '@/lib/planningEngine';
import { generateScheduleAlerts } from '@/lib/alertEngine';
import { generateScheduleQualityAlerts } from '@/lib/scheduleQualityEngine';
import { generateResourceConflictAlerts } from '@/lib/resourceConflictEngine';
import { calculateBaselineVariances, calculatePerformanceTrend, generateTrendAlerts } from '@/lib/trendEngine';
import { calculateControlHealth } from '@/lib/controlHealthEngine';
import { calculateRecoveryPlan } from '@/lib/recoveryEngine';
import { simulateScenario } from '@/lib/scenarioEngine';
import type { ActivityLink, ActivityResource, Resource } from '@/types';
import {
  TrendingUp, Clock, DollarSign, AlertTriangle,
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
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [approvedActualCost, setApprovedActualCost] = useState(0);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<ProjectAlert[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    setError('');
    const [actRes, riskRes, issueRes, budgetRes, progRes, costRes, baselineRes, alertsRes, linksRes, assignmentsRes, resourcesRes] = await Promise.all([
      supabase.from('activities').select('*, wbs_node:wbs_nodes(*)').eq('project_id', project.id),
      supabase.from('risks').select('*').eq('project_id', project.id),
      supabase.from('issues').select('*').eq('project_id', project.id),
      supabase.from('budget_lines').select('*').eq('project_id', project.id),
      supabase.from('progress_updates').select('*').eq('project_id', project.id).eq('status', 'approved').order('update_date', { ascending: false }),
      supabase.from('cost_transactions').select('*').eq('project_id', project.id).eq('status', 'approved'),
      supabase.from('baseline_activities').select('*, project_baselines!inner(project_id, is_active, status)').eq('project_baselines.project_id', project.id).eq('project_baselines.is_active', true).eq('project_baselines.status', 'approved'),
      supabase.from('project_alerts').select('*').eq('project_id', project.id).in('status', ['open', 'acknowledged']).order('severity', { ascending: false }),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('activity_resources').select('*').eq('project_id', project.id),
      supabase.from('resources').select('*').eq('project_id', project.id),
    ]);
    const queryError = [actRes, riskRes, issueRes, budgetRes, progRes, costRes, baselineRes, alertsRes, linksRes, assignmentsRes, resourcesRes]
      .find((result) => result.error)?.error;
    if (queryError) {
      setError(`تعذر تحميل بيانات التحكم: ${queryError.message}`);
      setLoading(false);
      return;
    }
    setActivities(actRes.data || []);
    setRisks(riskRes.data || []);
    setIssues(issueRes.data || []);
    setBudgetLines(budgetRes.data || []);
    setProgressUpdates(progRes.data || []);
    setApprovedActualCost((costRes.data || []).reduce((sum, item) => sum + Number(item.amount || 0), 0));
    setBaselineActivities((baselineRes.data || []) as BaselineActivity[]);
    setAlerts((alertsRes.data || []) as ProjectAlert[]);
    const activityData = (actRes.data || []) as Activity[];
    const budgetData = (budgetRes.data || []) as BudgetLine[];
    const planned = budgetData.reduce((sum, line) => sum + Number(line.planned_cost || 0), 0);
    const actual = (costRes.data || []).reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const activityWeights = new Map(activityData.map((activity) => [
      activity.id,
      Number(budgetData.find((line) => line.description === activity.name)?.planned_cost || activity.planned_quantity || 0),
    ]));
    const progress = calculateWeightedProgress(activityData, activityWeights);
    const baselineData = (baselineRes.data || []) as BaselineActivity[];
    const todayTime = Date.now();
    const plannedProgress = baselineData.length
      ? baselineData.reduce((sum, baseline) => {
          const start = new Date(`${baseline.early_start}T00:00:00Z`).getTime();
          const finish = new Date(`${baseline.early_finish}T00:00:00Z`).getTime();
          return sum + (todayTime <= start ? 0 : todayTime >= finish || finish <= start ? 1 : (todayTime - start) / (finish - start));
        }, 0) / baselineData.length
      : 0;
    const metrics = calculateEvmMetrics(planned, plannedProgress, progress, actual);
    const snapshotStart = activityData.reduce((min, activity) => !activity.early_start || (min && min <= activity.early_start) ? min : activity.early_start, null as string | null);
    const snapshotFinish = activityData.reduce((max, activity) => !activity.early_finish || (max && max >= activity.early_finish) ? max : activity.early_finish, null as string | null);
    const snapshotForecast = analyzeForecast(
      snapshotStart,
      snapshotFinish,
      planned,
      actual,
      progress,
      metrics.spi,
      metrics.cpi,
      activityData.filter((activity) => activity.is_critical && activity.percent_complete < 100).length,
      activityData.filter((activity) => Number(activity.total_float || 0) > 0 && Number(activity.total_float || 0) <= 5 && activity.percent_complete < 100).length,
    );
    const { error: snapshotError } = await supabase.from('forecast_snapshots').upsert({
      project_id: project.id,
      snapshot_date: new Date().toISOString().split('T')[0],
      spi: metrics.spi,
      cpi: metrics.cpi,
      forecast_finish: snapshotForecast.scenarios.realistic,
      optimistic_finish: snapshotForecast.scenarios.optimistic,
      pessimistic_finish: snapshotForecast.scenarios.pessimistic,
      eac_realistic: snapshotForecast.cost.realistic,
      risk_cost_exposure: snapshotForecast.riskExposure.cost,
      risk_days_exposure: snapshotForecast.riskExposure.days,
      confidence: snapshotForecast.confidence,
      volatility: snapshotForecast.volatility,
    }, { onConflict: 'project_id,snapshot_date' });
    if (snapshotError) {
      setError(`تعذر حفظ لقطة التوقع: ${snapshotError.message}`);
      setLoading(false);
      return;
    }
    const generatedAlerts = [
      ...generateScheduleAlerts(activityData, metrics),
      ...generateScheduleQualityAlerts(activityData, (linksRes.data || []) as ActivityLink[]),
      ...generateResourceConflictAlerts(activityData, (assignmentsRes.data || []) as ActivityResource[], (resourcesRes.data || []) as Resource[]),
      ...generateTrendAlerts(
        calculatePerformanceTrend((progRes.data || []) as ProgressUpdate[], (costRes.data || []) as CostTransaction[]),
        calculateBaselineVariances(activityData, baselineData),
      ),
    ];
    const recovery = calculateRecoveryPlan(activityData, baselineData, metrics);
    const scenarioResult = simulateScenario(activityData, baselineData, {
      productivityFactor: recovery.feasibility === 'unlikely' ? 1.2 : 1.1,
      delayDays: 0,
      resourceCapacityFactor: 1.1,
      costFactor: 1.08,
    });
    const { error: recoveryError } = await supabase.from('recovery_snapshots').upsert({
      project_id: project.id,
      snapshot_date: new Date().toISOString().split('T')[0],
      required_spi: recovery.requiredSpi,
      remaining_quantity: recovery.remainingQuantity,
      required_daily_quantity: recovery.requiredDailyQuantity,
      cost_gap: recovery.costGap,
      feasibility: recovery.feasibility,
      action: recovery.action,
    }, { onConflict: 'project_id,snapshot_date' });
    if (recoveryError) {
      setError(`تعذر حفظ خطة التعافي: ${recoveryError.message}`);
      setLoading(false);
      return;
    }
    const { error: scenarioError } = await supabase.from('scenario_simulations').upsert({
      project_id: project.id,
      name: `Recovery scenario ${new Date().toISOString().split('T')[0]}`,
      input: { productivityFactor: 1.1, delayDays: 0, resourceCapacityFactor: 1.1, costFactor: 1.08 },
      result: scenarioResult,
    }, { onConflict: 'project_id,name' });
    if (scenarioError) {
      setError(`تعذر حفظ محاكاة السيناريو: ${scenarioError.message}`);
      setLoading(false);
      return;
    }
    const activeFingerprints = new Set(generatedAlerts.map((alert) => alert.fingerprint));
    const staleAlertIds = ((alertsRes.data || []) as ProjectAlert[])
      .filter((alert) => alert.status === 'open' && !activeFingerprints.has(alert.fingerprint))
      .map((alert) => alert.id);
    if (staleAlertIds.length > 0) {
      await supabase.from('project_alerts').update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      }).in('id', staleAlertIds).eq('project_id', project.id);
    }
    if (generatedAlerts.length) {
      const { error: alertError } = await supabase.from('project_alerts').upsert(
        generatedAlerts.map((alert) => ({ ...alert, project_id: project.id, last_seen_at: new Date().toISOString() })),
        { onConflict: 'project_id,fingerprint' },
      );
      if (alertError) {
        setError(`تعذر حفظ الإنذارات: ${alertError.message}`);
        setLoading(false);
        return;
      }
      const { data: refreshedAlerts } = await supabase.from('project_alerts').select('*').eq('project_id', project.id).in('status', ['open', 'acknowledged']).order('severity', { ascending: false });
      setAlerts((refreshedAlerts || []) as ProjectAlert[]);
    }
    setLoading(false);
  }

  async function updateAlert(id: string, status: 'acknowledged' | 'resolved') {
    if (!project) return;
    await supabase.from('project_alerts').update({
      status,
      acknowledged_at: status === 'acknowledged' ? new Date().toISOString() : undefined,
      resolved_at: status === 'resolved' ? new Date().toISOString() : undefined,
    }).eq('id', id).eq('project_id', project.id);
    await loadData();
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

  if (error) {
    return <div className="p-5 rounded-xl border border-red-200 bg-red-50 text-red-700">{error}</div>;
  }

  // Calculate KPIs
  const totalActivities = activities.length;
  const completedActivities = activities.filter((a) => a.percent_complete >= 100).length;
  const inProgress = activities.filter((a) => a.percent_complete > 0 && a.percent_complete < 100).length;
  const notStarted = activities.filter((a) => a.percent_complete === 0).length;
  const activityWeights = new Map(activities.map((activity) => [
    activity.id,
    Number(budgetLines.find((line) => line.description === activity.name)?.planned_cost || activity.planned_quantity || 0),
  ]));
  const overallProgress = calculateWeightedProgress(activities, activityWeights) * 100;
  const plannedProgress = baselineActivities.length > 0
    ? (() => {
      let weightedExpected = 0;
      let totalBaselineCost = 0;
      baselineActivities.forEach((baseline) => {
        const start = new Date(baseline.early_start).getTime();
        const finish = new Date(baseline.early_finish).getTime();
        const todayTime = Date.now();
        const expected = todayTime <= start ? 0 : todayTime >= finish || finish <= start
          ? 1
          : (todayTime - start) / (finish - start);
        const weight = Math.max(0, Number(baseline.planned_cost || 0));
        weightedExpected += expected * weight;
        totalBaselineCost += weight;
      });
      return totalBaselineCost > 0
        ? weightedExpected / totalBaselineCost
        : baselineActivities.reduce((sum, baseline) => sum + (
          Date.now() < new Date(`${baseline.early_start}T00:00:00Z`).getTime() ? 0 : 1
        ), 0) / baselineActivities.length;
    })()
    : 0;

  const plannedBudget = budgetLines.reduce((sum, b) => sum + (b.planned_cost || 0), 0);
  const actualCost = approvedActualCost > 0
    ? approvedActualCost
    : budgetLines.reduce((sum, b) => sum + (b.actual_cost || 0), 0);
  const committedCost = budgetLines.reduce((sum, b) => sum + (b.committed_cost || 0), 0);
  const remainingBudget = plannedBudget - actualCost;
  const budgetUtilization = plannedBudget > 0 ? (actualCost / plannedBudget) * 100 : 0;

  const openRisks = risks.filter((r) => r.status === 'open').length;
  const highRisks = risks.filter((r) => r.severity >= 15).length;
  const openIssues = issues.filter((i) => i.status === 'open').length;

  const criticalActivities = activities.filter((a) => a.is_critical && a.percent_complete < 100).length;
  const nearCriticalActivities = activities.filter((a) => Number(a.total_float || 0) > 0 && Number(a.total_float || 0) <= 5 && a.percent_complete < 100).length;

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

  const evm = calculateEvmMetrics(
    plannedBudget,
    plannedProgress,
    overallProgress / 100,
    actualCost,
  );
  const scheduleWarning = evm.spi < 0.9 || (plannedProgress - overallProgress / 100) > 0.1 || criticalActivities > 0 || nearCriticalActivities > 0;
  const costWarning = evm.cpi < 0.9;
  const forecast = analyzeForecast(
    startDate,
    endDate,
    plannedBudget,
    actualCost,
    overallProgress / 100,
    evm.spi,
    evm.cpi,
    criticalActivities,
    nearCriticalActivities,
    risks,
  );
  const forecastScenarios = forecast.scenarios;
  const performanceTrend = calculatePerformanceTrend(progressUpdates, []);
  const baselineVariances = calculateBaselineVariances(activities, baselineActivities);
  const behindBaselineCount = baselineVariances.filter((item) => item.status === 'behind').length;
  const resourceConflictCount = alerts.filter((alert) => alert.alert_type === 'resource').length;
  const controlHealth = calculateControlHealth(evm, alerts, behindBaselineCount, resourceConflictCount);
  const recovery = calculateRecoveryPlan(activities, baselineActivities, evm);
  const recoveryScenario = simulateScenario(activities, baselineActivities, {
    productivityFactor: recovery.feasibility === 'unlikely' ? 1.2 : 1.1,
    delayDays: 0,
    resourceCapacityFactor: 1.1,
    costFactor: 1.08,
  });
  const forecastFinish = forecastScenarios.realistic;
  const riskAdjustedFinish = forecastFinish
    ? (() => {
      const date = new Date(`${forecastFinish}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + Math.ceil(forecast.riskExposure.days));
      return date.toISOString().split('T')[0];
    })()
    : null;
  const forecastDelay = riskAdjustedFinish && endDate
    ? Math.max(0, Math.round((new Date(riskAdjustedFinish).getTime() - new Date(endDate).getTime()) / 86400000))
    : 0;

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

                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div>
                      <h3 className="font-semibold text-slate-800">الصحة التشغيلية للمشروع</h3>
                      <p className="text-xs text-slate-500 mt-1">درجة مركبة من الأداء والإنذارات وخط الأساس والموارد</p>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-semibold text-slate-800">محاكاة سيناريو التعافي</h3>
                        <span className={`text-xs px-3 py-1 rounded-full ${recoveryScenario.feasibility === 'feasible' ? 'bg-emerald-50 text-emerald-700' : recoveryScenario.feasibility === 'strained' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
                          {recoveryScenario.feasibility === 'feasible' ? 'قابل للتنفيذ' : recoveryScenario.feasibility === 'strained' ? 'مجهد' : 'غير قابل للتنفيذ'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                        <div className="rounded bg-slate-50 p-3"><span className="text-slate-500">التسليم بعد المحاكاة</span><p className="font-bold">{recoveryScenario.finishDate || '-'}</p></div>
                        <div className="rounded bg-slate-50 p-3"><span className="text-slate-500">التكلفة الإضافية</span><p className="font-bold text-amber-700">{recoveryScenario.incrementalCost.toLocaleString()}</p></div>
                        <div className="rounded bg-slate-50 p-3"><span className="text-slate-500">الأنشطة الحساسة</span><p className="font-bold text-red-700">{recoveryScenario.impactedActivities}</p></div>
                      </div>
                      <p className="mt-3 text-xs text-slate-500">المحاكاة تفترض رفع الإنتاجية 10% وزيادة القدرة 10% وتكلفة إضافية 8%، ولا تغيّر الخطة المعتمدة.</p>
                    </div>

                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-semibold text-slate-800">خطة التعافي المطلوبة</h3>
                        <span className={`text-xs px-3 py-1 rounded-full ${
                          recovery.feasibility === 'unlikely' ? 'bg-red-50 text-red-700' :
                            recovery.feasibility === 'strained' ? 'bg-amber-50 text-amber-700' :
                              'bg-emerald-50 text-emerald-700'
                        }`}>
                          {recovery.feasibility === 'not_required' ? 'لا تحتاج تعافي' : recovery.feasibility === 'feasible' ? 'قابلة للتنفيذ' : recovery.feasibility === 'strained' ? 'مجهدة' : 'غير مرجحة'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                        <div className="rounded bg-slate-50 p-3"><span className="text-slate-500">SPI المطلوب</span><p className="font-bold text-slate-800">{recovery.requiredSpi.toFixed(2)}</p></div>
                        <div className="rounded bg-slate-50 p-3"><span className="text-slate-500">الإنتاج اليومي المطلوب</span><p className="font-bold text-slate-800">{recovery.requiredDailyQuantity.toFixed(2)}</p></div>
                        <div className="rounded bg-slate-50 p-3"><span className="text-slate-500">فجوة التكلفة</span><p className="font-bold text-amber-700">{recovery.costGap.toLocaleString()}</p></div>
                      </div>
                      <p className="mt-3 text-sm text-slate-600">{recovery.action}</p>
                    </div>
                    <div className={`text-3xl font-bold ${controlHealth.score >= 80 ? 'text-emerald-600' : controlHealth.score >= 60 ? 'text-amber-600' : 'text-red-600'}`}>
                      {controlHealth.score}/100
                    </div>
                  </div>
                  <div className="h-3 bg-slate-100 rounded-full overflow-hidden mb-4">
                    <div className={`h-full rounded-full ${controlHealth.score >= 80 ? 'bg-emerald-500' : controlHealth.score >= 60 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${controlHealth.score}%` }} />
                  </div>
                  <div className="space-y-2">
                    {controlHealth.recommendations.map((recommendation) => (
                      <div key={recommendation.title} className="rounded-lg bg-slate-50 p-3">
                        <p className="text-sm font-semibold text-slate-700">{recommendation.title}</p>
                        <p className="text-xs text-slate-500 mt-1">{recommendation.action}</p>
                      </div>
                    ))}
                  </div>
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

                {alerts.length > 0 && (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                        <AlertTriangle size={20} className="text-red-500" />
                        سجل الإنذارات النشطة ({alerts.length})
                      </h3>
                      <span className="text-xs text-slate-500">مولد من الجدول والتقدم والتكلفة</span>
                    </div>
                    <div className="space-y-2">
                      {alerts.slice(0, 10).map((alert) => (
                        <div key={alert.id} className="flex items-start gap-3 p-3 rounded-lg bg-slate-50">
                          <span className={`mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                            alert.severity === 'critical' ? 'bg-red-600' : alert.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-slate-700">{alert.title}</p>
                            <p className="text-xs text-slate-500 mt-1">{alert.message}</p>
                          </div>
                          <div className="flex gap-2 flex-shrink-0">
                            {alert.status === 'open' && (
                              <button onClick={() => void updateAlert(alert.id, 'acknowledged')} className="text-xs text-amber-700">استلام</button>
                            )}
                            <button onClick={() => void updateAlert(alert.id, 'resolved')} className="text-xs text-emerald-700">حل</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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

      {(scheduleWarning || costWarning) && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <h3 className="font-semibold text-red-800 flex items-center gap-2 mb-3">
            <AlertTriangle size={20} />
            إنذارات التحكم المبكر
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-red-700">
            {scheduleWarning && (
              <p>الجدول يحتاج متابعة: SPI = {evm.spi.toFixed(2)}، والأنشطة الحرجة {criticalActivities} وقريبة الحرجة {nearCriticalActivities}.</p>
            )}
            {costWarning && (
              <p>التكلفة تحت ضغط: CPI = {evm.cpi.toFixed(2)}، والتكلفة المتوقعة عند الإكمال {evm.eac.toLocaleString()} ريال.</p>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h3 className="font-semibold text-slate-800 mb-4">القيمة المكتسبة والتوقعات</h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
          <div><p className="text-slate-500">PV مخطط</p><p className="font-bold text-slate-800">{evm.pv.toLocaleString()}</p></div>
          <div><p className="text-slate-500">EV مكتسب</p><p className="font-bold text-emerald-700">{evm.ev.toLocaleString()}</p></div>
          <div><p className="text-slate-500">SPI / CPI</p><p className="font-bold text-blue-700">{evm.spi.toFixed(2)} / {evm.cpi.toFixed(2)}</p></div>
          <div><p className="text-slate-500">EAC متوقع بالمخاطر</p><p className="font-bold text-amber-700">{(forecast.cost.realistic + forecast.riskExposure.cost).toLocaleString()}</p></div>
          <div><p className="text-slate-500">التسليم المتوقع</p><p className={`font-bold ${forecastDelay > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{riskAdjustedFinish || '-'}</p></div>
        </div>
        {forecastDelay > 0 && <p className="mt-3 text-sm text-red-700">التوقع الحالي يشير إلى تأخير محتمل قدره {forecastDelay} يوم عن تاريخ الخطة.</p>}
        {forecastScenarios.realistic && (
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded bg-emerald-50 p-2 text-emerald-700">متفائل: {forecastScenarios.optimistic}</div>
            <div className="rounded bg-blue-50 p-2 text-blue-700">واقعي: {forecastScenarios.realistic}</div>
            <div className="rounded bg-red-50 p-2 text-red-700">متشائم: {forecastScenarios.pessimistic}</div>
          </div>
        )}
        <div className="mt-3 rounded-lg bg-orange-50 p-3 text-xs text-orange-800">
          التعرض الكمي للمخاطر: احتياطي زمني {forecast.riskExposure.days.toFixed(1)} يوم، واحتياطي مالي {forecast.riskExposure.cost.toLocaleString()} ريال.
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">ثقة التوقع: {forecast.confidence}%</span>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">تذبذب الأداء: {(forecast.volatility * 100).toFixed(1)}%</span>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-blue-700">
            تكلفة متفائلة/واقعية/متشائمة: {forecast.cost.optimistic.toLocaleString()} / {forecast.cost.realistic.toLocaleString()} / {forecast.cost.pessimistic.toLocaleString()}
          </span>
          <span className={`rounded-full px-3 py-1 ${performanceTrend.direction === 'deteriorating' ? 'bg-red-50 text-red-700' : performanceTrend.direction === 'improving' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'}`}>
            اتجاه الأداء: {performanceTrend.direction === 'deteriorating' ? 'متدهور' : performanceTrend.direction === 'improving' ? 'يتحسن' : 'مستقر'}
          </span>
          <span className="rounded-full bg-orange-50 px-3 py-1 text-orange-700">أنشطة متأخرة عن الأساس: {behindBaselineCount}</span>
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

import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  Risk,
  Issue,
  BudgetLine,
  ProgressUpdate,
  BaselineActivity,
  ProjectAlert,
  CostTransaction,
  BoqItem,
  ViewName,
  ActivityLink,
  ActivityResource,
  Resource,
} from '@/types';
import { analyzeForecast, calculateQuantityBasedEvm, calculateWeightedProgress } from '@/lib/planningEngine';
import { generateScheduleAlerts } from '@/lib/alertEngine';
import { generateScheduleQualityAlerts } from '@/lib/scheduleQualityEngine';
import { generateResourceConflictAlerts } from '@/lib/resourceConflictEngine';
import { calculateBaselineVariances, calculatePerformanceTrend, generateTrendAlerts } from '@/lib/trendEngine';
import { calculateControlHealth } from '@/lib/controlHealthEngine';
import { calculateRecoveryPlan } from '@/lib/recoveryEngine';
import { simulateScenario } from '@/lib/scenarioEngine';
import { generateSCurveData } from '@/lib/sCurveEngine';
import { getLanguage, translations, type Language } from '@/lib/i18n';
import SCurveChart from './SCurveChart';
import {
  TrendingUp,
  Clock,
  DollarSign,
  AlertTriangle,
  CheckCircle,
  Calendar,
  Zap,
  Target,
  Shield,
  Activity as ActivityIcon,
  Sparkles,
  ArrowRight,
  Scale,
  FastForward,
  ShieldCheck,
  Wrench,
  ShieldAlert,
  FileText,
  Copy,
  Printer,
  Check,
  AlertOctagon,
  Landmark,
} from 'lucide-react';

interface DashboardProps {
  project: Project | null;
  onNavigate: (view: ViewName) => void;
}

export default function Dashboard({ project, onNavigate }: DashboardProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [costTransactions, setCostTransactions] = useState<CostTransaction[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [approvedActualCost, setApprovedActualCost] = useState(0);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<ProjectAlert[]>([]);
  const [error, setError] = useState('');
  const [lang, setLang] = useState<Language>(getLanguage());

  // FIDIC Notice Modal State
  const [showNoticeModal, setShowNoticeModal] = useState(false);
  const [noticeCopied, setNoticeCopied] = useState(false);
  const [noticeForm, setNoticeForm] = useState({
    eventType: 'delayed_drawings',
    eventTitle: 'تأخر اعتماد المخططات التنفيذية لمسارات دكت التكييف وشبكات الحريق',
    incidentDate: '2026-11-10',
    clauseReference: 'عقد الفيديك الأحمر (FIDIC Red Book) - المادة 8.4 [تمديد مدة الإنجاز] والمادة 20.1 [مطالبات المقاول]',
    timeExtensionDays: 14,
    financialClaimSar: 67200,
    contractorName: 'شركة البناء والإنشاءات المتقدمة للمقاولات',
    employerName: 'وزارة الإسكان والمرافق العمرانية / شركة التطوير العقاري',
    engineerName: 'دار الهندسة للاستشارات الهندسية',
  });

  useEffect(() => {
    if (project) {
      loadData();
    } else {
      setLoading(false);
    }

    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    setError('');

    try {
      const [actRes, riskRes, issueRes, budgetRes, progRes, costRes, baselineRes, alertsRes, linksRes, assignmentsRes, resourcesRes, boqRes] = await Promise.all([
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
        supabase.from('boq_items').select('*').eq('project_id', project.id),
      ]);

      const activityData = (actRes.data || []) as Activity[];
      const budgetData = (budgetRes.data || []) as BudgetLine[];
      const baselineData = (baselineRes.data || []) as BaselineActivity[];
      const progData = (progRes.data || []) as ProgressUpdate[];
      const costData = (costRes.data || []) as CostTransaction[];

      setActivities(activityData);
      setRisks((riskRes.data || []) as Risk[]);
      setIssues((issueRes.data || []) as Issue[]);
      setBudgetLines(budgetData);
      setProgressUpdates(progData);
      setCostTransactions(costData);
      setApprovedActualCost(costData.reduce((sum: number, item: CostTransaction) => sum + Number(item.amount || 0), 0));
      setBoqItems((boqRes.data || []) as BoqItem[]);
      setBaselineActivities(baselineData);
      setAlerts((alertsRes.data || []) as ProjectAlert[]);
    } catch (err: any) {
      console.error('Error loading dashboard:', err);
    } finally {
      setLoading(false);
    }
  }

  // Calculate 28-Day FIDIC 20.1 Deadline
  const noticeDeadlineDate = useMemo(() => {
    try {
      const d = new Date(noticeForm.incidentDate);
      d.setUTCDate(d.getUTCDate() + 28);
      return d.toISOString().split('T')[0];
    } catch {
      return '2026-12-08';
    }
  }, [noticeForm.incidentDate]);

  const daysRemainingToClaim = useMemo(() => {
    try {
      const deadline = new Date(noticeDeadlineDate).getTime();
      const today = new Date('2026-11-15').getTime();
      return Math.max(0, Math.round((deadline - today) / 86400000));
    } catch {
      return 23;
    }
  }, [noticeDeadlineDate]);

  const generatedNoticeText = useMemo(() => {
    return `إلى: المهندس الاستشاري / ${noticeForm.engineerName}
نسخة إلى: صاحب العمل / ${noticeForm.employerName}
من: المقاول الرئيسي / ${noticeForm.contractorName}
اسم المشروع: ${project?.name || 'مشروع البرج المكتبي التجاري'}
التاريخ: 2026-11-15
المرجع: CONTRACT-NOTICE-FIDIC20.1-EOT-${noticeForm.incidentDate.replace(/-/g, '')}

الموضوع: إخطار تعاقدي رسمي بوقوع حدث تأخير ومطالبة بتمديد الوقت والتكاليف غير المباشرة (Notice of Claim under FIDIC Red Book Clause 20.1 & Clause 8.4)

تحية طيبة وبعد،،،

عملاً بأحكام المادة 20.1 [مطالبات المقاول] من شروط العقد، نود إخطاركم رسمياً بوقوع حدث يعطي المقاول الحق في تمديد مدة الإنجاز (Extension of Time) والحصول على تعويض مالي للتكاليف غير المباشرة:

1. وصف الحدث والمسبب: ${noticeForm.eventTitle}
2. تاريخ وقوع الحدث أو العلم به: ${noticeForm.incidentDate}
3. السند التعاقدي للمطالبة: ${noticeForm.clauseReference}
4. الأثر الزمني المتوقع على المسار الحرج (CPM): تمديد مدة الإنجاز بمقدار ${noticeForm.timeExtensionDays} يوماً تقويمياً.
5. التكاليف الإضافية غير المباشرة المطالب بها: ${noticeForm.financialClaimSar.toLocaleString()} ريال سعودي.

نحيطكم علماً بأن المقاول ملتزم بالمهلة الزمنية التعاقدية (28 يوماً من تاريخ العلم بالحدث حتى تاريخ ${noticeDeadlineDate})، وسيقوم فريق التخطيط والتحليل بتقديم الملف التوثيقي التفصيلي وشبكة الأثر الزمني (Fragnet TIA Analysis) والسجلات المؤيدة خلال المهلة النظامية المحددة (42 يوماً).

وتفضلوا بقبول فائق الاحترام والتقدير،،،

مدير المشروع / إدارة العقود والمطالبات
${noticeForm.contractorName}`;
  }, [noticeForm, noticeDeadlineDate, project]);

  const t = translations[lang];

  const handleCopyNotice = () => {
    navigator.clipboard.writeText(generatedNoticeText);
    setNoticeCopied(true);
    setTimeout(() => setNoticeCopied(false), 3000);
  };

  // Calculations
  const totalActivities = activities.length;
  const completedActivities = activities.filter((a) => a.percent_complete >= 100).length;
  const inProgress = activities.filter((a) => a.percent_complete > 0 && a.percent_complete < 100).length;
  const notStarted = activities.filter((a) => a.percent_complete === 0).length;

  const activityWeights = useMemo(() => {
    return new Map(activities.map((activity) => [
      activity.id,
      Number(budgetLines.find((line) => line.description === activity.name)?.planned_cost || activity.planned_quantity || 0),
    ]));
  }, [activities, budgetLines]);

  const overallProgress = useMemo(() => {
    return calculateWeightedProgress(activities, activityWeights) * 100;
  }, [activities, activityWeights]);

  const plannedProgress = useMemo(() => {
    if (!baselineActivities.length) return 0;
    const todayTime = Date.now();
    let weightedExpected = 0;
    let totalBaselineCost = 0;
    baselineActivities.forEach((baseline) => {
      const start = new Date(baseline.early_start).getTime();
      const finish = new Date(baseline.early_finish).getTime();
      const expected = todayTime <= start ? 0 : todayTime >= finish || finish <= start ? 1 : (todayTime - start) / (finish - start);
      const weight = Math.max(0, Number(baseline.planned_cost || 0));
      weightedExpected += expected * weight;
      totalBaselineCost += weight;
    });
    return totalBaselineCost > 0
      ? weightedExpected / totalBaselineCost
      : baselineActivities.reduce((sum, baseline) => sum + (Date.now() < new Date(`${baseline.early_start}T00:00:00Z`).getTime() ? 0 : 1), 0) / baselineActivities.length;
  }, [baselineActivities]);

  const plannedBudget = useMemo(() => {
    return budgetLines.reduce((sum, b) => sum + Number(b.approved_budget ?? b.estimated_cost ?? b.planned_cost ?? 0), 0);
  }, [budgetLines]);

  const actualCost = useMemo(() => {
    if (approvedActualCost > 0) return approvedActualCost;
    return budgetLines.reduce((sum, b) => sum + (b.actual_cost || 0), 0);
  }, [approvedActualCost, budgetLines]);

  const committedCost = useMemo(() => {
    return budgetLines.reduce((sum, b) => sum + (b.committed_cost || 0), 0);
  }, [budgetLines]);

  const remainingBudget = plannedBudget - actualCost;
  const budgetUtilization = plannedBudget > 0 ? (actualCost / plannedBudget) * 100 : 0;

  const openRisks = risks.filter((r) => r.status === 'open').length;
  const highRisks = risks.filter((r) => r.severity >= 15).length;
  const openIssues = issues.filter((i) => i.status === 'open').length;

  const criticalActivities = activities.filter((a) => a.is_critical && a.percent_complete < 100).length;
  const nearCriticalActivities = activities.filter((a) => Number(a.total_float || 0) > 0 && Number(a.total_float || 0) <= 5 && a.percent_complete < 100).length;

  const startDate = useMemo(() => {
    return activities.length > 0
      ? activities.reduce((min, a) => (!a.early_start ? min : !min || a.early_start < min ? a.early_start : min), null as string | null)
      : null;
  }, [activities]);

  const endDate = useMemo(() => {
    return activities.length > 0
      ? activities.reduce((max, a) => (!a.early_finish ? max : !max || a.early_finish > max ? a.early_finish : max), null as string | null)
      : null;
  }, [activities]);

  const recentUpdates = useMemo(() => progressUpdates.slice(0, 5), [progressUpdates]);

  const evm = useMemo(() => {
    return calculateQuantityBasedEvm(activities, boqItems, budgetLines, plannedProgress, actualCost);
  }, [activities, boqItems, budgetLines, plannedProgress, actualCost]);

  const forecast = useMemo(() => {
    return analyzeForecast(
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
  }, [startDate, endDate, plannedBudget, actualCost, overallProgress, evm.spi, evm.cpi, criticalActivities, nearCriticalActivities, risks]);

  const baselineVariances = useMemo(() => calculateBaselineVariances(activities, baselineActivities), [activities, baselineActivities]);
  const behindBaselineCount = baselineVariances.filter((item) => item.status === 'behind').length;
  const resourceConflictCount = alerts.filter((alert) => alert.alert_type === 'resource').length;
  const controlHealth = useMemo(() => calculateControlHealth(evm, alerts, behindBaselineCount, resourceConflictCount), [evm, alerts, behindBaselineCount, resourceConflictCount]);

  const forecastFinish = forecast.scenarios.realistic;
  const riskAdjustedFinish = useMemo(() => {
    if (!forecastFinish) return null;
    const date = new Date(`${forecastFinish}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Math.ceil(forecast.riskExposure.days));
    return date.toISOString().split('T')[0];
  }, [forecastFinish, forecast.riskExposure.days]);

  const forecastDelay = riskAdjustedFinish && endDate
    ? Math.max(0, Math.round((new Date(riskAdjustedFinish).getTime() - new Date(endDate).getTime()) / 86400000))
    : 0;

  const sCurveData = useMemo(() => {
    return generateSCurveData(
      activities,
      baselineActivities,
      progressUpdates,
      costTransactions,
      evm,
      project?.start_date || startDate,
      project?.end_date || endDate,
    );
  }, [activities, baselineActivities, progressUpdates, costTransactions, evm, project, startDate, endDate]);

  const kpis = [
    {
      label: t.total_progress,
      value: `${overallProgress.toFixed(1)}%`,
      icon: TrendingUp,
      bg: 'bg-emerald-50',
      text: 'text-emerald-600',
      progress: overallProgress,
    },
    {
      label: t.completed_activities,
      value: `${completedActivities}/${totalActivities}`,
      icon: CheckCircle,
      bg: 'bg-blue-50',
      text: 'text-blue-600',
      subtext: `${inProgress} ${t.in_progress} · ${notStarted} ${t.not_started}`,
    },
    {
      label: t.consumed_budget,
      value: `${budgetUtilization.toFixed(1)}%`,
      icon: DollarSign,
      bg: 'bg-amber-50',
      text: 'text-amber-600',
      subtext: `${actualCost.toLocaleString()} / ${plannedBudget.toLocaleString()} SAR`,
      progress: budgetUtilization,
    },
    {
      label: t.critical_activities,
      value: `${criticalActivities}`,
      icon: Zap,
      bg: 'bg-red-50',
      text: 'text-red-600',
      subtext: lang === 'ar' ? 'على المسار الحرج' : 'On Critical Path',
    },
    {
      label: t.open_risks,
      value: `${openRisks}`,
      icon: AlertTriangle,
      bg: 'bg-orange-50',
      text: 'text-orange-600',
      subtext: `${highRisks} ${t.high_risks}`,
    },
    {
      label: t.open_issues,
      value: `${openIssues}`,
      icon: AlertTriangle,
      bg: 'bg-rose-50',
      text: 'text-rose-600',
      subtext: lang === 'ar' ? 'تحتاج متابعة فورية' : 'Pending Resolution',
    },
  ];

  if (!project) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center max-w-md p-8 bg-white rounded-2xl shadow-sm border border-slate-200">
          <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Target size={36} className="text-amber-500" />
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">{lang === 'ar' ? 'مرحباً بك' : 'Welcome'}</h2>
          <p className="text-slate-500 text-sm mb-6">{lang === 'ar' ? 'ابدأ باستيراد عقد المشروع وجدول الكميات لإنشاء الجدول الزمني والميزانية تلقائياً' : 'Import contract BOQ or schedule to begin project tracking.'}</p>
          <button
            onClick={() => onNavigate('import')}
            className="bg-amber-500 text-slate-900 px-6 py-2.5 rounded-lg font-semibold hover:bg-amber-400 transition-colors text-sm cursor-pointer"
          >
            {lang === 'ar' ? 'استيراد مشروع جديد' : 'Import Project'}
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-amber-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-slate-500">
            {project.client && <span>{lang === 'ar' ? 'العميل:' : 'Client:'} <strong className="text-slate-700">{project.client}</strong></span>}
            {project.location && <span>{lang === 'ar' ? 'الموقع:' : 'Location:'} <strong className="text-slate-700">{project.location}</strong></span>}
            <span className="px-2.5 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full font-semibold">
              {project.status === 'planning' ? (lang === 'ar' ? 'تخطيط' : 'Planning') : (lang === 'ar' ? 'قيد التنفيذ' : 'Active Execution')}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() => onNavigate('schedule_diff')}
            className="flex items-center gap-1.5 bg-slate-900 text-white px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors font-semibold cursor-pointer"
          >
            <span>{lang === 'ar' ? 'مقارن النسخ' : 'Schedule Diff'}</span>
            <span className="bg-amber-400 text-slate-950 text-[10px] px-1 rounded font-bold">Diff</span>
          </button>
          <button
            onClick={() => onNavigate('time_impact_analysis')}
            className="flex items-center gap-1.5 bg-amber-500 text-slate-950 px-3 py-1.5 rounded-lg hover:bg-amber-400 transition-colors font-bold cursor-pointer"
          >
            <span>{lang === 'ar' ? 'تحليل TIA ومطالبات EOT' : 'TIA & EOT Claims'}</span>
          </button>
          <button
            onClick={() => onNavigate('schedule_recovery')}
            className="flex items-center gap-1.5 bg-slate-100 text-slate-700 border border-slate-300 px-3 py-1.5 rounded-lg hover:bg-slate-200 transition-colors font-semibold cursor-pointer"
          >
            <span>{lang === 'ar' ? 'خطة التعجيل (Crashing)' : 'Schedule Recovery'}</span>
          </button>
          {startDate && endDate && (
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg font-mono text-xs">
              <Calendar size={14} className="text-blue-600" />
              <span className="text-slate-700 font-bold">{startDate}</span>
              <span className="text-slate-400">➔</span>
              <span className="text-slate-700 font-bold">{endDate}</span>
            </div>
          )}
        </div>
      </div>

      {/* DEDICATED ENGINEERING CORRECTIVE PROPOSALS MATRIX (Placed at Top for Immediate Access) */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white rounded-2xl p-6 shadow-md border border-slate-700 space-y-5 animate-fadeIn">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/80 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles size={22} className="text-amber-400" />
              <h2 className="text-base font-black text-white">{t.engineering_proposals_title}</h2>
            </div>
            <p className="text-xs text-slate-300 mt-1">{t.engineering_proposals_subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => onNavigate?.('scenario_simulation')}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/30 transition-colors cursor-pointer"
            >
              <Sparkles size={14} className="text-amber-400" />
              <span>{lang === 'ar' ? 'محاكي السيناريوهات المعقدة (Sim)' : 'Complex Scenario Simulator'}</span>
            </button>
            <button
              onClick={() => onNavigate?.('data_governance')}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition-colors cursor-pointer"
            >
              <ShieldCheck size={14} />
              <span>{lang === 'ar' ? 'فحص الحوكمة الشامل (SSOT)' : 'Data Governance & SSOT'}</span>
            </button>
            <span className="hidden sm:inline-block px-3 py-1 rounded-full text-xs font-black bg-amber-500/20 text-amber-300 border border-amber-500/30">
              International Standards Compliant (AACE / PMI / FIDIC / DCMA)
            </span>
          </div>
        </div>

        {/* 4 Actionable Corrective Proposals Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* 1. Schedule & Progress Recovery */}
          <div className="bg-slate-800/90 p-4 rounded-xl border border-slate-700 flex flex-col justify-between space-y-3 hover:border-amber-500 transition-all shadow-sm">
            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-bold text-amber-300 flex items-center gap-1.5">
                  <Clock size={15} className="text-amber-400" />
                  {lang === 'ar' ? 'الجدول والمسار الحرج' : 'Schedule & Critical Path'}
                </span>
                <span className="text-[10px] font-mono bg-slate-950 text-amber-300 px-2 py-0.5 rounded font-bold border border-amber-500/30">FIDIC Cl. 8.6</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {lang === 'ar'
                  ? `مؤشر SPI الحالي (${evm.spi.toFixed(2)}). يوصى بتطبيق خطة التعجيل (Crashing Optimizer) لضغط الأنشطة الصفرية الهامش، أو تداخل المسارات المتتابعة.`
                  : `Current SPI is ${evm.spi.toFixed(2)}. Apply critical path crashing or fast-tracking to recover schedule deficits.`}
              </p>
            </div>
            <button
              onClick={() => onNavigate('schedule_recovery')}
              className="w-full py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-sm"
            >
              <FastForward size={14} />
              <span>{lang === 'ar' ? 'تطبيق خطة التعجيل' : 'Run Recovery Optimizer'}</span>
            </button>
          </div>

          {/* 2. EOT & Time Impact Analysis */}
          <div className="bg-slate-800/90 p-4 rounded-xl border border-slate-700 flex flex-col justify-between space-y-3 hover:border-blue-400 transition-all shadow-sm">
            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-bold text-blue-300 flex items-center gap-1.5">
                  <Scale size={15} className="text-blue-400" />
                  {lang === 'ar' ? 'مطالبات تمديد المدة (EOT)' : 'Delay Claims & EOT'}
                </span>
                <span className="text-[10px] font-mono bg-slate-950 text-blue-300 px-2 py-0.5 rounded font-bold border border-blue-500/30">AACE RP 29R-03</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {lang === 'ar'
                  ? 'في حال كانت التأخيرات ناتجة عن اعتمادات المالك أو تعديلات نطاق العمل، يتم إدراج شبكة Fragnet وحساب تكاليف التمديد (FIDIC Cl. 8.4).'
                  : 'Quantify employer-caused delays using Fragnet insertion and calculate prolongation cost claims.'}
              </p>
            </div>
            <button
              onClick={() => onNavigate('time_impact_analysis')}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-sm"
            >
              <Scale size={14} />
              <span>{lang === 'ar' ? 'إعداد مطالبة TIA' : 'Open TIA Engine'}</span>
            </button>
          </div>

          {/* 3. DCMA Schedule Quality Auto-Repair */}
          <div className="bg-slate-800/90 p-4 rounded-xl border border-slate-700 flex flex-col justify-between space-y-3 hover:border-emerald-400 transition-all shadow-sm">
            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-bold text-emerald-300 flex items-center gap-1.5">
                  <ShieldCheck size={15} className="text-emerald-400" />
                  {lang === 'ar' ? 'سلامة منطق DCMA' : 'DCMA Logic Quality'}
                </span>
                <span className="text-[10px] font-mono bg-slate-950 text-emerald-300 px-2 py-0.5 rounded font-bold border border-emerald-500/30">DCMA 14-Point</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {lang === 'ar'
                  ? 'معالجة الروابط المفتوحة (Open Logic)، وإلغاء القيود الصارمة المانعة، وضبط الـ Negative Lags لإعادة انضباط المسار الحرج.'
                  : 'Automatically eliminate dangling tasks, remove hard constraints, and convert non-standard relationships.'}
              </p>
            </div>
            <button
              onClick={() => onNavigate('dcma_audit')}
              className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-black rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-sm"
            >
              <Wrench size={14} />
              <span>{lang === 'ar' ? 'فحص وتصحيح DCMA' : 'Audit & Auto-Fix'}</span>
            </button>
          </div>

          {/* 4. Cost & EVM Management */}
          <div className="bg-slate-800/90 p-4 rounded-xl border border-slate-700 flex flex-col justify-between space-y-3 hover:border-purple-400 transition-all shadow-sm">
            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-bold text-purple-300 flex items-center gap-1.5">
                  <DollarSign size={15} className="text-purple-400" />
                  {lang === 'ar' ? 'كبح انحراف التكاليف' : 'Cost & Value Control'}
                </span>
                <span className="text-[10px] font-mono bg-slate-950 text-purple-300 px-2 py-0.5 rounded font-bold border border-purple-500/30">PMI EVM Standard</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {lang === 'ar'
                  ? `مؤشر CPI الحالي (${evm.cpi.toFixed(2)}). يوصى بتطبيق هندسة القيمة (Value Engineering) لبنود التشطيبات المتبقية وكبح مؤشر EAC.`
                  : `Current CPI is ${evm.cpi.toFixed(2)}. Apply value engineering and tighten daily productivity rates to curb forecast overruns.`}
              </p>
            </div>
            <button
              onClick={() => onNavigate('budget')}
              className="w-full py-2 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-sm"
            >
              <DollarSign size={14} />
              <span>{lang === 'ar' ? 'إدارة الميزانية والتكاليف' : 'Review Cost Variance'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* UNIFIED MULTI-DISCIPLINE EARLY-WARNING RADAR */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
              <ShieldAlert className="text-rose-600" size={20} />
              <span>{lang === 'ar' ? 'رادار الإنذار المبكر الشامل (Unified Early-Warning Radar)' : 'Unified Multi-Discipline Early-Warning Radar'}</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-200">
                Live Alert Monitor
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {lang === 'ar'
                ? 'رصد متكامل ومتقاطع للثغرات الحرجة عبر الجدول الزمني، السيولة النقدية، الضمانات البنكية، وانحراف التكاليف قبل حدوث أزمات تعاقدية.'
                : 'Cross-functional telemetry tracking schedule slippage, cash deficits, bank guarantee expiries, and cost variances.'}
            </p>
          </div>

          <button
            onClick={() => setShowNoticeModal(true)}
            className="flex items-center gap-2 bg-rose-600 hover:bg-rose-700 text-white px-3.5 py-2 rounded-xl text-xs font-black shadow-md shadow-rose-500/20 transition-all cursor-pointer"
          >
            <FileText size={15} />
            <span>{lang === 'ar' ? 'توليد إخطار تعاقدي فوري (FIDIC Cl. 20.1 Notice)' : 'Generate FIDIC Cl. 20.1 Notice'}</span>
          </button>
        </div>

        {/* 4 Multi-Discipline Alert Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          {/* 1. Schedule & Float Warning */}
          <div className="p-3.5 bg-rose-50/70 border border-rose-200 rounded-xl flex flex-col justify-between space-y-2.5">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-bold text-rose-950 flex items-center gap-1.5">
                  <Clock size={14} className="text-rose-600" />
                  <span>الجدول الزمني والهامش</span>
                </span>
                <span className="px-1.5 py-0.2 rounded text-[10px] bg-rose-200 text-rose-900 font-black">حرج</span>
              </div>
              <p className="text-rose-900 text-[11px] leading-relaxed">
                تآكل الهامش الكلي لمسار شبكة التكييف بمعدل 3.5 يوم/أسبوع، واقتراب المسار شبه الحرج من الصفر.
              </p>
            </div>
            <div className="pt-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-rose-800 font-bold border-t border-rose-200">
              <span>انزلاق متوقع: +14 يوم</span>
              <button onClick={() => onNavigate('schedule')} className="text-rose-900 hover:text-rose-950 font-black underline cursor-pointer">عرض الجدول ←</button>
            </div>
          </div>

          {/* 2. Cash Flow Deficit Warning */}
          <div className="p-3.5 bg-amber-50/70 border border-amber-200 rounded-xl flex flex-col justify-between space-y-2.5">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-bold text-amber-950 flex items-center gap-1.5">
                  <DollarSign size={14} className="text-amber-600" />
                  <span>التدفق النقدي والسيولة</span>
                </span>
                <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-200 text-amber-900 font-black">تنبيه</span>
              </div>
              <p className="text-amber-900 text-[11px] leading-relaxed">
                عجز سيولة متوقع بقيمة (312,000 SAR) خلال الشهرين القادمين بسبب تأخر صرف مستخلص رقم 3.
              </p>
            </div>
            <div className="pt-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-amber-800 font-bold border-t border-amber-200">
              <span>ذروة العجز: شهر 12</span>
              <button onClick={() => onNavigate('budget')} className="text-amber-900 hover:text-amber-950 font-black underline cursor-pointer">عرض التدفقات ←</button>
            </div>
          </div>

          {/* 3. Bank Guarantees Expiry Warning */}
          <div className="p-3.5 bg-blue-50/70 border border-blue-200 rounded-xl flex flex-col justify-between space-y-2.5">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-bold text-blue-950 flex items-center gap-1.5">
                  <Landmark size={14} className="text-blue-600" />
                  <span>الضمانات البنكية (BG)</span>
                </span>
                <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-200 text-blue-900 font-black">21 يوم متبقي</span>
              </div>
              <p className="text-blue-900 text-[11px] leading-relaxed">
                ضمان الدفعة المقدمة (APG-001) ينتهي في 2026-12-15، ويلزم تقديم خطاب تمديد للبنك لتجنب التسييل.
              </p>
            </div>
            <div className="pt-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-blue-800 font-bold border-t border-blue-200">
              <span>قيمة الضمان: 1.2M SAR</span>
              <button onClick={() => onNavigate('financial_controls')} className="text-blue-900 hover:text-blue-950 font-black underline cursor-pointer">إدارة الضمانات ←</button>
            </div>
          </div>

          {/* 4. Cost & Claims 28-Day Rule */}
          <div className="p-3.5 bg-purple-50/70 border border-purple-200 rounded-xl flex flex-col justify-between space-y-2.5">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-bold text-purple-950 flex items-center gap-1.5">
                  <Scale size={14} className="text-purple-600" />
                  <span>مهلة الإخطار (FIDIC 20.1)</span>
                </span>
                <span className="px-1.5 py-0.2 rounded text-[10px] bg-purple-200 text-purple-900 font-black">ساري</span>
              </div>
              <p className="text-purple-900 text-[11px] leading-relaxed">
                متبقي {daysRemainingToClaim} يوماً على المهلة القصوى (28 يوماً) لإرسال إخطار المطالبة رسمياً للاستشاري.
              </p>
            </div>
            <div className="pt-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-purple-800 font-bold border-t border-purple-200">
              <span>المهلة: {noticeDeadlineDate}</span>
              <button onClick={() => setShowNoticeModal(true)} className="text-purple-900 hover:text-purple-950 font-black underline cursor-pointer">إصدار الإخطار ←</button>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 items-stretch">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="min-w-0 bg-white rounded-xl shadow-sm border border-slate-200 p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <div className={`w-10 h-10 ${kpi.bg} rounded-lg flex items-center justify-center`}>
                  <Icon size={20} className={kpi.text} />
                </div>
                <span className="text-xl font-bold text-slate-800">{kpi.value}</span>
              </div>
              <p className="text-xs font-semibold text-slate-600">{kpi.label}</p>
              {kpi.subtext && <p className="text-[11px] text-slate-400 mt-1">{kpi.subtext}</p>}
              {kpi.progress !== undefined && (
                <div className="mt-2.5">
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(kpi.progress, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Health & Status Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Project Health Score */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <Shield size={18} className="text-slate-500" />
            {t.control_health}
          </h3>
          <div className="flex items-center gap-4 mb-4">
            <div className={`text-4xl font-extrabold ${
              controlHealth.score >= 80 ? 'text-emerald-600' :
              controlHealth.score >= 60 ? 'text-blue-600' :
              controlHealth.score >= 40 ? 'text-amber-600' : 'text-red-600'
            }`}>
              {controlHealth.score}%
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-700">
                {controlHealth.score >= 80 ? (lang === 'ar' ? 'أداء ممتاز ومتحكم به' : 'Excellent & Controlled') :
                 controlHealth.score >= 60 ? (lang === 'ar' ? 'تحت المراقبة المستمرة' : 'Under Continuous Monitoring') :
                 controlHealth.score >= 40 ? (lang === 'ar' ? 'معرض لمخاطر وانحراف' : 'At Risk of Variance') : (lang === 'ar' ? 'حالة حرجة تتطلب تدخل' : 'Critical Intervention Required')}
              </p>
              <p className="text-xs text-slate-400">{lang === 'ar' ? 'تقييم مبني على مؤشرات EVM، المسار الحرج، والموارد' : 'Based on EVM, CPM network, and resource loading.'}</p>
            </div>
          </div>
          <div className="space-y-2">
            {controlHealth.recommendations.map((rec, i) => (
              <div key={i} className="p-2.5 rounded-lg bg-slate-50 text-xs">
                <span className="font-semibold text-slate-700 block">{rec.title}</span>
                <span className="text-slate-500">{rec.action}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Schedule Summary */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <Clock size={18} className="text-slate-500" />
            {t.construction_status}
          </h3>
          <div className="space-y-3 text-xs">
            <div>
              <div className="flex justify-between text-slate-600 mb-1">
                <span>{lang === 'ar' ? `مكتمل (${completedActivities})` : `Completed (${completedActivities})`}</span>
                <span className="font-semibold">{totalActivities > 0 ? Math.round((completedActivities / totalActivities) * 100) : 0}%</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${totalActivities > 0 ? (completedActivities / totalActivities) * 100 : 0}%` }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-slate-600 mb-1">
                <span>{lang === 'ar' ? `قيد التنفيذ (${inProgress})` : `In Progress (${inProgress})`}</span>
                <span className="font-semibold">{totalActivities > 0 ? Math.round((inProgress / totalActivities) * 100) : 0}%</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${totalActivities > 0 ? (inProgress / totalActivities) * 100 : 0}%` }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-slate-600 mb-1">
                <span>{lang === 'ar' ? `لم تبدأ بعد (${notStarted})` : `Not Started (${notStarted})`}</span>
                <span className="font-semibold">{totalActivities > 0 ? Math.round((notStarted / totalActivities) * 100) : 0}%</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-slate-300 rounded-full" style={{ width: `${totalActivities > 0 ? (notStarted / totalActivities) * 100 : 0}%` }} />
              </div>
            </div>
          </div>
        </div>

        {/* Budget Summary */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <DollarSign size={18} className="text-slate-500" />
            {t.budget_summary}
          </h3>
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-lg">
              <span className="text-slate-600">{t.approved_budget}</span>
              <span className="font-bold text-slate-800">{plannedBudget.toLocaleString()} SAR</span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-blue-50 rounded-lg">
              <span className="text-blue-700">{t.committed_cost}</span>
              <span className="font-bold text-blue-700">{committedCost.toLocaleString()} SAR</span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-amber-50 rounded-lg">
              <span className="text-amber-700">{t.actual_cost}</span>
              <span className="font-bold text-amber-700">{actualCost.toLocaleString()} SAR</span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-emerald-50 rounded-lg">
              <span className="text-emerald-700">{t.remaining_budget}</span>
              <span className="font-bold text-emerald-700">{remainingBudget.toLocaleString()} SAR</span>
            </div>
          </div>
        </div>
      </div>

      {/* EVM Metric Cards */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h3 className="font-semibold text-slate-800 mb-3 text-sm">{t.evm_title}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
          <div className="bg-slate-50 p-3 rounded-lg"><p className="text-slate-500">{t.planned_pv}</p><p className="font-bold text-slate-800 text-sm mt-0.5">{evm.pv.toLocaleString()}</p></div>
          <div className="bg-emerald-50 p-3 rounded-lg"><p className="text-emerald-700">{t.earned_ev}</p><p className="font-bold text-emerald-800 text-sm mt-0.5">{evm.ev.toLocaleString()}</p></div>
          <div className="bg-blue-50 p-3 rounded-lg"><p className="text-blue-700">{t.spi_cpi}</p><p className="font-bold text-blue-800 text-sm mt-0.5">{evm.spi.toFixed(2)} / {evm.cpi.toFixed(2)}</p></div>
          <div className="bg-amber-50 p-3 rounded-lg"><p className="text-amber-700">{t.forecast_eac}</p><p className="font-bold text-amber-800 text-sm mt-0.5">{(forecast.cost.realistic + forecast.riskExposure.cost).toLocaleString()}</p></div>
          <div className="bg-slate-50 p-3 rounded-lg"><p className="text-slate-500">{t.forecast_finish}</p><p className={`font-bold text-sm mt-0.5 ${forecastDelay > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{riskAdjustedFinish || '-'}</p></div>
        </div>
      </div>

      {/* S-Curve Interactive Analysis */}
      <SCurveChart data={sCurveData} currency={project?.currency || 'SAR'} />

      {/* Recent Updates & Top Risks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2 text-sm">
            <Clock size={16} className="text-slate-500" />
            {t.recent_updates}
          </h3>
          {recentUpdates.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-4">{lang === 'ar' ? 'لا توجد تحديثات بعد' : 'No recent updates'}</p>
          ) : (
            <div className="space-y-2 text-xs">
              {recentUpdates.map((u) => {
                const act = activities.find((a) => a.id === u.activity_id);
                return (
                  <div key={u.id} className="flex items-center gap-3 p-2 bg-slate-50 rounded-lg">
                    <div className={`w-2 h-2 rounded-full ${u.percent_complete >= 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-700 truncate">{act?.name || 'نشاط'}</p>
                      <p className="text-[11px] text-slate-400">{u.update_date} · {lang === 'ar' ? 'نسبة الإنجاز:' : 'Progress:'} {u.percent_complete}%</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2 text-sm">
            <AlertTriangle size={16} className="text-slate-500" />
            {t.top_risks}
          </h3>
          {risks.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-4">{lang === 'ar' ? 'لا توجد مخاطر مسجلة' : 'No open risks'}</p>
          ) : (
            <div className="space-y-2 text-xs">
              {risks.slice(0, 4).map((r) => (
                <div key={r.id} className="flex items-center gap-3 p-2 bg-slate-50 rounded-lg">
                  <div className={`w-2 h-2 rounded-full ${r.severity >= 15 ? 'bg-red-500' : r.severity >= 9 ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-700 truncate">{r.title}</p>
                    <p className="text-[11px] text-slate-400">{lang === 'ar' ? 'مستوى الخطورة:' : 'Severity:'} {r.severity}/25 · {lang === 'ar' ? 'الحالة:' : 'Status:'} {r.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* FIDIC CLAUSE 20.1 NOTICE OF CLAIM MODAL */}
      {showNoticeModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl animate-fadeIn">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <FileText className="text-rose-600" size={22} />
                <div>
                  <h3 className="text-base font-black text-slate-900">
                    {lang === 'ar' ? 'مولد الإخطارات التعاقدية الرسمية (FIDIC Clause 20.1 Notice of Claim)' : 'FIDIC Clause 20.1 Notice of Claim Generator'}
                  </h3>
                  <span className="text-[11px] text-slate-500">
                    صياغة قانونية معتمدة وفق متطلبات المهلة الزمنية الصارمة (28 يوماً) لتفادي سقوط الحق بالتقادم (Time-Bar).
                  </span>
                </div>
              </div>
              <button
                onClick={() => setShowNoticeModal(false)}
                className="text-slate-400 hover:text-slate-700 font-black text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Inputs Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">وصف حدث التأخير والمطالبة:</label>
                <input
                  type="text"
                  value={noticeForm.eventTitle}
                  onChange={(e) => setNoticeForm({ ...noticeForm, eventTitle: e.target.value })}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">تاريخ وقوع الحدث أو العلم به:</label>
                <input
                  type="date"
                  value={noticeForm.incidentDate}
                  onChange={(e) => setNoticeForm({ ...noticeForm, incidentDate: e.target.value })}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">المهندس الاستشاري المشرف:</label>
                <input
                  type="text"
                  value={noticeForm.engineerName}
                  onChange={(e) => setNoticeForm({ ...noticeForm, engineerName: e.target.value })}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">صاحب العمل (المالك):</label>
                <input
                  type="text"
                  value={noticeForm.employerName}
                  onChange={(e) => setNoticeForm({ ...noticeForm, employerName: e.target.value })}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">التمديد الزمني المطالب به (أيام):</label>
                <input
                  type="number"
                  value={noticeForm.timeExtensionDays}
                  onChange={(e) => setNoticeForm({ ...noticeForm, timeExtensionDays: Number(e.target.value) })}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">التعويض المالي التقديري (ريال):</label>
                <input
                  type="number"
                  value={noticeForm.financialClaimSar}
                  onChange={(e) => setNoticeForm({ ...noticeForm, financialClaimSar: Number(e.target.value) })}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>
            </div>

            {/* 28-day notice banner */}
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <AlertOctagon size={16} className="text-rose-600" />
                <span className="font-bold text-rose-950">
                  آخر موعد قانوني لتقديم الإخطار (قاعدة 28 يوماً): <span className="font-mono text-rose-800 font-black">{noticeDeadlineDate}</span>
                </span>
              </div>
              <span className="px-2 py-0.5 bg-rose-200 text-rose-900 rounded font-black text-[11px]">
                متبقي {daysRemainingToClaim} يوم
              </span>
            </div>

            {/* Formal Letter Preview */}
            <div className="space-y-1.5">
              <span className="text-xs font-bold text-slate-700 block">معاينة الخطاب الرسمي المولد:</span>
              <div className="p-4 bg-slate-900 text-slate-100 rounded-xl font-mono text-[11px] leading-relaxed max-h-56 overflow-y-auto whitespace-pre-wrap border border-slate-800">
                {generatedNoticeText}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t">
              <button
                onClick={() => setShowNoticeModal(false)}
                className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                إغلاق
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopyNotice}
                  className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-amber-400 font-black rounded-xl text-xs shadow-sm cursor-pointer"
                >
                  {noticeCopied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                  <span>{noticeCopied ? 'تم نسخ نص الخطاب بنجاح ✓' : 'نسخ نص الإخطار'}</span>
                </button>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-black rounded-xl text-xs shadow-md shadow-rose-500/20 cursor-pointer"
                >
                  <Printer size={14} />
                  <span>طباعة الخطاب الرسمي</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

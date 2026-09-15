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
  ScheduleUpdateSnapshot,
  WbsNode,
  ActivityBoqAllocation,
  CostControlSnapshot,
} from '@/types';
import { analyzeForecast, calculateActivityCompletionAverage } from '@/lib/planningEngine';
// F9.4 (defect 1): the dashboard QUOTES the canonical EVM from its own F6 report instead of running
// a second, competing EVM derivation. F6 is canonical for the cost-control layer; F8 (below) already
// quotes F6, so all three surfaces now read one source.
import { quoteCanonicalEvm } from '@/lib/canonicalEvm';
import { generateScheduleAlerts } from '@/lib/alertEngine';
import { generateResourceConflictAlerts } from '@/lib/resourceConflictEngine';
import { calculateBaselineVariances, calculatePerformanceTrend, generateTrendAlerts } from '@/lib/trendEngine';
import { calculateControlHealth } from '@/lib/controlHealthEngine';
import { calculateRecoveryPlan } from '@/lib/recoveryEngine';
import { simulateScenario } from '@/lib/scenarioEngine';
import { generateSCurveData } from '@/lib/sCurveEngine';
import { analyzeScheduleControl } from '@/lib/scheduleControlEngine';
import { analyzeCostControl } from '@/lib/costControlEngine';
import { analyzeIntegratedDecisions } from '@/lib/integratedDecisionEngine';
// F8: forecast accuracy, trends & confidence — a trust layer quoting F5/F6/F7 (no new math).
import { analyzeForecastTrust } from '@/lib/forecastTrustEngine';
import type { ReliabilityClass } from '@/lib/forecastTrustEngine';
// GAP-010: the FIDIC 20.1 notice generator works on the governed Data Date, not on a literal clock.
import { calendarDaysBetween, isAfterDataDate, isIsoDate, resolveDataDate } from '@/lib/chronologyGuard';
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

/** F8: shared badge palette for High/Medium/Low confidence levels. */
function confBadgeClass(level: string): string {
  return level === 'High' || level === 'reliable'
    ? 'bg-emerald-100 text-emerald-800'
    : level === 'Medium' || level === 'usable_with_caution'
    ? 'bg-amber-100 text-amber-800'
    : level === 'Low' || level === 'weak'
    ? 'bg-rose-100 text-rose-800'
    : 'bg-slate-200 text-slate-600';
}

/** F8: shared badge palette for trend directions (adverse = rose, favorable = emerald, else slate). */
function trendBadgeClass(direction: string): string {
  return ['slipping', 'worsening', 'eroding', 'deteriorating', 'declining'].includes(direction)
    ? 'bg-rose-100 text-rose-700'
    : ['recovering', 'improving'].includes(direction)
    ? 'bg-emerald-100 text-emerald-700'
    : 'bg-slate-100 text-slate-600';
}

export default function Dashboard({ project, onNavigate }: DashboardProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [costTransactions, setCostTransactions] = useState<CostTransaction[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  // F5: control inputs — the links fetch already existed; snapshots are new.
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [snapshots, setSnapshots] = useState<ScheduleUpdateSnapshot[]>([]);
  // F6: cost-strip inputs (packages/schedule linkage stay in BudgetView; the strip is N/A-safe).
  const [costWbs, setCostWbs] = useState<WbsNode[]>([]);
  const [costAllocations, setCostAllocations] = useState<ActivityBoqAllocation[]>([]);
  const [costSnapshots, setCostSnapshots] = useState<CostControlSnapshot[]>([]);
  const [approvedActualCost, setApprovedActualCost] = useState(0);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<ProjectAlert[]>([]);
  const [error, setError] = useState('');
  const [lang, setLang] = useState<Language>(getLanguage());

  // FIDIC Notice Modal State
  const [showNoticeModal, setShowNoticeModal] = useState(false);
  const [noticeCopied, setNoticeCopied] = useState(false);
  // Chronology (GAP-010 / GAP-038): the incident date defaults to the governed Data Date. The former
  // default dated the event — and the generated letter — after the Data Date, so the dashboard
  // offered a claim for something that had not happened yet and counted the 28-day notice period
  // from a hardcoded pseudo-today.
  const governedDataDate = useMemo(() => resolveDataDate(project), [project]);

  const [noticeForm, setNoticeForm] = useState({
    eventType: 'delayed_drawings',
    eventTitle: 'تأخر اعتماد المخططات التنفيذية لمسارات دكت التكييف وشبكات الحريق',
    incidentDate: resolveDataDate(project),
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
    const handleDataDateChange = (e: any) => {
      if (project && (!e.detail?.projectId || e.detail.projectId === project.id)) {
        loadData();
      }
    };

    window.addEventListener('app-language-changed', handleLangChange);
    window.addEventListener('project-data-date-changed', handleDataDateChange);
    return () => {
      window.removeEventListener('app-language-changed', handleLangChange);
      window.removeEventListener('project-data-date-changed', handleDataDateChange);
    };
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    setError('');

    try {
      const [actRes, riskRes, issueRes, budgetRes, progRes, costRes, baselineRes, alertsRes, linksRes, assignmentsRes, resourcesRes, boqRes, snapRes, cwbsRes, calRes, csnapRes] = await Promise.all([
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
        supabase.from('schedule_update_snapshots').select('*').eq('project_id', project.id).order('data_date', { ascending: false }).limit(10),
        supabase.from('wbs_nodes').select('*').eq('project_id', project.id),
        supabase.from('activity_boq_allocations').select('*').eq('project_id', project.id),
        supabase.from('cost_control_snapshots').select('*').eq('project_id', project.id).order('data_date', { ascending: false }).limit(10),
      ]);

      // F9 (item 5): supabase-js resolves failed reads with `{ error }` instead of throwing. A failed
      // read must never render as an "empty" dashboard (which reads as "no data"), so the first
      // failed table aborts the load and surfaces a meaningful, table-named error.
      const failedRead = ([
        ['activities', actRes], ['risks', riskRes], ['issues', issueRes], ['budget_lines', budgetRes],
        ['progress_updates', progRes], ['cost_transactions', costRes], ['baseline_activities', baselineRes],
        ['project_alerts', alertsRes], ['activity_links', linksRes], ['activity_resources', assignmentsRes],
        ['resources', resourcesRes], ['boq_items', boqRes], ['schedule_update_snapshots', snapRes],
        ['wbs_nodes', cwbsRes], ['activity_boq_allocations', calRes], ['cost_control_snapshots', csnapRes],
      ] as [string, { error?: { message?: string } | null }][]).find(([, res]) => Boolean(res?.error));
      if (failedRead) {
        const reason = failedRead[1].error?.message || (lang === 'ar' ? 'خطأ غير معروف' : 'unknown database error');
        throw new Error(lang === 'ar'
          ? `تعذر تحميل بيانات لوحة التحكم من جدول [${failedRead[0]}]: ${reason}`
          : `Failed to load dashboard data from [${failedRead[0]}]: ${reason}`);
      }

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
      setLinks(((linksRes as { data?: unknown }).data || []) as ActivityLink[]);
      setSnapshots(((snapRes as { data?: unknown }).data || []) as ScheduleUpdateSnapshot[]);
      setCostWbs((((cwbsRes as { data?: unknown }).data || []) as WbsNode[]));
      setCostAllocations((((calRes as { data?: unknown }).data || []) as ActivityBoqAllocation[]));
      setCostSnapshots((((csnapRes as { data?: unknown }).data || []) as CostControlSnapshot[]));
      setAlerts((alertsRes.data || []) as ProjectAlert[]);
    } catch (err: any) {
      // F9 (item 5): the failure is surfaced in the UI (banner below the header), not only logged —
      // a silent catch would render a healthy-looking but empty dashboard.
      console.error('Error loading dashboard:', err);
      setError(err?.message || (lang === 'ar' ? 'تعذر تحميل بيانات لوحة التحكم.' : 'Failed to load dashboard data.'));
    } finally {
      setLoading(false);
    }
  }

  // Re-anchor the incident date when another project becomes active, so a date from the previous
  // project can never be carried into a new claim notice.
  useEffect(() => {
    setNoticeForm((prev) => ({ ...prev, incidentDate: governedDataDate }));
  }, [governedDataDate]);

  // 28-day FIDIC 20.1 deadline. An unusable incident date yields null (rendered as N/A) instead of a
  // fabricated deadline.
  const noticeDeadlineDate = useMemo<string | null>(() => {
    if (!isIsoDate(noticeForm.incidentDate)) return null;
    const deadline = new Date(`${noticeForm.incidentDate}T00:00:00Z`);
    deadline.setUTCDate(deadline.getUTCDate() + 28);
    return deadline.toISOString().split('T')[0];
  }, [noticeForm.incidentDate]);

  // Days left of the notice period, counted from the governed Data Date — the only "today" a project
  // control screen is allowed to use.
  const daysRemainingToClaim = useMemo<number | null>(() => {
    if (!noticeDeadlineDate) return null;
    const remaining = calendarDaysBetween(governedDataDate, noticeDeadlineDate);
    return remaining === null ? null : Math.max(0, remaining);
  }, [noticeDeadlineDate, governedDataDate]);

  const generatedNoticeText = useMemo(() => {
    return `إلى: المهندس الاستشاري / ${noticeForm.engineerName}
نسخة إلى: صاحب العمل / ${noticeForm.employerName}
من: المقاول الرئيسي / ${noticeForm.contractorName}
اسم المشروع: ${project?.name || 'مشروع البرج المكتبي التجاري'}
التاريخ: ${governedDataDate}
المرجع: CONTRACT-NOTICE-FIDIC20.1-EOT-${noticeForm.incidentDate.replace(/-/g, '')}

الموضوع: إخطار تعاقدي رسمي بوقوع حدث تأخير ومطالبة بتمديد الوقت والتكاليف غير المباشرة (Notice of Claim under FIDIC Red Book Clause 20.1 & Clause 8.4)

تحية طيبة وبعد،،،

عملاً بأحكام المادة 20.1 [مطالبات المقاول] من شروط العقد، نود إخطاركم رسمياً بوقوع حدث يعطي المقاول الحق في تمديد مدة الإنجاز (Extension of Time) والحصول على تعويض مالي للتكاليف غير المباشرة:

1. وصف الحدث والمسبب: ${noticeForm.eventTitle}
2. تاريخ وقوع الحدث أو العلم به: ${noticeForm.incidentDate}
3. السند التعاقدي للمطالبة: ${noticeForm.clauseReference}
4. الأثر الزمني المتوقع على المسار الحرج (CPM): تمديد مدة الإنجاز بمقدار ${noticeForm.timeExtensionDays} يوماً تقويمياً.
5. التكاليف الإضافية غير المباشرة المطالب بها: ${noticeForm.financialClaimSar.toLocaleString()} ريال سعودي.

نحيطكم علماً بأن المقاول ملتزم بالمهلة الزمنية التعاقدية (28 يوماً من تاريخ العلم بالحدث حتى تاريخ ${noticeDeadlineDate ?? 'غير قابل للاحتساب (N/A)'})، وسيقوم فريق التخطيط والتحليل بتقديم الملف التوثيقي التفصيلي وشبكة الأثر الزمني (Fragnet TIA Analysis) والسجلات المؤيدة خلال المهلة النظامية المحددة (42 يوماً).

وتفضلوا بقبول فائق الاحترام والتقدير،،،

مدير المشروع / إدارة العقود والمطالبات
${noticeForm.contractorName}`;
  }, [noticeForm, noticeDeadlineDate, governedDataDate, project]);

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

  const openRisks = risks.filter((r) => r.status === 'open').length;
  const highRisks = risks.filter((r) => r.severity >= 15).length;
  const openIssues = issues.filter((i) => i.status === 'open').length;

  // F5: schedule-control summary (forecast vs baseline) derived from the canonical statused CPM.
  const control = useMemo(() => {
    if (!project) return null;
    const ordered = [...snapshots].sort((a, b) => (a.data_date < b.data_date ? 1 : -1));
    return analyzeScheduleControl({
      activities,
      links,
      baselines: baselineActivities,
      progressUpdates,
      previousSnapshot: ordered.find((x) => x.data_date < governedDataDate) || null,
      dataDate: governedDataDate,
      calendarType: project.calendar_type || '6_days',
      statusLogic: project.status_logic || 'retained_logic',
    });
  }, [project, activities, links, baselineActivities, progressUpdates, snapshots, governedDataDate]);
  // F6: cost-control strip (CPI, CV, recommended EAC, VAC, forecast confidence).
  const costStrip = useMemo(() => {
    if (!project) return null;
    return analyzeCostControl({
      project,
      activities,
      baselines: baselineActivities,
      budgetLines,
      costTransactions,
      progressUpdates,
      wbsNodes: costWbs,
      boqItems,
      allocations: costAllocations,
      previousSnapshots: costSnapshots,
      dataDate: governedDataDate,
      calendarType: project.calendar_type || '6_days',
      manualEtc: typeof project.manual_etc_override === 'number' ? project.manual_etc_override : null,
    });
  }, [project, activities, baselineActivities, budgetLines, costTransactions, progressUpdates, costWbs, boqItems, costAllocations, costSnapshots, governedDataDate]);

  // F9.4 (Controlled Pilot defect 4) — canonical criticality, quoted from F5.
  //
  // These two counts used to be read off the PERSISTED `activities.is_critical` / `total_float`
  // columns, which are a cached snapshot of some earlier CPM run (or, in seed data, hand-authored).
  // The pilot showed the same project reporting 9 critical activities where the canonical statused
  // CPM said 6: three 100%-complete activities were still flagged critical in the column, and
  // finished work does not drive the remaining critical path. The old `criticalActivities` also
  // carried an extra `percent_complete < 100` filter, so it was really an INCOMPLETE subset wearing
  // the "Critical Activities" label — it agreed with the canonical total only by coincidence.
  //
  // F5 is canonical for the schedule-control layer, so both figures are now quoted from its report:
  // `project.criticalCount` for the total, and the explicitly separate remaining/incomplete subset
  // derived from the same statused rows. Same label, same source, same number everywhere.
  const criticalActivities = control ? control.project.criticalCount : 0;
  const remainingCriticalActivities = control
    ? control.statused.filter((s) => s.critical && !s.completed).length
    : 0;
  const nearCriticalActivities = control ? control.project.nearCriticalCount : 0;

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

  // F9.4 (Controlled Pilot defect 1) — canonical EVM, quoted from the F6 cost-control report above.
  //
  // The Controlled Pilot read two different answers for the same project at the same governed Data
  // Date: F6 showed EV 755,708 / CPI 1.095 / EAC 2,141,689.5 while this dashboard's EVM block and
  // the Executive Report showed EV 276,918 / CPI 0.400 / EAC 5,862,875. The dashboard was running
  // `calculateProjectEvmAtDataDate` beside its own F6 report — a second derivation that weights each
  // activity by the FIRST budget line matching its WBS node (shared in full by every activity in the
  // node) and time-prorates the recorded percent, while F6 weights by the approved baseline's
  // `planned_cost`. F8 already quotes F6, so the dashboard was the odd one out.
  //
  // `quoteCanonicalEvm` copies F6's published BAC/PV/EV/AC/CPI/SPI/ETC/EAC/VAC verbatim and derives
  // nothing of its own. With no project selected `costStrip` is null and the result is the explicit
  // all-N/A canonical state — no fabricated budget, ratios flagged 'empty_no_data'.
  const evm = useMemo(() => quoteCanonicalEvm(costStrip), [costStrip]);

  // GAP-039: the primary project progress metric on this dashboard is the canonical earned
  // progress (EV / BAC) from the shared engine. The deprecated `actualProgressPercent` alias it used
  // to be read through no longer exists (Wave 11 removed the duplicate field), so this is now the
  // only name for the value — identical to what ProgressView / BudgetView / ExecutiveReportView /
  // PortfolioView read.
  const overallProgress = evm.earnedProgressPercent;
  const plannedProgress = evm.plannedProgressPercent / 100;
  const plannedBudget = evm.bac;
  const actualCost = evm.ac;

  const committedCost = useMemo(() => {
    return budgetLines.reduce((sum, b) => sum + (b.committed_cost || 0), 0);
  }, [budgetLines]);

  const remainingBudget = plannedBudget - actualCost;
  const budgetUtilization = plannedBudget > 0 ? (actualCost / plannedBudget) * 100 : 0;

  // Phase A: the forecast anchors on the governed Data Date, passed explicitly. The machine
  // clock no longer participates: same project + same Data Date => same forecast, always.
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
      governedDataDate,
      risks,
    );
  }, [startDate, endDate, plannedBudget, actualCost, overallProgress, evm.spi, evm.cpi, criticalActivities, nearCriticalActivities, governedDataDate, risks]);

  // F9 (acceptance A): baseline variance is evaluated at the governed Data Date, never at the
  // machine clock — this count feeds behindBaselineCount and the control-health score.
  const baselineVariances = useMemo(
    () => calculateBaselineVariances(activities, baselineActivities, new Date(`${governedDataDate}T00:00:00Z`)),
    [activities, baselineActivities, governedDataDate],
  );
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
      // No explicit cutoff: the engine uses the canonical EVM's own governed data date, so the
      // actual series ends exactly at the Data Date instead of at the machine clock.
      null,
      // GAP-006: canonical sources for planned-value weighting and BAC reconciliation.
      { project, budgetLines, boqItems },
    );
  }, [activities, baselineActivities, progressUpdates, costTransactions, evm, project, startDate, endDate, budgetLines, boqItems]);

  // F7: integrated time-cost decisions (orchestrates the F5 + F6 reports above; no new math).
  const decisions = useMemo(() => {
    if (!project || !control || !costStrip) return null;
    const orderedSched = [...snapshots].sort((a, b) => (a.data_date < b.data_date ? 1 : -1));
    const orderedCost = [...costSnapshots].sort((a, b) => (a.data_date < b.data_date ? 1 : -1));
    return analyzeIntegratedDecisions({
      scheduleReport: control,
      costReport: costStrip,
      activities,
      links,
      baselines: baselineActivities,
      progressUpdates,
      previousScheduleSnapshot: orderedSched.find((x) => x.data_date < governedDataDate) || null,
      previousCostSnapshot: orderedCost.find((x) => x.data_date < governedDataDate) || null,
      dataDate: governedDataDate,
      calendarType: project.calendar_type || '6_days',
      statusLogic: project.status_logic || 'retained_logic',
    });
  }, [project, control, costStrip, activities, links, baselineActivities, progressUpdates, snapshots, costSnapshots, governedDataDate]);
  // F8: forecast trust — accuracy vs outcomes, trend quality, data-quality scores, capped confidence,
  // stale-data and integrity findings, reliability classes, calibration and accuracy KPIs. It quotes
  // the F5/F6/F7 reports above and never recomputes their numbers; missing evidence renders as N/A.
  const trust = useMemo(() => {
    if (!project || !control || !costStrip) return null;
    return analyzeForecastTrust({
      scheduleReport: control,
      costReport: costStrip,
      decisionReport: decisions,
      activities,
      links,
      baselines: baselineActivities,
      progressUpdates,
      costTransactions,
      boqItems,
      allocations: costAllocations,
      scheduleSnapshots: snapshots,
      costSnapshots,
      dataDate: governedDataDate,
      calendarType: project.calendar_type || '6_days',
    });
  }, [project, control, costStrip, decisions, activities, links, baselineActivities, progressUpdates, costTransactions, boqItems, costAllocations, snapshots, costSnapshots, governedDataDate]);
  const cappedActionByIssue = new Map((trust ? trust.decisionConfidence.actions : []).map((a) => [a.issueId, a]));
  const controlDelay = control ? control.project.totalDelayWd : null;
  const controlSlipped = control ? control.milestones.filter((m) => m.state === 'slipped').length : 0;

  // F8: display vocabulary for directions, reliability classes and quality domains (inline, like
  // the rest of the dashboard's bilingual labels).
  const dirAr: Record<string, string> = {
    slipping: 'انزلاق', recovering: 'تعافٍ', holding: 'ثبات', insufficient: 'غير كافٍ',
    eroding: 'تآكل', improving: 'تحسّن', stable: 'مستقر', worsening: 'تدهور',
    deteriorating: 'تدهور', declining: 'انحدار', optimistic: 'متفائل', pessimistic: 'متشائم',
    neutral: 'محايد', mixed: 'مختلط',
  };
  const dirLabel = (d: string): string => (lang === 'ar' ? dirAr[d] || d : d);
  const relAr: Record<ReliabilityClass, string> = {
    reliable: 'موثوق', usable_with_caution: 'قابل للاستخدام بحذر', weak: 'ضعيف', not_supportable: 'غير قابل للدعم',
  };
  const relLabel = (c: ReliabilityClass): string => (lang === 'ar' ? relAr[c] : c);
  const domAr: Record<string, string> = {
    schedule: 'الجدول', progress: 'التقدم', cost: 'التكلفة', baseline: 'خط الأساس', forecast: 'التنبؤ',
  };
  // F8: one presentation list over integrity (already severity-sorted by the engine) + stale data.
  const trustFindings = trust ? [
    ...trust.integrity.map((x) => ({ severity: x.severity, code: `${x.source}/${x.code}`, message: x.message, evidence: x.evidence })),
    ...trust.stale.map((s) => ({ severity: s.severity, code: s.code, message: s.message, evidence: s.evidence })),
  ] : [];

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
      // F9.4 (defect 4): the headline number is the canonical TOTAL critical count (F5's
      // `project.criticalCount`, from the statused CPM at the governed Data Date). The incomplete
      // subset is still useful, so it is shown beside it under its own explicit name instead of
      // being passed off as the total — which is what the old `is_critical && percent_complete < 100`
      // filter did.
      label: t.critical_activities,
      value: `${criticalActivities}`,
      icon: Zap,
      bg: 'bg-red-50',
      text: 'text-red-600',
      subtext: lang === 'ar'
        ? `على المسار الحرج · الحرجة غير المكتملة ${remainingCriticalActivities}`
        : `On Critical Path · ${remainingCriticalActivities} remaining incomplete`,
    },
    {
      label: lang === 'ar' ? 'تأخير النهاية المتوقعة' : 'Forecast delay',
      value: controlDelay !== null ? `${controlDelay > 0 ? '+' : ''}${controlDelay}d` : 'N/A',
      icon: Clock,
      bg: controlDelay !== null && controlDelay > 0 ? 'bg-red-50' : 'bg-emerald-50',
      text: controlDelay !== null && controlDelay > 0 ? 'text-red-600' : 'text-emerald-600',
      subtext: control && control.project.forecastFinish
        ? `${control.project.forecastFinish} · ${controlSlipped} ${lang === 'ar' ? 'معالم متأخرة' : 'milestones slipped'}`
        : (lang === 'ar' ? 'لا خط أساس للمقارنة' : 'No baseline to compare'),
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
      {/* F9 (item 5): a failed data load is announced — never rendered as a silent empty dashboard. */}
      {error && (
        <div className="flex items-start gap-3 bg-rose-50 border border-rose-300 text-rose-800 rounded-xl p-4 text-sm">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-600" />
          <div>
            <p className="font-bold">{lang === 'ar' ? 'تعذر تحميل بعض بيانات لوحة التحكم' : 'Dashboard data failed to load'}</p>
            <p className="mt-0.5 break-words">{error}</p>
          </div>
        </div>
      )}
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
                {daysRemainingToClaim === null
                  ? 'المهلة غير قابلة للاحتساب (N/A): تاريخ وقوع الحدث غير صالح أو غير محدد.'
                  : `متبقي ${daysRemainingToClaim} يوماً على المهلة القصوى (28 يوماً) لإرسال إخطار المطالبة رسمياً للاستشاري، محسوبة من تاريخ خط الحالة ${governedDataDate}.`}
              </p>
            </div>
            <div className="pt-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-purple-800 font-bold border-t border-purple-200">
              <span>المهلة: {noticeDeadlineDate ?? 'غير قابلة للاحتساب (N/A)'}</span>
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

      {/* F6: Cost Control strip — five decision numbers, no clutter. */}
      {costStrip && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
            <div>
              <span className="text-[11px] text-slate-500 font-bold block">CPI</span>
              <span className={`text-lg font-black font-mono ${costStrip.project.cpi !== null && costStrip.project.cpi < 0.9 ? 'text-rose-700' : 'text-slate-900'}`}>
                {costStrip.project.cpi !== null ? costStrip.project.cpi : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-[11px] text-slate-500 font-bold block">CV</span>
              <span className={`text-lg font-black font-mono ${costStrip.project.cv !== null && costStrip.project.cv < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                {costStrip.project.cv !== null ? costStrip.project.cv.toLocaleString() : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'EAC الموصى به' : 'Recommended EAC'}</span>
              <span className="text-lg font-black font-mono text-slate-900">
                {costStrip.project.eac !== null ? costStrip.project.eac.toLocaleString() : 'N/A'}
              </span>
              <span className="text-[10px] text-slate-400 block font-mono">{costStrip.recommended ? costStrip.recommended.method : costStrip.recommendedNote}</span>
            </div>
            <div>
              <span className="text-[11px] text-slate-500 font-bold block">VAC</span>
              <span className={`text-lg font-black font-mono ${costStrip.project.vac !== null && costStrip.project.vac < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                {costStrip.project.vac !== null ? costStrip.project.vac.toLocaleString() : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'ثقة التنبؤ' : 'Forecast confidence'}</span>
              <span className={`inline-block mt-1 px-3 py-1 rounded-full text-xs font-bold ${costStrip.confidence.forecast.level === 'High' ? 'bg-emerald-100 text-emerald-800' : costStrip.confidence.forecast.level === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>
                {costStrip.confidence.forecast.level}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* F7: Integrated time-cost decision support (summary + top actions + matrix). */}
      {decisions && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-4">
          <div>
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <Scale size={18} className="text-slate-500" />
              {lang === 'ar' ? 'ملخص القرار المتكامل (زمن + تكلفة)' : 'Integrated Decision Summary (Time + Cost)'}
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${decisions.summary.overallConfidence === 'High' ? 'bg-emerald-100 text-emerald-800' : decisions.summary.overallConfidence === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>
                {decisions.summary.overallConfidence}
              </span>
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-center">
              <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'النهاية المتوقعة' : 'Forecast finish'}</span>
                <span className="text-sm font-black font-mono text-slate-900">{decisions.summary.forecastFinish || 'N/A'}</span>
                <span className="text-[10px] text-slate-400 block font-mono">
                  {decisions.summary.delayVsBaselineWd !== null ? `${decisions.summary.delayVsBaselineWd > 0 ? '+' : ''}${decisions.summary.delayVsBaselineWd}d` : 'N/A'}
                </span>
              </div>
              <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-[11px] text-slate-500 font-bold block">EAC</span>
                <span className="text-sm font-black font-mono text-slate-900">{decisions.summary.recommendedEac !== null ? decisions.summary.recommendedEac.toLocaleString() : 'N/A'}</span>
                <span className="text-[10px] text-slate-400 block font-mono">VAC {decisions.summary.vac !== null ? decisions.summary.vac.toLocaleString() : 'N/A'}</span>
              </div>
              <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 col-span-2 sm:col-span-1">
                <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'أعلى مخاطرة' : 'Top risk'}</span>
                <span className="text-xs font-bold text-slate-900">{decisions.summary.topRisk || '—'}</span>
              </div>
              <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 col-span-2 sm:col-span-1">
                <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'القرار المطلوب' : 'Top decision'}</span>
                <span className="text-xs font-bold text-slate-900">{decisions.summary.topDecision || '—'}</span>
              </div>
            </div>
          </div>

          {decisions.actions.length > 0 && (
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">{lang === 'ar' ? 'أهم القرارات' : 'Top decisions'}</h4>
              <ol className="space-y-2">
                {decisions.actions.map((a) => {
                  // F8: the effective confidence is the F7 level re-capped by the integrated forecast
                  // confidence (weakest source). F7 output itself is never modified.
                  const cap = cappedActionByIssue.get(a.issueId);
                  return (
                  <li key={a.issueId} className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="w-5 h-5 rounded-full bg-slate-900 text-amber-400 text-[10px] font-black flex items-center justify-center">{a.rank}</span>
                      <span className="font-black text-slate-900">{a.title}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${a.confidence === 'High' ? 'bg-emerald-100 text-emerald-800' : a.confidence === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>
                        {a.confidence}
                      </span>
                      {cap && cap.effectiveConfidence !== cap.reportedConfidence && (
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${confBadgeClass(cap.effectiveConfidence)}`} title={cap.cappedBy}>
                          {lang === 'ar' ? 'فعّالة' : 'effective'} {cap.effectiveConfidence}
                        </span>
                      )}
                      {cap && !cap.strongRecommendationAllowed && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-700">
                          {lang === 'ar' ? 'تحقيق فقط — لا توصية قوية من بيانات منخفضة الثقة' : 'investigate only — no strong recommendation on Low-confidence data'}
                        </span>
                      )}
                    </div>
                    <p className="text-slate-600 mt-1 font-mono text-[11px]">{a.evidence.slice(0, 4).join(' · ')}</p>
                    {a.rootCause && <p className="text-slate-600 text-[11px]"><span className="font-bold">Cause:</span> {a.rootCause.category} ({a.rootCause.confidence})</p>}
                    <p className="text-slate-800 mt-0.5"><span className="font-bold">Action:</span> {a.recommendedAction}</p>
                    <p className="text-slate-600 text-[11px]"><span className="font-bold">Benefit:</span> {a.expectedBenefit ? `−${a.expectedBenefit.daysSaved}d${a.expectedBenefit.costDelta !== null ? `, ${a.expectedBenefit.costDelta.toLocaleString()} SAR` : ''}` : a.expectedBenefitNote}</p>
                    {cap && cap.evidenceGaps.length > 0 && (
                      <p className="text-amber-700 text-[11px] mt-0.5"><span className="font-bold">{lang === 'ar' ? 'فجوات الأدلة' : 'Evidence gaps'}:</span> {cap.evidenceGaps.join(' · ')}</p>
                    )}
                  </li>
                  );
                })}
              </ol>
            </div>
          )}

          {decisions.warnings.length > 0 && (
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">{lang === 'ar' ? 'إنذار مبكر' : 'Early warnings'}</h4>
              <ul className="space-y-1.5">
                {decisions.warnings.map((w, i) => (
                  <li key={`${w.code}-${w.activityCode || 'p'}-${i}`} className="p-2.5 bg-amber-50/60 rounded-xl border border-amber-200 text-xs text-slate-700">
                    <span className="font-mono font-bold">{w.code}</span> — {w.message}
                    <span className="text-slate-500 font-mono text-[11px] block">{w.evidence.join(' · ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 className="text-xs font-black text-slate-800 mb-2">{lang === 'ar' ? 'مصفوفة الزمن والتكلفة' : 'Time-cost matrix'}</h4>
            <div className="overflow-x-auto border border-slate-200 rounded-xl max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b sticky top-0">
                  <tr>
                    <th className="p-2 text-right">{lang === 'ar' ? 'البند' : 'Item'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'النوع' : 'Scope'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'التصنيف' : 'Class'}</th>
                    <th className="p-2 text-right">{lang === 'ar' ? 'ملاحظات' : 'Notes'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {decisions.matrix.map((m) => (
                    <tr key={`${m.scope}-${m.id}`} className="hover:bg-slate-50">
                      <td className="p-2 font-bold text-slate-900 font-mono">{m.code} <span className="font-sans font-normal text-slate-500">{m.name.slice(0, 28)}</span></td>
                      <td className="p-2 text-center text-slate-500">{m.scope}</td>
                      <td className="p-2 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          m.class === 'on_track' ? 'bg-emerald-100 text-emerald-800'
                          : m.class === 'time_cost_risk' ? 'bg-rose-100 text-rose-800'
                          : m.class === 'data_insufficient' ? 'bg-slate-200 text-slate-600'
                          : 'bg-amber-100 text-amber-800'
                        }`}>
                          {m.class}
                        </span>
                      </td>
                      <td className="p-2 text-slate-500 font-mono text-[11px]">{m.notes.join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* F8: Forecast trust — accuracy, trends, data quality, capped confidence (quotes F5/F6/F7). */}
      {trust && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <ShieldCheck size={18} className="text-slate-500" />
              {lang === 'ar' ? 'ثقة التنبؤات ودقتها وجودة البيانات' : 'Forecast Trust, Accuracy & Data Quality'}
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${confBadgeClass(trust.confidence.integrated.level)}`}>
                {trust.confidence.integrated.level}
              </span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${confBadgeClass(trust.reliability[2].class)}`} title={trust.reliability[2].reasons.join(' · ')}>
                {relLabel(trust.reliability[2].class)}
              </span>
            </h3>
            <span className="text-[10px] text-slate-400 font-mono" title={trust.confidence.integrated.notes.join(' · ')}>
              {lang === 'ar' ? 'السقف من أضعف مصدر' : 'capped by weakest source'}: {trust.confidence.integrated.cappedBy}
            </span>
          </div>

          {/* Executive trust summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'النهاية المتوقعة' : 'Forecast finish'}</span>
              <span className="text-sm font-black font-mono text-slate-900">{trust.trust.forecastFinish || 'N/A'}</span>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${confBadgeClass(trust.trust.forecastConfidence)}`} title={trust.reliability[0].reasons.join(' · ')}>
                {trust.trust.forecastConfidence} · {relLabel(trust.reliability[0].class)}
              </span>
            </div>
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[11px] text-slate-500 font-bold block">EAC</span>
              <span className="text-sm font-black font-mono text-slate-900">{trust.trust.eac !== null ? trust.trust.eac.toLocaleString() : 'N/A'}</span>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${confBadgeClass(trust.trust.costForecastConfidence)}`} title={trust.reliability[1].reasons.join(' · ')}>
                {trust.trust.costForecastConfidence} · {relLabel(trust.reliability[1].class)}
              </span>
            </div>
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'جودة البيانات الإجمالية' : 'Overall data quality'}</span>
              <span className="text-sm font-black font-mono text-slate-900">{trust.trust.overallDataQuality.score}</span>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${confBadgeClass(trust.trust.overallDataQuality.level)}`}>
                {trust.trust.overallDataQuality.level}
              </span>
            </div>
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 text-right">
              <span className="text-[11px] text-slate-500 font-bold block">{lang === 'ar' ? 'أعلى مخاطرة بيانات' : 'Top data risk'}</span>
              <span className="text-[11px] font-bold text-slate-800 block">{trust.trust.topDataRisk || (lang === 'ar' ? 'لا مخاطرة مرصودة' : 'none detected')}</span>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 font-mono">
            {lang === 'ar' ? 'أدق مؤشر' : 'Most reliable KPI'}: {trust.trust.mostReliableKpi ? `${trust.trust.mostReliableKpi.key} (${trust.trust.mostReliableKpi.level})` : 'N/A'}
            {' · '}
            {lang === 'ar' ? 'أضعف مؤشر' : 'Least reliable KPI'}: {trust.trust.leastReliableKpi ? `${trust.trust.leastReliableKpi.key} (${trust.trust.leastReliableKpi.level})` : 'N/A'}
            {' · '}
            {lang === 'ar' ? 'الانحياز' : 'Bias'}: <span title={trust.accuracy.bias.reason}>{dirLabel(trust.accuracy.bias.direction)}</span>
            {' · '}
            {lang === 'ar' ? 'المعايرة التاريخية' : 'Calibration'}: <span title={trust.calibration.overall.reason}>{trust.calibration.overall.classification ? dirLabel(trust.calibration.overall.classification) : 'N/A'}</span>
          </p>

          {/* Accuracy KPIs — each tile is N/A with its stated reason when evidence is insufficient */}
          <div>
            <h4 className="text-xs font-black text-slate-800 mb-2">{lang === 'ar' ? 'مؤشرات دقة التنبؤ (تُعرض فقط عند كفاية البيانات)' : 'Accuracy KPIs (published only with sufficient evidence)'}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              {[
                { label: lang === 'ar' ? 'متوسط خطأ تنبؤ النهاية' : 'MAE finish forecast', k: trust.accuracyKpis.maeFinishForecastWd, fmt: (v: number) => `${v} wd` },
                { label: lang === 'ar' ? 'نسبة إصابة المعالم' : 'Milestone hit rate', k: trust.accuracyKpis.milestoneHitRatePct, fmt: (v: number) => `${v}%` },
                { label: lang === 'ar' ? 'خطأ تنبؤ EAC' : 'EAC forecast error', k: trust.accuracyKpis.eacForecastErrorPct, fmt: (v: number) => `${v > 0 ? '+' : ''}${v}%` },
                { label: lang === 'ar' ? 'انحراف النهاية لكل تحديث' : 'Finish drift / update', k: trust.accuracyKpis.forecastDriftPerUpdateWd, fmt: (v: number) => `${v} wd` },
              ].map((tile) => (
                <div key={tile.label} className="p-2 bg-slate-50 rounded-xl border border-slate-200" title={tile.k.reason}>
                  <span className="text-[10px] text-slate-500 font-bold block">{tile.label}</span>
                  <span className={`text-sm font-black font-mono ${tile.k.value === null ? 'text-slate-400' : 'text-slate-900'}`}>
                    {tile.k.value !== null ? tile.fmt(tile.k.value) : 'N/A'}
                  </span>
                  <span className="text-[9px] text-slate-400 block font-mono">{tile.k.samples} {lang === 'ar' ? 'عينة' : 'sample(s)'}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5 font-mono" title={[...trust.accuracy.finish.evidence, ...trust.accuracy.etc.evidence].join(' · ')}>
              {lang === 'ar' ? 'خطأ النهاية مقابل النتيجة' : 'Finish error vs outcome'}: {trust.accuracy.finish.errorWd !== null ? `${trust.accuracy.finish.errorWd > 0 ? '+' : ''}${trust.accuracy.finish.errorWd} wd` : 'N/A'}
              {' · '}
              {lang === 'ar' ? 'خطأ ETC' : 'ETC error'}: {trust.accuracy.etc.error !== null ? `${trust.accuracy.etc.error > 0 ? '+' : ''}${trust.accuracy.etc.error.toLocaleString()} SAR` : 'N/A'}
              {' · '}
              {lang === 'ar' ? 'خطأ EAC' : 'EAC error'}: {trust.accuracy.eac.error !== null ? `${trust.accuracy.eac.error > 0 ? '+' : ''}${trust.accuracy.eac.error.toLocaleString()} SAR` : 'N/A'}
            </p>
          </div>

          {/* Trend quality chips */}
          <div>
            <h4 className="text-xs font-black text-slate-800 mb-2">{lang === 'ar' ? 'جودة الاتجاهات عبر اللقطات' : 'Trend quality across snapshots'} <span className="font-normal text-slate-400">({trust.trends.evaluableCount}/{trust.trends.totalCount})</span></h4>
            <div className="flex flex-wrap gap-2">
              {[
                { label: lang === 'ar' ? 'انحراف النهاية' : 'Finish', d: trust.trends.finish.direction, v: trust.trends.finish.totalDriftWd !== null ? `${trust.trends.finish.totalDriftWd > 0 ? '+' : ''}${trust.trends.finish.totalDriftWd} wd` : null, t: trust.trends.finish.reason },
                { label: lang === 'ar' ? 'السماح العائم' : 'Float', d: trust.trends.float.direction, v: trust.trends.float.meanDeltaTfWd !== null ? `${trust.trends.float.meanDeltaTfWd > 0 ? '+' : ''}${trust.trends.float.meanDeltaTfWd} wd` : null, t: trust.trends.float.reason },
                { label: 'CPI', d: trust.trends.cpi.direction, v: trust.trends.cpi.delta !== null ? `${trust.trends.cpi.delta > 0 ? '+' : ''}${trust.trends.cpi.delta}` : null, t: trust.trends.cpi.reason },
                { label: 'SPI', d: trust.trends.spi.direction, v: trust.trends.spi.delta !== null ? `${trust.trends.spi.delta > 0 ? '+' : ''}${trust.trends.spi.delta}` : null, t: trust.trends.spi.reason },
                { label: lang === 'ar' ? 'انحراف EAC' : 'EAC drift', d: trust.trends.eac.direction, v: trust.trends.eac.latestDriftFromF6 !== null ? `${trust.trends.eac.latestDriftFromF6 > 0 ? '+' : ''}${trust.trends.eac.latestDriftFromF6.toLocaleString()}` : null, t: trust.trends.eac.reason },
                { label: 'VAC', d: trust.trends.vac.direction, v: trust.trends.vac.change !== null ? `${trust.trends.vac.change > 0 ? '+' : ''}${trust.trends.vac.change.toLocaleString()}` : null, t: trust.trends.vac.reason },
              ].map((chip) => (
                <span key={chip.label} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${trendBadgeClass(chip.d)}`} title={chip.t}>
                  {chip.label}: {dirLabel(chip.d)}{chip.v !== null ? <span className="font-mono font-normal">{chip.v}</span> : null}
                </span>
              ))}
            </div>
          </div>

          {/* Data-quality scores per domain */}
          <div>
            <h4 className="text-xs font-black text-slate-800 mb-2">{lang === 'ar' ? 'جودة البيانات حسب المجال' : 'Data quality by domain'}</h4>
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b">
                  <tr>
                    <th className="p-2 text-right">{lang === 'ar' ? 'المجال' : 'Domain'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'الاكتمال' : 'Complete'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'الحداثة' : 'Fresh'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'الاتساق' : 'Consistent'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'التتبع' : 'Traceable'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'الدرجة' : 'Score'}</th>
                    <th className="p-2 text-center">{lang === 'ar' ? 'الثقة' : 'Level'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {trust.dataQuality.domains.map((d) => (
                    <tr key={d.key} className="hover:bg-slate-50" title={d.notes.join(' · ')}>
                      <td className="p-2 font-bold text-slate-900">{lang === 'ar' ? domAr[d.key] || d.key : d.key}</td>
                      <td className="p-2 text-center font-mono text-slate-600">{d.completeness}</td>
                      <td className="p-2 text-center font-mono text-slate-600">{d.freshness}</td>
                      <td className="p-2 text-center font-mono text-slate-600">{d.consistency}</td>
                      <td className="p-2 text-center font-mono text-slate-600">{d.traceability}</td>
                      <td className="p-2 text-center font-mono font-black text-slate-900">{d.score}</td>
                      <td className="p-2 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${confBadgeClass(d.level)}`}>{d.level}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Stale-data + integrity findings (evidence-based; capped list) */}
          {trustFindings.length > 0 && (
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">
                {lang === 'ar' ? 'نتائج البيانات (تكامل وقِدم)' : 'Data findings (integrity & staleness)'}
                <span className="font-normal text-slate-400"> ({trustFindings.length})</span>
              </h4>
              <ul className="space-y-1.5">
                {trustFindings.slice(0, 6).map((x, i) => (
                  <li key={`${x.code}-${i}`} className={`p-2.5 rounded-xl border text-xs text-slate-700 ${x.severity === 'error' ? 'bg-rose-50/70 border-rose-200' : x.severity === 'warning' ? 'bg-amber-50/60 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
                    <span className="font-mono font-bold">{x.code}</span> — {x.message}
                    <span className="text-slate-500 font-mono text-[11px] block">{x.evidence.slice(0, 3).join(' · ')}</span>
                  </li>
                ))}
                {trustFindings.length > 6 && (
                  <li className="text-[11px] text-slate-400 font-mono">+{trustFindings.length - 6} {lang === 'ar' ? 'نتيجة إضافية' : 'more finding(s)'}</li>
                )}
              </ul>
            </div>
          )}
          {trust.decisionConfidence.blockedStrongCount > 0 && (
            <p className="text-[11px] text-amber-700 font-bold">
              {lang === 'ar'
                ? `${trust.decisionConfidence.blockedStrongCount} من التوصيات محجوبة عن القوة: الثقة الفعّالة منخفضة — تحقيق وجمع أدلة فقط.`
                : `${trust.decisionConfidence.blockedStrongCount} recommendation(s) blocked from strong wording: effective confidence is Low — investigate and collect evidence only.`}
            </p>
          )}
        </div>
      )}

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
                <p className="text-[10px] text-slate-500 mt-1">
                  تاريخ خط الحالة المعتمد: <strong className="font-mono text-slate-800">{governedDataDate}</strong> — يُعبّأ تاريخ الحدث به افتراضياً.
                </p>
                {isAfterDataDate(noticeForm.incidentDate, governedDataDate) && (
                  <p className="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                    التاريخ المختار بعد تاريخ خط الحالة: الإخطار سيُصدر لحدث لم يقع بعد وفق بيانات المشروع، ولا يُحتسب أثراً فعلياً.
                  </p>
                )}
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

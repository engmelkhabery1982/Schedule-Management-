import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  ActivityLink,
  BaselineActivity,
  BudgetLine,
  CostTransaction,
  ProgressUpdate,
  Risk,
  BoqItem,
} from '@/types';
import { runDcma14PointAudit } from '@/lib/scheduleQualityEngine';
import { generateSCurveData, type SCurveData } from '@/lib/sCurveEngine';
import { calculateEarnedSchedule } from '@/lib/earnedScheduleEngine';
import {
  calculateProjectEvmAtDataDate,
  deriveEvmFromScalars,
  type ComprehensiveProjectEvm,
} from '@/lib/planningEngine';
import { reconcileFinishForecasts } from '@/lib/forecastReconciliation';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import SCurveChart from '@/components/views/SCurveChart';
import {
  Printer,
  FileText,
  Building2,
  Calendar,
  TrendingUp,
  Award,
  Zap,
  Scale,
  GitCommit,
} from 'lucide-react';

interface ExecutiveReportViewProps {
  project: Project | null;
}

export default function ExecutiveReportView({ project }: ExecutiveReportViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [transactions, setTransactions] = useState<CostTransaction[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, linkRes, baselineRes, bgtRes, cstRes, prgRes, boqRes, rskRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('baseline_activities').select('*'),
      supabase.from('budget_lines').select('*').eq('project_id', project.id),
      supabase.from('cost_transactions').select('*').eq('project_id', project.id),
      supabase.from('progress_updates').select('*').eq('project_id', project.id),
      supabase.from('boq_items').select('*').eq('project_id', project.id),
      supabase.from('risks').select('*').eq('project_id', project.id),
    ]);
    setActivities(actRes.data || []);
    setLinks((linkRes.data || []) as ActivityLink[]);
    // Cross-project leak: `baseline_activities` has no `project_id` column (it hangs off
    // `baselines`), so the unfiltered fetch above pulled every project's baseline snapshots into
    // this report's DCMA audit and baseline S-Curve. Scope them to the activities of the project
    // being reported — client-side, no query or migration change.
    const projectActivityIds = new Set(((actRes.data || []) as Activity[]).map((a) => a.id));
    setBaselineActivities(
      ((baselineRes.data || []) as BaselineActivity[]).filter((b) => projectActivityIds.has(b.activity_id)),
    );
    setBudgetLines(bgtRes.data || []);
    setTransactions((cstRes.data || []) as CostTransaction[]);
    setProgressUpdates((prgRes.data || []) as ProgressUpdate[]);
    setBoqItems((boqRes.data || []) as BoqItem[]);
    setRisks(rskRes.data || []);
    setLoading(false);
  }

  // GAP-010: the DCMA audit runs at the governed Data Date — `project.data_date` or the
  // DEFAULT_DATA_DATE constant — which is exactly the resolution the canonical EVM engine applies
  // (`overrideDataDate || project.data_date || DEFAULT_DATA_DATE`). The runtime clock is not a
  // project status date: auditing against "today" would score activities as late or missing actuals
  // relative to a date no figure in this report was computed at, and would drift every day.
  const dcmaDataDate = project?.data_date || DEFAULT_DATA_DATE;
  const dcma = useMemo(() => {
    return runDcma14PointAudit(
      activities,
      links,
      baselineActivities,
      [],
      dcmaDataDate,
      // GAP-015: the critical-path continuity point recomputes CPM, so the audit is told which
      // calendar and status logic this project is actually scheduled with.
      { calendarType: project?.calendar_type, statusLogic: project?.status_logic },
    );
  }, [activities, links, baselineActivities, dcmaDataDate, project?.calendar_type, project?.status_logic]);

  // Compute EVM metrics using the unified engine.
  // Typed as the canonical `ComprehensiveProjectEvm` (it always was one at runtime): the former
  // narrow annotation hid `earnedProgressPercent`, the ratio statuses and `dataDate` from this
  // report, so the progress and data-quality semantics could not be shown (GAP-039 / GAP-036).
  const evmMetrics: ComprehensiveProjectEvm = useMemo(() => {
    // Null safety (no project selected yet): return the canonical all-zero empty state instead of
    // dereferencing `project!`. Same pattern as Dashboard — no fabricated Project, no conditional
    // hook, and the ratios come back flagged 'empty_no_data' rather than as fake performance.
    if (!project) return deriveEvmFromScalars(0, 0, 0, 0);
    return calculateProjectEvmAtDataDate(
      project,
      activities,
      // GAP-036 correction: this parameter is the CBS budget-line input of the EVM engine.
      // It previously received `baselineActivities` (baseline activity snapshots, which carry
      // no project_id/wbs_node_id/approved_budget/actual_cost), which is not a legitimate
      // budget-line relationship. `budgetLines` is already loaded by this view from the
      // `budget_lines` table (see loadData), so the correct source is passed instead.
      // No EVM formula, fallback, or ordering is changed.
      budgetLines,
      boqItems,
      transactions,
      progressUpdates,
      // GAP-007: no view-level Data Date override. The canonical engine already resolves
      // `project.data_date || DEFAULT_DATA_DATE`; the local '2026-11-15' literal that used to be
      // passed here pre-empted the governed constant and made this report disagree with every
      // other consumer whenever a project has no stored data date.
    );
  }, [project, activities, budgetLines, boqItems, transactions, progressUpdates]);

  const totalBac = evmMetrics.bac;

  const sCurveData: SCurveData = useMemo(() => {
    return generateSCurveData(
      activities,
      baselineActivities,
      progressUpdates,
      transactions,
      evmMetrics,
      project?.start_date,
      project?.end_date,
      project?.data_date,
      // GAP-006: the canonical sources the curve needs so planned value is evaluated with the same
      // cost allocation and the same BAC as the EVM above (final cumulative PV reconciles to BAC).
      { project, budgetLines, boqItems },
    );
  }, [activities, baselineActivities, progressUpdates, transactions, evmMetrics, project, budgetLines, boqItems]);

  // Earned Schedule (ESM) — consumes the canonical EVM above and the SAME S-Curve rendered below,
  // so EV, CPI and the planned-value curve it inverts are the governed values (GAP-007/GAP-023).
  const earnedScheduleData = useMemo(() => {
    return calculateEarnedSchedule({
      project,
      activities,
      evm: evmMetrics,
      sCurve: sCurveData,
      budgetLines,
      boqItems,
      costTransactions: transactions,
      progressUpdates,
    });
  }, [project, activities, evmMetrics, sCurveData, budgetLines, boqItems, transactions, progressUpdates]);

  // GAP-041: name both finish methods and their delta instead of showing one ambiguous date.
  const finishReconciliation = useMemo(
    () => reconcileFinishForecasts(activities, earnedScheduleData),
    [activities, earnedScheduleData],
  );

  // Lookahead activities (next 3 weeks from the canonical Data Date).
  // GAP-010: the window is anchored on `evmMetrics.dataDate` — the governed date every figure in this
  // report was computed at — instead of a local literal that could sit months beyond it and present
  // work far in the future as the immediate lookahead.
  const lookaheadActivities = useMemo(() => {
    const dataDate = evmMetrics.dataDate;
    const lookaheadEnd = new Date(dataDate);
    lookaheadEnd.setDate(lookaheadEnd.getDate() + 21);
    const lookaheadEndStr = lookaheadEnd.toISOString().split('T')[0];

    return activities.filter((a) => {
      if (a.percent_complete >= 100) return false;
      if (!a.early_start) return false;
      return a.early_start <= lookaheadEndStr;
    });
  }, [activities, evmMetrics.dataDate]);

  // Report-generation metadata. This is the moment the document was rendered — it is NOT a project
  // status date, and it feeds no control calculation: BAC, PV, EV, AC, SPI(t), IEAC(t), the DCMA
  // score and every forecast in this report stay anchored to `evmMetrics.dataDate`. Regenerating the
  // report a day later changes this stamp only (Case L).
  const reportGeneratedAt = useMemo(() => new Date(), []);
  const reportGeneratedAtLabel = useMemo(() => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${reportGeneratedAt.getFullYear()}-${pad(reportGeneratedAt.getMonth() + 1)}-${pad(reportGeneratedAt.getDate())} ${pad(reportGeneratedAt.getHours())}:${pad(reportGeneratedAt.getMinutes())}`;
  }, [reportGeneratedAt]);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Control Bar (Hidden in Print) */}
      <div className="flex items-center justify-between bg-white p-4 rounded-xl border border-slate-200 shadow-sm print:hidden">
        <div>
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <FileText className="text-amber-500" size={20} />
            التقرير التنفيذي الشامل للجدول الزمني والتحكم بالمشروع (Executive Status Report)
          </h2>
          <p className="text-xs text-slate-500">
            يتضمن مؤشرات القيمة والجدول المكتسب (ESM)، فحص DCMA 14-Point، ومطالبات TIA الهندسية.
          </p>
        </div>

        <button
          onClick={handlePrint}
          className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-md transition-all cursor-pointer"
        >
          <Printer size={15} />
          <span>طباعة / حفظ كملف PDF رسمي</span>
        </button>
      </div>

      {/* Printable Report Document Container */}
      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-md space-y-6 print:border-none print:shadow-none print:p-0">
        {/* Report Header */}
        <div className="flex items-start justify-between border-b-2 border-slate-900 pb-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl bg-slate-900 text-amber-400 flex items-center justify-center font-bold">
                <Building2 size={20} />
              </div>
              <h1 className="text-xl font-black text-slate-900">{project?.name}</h1>
            </div>
            <p className="text-xs text-slate-600">
              المالك / العميل: <span className="font-semibold text-slate-800">{project?.client || 'شركة الأفق'}</span> | الموقع: <span className="font-semibold text-slate-800">{project?.location || 'الرياض'}</span>
            </p>
            <p className="text-xs text-slate-600">
              قيمة العقد: <span className="font-bold text-slate-900">{totalBac.toLocaleString()} {project?.currency || 'ر.س'}</span> | البداية: <span className="font-mono">{project?.start_date}</span> | النهاية المعتمدة: <span className="font-mono">{project?.end_date}</span>
            </p>
          </div>

          <div className="text-left space-y-1">
            <div className="bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg text-right">
              <div className="text-[10px] text-amber-800 font-bold uppercase">تاريخ خط الحالة (Data Date)</div>
              {/* The Data Date every figure below was computed at, read from the canonical result —
                  not a view-level literal, which disagreed with the engine whenever data_date was
                  null and made this report unreconcilable against the other screens. */}
              <div className="text-sm font-black font-mono text-slate-900">{evmMetrics.dataDate}</div>
            </div>
            <div className="text-left space-y-0.5">
              <div className="text-[10px] text-slate-400 font-mono">
                {`توقيت إصدار التقرير (Report Generated At): ${reportGeneratedAtLabel}`}
              </div>
              <div className="text-[9px] text-slate-400 leading-snug max-w-[16rem]">
                طابع زمني لحظي للتوثيق فقط — لا يغيّر أي حساب: كل الأرقام أعلاه مثبّتة على تاريخ خط الحالة.
              </div>
            </div>
          </div>
        </div>

        {/* Executive KPI Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">مؤشر أداء الجدول الزمني SPI(t)</span>
            <div className={`text-2xl font-black mt-1 ${earnedScheduleData.schedulePerformanceIndexTime >= 1 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {earnedScheduleData.schedulePerformanceIndexTime.toFixed(2)}
            </div>
            <span className="text-[10px] font-mono text-slate-500">
              الجدول المكتسب: {earnedScheduleData.earnedScheduleDays} يوم
            </span>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">الانحراف الزمني الحقيقي SV(t)</span>
            <div className={`text-2xl font-black mt-1 ${earnedScheduleData.scheduleVarianceTimeDays >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {earnedScheduleData.scheduleVarianceTimeDays >= 0 ? `+${earnedScheduleData.scheduleVarianceTimeDays}` : earnedScheduleData.scheduleVarianceTimeDays} يوم
            </div>
            <span className="text-[10px] text-slate-500">Time-based schedule variance</span>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">
              {finishReconciliation.labels.earned_schedule_trend.nameAr}
            </span>
            <div className="text-base font-black text-purple-900 mt-1.5">
              {finishReconciliation.esTrendFinish || 'غير قابل للحساب (N/A)'}
            </div>
            {/* GAP-041: this is a performance trend forecast (IEAC(t) = PD / SPI(t)), NOT the CPM
                deterministic finish. When SPI(t) is 0 it is not computable and no date is shown. */}
            {finishReconciliation.esComputable ? (
              <span className="text-[10px] text-rose-600 font-bold">
                تأخير متوقع مقابل النهاية المخططة: {Math.abs(earnedScheduleData.varianceAtCompletionTimeDays)} يوم
              </span>
            ) : (
              <span className="text-[10px] text-slate-500 font-bold">
                IEAC(t) غير قابل للحساب ({finishReconciliation.esAvailability === 'spi_t_zero' ? 'SPI(t) = 0' : finishReconciliation.esAvailability === 'no_planned_duration' ? 'لا توجد مدة مخططة' : 'لا توجد نتائج جدول مكتسب'}) — لا يُعرض تاريخ بديل.
              </span>
            )}
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">جودة وسلامة الجدول (DCMA)</span>
            <div className="text-2xl font-black text-emerald-700 mt-1">{dcma.score}%</div>
            <span className="text-[10px] text-emerald-600 font-bold">{dcma.totalPassed}/14 معايير معتمدة</span>
          </div>
        </div>

        {/* Canonical project-control EVM (GAP-036 / GAP-039).
            Every number here is a direct field read of the single canonical engine result — no
            second formula and no view-level rounding policy — so this report reconciles with
            Dashboard, BudgetView, ProgressView and PortfolioView for the same project and the same
            Data Date (`evmMetrics.dataDate`). */}
        <div className="border border-slate-200 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <Scale size={15} className="text-emerald-600" />
            مؤشرات التحكم بالمشروع المعتمدة (Canonical Project Controls — EVM @ Data Date {evmMetrics.dataDate})
          </h3>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">الإنجاز المكتسب للمشروع (EV / BAC)</span>
              <span className="text-lg font-black text-amber-700 font-mono">{evmMetrics.earnedProgressPercent}%</span>
              <span className="text-[9px] text-slate-400 block">المخطط (PV / BAC): {evmMetrics.plannedProgressPercent}%</span>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">ميزانية العقد BAC</span>
              <span className="text-lg font-black text-slate-800 font-mono">{evmMetrics.bac.toLocaleString()}</span>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">القيمة المخططة PV</span>
              <span className="text-lg font-black text-slate-800 font-mono">{evmMetrics.pv.toLocaleString()}</span>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">القيمة المكتسبة EV</span>
              <span className="text-lg font-black text-emerald-700 font-mono">{evmMetrics.ev.toLocaleString()}</span>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">التكلفة الفعلية AC</span>
              <span className="text-lg font-black text-slate-800 font-mono">{evmMetrics.ac.toLocaleString()}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">كفاءة التكلفة CPI</span>
              <span className={`text-lg font-black font-mono ${evmMetrics.cpiStatus === 'valid' ? (evmMetrics.cpi >= 1 ? 'text-emerald-700' : 'text-rose-700') : 'text-slate-500'}`}>
                {evmMetrics.cpiStatus === 'valid' ? evmMetrics.cpi.toFixed(3) : 'غير مقاس (N/A)'}
              </span>
              {evmMetrics.cpiStatus !== 'valid' && (
                <span className="text-[9px] text-rose-600 block">
                  {evmMetrics.cpiStatus === 'empty_no_data' ? 'لا توجد بيانات (حالة فارغة)' : 'مقام صفري مع وجود قيمة مكتسبة — خلل بيانات'}
                </span>
              )}
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">كفاءة الجدول SPI</span>
              <span className={`text-lg font-black font-mono ${evmMetrics.spiStatus === 'valid' ? (evmMetrics.spi >= 1 ? 'text-emerald-700' : 'text-rose-700') : 'text-slate-500'}`}>
                {evmMetrics.spiStatus === 'valid' ? evmMetrics.spi.toFixed(3) : 'غير مقاس (N/A)'}
              </span>
              {evmMetrics.spiStatus !== 'valid' && (
                <span className="text-[9px] text-rose-600 block">
                  {evmMetrics.spiStatus === 'empty_no_data' ? 'لا توجد بيانات (حالة فارغة)' : 'مقام صفري مع وجود قيمة مكتسبة — خلل بيانات'}
                </span>
              )}
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">التقدير عند الإنجاز EAC</span>
              <span className="text-lg font-black text-amber-700 font-mono">{evmMetrics.eac.toLocaleString()}</span>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">التكلفة المتبقية ETC</span>
              <span className="text-lg font-black text-slate-800 font-mono">{evmMetrics.etc.toLocaleString()}</span>
            </div>
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="text-[10px] text-slate-500 font-semibold block">الانحراف عند الإنجاز VAC</span>
              <span className={`text-lg font-black font-mono ${evmMetrics.vac >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {evmMetrics.vac >= 0 ? '+' : ''}{evmMetrics.vac.toLocaleString()}
              </span>
            </div>
          </div>

          {/* GAP-041: the two finish methods, both named, with the delta in days. */}
          <div className="p-3 bg-amber-50/60 border border-amber-200 rounded-lg space-y-1.5">
            <p className="text-[11px] font-black text-slate-700">
              تاريخ الإنجاز المتوقع — طريقتان مختلفتان (وليستا تاريخاً واحداً متعارضاً)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
              <div className="p-2 bg-white border border-slate-200 rounded-lg">
                <span className="text-slate-500 font-bold block">{finishReconciliation.labels.cpm_deterministic.nameAr}</span>
                <span className="font-mono font-black text-slate-800">{finishReconciliation.cpmEarlyFinish || 'غير متوفر (N/A)'}</span>
              </div>
              <div className="p-2 bg-white border border-slate-200 rounded-lg">
                <span className="text-slate-500 font-bold block">{finishReconciliation.labels.earned_schedule_trend.nameAr}</span>
                <span className="font-mono font-black text-purple-900">{finishReconciliation.esTrendFinish || 'غير قابل للحساب (N/A)'}</span>
              </div>
              <div className="p-2 bg-white border border-slate-200 rounded-lg">
                <span className="text-slate-500 font-bold block">الفرق بين الطريقتين (Delta)</span>
                <span className={`font-mono font-black ${finishReconciliation.deltaDays === null ? 'text-slate-400' : finishReconciliation.deltaDays > 0 ? 'text-rose-700' : finishReconciliation.deltaDays < 0 ? 'text-emerald-700' : 'text-slate-700'}`}>
                  {finishReconciliation.deltaDays === null
                    ? 'N/A'
                    : `${finishReconciliation.deltaDays > 0 ? '+' : ''}${finishReconciliation.deltaDays} يوم`}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              {finishReconciliation.labels.cpm_deterministic.basisAr}
            </p>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              {finishReconciliation.labels.earned_schedule_trend.basisAr}
            </p>
          </div>
        </div>

        {/* S-Curve Chart Section */}
        <div className="border border-slate-200 rounded-xl p-4">
          <h3 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5">
            <TrendingUp size={15} className="text-amber-600" />
            منحنى الإنجاز التراكمي ومطابقة خط الأساس (Baseline S-Curve & EVM)
          </h3>
          <SCurveChart data={sCurveData} currency={project?.currency || 'ريال'} />
        </div>

        {/* Critical Path Table */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <Zap size={15} className="text-rose-600" />
            أنشطة المسار الحرج (Critical Path Activities - Zero Float)
          </h3>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-2 text-right">كود النشاط</th>
                  <th className="p-2 text-right">اسم النشاط</th>
                  <th className="p-2 text-right">البداية المبكرة</th>
                  <th className="p-2 text-right">النهاية المبكرة</th>
                  <th className="p-2 text-right">المدة</th>
                  <th className="p-2 text-right">الإنجاز</th>
                  <th className="p-2 text-right">كبح المسار (Drag)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activities.filter((a) => a.is_critical).map((act) => (
                  <tr key={act.id} className="hover:bg-slate-50">
                    <td className="p-2 font-mono font-bold text-rose-700">{act.code}</td>
                    <td className="p-2 font-semibold text-slate-800">{act.name}</td>
                    <td className="p-2 font-mono text-slate-600">{act.early_start}</td>
                    <td className="p-2 font-mono text-slate-600">{act.early_finish}</td>
                    <td className="p-2">{act.duration_days} يوم</td>
                    <td className="p-2 font-bold text-blue-700">{act.percent_complete}%</td>
                    <td className="p-2 font-mono">{act.activity_drag || act.duration_days} يوم</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 3-Week Lookahead Schedule */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <Calendar size={15} className="text-indigo-600" />
            جدول النظرة المستقبلية للأسابيع الثلاثة القادمة (3-Week Lookahead Schedule)
          </h3>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-2 text-right">الكود</th>
                  <th className="p-2 text-right">النشاط المستهدف</th>
                  <th className="p-2 text-right">المقاول / الفريق</th>
                  <th className="p-2 text-right">تاريخ البدء المخطط</th>
                  <th className="p-2 text-right">تاريخ الإنجاز المخطط</th>
                  <th className="p-2 text-right">الهامش (Float)</th>
                  <th className="p-2 text-center">الأولوية</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lookaheadActivities.map((act) => (
                  <tr key={act.id} className="hover:bg-slate-50">
                    <td className="p-2 font-mono font-medium">{act.code}</td>
                    <td className="p-2 font-medium text-slate-800">{act.name}</td>
                    <td className="p-2 text-slate-500">{act.contractor || 'المقاول العام'}</td>
                    <td className="p-2 font-mono text-slate-700">{act.early_start}</td>
                    <td className="p-2 font-mono text-slate-700">{act.early_finish}</td>
                    <td className="p-2 font-mono">{act.total_float || 0} يوم</td>
                    <td className="p-2 text-center">
                      {act.is_critical ? (
                        <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-800 font-bold text-[10px]">حرج جداً</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-semibold text-[10px]">عادي</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Report Footer & Signatures */}
        <div className="grid grid-cols-3 gap-6 pt-8 border-t border-slate-300 text-xs text-center">
          <div className="space-y-8">
            <p className="font-semibold text-slate-700">مهندس التخطيط والجدولة (Planning Engineer)</p>
            <div className="border-b border-slate-400 w-36 mx-auto" />
          </div>
          <div className="space-y-8">
            <p className="font-semibold text-slate-700">مدير المشروع (Project Manager)</p>
            <div className="border-b border-slate-400 w-36 mx-auto" />
          </div>
          <div className="space-y-8">
            <p className="font-semibold text-slate-700">استشاري المشروع (Consultant Representative)</p>
            <div className="border-b border-slate-400 w-36 mx-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}

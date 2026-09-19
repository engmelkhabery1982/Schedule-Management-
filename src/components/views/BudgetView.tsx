import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import { quoteCanonicalEvm } from '@/lib/canonicalEvm';
import { reviewStateOf } from '@/lib/demoDbContracts';
import { assertDbWriteOk } from '@/lib/supabaseErrors';
import { calculateEarnedSchedule, type EarnedScheduleResult } from '@/lib/earnedScheduleEngine';
import {
  aggregateCbsCostCenters,
  calculateMultiEacForecast,
  summarizeCommittedCost,
  type CbsAggregation,
  type EacModelResult,
  type MultiEacForecast,
  type TcpiReading,
} from '@/lib/budgetForecastEngine';
import type {
  Project,
  BudgetLine,
  CostTransaction,
  BoqItem,
  Activity,
  ActivityLink,
  BaselineActivity,
  WbsNode,
  ActivityBoqAllocation,
  CostControlSnapshot,
  ProgressUpdate,
  MonthlyCashFlowBucket,
  ReserveBurnItem,
} from '@/types';
import { analyzeCostControl, buildCostSnapshot, type CostControlReport } from '@/lib/costControlEngine';
import { analyzeScheduleControl, type ScheduleControlReport } from '@/lib/scheduleControlEngine';
import { isAfterDataDate, resolveDataDate } from '@/lib/chronologyGuard';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Save,
  Layers,
  ArrowDownRight,
  ArrowUpRight,
  ShieldAlert,
  Percent,
  Calendar,
  AlertTriangle,
  CheckCircle2,
  PieChart,
  BarChart3,
  Sparkles,
  Plus,
  Compass,
  Zap,
  Activity as ActivityIcon,
  HelpCircle,
  FileText,
} from 'lucide-react';

interface BudgetViewProps {
  project: Project | null;
}

type BudgetTab = 'evm_tcpi' | 'cash_flow' | 'cbs_centers' | 'reserves' | 'transactions_table' | 'cost_control';

/** Labels of the Earned Schedule status the canonical engine returns (no view-side status logic). */
const ESM_STATUS_LABELS: Record<EarnedScheduleResult['status'], { ar: string; en: string; className: string }> = {
  ahead: { ar: 'متقدم عن الخطة الزمنية', en: 'Ahead of the planned time', className: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  on_track: { ar: 'على المسار الزمني المخطط', en: 'On the planned time track', className: 'bg-blue-100 text-blue-800 border-blue-200' },
  delayed: { ar: 'تأخير زمني مقاس', en: 'Measured time delay', className: 'bg-amber-100 text-amber-900 border-amber-200' },
  critical_delay: { ar: 'تأخير حرج — لا يوجد جدول مكتسب', en: 'Critical delay — no earned schedule', className: 'bg-rose-100 text-rose-800 border-rose-200' },
};

/** Day/month formatting for engine output: finite numbers only, everything else is N/A. */
function formatEsmNumber(value: number | null | undefined, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'غير قابل للحساب (N/A)';
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(digits);
}

export default function BudgetView({ project }: BudgetViewProps) {
  const [activeTab, setActiveTab] = useState<BudgetTab>('evm_tcpi');
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editActual, setEditActual] = useState(0);
  const [transactions, setTransactions] = useState<CostTransaction[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  // F6: cost-control inputs.
  const [baselines, setBaselines] = useState<BaselineActivity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [wbsNodes, setWbsNodes] = useState<WbsNode[]>([]);
  const [allocations, setAllocations] = useState<ActivityBoqAllocation[]>([]);
  const [packages, setPackages] = useState<Array<{ status: string; totalSubcontractValueSar: number | null }>>([]);
  const [costSnapshots, setCostSnapshots] = useState<CostControlSnapshot[]>([]);
  const [manualEtcInput, setManualEtcInput] = useState('');
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [notice, setNotice] = useState('');
  const governedDataDate = useMemo(() => resolveDataDate(project), [project]);
  const [txnDate, setTxnDate] = useState(() => resolveDataDate(project));
  const [lang, setLang] = useState<Language>(getLanguage());

  // Cost Transaction Input Form
  const [transactionForm, setTransactionForm] = useState({
    description: '',
    amount: 0,
    cost_type: 'direct',
    boq_item_id: '',
    activity_id: '',
    budget_line_id: '',
    vendor: '',
    invoice_number: '',
  });

  // Reserve Drawdown Request Form
  const [showReserveModal, setShowReserveModal] = useState(false);
  const [reserveDrawForm, setReserveDrawForm] = useState({
    reserveType: 'contingency' as 'contingency' | 'management',
    nameAr: '',
    amountSar: 50000,
    associatedRiskTitle: 'ارتفاع أسعار حديد التسليح وتأخر التوريد',
    authorizationNotes: 'موافقة لجنة التحكم المالي لتغطية فارق تكلفة التوريد العاجل',
  });

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);

    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    const handleDataDateChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId?: string } | undefined;
      if (project && (!detail?.projectId || detail.projectId === project.id)) loadData();
    };
    window.addEventListener('project-data-date-changed', handleDataDateChange);
    return () => {
      window.removeEventListener('app-language-changed', handleLangChange);
      window.removeEventListener('project-data-date-changed', handleDataDateChange);
    };
  }, [project]);

  // F6: keep the manual-ETC editor and transaction date anchored when the project changes.
  useEffect(() => {
    setManualEtcInput(
      project?.manual_etc_override !== null && project?.manual_etc_override !== undefined
        ? String(project.manual_etc_override) : '',
    );
    setTxnDate(resolveDataDate(project));
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [{ data }, { data: transactionData }, { data: boqData }, { data: activityData }, { data: progressData }, baseRes, linkRes, wbsRes, allocRes, pkgRes, snapRes] = await Promise.all([
      supabase.from('budget_lines').select('*').eq('project_id', project.id),
      supabase.from('cost_transactions').select('*').eq('project_id', project.id).order('transaction_date', { ascending: false }),
      supabase.from('boq_items').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('progress_updates').select('*').eq('project_id', project.id),
      supabase.from('baseline_activities').select('*, project_baselines!inner(project_id, is_active, status)').eq('project_baselines.project_id', project.id).eq('project_baselines.is_active', true).eq('project_baselines.status', 'approved'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('wbs_nodes').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_boq_allocations').select('*').eq('project_id', project.id),
      // Direct rows only: the cached loader falls back to demo defaults, which F6 must not read as exposure.
      supabase.from('subcontract_packages').select('status, total_subcontract_value_sar').eq('project_id', project.id),
      supabase.from('cost_control_snapshots').select('*').eq('project_id', project.id).order('data_date', { ascending: false }).limit(10),
    ]);
    setBudgetLines(data || []);
    setTransactions((transactionData || []) as CostTransaction[]);
    setBoqItems((boqData || []) as BoqItem[]);
    setActivities((activityData || []) as Activity[]);
    setProgressUpdates((progressData || []) as ProgressUpdate[]);
    setBaselines(((baseRes as { data?: unknown }).data || []) as BaselineActivity[]);
    setLinks(((linkRes as { data?: unknown }).data || []) as ActivityLink[]);
    setWbsNodes(((wbsRes as { data?: unknown }).data || []) as WbsNode[]);
    setAllocations(((allocRes as { data?: unknown }).data || []) as ActivityBoqAllocation[]);
    setPackages((((pkgRes as { data?: unknown }).data || []) as Array<Record<string, unknown>>).map((r) => ({
      status: String(r.status || ''),
      totalSubcontractValueSar: typeof r.total_subcontract_value_sar === 'number' ? (r.total_subcontract_value_sar as number) : null,
    })));
    setCostSnapshots(((snapRes as { data?: unknown }).data || []) as CostControlSnapshot[]);
    setLoading(false);
  }

  async function addTransaction() {
    if (!project || !transactionForm.description || transactionForm.amount <= 0) return;
    // F6 §1: a transaction dated after the Data Date is not an actual — blocked at entry.
    if (isAfterDataDate(txnDate, governedDataDate)) {
      setNotice(`تعذر التسجيل: تاريخ الحركة (${txnDate}) بعد تاريخ التحديث المعتمد (${governedDataDate}).`);
      return;
    }
    const { error } = await supabase.from('cost_transactions').insert({
      project_id: project.id,
      description: transactionForm.description,
      amount: transactionForm.amount,
      cost_type: transactionForm.cost_type,
      transaction_date: txnDate,
      source: 'manual',
      status: 'submitted',
      boq_item_id: transactionForm.boq_item_id || null,
      activity_id: transactionForm.activity_id || null,
      budget_line_id: transactionForm.budget_line_id || null,
      vendor: transactionForm.vendor || null,
      invoice_number: transactionForm.invoice_number || null,
    });
    // P2A1-M02: a rejected write must never fail silently. The project boundary is enforced at the
    // persistence layer (demo store mirrors the live `validate_cost_project` trigger), so an
    // activity that does not exist, or that belongs to another project, comes back as an error here
    // and is reported instead of looking like a save that quietly did nothing.
    if (error) {
      setNotice(error.message === 'Control record crosses project boundary'
        ? (lang === 'ar'
          ? 'تعذر التسجيل: النشاط المحدد غير موجود أو يتبع مشروعاً آخر.'
          : 'Not saved: the selected activity does not exist or belongs to another project.')
        : (lang === 'ar' ? `تعذر التسجيل: ${error.message}` : `Not saved: ${error.message}`));
      return;
    }
    setTransactionForm({ description: '', amount: 0, cost_type: 'direct', boq_item_id: '', activity_id: '', budget_line_id: '', vendor: '', invoice_number: '' });
    setTxnDate(governedDataDate);
    setNotice('');
    await loadData();
  }

  // F6: schedule linkage (read-only F5) + the cost-control report + snapshot/manual persistence.
  const scheduleReport: ScheduleControlReport | null = useMemo(() => {
    if (!project) return null;
    return analyzeScheduleControl({
      activities,
      links,
      baselines,
      progressUpdates,
      previousSnapshot: null,
      dataDate: governedDataDate,
      calendarType: project.calendar_type || '6_days',
      statusLogic: project.status_logic || 'retained_logic',
    });
  }, [project, activities, links, baselines, progressUpdates, governedDataDate]);

  const manualEtcValue: number | null = manualEtcInput.trim() === '' ? null : Number(manualEtcInput);
  const costReport: CostControlReport | null = useMemo(() => {
    if (!project) return null;
    return analyzeCostControl({
      project,
      activities,
      baselines,
      budgetLines,
      costTransactions: transactions,
      progressUpdates,
      wbsNodes,
      boqItems,
      allocations,
      subcontractPackages: packages,
      previousSnapshots: costSnapshots,
      scheduleReport,
      dataDate: governedDataDate,
      calendarType: project.calendar_type || '6_days',
      manualEtc: manualEtcInput.trim() === '' || !Number.isFinite(Number(manualEtcInput)) ? null : Number(manualEtcInput),
    });
  }, [project, activities, baselines, budgetLines, transactions, progressUpdates, wbsNodes, boqItems, allocations, packages, costSnapshots, scheduleReport, governedDataDate, manualEtcInput]);

  async function handleSaveCostSnapshot() {
    if (!project || !costReport) return;
    setSavingSnapshot(true);
    try {
      const payload = buildCostSnapshot(project.id, costReport);
      const { error } = await supabase.from('cost_control_snapshots').upsert(payload, { onConflict: 'project_id,data_date' });
      if (error) throw error;
      setNotice(`تم حفظ لقطة التكلفة (Data Date ${costReport.dataDate}): EAC الموصى به ${costReport.project.eac !== null ? costReport.project.eac.toLocaleString() : 'N/A'}.`);
      const snapRes = await supabase.from('cost_control_snapshots').select('*').eq('project_id', project.id).order('data_date', { ascending: false }).limit(10);
      setCostSnapshots(((snapRes as { data?: unknown }).data || []) as CostControlSnapshot[]);
    } catch (err: unknown) {
      setNotice(`تعذر حفظ اللقطة: ${(err as Error).message}`);
    } finally {
      setSavingSnapshot(false);
    }
  }

  async function handleSaveManualEtc() {
    if (!project) return;
    const parsed = manualEtcInput.trim() === '' ? null : Number(manualEtcInput);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setNotice('قيمة ETC اليدوية غير صالحة: أدخل رقماً غير سالب أو اترك الحقل فارغاً.');
      return;
    }
    setSavingManual(true);
    try {
      const { error } = await supabase.from('projects').update({ manual_etc_override: parsed }).eq('id', project.id);
      if (error) throw error;
      setNotice(parsed === null ? 'تم مسح ETC اليدوية: طريقة التقدير اليدوي أصبحت غير منطبقة.' : `تم حفظ ETC اليدوية (${parsed.toLocaleString()} SAR).`);
    } catch (err: unknown) {
      setNotice(`تعذر حفظ ETC اليدوية: ${(err as Error).message}`);
    } finally {
      setSavingManual(false);
    }
  }

  /**
   * F9.4 (Controlled Pilot defect 2) — approve a submitted cost transaction.
   *
   * The pilot's "Controlled Pilot cost transaction — 100 SAR" stayed Pending after Approve with no
   * message at all. The handler was already gating on the returned `{ error }`; the failure was
   * underneath it. In demo mode `supabase.rpc` is served by the local store, whose `mockRpc`
   * implemented only `approve_progress_update` and answered EVERY other function name with
   * `{ data: true, error: null }` without writing anything. An unimplemented write therefore
   * reported success: no error to gate on, no state change, and `loadData()` re-read the row that
   * had never been touched. The contract now lives in `src/lib/demoDbContracts.ts`, mirroring the
   * `review_cost_transaction` SQL function, and an unimplemented RPC is an explicit error.
   *
   * Two further points this handler now honours:
   *   - the SQL procedure is a TWO-LEVEL gate (`approval_level` 0 -> 1 keeps status `submitted`;
   *     1 -> 2 sets `approved`, `approved_at`, `approved_by`). A legitimate level advance used to be
   *     invisible because only the status badge was rendered, so the notice names the outcome;
   *   - success is confirmed by reading the row BACK, so the message reports persisted state rather
   *     than an assumption. No optimistic local state is written anywhere.
   */
  async function approveTransaction(id: string) {
    const transaction = transactions.find((item) => item.id === id);
    try {
      assertDbWriteOk(
        await supabase.rpc('review_cost_transaction', {
          transaction_uuid: id,
          approver: (transaction?.approval_level || 0) === 0 ? 'project_control' : 'finance_manager',
          decision: 'approve',
        }),
        lang === 'ar' ? 'اعتماد حركة التكلفة (review_cost_transaction)' : 'approve cost transaction (review_cost_transaction)',
      );
    } catch (err: unknown) {
      // Failure: no success message, no local state change, and enough context to identify the
      // failed database step.
      setNotice(lang === 'ar'
        ? `تعذر اعتماد المعاملة: ${(err as Error).message}`
        : `Approval failed: ${(err as Error).message}`);
      return;
    }
    await loadData();
    // Read the committed row back so the notice states what is actually persisted.
    const { data: row } = await supabase.from('cost_transactions').select('*').eq('id', id).maybeSingle();
    const state = reviewStateOf((row as { status?: unknown; approval_level?: unknown } | null) || null);
    if (!state) {
      setNotice(lang === 'ar'
        ? 'تم تنفيذ الاعتماد ولكن تعذرت قراءة الحركة للتأكد من الحالة.'
        : 'Approval executed, but the transaction could not be read back to confirm its state.');
      return;
    }
    setNotice(state.isApproved
      ? (lang === 'ar'
        ? `تم اعتماد الحركة (${transaction?.description ?? id}) — الحالة: معتمدة، وسيُحتسب مبلغها ضمن التكلفة الفعلية (AC) إذا كان تاريخها في حدود تاريخ التحديث المعتمد.`
        : `Transaction approved (${transaction?.description ?? id}) — status: approved. Its amount enters AC when its date is on or before the governed Data Date.`)
      : (lang === 'ar'
        ? `تم تسجيل الاعتماد الأول للحالة (${transaction?.description ?? id}) — المستوى ${state.approvalLevel}/2، ما زالت بانتظار اعتماد المستوى التالي.`
        : `First-level approval recorded (${transaction?.description ?? id}) — level ${state.approvalLevel}/2; still awaiting the next approval level.`));
  }

  async function rejectTransaction(id: string) {
    try {
      assertDbWriteOk(
        await supabase.rpc('review_cost_transaction', {
          transaction_uuid: id,
          approver: 'reviewer',
          decision: 'reject',
          review_notes: 'مرفوض للمراجعة والتصحيح',
        }),
        lang === 'ar' ? 'رفض حركة التكلفة (review_cost_transaction)' : 'reject cost transaction (review_cost_transaction)',
      );
    } catch (err: unknown) {
      // F9 (item 5) + F9.4 (defect 2): same gating for rejection — a failed write is announced.
      setNotice(lang === 'ar'
        ? `تعذر رفض المعاملة: ${(err as Error).message}`
        : `Rejection failed: ${(err as Error).message}`);
      return;
    }
    await loadData();
    setNotice(lang === 'ar' ? 'تم رفض الحركة.' : 'Transaction rejected.');
  }

  async function saveActual(id: string) {
    const line = budgetLines.find((l) => l.id === id);
    if (!line) return;
    // PA-13: unified remaining basis COALESCE(approved_budget, planned_cost, 0) - actual,
    // shared with recompute_budget_line_actuals() / recompute_resource_budget(). A negative
    // result is a real overrun signal and is stored as-is (never clamped to zero).
    const basis = line.approved_budget ?? line.planned_cost ?? 0;
    const remaining = basis - editActual;
    const { error } = await supabase.from('budget_lines').update({
      actual_cost: editActual,
      remaining_cost: remaining,
    }).eq('id', id);
    // F9 (item 5): announce the failure — the previous silent `return` left the editor open with no
    // explanation, indistinguishable from a stuck UI.
    if (error) {
      setNotice(`تعذر حفظ التكلفة الفعلية: ${error.message}`);
      return;
    }
    setEditingId(null);
    await loadData();
  }

  // Canonical EVM — QUOTED from this view's own F6 cost-control report (F9.4, Controlled Pilot
  // defect 1). This screen is the F6 cost-control workstation, and it used to render a second,
  // independently derived EVM block beside the F6 panel: `calculateProjectEvmAtDataDate` allocates
  // each activity's budget from the FIRST budget line matching its WBS node (shared in full by every
  // activity in that node) and time-prorates the recorded percent, whereas F6 allocates from the
  // approved baseline's `planned_cost`. On the pilot project that produced EV 275,358 / CPI 0.40 /
  // EAC 5,862,875 here against F6's EV 752,900 / CPI 1.091 / EAC 2,149,542 on the same approved data
  // at the same Data Date — two answers on one screen.
  //
  // F6 is canonical for the cost-control layer, so every BAC/PV/EV/AC/CPI/SPI/ETC/EAC/VAC figure
  // this view shows is now a verbatim quote of `costReport`. No formula is re-implemented here and
  // no value is copied between widgets: both read the same report object.
  const evm = useMemo(() => quoteCanonicalEvm(costReport), [costReport]);

  // Earned Schedule (ESM) — the SAME canonical engine ProgressView and the Executive Report use, so
  // this card cannot present a competing forecast (GAP-008: one engine, many consumers). It consumes
  // the canonical EVM above plus the same source rows, and derives the planned-value S-Curve from
  // them internally because this view does not hold one.
  const earnedSchedule = useMemo(
    () =>
      calculateEarnedSchedule({
        project,
        activities,
        evm,
        budgetLines,
        boqItems,
        costTransactions: transactions,
        progressUpdates,
        // F9.6: without these the engine's internal S-Curve fallback would weight PV by budget lines
        // instead of the approved baseline, inverting a different curve than the canonical screens.
        baselines,
        calendarType: project?.calendar_type || undefined,
      }),
    [project, activities, evm, budgetLines, boqItems, transactions, progressUpdates, baselines],
  );

  // Case J: the engine returns zeros when there is nothing to measure. The card says N/A and names
  // the missing input instead of rendering those zeros as a result.
  const esmComputable =
    project !== null &&
    activities.length > 0 &&
    earnedSchedule.plannedDurationDays > 0 &&
    earnedSchedule.actualTimeElapsedDays > 0;
  const esmIeacComputable = esmComputable && earnedSchedule.schedulePerformanceIndexTime > 0;
  /** The Data Date every figure in this card was computed at — read from the canonical EVM result. */
  const earnedScheduleDateLabel = evm.dataDate;
  const esmMissingInputAr = !project
    ? 'لا يوجد مشروع محدد.'
    : activities.length === 0
      ? 'لا توجد أنشطة مجدولة للمشروع.'
      : earnedSchedule.plannedDurationDays <= 0
        ? 'لا توجد مدة مخططة (PD = 0) أو تواريخ بداية/نهاية صالحة.'
        : 'لم ينقضِ وقت فعلي حتى تاريخ خط الحالة (AT = 0).';
  const esmMissingInputEn = !project
    ? 'No project is selected.'
    : activities.length === 0
      ? 'The project has no scheduled activities.'
      : earnedSchedule.plannedDurationDays <= 0
        ? 'There is no planned duration (PD = 0) or no valid start / finish dates.'
        : 'No actual time has elapsed by the Data Date (AT = 0).';

  // Committed cost provenance (UG-051): the stored `committed_cost` values, or an explicit
  // "no commitment data" state. The former `|| Math.round(planned * 0.75)` fabricated a commitment
  // of 75% of the budget whenever the real total was 0 or absent; nothing is synthesised here.
  const committedSummary = useMemo(() => summarizeCommittedCost(budgetLines), [budgetLines]);

  // Basic totals — planned and actual are the canonical EVM values, never local recomputations.
  const totals = useMemo(() => {
    const planned = evm.bac;
    const actual = evm.ac;
    const remaining = planned - actual;
    const variance = planned - actual;
    return { planned, committed: committedSummary.total, actual, remaining, variance };
  }, [evm, committedSummary]);

  // -------------------------------------------------------------
  // 1. CBS Cost Centers — attributed from real records only (UG-050)
  // -------------------------------------------------------------
  // The five centers used to be filled with fixed percentages of BAC (22 / 38 / 12 / 20 / 8%) and
  // of AC (24 / 40 / 11 / 18 / 7%), i.e. with numbers that no record supports. Attribution now
  // comes from `budget_lines` (planned / committed) and approved `cost_transactions` dated on or
  // before the Data Date (actual). A record is only attributed to a cost nature when its own
  // category text names one; everything else is reported in the explicit Unclassified / Other
  // center, so the columns reconcile exactly to the canonical BAC and AC.
  const cbs: CbsAggregation = useMemo(() => {
    return aggregateCbsCostCenters({
      budgetLines,
      costTransactions: transactions,
      boqItems,
      totalPlanned: evm.bac,
      totalActual: evm.ac,
      dataDate: evm.dataDate,
    });
  }, [budgetLines, transactions, boqItems, evm]);

  const cbsCenters = cbs.centers;

  // -------------------------------------------------------------
  // 2. Monthly Cash Flow S-Curve & Peak Working Capital
  // -------------------------------------------------------------
  // Provenance (Phase B): the Out leg is bound to REAL records — approved `cost_transactions`
  // grouped by transaction month (the same approval rule as canonical AC). The In leg has NO
  // source table in the schema — no owner receivables / IPC collection records exist anywhere
  // in the app — so it and every figure derived from it (net, cumulative, peak working
  // capital, deficit flags, monthly PV phasing) are `null` = N/A. The previous revision
  // hardcoded seven demo months of PV/In/Out as if they were project facts; those fabricated
  // figures are removed and are never shown as actuals.
  const cashFlowTimeline: MonthlyCashFlowBucket[] = useMemo(() => {
    const AR_MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const EN_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const isDateKey = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

    const outByMonth = new Map<string, number>();
    for (const t of transactions) {
      if (t.status !== 'approved') continue;
      if (!isDateKey(t.transaction_date)) continue;
      const amount = Number(t.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const key = t.transaction_date.slice(0, 7);
      outByMonth.set(key, (outByMonth.get(key) || 0) + amount);
    }

    // Contiguous spine covering the scheduled window AND every outflow month, so no approved
    // outflow can fall outside the table.
    const extentDates: string[] = [];
    for (const a of activities) {
      if (isDateKey(a.early_start)) extentDates.push(a.early_start);
      if (isDateKey(a.early_finish)) extentDates.push(a.early_finish);
    }
    for (const t of transactions) {
      if (t.status === 'approved' && isDateKey(t.transaction_date)) extentDates.push(t.transaction_date);
    }
    if (extentDates.length === 0) return [];
    extentDates.sort();
    const startKey = extentDates[0].slice(0, 7);
    const endKey = extentDates[extentDates.length - 1].slice(0, 7);

    const buckets: MonthlyCashFlowBucket[] = [];
    let [y, m] = startKey.split('-').map(Number);
    const [endY, endM] = endKey.split('-').map(Number);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      buckets.push({
        periodMonth: key,
        monthLabel: lang === 'ar' ? `${AR_MONTH_NAMES[m - 1]} ${y}` : `${EN_MONTH_NAMES[m - 1]} ${y}`,
        plannedValueSar: null,
        cashInGrossSar: null,
        cashInNetReceivedSar: null,
        cashOutCommittedSar: outByMonth.get(key) || 0,
        netMonthlyCashFlowSar: null,
        cumulativeCashFlowSar: null,
        isDeficit: null,
        fundingGapSar: null,
      });
      if (y === endY && m === endM) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return buckets;
  }, [activities, transactions, lang]);

  // Peak Working Capital Required — N/A: it is the deepest cumulative deficit, and the
  // cumulative leg needs inflows that do not exist in the schema. Any missing leg forces N/A;
  // a partial figure is never presented.
  const peakWorkingCapitalSar: number | null = useMemo(() => {
    let minCumul: number | null = null;
    for (const b of cashFlowTimeline) {
      if (b.cumulativeCashFlowSar == null) return null;
      if (minCumul == null || b.cumulativeCashFlowSar < minCumul) minCumul = b.cumulativeCashFlowSar;
    }
    return minCumul == null ? null : Math.abs(minCumul);
  }, [cashFlowTimeline]);

  // Total Cash-In is real only when at least one bucket carries collection data (none do until
  // a receivables source exists); otherwise the KPI shows N/A instead of a zero-as-fact.
  const hasCashInData = cashFlowTimeline.some((b) => b.cashInNetReceivedSar != null);

  // -------------------------------------------------------------
  // 3. Contingency & Management Reserves
  // -------------------------------------------------------------
  // No reserves table exists in the schema, so there are no reserve balances to show. The
  // previous revision hardcoded three demo reserves (RES-01..03 with allocated/spent/remaining
  // figures and approval notes) as if they were project facts; fabricated reserve balances are
  // forbidden, so the register starts empty and renders N/A until real reserve data exists.
  // The drawdown recorder below stays dormant (its trigger hides while the register is empty)
  // and can only ever operate on user-provided entries, never on invented seeds.
  const [reserves, setReserves] = useState<ReserveBurnItem[]>([]);

  const totalReservesAllocated = reserves.reduce((s, r) => s + r.allocatedAmountSar, 0);
  const totalReservesSpent = reserves.reduce((s, r) => s + r.spentToDateSar, 0);
  const totalReservesRemaining = reserves.reduce((s, r) => s + r.remainingAmountSar, 0);
  const totalReservesUtilization = totalReservesAllocated > 0 ? (totalReservesSpent / totalReservesAllocated) * 100 : 0;

  // -------------------------------------------------------------
  // 4. Multi-Formula EAC Forecast & TCPI Matrix (GAP-009 / GAP-042 / GAP-047)
  // -------------------------------------------------------------
  // Single shared implementation in `@/lib/budgetForecastEngine`: no EAC or TCPI formula lives in
  // this view any more. The canonical EVM scalars are the only inputs, and the canonical
  // `evm.tcpi` / `evm.tcpiStatus` are passed through so `assessEvmRatios` stays the one producer
  // of TCPI(BAC). The previous local pair fell back to `1.0` when the budget was exhausted or the
  // denominator was zero, which rendered an overrun as "easy (TCPI <= 1.0)".
  const multiEacData: MultiEacForecast = useMemo(() => {
    return calculateMultiEacForecast({
      bac: evm.bac,
      ev: evm.ev,
      ac: evm.ac,
      cpi: evm.cpi,
      spi: evm.spi,
      tcpi: evm.tcpi,
      tcpiStatus: evm.tcpiStatus,
    });
  }, [evm]);

  /** Renders an EAC model: the number when it is computable, an explicit N/A when it is not. */
  const renderModelValue = (model: EacModelResult): string => {
    if (model.isComputable) return `${model.eac.toLocaleString()} SAR`;
    return lang === 'ar' ? 'غير قابل للحساب — لا يوجد تقدير (N/A)' : 'Not computable — no forecast (N/A)';
  };

  /** Renders a TCPI reading: a measured index, or the semantic state. Never the 9.99 sentinel. */
  const renderTcpi = (reading: TcpiReading): string => {
    if (reading.display === 'value') return reading.value.toFixed(2);
    if (reading.display === 'not_available') {
      return lang === 'ar' ? 'غير محدد (N/A) — لا توجد ميزانية متبقية' : 'Undefined (N/A) — no remaining budget';
    }
    return lang === 'ar' ? 'تجاوز / استنفاد الميزانية (Overrun)' : 'Budget exhausted (Overrun)';
  };

  const tcpiIsComputable = multiEacData.tcpiToBudget.isComputable;

  // Handle new reserve drawdown
  const handleAddReserveDraw = () => {
    if (!reserveDrawForm.nameAr || reserveDrawForm.amountSar <= 0) return;
    const targetReserve = reserves.find((r) => r.reserveType === reserveDrawForm.reserveType);
    if (!targetReserve) return;

    const newSpent = targetReserve.spentToDateSar + Number(reserveDrawForm.amountSar);
    const newRemaining = Math.max(0, targetReserve.allocatedAmountSar - newSpent);
    const newUtil = Number(((newSpent / targetReserve.allocatedAmountSar) * 100).toFixed(1));

    setReserves((prev) =>
      prev.map((r) =>
        r.id === targetReserve.id
          ? {
              ...r,
              spentToDateSar: newSpent,
              remainingAmountSar: newRemaining,
              utilizationPercent: newUtil,
              status: newUtil > 80 ? 'exhausted' : newUtil > 60 ? 'caution' : 'healthy',
            }
          : r
      )
    );

    setShowReserveModal(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-amber-500 border-t-transparent"></div>
      </div>
    );
  }

  if (!project) {
    return <div className="text-center text-slate-400 py-12">لا يوجد مشروع محدد</div>;
  }

  return (
    <div className="space-y-6 select-none">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shadow-xs">
              <Wallet size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black text-slate-900">
                  {lang === 'ar' ? 'الميزانية والتحكم المالي المتقدم' : 'Enterprise Budget & Financial Control Workstation'}
                </h1>
                <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
                  EVM · CBS · Cash Flow · Reserves
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'ar'
                  ? 'إدارة التدفقات النقدية، مؤشرات الأداء المطلوبة TCPI، مصفوفة التنبؤ الرباعية EAC، مراكز التكلفة CBS، ومراقبة احتياطي الطوارئ.'
                  : 'Cash Flow S-Curve, TCPI efficiency indices, 4-formula EAC forecasting, CBS cost centers, and reserve burn-down controls.'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-bold text-slate-700 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200">
          <DollarSign size={15} className="text-amber-600" />
          <span>ميزانية المشروع: <strong className="font-mono text-slate-900">{totals.planned.toLocaleString()} SAR</strong></span>
        </div>
      </div>

      {/* DEDICATED FULL-WIDTH TAB NAVIGATION BAR */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200 shadow-xs">
        <button
          onClick={() => setActiveTab('evm_tcpi')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'evm_tcpi'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <Zap size={15} className={activeTab === 'evm_tcpi' ? 'text-amber-400' : 'text-amber-600'} />
          <span>مؤشرات EVM و TCPI و EAC</span>
        </button>

        <button
          onClick={() => setActiveTab('cash_flow')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'cash_flow'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <TrendingUp size={15} className={activeTab === 'cash_flow' ? 'text-amber-400' : 'text-blue-600'} />
          <span>التدفقات النقدية (Cash Flow)</span>
        </button>

        <button
          onClick={() => setActiveTab('cbs_centers')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'cbs_centers'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <PieChart size={15} className={activeTab === 'cbs_centers' ? 'text-amber-400' : 'text-purple-600'} />
          <span>مراكز التكلفة (CBS)</span>
        </button>

        <button
          onClick={() => setActiveTab('reserves')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'reserves'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <ShieldAlert size={15} className={activeTab === 'reserves' ? 'text-amber-400' : 'text-rose-600'} />
          <span>احتياطي الطوارئ (Reserves)</span>
        </button>

        <button
          onClick={() => setActiveTab('transactions_table')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center col-span-2 sm:col-span-1 ${
            activeTab === 'transactions_table'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <FileText size={15} className={activeTab === 'transactions_table' ? 'text-amber-400' : 'text-emerald-600'} />
          <span>سجل بنود الميزانية والمصروفات</span>
        </button>

        <button
          onClick={() => setActiveTab('cost_control')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center col-span-2 sm:col-span-1 ${
            activeTab === 'cost_control'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <Wallet size={15} className={activeTab === 'cost_control' ? 'text-amber-400' : 'text-amber-700'} />
          <span>التحكم بالتكلفة (F6)</span>
        </button>
      </div>

      {notice && (
        <div className="p-3 bg-blue-50/90 border border-blue-200 text-blue-900 rounded-xl text-xs font-medium flex items-center justify-between shadow-sm">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="text-blue-500 hover:text-blue-700 font-bold text-sm cursor-pointer">×</button>
        </div>
      )}

      {/* Summary KPI Ribbon */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 mb-1">
            <DollarSign size={16} />
            <span className="text-xs font-bold">ميزانية العقد (BAC)</span>
          </div>
          <p className="text-xl font-black text-slate-800 font-mono">{totals.planned.toLocaleString()} <span className="text-xs font-normal">SAR</span></p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-blue-500 mb-1">
            <DollarSign size={16} />
            <span className="text-xs font-bold">ملتزم تعاقدياً</span>
          </div>
          {/* UG-051: the stored committed_cost total, or an explicit "no data" state. Never 75% of BAC. */}
          {committedSummary.status === 'no_commitment_data' ? (
            <>
              <p className="text-xl font-black text-slate-400 font-mono">
                {lang === 'ar' ? 'لا توجد التزامات مسجلة' : 'No commitments recorded'}
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5">
                {lang === 'ar'
                  ? 'لا يوجد أي بيان committed_cost في بنود الميزانية — لا يُعرض رقم مُقدَّر.'
                  : 'No committed_cost value exists on any budget line — no estimated figure is shown.'}
              </p>
            </>
          ) : (
            <>
              <p className="text-xl font-black text-blue-700 font-mono">{totals.committed.toLocaleString()} <span className="text-xs font-normal">SAR</span></p>
              <p className="text-[10px] text-slate-400 mt-0.5">
                {lang === 'ar'
                  ? `${committedSummary.linesWithCommitment} من ${committedSummary.linesTotal} بند ميزانية تحمل قيمة التزام مسجلة`
                  : `${committedSummary.linesWithCommitment} of ${committedSummary.linesTotal} budget lines carry a recorded commitment`}
                {committedSummary.status === 'zero_recorded'
                  ? (lang === 'ar' ? ' — الالتزام المسجل صفر' : ' — recorded commitment is zero')
                  : ''}
              </p>
            </>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-amber-500 mb-1">
            <DollarSign size={16} />
            <span className="text-xs font-bold">التكلفة الفعلية (AC)</span>
          </div>
          <p className="text-xl font-black text-amber-800 font-mono">{totals.actual.toLocaleString()} <span className="text-xs font-normal">SAR</span></p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-emerald-500 mb-1">
            <DollarSign size={16} />
            <span className="text-xs font-bold">المتبقي بالميزانية</span>
          </div>
          <p className="text-xl font-black text-emerald-700 font-mono">{totals.remaining.toLocaleString()} <span className="text-xs font-normal">SAR</span></p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className={`flex items-center gap-2 mb-1 ${totals.variance >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
            {totals.variance >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
            <span className="text-xs font-bold">انحراف التكلفة (CV)</span>
          </div>
          <p className={`text-xl font-black font-mono ${totals.variance >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {totals.variance > 0 ? `+${totals.variance.toLocaleString()}` : totals.variance.toLocaleString()} <span className="text-xs font-normal">SAR</span>
          </p>
        </div>
      </div>

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 1: EVM KPIs + MULTI-FORMULA EAC FORECAST MATRIX + TCPI INDICATOR            */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'evm_tcpi' && (
        <div className="space-y-6">
          {/* TCPI Hero Card */}
          <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white rounded-2xl p-6 shadow-sm border border-slate-700 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-4">
              <div>
                <span className="text-[11px] font-mono font-bold text-amber-400 bg-slate-800 px-2.5 py-1 rounded-md border border-amber-500/30">
                  PMI / AACE Standard Formula
                </span>
                <h3 className="text-lg font-black text-white mt-1.5 flex items-center gap-2">
                  <span>مؤشر الأداء المطلوب لإكمال المشروع (To-Complete Performance Index - TCPI)</span>
                </h3>
                <p className="text-xs text-slate-300 mt-0.5">
                  يقيس كفاءة التكلفة التي يجب أن تعمل بها الفرق للأعمال المتبقية لتحقيق هدف الميزانية التعاقدية (BAC) أو الميزانية التقديرية (EAC).
                </p>
              </div>

              <div className="text-left">
                <span className="text-[11px] text-slate-400 block font-semibold">مستوى الجدوى الهندسية:</span>
                {/* GAP-042: feasibility is only assessable from a measurable TCPI. A budget that is
                    exhausted or fully consumed reads as "not assessable", never as "easy". */}
                <span className={`px-3 py-1 rounded-full text-xs font-black ${
                  multiEacData.feasibility === 'easy'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : multiEacData.feasibility === 'realistic'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : multiEacData.feasibility === 'not_assessable'
                    ? 'bg-slate-500/20 text-slate-300 border border-slate-500/40'
                    : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                }`}>
                  {multiEacData.feasibility === 'easy'
                    ? '✓ مرن ومريح (TCPI ≤ 1.0)'
                    : multiEacData.feasibility === 'realistic'
                    ? '✓ واقعي وممكن تحقيقه (1.0 < TCPI ≤ 1.1)'
                    : multiEacData.feasibility === 'hard'
                    ? '⚠️ يتطلب ترشيد تكاليف مشدد (1.1 < TCPI ≤ 1.25)'
                    : multiEacData.feasibility === 'unachievable'
                    ? '⛔ غير قابل للتحقيق (TCPI > 1.25)'
                    : '— غير قابل للتقييم (لا يوجد مؤشر TCPI صالح)'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-xs text-slate-400 block">مؤشر TCPI بالنسبة لميزانية العقد الأصلية (BAC):</span>
                {/* Canonical Wave-2 reading (evm.tcpi + evm.tcpiStatus). The 9.99 compatibility
                    sentinel is never rendered as an index; the semantic state is shown instead. */}
                <div className={`text-2xl font-black font-mono ${tcpiIsComputable ? 'text-amber-400' : 'text-rose-300'}`}>
                  {renderTcpi(multiEacData.tcpiToBudget)}
                </div>
                <p className="text-[11px] text-slate-300">
                  {tcpiIsComputable
                    ? (lang === 'ar'
                        ? `يلزم تنفيذ الأعمال المتبقية (${multiEacData.tcpiToBudget.workRemaining.toLocaleString()} ر.س) بكفاءة ${multiEacData.tcpiToBudget.value.toFixed(2)} ضمن المتبقي من الميزانية (${multiEacData.tcpiToBudget.fundsRemaining.toLocaleString()} ر.س).`
                        : `Remaining work of ${multiEacData.tcpiToBudget.workRemaining.toLocaleString()} SAR must be delivered at ${multiEacData.tcpiToBudget.value.toFixed(2)} efficiency within the ${multiEacData.tcpiToBudget.fundsRemaining.toLocaleString()} SAR of budget left.`)
                    : (lang === 'ar'
                        ? `المتبقي من الميزانية (BAC − AC) = ${multiEacData.tcpiToBudget.fundsRemaining.toLocaleString()} ر.س، لذلك المؤشر غير معرَّف رياضياً أو غير قابل للتحقيق. لا يُعرض رقم بديل.`
                        : `Remaining budget (BAC − AC) = ${multiEacData.tcpiToBudget.fundsRemaining.toLocaleString()} SAR, so the index is either mathematically undefined or unachievable. No substitute number is shown.`)}
                </p>
              </div>

              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-xs text-slate-400 block">مؤشر TCPI بالنسبة للتقدير الواقعي (EAC):</span>
                <div className={`text-2xl font-black font-mono ${multiEacData.tcpiToEac.isComputable ? 'text-emerald-400' : 'text-rose-300'}`}>
                  {renderTcpi(multiEacData.tcpiToEac)}
                </div>
                <p className="text-[11px] text-slate-300">
                  {lang === 'ar'
                    ? 'الكفاءة المطلوبة لتحقيق التقدير النهائي المعدل وفق أداء المشروع الحالي (EAC الواقعي).'
                    : 'Efficiency required to meet the realistic forecast (EAC) given current performance.'}
                </p>
              </div>

              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-xs text-slate-400 block">كفاءة التكلفة الحالية (Current CPI):</span>
                <div className={`text-2xl font-black font-mono ${evm.cpi >= 1.0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {evm.cpiStatus === 'valid'
                    ? evm.cpi.toFixed(2)
                    : (lang === 'ar' ? 'غير مقاس (N/A)' : 'Not measured (N/A)')}
                </div>
                <p className="text-[11px] text-slate-300">
                  {lang === 'ar'
                    ? 'مؤشر الأداء التراكمي المحقق حتى تاريخ البيانات — من المحرك القانوني الموحّد.'
                    : 'Cumulative performance to the Data Date — from the canonical unified engine.'}
                </p>
              </div>
            </div>
          </div>

          {/* Multi-Formula EAC Forecast Comparison Matrix */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <BarChart3 className="text-blue-600" size={18} />
                  <span>مصفوفة التنبؤ بالتكلفة النهائية عند الاكتمال بالصيغ الأربعة القياسية (Multi-Formula EAC Matrix)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  مقارنة سيناريوهات التقدير المختلفة لتحديد حدود المخاطر المالية والانحراف النهائي المتوقع (Variance at Completion - VAC).
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              {/* Formula 1: Optimistic */}
              <div className="p-4 bg-blue-50/70 rounded-xl border border-blue-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-blue-900">1. السيناريو المتفائل (EAC₁)</span>
                  <span className="text-[10px] font-mono bg-blue-200 text-blue-950 px-1.5 py-0.5 rounded font-bold">Planned Rate</span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono font-semibold">{multiEacData.optimistic.formula}</p>
                <div className="text-lg font-black text-blue-950 font-mono">
                  {renderModelValue(multiEacData.optimistic)}
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.optimistic.vac >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.optimistic.vac > 0 ? `+${multiEacData.optimistic.vac.toLocaleString()}` : multiEacData.optimistic.vac.toLocaleString()} SAR
                </div>
                {multiEacData.optimistic.isComputable ? null : (
                  <p className="text-[10px] font-bold text-rose-700">
                    {lang === 'ar'
                      ? 'المقام غير قابل للقياس — الرقم المعروض حد مرجعي (BAC) وليس تنبؤاً.'
                      : 'The denominator is not a measured value — the figure shown is the BAC reference, not a forecast.'}
                  </p>
                )}
                <p className="text-[10px] text-slate-600">بافتراض تنفيذ المتبقي بالمعدل المخطط الأصلي تماماً.</p>
              </div>

              {/* Formula 2: Realistic */}
              <div className="p-4 bg-emerald-50/70 rounded-xl border border-emerald-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-900">2. السيناريو الواقعي (EAC₂)</span>
                  <span className="text-[10px] font-mono bg-emerald-200 text-emerald-950 px-1.5 py-0.5 rounded font-bold">Current CPI</span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono font-semibold">{multiEacData.realistic.formula}</p>
                <div className="text-lg font-black text-emerald-950 font-mono">
                  {renderModelValue(multiEacData.realistic)}
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.realistic.vac >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.realistic.vac > 0 ? `+${multiEacData.realistic.vac.toLocaleString()}` : multiEacData.realistic.vac.toLocaleString()} SAR
                </div>
                {multiEacData.realistic.isComputable ? null : (
                  <p className="text-[10px] font-bold text-rose-700">
                    {lang === 'ar'
                      ? 'المقام غير قابل للقياس — الرقم المعروض حد مرجعي (BAC) وليس تنبؤاً.'
                      : 'The denominator is not a measured value — the figure shown is the BAC reference, not a forecast.'}
                  </p>
                )}
                <p className="text-[10px] text-slate-600">بافتراض استمرار نفس كفاءة التكلفة التاريخية الحالية.</p>
              </div>

              {/* Formula 3: Pessimistic Composite */}
              <div className="p-4 bg-amber-50/70 rounded-xl border border-amber-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-900">3. السيناريو المركب (EAC₃)</span>
                  <span className="text-[10px] font-mono bg-amber-200 text-amber-950 px-1.5 py-0.5 rounded font-bold">CPI × SPI</span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono font-semibold">{multiEacData.pessimistic.formula}</p>
                <div className="text-lg font-black text-amber-950 font-mono">
                  {renderModelValue(multiEacData.pessimistic)}
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.pessimistic.vac >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.pessimistic.vac > 0 ? `+${multiEacData.pessimistic.vac.toLocaleString()}` : multiEacData.pessimistic.vac.toLocaleString()} SAR
                </div>
                {multiEacData.pessimistic.isComputable ? null : (
                  <p className="text-[10px] font-bold text-rose-700">
                    {lang === 'ar'
                      ? 'المقام غير قابل للقياس — الرقم المعروض حد مرجعي (BAC) وليس تنبؤاً.'
                      : 'The denominator is not a measured value — the figure shown is the BAC reference, not a forecast.'}
                  </p>
                )}
                <p className="text-[10px] text-slate-600">يراعي أثر تأخير الجدول الزمني على زيادة التكلفة.</p>
              </div>

              {/* Formula 4: Bottom-Up */}
              <div className="p-4 bg-purple-50/70 rounded-xl border border-purple-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-purple-900">4. التقدير التصاعدي (EAC₄)</span>
                  <span className="text-[10px] font-mono bg-purple-200 text-purple-950 px-1.5 py-0.5 rounded font-bold">Bottom-up ETC</span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono font-semibold">{multiEacData.bottomUp.formula}</p>
                <div className="text-lg font-black text-purple-950 font-mono">
                  {renderModelValue(multiEacData.bottomUp)}
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.bottomUp.vac >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.bottomUp.vac > 0 ? `+${multiEacData.bottomUp.vac.toLocaleString()}` : multiEacData.bottomUp.vac.toLocaleString()} SAR
                </div>
                {multiEacData.bottomUp.isComputable ? null : (
                  <p className="text-[10px] font-bold text-rose-700">
                    {lang === 'ar'
                      ? 'المقام غير قابل للقياس — الرقم المعروض حد مرجعي (BAC) وليس تنبؤاً.'
                      : 'The denominator is not a measured value — the figure shown is the BAC reference, not a forecast.'}
                  </p>
                )}
                <p className="text-[10px] text-slate-600">مراجعة هندسية دقيقة لتكاليف وأسعار المواد المتبقية.</p>
              </div>
            </div>
          </div>

          {/* Earned Schedule Management (ESM) Section */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <ActivityIcon size={16} className="text-blue-600" />
                  <span>إدارة الجدول المكتسب بالوحدات الزمنية (Earned Schedule Management - ESM)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  قياس كفاءة الوقت بالأشهر والأيام بدلاً من العملة لتفادي وهم مؤشر $SPI$ النقدي في نهاية المشروع.
                </p>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                  {lang === 'ar'
                    ? `محسوبة بمحرك الجدول المكتسب المعتمد (calculateEarnedSchedule) من نفس بيانات المشروع المستخدمة في شاشة التقدم والتقرير التنفيذي، عند تاريخ خط الحالة ${earnedScheduleDateLabel}. لا توجد قيم نموذجية: أي مقياس بلا بيانات كافية يظهر (N/A) مع سببه.`
                    : `Computed by the canonical Earned Schedule engine (calculateEarnedSchedule) from the same project data used by the Progress and Executive Report screens, at the Data Date ${earnedScheduleDateLabel}. No sample values: any metric without sufficient data is shown as N/A with its reason.`}
                </p>
              </div>
              <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black border whitespace-nowrap ${ESM_STATUS_LABELS[earnedSchedule.status].className}`}>
                {lang === 'ar' ? ESM_STATUS_LABELS[earnedSchedule.status].ar : ESM_STATUS_LABELS[earnedSchedule.status].en}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">{lang === 'ar' ? 'الوقت الفعلي المنقضي (AT):' : 'Actual Time (AT):'}</span>
                <span className="font-mono font-black text-slate-900 text-base">
                  {esmComputable
                    ? `${formatEsmNumber(earnedSchedule.actualTimeElapsedMonths, 2)} ${lang === 'ar' ? 'شهر' : 'mo'} (${formatEsmNumber(earnedSchedule.actualTimeElapsedDays)} ${lang === 'ar' ? 'يوم' : 'd'})`
                    : (lang === 'ar' ? 'غير قابل للحساب (N/A)' : 'Not computable (N/A)')}
                </span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">{lang === 'ar' ? 'الجدول المكتسب (ES):' : 'Earned Schedule (ES):'}</span>
                <span className="font-mono font-black text-blue-900 text-base">
                  {esmComputable
                    ? `${formatEsmNumber(earnedSchedule.earnedScheduleMonths, 2)} ${lang === 'ar' ? 'شهر' : 'mo'} (${formatEsmNumber(earnedSchedule.earnedScheduleDays)} ${lang === 'ar' ? 'يوم' : 'd'})`
                    : (lang === 'ar' ? 'غير قابل للحساب (N/A)' : 'Not computable (N/A)')}
                </span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">{lang === 'ar' ? 'مؤشر الأداء الزمني SPI(t):' : 'Time-based SPI(t):'}</span>
                <span className={`font-mono font-black text-base ${earnedSchedule.schedulePerformanceIndexTime >= 1 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {esmComputable ? formatEsmNumber(earnedSchedule.schedulePerformanceIndexTime, 2) : (lang === 'ar' ? 'غير قابل للحساب (N/A)' : 'Not computable (N/A)')}
                </span>
                <span className="text-[10px] text-slate-500 font-mono block">
                  {esmComputable
                    ? `SV(t) = ${earnedSchedule.scheduleVarianceTimeDays >= 0 ? '+' : ''}${formatEsmNumber(earnedSchedule.scheduleVarianceTimeDays)} ${lang === 'ar' ? 'يوم' : 'd'}`
                    : `SV(t) = N/A`}
                </span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">{lang === 'ar' ? 'التسليم المتوقع زمنياً IEAC(t):' : 'Time-based IEAC(t):'}</span>
                <span className="font-mono font-black text-purple-900 text-base">
                  {esmIeacComputable
                    ? `${formatEsmNumber(earnedSchedule.estimatedDurationAtCompletionMonths, 2)} ${lang === 'ar' ? 'شهر' : 'mo'} (${formatEsmNumber(earnedSchedule.estimatedDurationAtCompletionDays)} ${lang === 'ar' ? 'يوم' : 'd'})`
                    : (lang === 'ar' ? 'غير قابل للحساب (N/A)' : 'Not computable (N/A)')}
                </span>
                <span className="text-[10px] text-slate-500 font-mono block">
                  {esmIeacComputable
                    ? `${lang === 'ar' ? 'تاريخ الانتهاء المتوقع' : 'Forecast finish'}: ${earnedSchedule.forecastCompletionDate} · VAC(t) = ${earnedSchedule.varianceAtCompletionTimeDays >= 0 ? '+' : ''}${formatEsmNumber(earnedSchedule.varianceAtCompletionTimeDays)} ${lang === 'ar' ? 'يوم' : 'd'}`
                    : (lang === 'ar' ? 'لا يُعرض تاريخ بديل عند تعذّر الحساب' : 'No substitute date is shown when it is not computable')}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
              <div className="p-3 bg-white rounded-xl border border-slate-200 space-y-1">
                <span className="text-slate-400 block font-bold">{lang === 'ar' ? 'المرجع الزمني المخطط (PD)' : 'Planned duration reference (PD)'}</span>
                <span className="font-mono text-slate-800">
                  {esmComputable
                    ? `${formatEsmNumber(earnedSchedule.plannedDurationMonths, 2)} ${lang === 'ar' ? 'شهر' : 'mo'} (${formatEsmNumber(earnedSchedule.plannedDurationDays)} ${lang === 'ar' ? 'يوم' : 'd'}) · ${lang === 'ar' ? 'النهاية المخططة' : 'planned finish'} ${earnedSchedule.plannedCompletionDate}`
                    : (lang === 'ar' ? 'غير قابل للحساب (N/A)' : 'Not computable (N/A)')}
                </span>
                <span className="text-slate-500 block">
                  {lang === 'ar' ? 'تاريخ خط الحالة الحاكم: ' : 'Governing Data Date: '}
                  <strong className="font-mono text-slate-800">{earnedScheduleDateLabel}</strong>
                </span>
              </div>
              <div className="p-3 bg-white rounded-xl border border-slate-200 space-y-1">
                <span className="text-slate-400 block font-bold">{lang === 'ar' ? 'مقارنة بالـ EVM النقدي (من نفس المحرك)' : 'Comparison with the money-based EVM (same engine)'}</span>
                <span className="font-mono text-slate-800">
                  SPI = {formatEsmNumber(earnedSchedule.comparisonWithTraditionalEvm.evmSpi, 2)} · SV = {Math.round(earnedSchedule.comparisonWithTraditionalEvm.evmSvAmount).toLocaleString('en-US')} SAR
                </span>
                <span className="text-slate-500 block leading-relaxed">{earnedSchedule.timeDivergenceNote}</span>
              </div>
            </div>

            {!esmComputable && (
              <div className="p-3 rounded-xl border border-rose-200 bg-rose-50 text-[11px] font-bold text-rose-800">
                {lang === 'ar'
                  ? `لا يمكن احتساب الجدول المكتسب: ${esmMissingInputAr} لا تُعرض قيم بديلة أو تقديرية.`
                  : `Earned Schedule is not computable: ${esmMissingInputEn} No substitute or estimated values are shown.`}
              </div>
            )}
            {esmComputable && !esmIeacComputable && (
              <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] font-bold text-amber-900">
                {lang === 'ar'
                  ? 'SPI(t) = 0: لا يوجد جدول مكتسب حتى تاريخ خط الحالة، لذلك IEAC(t) غير قابل للحساب ولا يُعرض تاريخ تسليم بديل.'
                  : 'SPI(t) = 0: nothing has been earned by the Data Date, so IEAC(t) is not computable and no substitute finish date is shown.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 2: MONTHLY CASH FLOW S-CURVE & WORKING CAPITAL DEFICIT                       */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'cash_flow' && (
        <div className="space-y-6">
          {/* Working Capital Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">أعلى نقطة تمويل مطلوبة (Peak Working Capital)</span>
              <div className="text-xl font-black text-rose-700 font-mono">
                {peakWorkingCapitalSar == null ? 'N/A' : `${peakWorkingCapitalSar.toLocaleString()} SAR`}
              </div>
              <span className="text-[10px] text-slate-500">{lang === 'ar' ? 'N/A — يتطلب التدفق الداخل (لا توجد بيانات تحصيل)' : 'N/A — needs cash-in data (no collection records)'}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي التدفقات النقدية الداخلة (Total Cash-In)</span>
              <div className="text-xl font-black text-emerald-700 font-mono">
                {!hasCashInData ? 'N/A' : `${cashFlowTimeline.reduce((s, b) => s + (b.cashInNetReceivedSar || 0), 0).toLocaleString()} SAR`}
              </div>
              <span className="text-[10px] text-emerald-600 font-semibold">{lang === 'ar' ? 'N/A — لا توجد بيانات مستخلصات/تحصيل في النظام' : 'N/A — no receivables data in the system'}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي التدفقات الخارجة (Total Cash-Out)</span>
              <div className="text-xl font-black text-slate-900 font-mono">
                {cashFlowTimeline.reduce((s, b) => s + b.cashOutCommittedSar, 0).toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-slate-500">{lang === 'ar' ? 'من حركات التكلفة المعتمدة حسب الشهر' : 'From approved cost transactions by month'}</span>
            </div>
          </div>

          {/* Monthly Cash Flow Table & S-Curve Bars */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  جدول التدفقات النقدية الشهرية ورصد العجز المالي (Monthly Cash Flow Timeline)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {lang === 'ar'
                    ? 'التدفق الخارج من حركات التكلفة المعتمدة حسب الشهر. التدفق الداخل N/A — لا توجد بيانات مستخلصات/تحصيل في النظام، لذا الصافي والتراكمي وذروة التمويل وحالة السيولة N/A.'
                    : 'Cash-out is bound to approved cost transactions by month. Cash-in is N/A — no collection data exists, so net, cumulative, peak funding and liquidity status are N/A.'}
                </p>
              </div>
              <span className="text-xs font-mono font-bold bg-amber-50 text-amber-900 px-2.5 py-1 rounded border border-amber-200">
                {lang === 'ar' ? 'التدفق الداخل: N/A — لا توجد بيانات تحصيل' : 'Cash-In: N/A — no collection data'}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">الفترة الشهرية</th>
                    <th className="p-3 text-right">القيمة المخططة (PV)</th>
                    <th className="p-3 text-right bg-emerald-50 text-emerald-950">التدفق الداخل (Cash-In)</th>
                    <th className="p-3 text-right bg-rose-50 text-rose-950">التدفق الخارج (Cash-Out)</th>
                    <th className="p-3 text-right">صافي التدفق الشهري</th>
                    <th className="p-3 text-right">السيولة التراكمية (Net Balance)</th>
                    <th className="p-3 text-center">حالة السيولة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {cashFlowTimeline.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-slate-400">
                        {lang === 'ar' ? 'لا توجد نافذة زمنية أو حركات معتمدة لعرضها (N/A)' : 'No time window or approved transactions to show (N/A)'}
                      </td>
                    </tr>
                  )}
                  {cashFlowTimeline.map((b) => (
                    <tr key={b.periodMonth} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-bold text-slate-900">{b.monthLabel}</td>
                      <td className="p-3 font-mono text-slate-600">{b.plannedValueSar == null ? 'N/A' : `${b.plannedValueSar.toLocaleString()} SAR`}</td>
                      <td className="p-3 font-mono font-bold text-emerald-800 bg-emerald-50/40">
                        {b.cashInNetReceivedSar == null ? 'N/A' : `+${b.cashInNetReceivedSar.toLocaleString()} SAR`}
                      </td>
                      <td className="p-3 font-mono font-bold text-rose-800 bg-rose-50/40">
                        -{b.cashOutCommittedSar.toLocaleString()} SAR
                      </td>
                      <td className={`p-3 font-mono font-bold ${b.netMonthlyCashFlowSar == null ? 'text-slate-400' : b.netMonthlyCashFlowSar >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {b.netMonthlyCashFlowSar == null ? 'N/A' : `${b.netMonthlyCashFlowSar >= 0 ? '+' : ''}${b.netMonthlyCashFlowSar.toLocaleString()} SAR`}
                      </td>
                      <td className={`p-3 font-mono font-black ${b.cumulativeCashFlowSar == null ? 'text-slate-400' : b.cumulativeCashFlowSar >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {b.cumulativeCashFlowSar == null ? 'N/A' : `${b.cumulativeCashFlowSar >= 0 ? '+' : ''}${b.cumulativeCashFlowSar.toLocaleString()} SAR`}
                      </td>
                      <td className="p-3 text-center">
                        {b.isDeficit == null ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">
                            {lang === 'ar' ? 'غير محدد (N/A)' : 'Unknown (N/A)'}
                          </span>
                        ) : b.isDeficit ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-200">
                            عجز تمويلي ⚠️
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            فائض سيولة ✓
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 3: COST BREAKDOWN STRUCTURE (CBS) — attributed from real records (UG-050)      */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'cbs_centers' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <PieChart className="text-amber-600" size={18} />
                  <span>مراكز التكلفة حسب طبيعة التكلفة (Cost Breakdown Structure - CBS)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {lang === 'ar'
                    ? 'مبنية من السجلات المالية الفعلية فقط: بنود الميزانية (المخطط والالتزام) وحركات التكلفة المعتمدة حتى تاريخ البيانات (الفعلي). لا تُستخدم أي نسب ثابتة.'
                    : 'Built only from real financial records: budget lines (planned and committed) and approved cost transactions up to the Data Date (actual). No fixed percentages are used.'}
                </p>
              </div>
            </div>

            {/* Provenance + reconciliation banner */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                <span className="font-black text-slate-700 block">
                  {lang === 'ar' ? 'مصدر التصنيف' : 'Classification source'}
                </span>
                <span className="text-slate-600">
                  {lang === 'ar'
                    ? `بنود الميزانية: ${cbs.classification.mappedBudgetLines} مصنَّف / ${cbs.classification.unmappedBudgetLines} غير مصنَّف · حركات التكلفة المعتمدة: ${cbs.classification.mappedTransactions} مصنَّفة / ${cbs.classification.unmappedTransactions} غير مصنَّفة`
                    : `Budget lines: ${cbs.classification.mappedBudgetLines} mapped / ${cbs.classification.unmappedBudgetLines} unmapped · Approved transactions: ${cbs.classification.mappedTransactions} mapped / ${cbs.classification.unmappedTransactions} unmapped`}
                </span>
              </div>
              <div className={`border rounded-lg p-3 space-y-1 ${cbs.reconciliation.plannedBalanced && cbs.reconciliation.actualBalanced ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                <span className="font-black text-slate-700 block">
                  {lang === 'ar' ? 'التسوية مع الإجماليات القانونية' : 'Reconciliation to canonical totals'}
                </span>
                <span className={cbs.reconciliation.plannedBalanced && cbs.reconciliation.actualBalanced ? 'text-emerald-700' : 'text-rose-700'}>
                  {lang === 'ar'
                    ? `المخطط: ${cbs.reconciliation.totalPlanned.toLocaleString()} ر.س (فارق ${cbs.reconciliation.plannedDelta.toLocaleString()}) · الفعلي: ${cbs.reconciliation.totalActual.toLocaleString()} ر.س (فارق ${cbs.reconciliation.actualDelta.toLocaleString()})`
                    : `Planned: ${cbs.reconciliation.totalPlanned.toLocaleString()} SAR (delta ${cbs.reconciliation.plannedDelta.toLocaleString()}) · Actual: ${cbs.reconciliation.totalActual.toLocaleString()} SAR (delta ${cbs.reconciliation.actualDelta.toLocaleString()})`}
                </span>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
                <span className="font-black text-slate-700 block">
                  {lang === 'ar' ? 'غير المصنَّف صراحةً' : 'Explicitly unclassified'}
                </span>
                <span className="text-slate-600">
                  {lang === 'ar'
                    ? `مخطط ${cbs.reconciliation.unclassifiedPlanned.toLocaleString()} ر.س · فعلي ${cbs.reconciliation.unclassifiedActual.toLocaleString()} ر.س (منه ${cbs.reconciliation.unallocatedPlanned.toLocaleString()} ر.س خارج بنود الميزانية و${cbs.reconciliation.unrecordedActual.toLocaleString()} ر.س بلا حركة تكلفة معتمدة)`
                    : `Planned ${cbs.reconciliation.unclassifiedPlanned.toLocaleString()} SAR · Actual ${cbs.reconciliation.unclassifiedActual.toLocaleString()} SAR (of which ${cbs.reconciliation.unallocatedPlanned.toLocaleString()} SAR sits outside budget lines and ${cbs.reconciliation.unrecordedActual.toLocaleString()} SAR has no approved transaction)`}
                </span>
              </div>
            </div>

            {/* CBS Table */}
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">مركز التكلفة (CBS Element)</th>
                    <th className="p-3 text-right">الميزانية المخصصة (Budget)</th>
                    <th className="p-3 text-right">الالتزام المالي (Committed)</th>
                    <th className="p-3 text-right">المصروف الفعلي (Actual)</th>
                    <th className="p-3 text-right">المتبقي (Remaining)</th>
                    <th className="p-3 text-right">الانحراف المالي (Variance)</th>
                    <th className="p-3 text-center">نسبة الانحراف %</th>
                    <th className="p-3 text-center">السجلات (Records)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {cbsCenters.map((center) => (
                    <tr key={center.id} className={`hover:bg-slate-50 transition-colors ${center.isUnclassified ? 'bg-amber-50/40' : ''}`}>
                      <td className="p-3 font-bold text-slate-900">
                        {lang === 'ar' ? center.nameAr : center.nameEn}
                        {center.isUnclassified && (
                          <span className="block text-[10px] font-medium text-amber-700 max-w-xs">
                            {center.description}
                          </span>
                        )}
                      </td>
                      <td className="p-3 font-mono text-slate-800">{center.budgetAllocatedSar.toLocaleString()} SAR</td>
                      <td className="p-3 font-mono text-blue-700">
                        {center.committedCostStatus === 'no_commitment_data'
                          ? <span className="text-slate-400 font-sans">{lang === 'ar' ? 'لا توجد التزامات مسجلة' : 'No commitments recorded'}</span>
                          : `${center.committedCostSar.toLocaleString()} SAR`}
                      </td>
                      <td className="p-3 font-mono text-amber-800 font-bold">{center.actualCostSar.toLocaleString()} SAR</td>
                      <td className="p-3 font-mono text-emerald-700">{center.remainingCostSar.toLocaleString()} SAR</td>
                      <td className={`p-3 font-mono font-black ${center.varianceSar >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {center.varianceSar >= 0 ? `+${center.varianceSar.toLocaleString()}` : center.varianceSar.toLocaleString()} SAR
                      </td>
                      <td className="p-3 text-center font-mono font-bold">
                        {center.budgetAllocatedSar === 0 ? (
                          <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 text-slate-500">
                            {lang === 'ar' ? 'لا ينطبق' : 'N/A'}
                          </span>
                        ) : (
                          <span className={`px-2 py-0.5 rounded text-[10px] ${center.variancePercent >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                            {center.variancePercent}%
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-center font-mono text-slate-600">{center.mappedRecordCount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-black text-slate-900 border-t">
                  <tr>
                    <td className="p-3">{lang === 'ar' ? 'الإجمالي العام لمراكز التكلفة:' : 'Total across cost centers:'}</td>
                    <td className="p-3 font-mono">{cbsCenters.reduce((sum, c) => sum + c.budgetAllocatedSar, 0).toLocaleString()} SAR</td>
                    <td className="p-3 font-mono text-blue-700">
                      {committedSummary.status === 'no_commitment_data'
                        ? <span className="text-slate-400 font-sans">{lang === 'ar' ? 'لا توجد التزامات مسجلة' : 'No commitments recorded'}</span>
                        : `${cbsCenters.reduce((sum, c) => sum + c.committedCostSar, 0).toLocaleString()} SAR`}
                    </td>
                    <td className="p-3 font-mono text-amber-800">{cbsCenters.reduce((sum, c) => sum + c.actualCostSar, 0).toLocaleString()} SAR</td>
                    <td className="p-3 font-mono text-emerald-700">{cbsCenters.reduce((sum, c) => sum + c.remainingCostSar, 0).toLocaleString()} SAR</td>
                    <td className="p-3 font-mono">{cbsCenters.reduce((sum, c) => sum + c.varianceSar, 0).toLocaleString()} SAR</td>
                    <td colSpan={2}></td>
                  </tr>
                  <tr>
                    <td className="p-3 text-[11px] font-bold text-slate-600" colSpan={8}>
                      {lang === 'ar'
                        ? `التسوية: مجموع المخطط = BAC القانوني (${cbs.reconciliation.totalPlanned.toLocaleString()} ر.س) ومجموع الفعلي = AC القانوني (${cbs.reconciliation.totalActual.toLocaleString()} ر.س) — الفارق ${cbs.reconciliation.plannedDelta.toLocaleString()} / ${cbs.reconciliation.actualDelta.toLocaleString()} ر.س.`
                        : `Reconciliation: planned sums to the canonical BAC (${cbs.reconciliation.totalPlanned.toLocaleString()} SAR) and actual to the canonical AC (${cbs.reconciliation.totalActual.toLocaleString()} SAR) — delta ${cbs.reconciliation.plannedDelta.toLocaleString()} / ${cbs.reconciliation.actualDelta.toLocaleString()} SAR.`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 4: CONTINGENCY & MANAGEMENT RESERVE CONTROLS                                 */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'reserves' && (
        <div className="space-y-6">
          {/* Reserves Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي المخصص للاحتياطيات</span>
              <div className="text-xl font-black text-slate-900 font-mono">
                {reserves.length === 0 ? 'N/A' : `${totalReservesAllocated.toLocaleString()} SAR`}
              </div>
              <span className="text-[10px] text-slate-500">{reserves.length === 0 ? (lang === 'ar' ? 'لا توجد بيانات احتياطي مسجلة' : 'No reserve data recorded') : 'طوارئ مخاطر + إدارة'}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">المسحوب والمستهلك حتى تاريخه</span>
              <div className="text-xl font-black text-amber-800 font-mono">
                {reserves.length === 0 ? 'N/A' : `${totalReservesSpent.toLocaleString()} SAR`}
              </div>
              <span className="text-[10px] text-amber-700 font-semibold">{reserves.length === 0 ? 'N/A' : `معدل الاستهلاك: ${totalReservesUtilization.toFixed(1)}%`}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">الرصيد المتبقي المتاح</span>
              <div className="text-xl font-black text-emerald-700 font-mono">
                {reserves.length === 0 ? 'N/A' : `${totalReservesRemaining.toLocaleString()} SAR`}
              </div>
              <span className="text-[10px] text-emerald-600 font-semibold">{reserves.length === 0 ? (lang === 'ar' ? 'لا توجد بيانات احتياطي مسجلة' : 'No reserve data recorded') : 'جاهز لمواجهة أي مستجدات'}</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">سحب جديد</span>
                {/* The recorder can only draw against a user-provided reserve entry; with an
                    empty register there is nothing to draw from, so the trigger hides. */}
                {reserves.length > 0 ? (
                  <button
                    onClick={() => setShowReserveModal(true)}
                    className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 rounded-lg text-xs font-bold transition-all shadow-sm cursor-pointer"
                  >
                    + طلب سحب من الاحتياطي
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">{lang === 'ar' ? 'لا يوجد احتياطي مسجل للسحب منه (N/A)' : 'No recorded reserve to draw from (N/A)'}</span>
                )}
              </div>
            </div>
          </div>

          {/* Reserves Table */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  سجل ومراقبة استهلاك مخصصات واحتياطيات المشروع (Reserve Drawdown Register)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {lang === 'ar'
                    ? 'لا يوجد جدول احتياطيات في النظام — لا تُعرض أي أرصدة مختلقة. تظهر البيانات هنا فقط عند توفر مصدر حقيقي لها.'
                    : 'No reserves table exists in the system — no invented balances are shown. Data appears here only when a real source exists.'}
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">نوع ومسمى الاحتياطي</th>
                    <th className="p-3 text-right">المخصص الأصلي (SAR)</th>
                    <th className="p-3 text-right">المستهلك حتى الآن (SAR)</th>
                    <th className="p-3 text-right">المتبقي (SAR)</th>
                    <th className="p-3 text-center">معدل الاستهلاك</th>
                    <th className="p-3 text-right">المخاطر المربوطة والمبررات</th>
                    <th className="p-3 text-center">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {reserves.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-slate-400">
                        {lang === 'ar' ? 'لا توجد احتياطيات مسجلة لهذا المشروع (N/A) — لا يُعرض رقم مختلق.' : 'No reserves recorded for this project (N/A) — no invented figure is shown.'}
                      </td>
                    </tr>
                  )}
                  {reserves.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3">
                        <div className="font-bold text-slate-900">{r.nameAr}</div>
                        <span className="font-mono text-[10px] text-slate-400">
                          {r.reserveType === 'contingency' ? 'Contingency Reserve (Known-Unknowns)' : 'Management Reserve (Unknown-Unknowns)'}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-slate-800">{r.allocatedAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 font-mono font-bold text-amber-800">{r.spentToDateSar.toLocaleString()} SAR</td>
                      <td className="p-3 font-mono font-black text-emerald-700">{r.remainingAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-16 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-500 rounded-full" style={{ width: `${r.utilizationPercent}%` }} />
                          </div>
                          <span className="font-mono font-bold text-slate-700">{r.utilizationPercent}%</span>
                        </div>
                      </td>
                      <td className="p-3 text-slate-600 max-w-sm">
                        <div className="font-semibold text-slate-800">{r.associatedRiskTitle}</div>
                        <div className="text-[10px] text-slate-400">{r.authorizationNotes}</div>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          r.status === 'healthy' ? 'bg-emerald-100 text-emerald-800' : r.status === 'caution' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                        }`}>
                          {r.status === 'healthy' ? 'آمن ومستقر' : r.status === 'caution' ? 'تنبيه استنزاف' : 'مستنفذ'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 5: BUDGET LINES & COST TRANSACTIONS TABLE                                    */}
      {/* -------------------------------------------------------------------------------- */}
      {/* Cost Control Tab — F6: BAC/PV/EV/AC, EAC methods, commitments, trend, anomalies, actions. */}
      {activeTab === 'cost_control' && costReport && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-3">
              <div>
                <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <Wallet className="text-amber-600" size={20} />
                  <span>التحكم بالتكلفة والتنبؤ (Cost Control)</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-200">
                    Data Date {costReport.dataDate}
                  </span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  BAC من الموازنة المعتمدة فقط · PV/EAC بلا قيم مخترعة · القسمة على صفر = N/A · الطرق الأربع معلنة والمُوصى به مبرر.
                </p>
              </div>
              <button
                onClick={() => void handleSaveCostSnapshot()}
                disabled={savingSnapshot}
                className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 px-4 py-2 rounded-xl text-xs font-bold transition-all disabled:opacity-50 cursor-pointer shadow-sm"
              >
                <Save size={13} />
                {savingSnapshot ? 'جاري الحفظ...' : 'حفظ لقطة التكلفة'}
              </button>
            </div>

            {/* BAC + PV/EV/AC */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                <span className="text-[11px] text-amber-400 font-bold block">BAC (الميزانية المعتمدة)</span>
                <div className="text-sm font-black text-white font-mono">{costReport.project.bac !== null ? costReport.project.bac.toLocaleString() : 'N/A'}</div>
                <span className="text-[10px] text-slate-300 block mt-0.5">المصدر: {costReport.bac.source} · {costReport.bac.confidence}</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-[11px] text-slate-500 font-bold block">PV (المخطط)</span>
                <div className="text-sm font-black text-slate-900 font-mono">{costReport.project.pv !== null ? costReport.project.pv.toLocaleString() : 'N/A'}</div>
                <span className="text-[10px] text-slate-400 block mt-0.5">{costReport.pvMethod}</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-[11px] text-slate-500 font-bold block">EV (المكتسب)</span>
                <div className="text-sm font-black text-slate-900 font-mono">{costReport.project.ev !== null ? costReport.project.ev.toLocaleString() : 'N/A'}</div>
                <span className="text-[10px] text-slate-400 block mt-0.5">التقدم المسجل × الموازنة</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-[11px] text-slate-500 font-bold block">AC (الفعلي المعتمد)</span>
                <div className="text-sm font-black text-slate-900 font-mono">{costReport.project.ac.toLocaleString()}</div>
                <span className="text-[10px] text-slate-400 block mt-0.5">{costReport.project.acCount} حركة · {costReport.project.acSource}</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-[11px] text-slate-500 font-bold block">CV / CPI</span>
                <div className={`text-sm font-black font-mono ${(costReport.project.cv || 0) < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {costReport.project.cv !== null ? costReport.project.cv.toLocaleString() : 'N/A'} / {costReport.project.cpi !== null ? costReport.project.cpi : 'N/A'}
                </div>
                <span className="text-[10px] text-slate-400 block mt-0.5">SV {costReport.project.sv !== null ? costReport.project.sv.toLocaleString() : 'N/A'} · SPI {costReport.project.spi !== null ? costReport.project.spi : 'N/A'}</span>
              </div>
            </div>

            {/* EAC methods + recommendation */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">طرق التنبؤ EAC (كل طريقة معلنة — لا اختيار صامت)</h4>
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-700 font-bold border-b">
                    <tr>
                      <th className="p-2 text-right">الطريقة</th>
                      <th className="p-2 text-right">المعادلة</th>
                      <th className="p-2 text-center">القيمة</th>
                      <th className="p-2 text-right">متى تنطبق</th>
                      <th className="p-2 text-center">الثقة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {costReport.eacMethods.map((m) => (
                      <tr key={m.key} className={costReport.recommended?.method === m.key ? 'bg-amber-50/60' : 'hover:bg-slate-50'}>
                        <td className="p-2 font-mono font-bold text-slate-900">{m.key}{costReport.recommended?.method === m.key ? ' ★' : ''}</td>
                        <td className="p-2 font-mono text-slate-600">{m.formula}</td>
                        <td className="p-2 text-center font-mono font-bold">{m.value !== null ? m.value.toLocaleString() : 'N/A'}</td>
                        <td className="p-2 text-slate-600">{m.applicability}</td>
                        <td className="p-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${m.confidence === 'High' ? 'bg-emerald-100 text-emerald-800' : m.confidence === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>
                            {m.confidence}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {costReport.recommended ? (
                <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs">
                  <span className="font-black text-slate-900">EAC الموصى به ({costReport.recommended.method}): {costReport.recommended.eac.toLocaleString()} SAR</span>
                  <span className="text-slate-600"> · ETC {costReport.recommended.etc.toLocaleString()} · VAC {costReport.recommended.vac !== null ? costReport.recommended.vac.toLocaleString() : 'N/A'}</span>
                  <p className="text-slate-600 mt-1"><span className="font-bold">لماذا:</span> {costReport.recommended.why}</p>
                </div>
              ) : (
                <p className="mt-2 text-xs text-slate-500">N/A — {costReport.recommendedNote}</p>
              )}
              {/* Manual ETC editor */}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <label className="font-bold text-slate-700">ETC يدوية (إعادة تقدير المتبقي — فارغ = غير مسجلة):</label>
                <input
                  type="number"
                  min="0"
                  value={manualEtcInput}
                  onChange={(e) => setManualEtcInput(e.target.value)}
                  placeholder="SAR"
                  className="w-44 px-3 py-1.5 border border-slate-300 rounded-xl text-xs font-mono outline-none focus:ring-2 focus:ring-amber-500 bg-white"
                />
                <button
                  onClick={() => void handleSaveManualEtc()}
                  disabled={savingManual}
                  className="px-3 py-1.5 bg-slate-900 text-amber-400 rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer"
                >
                  {savingManual ? 'جاري الحفظ...' : 'حفظ ETC اليدوية'}
                </button>
                {manualEtcValue !== null && <span className="text-slate-500 font-mono">الحالية: {manualEtcValue.toLocaleString()} SAR</span>}
              </div>
            </div>

            {/* Commitment split */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">الالتزامات (Budget / Committed / Actual / Remaining / Forecast)</h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-xs">
                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200"><span className="text-slate-500 font-bold block">الميزانية</span><span className="font-mono font-black">{costReport.commitment.budget !== null ? costReport.commitment.budget.toLocaleString() : 'N/A'}</span></div>
                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200"><span className="text-slate-500 font-bold block">الملتزم به</span><span className="font-mono font-black">{costReport.commitment.hasCommitmentData ? costReport.commitment.committed.toLocaleString() : 'N/A'}</span></div>
                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200"><span className="text-slate-500 font-bold block">الفعلي</span><span className="font-mono font-black">{costReport.commitment.actual.toLocaleString()}</span></div>
                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200"><span className="text-slate-500 font-bold block">المتبقي الملتزم</span><span className="font-mono font-black">{costReport.commitment.remainingCommitment !== null ? costReport.commitment.remainingCommitment.toLocaleString() : 'N/A'}</span></div>
                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200"><span className="text-slate-500 font-bold block">المتوقع المتبقي ETC</span><span className="font-mono font-black">{costReport.commitment.forecastEtc !== null ? costReport.commitment.forecastEtc.toLocaleString() : 'N/A'}</span></div>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">التعاقدات المفتوحة (مرجع غير مجموع): {costReport.commitment.contractedOpen !== null ? costReport.commitment.contractedOpen.toLocaleString() : 'N/A'} — {costReport.commitment.contractedNote}</p>
            </div>

            {/* WBS rollup */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">التحكم عبر WBS (تجميع شجري بلا ازدواج)</h4>
              <div className="overflow-x-auto border border-slate-200 rounded-xl max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-700 font-bold border-b sticky top-0">
                    <tr>
                      <th className="p-2 text-right">WBS</th>
                      <th className="p-2 text-center">BAC</th>
                      <th className="p-2 text-center">EV</th>
                      <th className="p-2 text-center">AC</th>
                      <th className="p-2 text-center">CV</th>
                      <th className="p-2 text-center">CPI</th>
                      <th className="p-2 text-center">EAC</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {[...costReport.wbs, costReport.unassigned].map((w) => (
                      <tr key={w.id} className="hover:bg-slate-50">
                        <td className="p-2 font-bold text-slate-900" style={{ paddingRight: `${Math.max(0, w.level) * 12 + 8}px` }}>{w.code} <span className="font-sans font-normal text-slate-500">{w.name}</span></td>
                        <td className="p-2 text-center">{w.bac.toLocaleString()}</td>
                        <td className="p-2 text-center">{w.ev !== null ? w.ev.toLocaleString() : 'N/A'}</td>
                        <td className="p-2 text-center">{w.ac.toLocaleString()}</td>
                        <td className="p-2 text-center font-bold">{w.cv !== null ? w.cv.toLocaleString() : 'N/A'}</td>
                        <td className="p-2 text-center">{w.cpi !== null ? w.cpi : 'N/A'}</td>
                        <td className="p-2 text-center">{w.eac !== null ? w.eac.toLocaleString() : 'N/A'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Activity overruns */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">تجاوزات الأنشطة (الأعلى |CV|)</h4>
              {costReport.activities.filter((a) => a.cv !== null && a.cv < 0).length === 0 ? (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">لا تجاوزات على مستوى الأنشطة.</p>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded-xl">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-700 font-bold border-b">
                      <tr>
                        <th className="p-2 text-right">النشاط</th>
                        <th className="p-2 text-center">BAC</th>
                        <th className="p-2 text-center">EV</th>
                        <th className="p-2 text-center">AC</th>
                        <th className="p-2 text-center">CV</th>
                        <th className="p-2 text-center">CPI</th>
                        <th className="p-2 text-center">EAC</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono">
                      {costReport.activities.filter((a) => a.cv !== null && (a.cv as number) < 0).sort((a, b) => (a.cv as number) - (b.cv as number)).slice(0, 8).map((a) => (
                        <tr key={a.id} className="hover:bg-slate-50">
                          <td className="p-2 font-bold text-slate-900">{a.code} <span className="font-sans font-normal text-slate-500">{a.name.slice(0, 30)}</span></td>
                          <td className="p-2 text-center">{a.bac.toLocaleString()}</td>
                          <td className="p-2 text-center">{a.ev !== null ? a.ev.toLocaleString() : 'N/A'}</td>
                          <td className="p-2 text-center">{a.ac.toLocaleString()}</td>
                          <td className="p-2 text-center font-bold text-rose-700">{a.cv !== null ? a.cv.toLocaleString() : 'N/A'}</td>
                          <td className="p-2 text-center">{a.cpi !== null ? a.cpi : 'N/A'}</td>
                          <td className="p-2 text-center">{a.eac !== null ? a.eac.toLocaleString() : 'N/A'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Integrity */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">سلامة بيانات التكلفة</h4>
              {costReport.integrity.length === 0 ? (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">نظيفة — لا ملاحظات.</p>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded-xl max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-700 font-bold border-b sticky top-0">
                      <tr>
                        <th className="p-2 text-center">الخطورة</th>
                        <th className="p-2 text-right">المرجع</th>
                        <th className="p-2 text-right">الملاحظة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {costReport.integrity.slice(0, 30).map((f, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="p-2 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${f.severity === 'error' ? 'bg-rose-100 text-rose-800' : f.severity === 'warning' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'}`}>
                              {f.severity}
                            </span>
                          </td>
                          <td className="p-2 font-mono text-slate-900">{f.refLabel || '—'} <span className="text-slate-400">{f.code}</span></td>
                          <td className="p-2 text-slate-600">{f.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {costReport.integrity.length > 30 && <p className="text-[11px] text-slate-400 p-2">+{costReport.integrity.length - 30} ملاحظات أخرى</p>}
                </div>
              )}
            </div>

            {/* Trend / drift / burn */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                <h4 className="font-black text-slate-800 mb-1.5">الاتجاه (لقطات التكلفة)</h4>
                {costReport.trend.length <= 1 ? (
                  <p className="text-slate-400">لقطة واحدة — احفظ لقطات دورية لبناء الاتجاه.</p>
                ) : (
                  <ul className="space-y-1 text-slate-600 font-mono">
                    {costReport.trend.map((t) => (
                      <li key={t.dataDate + String(t.current)}>{t.dataDate}{t.current ? ' (الحالية)' : ''}: AC {t.ac ?? 'N/A'} · EV {t.ev ?? 'N/A'} · CPI {t.cpi ?? 'N/A'} · EAC {t.eac ?? 'N/A'}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                <h4 className="font-black text-slate-800 mb-1.5">الانحراف عن التحديث السابق</h4>
                {!costReport.drift.hasPrevious ? (
                  <p className="text-slate-400">N/A — لا يوجد تحديث سابق.</p>
                ) : (
                  <ul className="space-y-1 text-slate-600 font-mono">
                    <li>انحراف EAC: {costReport.drift.eacDrift !== null ? (costReport.drift.eacDrift > 0 ? '+' : '') + costReport.drift.eacDrift.toLocaleString() : 'N/A'}</li>
                    <li>انحراف ETC: {costReport.drift.etcDrift !== null ? (costReport.drift.etcDrift > 0 ? '+' : '') + costReport.drift.etcDrift.toLocaleString() : 'N/A'}</li>
                    <li>تغير CPI: {costReport.drift.cpiChange !== null ? costReport.drift.cpiChange : 'N/A'}</li>
                    <li>الاتجاه: {costReport.drift.direction}</li>
                  </ul>
                )}
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                <h4 className="font-black text-slate-800 mb-1.5">معدل الحرق</h4>
                {!costReport.burn.sufficient ? (
                  <p className="text-slate-400">N/A — {costReport.burn.reason}</p>
                ) : (
                  <ul className="space-y-1 text-slate-600 font-mono">
                    <li>حرق فعلي/يوم: {costReport.burn.acBurnPerDay}</li>
                    <li>إنتاج مكتسب/يوم: {costReport.burn.evRatePerDay}</li>
                    <li>كفاءة الاتجاه: {costReport.burn.efficiencyTrend}</li>
                  </ul>
                )}
              </div>
            </div>

            {/* Anomalies */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">شذوذات التكلفة (بعتبات معلنة)</h4>
              {costReport.anomalies.length === 0 ? (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">لا شذوذات.</p>
              ) : (
                <ul className="space-y-2">
                  {costReport.anomalies.map((a) => (
                    <li key={a.code} className="p-3 bg-amber-50/60 rounded-xl border border-amber-200 text-xs">
                      <span className="font-black text-slate-900 font-mono">{a.code}</span>
                      <span className="text-slate-600"> — {a.message}</span>
                      <p className="text-slate-500 mt-0.5 font-mono text-[11px]">العتبة: {a.threshold} · الدليل: {a.evidence.join(' · ')}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Actions */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">أهم ٥ إجراءات تكلفة</h4>
              {costReport.actions.length === 0 ? (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">لا إجراءات مطلوبة.</p>
              ) : (
                <ol className="space-y-2">
                  {costReport.actions.map((a) => (
                    <li key={a.rank} className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="w-5 h-5 rounded-full bg-slate-900 text-amber-400 text-[10px] font-black flex items-center justify-center">{a.rank}</span>
                        <span className="font-black text-slate-900">{a.issue}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${a.confidence === 'High' ? 'bg-emerald-100 text-emerald-800' : a.confidence === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>
                          {a.confidence}
                        </span>
                      </div>
                      <p className="text-slate-600 mt-1"><span className="font-bold">الدليل:</span> {a.evidence.join(' · ')}</p>
                      <p className="text-slate-600"><span className="font-bold">الأثر المالي:</span> <span className="font-mono">{a.financialImpact.toLocaleString()} SAR</span></p>
                      {a.scheduleLinkage && <p className="text-slate-600"><span className="font-bold">الارتباط الزمني:</span> {a.scheduleLinkage}</p>}
                      <p className="text-slate-800"><span className="font-bold">الإجراء:</span> {a.action}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* Consistency */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">اتساق الزمن والتكلفة</h4>
              {costReport.consistencyNote ? (
                <p className="text-xs text-slate-400">{costReport.consistencyNote}</p>
              ) : costReport.consistency.length === 0 ? (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">متسق — لا تعارض بين التقدم الزمني والأرقام المالية.</p>
              ) : (
                <ul className="space-y-2">
                  {costReport.consistency.map((f, i) => (
                    <li key={i} className="p-3 bg-blue-50/60 rounded-xl border border-blue-200 text-xs">
                      <span className="font-black text-slate-900 font-mono">{f.code}</span>
                      <span className="text-slate-600"> — {f.message}</span>
                      <p className="text-slate-500 mt-0.5 font-mono text-[11px]">الدليل: {f.evidence.join(' · ')}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Confidence */}
            <div>
              <h4 className="text-xs font-black text-slate-800 mb-2">الثقة بكل مؤشر</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2">
                {(Object.entries(costReport.confidence) as Array<[string, { level: string; notes: string[] }]>).map(([kpi, c]) => (
                  <div key={kpi} className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-slate-700">{kpi}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${c.level === 'High' ? 'bg-emerald-100 text-emerald-800' : c.level === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>
                        {c.level}
                      </span>
                    </div>
                    <ul className="text-[11px] text-slate-500 mt-1 space-y-0.5">
                      {c.notes.map((n, i) => (<li key={i}>• {n}</li>))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'transactions_table' && (
        <div className="space-y-6">
          {/* Add Cost Transaction Form */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-black text-slate-900 text-sm flex items-center gap-2">
                <Plus size={16} className="text-amber-600" />
                <span>تسجيل حركة تكلفة ومصروفات / فاتورة جديدة (New Cost Transaction)</span>
              </h3>
              <span className="text-[11px] text-slate-400 font-medium">
                ربط مباشر ببنود المقايسة (BOQ) وشبكة المسار الحرج (CPM)
              </span>
            </div>

            {/* Structured 2-Row Grid Layout */}
            <div className="space-y-3">
              {/* Row 1: Description + Cost Type + BOQ Link */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-6">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">بيان ووصف المصروف أو الفاتورة:</label>
                  <input
                    value={transactionForm.description}
                    onChange={(e) => setTransactionForm({ ...transactionForm, description: e.target.value })}
                    placeholder="مثال: توريد دفعة حديد تسليح إضافية، إيجار مضخة خرسانة، رواتب..."
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-500 bg-white"
                  />
                </div>

                <div className="md:col-span-3">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">تصنيف التكلفة:</label>
                  <select
                    value={transactionForm.cost_type}
                    onChange={(e) => setTransactionForm({ ...transactionForm, cost_type: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs bg-white font-bold text-slate-800"
                  >
                    <option value="direct">تكلفة مباشرة (Direct)</option>
                    <option value="labor">رواتب وعمالة (Labor)</option>
                    <option value="materials">مواد وتوريدات (Materials)</option>
                    <option value="equipment">إيجار معدات وآليات (Equipment)</option>
                    <option value="subcontractor">مقاولو باطن (Subcontractor)</option>
                    <option value="overhead">مصروفات غير مباشرة (Overhead)</option>
                  </select>
                </div>

                <div className="md:col-span-3">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">تحميل على بند المقايسة (BOQ):</label>
                  <select
                    value={transactionForm.boq_item_id}
                    onChange={(e) => setTransactionForm({ ...transactionForm, boq_item_id: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs bg-white text-slate-700"
                  >
                    <option value="">اختياري - حدد بند المقايسة</option>
                    {boqItems.map((item) => (
                      <option key={item.id} value={item.id}>{item.code} - {item.description.slice(0, 32)}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Row 2: CPM Activity Link + Amount + Action Button */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                <div className="md:col-span-4">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">تحميل على نشاط CPM في الجدول الزمني:</label>
                  <select
                    value={transactionForm.activity_id}
                    onChange={(e) => setTransactionForm({ ...transactionForm, activity_id: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs bg-white text-slate-700"
                  >
                    <option value="">اختياري - حدد نشاط CPM</option>
                    {activities.map((item) => (
                      <option key={item.id} value={item.id}>{item.code} - {item.name.slice(0, 35)}</option>
                    ))}
                  </select>
                </div>

                <div className="md:col-span-3">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">تاريخ الحركة (≤ تاريخ التحديث):</label>
                  <input
                    type="date"
                    value={txnDate}
                    max={governedDataDate}
                    onChange={(e) => setTxnDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs font-mono font-bold bg-white outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">المبلغ (SAR):</label>
                  <input
                    type="number"
                    min="0"
                    value={transactionForm.amount || ''}
                    onChange={(e) => setTransactionForm({ ...transactionForm, amount: parseFloat(e.target.value) || 0 })}
                    placeholder="0.00 SAR"
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs font-mono font-black text-amber-900 bg-white"
                  />
                </div>

                <div className="md:col-span-3">
                  <button
                    onClick={addTransaction}
                    className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Plus size={15} />
                    <span>تسجيل وإدراج المصروف</span>
                  </button>
                </div>
              </div>

              {/* Row 3: Explicit Budget Line allocation (PA-14). Optional: when several lines
                  share the same BOQ/WBS reference, picking one here allocates the transaction
                  to that line only; otherwise allocation is automatic only for a unique match,
                  and ambiguous transactions stay Unallocated. */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-12">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">تخصيص صريح لبند ميزانية CBS (اختياري — يلزم عند تشابه البنود):</label>
                  <select
                    value={transactionForm.budget_line_id}
                    onChange={(e) => setTransactionForm({ ...transactionForm, budget_line_id: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs bg-white text-slate-700"
                  >
                    <option value="">تلقائي - حسب المرجعية (BOQ / WBS / نشاط CPM)</option>
                    {budgetLines.map((line) => (
                      <option key={line.id} value={line.id}>{(line.description || line.id).slice(0, 45)} - {(line.approved_budget ?? line.planned_cost ?? 0).toLocaleString()} SAR</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Transactions Log */}
          {transactions.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-bold text-slate-900 text-xs">سجل الحركات المالية المعتمدة وقيد المراجعة</h3>
                <span className="text-xs text-slate-400">{transactions.length} حركات مسجلة</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                    <tr>
                      <th className="p-3 text-right">التاريخ</th>
                      <th className="p-3 text-right">البيان</th>
                      <th className="p-3 text-right">النوع</th>
                      <th className="p-3 text-right">المبلغ (SAR)</th>
                      <th className="p-3 text-center">الحالة</th>
                      <th className="p-3 text-center">الإجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium">
                    {transactions.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-50">
                        <td className="p-3 font-mono text-slate-600">{t.transaction_date}</td>
                        <td className="p-3 font-bold text-slate-900">{t.description}</td>
                        <td className="p-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                            {t.cost_type}
                          </span>
                        </td>
                        <td className="p-3 font-mono font-bold text-slate-900">{t.amount.toLocaleString()} SAR</td>
                        <td className="p-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            t.status === 'approved' ? 'bg-emerald-100 text-emerald-800' : t.status === 'rejected' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
                          }`}>
                            {t.status === 'approved' ? 'معتمد' : t.status === 'rejected' ? 'مرفوض' : 'بانتظار الاعتماد'}
                          </span>
                          {/* F9.4 (defect 2): `review_cost_transaction` is a two-level gate, so an
                              approval that advances the level without changing the status used to be
                              indistinguishable from nothing happening. The level is part of the
                              persisted row — showing it makes every committed press visible. */}
                          {t.status === 'submitted' && (
                            <span className="block text-[9px] text-slate-500 font-mono mt-0.5">
                              مستوى الاعتماد {(reviewStateOf(t)?.approvalLevel ?? 0)}/2
                            </span>
                          )}
                          {t.status === 'approved' && t.approved_at && (
                            <span className="block text-[9px] text-slate-500 font-mono mt-0.5">
                              {String(t.approved_at).slice(0, 10)}
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-center">
                          {t.status === 'submitted' && (
                            <div className="flex items-center justify-center gap-2">
                              <button onClick={() => approveTransaction(t.id)} className="text-emerald-700 font-bold text-[11px] cursor-pointer">اعتماد</button>
                              <button onClick={() => rejectTransaction(t.id)} className="text-rose-700 font-bold text-[11px] cursor-pointer">رفض</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Budget Lines Table */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 font-bold text-xs text-slate-800">
              جدول بنود الميزانية التفصيلي (Budget Lines Schedule)
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">البند</th>
                    <th className="p-3 text-right">المخطط</th>
                    <th className="p-3 text-right">ملتزم</th>
                    <th className="p-3 text-right">فعلي</th>
                    <th className="p-3 text-right">متبقي</th>
                    <th className="p-3 text-right">الانحراف</th>
                    <th className="p-3 text-center">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {budgetLines.map((line) => {
                    const variance = line.planned_cost - line.actual_cost;
                    return (
                      <tr key={line.id} className="hover:bg-slate-50">
                        <td className="p-3 text-slate-800 max-w-xs truncate">{line.description}</td>
                        <td className="p-3 font-mono">{line.planned_cost.toLocaleString()}</td>
                        <td className="p-3 font-mono text-blue-700">{line.committed_cost.toLocaleString()}</td>
                        <td className="p-3 font-mono text-amber-800 font-bold">
                          {editingId === line.id ? (
                            <input
                              type="number"
                              value={editActual}
                              onChange={(e) => setEditActual(parseFloat(e.target.value) || 0)}
                              className="w-24 px-2 py-1 border border-slate-300 rounded text-xs focus:ring-2 focus:ring-amber-500 outline-none font-mono"
                              autoFocus
                            />
                          ) : (
                            line.actual_cost.toLocaleString()
                          )}
                        </td>
                        <td className="p-3 font-mono text-emerald-700">{line.remaining_cost.toLocaleString()}</td>
                        <td className={`p-3 font-mono font-bold ${variance >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {variance.toLocaleString()}
                        </td>
                        <td className="p-3 text-center">
                          {editingId === line.id ? (
                            <button onClick={() => saveActual(line.id)} className="text-emerald-600 hover:text-emerald-700 text-xs font-bold flex items-center gap-1 mx-auto cursor-pointer">
                              <Save size={13} /> حفظ
                            </button>
                          ) : (
                            <button onClick={() => { setEditingId(line.id); setEditActual(line.actual_cost); }} className="text-amber-600 hover:text-amber-800 text-xs font-bold cursor-pointer">
                              تحديث
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Add Reserve Draw Request */}
      {showReserveModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              طلب سحب واعتماد مالي من احتياطي المشروع
            </h3>

            <div className="space-y-3">
              <div>
                <label className="block text-slate-600 font-bold mb-1">نوع الاحتياطي المطلوب السحب منه</label>
                <select
                  value={reserveDrawForm.reserveType}
                  onChange={(e) => setReserveDrawForm({ ...reserveDrawForm, reserveType: e.target.value as any })}
                  className="w-full p-2 border rounded-lg bg-white font-bold"
                >
                  <option value="contingency">احتياطي طوارئ المخاطر (Contingency Reserve)</option>
                  <option value="management">احتياطي الإدارة للتغييرات الكبرى (Management Reserve)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">المبلغ المطلوب سحبه (SAR)</label>
                <input
                  type="number"
                  value={reserveDrawForm.amountSar}
                  onChange={(e) => setReserveDrawForm({ ...reserveDrawForm, amountSar: Number(e.target.value) })}
                  className="w-full p-2 border rounded-lg font-mono font-bold text-amber-900"
                />
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">الخطر المرتبط أو بند الاستنزاف</label>
                <input
                  type="text"
                  value={reserveDrawForm.associatedRiskTitle}
                  onChange={(e) => setReserveDrawForm({ ...reserveDrawForm, associatedRiskTitle: e.target.value })}
                  className="w-full p-2 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">المبررات الهندسية وموافقة مدير المشروع</label>
                <textarea
                  rows={2}
                  value={reserveDrawForm.authorizationNotes}
                  onChange={(e) => setReserveDrawForm({ ...reserveDrawForm, authorizationNotes: e.target.value })}
                  className="w-full p-2 border rounded-lg resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowReserveModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleAddReserveDraw}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                اعتماد السحب وتحديث المتبقي
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

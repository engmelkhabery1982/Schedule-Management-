import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type {
  Project,
  BudgetLine,
  CostTransaction,
  BoqItem,
  Activity,
  CbsCostCenter,
  MonthlyCashFlowBucket,
  ReserveBurnItem,
  MultiEacComparison,
} from '@/types';
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

type BudgetTab = 'evm_tcpi' | 'cash_flow' | 'cbs_centers' | 'reserves' | 'transactions_table';

export default function BudgetView({ project }: BudgetViewProps) {
  const [activeTab, setActiveTab] = useState<BudgetTab>('evm_tcpi');
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editActual, setEditActual] = useState(0);
  const [transactions, setTransactions] = useState<CostTransaction[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [lang, setLang] = useState<Language>(getLanguage());

  // Cost Transaction Input Form
  const [transactionForm, setTransactionForm] = useState({
    description: '',
    amount: 0,
    cost_type: 'direct',
    boq_item_id: '',
    activity_id: '',
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
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [{ data }, { data: transactionData }, { data: boqData }, { data: activityData }] = await Promise.all([
      supabase.from('budget_lines').select('*').eq('project_id', project.id),
      supabase.from('cost_transactions').select('*').eq('project_id', project.id).order('transaction_date', { ascending: false }),
      supabase.from('boq_items').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
    ]);
    setBudgetLines(data || []);
    setTransactions((transactionData || []) as CostTransaction[]);
    setBoqItems((boqData || []) as BoqItem[]);
    setActivities((activityData || []) as Activity[]);
    setLoading(false);
  }

  async function addTransaction() {
    if (!project || !transactionForm.description || transactionForm.amount <= 0) return;
    const { error } = await supabase.from('cost_transactions').insert({
      project_id: project.id,
      description: transactionForm.description,
      amount: transactionForm.amount,
      cost_type: transactionForm.cost_type,
      transaction_date: new Date().toISOString().split('T')[0],
      source: 'manual',
      status: 'submitted',
      boq_item_id: transactionForm.boq_item_id || null,
      activity_id: transactionForm.activity_id || null,
      vendor: transactionForm.vendor || null,
      invoice_number: transactionForm.invoice_number || null,
    });
    if (error) return;
    setTransactionForm({ description: '', amount: 0, cost_type: 'direct', boq_item_id: '', activity_id: '', vendor: '', invoice_number: '' });
    await loadData();
  }

  async function approveTransaction(id: string) {
    const transaction = transactions.find((item) => item.id === id);
    const { error } = await supabase.rpc('review_cost_transaction', {
      transaction_uuid: id,
      approver: (transaction?.approval_level || 0) === 0 ? 'project_control' : 'finance_manager',
      decision: 'approve',
    });
    if (!error) await loadData();
  }

  async function rejectTransaction(id: string) {
    const { error } = await supabase.rpc('review_cost_transaction', {
      transaction_uuid: id,
      approver: 'reviewer',
      decision: 'reject',
      review_notes: 'مرفوض للمراجعة والتصحيح',
    });
    if (!error) await loadData();
  }

  async function saveActual(id: string) {
    const line = budgetLines.find((l) => l.id === id);
    if (!line) return;
    const remaining = line.planned_cost - editActual;
    const { error } = await supabase.from('budget_lines').update({
      actual_cost: editActual,
      remaining_cost: remaining,
    }).eq('id', id);
    if (error) return;
    setEditingId(null);
    await loadData();
  }

  // Basic totals
  const totals = useMemo(() => {
    const planned = budgetLines.reduce((s, l) => s + (l.planned_cost || 0), 0) || project?.contract_value || 4850000;
    const committed = budgetLines.reduce((s, l) => s + (l.committed_cost || 0), 0) || Math.round(planned * 0.75);
    const lineActual = budgetLines.reduce((s, l) => s + (l.actual_cost || 0), 0);
    const transactionActual = transactions
      .filter((transaction) => transaction.status === 'approved')
      .reduce((s, t) => s + (t.amount || 0), 0);
    const actual = transactionActual > 0 ? transactionActual : (lineActual > 0 ? lineActual : 2180000);
    const remaining = planned - actual;
    const variance = planned - actual;
    return { planned, committed, actual, remaining, variance };
  }, [budgetLines, transactions, project]);

  // -------------------------------------------------------------
  // 1. CBS 5-Cost Center Breakdown Structure
  // -------------------------------------------------------------
  const cbsCenters: CbsCostCenter[] = useMemo(() => {
    const bac = totals.planned;
    return [
      {
        id: 'CBS-01',
        category: 'labor',
        nameAr: 'العمالة الذاتية المباشرة (Direct Labor & Payroll)',
        nameEn: 'Direct Labor & Site Supervision',
        budgetAllocatedSar: Math.round(bac * 0.22), // 22%
        committedCostSar: Math.round(bac * 0.22 * 0.85),
        actualCostSar: Math.round(totals.actual * 0.24),
        varianceSar: Math.round(bac * 0.22) - Math.round(totals.actual * 0.24),
        variancePercent: Number((((Math.round(bac * 0.22) - Math.round(totals.actual * 0.24)) / Math.round(bac * 0.22)) * 100).toFixed(1)),
        description: 'رواتب المهندسين والمشرفين والعمالة الحرفية المباشرة والتأمينات.',
      },
      {
        id: 'CBS-02',
        category: 'materials',
        nameAr: 'المواد والتوريدات الدائمة (Permanent Materials)',
        nameEn: 'Permanent Construction Materials',
        budgetAllocatedSar: Math.round(bac * 0.38), // 38%
        committedCostSar: Math.round(bac * 0.38 * 0.90),
        actualCostSar: Math.round(totals.actual * 0.40),
        varianceSar: Math.round(bac * 0.38) - Math.round(totals.actual * 0.40),
        variancePercent: Number((((Math.round(bac * 0.38) - Math.round(totals.actual * 0.40)) / Math.round(bac * 0.38)) * 100).toFixed(1)),
        description: 'حديد التسليح، الخرسانة الجاهزة، البلك، المواد الكيميائية والعوازل.',
      },
      {
        id: 'CBS-03',
        category: 'equipment',
        nameAr: 'المعدات والآليات (Equipment & Heavy Plant)',
        nameEn: 'Equipment Rental & Plant Operations',
        budgetAllocatedSar: Math.round(bac * 0.12), // 12%
        committedCostSar: Math.round(bac * 0.12 * 0.70),
        actualCostSar: Math.round(totals.actual * 0.11),
        varianceSar: Math.round(bac * 0.12) - Math.round(totals.actual * 0.11),
        variancePercent: Number((((Math.round(bac * 0.12) - Math.round(totals.actual * 0.11)) / Math.round(bac * 0.12)) * 100).toFixed(1)),
        description: 'الرافعات البرجية، الحفارات، مضخات الخرسانة، والمولدات والديزل.',
      },
      {
        id: 'CBS-04',
        category: 'subcontractors',
        nameAr: 'عقود مقاولي الباطن (Subcontractors Packages)',
        nameEn: 'Specialized Subcontractors',
        budgetAllocatedSar: Math.round(bac * 0.20), // 20%
        committedCostSar: Math.round(bac * 0.20 * 0.88),
        actualCostSar: Math.round(totals.actual * 0.18),
        varianceSar: Math.round(bac * 0.20) - Math.round(totals.actual * 0.18),
        variancePercent: Number((((Math.round(bac * 0.20) - Math.round(totals.actual * 0.18)) / Math.round(bac * 0.20)) * 100).toFixed(1)),
        description: 'مقاول مصنعيات الخرسانة، مقاول أعمال الدكت والتكييف، ومقاول الواجهات.',
      },
      {
        id: 'CBS-05',
        category: 'overheads',
        nameAr: 'المصاريف غير المباشرة للموقع (Site Overheads & Indirects)',
        nameEn: 'Site Overheads & Administration',
        budgetAllocatedSar: Math.round(bac * 0.08), // 8%
        committedCostSar: Math.round(bac * 0.08 * 0.65),
        actualCostSar: Math.round(totals.actual * 0.07),
        varianceSar: Math.round(bac * 0.08) - Math.round(totals.actual * 0.07),
        variancePercent: Number((((Math.round(bac * 0.08) - Math.round(totals.actual * 0.07)) / Math.round(bac * 0.08)) * 100).toFixed(1)),
        description: 'مكاتب الموقع، تصاريح البلدية، الأمن والسلامة، والضيافة والمختبرات.',
      },
    ];
  }, [totals]);

  // -------------------------------------------------------------
  // 2. Monthly Cash Flow S-Curve & Peak Working Capital
  // -------------------------------------------------------------
  const cashFlowTimeline: MonthlyCashFlowBucket[] = useMemo(() => {
    const months = [
      { month: '2026-09', label: 'سبتمبر 2026', pv: 350000, inGross: 0, inNet: 0, out: 280000 },
      { month: '2026-10', label: 'أكتوبر 2026', pv: 520000, inGross: 480000, inNet: 469200, out: 490000 },
      { month: '2026-11', label: 'نوفمبر 2026', pv: 680000, inGross: 640000, inNet: 625600, out: 580000 },
      { month: '2026-12', label: 'ديسمبر 2026', pv: 720000, inGross: 660000, inNet: 645150, out: 610000 },
      { month: '2027-01', label: 'يناير 2027', pv: 650000, inGross: 640000, inNet: 625600, out: 540000 },
      { month: '2027-02', label: 'فبراير 2027', pv: 580000, inGross: 600000, inNet: 586500, out: 480000 },
      { month: '2027-03', label: 'مارس 2027', pv: 450000, inGross: 550000, inNet: 537625, out: 390000 },
    ];

    let runningCumulative = 0;
    return months.map((m) => {
      const netMonthly = m.inNet - m.out;
      runningCumulative += netMonthly;
      const isDeficit = runningCumulative < 0;
      return {
        periodMonth: m.month,
        monthLabel: m.label,
        plannedValueSar: m.pv,
        cashInGrossSar: m.inGross,
        cashInNetReceivedSar: m.inNet,
        cashOutCommittedSar: m.out,
        netMonthlyCashFlowSar: netMonthly,
        cumulativeCashFlowSar: runningCumulative,
        isDeficit,
        fundingGapSar: isDeficit ? Math.abs(runningCumulative) : 0,
      };
    });
  }, []);

  // Peak Working Capital Required
  const peakWorkingCapitalSar = useMemo(() => {
    let minCumul = 0;
    cashFlowTimeline.forEach((b) => {
      if (b.cumulativeCashFlowSar < minCumul) minCumul = b.cumulativeCashFlowSar;
    });
    return Math.abs(minCumul);
  }, [cashFlowTimeline]);

  // -------------------------------------------------------------
  // 3. Contingency & Management Reserves
  // -------------------------------------------------------------
  const [reserves, setReserves] = useState<ReserveBurnItem[]>([
    {
      id: 'RES-01',
      reserveType: 'contingency',
      nameAr: 'احتياطي طوارئ مخاطر التوريد والأسعار (Material Inflation)',
      allocatedAmountSar: 240000, // 5% of BAC
      spentToDateSar: 75000,
      remainingAmountSar: 165000,
      utilizationPercent: 31.25,
      associatedRiskTitle: 'تقلب أسعار حديد التسليح واستيراد المحابس التخصصية',
      authorizationNotes: 'معتمد من مدير المشروع لتغطية فرق سعر شحنة الحديد العاجلة.',
      status: 'healthy',
    },
    {
      id: 'RES-02',
      reserveType: 'contingency',
      nameAr: 'احتياطي طوارئ المياه الجوفية وطبقات الحفر (Geotechnical Risk)',
      allocatedAmountSar: 150000,
      spentToDateSar: 110000,
      remainingAmountSar: 40000,
      utilizationPercent: 73.3,
      associatedRiskTitle: 'ظهور مياه جوفية غير متوقعة وتدعيم جوانب الحفر الإضافي',
      authorizationNotes: 'معتمد لتشغيل نظام النزح المائي المستمر (Dewatering System).',
      status: 'caution',
    },
    {
      id: 'RES-03',
      reserveType: 'management',
      nameAr: 'احتياطي الإدارة للتغييرات الكبرى (Management Reserve - MR)',
      allocatedAmountSar: 250000,
      spentToDateSar: 45000,
      remainingAmountSar: 205000,
      utilizationPercent: 18.0,
      associatedRiskTitle: 'تعديلات بلدية أو متطلبات أمان مستجدة (Unknown-Unknowns)',
      authorizationNotes: 'سحب جزئي لتنفيذ تعديل مسار محطة المحولات الكهربائية.',
      status: 'healthy',
    },
  ]);

  const totalReservesAllocated = reserves.reduce((s, r) => s + r.allocatedAmountSar, 0);
  const totalReservesSpent = reserves.reduce((s, r) => s + r.spentToDateSar, 0);
  const totalReservesRemaining = reserves.reduce((s, r) => s + r.remainingAmountSar, 0);
  const totalReservesUtilization = totalReservesAllocated > 0 ? (totalReservesSpent / totalReservesAllocated) * 100 : 0;

  // -------------------------------------------------------------
  // 4. Multi-Formula EAC Forecast & TCPI Matrix
  // -------------------------------------------------------------
  const multiEacData: MultiEacComparison = useMemo(() => {
    const bac = totals.planned;
    const ac = totals.actual;
    const progressRatio = 0.48; // 48% progress
    const ev = Math.round(bac * progressRatio);
    const spi = 0.94;
    const cpi = Number((ev / Math.max(1, ac)).toFixed(2)) || 1.05;

    // EAC Formulas
    // 1. Optimistic: EAC = AC + (BAC - EV)
    const eac1Optimistic = Math.round(ac + (bac - ev));
    const vac1 = Math.round(bac - eac1Optimistic);

    // 2. Realistic: EAC = BAC / CPI
    const eac2Realistic = Math.round(bac / cpi);
    const vac2 = Math.round(bac - eac2Realistic);

    // 3. Pessimistic / Composite: EAC = AC + (BAC - EV) / (CPI * SPI)
    const eac3Pessimistic = Math.round(ac + (bac - ev) / (cpi * spi));
    const vac3 = Math.round(bac - eac3Pessimistic);

    // 4. Bottom-Up: EAC = AC + Bottom-up ETC
    const bottomUpEtc = Math.round((bac - ev) * 1.02);
    const eac4BottomUp = Math.round(ac + bottomUpEtc);
    const vac4 = Math.round(bac - eac4BottomUp);

    // TCPI Formulas
    // TCPI(BAC) = (BAC - EV) / (BAC - AC)
    const tcpiBac = (bac - ac) > 0 ? Number(((bac - ev) / (bac - ac)).toFixed(2)) : 1.20;
    // TCPI(EAC) = (BAC - EV) / (EAC_realistic - AC)
    const tcpiEac = (eac2Realistic - ac) > 0 ? Number(((bac - ev) / (eac2Realistic - ac)).toFixed(2)) : 1.00;

    let tcpiFeasibility: 'easy' | 'realistic' | 'hard' | 'unachievable' = 'realistic';
    if (tcpiBac <= 1.0) tcpiFeasibility = 'easy';
    else if (tcpiBac <= 1.10) tcpiFeasibility = 'realistic';
    else if (tcpiBac <= 1.25) tcpiFeasibility = 'hard';
    else tcpiFeasibility = 'unachievable';

    return {
      bac,
      ev,
      ac,
      cpi,
      spi,
      tcpiBac,
      tcpiEac,
      tcpiFeasibility,
      eac1Optimistic,
      vac1,
      eac2Realistic,
      vac2,
      eac3Pessimistic,
      vac3,
      eac4BottomUp,
      vac4,
    };
  }, [totals]);

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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200 shadow-xs">
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
      </div>

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
          <p className="text-xl font-black text-blue-700 font-mono">{totals.committed.toLocaleString()} <span className="text-xs font-normal">SAR</span></p>
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
                <span className={`px-3 py-1 rounded-full text-xs font-black ${
                  multiEacData.tcpiFeasibility === 'easy'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : multiEacData.tcpiFeasibility === 'realistic'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                }`}>
                  {multiEacData.tcpiFeasibility === 'easy' ? '✓ مرن ومريح (TCPI ≤ 1.0)' : multiEacData.tcpiFeasibility === 'realistic' ? '✓ واقعي وممكن تحقيقه (1.0 < TCPI ≤ 1.1)' : '⚠️ يتطلب ترشيد تكاليف مشدد (TCPI > 1.1)'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-xs text-slate-400 block">مؤشر TCPI بالنسبة لميزانية العقد الأصلية (BAC):</span>
                <div className="text-2xl font-black text-amber-400 font-mono">
                  {multiEacData.tcpiBac}
                </div>
                <p className="text-[11px] text-slate-300">
                  يجب تنفيذ كل 1 ريال متبقي بتكلفة فعلية لا تتجاوز 0.95 ريال للبقاء ضمن ميزانية BAC الأصلية.
                </p>
              </div>

              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-xs text-slate-400 block">مؤشر TCPI بالنسبة للتقدير الواقعي (EAC):</span>
                <div className="text-2xl font-black text-emerald-400 font-mono">
                  {multiEacData.tcpiEac}
                </div>
                <p className="text-[11px] text-slate-300">
                  الكفاءة المطلوبة لتحقيق التقدير النهائي المعدل وفق أداء المشروع الحالي.
                </p>
              </div>

              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-xs text-slate-400 block">كفاءة التكلفة الحالية (Current CPI):</span>
                <div className={`text-2xl font-black font-mono ${multiEacData.cpi >= 1.0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {multiEacData.cpi}
                </div>
                <p className="text-[11px] text-slate-300">
                  مؤشر الأداء التراكمي المحقق حتى تاريخ اليومية الميدانية.
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
                <p className="text-[10px] text-slate-500 font-mono font-semibold">EAC = AC + (BAC - EV)</p>
                <div className="text-lg font-black text-blue-950 font-mono">
                  {multiEacData.eac1Optimistic.toLocaleString()} SAR
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.vac1 >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.vac1 > 0 ? `+${multiEacData.vac1.toLocaleString()}` : multiEacData.vac1.toLocaleString()} SAR
                </div>
                <p className="text-[10px] text-slate-600">بافتراض تنفيذ المتبقي بالمعدل المخطط الأصلي تماماً.</p>
              </div>

              {/* Formula 2: Realistic */}
              <div className="p-4 bg-emerald-50/70 rounded-xl border border-emerald-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-900">2. السيناريو الواقعي (EAC₂)</span>
                  <span className="text-[10px] font-mono bg-emerald-200 text-emerald-950 px-1.5 py-0.5 rounded font-bold">Current CPI</span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono font-semibold">EAC = BAC / CPI</p>
                <div className="text-lg font-black text-emerald-950 font-mono">
                  {multiEacData.eac2Realistic.toLocaleString()} SAR
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.vac2 >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.vac2 > 0 ? `+${multiEacData.vac2.toLocaleString()}` : multiEacData.vac2.toLocaleString()} SAR
                </div>
                <p className="text-[10px] text-slate-600">بافتراض استمرار نفس كفاءة التكلفة التاريخية الحالية.</p>
              </div>

              {/* Formula 3: Pessimistic Composite */}
              <div className="p-4 bg-amber-50/70 rounded-xl border border-amber-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-900">3. السيناريو المركب (EAC₃)</span>
                  <span className="text-[10px] font-mono bg-amber-200 text-amber-950 px-1.5 py-0.5 rounded font-bold">CPI × SPI</span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono font-semibold">EAC = AC + (BAC - EV)/(CPI × SPI)</p>
                <div className="text-lg font-black text-amber-950 font-mono">
                  {multiEacData.eac3Pessimistic.toLocaleString()} SAR
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.vac3 >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.vac3 > 0 ? `+${multiEacData.vac3.toLocaleString()}` : multiEacData.vac3.toLocaleString()} SAR
                </div>
                <p className="text-[10px] text-slate-600">يراعي أثر تأخير الجدول الزمني على زيادة التكلفة.</p>
              </div>

              {/* Formula 4: Bottom-Up */}
              <div className="p-4 bg-purple-50/70 rounded-xl border border-purple-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-purple-900">4. التقدير التصاعدي (EAC₄)</span>
                  <span className="text-[10px] font-mono bg-purple-200 text-purple-950 px-1.5 py-0.5 rounded font-bold">Bottom-up ETC</span>
                </div>
                <p className="text-[10px] text-slate-500 font-mono font-semibold">EAC = AC + Bottom-Up ETC</p>
                <div className="text-lg font-black text-purple-950 font-mono">
                  {multiEacData.eac4BottomUp.toLocaleString()} SAR
                </div>
                <div className={`text-[11px] font-bold font-mono ${multiEacData.vac4 >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  VAC = {multiEacData.vac4 > 0 ? `+${multiEacData.vac4.toLocaleString()}` : multiEacData.vac4.toLocaleString()} SAR
                </div>
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
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">الوقت الفعلي المنقضي (AT):</span>
                <span className="font-mono font-black text-slate-900 text-base">2.0 شهر (60 يوم)</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">الجدول المكتسب (ES):</span>
                <span className="font-mono font-black text-blue-900 text-base">1.88 شهر (56.4 يوم)</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">مؤشر الأداء الزمني (SPI_t):</span>
                <span className="font-mono font-black text-amber-700 text-base">0.94 (SV_t = -3.6d)</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block text-[11px]">التسليم المتوقع زمنياً (IEAC_t):</span>
                <span className="font-mono font-black text-purple-900 text-base">2027-05-12 (+12d)</span>
              </div>
            </div>
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
                {peakWorkingCapitalSar.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-slate-500">أقصى عجز سيولة مرحلي يحتاج تسهيل بنكي</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي التدفقات النقدية الداخلة (Total Cash-In)</span>
              <div className="text-xl font-black text-emerald-700 font-mono">
                {cashFlowTimeline.reduce((s, b) => s + b.cashInNetReceivedSar, 0).toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-emerald-600 font-semibold">المحصل الفعلي بعد الاستقطاعات</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي التدفقات الخارجة (Total Cash-Out)</span>
              <div className="text-xl font-black text-slate-900 font-mono">
                {cashFlowTimeline.reduce((s, b) => s + b.cashOutCommittedSar, 0).toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-slate-500">مصاريف الموقع والمواد والعمالة والباطن</span>
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
                  مقارنة السيولة المحصلة من مستخلصات المالك مقابل التزامات ومصروفات التشغيل بالموقع.
                </p>
              </div>
              <span className="text-xs font-mono font-bold bg-amber-50 text-amber-900 px-2.5 py-1 rounded border border-amber-200">
                Payment Lag: 30 Days
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
                  {cashFlowTimeline.map((b) => (
                    <tr key={b.periodMonth} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-bold text-slate-900">{b.monthLabel}</td>
                      <td className="p-3 font-mono text-slate-600">{b.plannedValueSar.toLocaleString()} SAR</td>
                      <td className="p-3 font-mono font-bold text-emerald-800 bg-emerald-50/40">
                        {b.cashInNetReceivedSar > 0 ? `+${b.cashInNetReceivedSar.toLocaleString()}` : '0'} SAR
                      </td>
                      <td className="p-3 font-mono font-bold text-rose-800 bg-rose-50/40">
                        -{b.cashOutCommittedSar.toLocaleString()} SAR
                      </td>
                      <td className={`p-3 font-mono font-bold ${b.netMonthlyCashFlowSar >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {b.netMonthlyCashFlowSar >= 0 ? `+${b.netMonthlyCashFlowSar.toLocaleString()}` : b.netMonthlyCashFlowSar.toLocaleString()} SAR
                      </td>
                      <td className={`p-3 font-mono font-black ${b.cumulativeCashFlowSar >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {b.cumulativeCashFlowSar >= 0 ? `+${b.cumulativeCashFlowSar.toLocaleString()}` : b.cumulativeCashFlowSar.toLocaleString()} SAR
                      </td>
                      <td className="p-3 text-center">
                        {b.isDeficit ? (
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
      {/* TAB 3: COST BREAKDOWN STRUCTURE (CBS 5-ELEMENT CENTERS)                          */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'cbs_centers' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <PieChart className="text-amber-600" size={18} />
                  <span>تصنيف التكاليف حسب مراكز التكلفة الخمسة (Cost Breakdown Structure - CBS)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  توزيع ومراقبة التكاليف المعتمدة مقابل المصروفات الفعلية والانحراف لكل عنصر إنشائي.
                </p>
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
                    <th className="p-3 text-right">الانحراف المالي (Variance)</th>
                    <th className="p-3 text-center">نسبة الانحراف %</th>
                    <th className="p-3 text-right">بيان التغطية والبنود</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {cbsCenters.map((center) => (
                    <tr key={center.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-bold text-slate-900">{center.nameAr}</td>
                      <td className="p-3 font-mono text-slate-800">{center.budgetAllocatedSar.toLocaleString()} SAR</td>
                      <td className="p-3 font-mono text-blue-700">{center.committedCostSar.toLocaleString()} SAR</td>
                      <td className="p-3 font-mono text-amber-800 font-bold">{center.actualCostSar.toLocaleString()} SAR</td>
                      <td className={`p-3 font-mono font-black ${center.varianceSar >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {center.varianceSar >= 0 ? `+${center.varianceSar.toLocaleString()}` : center.varianceSar.toLocaleString()} SAR
                      </td>
                      <td className="p-3 text-center font-mono font-bold">
                        <span className={`px-2 py-0.5 rounded text-[10px] ${center.variancePercent >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                          {center.variancePercent}%
                        </span>
                      </td>
                      <td className="p-3 text-slate-600 text-[11px] max-w-xs truncate">{center.description}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-black text-slate-900 border-t">
                  <tr>
                    <td className="p-3">الإجمالي العام لمراكز التكلفة:</td>
                    <td className="p-3 font-mono">{cbsCenters.reduce((s, c) => s + c.budgetAllocatedSar, 0).toLocaleString()} SAR</td>
                    <td className="p-3 font-mono text-blue-700">{cbsCenters.reduce((s, c) => s + c.committedCostSar, 0).toLocaleString()} SAR</td>
                    <td className="p-3 font-mono text-amber-800">{cbsCenters.reduce((s, c) => s + c.actualCostSar, 0).toLocaleString()} SAR</td>
                    <td className="p-3 font-mono text-emerald-700">{cbsCenters.reduce((s, c) => s + c.varianceSar, 0).toLocaleString()} SAR</td>
                    <td colSpan={2}></td>
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
                {totalReservesAllocated.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-slate-500">طوارئ مخاطر + إدارة</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">المسحوب والمستهلك حتى تاريخه</span>
              <div className="text-xl font-black text-amber-800 font-mono">
                {totalReservesSpent.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-amber-700 font-semibold">معدل الاستهلاك: {totalReservesUtilization.toFixed(1)}%</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">الرصيد المتبقي المتاح</span>
              <div className="text-xl font-black text-emerald-700 font-mono">
                {totalReservesRemaining.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-emerald-600 font-semibold">جاهز لمواجهة أي مستجدات</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">سحب جديد</span>
                <button
                  onClick={() => setShowReserveModal(true)}
                  className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 rounded-lg text-xs font-bold transition-all shadow-sm cursor-pointer"
                >
                  + طلب سحب من الاحتياطي
                </button>
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
                  فصل احتياطي الطوارئ المرتبط بالمخاطر المرصودة عن احتياطي الإدارة للتغييرات الكبرى.
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
                <div className="md:col-span-5">
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

                <div className="md:col-span-4">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">المبلغ المطلوب تسجيله (SAR):</label>
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

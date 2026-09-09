import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type {
  Project,
  BankGuaranteeItem,
  MaterialsOnSiteItem,
  ProlongationAndLdCalc,
  PriceEscalationItem,
  ThreeWayMatchingInvoice,
} from '@/types';
import {
  Landmark,
  Shield,
  Box,
  Scale,
  TrendingUp,
  Receipt,
  AlertTriangle,
  CheckCircle2,
  Clock,
  DollarSign,
  Plus,
  RefreshCw,
  FileCheck2,
  Layers,
  Sparkles,
  Printer,
  ChevronRight,
  ShieldAlert,
  Percent,
} from 'lucide-react';

interface FinancialControlsViewProps {
  project: Project | null;
}

type TabType = 'bank_guarantees' | 'materials_on_site' | 'prolongation_ld' | 'price_escalation' | 'three_way_matching';

export default function FinancialControlsView({ project }: FinancialControlsViewProps) {
  const [lang, setLang] = useState<Language>(getLanguage());
  const [activeTab, setActiveTab] = useState<TabType>('bank_guarantees');

  useEffect(() => {
    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, []);

  // -------------------------------------------------------------
  // 1. Bank Guarantees & Letters of Credit State
  // -------------------------------------------------------------
  const [guarantees, setGuarantees] = useState<BankGuaranteeItem[]>([
    {
      id: 'BG-01',
      guaranteeType: 'advance_payment',
      bondNumber: 'APG-SA-884920',
      issuingBank: 'بنك الراجحي - مصرفية الشركات',
      beneficiary: 'أمانة منطقة الرياض / المالك',
      issueDate: '2026-08-15',
      expiryDate: '2027-04-30',
      initialAmountSar: 485000, // 10% of contract
      currentAmountSar: 277000, // Reduced after deductions in IPCs
      reductionPercentage: 42.8,
      status: 'active',
      daysUntilExpiry: 233,
      notes: 'يتم تخفيضه تدريجياً مع كل استقطاع دفعة مقدمة في المستخلصات الشهرية لتخفيض عمولات البنك.',
    },
    {
      id: 'BG-02',
      guaranteeType: 'performance_bond',
      bondNumber: 'PB-SNB-992140',
      issuingBank: 'البنك الأهلي السعودي (SNB)',
      beneficiary: 'أمانة منطقة الرياض / المالك',
      issueDate: '2026-08-01',
      expiryDate: '2027-06-30',
      initialAmountSar: 242500, // 5% of contract
      currentAmountSar: 242500,
      reductionPercentage: 0,
      status: 'active',
      daysUntilExpiry: 294,
      notes: 'ضمان حسن التنفيذ ساري حتى الاستلام الابتدائي (Taking-Over Certificate) مع تنبيه تجديد قبل 30 يوم.',
    },
    {
      id: 'BG-03',
      guaranteeType: 'letter_of_credit',
      bondNumber: 'LC-RIYAD-773100',
      issuingBank: 'بنك الرياض',
      beneficiary: 'شركة تبريد وتكييف المركزية (مورد أجنبي)',
      issueDate: '2026-10-01',
      expiryDate: '2026-12-15',
      initialAmountSar: 350000,
      currentAmountSar: 350000,
      reductionPercentage: 0,
      status: 'expiring_soon',
      daysUntilExpiry: 24,
      notes: 'اعتماد مستندي غير قابل للإلغاء لاستيراد وحدات التشيلر والمضخات التخصصية.',
    },
  ]);

  const [showAddBgModal, setShowAddBgModal] = useState(false);
  const [newBgForm, setNewBgForm] = useState({
    guaranteeType: 'advance_payment' as any,
    bondNumber: 'BG-NEW-001',
    issuingBank: 'مصرف الراجحي',
    beneficiary: 'المالك / جهة المشروع',
    issueDate: '2026-10-01',
    expiryDate: '2027-05-30',
    initialAmountSar: 150000,
    notes: 'خطاب ضمان مصرفي ساري وفق اشتراطات العقد',
  });

  // -------------------------------------------------------------
  // 2. Materials On Site (MOS) State
  // -------------------------------------------------------------
  const [mosItems, setMosItems] = useState<MaterialsOnSiteItem[]>([
    {
      id: 'MOS-01',
      code: 'MOS-STL-01',
      description: 'حديد تسليح عالي المقاومة عيار 60 مشون بالموقع (أقطار 16، 20، 25 مم)',
      deliveryDate: '2026-10-10',
      unit: 'طن',
      deliveredQuantity: 180,
      unitRateSar: 2850,
      totalDeliveredValueSar: 513000,
      advancePaymentPercentage: 75, // 75% advance per FIDIC
      certifiedAmountSar: 384750,
      installedAndRecoveredQty: 95,
      remainingSiteBalanceQty: 85,
      remainingCertifiedBalanceSar: 181687.5,
      status: 'partially_installed',
      inspectionReportNo: 'MIR-STL-2026-042',
    },
    {
      id: 'MOS-02',
      code: 'MOS-PIP-01',
      description: 'أنابيب خرسانية سابقة الصب ووصلات قطر 800 مم لتصريف السيول',
      deliveryDate: '2026-10-25',
      unit: 'م.ط',
      deliveredQuantity: 650,
      unitRateSar: 420,
      totalDeliveredValueSar: 273000,
      advancePaymentPercentage: 80,
      certifiedAmountSar: 218400,
      installedAndRecoveredQty: 200,
      remainingSiteBalanceQty: 450,
      remainingCertifiedBalanceSar: 151200,
      status: 'partially_installed',
      inspectionReportNo: 'MIR-PIP-2026-088',
    },
    {
      id: 'MOS-03',
      code: 'MOS-CBL-01',
      description: 'بكرات كابلات نحاسية معزولة جهد متوسط 13.8 ك.ف مع الملحقات',
      deliveryDate: '2026-11-05',
      unit: 'م.ط',
      deliveredQuantity: 1200,
      unitRateSar: 185,
      totalDeliveredValueSar: 222000,
      advancePaymentPercentage: 75,
      certifiedAmountSar: 166500,
      installedAndRecoveredQty: 0,
      remainingSiteBalanceQty: 1200,
      remainingCertifiedBalanceSar: 166500,
      status: 'stored_on_site',
      inspectionReportNo: 'MIR-CBL-2026-104',
    },
  ]);

  const [showAddMosModal, setShowAddMosModal] = useState(false);
  const [newMosForm, setNewMosForm] = useState({
    code: 'MOS-MAT-04',
    description: '',
    deliveryDate: '2026-11-10',
    unit: 'طن',
    deliveredQuantity: 50,
    unitRateSar: 1200,
    advancePaymentPercentage: 75,
    inspectionReportNo: 'MIR-GEN-01',
  });

  // -------------------------------------------------------------
  // 3. Prolongation Cost & Liquidated Damages State
  // -------------------------------------------------------------
  const [dailyOverheadRates, setDailyOverheadRates] = useState({
    staffPayrollSar: 3200, // رواتب كادر الإشراف الموقعي
    siteOfficeRentSar: 650,  // إيجار المكاتب المتنقلة والمستودعات
    securityAndSafetySar: 450, // الحراسة والسلامة المهنية
    utilitiesAndGensetSar: 550, // محروقات المولدات والكهرباء والاتصالات
    insuranceAndFeesSar: 350,   // تأمين الموقع ورسوم الفحص
  });

  const [eotCompensableDays, setEotCompensableDays] = useState<number>(14);
  const [unexcusedDelayDays, setUnexcusedDelayDays] = useState<number>(0);

  const prolongationCalculation: ProlongationAndLdCalc = useMemo(() => {
    const dailyRate =
      dailyOverheadRates.staffPayrollSar +
      dailyOverheadRates.siteOfficeRentSar +
      dailyOverheadRates.securityAndSafetySar +
      dailyOverheadRates.utilitiesAndGensetSar +
      dailyOverheadRates.insuranceAndFeesSar;

    const totalProlongationClaim = dailyRate * eotCompensableDays;
    const contractVal = project?.contract_value || 4850000;
    const dailyLdRate = Math.round(contractVal / 1000); // 0.1% per day per standard tender contract
    const unconstrainedLd = dailyLdRate * unexcusedDelayDays;
    const maxLdCap = Math.round(contractVal * 0.10); // 10% maximum statutory cap
    const totalLd = Math.min(unconstrainedLd, maxLdCap);
    const isCapped = unconstrainedLd > maxLdCap;

    return {
      dailySiteOverheadRateSar: dailyRate,
      excusableCompensableEotDays: eotCompensableDays,
      totalProlongationCostClaimSar: totalProlongationClaim,
      unexcusedDelayDays: unexcusedDelayDays,
      dailyLdPenaltyRateSar: dailyLdRate,
      totalLdPenaltySar: totalLd,
      maxLdCapSar: maxLdCap,
      isLdCapped: isCapped,
      netDelayFinancialImpactSar: totalProlongationClaim - totalLd,
    };
  }, [dailyOverheadRates, eotCompensableDays, unexcusedDelayDays, project]);

  // -------------------------------------------------------------
  // 4. Price Escalation Engine (FIDIC Clause 13.8) State
  // -------------------------------------------------------------
  const [escalationItems, setEscalationItems] = useState<PriceEscalationItem[]>([
    {
      id: 'ESC-01',
      materialCategory: 'rebar',
      nameAr: 'حديد التسليح الإنشائي (Steel Rebar Index)',
      weightCoefficient: 0.28,
      baselineIndexDate: '2026-08-01',
      baselineIndexValue: 100.0, // L0 / M0
      currentIndexDate: '2026-11-01',
      currentIndexValue: 114.5,  // +14.5% inflation
      escalationRatio: 0.145,
      quantityConsumed: 320,
      unit: 'طن',
      baselineUnitRateSar: 2650,
      escalationAdjustmentSar: 122960, // +122,960 SAR Payable to Contractor
    },
    {
      id: 'ESC-02',
      materialCategory: 'ready_mix_concrete',
      nameAr: 'الخرسانة الجاهزة C35/40 (Ready-Mix Index)',
      weightCoefficient: 0.32,
      baselineIndexDate: '2026-08-01',
      baselineIndexValue: 100.0,
      currentIndexDate: '2026-11-01',
      currentIndexValue: 106.2, // +6.2% inflation
      escalationRatio: 0.062,
      quantityConsumed: 2250,
      unit: 'م3',
      baselineUnitRateSar: 240,
      escalationAdjustmentSar: 33480, // +33,480 SAR Payable to Contractor
    },
    {
      id: 'ESC-03',
      materialCategory: 'diesel',
      nameAr: 'الديزل والمحروقات للمعدات (Fuel & Diesel Index)',
      weightCoefficient: 0.15,
      baselineIndexDate: '2026-08-01',
      baselineIndexValue: 100.0,
      currentIndexDate: '2026-11-01',
      currentIndexValue: 108.0, // +8% inflation
      escalationRatio: 0.08,
      quantityConsumed: 45000,
      unit: 'لتر',
      baselineUnitRateSar: 1.15,
      escalationAdjustmentSar: 4140,
    },
  ]);

  const totalNetEscalationClaimSar = escalationItems.reduce((s, i) => s + i.escalationAdjustmentSar, 0);

  // -------------------------------------------------------------
  // 5. 3-Way Invoice Matching State
  // -------------------------------------------------------------
  const [invoices, setInvoices] = useState<ThreeWayMatchingInvoice[]>([
    {
      id: '3WAY-01',
      poNumber: 'PO-2026-089',
      poDate: '2026-10-05',
      poAmountSar: 142500,
      grnInspectionNumber: 'MIR-STL-042',
      grnDate: '2026-10-10',
      grnInspectedAmountSar: 142500,
      invoiceNumber: 'INV-SABIC-4491',
      invoiceDate: '2026-10-12',
      vendorName: 'شركة حديد سابك للتوزيع',
      invoiceAmountSar: 142500,
      priceVarianceSar: 0,
      quantityVarianceSar: 0,
      matchingStatus: 'fully_matched',
      approvalStatus: 'approved_for_payment',
    },
    {
      id: '3WAY-02',
      poNumber: 'PO-2026-104',
      poDate: '2026-10-18',
      poAmountSar: 85000,
      grnInspectionNumber: 'MIR-PIP-088',
      grnDate: '2026-10-25',
      grnInspectedAmountSar: 78000, // Partial delivery (78k vs 85k)
      invoiceNumber: 'INV-PIPE-9921',
      invoiceDate: '2026-10-28',
      vendorName: 'مصنع الأنابيب والوصلات الهيدروليكية',
      invoiceAmountSar: 85000, // Invoiced for full PO instead of actual GRN
      priceVarianceSar: 0,
      quantityVarianceSar: 7000,
      matchingStatus: 'quantity_discrepancy',
      approvalStatus: 'on_hold',
    },
    {
      id: '3WAY-03',
      poNumber: 'PO-2026-118',
      poDate: '2026-11-01',
      poAmountSar: 62000,
      grnInspectionNumber: 'MIR-CHEM-110',
      grnDate: '2026-11-04',
      grnInspectedAmountSar: 62000,
      invoiceNumber: 'INV-FOSROC-213',
      invoiceDate: '2026-11-06',
      vendorName: 'شركة المواد الكيميائية والعوازل',
      invoiceAmountSar: 66500, // Price billed is higher than PO rate (+4,500 SAR)
      priceVarianceSar: 4500,
      quantityVarianceSar: 0,
      matchingStatus: 'price_discrepancy',
      approvalStatus: 'on_hold',
    },
  ]);

  // Handle adding new Guarantee
  const handleAddBg = () => {
    if (!newBgForm.bondNumber || newBgForm.initialAmountSar <= 0) return;
    const newBg: BankGuaranteeItem = {
      id: `BG-0${guarantees.length + 1}`,
      guaranteeType: newBgForm.guaranteeType,
      bondNumber: newBgForm.bondNumber,
      issuingBank: newBgForm.issuingBank,
      beneficiary: newBgForm.beneficiary,
      issueDate: newBgForm.issueDate,
      expiryDate: newBgForm.expiryDate,
      initialAmountSar: Number(newBgForm.initialAmountSar),
      currentAmountSar: Number(newBgForm.initialAmountSar),
      reductionPercentage: 0,
      status: 'active',
      daysUntilExpiry: 180,
      notes: newBgForm.notes,
    };
    setGuarantees([...guarantees, newBg]);
    setShowAddBgModal(false);
  };

  // Handle adding new MOS Item
  const handleAddMos = () => {
    if (!newMosForm.description || newMosForm.deliveredQuantity <= 0) return;
    const totalVal = Number(newMosForm.deliveredQuantity) * Number(newMosForm.unitRateSar);
    const certVal = totalVal * (Number(newMosForm.advancePaymentPercentage) / 100);

    const newMos: MaterialsOnSiteItem = {
      id: `MOS-0${mosItems.length + 1}`,
      code: newMosForm.code,
      description: newMosForm.description,
      deliveryDate: newMosForm.deliveryDate,
      unit: newMosForm.unit,
      deliveredQuantity: Number(newMosForm.deliveredQuantity),
      unitRateSar: Number(newMosForm.unitRateSar),
      totalDeliveredValueSar: totalVal,
      advancePaymentPercentage: Number(newMosForm.advancePaymentPercentage),
      certifiedAmountSar: certVal,
      installedAndRecoveredQty: 0,
      remainingSiteBalanceQty: Number(newMosForm.deliveredQuantity),
      remainingCertifiedBalanceSar: certVal,
      status: 'stored_on_site',
      inspectionReportNo: newMosForm.inspectionReportNo,
    };
    setMosItems([...mosItems, newMos]);
    setShowAddMosModal(false);
  };

  return (
    <div className="space-y-6 select-none">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shadow-xs">
              <Landmark size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black text-slate-900">
                  {lang === 'ar' ? 'الرقابة المالية والتعاقدية المتقدمة' : 'Advanced FIDIC & Contract Financial Controls'}
                </h1>
                <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
                  FIDIC Red Book · SCL · GaStat
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'ar'
                  ? 'إدارة الضمانات البنكية، مستحقات التشوينات بالموقع (MOS)، حاسبة تكاليف الإطالة وغرامات LDs، فروقات الأسعار، والمطابقة الثلاثية للفواتير.'
                  : 'Bank Guarantees, Materials On Site (MOS), Prolongation claims, Price Escalation (Clause 13.8), and 3-Way Invoice Matching.'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-bold text-slate-700 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200">
          <Shield size={15} className="text-emerald-600" />
          <span>مطابقة فيديك: <strong className="text-emerald-700">100% متوافق نظامياً</strong></span>
        </div>
      </div>

      {/* DEDICATED FULL-WIDTH TAB NAVIGATION BAR */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200 shadow-xs">
        <button
          onClick={() => setActiveTab('bank_guarantees')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'bank_guarantees'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <Shield size={15} className={activeTab === 'bank_guarantees' ? 'text-amber-400' : 'text-blue-600'} />
          <span>الضمانات البنكية والاعتمادات (BG/LC)</span>
        </button>

        <button
          onClick={() => setActiveTab('materials_on_site')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'materials_on_site'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <Box size={15} className={activeTab === 'materials_on_site' ? 'text-amber-400' : 'text-amber-600'} />
          <span>المواد المشونة بالموقع (MOS)</span>
        </button>

        <button
          onClick={() => setActiveTab('prolongation_ld')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'prolongation_ld'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <Scale size={15} className={activeTab === 'prolongation_ld' ? 'text-amber-400' : 'text-rose-600'} />
          <span>تكاليف الإطالة وغرامات (LDs)</span>
        </button>

        <button
          onClick={() => setActiveTab('price_escalation')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center ${
            activeTab === 'price_escalation'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <TrendingUp size={15} className={activeTab === 'price_escalation' ? 'text-amber-400' : 'text-purple-600'} />
          <span>تعديل الأسعار (Clause 13.8)</span>
        </button>

        <button
          onClick={() => setActiveTab('three_way_matching')}
          className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 text-center col-span-2 sm:col-span-1 ${
            activeTab === 'three_way_matching'
              ? 'bg-slate-900 text-amber-400 shadow-sm font-black ring-1 ring-slate-800'
              : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200/60'
          }`}
        >
          <Receipt size={15} className={activeTab === 'three_way_matching' ? 'text-amber-400' : 'text-emerald-600'} />
          <span>المطابقة الثلاثية (3-Way Match)</span>
        </button>
      </div>

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 1: BANK GUARANTEES & LETTERS OF CREDIT                                       */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'bank_guarantees' && (
        <div className="space-y-5">
          {/* Top KPI Ribbon */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي الضمانات البنكية النشطة</span>
              <div className="text-xl font-black text-slate-900">{guarantees.length} خطابات ضمان</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">القيمة الأصلية للضمانات الصادرة</span>
              <div className="text-xl font-black text-slate-900 font-mono">
                {guarantees.reduce((s, g) => s + g.initialAmountSar, 0).toLocaleString()} SAR
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">القيمة الحالية المحجوزة لدى البنوك</span>
              <div className="text-xl font-black text-amber-900 font-mono">
                {guarantees.reduce((s, g) => s + g.currentAmountSar, 0).toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-emerald-600 font-bold">
                وفر تخفيض الضمان: {((guarantees.reduce((s, g) => s + (g.initialAmountSar - g.currentAmountSar), 0))).toLocaleString()} SAR
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">إصدار جديد</span>
                <button
                  onClick={() => setShowAddBgModal(true)}
                  className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 font-bold rounded-lg text-xs transition-all cursor-pointer shadow-sm"
                >
                  + تسجيل خطاب ضمان
                </button>
              </div>
            </div>
          </div>

          {/* Guarantees Table */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-sm">
                سجل تتبع خطابات الضمان والاعتمادات المستندية (Bank Guarantees & LCs Register)
              </h3>
              <span className="text-xs text-slate-500 font-bold">تنبيهات تلقائية قبل انتهاء الصلاحية بـ 30 يوم</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">رقم ونوع الضمان</th>
                    <th className="p-3 text-right">البنك المصدر / المستفيد</th>
                    <th className="p-3 text-center">تاريخ الإصدار ← الانتهاء</th>
                    <th className="p-3 text-right">القيمة الأصلية</th>
                    <th className="p-3 text-right">القيمة الحالية السارية</th>
                    <th className="p-3 text-center">نسبة التخفيض المنجز</th>
                    <th className="p-3 text-center">الأيام المتبقية</th>
                    <th className="p-3 text-center">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {guarantees.map((g) => (
                    <tr key={g.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3">
                        <div className="font-mono font-bold text-slate-900">{g.bondNumber}</div>
                        <span className="text-[10px] text-amber-800 font-bold bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                          {g.guaranteeType === 'advance_payment'
                            ? 'ضمان الدفعة المقدمة (APG)'
                            : g.guaranteeType === 'performance_bond'
                            ? 'ضمان حسن التنفيذ (Performance Bond)'
                            : 'اعتماد مستندي (Letter of Credit)'}
                        </span>
                      </td>
                      <td className="p-3 text-slate-800">
                        <div className="font-semibold">{g.issuingBank}</div>
                        <div className="text-[10px] text-slate-400">المستفيد: {g.beneficiary}</div>
                      </td>
                      <td className="p-3 text-center font-mono text-slate-600 whitespace-nowrap">
                        {g.issueDate} ← <strong className="text-slate-900">{g.expiryDate}</strong>
                      </td>
                      <td className="p-3 text-right font-mono text-slate-800">{g.initialAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-right font-mono font-black text-amber-900">{g.currentAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-center">
                        <span className="font-mono font-bold text-emerald-700">%{g.reductionPercentage}</span>
                      </td>
                      <td className="p-3 text-center font-mono font-bold">
                        <span className={g.daysUntilExpiry <= 30 ? 'text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200' : 'text-slate-700'}>
                          {g.daysUntilExpiry} يوم
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          g.status === 'active'
                            ? 'bg-emerald-100 text-emerald-800'
                            : g.status === 'expiring_soon'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-100 text-slate-800'
                        }`}>
                          {g.status === 'active' ? 'ساري ومطابق ✓' : g.status === 'expiring_soon' ? 'قرب الانتهاء ⚠️' : 'تم الإفراج'}
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
      {/* TAB 2: MATERIALS ON SITE (MOS) ACCOUNTING                                        */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'materials_on_site' && (
        <div className="space-y-5">
          {/* MOS Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي قيمة التشوينات بالموقع</span>
              <div className="text-xl font-black text-slate-900 font-mono">
                {mosItems.reduce((s, m) => s + m.totalDeliveredValueSar, 0).toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-slate-500">مواد مفحوصة ومعتمدة بمحاضر MIR</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">المستحق المعتمد بالمستخلصات (75-80%)</span>
              <div className="text-xl font-black text-emerald-700 font-mono">
                {mosItems.reduce((s, m) => s + m.certifiedAmountSar, 0).toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-emerald-600 font-semibold">دفعة تشوينات مدفوعة من المالك</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">المقاصة المستردة بعد التركيب</span>
              <div className="text-xl font-black text-blue-700 font-mono">
                {(mosItems.reduce((s, m) => s + (m.certifiedAmountSar - m.remainingCertifiedBalanceSar), 0)).toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-blue-600 font-semibold">تم دمجها في الأعمال الدائمة</span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <span className="text-[11px] text-slate-400 block mb-1">تسجيل توريد جديد</span>
                <button
                  onClick={() => setShowAddMosModal(true)}
                  className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 font-bold rounded-lg text-xs transition-all cursor-pointer shadow-sm"
                >
                  + إضافة تشوينات للموقع
                </button>
              </div>
            </div>
          </div>

          {/* MOS Inventory Table */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  جدول مستحقات المواد المشونة بالموقع والمقاصة التلقائية (Materials On Site Ledger)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  وفق شروط عقود الفيديك (FIDIC) ونظام المنافسات: يحق للمقاول صرف 70% إلى 80% من قيمة المواد المفحوصة قبل تركيبها.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">كود وبيان المواد المشونة</th>
                    <th className="p-3 text-center">محضر الفحص (MIR)</th>
                    <th className="p-3 text-center">الكمية الموردة</th>
                    <th className="p-3 text-right">سعر الوحدة</th>
                    <th className="p-3 text-right">إجمالي القيمة</th>
                    <th className="p-3 text-center">نسبة الصرف</th>
                    <th className="p-3 text-right">المعتمد بالمستخلص</th>
                    <th className="p-3 text-center">المركب والمسترد</th>
                    <th className="p-3 text-right">الرصيد المشون المتبقي</th>
                    <th className="p-3 text-center">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {mosItems.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3">
                        <span className="font-mono font-bold text-slate-900 block">{m.code}</span>
                        <span className="text-slate-600 max-w-xs block truncate">{m.description}</span>
                      </td>
                      <td className="p-3 text-center font-mono font-bold text-blue-700">{m.inspectionReportNo}</td>
                      <td className="p-3 text-center font-mono font-bold text-slate-900">{m.deliveredQuantity} {m.unit}</td>
                      <td className="p-3 text-right font-mono text-slate-700">{m.unitRateSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-right font-mono text-slate-900">{m.totalDeliveredValueSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-center font-mono font-bold text-amber-800">%{m.advancePaymentPercentage}</td>
                      <td className="p-3 text-right font-mono font-black text-emerald-700">{m.certifiedAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-center font-mono font-bold text-blue-800">
                        {m.installedAndRecoveredQty} {m.unit}
                      </td>
                      <td className="p-3 text-right font-mono font-black text-amber-950">
                        {m.remainingCertifiedBalanceSar.toLocaleString()} SAR
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          m.status === 'stored_on_site' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                        }`}>
                          {m.status === 'stored_on_site' ? 'مشون بالكامل' : 'مركب جزئياً ومقاص'}
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
      {/* TAB 3: PROLONGATION COST & LIQUIDATED DAMAGES (LDS) CALCULATOR                   */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'prolongation_ld' && (
        <div className="space-y-6">
          {/* Prolongation vs LDs Comparison Result Card */}
          <div className="bg-gradient-to-br from-slate-900 to-indigo-950 text-white p-6 rounded-2xl shadow-sm border border-slate-700 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-4">
              <div>
                <span className="text-[11px] font-mono font-bold text-amber-400 bg-slate-800 px-2.5 py-1 rounded-md border border-amber-500/30">
                  Delay & Prolongation Quantum Analysis (SCL / FIDIC)
                </span>
                <h3 className="text-lg font-black text-white mt-1.5">
                  حاسبة التكاليف غير المباشرة للإطالة وغرامات التأخير التعاقدية (Prolongation & LDs)
                </h3>
              </div>

              <div className="text-left">
                <span className="text-[11px] text-slate-400 block font-semibold">صافي الأثر المالي للتأخير:</span>
                <span className={`text-xl font-black font-mono ${prolongationCalculation.netDelayFinancialImpactSar >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {prolongationCalculation.netDelayFinancialImpactSar >= 0 ? `+${prolongationCalculation.netDelayFinancialImpactSar.toLocaleString()}` : prolongationCalculation.netDelayFinancialImpactSar.toLocaleString()} SAR
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-slate-400 block">معدل الحرق اليومي لمصاريف الموقع (Overhead Rate):</span>
                <div className="text-xl font-black text-amber-400 font-mono">
                  {prolongationCalculation.dailySiteOverheadRateSar.toLocaleString()} SAR / يوم
                </div>
                <p className="text-[11px] text-slate-300">تكلفة استمرار تشغيل الموقع يومياً (كادر، مكاتب، حراسة، مرافق).</p>
              </div>

              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-slate-400 block">مبلغ تعويض الإطالة المبررة (Prolongation Claim):</span>
                <div className="text-xl font-black text-emerald-400 font-mono">
                  +{prolongationCalculation.totalProlongationCostClaimSar.toLocaleString()} SAR
                </div>
                <p className="text-[11px] text-slate-300">مستحق للمقاول عن ({eotCompensableDays}) يوم تمديد معتمد EOT.</p>
              </div>

              <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-1">
                <span className="text-slate-400 block">غرامات التأخير غير المبرر (Liquidated Damages):</span>
                <div className="text-xl font-black text-rose-400 font-mono">
                  -{prolongationCalculation.totalLdPenaltySar.toLocaleString()} SAR
                </div>
                <p className="text-[11px] text-slate-300">
                  {prolongationCalculation.isLdCapped ? 'تم بلوغ السقف النظامي الأقصى (10% من قيمة العقد)' : 'غرامة محتسبة على المقاول للتأخير الذاتي'}
                </p>
              </div>
            </div>
          </div>

          {/* Interactive Parameters & Breakdown Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left Box: Daily Site Overheads Breakdown */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
              <h4 className="font-bold text-slate-900 text-xs border-b pb-2 flex items-center justify-between">
                <span>1. تفصيل عناصر المصاريف غير المباشرة اليومية بالموقع</span>
                <span className="font-mono text-amber-800 font-bold">{prolongationCalculation.dailySiteOverheadRateSar.toLocaleString()} SAR/d</span>
              </h4>

              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">رواتب كادر الإشراف والمهندسين اليومية:</span>
                  <input
                    type="number"
                    value={dailyOverheadRates.staffPayrollSar}
                    onChange={(e) => setDailyOverheadRates({ ...dailyOverheadRates, staffPayrollSar: Number(e.target.value) })}
                    className="w-28 px-2 py-1 border rounded font-mono font-bold text-left"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-600">إيجار مكاتب الموقع والمختبرات والمستودعات:</span>
                  <input
                    type="number"
                    value={dailyOverheadRates.siteOfficeRentSar}
                    onChange={(e) => setDailyOverheadRates({ ...dailyOverheadRates, siteOfficeRentSar: Number(e.target.value) })}
                    className="w-28 px-2 py-1 border rounded font-mono font-bold text-left"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-600">الحراسات الأمنية ومسؤولي السلامة HSE:</span>
                  <input
                    type="number"
                    value={dailyOverheadRates.securityAndSafetySar}
                    onChange={(e) => setDailyOverheadRates({ ...dailyOverheadRates, securityAndSafetySar: Number(e.target.value) })}
                    className="w-28 px-2 py-1 border rounded font-mono font-bold text-left"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-600">محروقات المولدات والكهرباء والاتصالات:</span>
                  <input
                    type="number"
                    value={dailyOverheadRates.utilitiesAndGensetSar}
                    onChange={(e) => setDailyOverheadRates({ ...dailyOverheadRates, utilitiesAndGensetSar: Number(e.target.value) })}
                    className="w-28 px-2 py-1 border rounded font-mono font-bold text-left"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-600">وثيقة التأمين الشامل ورسوم الفحوصات:</span>
                  <input
                    type="number"
                    value={dailyOverheadRates.insuranceAndFeesSar}
                    onChange={(e) => setDailyOverheadRates({ ...dailyOverheadRates, insuranceAndFeesSar: Number(e.target.value) })}
                    className="w-28 px-2 py-1 border rounded font-mono font-bold text-left"
                  />
                </div>
              </div>
            </div>

            {/* Right Box: Delay Days Parameters & LDs Cap */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
              <h4 className="font-bold text-slate-900 text-xs border-b pb-2">
                2. أيام التأخير وغرامات الإخلال بالجدول (Contractual Delay Days)
              </h4>

              <div className="space-y-4 text-xs">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">أيام التمديد المبررة المستحقة للتعويض (Compensable EOT Days):</label>
                  <input
                    type="number"
                    value={eotCompensableDays}
                    onChange={(e) => setEotCompensableDays(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-emerald-300 bg-emerald-50/40 rounded-lg font-mono font-black text-emerald-900"
                  />
                  <span className="text-[10px] text-emerald-700">تأخيرات ناتجة عن أوامر تغييرية أو تأخر تسليم المخططات من المالك.</span>
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">أيام التأخير غير المبرر المنسوبة للمقاول (Unexcused Delay Days):</label>
                  <input
                    type="number"
                    value={unexcusedDelayDays}
                    onChange={(e) => setUnexcusedDelayDays(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-rose-300 bg-rose-50/40 rounded-lg font-mono font-black text-rose-900"
                  />
                  <span className="text-[10px] text-rose-700">تطبق عليها غرامة يومية قدرها {prolongationCalculation.dailyLdPenaltyRateSar.toLocaleString()} SAR/يوم (حد أقصى 10%).</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 4: PRICE ESCALATION ENGINE (FIDIC CLAUSE 13.8)                               */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'price_escalation' && (
        <div className="space-y-6">
          {/* Escalation Formula Banner */}
          <div className="p-4 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-600 animate-pulse" />
                <h3 className="text-sm font-black text-slate-900">
                  محرك احتساب تعديل وفروقات الأسعار وتضخم المواد (FIDIC Clause 13.8 & GaStat Indices)
                </h3>
              </div>
              <span className="font-mono text-xs font-black bg-white px-3 py-1 rounded border border-amber-300 text-amber-950">
                صافي التعويض: +{totalNetEscalationClaimSar.toLocaleString()} SAR
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed font-mono">
              Pn = P0 × [ a + b(Ln/L0) + c(Mn/M0) + d(En/E0) ] · تعويض مباشر للمقاول لتغطية الارتفاعات السعرية للحديد والخرسانة والمحروقات.
            </p>
          </div>

          {/* Escalation Table */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-sm">مصفوفة الأرقام القياسية وفروقات الأسعار للمواد الاستراتيجية</h3>
              <span className="text-xs text-slate-400">تحديث أرقام الهيئة العامة للإحصاء</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">المادة الاستراتيجية</th>
                    <th className="p-3 text-center">معامل الوزن (Weight)</th>
                    <th className="p-3 text-center">الرقم القياسي الأساس (L₀/M₀)</th>
                    <th className="p-3 text-center">الرقم القياسي الحالي (Lₙ/Mₙ)</th>
                    <th className="p-3 text-center">نسبة التغير السعري %</th>
                    <th className="p-3 text-center">الكمية المستهلكة</th>
                    <th className="p-3 text-right">السعر الأساسي</th>
                    <th className="p-3 text-right">مبلغ التعويض المستحق (SAR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {escalationItems.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-bold text-slate-900">{item.nameAr}</td>
                      <td className="p-3 text-center font-mono font-bold">{item.weightCoefficient}</td>
                      <td className="p-3 text-center font-mono text-slate-600">{item.baselineIndexValue.toFixed(1)}</td>
                      <td className="p-3 text-center font-mono font-black text-amber-900">{item.currentIndexValue.toFixed(1)}</td>
                      <td className="p-3 text-center font-mono font-bold text-rose-700">
                        +{(item.escalationRatio * 100).toFixed(1)}%
                      </td>
                      <td className="p-3 text-center font-mono font-bold text-slate-900">{item.quantityConsumed.toLocaleString()} {item.unit}</td>
                      <td className="p-3 text-right font-mono text-slate-600">{item.baselineUnitRateSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-right font-mono font-black text-emerald-700 text-sm">
                        +{item.escalationAdjustmentSar.toLocaleString()} SAR
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-black text-slate-900 border-t">
                  <tr>
                    <td colSpan={7} className="p-3 text-left">إجمالي مبالغ فروقات الأسعار المستحقة للمقاول بالمستخلص القادم:</td>
                    <td className="p-3 text-right font-mono text-emerald-800 text-sm">+{totalNetEscalationClaimSar.toLocaleString()} SAR</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------------------- */}
      {/* TAB 5: 3-WAY INVOICE MATCHING & SPEND CONTROL                                    */}
      {/* -------------------------------------------------------------------------------- */}
      {activeTab === 'three_way_matching' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <FileCheck2 size={18} className="text-emerald-600" />
                  <span>المطابقة الثلاثية للفواتير والرقابة المانعة للصرف (3-Way Invoice Matching)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  مطابقة أوتوماتيكية بين (1. أمر الشراء PO) و (2. إذن استلام وفحص المواد GRN) و (3. فاتورة المورد الضريبية) لمنع أي هدر أو تلاعب بالكميات والأسعار.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">أمر الشراء (PO)</th>
                    <th className="p-3 text-right">إذن الاستلام الموقعي (GRN/MIR)</th>
                    <th className="p-3 text-right">فاتورة المورد الضريبية</th>
                    <th className="p-3 text-right">مبلغ أمر الشراء</th>
                    <th className="p-3 text-right">مبلغ المستلم فعلياً</th>
                    <th className="p-3 text-right">مبلغ الفاتورة</th>
                    <th className="p-3 text-center">فارق المطابقة</th>
                    <th className="p-3 text-center">حالة الفحص</th>
                    <th className="p-3 text-center">إذن الصرف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3">
                        <span className="font-mono font-bold text-slate-900 block">{inv.poNumber}</span>
                        <span className="text-[10px] text-slate-400">{inv.poDate}</span>
                      </td>
                      <td className="p-3">
                        <span className="font-mono font-bold text-blue-700 block">{inv.grnInspectionNumber}</span>
                        <span className="text-[10px] text-slate-400">{inv.grnDate}</span>
                      </td>
                      <td className="p-3">
                        <span className="font-mono font-bold text-slate-800 block">{inv.invoiceNumber}</span>
                        <span className="text-[11px] text-slate-500 font-semibold">{inv.vendorName}</span>
                      </td>
                      <td className="p-3 text-right font-mono text-slate-700">{inv.poAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-right font-mono text-blue-800 font-bold">{inv.grnInspectedAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-right font-mono font-black text-slate-900">{inv.invoiceAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-center">
                        {inv.priceVarianceSar === 0 && inv.quantityVarianceSar === 0 ? (
                          <span className="text-emerald-700 font-mono font-bold">0 SAR ✓</span>
                        ) : (
                          <span className="text-rose-700 font-mono font-bold">
                            +{((inv.priceVarianceSar || inv.quantityVarianceSar)).toLocaleString()} SAR
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          inv.matchingStatus === 'fully_matched'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-rose-100 text-rose-800'
                        }`}>
                          {inv.matchingStatus === 'fully_matched'
                            ? 'مطابق 100% ✓'
                            : inv.matchingStatus === 'quantity_discrepancy'
                            ? 'تجاوز كميات المستلم ⚠️'
                            : 'تجاوز سعر الوحدة ⚠️'}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-black ${
                          inv.approvalStatus === 'approved_for_payment'
                            ? 'bg-emerald-600 text-white'
                            : 'bg-rose-600 text-white'
                        }`}>
                          {inv.approvalStatus === 'approved_for_payment' ? 'معتمد للصرف' : 'موقوف إلكترونياً (Block)'}
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

      {/* Modal: Add Bank Guarantee */}
      {showAddBgModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              تسجيل خطاب ضمان بنكي أو اعتماد مستندي جديد
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">نوع الضمان</label>
                  <select
                    value={newBgForm.guaranteeType}
                    onChange={(e) => setNewBgForm({ ...newBgForm, guaranteeType: e.target.value })}
                    className="w-full p-2 border rounded-lg bg-white font-bold"
                  >
                    <option value="advance_payment">ضمان الدفعة المقدمة (APG)</option>
                    <option value="performance_bond">ضمان حسن التنفيذ (Performance Bond)</option>
                    <option value="maintenance_defect">ضمان الصيانة والعيوب (Defects Bond)</option>
                    <option value="letter_of_credit">اعتماد مستندي (Letter of Credit)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">رقم خطاب الضمان</label>
                  <input
                    type="text"
                    value={newBgForm.bondNumber}
                    onChange={(e) => setNewBgForm({ ...newBgForm, bondNumber: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">البنك المصدر</label>
                  <input
                    type="text"
                    value={newBgForm.issuingBank}
                    onChange={(e) => setNewBgForm({ ...newBgForm, issuingBank: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">الجهة المستفيدة</label>
                  <input
                    type="text"
                    value={newBgForm.beneficiary}
                    onChange={(e) => setNewBgForm({ ...newBgForm, beneficiary: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">تاريخ الإصدار</label>
                  <input
                    type="date"
                    value={newBgForm.issueDate}
                    onChange={(e) => setNewBgForm({ ...newBgForm, issueDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">تاريخ الانتهاء والصلاحية</label>
                  <input
                    type="date"
                    value={newBgForm.expiryDate}
                    onChange={(e) => setNewBgForm({ ...newBgForm, expiryDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono text-emerald-800 font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">قيمة الضمان (SAR)</label>
                <input
                  type="number"
                  value={newBgForm.initialAmountSar}
                  onChange={(e) => setNewBgForm({ ...newBgForm, initialAmountSar: Number(e.target.value) })}
                  className="w-full p-2 border rounded-lg font-mono font-black text-amber-900"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAddBgModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleAddBg}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-amber-400 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                حفظ وتسجيل الضمان
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Add Materials on Site */}
      {showAddMosModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              تسجيل مواد مشونة جديدة بالموقع (Materials On Site)
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">كود المادة المشونة</label>
                  <input
                    type="text"
                    value={newMosForm.code}
                    onChange={(e) => setNewMosForm({ ...newMosForm, code: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">رقم محضر الفحص (MIR)</label>
                  <input
                    type="text"
                    value={newMosForm.inspectionReportNo}
                    onChange={(e) => setNewMosForm({ ...newMosForm, inspectionReportNo: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold text-blue-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">بيان ووصف المواد الموردة</label>
                <input
                  type="text"
                  placeholder="مثال: حديد تسليح، أنابيب، كابلات، وحدات تبريد..."
                  value={newMosForm.description}
                  onChange={(e) => setNewMosForm({ ...newMosForm, description: e.target.value })}
                  className="w-full p-2 border rounded-lg font-semibold"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">الوحدة</label>
                  <input
                    type="text"
                    value={newMosForm.unit}
                    onChange={(e) => setNewMosForm({ ...newMosForm, unit: e.target.value })}
                    className="w-full p-2 border rounded-lg text-center"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">الكمية الموردة</label>
                  <input
                    type="number"
                    value={newMosForm.deliveredQuantity}
                    onChange={(e) => setNewMosForm({ ...newMosForm, deliveredQuantity: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">سعر الوحدة (SAR)</label>
                  <input
                    type="number"
                    value={newMosForm.unitRateSar}
                    onChange={(e) => setNewMosForm({ ...newMosForm, unitRateSar: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold text-amber-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">تاريخ التوريد للموقع</label>
                  <input
                    type="date"
                    value={newMosForm.deliveryDate}
                    onChange={(e) => setNewMosForm({ ...newMosForm, deliveryDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">نسبة الاعتماد بالمستخلص (%)</label>
                  <input
                    type="number"
                    value={newMosForm.advancePaymentPercentage}
                    onChange={(e) => setNewMosForm({ ...newMosForm, advancePaymentPercentage: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-black text-emerald-800"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAddMosModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleAddMos}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-amber-400 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                حفظ وإدراج بالمستخلص
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

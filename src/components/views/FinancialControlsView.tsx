import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
// GAP-037 / GAP-010: one governed Data Date, and one rule for whether a record may count as actual.
import {
  calendarDaysBetween,
  isAfterDataDate,
  resolveDataDate,
  sumNumeric,
} from '@/lib/chronologyGuard';
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

/**
 * Visible DEMO / SAMPLE notice (GAP-037).
 *
 * None of the five domains on this screen — bank guarantees, materials on site, prolongation and
 * liquidated damages, price escalation indices, three-way invoice matching — has a table in
 * `supabase/migrations`, and this view issues no query at all. So each block states plainly that its
 * rows are samples and that they feed no live project KPI, instead of letting a reader take them for
 * contractual facts. The missing schema is reported here rather than papered over with new tables.
 */
function DemoSourceNotice({
  lang,
  dataDate,
  domainAr,
  domainEn,
  detailAr,
  detailEn,
}: {
  lang: Language;
  dataDate: string;
  domainAr: string;
  domainEn: string;
  detailAr?: string;
  detailEn?: string;
}) {
  return (
    <div className="p-3.5 rounded-xl border border-amber-300 bg-amber-50 flex items-start gap-2.5">
      <ShieldAlert size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="text-[11px] leading-relaxed space-y-0.5">
        <p className="font-black text-amber-900">
          {lang === 'ar' ? `بيانات تجريبية (DEMO / SAMPLE) — ${domainAr}` : `DEMO / SAMPLE data — ${domainEn}`}
        </p>
        <p className="text-amber-800">
          {lang === 'ar'
            ? `لا يوجد جدول في قاعدة البيانات لنطاق «${domainAr}» ضمن ملفات الـ migrations الحالية، وهذه الشاشة لا تقرأ أي جدول. السجلات المعروضة عيّنة ثابتة لأغراض العرض فقط، ولا تدخل في أي مؤشر أو إجمالي مالي حي للمشروع (BAC / EV / AC، المستخلصات المعتمدة، المدفوعات، نسب الإنجاز). تاريخ خط الحالة الحاكم: ${dataDate}.`
            : `No table exists for "${domainEn}" in the current migrations and this screen reads none. The rows shown are fixed samples for presentation only and contribute to no live project KPI or total (BAC / EV / AC, certified IPCs, payments, earned progress). Governing Data Date: ${dataDate}.`}
        </p>
        {(detailAr || detailEn) && (
          <p className="text-amber-900 font-bold">{lang === 'ar' ? detailAr : detailEn}</p>
        )}
      </div>
    </div>
  );
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

  // Governed Data Date of the active project (GAP-010). Every chronology test on this screen uses
  // it: a guarantee issued later, a delivery scheduled later, an index published later or an invoice
  // dated later is forward-looking and never an actual.
  const dataDate = useMemo(() => resolveDataDate(project), [project]);

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
      daysUntilExpiry: 229, // 2026-09-13 -> 2027-04-30 at the governed Data Date (rendered value is derived)
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
      daysUntilExpiry: 290, // 2026-09-13 -> 2027-06-30 at the governed Data Date (rendered value is derived)
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
      daysUntilExpiry: 93, // 2026-09-13 -> 2026-12-15 at the governed Data Date (rendered value is derived)
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
    const contractVal = project?.contract_value || 0;
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
      // Derived from the governed Data Date instead of a fixed 180-day placeholder; the register
      // renders this countdown from the same derivation, so the two can never disagree.
      daysUntilExpiry: calendarDaysBetween(dataDate, newBgForm.expiryDate) ?? 0,
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

  // ---------------------------------------------------------------------------
  // Chronology of every block (GAP-010): what already happened, and what is a plan
  // ---------------------------------------------------------------------------

  /** Bank guarantees: issued on or before the Data Date vs planned issuance; countdown derived. */
  const guaranteeChronology = useMemo(() => {
    const rows = guarantees.map((g) => {
      const issued = !isAfterDataDate(g.issueDate, dataDate);
      const daysUntilExpiry = calendarDaysBetween(dataDate, g.expiryDate);
      const displayStatus: 'planned' | 'active' | 'expiring_soon' | 'expired' = !issued
        ? 'planned'
        : daysUntilExpiry === null
          ? 'active'
          : daysUntilExpiry <= 0
            ? 'expired'
            : daysUntilExpiry <= 30
              ? 'expiring_soon'
              : 'active';
      return { ...g, issued, daysUntilExpiryLive: daysUntilExpiry, displayStatus };
    });
    const issuedRows = rows.filter((r) => r.issued);
    const plannedRows = rows.filter((r) => !r.issued);
    return {
      rows,
      issuedCount: issuedRows.length,
      plannedCount: plannedRows.length,
      issuedInitialSar: sumNumeric(issuedRows, (r) => r.initialAmountSar),
      issuedCurrentSar: sumNumeric(issuedRows, (r) => r.currentAmountSar),
      issuedReductionSar: sumNumeric(issuedRows, (r) => r.initialAmountSar - r.currentAmountSar),
      plannedInitialSar: sumNumeric(plannedRows, (r) => r.initialAmountSar),
    };
  }, [guarantees, dataDate]);

  /** Materials on site: only a delivery dated on or before the Data Date is a received actual. */
  const mosChronology = useMemo(() => {
    const rows = mosItems.map((m) => ({ ...m, delivered: !isAfterDataDate(m.deliveryDate, dataDate) }));
    const delivered = rows.filter((r) => r.delivered);
    const planned = rows.filter((r) => !r.delivered);
    return {
      rows,
      deliveredCount: delivered.length,
      plannedCount: planned.length,
      deliveredValueSar: sumNumeric(delivered, (r) => r.totalDeliveredValueSar),
      plannedValueSar: sumNumeric(planned, (r) => r.totalDeliveredValueSar),
      certifiedActualSar: sumNumeric(delivered, (r) => r.certifiedAmountSar),
      certifiedPlannedSar: sumNumeric(planned, (r) => r.certifiedAmountSar),
      recoveredActualSar: sumNumeric(delivered, (r) => r.certifiedAmountSar - r.remainingCertifiedBalanceSar),
    };
  }, [mosItems, dataDate]);

  /** Price escalation: an index reading dated after the Data Date is a projection, not a measurement. */
  const escalationChronology = useMemo(() => {
    const rows = escalationItems.map((i) => ({ ...i, measured: !isAfterDataDate(i.currentIndexDate, dataDate) }));
    const measured = rows.filter((r) => r.measured);
    const projected = rows.filter((r) => !r.measured);
    return {
      rows,
      measuredCount: measured.length,
      projectedCount: projected.length,
      measuredClaimSar: sumNumeric(measured, (r) => r.escalationAdjustmentSar),
      projectedClaimSar: sumNumeric(projected, (r) => r.escalationAdjustmentSar),
    };
  }, [escalationItems, dataDate]);

  /** Three-way matching: a document dated after the Data Date cannot be an actual receipt or payment. */
  const invoiceChronology = useMemo(() => {
    const rows = invoices.map((inv) => {
      const futureDocuments = [
        { label: 'PO', date: inv.poDate },
        { label: 'GRN', date: inv.grnDate },
        { label: 'Invoice', date: inv.invoiceDate },
      ].filter((doc) => isAfterDataDate(doc.date, dataDate));
      return { ...inv, futureDocuments, isFutureDated: futureDocuments.length > 0 };
    });
    const actualRows = rows.filter((r) => !r.isFutureDated);
    const futureRows = rows.filter((r) => r.isFutureDated);
    return {
      rows,
      actualCount: actualRows.length,
      futureCount: futureRows.length,
      actualInvoiceSar: sumNumeric(actualRows, (r) => r.invoiceAmountSar),
      futureInvoiceSar: sumNumeric(futureRows, (r) => r.invoiceAmountSar),
    };
  }, [invoices, dataDate]);

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

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
          <div className="flex items-center gap-2 text-slate-700 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200">
            <Clock size={15} className="text-blue-600" />
            <span>
              {lang === 'ar' ? 'تاريخ خط الحالة الحاكم: ' : 'Governing Data Date: '}
              <strong className="font-mono text-slate-900">{dataDate}</strong>
            </span>
          </div>
          {/* The former "100% compliant" badge asserted a compliance score no record supports. */}
          <div className="flex items-center gap-2 text-amber-900 bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-300">
            <ShieldAlert size={15} className="text-amber-600" />
            <span>
              {lang === 'ar'
                ? 'وحدات هذه الشاشة بلا جداول في قاعدة البيانات — السجلات المعروضة عيّنة (DEMO) ولا تدخل في أي مؤشر مالي حي'
                : 'These modules have no database tables — the rows shown are DEMO samples and feed no live financial KPI'}
            </span>
          </div>
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
          <DemoSourceNotice
            lang={lang}
            dataDate={dataDate}
            domainAr="الضمانات البنكية والاعتمادات المستندية"
            domainEn="Bank Guarantees & Letters of Credit"
            detailAr={`الصادر فعلاً حتى تاريخ خط الحالة: ${guaranteeChronology.issuedCount} — والإصدار المخطط بعده: ${guaranteeChronology.plannedCount} (لا يُحتسب ضماناً قائماً).`}
            detailEn={`Issued by the Data Date: ${guaranteeChronology.issuedCount} — planned issuance after it: ${guaranteeChronology.plannedCount} (not counted as an existing guarantee).`}
          />

          {/* Top KPI Ribbon */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">
                {lang === 'ar' ? 'الضمانات الصادرة فعلياً (حتى تاريخ خط الحالة)' : 'Guarantees actually issued (up to the Data Date)'}
              </span>
              <div className="text-xl font-black text-slate-900">
                {guaranteeChronology.issuedCount} {lang === 'ar' ? 'خطاب ضمان' : 'issued'}
              </div>
              <span className="text-[10px] text-slate-500 font-semibold">
                {lang === 'ar'
                  ? `إصدار مخطط بعد ${dataDate}: ${guaranteeChronology.plannedCount}`
                  : `Planned issuance after ${dataDate}: ${guaranteeChronology.plannedCount}`}
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">
                {lang === 'ar' ? 'القيمة الأصلية للضمانات الصادرة فعلياً' : 'Initial value of issued guarantees'}
              </span>
              <div className="text-xl font-black text-slate-900 font-mono">
                {guaranteeChronology.issuedInitialSar.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-slate-500 font-semibold">
                {lang === 'ar'
                  ? `مخطط للإصدار لاحقاً: ${guaranteeChronology.plannedInitialSar.toLocaleString()} SAR (خارج القائم)`
                  : `Planned for later issuance: ${guaranteeChronology.plannedInitialSar.toLocaleString()} SAR (excluded)`}
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">
                {lang === 'ar' ? 'القيمة الحالية المحجوزة لدى البنوك (ضمانات صادرة)' : 'Current amount held by banks (issued guarantees)'}
              </span>
              <div className="text-xl font-black text-amber-900 font-mono">
                {guaranteeChronology.issuedCurrentSar.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-emerald-600 font-bold">
                {lang === 'ar' ? 'وفر تخفيض الضمان: ' : 'Guarantee reduction saving: '}
                {guaranteeChronology.issuedReductionSar.toLocaleString()} SAR
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
                  {guaranteeChronology.rows.map((g) => (
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
                        {!g.issued && (
                          <span className="block text-[9.5px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 mt-1">
                            {lang === 'ar' ? 'إصدار مخطط بعد خط الحالة' : 'Planned issuance after the Data Date'}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono text-slate-800">{g.initialAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-right font-mono font-black text-amber-900">{g.currentAmountSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-center">
                        <span className="font-mono font-bold text-emerald-700">%{g.reductionPercentage}</span>
                      </td>
                      <td className="p-3 text-center font-mono font-bold">
                        {/* Derived from the governed Data Date, so the countdown cannot go stale. */}
                        <span className={
                          g.daysUntilExpiryLive === null
                            ? 'text-slate-400'
                            : g.daysUntilExpiryLive <= 30
                              ? 'text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200'
                              : 'text-slate-700'
                        }>
                          {g.daysUntilExpiryLive === null
                            ? (lang === 'ar' ? 'غير متاح (N/A)' : 'N/A')
                            : `${g.daysUntilExpiryLive} ${lang === 'ar' ? 'يوم' : 'd'}`}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          g.displayStatus === 'planned'
                            ? 'bg-slate-200 text-slate-700'
                            : g.displayStatus === 'active'
                              ? 'bg-emerald-100 text-emerald-800'
                              : g.displayStatus === 'expiring_soon'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-rose-100 text-rose-800'
                        }`}>
                          {g.displayStatus === 'planned'
                            ? (lang === 'ar' ? 'إصدار مخطط (لم يصدر بعد)' : 'Planned — not issued yet')
                            : g.displayStatus === 'active'
                              ? (lang === 'ar' ? 'ساري ✓' : 'Active ✓')
                              : g.displayStatus === 'expiring_soon'
                                ? (lang === 'ar' ? 'قرب الانتهاء ⚠️' : 'Expiring soon ⚠️')
                                : (lang === 'ar' ? 'منتهي الصلاحية' : 'Expired')}
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
          <DemoSourceNotice
            lang={lang}
            dataDate={dataDate}
            domainAr="المواد المشونة بالموقع (MOS)"
            domainEn="Materials On Site (MOS)"
            detailAr={`المستلم فعلياً حتى ${dataDate}: ${mosChronology.deliveredCount} بند — وتوريد مخطط بعده: ${mosChronology.plannedCount} بند لا يدخل في قيمة التشوينات أو المستخلص المعتمد.`}
            detailEn={`Actually delivered by ${dataDate}: ${mosChronology.deliveredCount} item(s) — planned delivery after it: ${mosChronology.plannedCount} item(s), excluded from the on-site and certified totals.`}
          />

          {/* MOS Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">
                {lang === 'ar' ? `قيمة التشوينات المستلمة فعلياً (حتى ${dataDate})` : `Materials actually delivered (up to ${dataDate})`}
              </span>
              <div className="text-xl font-black text-slate-900 font-mono">
                {mosChronology.deliveredValueSar.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-slate-500">
                {lang === 'ar'
                  ? `توريد مخطط بعد خط الحالة: ${mosChronology.plannedValueSar.toLocaleString()} SAR (${mosChronology.plannedCount} بند) — غير مستلم`
                  : `Planned delivery after the Data Date: ${mosChronology.plannedValueSar.toLocaleString()} SAR (${mosChronology.plannedCount} item(s)) — not received`}
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">
                {lang === 'ar' ? 'المعتمد فعلاً بالمستخلصات عن تشوينات مستلمة' : 'Certified in IPCs for delivered materials'}
              </span>
              <div className="text-xl font-black text-emerald-700 font-mono">
                {mosChronology.certifiedActualSar.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-emerald-600 font-semibold">
                {lang === 'ar'
                  ? `متوقع عند التوريد المخطط: ${mosChronology.certifiedPlannedSar.toLocaleString()} SAR (ليس مستحقاً بعد)`
                  : `Expected on planned delivery: ${mosChronology.certifiedPlannedSar.toLocaleString()} SAR (not yet due)`}
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">
                {lang === 'ar' ? 'المقاصة المستردة بعد التركيب (مواد مستلمة فعلياً)' : 'Recovered after installation (delivered materials only)'}
              </span>
              <div className="text-xl font-black text-blue-700 font-mono">
                {mosChronology.recoveredActualSar.toLocaleString()} SAR
              </div>
              <span className="text-[10px] text-blue-600 font-semibold">
                {lang === 'ar' ? 'مواد دُمجت في الأعمال الدائمة بموجب محاضر فحص' : 'Materials incorporated into the permanent works against inspection records'}
              </span>
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
                  {mosChronology.rows.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3">
                        <span className="font-mono font-bold text-slate-900 block">{m.code}</span>
                        <span className="text-slate-600 max-w-xs block truncate">{m.description}</span>
                      </td>
                      <td className="p-3 text-center font-mono font-bold text-blue-700">
                        {m.inspectionReportNo}
                        <span className="block text-[9.5px] text-slate-400">{m.deliveryDate}</span>
                        {!m.delivered && (
                          <span className="block text-[9.5px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 mt-1">
                            {lang === 'ar' ? 'توريد مخطط — لم يُستلم' : 'Planned delivery — not received'}
                          </span>
                        )}
                      </td>
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
                          !m.delivered
                            ? 'bg-slate-200 text-slate-700'
                            : m.status === 'stored_on_site'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-blue-100 text-blue-800'
                        }`}>
                          {!m.delivered
                            ? (lang === 'ar' ? 'مخطط بعد خط الحالة (ليس تشويناً قائماً)' : 'Planned after the Data Date (not on site)')
                            : m.status === 'stored_on_site'
                              ? (lang === 'ar' ? 'مشون بالكامل' : 'Stored on site')
                              : (lang === 'ar' ? 'مركب جزئياً ومقاص' : 'Partially installed')}
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
          <DemoSourceNotice
            lang={lang}
            dataDate={dataDate}
            domainAr="تكاليف الإطالة وغرامات التأخير (Prolongation & LDs)"
            domainEn="Prolongation cost & Liquidated Damages"
            detailAr="حاسبة سيناريو بمدخلات تجريبية قابلة للتعديل: أيام التمديد المعتمدة تعاقدياً لا يوجد لها جدول في قاعدة البيانات (لا delay_claims ضمن الـ migrations)، لذلك لا يُعرض رقم معتمد — النتيجة أدناه تقدير what-if وليست مطالبة مستحقة."
            detailEn="Scenario calculator with editable demo inputs: contractually approved EOT days have no table in the database (no delay_claims migration), so no approved figure is shown — the result below is a what-if estimate, not a due claim."
          />

          {/* Prolongation vs LDs Comparison Result Card */}
          <div className="bg-gradient-to-br from-slate-900 to-indigo-950 text-white p-6 rounded-2xl shadow-sm border border-slate-700 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700 pb-4">
              <div>
                <span className="text-[11px] font-mono font-bold text-amber-400 bg-slate-800 px-2.5 py-1 rounded-md border border-amber-500/30">
                  Delay & Prolongation Quantum Analysis (SCL / FIDIC)
                </span>
                <span className="text-[10px] font-bold text-slate-300 bg-slate-800/70 px-2 py-0.5 rounded-md border border-slate-600 ml-1">
                  {lang === 'ar' ? 'سيناريو تقديري (DEMO inputs) — ليس مطالبة معتمدة' : 'Illustrative scenario (DEMO inputs) — not an approved claim'}
                </span>
                <h3 className="text-lg font-black text-white mt-1.5">
                  حاسبة التكاليف غير المباشرة للإطالة وغرامات التأخير التعاقدية (Prolongation & LDs)
                </h3>
              </div>

              <div className="text-left">
                <span className="text-[11px] text-slate-400 block font-semibold">
                  {lang === 'ar' ? 'صافي الأثر المالي لهذا السيناريو (تقديري):' : 'Net financial impact of this scenario (estimate):'}
                </span>
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
                <p className="text-[11px] text-slate-300">
                  {lang === 'ar'
                    ? `محسوب على ({eotCompensableDays}) يوم تمديد مُدخل يدوياً في هذا السيناريو — لا يوجد مصدر بيانات لأيام EOT معتمدة تعاقدياً (N/A).`
                    : `Computed on (${eotCompensableDays}) manually entered EOT day(s) for this scenario — there is no data source for contractually approved EOT days (N/A).`}
                </p>
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
          <DemoSourceNotice
            lang={lang}
            dataDate={dataDate}
            domainAr="تعديل الأسعار والأرقام القياسية (FIDIC 13.8)"
            domainEn="Price escalation indices (FIDIC Clause 13.8)"
            detailAr={`قراءة الرقم القياسي بتاريخ لاحق لتاريخ خط الحالة ${dataDate} هي قراءة متوقعة وليست قياساً صادراً: ${escalationChronology.projectedCount} من ${escalationChronology.rows.length} صفوف أدناه مبنية على أرقام مستقبلية، ومبالغها لا تُحتسب مستحقة.`}
            detailEn={`An index reading dated after the Data Date ${dataDate} is projected, not published: ${escalationChronology.projectedCount} of ${escalationChronology.rows.length} rows below rest on future readings, and their amounts are not due.`}
          />

          {/* Escalation Formula Banner */}
          <div className="p-4 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-600 animate-pulse" />
                <h3 className="text-sm font-black text-slate-900">
                  محرك احتساب تعديل وفروقات الأسعار وتضخم المواد (FIDIC Clause 13.8 & GaStat Indices)
                </h3>
              </div>
              <div className="text-left space-y-1">
                <span className="font-mono text-xs font-black bg-white px-3 py-1 rounded border border-emerald-300 text-emerald-900 block">
                  {lang === 'ar' ? 'مبني على أرقام قياسية صادرة حتى خط الحالة: ' : 'Based on indices published by the Data Date: '}
                  +{escalationChronology.measuredClaimSar.toLocaleString()} SAR
                </span>
                <span className="font-mono text-[11px] font-bold bg-white px-3 py-1 rounded border border-amber-300 text-amber-900 block">
                  {lang === 'ar' ? 'متوقع بعد خط الحالة (غير مستحق): ' : 'Projected after the Data Date (not due): '}
                  +{escalationChronology.projectedClaimSar.toLocaleString()} SAR
                </span>
              </div>
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
                  {escalationChronology.rows.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-bold text-slate-900">{item.nameAr}</td>
                      <td className="p-3 text-center font-mono font-bold">{item.weightCoefficient}</td>
                      <td className="p-3 text-center font-mono text-slate-600">{item.baselineIndexValue.toFixed(1)}</td>
                      <td className="p-3 text-center font-mono font-black text-amber-900">
                        {item.currentIndexValue.toFixed(1)}
                        <span className="block text-[9.5px] text-slate-400 font-semibold">{item.currentIndexDate}</span>
                        {!item.measured && (
                          <span className="block text-[9.5px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 mt-1">
                            {lang === 'ar' ? 'قراءة متوقعة بعد خط الحالة' : 'Projected reading after the Data Date'}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-center font-mono font-bold text-rose-700">
                        +{(item.escalationRatio * 100).toFixed(1)}%
                      </td>
                      <td className="p-3 text-center font-mono font-bold text-slate-900">{item.quantityConsumed.toLocaleString()} {item.unit}</td>
                      <td className="p-3 text-right font-mono text-slate-600">{item.baselineUnitRateSar.toLocaleString()} SAR</td>
                      <td className="p-3 text-right font-mono font-black text-sm">
                        <span className={item.measured ? 'text-emerald-700' : 'text-slate-400'}>
                          +{item.escalationAdjustmentSar.toLocaleString()} SAR
                        </span>
                        {!item.measured && (
                          <span className="block text-[9.5px] text-amber-800 font-bold">
                            {lang === 'ar' ? 'غير مستحق — رقم قياسي مستقبلي' : 'Not due — future index'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-black text-slate-900 border-t">
                  <tr>
                    <td colSpan={7} className="p-3 text-left">
                      {lang === 'ar'
                        ? `فروقات الأسعار المدعومة بأرقام قياسية صادرة حتى ${dataDate} (عيّنة DEMO):`
                        : `Escalation supported by indices published up to ${dataDate} (DEMO sample):`}
                    </td>
                    <td className="p-3 text-right font-mono text-emerald-800 text-sm">+{escalationChronology.measuredClaimSar.toLocaleString()} SAR</td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="p-3 text-left text-slate-500">
                      {lang === 'ar'
                        ? `مبنية على أرقام قياسية متوقعة بعد ${dataDate} — تُعرض للتقدير ولا تدخل في أي مستحق:`
                        : `Based on index readings projected after ${dataDate} — shown for estimation only, excluded from any amount due:`}
                    </td>
                    <td className="p-3 text-right font-mono text-slate-500 text-sm">+{escalationChronology.projectedClaimSar.toLocaleString()} SAR</td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="p-3 text-left text-slate-400 text-[11px]">
                      {lang === 'ar' ? 'مجموع صفقات العيّنة (لا يمثل مستحقاً تعاقدياً):' : 'Sum of the sample rows (not a contractual entitlement):'}
                    </td>
                    <td className="p-3 text-right font-mono text-slate-400 text-[11px]">+{totalNetEscalationClaimSar.toLocaleString()} SAR</td>
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
          <DemoSourceNotice
            lang={lang}
            dataDate={dataDate}
            domainAr="المطابقة الثلاثية للفواتير (PO / GRN / Invoice)"
            domainEn="Three-way invoice matching (PO / GRN / Invoice)"
            detailAr={`لا توجد جداول لأوامر الشراء أو أذون الاستلام أو فواتير الموردين (العمود المتاح هو cost_transactions.invoice_number فقط). ${invoiceChronology.futureCount} من ${invoiceChronology.rows.length} مستندات أدناه بتاريخ لاحق لتاريخ خط الحالة ${dataDate}، فهي مستندات مخططة وليست صرفاً فعلياً.`}
            detailEn={`There are no tables for purchase orders, goods receipts or vendor invoices (only cost_transactions.invoice_number exists). ${invoiceChronology.futureCount} of ${invoiceChronology.rows.length} documents below are dated after the Data Date ${dataDate}, so they are planned documents, not actual payments.`}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px]">
            <div className="p-3 bg-white rounded-xl border border-slate-200">
              <span className="text-slate-400 block">
                {lang === 'ar' ? `مستندات مكتملة بتاريخ لا يتجاوز ${dataDate}` : `Documents dated on or before ${dataDate}`}
              </span>
              <span className="font-mono font-black text-slate-900 text-base">{invoiceChronology.actualCount}</span>
              <span className="text-slate-500 font-mono block">{invoiceChronology.actualInvoiceSar.toLocaleString()} SAR</span>
            </div>
            <div className="p-3 bg-white rounded-xl border border-amber-200">
              <span className="text-slate-400 block">
                {lang === 'ar' ? 'مستندات بتاريخ لاحق (مخططة / متوقعة)' : 'Documents dated later (planned / forecast)'}
              </span>
              <span className="font-mono font-black text-amber-800 text-base">{invoiceChronology.futureCount}</span>
              <span className="text-amber-700 font-mono block">{invoiceChronology.futureInvoiceSar.toLocaleString()} SAR</span>
            </div>
            <div className="p-3 bg-white rounded-xl border border-slate-200">
              <span className="text-slate-400 block">
                {lang === 'ar' ? 'الأثر على التكلفة الفعلية للمشروع' : 'Effect on the project actual cost'}
              </span>
              <span className="font-black text-slate-700">
                {lang === 'ar' ? 'صفر — لا يُرحّل أي مبلغ من هذه العيّنة إلى AC' : 'None — no sample amount is posted to AC'}
              </span>
            </div>
          </div>

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
                  {invoiceChronology.rows.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3">
                        <span className="font-mono font-bold text-slate-900 block">{inv.poNumber}</span>
                        <span className="text-[10px] text-slate-400">{inv.poDate}</span>
                        {inv.futureDocuments.some((doc) => doc.label === 'PO') && (
                          <span className="block text-[9.5px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 mt-1">
                            {lang === 'ar' ? 'أمر شراء مستقبلي' : 'Future PO'}
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <span className="font-mono font-bold text-blue-700 block">{inv.grnInspectionNumber}</span>
                        <span className="text-[10px] text-slate-400">{inv.grnDate}</span>
                        {inv.futureDocuments.some((doc) => doc.label === 'GRN') && (
                          <span className="block text-[9.5px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 mt-1">
                            {lang === 'ar' ? 'استلام لم يقع بعد' : 'Receipt not yet occurred'}
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        <span className="font-mono font-bold text-slate-800 block">{inv.invoiceNumber}</span>
                        <span className="text-[10px] text-slate-400">{inv.invoiceDate}</span>
                        <span className="text-[11px] text-slate-500 font-semibold block">{inv.vendorName}</span>
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
                          inv.isFutureDated
                            ? 'bg-slate-400 text-white'
                            : inv.approvalStatus === 'approved_for_payment'
                              ? 'bg-emerald-600 text-white'
                              : 'bg-rose-600 text-white'
                        }`}>
                          {inv.isFutureDated
                            ? (lang === 'ar' ? 'مستند مستقبلي — ليس صرفاً فعلياً' : 'Future document — not an actual payment')
                            : inv.approvalStatus === 'approved_for_payment'
                              ? (lang === 'ar' ? 'معتمد للصرف' : 'Approved for payment')
                              : (lang === 'ar' ? 'موقوف إلكترونياً (Block)' : 'Blocked electronically')}
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

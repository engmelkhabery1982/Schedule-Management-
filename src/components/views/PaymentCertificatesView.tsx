import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, PaymentCertificate, VariationOrder } from '@/types';
import {
  Receipt,
  FileCheck2,
  DollarSign,
  Plus,
  Printer,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileText,
  Building,
  TrendingUp,
  Percent,
} from 'lucide-react';

interface PaymentCertificatesViewProps {
  project: Project | null;
}

export interface SubcontractorIpc {
  id: string;
  ipcNumber: string;
  subcontractorName: string;
  trade: string; // e.g. "أعمال الخرسانات والهياكل", "أعمال MEP والتكييف"
  certificateDate: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'approved' | 'paid';
  grossAmountToDate: number;
  currentGrossAmount: number;
  retentionDeduction: number; // 5% or 10%
  materialDeductions: number; // خصومات تشوينات أو محروقات
  netPayableToSubcontractor: number;
  // Back to back main contractor comparison
  mainContractorRevenueForSameQty: number;
  mainContractorProfitMarginSar: number;
  mainContractorMarginPercent: number;
  items: {
    id: string;
    description: string;
    unit: string;
    quantity: number;
    subcontractorRate: number; // سعر مقاول الباطن
    subcontractorAmount: number;
    mainContractorRate: number; // سعر المقاول الرئيسي مع المالك
    mainContractorAmount: number;
    marginSar: number;
  }[];
}

export default function PaymentCertificatesView({ project }: PaymentCertificatesViewProps) {
  const [lang, setLang] = useState<Language>(getLanguage());
  const [activeTab, setActiveTab] = useState<'ipcs' | 'subcontractors' | 'vos'>('ipcs');
  const [selectedIpcId, setSelectedIpcId] = useState<string>('IPC-04');
  const [selectedSubIpcId, setSelectedSubIpcId] = useState<string>('SUB-IPC-02');
  const [showAddVoModal, setShowAddVoModal] = useState(false);
  const [showAddSubIpcModal, setShowAddSubIpcModal] = useState(false);

  // Subcontractor IPCs
  const [subcontractorIpcs, setSubcontractorIpcs] = useState<SubcontractorIpc[]>([
    {
      id: 'SUB-IPC-01',
      ipcNumber: 'SUB-IPC-001',
      subcontractorName: 'شركة البنيان لأعمال الخرسانات والهياكل',
      trade: 'مقاول باطن - أعمال الهيكل الإنشائي والخرسانات',
      certificateDate: '2026-11-30',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      status: 'paid',
      grossAmountToDate: 490000,
      currentGrossAmount: 210000,
      retentionDeduction: 21000, // 10%
      materialDeductions: 15000, // ديزل وتشوينات
      netPayableToSubcontractor: 174000,
      mainContractorRevenueForSameQty: 295000,
      mainContractorProfitMarginSar: 85000,
      mainContractorMarginPercent: 28.8,
      items: [
        {
          id: 'SUB-ITM-01',
          description: 'صب ومعالجة خرسانة مسلحة للأعمدة وجدران القص (مصنعيات + نجارة وحدادة)',
          unit: 'م3',
          quantity: 220,
          subcontractorRate: 380,
          subcontractorAmount: 83600,
          mainContractorRate: 550,
          mainContractorAmount: 121000,
          marginSar: 37400,
        },
        {
          id: 'SUB-ITM-02',
          description: 'تنفيذ أسقف وجسور خرسانية مصمتة ومفرغة بالدور الأول',
          unit: 'م3',
          quantity: 340,
          subcontractorRate: 370,
          subcontractorAmount: 125800,
          mainContractorRate: 512,
          mainContractorAmount: 174080,
          marginSar: 48280,
        },
      ],
    },
    {
      id: 'SUB-IPC-02',
      ipcNumber: 'SUB-IPC-002',
      subcontractorName: 'مؤسسة الدقة للأنظمة الكهروميكانيكية (MEP)',
      trade: 'مقاول باطن - تمديدات التكييف والتهوية المركزية',
      certificateDate: '2026-12-31',
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      status: 'approved',
      grossAmountToDate: 280000,
      currentGrossAmount: 110500,
      retentionDeduction: 11050, // 10%
      materialDeductions: 4500,
      netPayableToSubcontractor: 94950,
      mainContractorRevenueForSameQty: 156000,
      mainContractorProfitMarginSar: 45500,
      mainContractorMarginPercent: 29.2,
      items: [
        {
          id: 'SUB-ITM-03',
          description: 'تركيب مجاري الهواء (Ductwork) وعوازل الصوت والحرارة للأسقف المستعارة',
          unit: 'م.ط',
          quantity: 650,
          subcontractorRate: 170,
          subcontractorAmount: 110500,
          mainContractorRate: 240,
          mainContractorAmount: 156000,
          marginSar: 45500,
        },
      ],
    },
  ]);

  useEffect(() => {
    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, []);

  // List of Payment Certificates
  const [certificates, setCertificates] = useState<PaymentCertificate[]>([
    {
      id: 'IPC-01',
      ipcNumber: 'IPC-01',
      certificateDate: '2026-09-30',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      status: 'paid',
      grossAmountToDate: 480000,
      previousGrossAmount: 0,
      currentGrossAmount: 480000,
      advancePaymentDeduction: 48000, // 10%
      retentionMoneyDeduction: 24000, // 5%
      penaltyDeduction: 0,
      vatAmount: 61200, // 15%
      netPayableAmount: 469200,
      items: [],
    },
    {
      id: 'IPC-02',
      ipcNumber: 'IPC-02',
      certificateDate: '2026-10-31',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      status: 'paid',
      grossAmountToDate: 1120000,
      previousGrossAmount: 480000,
      currentGrossAmount: 640000,
      advancePaymentDeduction: 64000,
      retentionMoneyDeduction: 32000,
      penaltyDeduction: 0,
      vatAmount: 81600,
      netPayableAmount: 625600,
      items: [],
    },
    {
      id: 'IPC-03',
      ipcNumber: 'IPC-03',
      certificateDate: '2026-11-30',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      status: 'certified_by_consultant',
      grossAmountToDate: 1780000,
      previousGrossAmount: 1120000,
      currentGrossAmount: 660000,
      advancePaymentDeduction: 66000,
      retentionMoneyDeduction: 33000,
      penaltyDeduction: 0,
      vatAmount: 84150,
      netPayableAmount: 645150,
      items: [],
    },
    {
      id: 'IPC-04',
      ipcNumber: 'IPC-04',
      certificateDate: '2026-12-31',
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      status: 'submitted_by_contractor',
      grossAmountToDate: 2420000,
      previousGrossAmount: 1780000,
      currentGrossAmount: 640000,
      advancePaymentDeduction: 64000,
      retentionMoneyDeduction: 32000,
      penaltyDeduction: 0,
      vatAmount: 81600,
      netPayableAmount: 625600,
      items: [
        {
          id: 'ITEM-01',
          boqItemId: 'BOQ-01',
          boqCode: '01.01',
          description: 'حفريات التربة وتجهيز منسوب التأسيس',
          unit: 'م3',
          contractQuantity: 4500,
          unitRateSar: 45,
          previousQuantity: 4500,
          currentQuantity: 0,
          cumulativeQuantity: 4500,
          cumulativeAmountSar: 202500,
          currentAmountSar: 0,
        },
        {
          id: 'ITEM-02',
          boqItemId: 'BOQ-02',
          boqCode: '02.01',
          description: 'خرسانة مسلحة عيار C35 للأساسات واللبشة',
          unit: 'م3',
          contractQuantity: 1200,
          unitRateSar: 480,
          previousQuantity: 1200,
          currentQuantity: 0,
          cumulativeQuantity: 1200,
          cumulativeAmountSar: 576000,
          currentAmountSar: 0,
        },
        {
          id: 'ITEM-03',
          boqItemId: 'BOQ-03',
          boqCode: '02.03',
          description: 'خرسانة مسلحة للأعمدة وجدران القص',
          unit: 'م3',
          contractQuantity: 650,
          unitRateSar: 550,
          previousQuantity: 380,
          currentQuantity: 220,
          cumulativeQuantity: 600,
          cumulativeAmountSar: 330000,
          currentAmountSar: 121000,
        },
        {
          id: 'ITEM-04',
          boqItemId: 'BOQ-04',
          boqCode: '02.04',
          description: 'خرسانة مسلحة للأسقف والجسور سابقة الإجهاد',
          unit: 'م3',
          contractQuantity: 950,
          unitRateSar: 520,
          previousQuantity: 320,
          currentQuantity: 410,
          cumulativeQuantity: 730,
          cumulativeAmountSar: 379600,
          currentAmountSar: 213200,
        },
        {
          id: 'ITEM-05',
          boqItemId: 'BOQ-05',
          boqCode: '03.01',
          description: 'تمديدات مسارات الدكت وشبكات التكييف المركزية',
          unit: 'م.ط',
          contractQuantity: 1800,
          unitRateSar: 170,
          previousQuantity: 400,
          currentQuantity: 650,
          cumulativeQuantity: 1050,
          cumulativeAmountSar: 178500,
          currentAmountSar: 110500,
        },
      ],
    },
  ]);

  // Variation Orders Log
  const [variationOrders, setVariationOrders] = useState<VariationOrder[]>([
    {
      id: 'VO-01',
      voNumber: 'VO-001',
      title: 'تعديل مسارات كابلات الجهد المتوسط ومحطة المحولات',
      description: 'نقل موقع غرفة المحولات لتفادي تقاطع شبكة الصرف الرئيسية وفق تعليمات شركة الكهرباء.',
      reason: 'authority_requirement',
      claimedCostSar: 145000,
      approvedCostSar: 128000,
      claimedTimeDays: 14,
      approvedTimeDays: 10,
      status: 'approved',
      submissionDate: '2026-10-15',
      approvalDate: '2026-11-02',
      impactedActivityCode: 'ACT-03',
    },
    {
      id: 'VO-02',
      voNumber: 'VO-002',
      title: 'ترقية نظام الواجهات الزجاجية إلى زجاج عاكس ثلاثي الطبقات',
      description: 'تحسين كفاءة الطاقة وتخفيض الحمل الحراري للمبنى حسب متطلبات كود البناء السعودي الأخضر.',
      reason: 'client_request',
      claimedCostSar: 280000,
      approvedCostSar: 245000,
      claimedTimeDays: 20,
      approvedTimeDays: 14,
      status: 'approved',
      submissionDate: '2026-11-10',
      approvalDate: '2026-11-28',
      impactedActivityCode: 'ACT-10',
    },
    {
      id: 'VO-03',
      voNumber: 'VO-003',
      title: 'إضافة نظام إطفاء بالغاز النظيف FM200 لغرف السيرفرات',
      description: 'تجهيز غرف تكنولوجيا المعلومات بنظام إطفاء متطور لم يكن مشمولاً بالمخططات الأولية.',
      reason: 'design_change',
      claimedCostSar: 95000,
      approvedCostSar: 0,
      claimedTimeDays: 7,
      approvedTimeDays: 0,
      status: 'pending_review',
      submissionDate: '2026-12-05',
      impactedActivityCode: 'ACT-11',
    },
  ]);

  // Form state for creating a new VO
  const [newVoForm, setNewVoForm] = useState({
    voNumber: `VO-00${variationOrders.length + 1}`,
    title: '',
    description: '',
    reason: 'client_request' as const,
    claimedCostSar: 85000,
    approvedCostSar: 75000,
    claimedTimeDays: 12,
    approvedTimeDays: 8,
    status: 'approved' as const,
    submissionDate: '2026-11-15',
    approvalDate: '2026-11-28',
    impactedActivityCode: 'ACT-05',
  });

  const selectedIpc = useMemo(() => {
    return certificates.find((c) => c.id === selectedIpcId) || certificates[certificates.length - 1];
  }, [certificates, selectedIpcId]);

  const totalCertifiedGross = certificates.reduce((sum, c) => Math.max(sum, c.grossAmountToDate), 0);
  const totalVoApprovedCost = variationOrders.filter((v) => v.status === 'approved').reduce((sum, v) => sum + v.approvedCostSar, 0);
  const totalVoApprovedTimeDays = variationOrders.filter((v) => v.status === 'approved').reduce((sum, v) => sum + v.approvedTimeDays, 0);

  const baseContractValue = project?.contract_value || 4500000;
  const revisedContractValue = baseContractValue + totalVoApprovedCost;

  // Toggle VO Status dynamically (Approved vs Pending vs Rejected)
  const handleToggleVoStatus = (voId: string) => {
    setVariationOrders((prev) =>
      prev.map((vo) => {
        if (vo.id === voId) {
          const nextStatus = vo.status === 'approved' ? 'pending_review' : vo.status === 'pending_review' ? 'rejected' : 'approved';
          const approvedCost = nextStatus === 'approved' ? vo.claimedCostSar * 0.9 : 0;
          const approvedTime = nextStatus === 'approved' ? Math.round(vo.claimedTimeDays * 0.8) : 0;
          const approvalDate = nextStatus === 'approved' ? (vo.approvalDate || new Date().toISOString().split('T')[0]) : undefined;
          return {
            ...vo,
            status: nextStatus,
            approvedCostSar: approvedCost,
            approvedTimeDays: approvedTime,
            approvalDate,
          };
        }
        return vo;
      })
    );
  };

  const handleAddNewVo = () => {
    if (!newVoForm.title) return;
    const newVo: VariationOrder = {
      id: `VO-0${variationOrders.length + 1}`,
      voNumber: newVoForm.voNumber,
      title: newVoForm.title,
      description: newVoForm.description,
      reason: newVoForm.reason,
      claimedCostSar: Number(newVoForm.claimedCostSar) || 0,
      approvedCostSar: Number(newVoForm.approvedCostSar) || 0,
      claimedTimeDays: Number(newVoForm.claimedTimeDays) || 0,
      approvedTimeDays: Number(newVoForm.approvedTimeDays) || 0,
      status: newVoForm.status,
      submissionDate: newVoForm.submissionDate || new Date().toISOString().split('T')[0],
      approvalDate: newVoForm.status === 'approved' ? newVoForm.approvalDate : undefined,
      impactedActivityCode: newVoForm.impactedActivityCode,
    };

    setVariationOrders([...variationOrders, newVo]);
    setShowAddVoModal(false);
    setNewVoForm({
      voNumber: `VO-00${variationOrders.length + 2}`,
      title: '',
      description: '',
      reason: 'client_request',
      claimedCostSar: 85000,
      approvedCostSar: 75000,
      claimedTimeDays: 12,
      approvedTimeDays: 8,
      status: 'approved',
      submissionDate: '2026-12-01',
      approvalDate: '2026-12-15',
      impactedActivityCode: 'ACT-05',
    });
  };

  return (
    <div className="space-y-5 select-none">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <Receipt className="text-amber-500" size={24} />
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              {lang === 'ar' ? 'المستخلصات المالية وسجل الأوامر التغييرية (IPCs & Variation Orders)' : 'Interim Payment Certificates & Variations'}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              Contract Billing & EVM
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'إدارة مستخلصات الدفع الدورية، استقطاعات الدفعة المقدمة والضمان، وحساب الضريبة (15%) واعتمادات الأوامر التغييرية.'
              : 'Manage monthly contractor payment certificates, advance deductions, retention money, VAT, and variation orders.'}
          </p>
        </div>

        {/* Tab Selector */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setActiveTab('ipcs')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'ipcs' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            <FileCheck2 size={14} />
            <span>{lang === 'ar' ? 'مستخلصات المقاول الرئيسي مع المالك (Main IPCs)' : 'Main Contractor IPCs'}</span>
          </button>

          <button
            onClick={() => setActiveTab('subcontractors')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'subcontractors' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Building size={14} />
            <span>{lang === 'ar' ? 'مستخلصات مقاولي الباطن وتكاليف التنفيذ (Subcontractor IPCs)' : 'Subcontractor IPCs & Costs'}</span>
          </button>

          <button
            onClick={() => setActiveTab('vos')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'vos' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            <FileText size={14} />
            <span>{lang === 'ar' ? 'الأوامر التغييرية (VOs)' : 'Variation Orders'}</span>
          </button>
        </div>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-[11px] text-slate-400 block mb-1">{lang === 'ar' ? 'قيمة العقد الأصلية (Base Contract)' : 'Base Contract Value'}</span>
          <div className="text-lg font-black text-slate-900">{baseContractValue.toLocaleString()} SAR</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-[11px] text-slate-400 block mb-1">{lang === 'ar' ? 'قيمة العقد المعدلة (Revised BAC)' : 'Revised Contract (BAC)'}</span>
          <div className="text-lg font-black text-emerald-700">{revisedContractValue.toLocaleString()} SAR</div>
          <span className="text-[10px] text-emerald-600 font-bold">+{totalVoApprovedCost.toLocaleString()} SAR VOs</span>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-[11px] text-slate-400 block mb-1">{lang === 'ar' ? 'إجمالي التمديد الزمني المعتمد' : 'Approved Time Extension'}</span>
          <div className="text-lg font-black text-blue-700">+{totalVoApprovedTimeDays} {lang === 'ar' ? 'يوم عمل' : 'days'}</div>
          <span className="text-[10px] text-blue-600 font-bold">{lang === 'ar' ? 'مربوط بشبكة CPM و TIA' : 'Linked to CPM & TIA'}</span>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-[11px] text-slate-400 block mb-1">{lang === 'ar' ? 'محتجز الضمان التراكمي (5%)' : 'Accumulated Retention'}</span>
          <div className="text-lg font-black text-amber-700">{(totalCertifiedGross * 0.05).toLocaleString()} SAR</div>
        </div>
      </div>

      {/* TAB 1: Interim Payment Certificates */}
      {activeTab === 'ipcs' && (
        <div className="space-y-4">
          {/* IPC Selector Strip */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {certificates.map((cert) => (
              <button
                key={cert.id}
                onClick={() => setSelectedIpcId(cert.id)}
                className={`flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                  selectedIpcId === cert.id
                    ? 'bg-slate-900 text-amber-400 border-slate-900 shadow-sm'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono">{cert.ipcNumber}</span>
                  <span className="text-[10px] text-slate-400">({cert.certificateDate})</span>
                </div>
              </button>
            ))}
          </div>

          {/* Certificate Official Dossier View */}
          {selectedIpc && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-6 space-y-6">
              {/* Certificate Top Header */}
              <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
                <div>
                  <span className="text-[11px] font-mono font-bold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
                    INTERIM PAYMENT CERTIFICATE NO. {selectedIpc.ipcNumber}
                  </span>
                  <h2 className="text-base font-black text-slate-900 mt-2">
                    {lang === 'ar' ? `شهادة الدفع والمستخلص الجاري رقم [${selectedIpc.ipcNumber}]` : `Interim Payment Certificate [${selectedIpc.ipcNumber}]`}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {lang === 'ar' ? `الفترة من ${selectedIpc.periodStart} إلى ${selectedIpc.periodEnd}` : `Period from ${selectedIpc.periodStart} to ${selectedIpc.periodEnd}`}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => window.print()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    <Printer size={14} />
                    <span>{lang === 'ar' ? 'طباعة المستخلص' : 'Print IPC'}</span>
                  </button>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold ${
                      selectedIpc.status === 'paid'
                        ? 'bg-emerald-100 text-emerald-800'
                        : selectedIpc.status === 'certified_by_consultant'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {selectedIpc.status === 'paid' ? 'تم الصرف (Paid)' : selectedIpc.status === 'certified_by_consultant' ? 'معتمد من الاستشاري' : 'مقدم للمراجعة'}
                  </span>
                </div>
              </div>

              {/* Financial Calculation Summary Table */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
                {/* Gross Amount Breakdown */}
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
                  <h4 className="font-bold text-slate-900 border-b pb-1.5">{lang === 'ar' ? '1. احتساب قيمة الأعمال المنجزة (Gross Value)' : '1. Gross Work Value'}</h4>
                  <div className="flex justify-between">
                    <span className="text-slate-600">{lang === 'ar' ? 'إجمالي الأعمال التراكمية حتى تاريخه:' : 'Cumulative Work to Date:'}</span>
                    <span className="font-mono font-bold text-slate-800">{selectedIpc.grossAmountToDate.toLocaleString()} SAR</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">{lang === 'ar' ? 'يخصم إجمالي المستخلص السابق:' : 'Less Previous Cumulative Gross:'}</span>
                    <span className="font-mono font-bold text-slate-600">({selectedIpc.previousGrossAmount.toLocaleString()}) SAR</span>
                  </div>
                  <div className="flex justify-between border-t pt-1.5 font-bold text-blue-800">
                    <span>{lang === 'ar' ? 'صافي الأعمال المنجزة خلال هذا الشهر:' : 'Current Period Work Value:'}</span>
                    <span className="font-mono">{selectedIpc.currentGrossAmount.toLocaleString()} SAR</span>
                  </div>
                </div>

                {/* Deductions Breakdown */}
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
                  <h4 className="font-bold text-slate-900 border-b pb-1.5">{lang === 'ar' ? '2. الاستقطاعات والضريبة (Deductions & VAT)' : '2. Deductions & VAT'}</h4>
                  <div className="flex justify-between text-rose-700">
                    <span>{lang === 'ar' ? 'استقطاع الدفعة المقدمة (10%):' : 'Advance Payment Recovery (10%):'}</span>
                    <span className="font-mono font-bold">- {selectedIpc.advancePaymentDeduction.toLocaleString()} SAR</span>
                  </div>
                  <div className="flex justify-between text-amber-700">
                    <span>{lang === 'ar' ? 'محتجز ضمان الأعمال (5%):' : 'Retention Money (5%):'}</span>
                    <span className="font-mono font-bold">- {selectedIpc.retentionMoneyDeduction.toLocaleString()} SAR</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>{lang === 'ar' ? 'ضريبة القيمة المضافة (15% VAT):' : 'VAT (15%):'}</span>
                    <span className="font-mono font-bold">+ {selectedIpc.vatAmount.toLocaleString()} SAR</span>
                  </div>
                  <div className="flex justify-between border-t pt-1.5 font-black text-emerald-800 text-sm">
                    <span>{lang === 'ar' ? 'المبلغ الصافي المستحق للصرف:' : 'Net Payable Amount:'}</span>
                    <span className="font-mono">{selectedIpc.netPayableAmount.toLocaleString()} SAR</span>
                  </div>
                </div>
              </div>

              {/* Items Detail Table */}
              {selectedIpc.items.length > 0 && (
                <div className="border rounded-xl overflow-hidden">
                  <div className="p-3 bg-slate-100 font-bold text-xs text-slate-700">
                    {lang === 'ar' ? 'تفصيل كميات بنود الأعمال المعتمدة بالمستخلص' : 'IPC Itemized Bill of Quantities Progress'}
                  </div>
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                      <tr>
                        <th className="p-2.5 text-right">{lang === 'ar' ? 'البند' : 'Item'}</th>
                        <th className="p-2.5 text-right">{lang === 'ar' ? 'بيان الأعمال' : 'Description'}</th>
                        <th className="p-2.5 text-center">{lang === 'ar' ? 'الوحدة' : 'Unit'}</th>
                        <th className="p-2.5 text-center">{lang === 'ar' ? 'الكمية السابقة' : 'Prev Qty'}</th>
                        <th className="p-2.5 text-center">{lang === 'ar' ? 'الكمية الحالية' : 'Curr Qty'}</th>
                        <th className="p-2.5 text-center">{lang === 'ar' ? 'الكمية التراكمية' : 'Cumul Qty'}</th>
                        <th className="p-2.5 text-right">{lang === 'ar' ? 'القيمة الحالية' : 'Current Value'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedIpc.items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="p-2.5 font-mono font-bold text-slate-700">{item.boqCode}</td>
                          <td className="p-2.5 font-medium text-slate-800 max-w-xs">{item.description}</td>
                          <td className="p-2.5 text-center text-slate-500 font-mono">{item.unit}</td>
                          <td className="p-2.5 text-center font-mono text-slate-500">{item.previousQuantity}</td>
                          <td className="p-2.5 text-center font-mono font-bold text-blue-700">{item.currentQuantity}</td>
                          <td className="p-2.5 text-center font-mono font-bold text-slate-800">{item.cumulativeQuantity}</td>
                          <td className="p-2.5 text-right font-mono font-black text-emerald-700">
                            {item.currentAmountSar.toLocaleString()} SAR
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: Subcontractor IPCs & Cost Accounting */}
      {activeTab === 'subcontractors' && (
        <div className="space-y-5">
          {/* Architecture Explanatory Infographic Card */}
          <div className="p-4 bg-gradient-to-r from-blue-50 via-slate-50 to-amber-50 border border-slate-200 rounded-xl space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <h3 className="text-sm font-black text-slate-900">
                {lang === 'ar' ? 'منظومة الفصل الهندسي والمالي بين مستحقات مقاول الباطن والمقاول الرئيسي' : 'Main Contractor Revenue vs Subcontractor Liability Model'}
              </h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs pt-1">
              <div className="bg-white p-3 rounded-lg border border-blue-200 shadow-xs">
                <span className="font-bold text-blue-900 block mb-1">1. إيراد المقاول الرئيسي (Client Revenue / EV)</span>
                <p className="text-[11px] text-slate-600">
                  تحسب الكميات المنفذة في الموقع <span className="font-bold text-blue-800">بسعر عقد المالك (Client Unit Price)</span> لتوليد مستخلص المقاول الرئيسي واحتساب القيمة المكتسبة (EV).
                </p>
              </div>

              <div className="bg-white p-3 rounded-lg border border-amber-200 shadow-xs">
                <span className="font-bold text-amber-900 block mb-1">2. مستحقات مقاول الباطن (Subcontractor Payable)</span>
                <p className="text-[11px] text-slate-600">
                  تحسب نفس الكميات المعتمدة <span className="font-bold text-amber-800">بسعر عقد الباطن (Subcontract Rate)</span> بمستخلص منفصل مع خصم محتجز الضمان وتشوينات الموقع.
                </p>
              </div>

              <div className="bg-white p-3 rounded-lg border border-emerald-200 shadow-xs">
                <span className="font-bold text-emerald-900 block mb-1">3. تكلفة فعلية وهامش ربح (Cost & Profit Margin)</span>
                <p className="text-[11px] text-slate-600">
                  يرحل مستخلص الباطن كـ <span className="font-bold text-rose-700">تكلفة فعلية مباشرة (AC)</span> على المقاول الرئيسي، والفارق بين السعرين هو <span className="font-bold text-emerald-700">هامش ربح المقاول</span>.
                </p>
              </div>
            </div>
          </div>

          {/* Subcontractor Selector Strip */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {subcontractorIpcs.map((sub) => (
              <button
                key={sub.id}
                onClick={() => setSelectedSubIpcId(sub.id)}
                className={`flex-shrink-0 px-4 py-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                  selectedSubIpcId === sub.id
                    ? 'bg-slate-900 text-amber-400 border-slate-900 shadow-sm'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex flex-col text-right">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold">{sub.ipcNumber}</span>
                    <span className="text-[10px] text-slate-400">({sub.certificateDate})</span>
                  </div>
                  <span className="text-[11px] text-slate-300 font-normal truncate max-w-xs">{sub.subcontractorName}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Active Subcontractor IPC Dossier */}
          {(() => {
            const currentSubIpc = subcontractorIpcs.find((s) => s.id === selectedSubIpcId) || subcontractorIpcs[0];
            if (!currentSubIpc) return null;

            return (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-6 space-y-6">
                {/* Dossier Header */}
                <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
                  <div>
                    <span className="text-[11px] font-mono font-bold text-amber-900 bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
                      SUBCONTRACTOR PAYMENT CERTIFICATE: {currentSubIpc.ipcNumber}
                    </span>
                    <h2 className="text-base font-black text-slate-900 mt-2">
                      {currentSubIpc.subcontractorName}
                    </h2>
                    <p className="text-xs text-slate-500 font-semibold mt-0.5">
                      {currentSubIpc.trade} · الفترة: من {currentSubIpc.periodStart} إلى {currentSubIpc.periodEnd}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => window.print()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <Printer size={14} />
                      <span>{lang === 'ar' ? 'طباعة مستخلص الباطن' : 'Print Sub IPC'}</span>
                    </button>
                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
                      {currentSubIpc.status === 'paid' ? 'تم الصرف للباطن (Paid)' : 'معتمد للترحيل والتكاليف'}
                    </span>
                  </div>
                </div>

                {/* Back-to-Back Comparison Dashboard */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  {/* Subcontractor Payable Box */}
                  <div className="bg-amber-50/70 p-4 rounded-xl border border-amber-200 space-y-2">
                    <span className="text-[11px] text-amber-900 font-bold block">مستحقات مقاول الباطن (صافي التكلفة)</span>
                    <div className="text-xl font-black text-amber-950 font-mono">
                      {currentSubIpc.netPayableToSubcontractor.toLocaleString()} SAR
                    </div>
                    <div className="text-[10px] text-amber-800 space-y-0.5 border-t border-amber-200/60 pt-1.5">
                      <div className="flex justify-between">
                        <span>إجمالي الأعمال المنجزة:</span>
                        <span className="font-mono font-bold">{currentSubIpc.currentGrossAmount.toLocaleString()} SAR</span>
                      </div>
                      <div className="flex justify-between text-rose-700">
                        <span>محتجز ضمان الباطن (10%):</span>
                        <span className="font-mono">- {currentSubIpc.retentionDeduction.toLocaleString()} SAR</span>
                      </div>
                      <div className="flex justify-between text-rose-700">
                        <span>خصومات تشوينات/ديزل:</span>
                        <span className="font-mono">- {currentSubIpc.materialDeductions.toLocaleString()} SAR</span>
                      </div>
                    </div>
                  </div>

                  {/* Main Contractor Revenue for Same Work Box */}
                  <div className="bg-blue-50/70 p-4 rounded-xl border border-blue-200 space-y-2">
                    <span className="text-[11px] text-blue-900 font-bold block">إيراد المقاول الرئيسي مع المالك لنفس البنود</span>
                    <div className="text-xl font-black text-blue-950 font-mono">
                      {currentSubIpc.mainContractorRevenueForSameQty.toLocaleString()} SAR
                    </div>
                    <div className="text-[10px] text-blue-800 space-y-0.5 border-t border-blue-200/60 pt-1.5">
                      <div className="flex justify-between">
                        <span>السعر التعاقدي مع المالك:</span>
                        <span className="font-mono font-bold">معتمد في مستخلص المالك</span>
                      </div>
                      <div className="flex justify-between">
                        <span>القيمة المكتسبة (EV) للمشروع:</span>
                        <span className="font-mono font-bold">+{currentSubIpc.mainContractorRevenueForSameQty.toLocaleString()} SAR</span>
                      </div>
                    </div>
                  </div>

                  {/* Main Contractor Profit Margin Box */}
                  <div className="bg-emerald-50/70 p-4 rounded-xl border border-emerald-200 space-y-2">
                    <span className="text-[11px] text-emerald-900 font-bold block">هامش ربح المقاول الرئيسي (Gross Margin)</span>
                    <div className="text-xl font-black text-emerald-700 font-mono">
                      +{currentSubIpc.mainContractorProfitMarginSar.toLocaleString()} SAR
                    </div>
                    <div className="text-[10px] text-emerald-800 space-y-0.5 border-t border-emerald-200/60 pt-1.5">
                      <div className="flex justify-between">
                        <span>نسبة الهامش الربحي:</span>
                        <span className="font-mono font-bold text-emerald-900">%{currentSubIpc.mainContractorMarginPercent}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>الأثر على الميزانية:</span>
                        <span className="font-bold text-emerald-700">إيجابي (وفر تكلفة)</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Detailed Back-to-Back Quantity & Two-Tier Unit Price Table */}
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="p-3 bg-slate-100 font-bold text-xs text-slate-800 flex items-center justify-between">
                    <span>جدول مقارنة الأسعار المزدوجة (سعر المالك vs سعر الباطن) لنفس الكميات المنفذة</span>
                    <span className="text-[11px] text-slate-500 font-mono">Two-Tier Unit Rate Breakdown</span>
                  </div>

                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                      <tr>
                        <th className="p-3 text-right">بيان البند والعمل المنفذ</th>
                        <th className="p-3 text-center">الوحدة</th>
                        <th className="p-3 text-center">الكمية المنجزة</th>
                        <th className="p-3 text-center bg-amber-50/70 text-amber-900 border-x border-amber-200">سعر الباطن (شراء)</th>
                        <th className="p-3 text-right bg-amber-50/70 text-amber-900">مستحق الباطن (تكلفة)</th>
                        <th className="p-3 text-center bg-blue-50/70 text-blue-900 border-x border-blue-200">سعر المالك (بيع)</th>
                        <th className="p-3 text-right bg-blue-50/70 text-blue-900">إيراد المقاول الرئيسي</th>
                        <th className="p-3 text-right bg-emerald-50 text-emerald-900">هامش الربح (SAR)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {currentSubIpc.items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="p-3 font-semibold text-slate-800 max-w-xs">{item.description}</td>
                          <td className="p-3 text-center text-slate-500 font-mono">{item.unit}</td>
                          <td className="p-3 text-center font-mono font-bold text-slate-900">{item.quantity}</td>
                          <td className="p-3 text-center font-mono font-bold text-amber-800 bg-amber-50/40 border-x border-amber-100">
                            {item.subcontractorRate} ر.س
                          </td>
                          <td className="p-3 text-right font-mono font-bold text-amber-900 bg-amber-50/40">
                            {item.subcontractorAmount.toLocaleString()} ر.س
                          </td>
                          <td className="p-3 text-center font-mono font-bold text-blue-800 bg-blue-50/40 border-x border-blue-100">
                            {item.mainContractorRate} ر.س
                          </td>
                          <td className="p-3 text-right font-mono font-bold text-blue-900 bg-blue-50/40">
                            {item.mainContractorAmount.toLocaleString()} ر.س
                          </td>
                          <td className="p-3 text-right font-mono font-black text-emerald-700 bg-emerald-50/40">
                            +{item.marginSar.toLocaleString()} ر.س
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* TAB 3: Variation Orders Log */}
      {activeTab === 'vos' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-3">
            <div>
              <div className="flex items-center gap-2">
                <FileText size={16} className="text-amber-600" />
                <h3 className="text-sm font-bold text-slate-900">
                  {lang === 'ar' ? 'سجل الأوامر التغييرية والمطالبات المالية (Variation Orders Log)' : 'Variation Orders Log'}
                </h3>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                  {lang === 'ar' ? 'مربوط آلياً بالجداول والميزانية و TIA' : 'Linked to Schedule, Cost & TIA'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'ar'
                  ? 'رصد ومتابعة التغييرات الهندسية والتعاقدية وأثرها المالي (زيادة ميزانية العقد) والزمني (تمديد مسار CPM) على المشروع.'
                  : 'Track engineering change requests, approved cost, and schedule duration impact linked to CPM and Budget.'}
              </p>
            </div>

            <button
              onClick={() => setShowAddVoModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-all shadow-sm cursor-pointer"
            >
              <Plus size={14} />
              <span>{lang === 'ar' ? 'تسجيل أمر تغييري جديد' : 'New Variation Order'}</span>
            </button>
          </div>

          {/* Direct Linkage Infographic Bar */}
          <div className="p-3.5 bg-blue-50/80 border border-blue-200 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-blue-950">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-600 animate-ping" />
              <span className="font-bold">
                {lang === 'ar' ? 'التكامل التلقائي للأوامر التغييرية:' : 'Variation Order Bidirectional Linkage:'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
              <span className="bg-white px-2 py-0.5 rounded border border-blue-200">
                📊 {lang === 'ar' ? 'الميزانية المعدلة (BAC):' : 'Revised BAC:'} {revisedContractValue.toLocaleString()} SAR
              </span>
              <span className="bg-white px-2 py-0.5 rounded border border-blue-200">
                ⏱ {lang === 'ar' ? 'التمديد الزمني:' : 'Total EOT:'} +{totalVoApprovedTimeDays} {lang === 'ar' ? 'يوم' : 'days'}
              </span>
              <span className="bg-white px-2 py-0.5 rounded border border-blue-200">
                🔗 {lang === 'ar' ? 'شبكة CPM:' : 'CPM Network:'} {lang === 'ar' ? 'محدثة تلقائياً' : 'Auto-synced'}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                <tr>
                  <th className="p-3 text-right">{lang === 'ar' ? 'رقم الأمر' : 'VO No.'}</th>
                  <th className="p-3 text-right">{lang === 'ar' ? 'عنوان وبيان التغيير' : 'Title & Description'}</th>
                  <th className="p-3 text-right">{lang === 'ar' ? 'النشاط المربوط في CPM' : 'Linked Activity'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'تاريخ التقديم' : 'Submission Date'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'تاريخ الاعتماد / السريان' : 'Approval / Impact Date'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الأثر المالي (المعتمد)' : 'Approved Cost'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الأثر الزمني (EOT)' : 'Time Impact'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الحالة والاعتماد' : 'Status'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'إجراء' : 'Action'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {variationOrders.map((vo) => (
                  <tr key={vo.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-3 font-mono font-bold text-amber-800">{vo.voNumber}</td>
                    <td className="p-3 max-w-sm">
                      <div className="font-bold text-slate-800">{vo.title}</div>
                      <div className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">{vo.description}</div>
                    </td>
                    <td className="p-3">
                      <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 text-[11px]">
                        {vo.impactedActivityCode || 'ACT-03'}
                      </span>
                    </td>
                    <td className="p-3 text-center font-mono text-slate-600 whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded bg-slate-100 font-semibold text-[11px]">
                        {vo.submissionDate || '2026-10-15'}
                      </span>
                    </td>
                    <td className="p-3 text-center font-mono whitespace-nowrap">
                      {vo.status === 'approved' && vo.approvalDate ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold text-[11px]">
                          ✓ {vo.approvalDate}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[10px]">
                          {lang === 'ar' ? 'بانتظار الاعتماد' : 'Pending Approval'}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-center font-mono">
                      <div className="font-bold text-emerald-700">{vo.approvedCostSar.toLocaleString()} SAR</div>
                      <div className="text-[10px] text-slate-400">({vo.claimedCostSar.toLocaleString()} SAR)</div>
                    </td>
                    <td className="p-3 text-center font-mono font-bold text-blue-700">
                      +{vo.approvedTimeDays} {lang === 'ar' ? 'يوم' : 'd'}
                    </td>
                    <td className="p-3 text-center">
                      <span
                        className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          vo.status === 'approved'
                            ? 'bg-emerald-100 text-emerald-800'
                            : vo.status === 'pending_review'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-rose-100 text-rose-800'
                        }`}
                      >
                        {vo.status === 'approved' ? 'معتمد (Approved)' : vo.status === 'pending_review' ? 'قيد المراجعة' : 'مرفوض'}
                      </span>
                    </td>
                    <td className="p-3 text-center">
                      <button
                        onClick={() => handleToggleVoStatus(vo.id)}
                        className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-[10px] cursor-pointer"
                        title={lang === 'ar' ? 'تبديل حالة الاعتماد وإعادة حساب الأثر المالي والزمني' : 'Toggle status'}
                      >
                        {lang === 'ar' ? 'تغيير الحالة ↺' : 'Toggle ↺'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add VO Modal */}
      {showAddVoModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              {lang === 'ar' ? 'تسجيل أمر تغييري وربطه بالجدول والميزانية' : 'Register New Variation Order'}
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'رقم الأمر التغييري' : 'VO Number'}</label>
                  <input
                    type="text"
                    value={newVoForm.voNumber}
                    onChange={(e) => setNewVoForm({ ...newVoForm, voNumber: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'النشاط المرتبط في الجدول (CPM Activity)' : 'Linked Activity'}</label>
                  <select
                    value={newVoForm.impactedActivityCode}
                    onChange={(e) => setNewVoForm({ ...newVoForm, impactedActivityCode: e.target.value })}
                    className="w-full p-2 border rounded-lg bg-white font-mono font-bold"
                  >
                    <option value="ACT-01">ACT-01 - أعمال الحفريات وتجهيز الموقع</option>
                    <option value="ACT-02">ACT-02 - لبشة الأساسات الخرسانية</option>
                    <option value="ACT-03">ACT-03 - أعمدة وجدران القص للدور الأرضي</option>
                    <option value="ACT-04">ACT-04 - سقف الدور الأرضي</option>
                    <option value="ACT-05">ACT-05 - أعمدة الدور الأول</option>
                    <option value="ACT-06">ACT-06 - سقف الدور الأول</option>
                    <option value="ACT-10">ACT-10 - الواجهات الزجاجية والكلادينج</option>
                    <option value="ACT-11">ACT-11 - وحدات التكييف وشبكات MEP</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'عنوان وبيان أمر التغيير' : 'Title & Description'}</label>
                <input
                  type="text"
                  placeholder="مثال: إضافة أعمال إنشائية إضافية أو تعديل تصاميم"
                  value={newVoForm.title}
                  onChange={(e) => setNewVoForm({ ...newVoForm, title: e.target.value })}
                  className="w-full p-2 border rounded-lg font-semibold"
                />
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'تفاصيل التغيير الفني والتعاقدي' : 'Details'}</label>
                <textarea
                  rows={2}
                  value={newVoForm.description}
                  onChange={(e) => setNewVoForm({ ...newVoForm, description: e.target.value })}
                  className="w-full p-2 border rounded-lg text-xs"
                  placeholder="بيان المبررات الهندسية والمراسلات المرجعية..."
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'تاريخ التقديم (Submission Date)' : 'Submission Date'}</label>
                  <input
                    type="date"
                    value={newVoForm.submissionDate}
                    onChange={(e) => setNewVoForm({ ...newVoForm, submissionDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'تاريخ الاعتماد / سريان الأثر' : 'Approval / Effective Date'}</label>
                  <input
                    type="date"
                    value={newVoForm.approvalDate}
                    onChange={(e) => setNewVoForm({ ...newVoForm, approvalDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono text-emerald-800 font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'الأثر المالي المعتمد (SAR)' : 'Approved Cost (SAR)'}</label>
                  <input
                    type="number"
                    value={newVoForm.approvedCostSar}
                    onChange={(e) => setNewVoForm({ ...newVoForm, approvedCostSar: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold text-emerald-700"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'التمديد الزمني المعتمد (أيام)' : 'Approved Time (Days)'}</label>
                  <input
                    type="number"
                    value={newVoForm.approvedTimeDays}
                    onChange={(e) => setNewVoForm({ ...newVoForm, approvedTimeDays: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold text-blue-700"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAddVoModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                {lang === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                onClick={handleAddNewVo}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                {lang === 'ar' ? 'حفظ وربط مع الجدول والميزانية' : 'Save & Link to CPM/Budget'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

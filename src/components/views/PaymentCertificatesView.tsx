import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import { resolveContractBaseline } from '@/lib/budgetForecastEngine';
import type { Project, PaymentCertificate, SubcontractPackage, SubcontractorIpc, PaymentCertificateItem, SubcontractorIpcItem } from '@/types';
import ScopeChangeRegister from './ScopeChangeRegister';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import { loadSubcontractPackages } from '@/lib/subcontractEngine';
import {
  getContractRetentionPercent,
  reconcilePaymentCertificate,
  reconcileSubcontractorCertificate,
  summarizeCertificates,
  type CertificateReconciliation,
} from '@/lib/commercialControlsEngine';
import {
  Receipt,
  FileCheck2,
  Printer,
  AlertCircle,
  FileText,
  Building,
  Plus,
  Trash2,
  X,
  CheckCircle2,
} from 'lucide-react';

export type { SubcontractorIpc };

interface PaymentCertificatesViewProps {
  project: Project | null;
}

export default function PaymentCertificatesView({ project }: PaymentCertificatesViewProps) {
  // Project changes discard drafts and late save responses from the prior project.
  return <ProjectPaymentCertificates key={project?.id ?? 'no-project'} project={project} />;
}

function ProjectPaymentCertificates({ project }: PaymentCertificatesViewProps) {
  const [lang, setLang] = useState<Language>(getLanguage());
  const [activeTab, setActiveTab] = useState<'ipcs' | 'subcontractors' | 'vos'>('ipcs');

  // Loaded project-scoped certificates
  const [certificates, setCertificates] = useState<PaymentCertificate[]>([]);
  const [subcontractorIpcs, setSubcontractorIpcs] = useState<SubcontractorIpc[]>([]);
  const [selectedIpcId, setSelectedIpcId] = useState<string | null>(null);
  const [selectedSubIpcId, setSelectedSubIpcId] = useState<string | null>(null);

  // Status and feedback
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  // Modals
  const [showAddIpcModal, setShowAddIpcModal] = useState(false);
  const [showAddSubIpcModal, setShowAddSubIpcModal] = useState(false);
  const [subcontractPackages, setSubcontractPackages] = useState<SubcontractPackage[]>([]);

  // Form states for new IPC
  const [newIpcNumber, setNewIpcNumber] = useState('');
  const [newCertDate, setNewCertDate] = useState('');
  const [newPeriodStart, setNewPeriodStart] = useState('');
  const [newPeriodEnd, setNewPeriodEnd] = useState('');
  const [newIpcStatus, setNewIpcStatus] = useState<PaymentCertificate['status']>('draft');
  const [newCurrentGross, setNewCurrentGross] = useState(0);
  const [newPreviousGross, setNewPreviousGross] = useState(0);
  const [newAdvanceDeduction, setNewAdvanceDeduction] = useState(0);
  const [newRetentionDeduction, setNewRetentionDeduction] = useState(0);
  const [newPenaltyDeduction, setNewPenaltyDeduction] = useState(0);
  const [newVatAmount, setNewVatAmount] = useState(0);
  const [newIpcItems, setNewIpcItems] = useState<PaymentCertificateItem[]>([]);

  // Form states for new Subcontractor IPC
  const [newSubIpcNumber, setNewSubIpcNumber] = useState('');
  const [newSubName, setNewSubName] = useState('');
  const [newSubTrade, setNewSubTrade] = useState('');
  const [newSubPkgCode, setNewSubPkgCode] = useState('');
  const [newSubCertDate, setNewSubCertDate] = useState('');
  const [newSubPeriodStart, setNewSubPeriodStart] = useState('');
  const [newSubPeriodEnd, setNewSubPeriodEnd] = useState('');
  const [newSubStatus, setNewSubStatus] = useState<'draft' | 'approved' | 'paid'>('draft');
  const [newSubCurrentGross, setNewSubCurrentGross] = useState(0);
  const [newSubGrossToDate, setNewSubGrossToDate] = useState(0);
  const [newSubRetention, setNewSubRetention] = useState(0);
  const [newSubMaterialDeductions, setNewSubMaterialDeductions] = useState(0);
  const [newSubMainRevenue, setNewSubMainRevenue] = useState(0);
  const [newSubItems, setNewSubItems] = useState<SubcontractorIpcItem[]>([]);

  const dataDate = project?.data_date || DEFAULT_DATA_DATE;

  useEffect(() => {
    const handleLangChange = (e: Event) => {
      const custom = e as CustomEvent<{ lang?: 'en' | 'ar' }>;
      setLang(custom.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, []);

  // Load project-scoped certificates, refusing stale asynchronous responses
  useEffect(() => {
    let cancelled = false;
    setSaveError(null);
    setSaveSuccess(null);

    if (!project?.id) {
      setCertificates([]);
      setSubcontractorIpcs([]);
      setSelectedIpcId(null);
      setSelectedSubIpcId(null);
      setLoading(false);
      setLoadError(null);
      return;
    }

    setLoading(true);
    setLoadError(null);

    Promise.all([
      supabase.from('payment_certificates').select('*').eq('project_id', project.id),
      supabase.from('subcontractor_payment_certificates').select('*').eq('project_id', project.id),
    ])
      .then(([mainRes, subRes]) => {
        if (cancelled) return;
        setLoading(false);

        if (mainRes.error) {
          setLoadError(mainRes.error.message || 'Failed to load main certificates');
          return;
        }
        if (subRes.error) {
          setLoadError(subRes.error.message || 'Failed to load subcontractor certificates');
          return;
        }

        const loadedMain = (mainRes.data || []) as PaymentCertificate[];
        const loadedSub = (subRes.data || []) as SubcontractorIpc[];

        setCertificates(loadedMain);
        setSubcontractorIpcs(loadedSub);

        // Safe ID resolution when switching projects
        setSelectedIpcId((prev) => {
          if (prev && loadedMain.some((c) => c.id === prev)) return prev;
          return loadedMain.length > 0 ? loadedMain[loadedMain.length - 1].id : null;
        });

        setSelectedSubIpcId((prev) => {
          if (prev && loadedSub.some((s) => s.id === prev)) return prev;
          return loadedSub.length > 0 ? loadedSub[0].id : null;
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setLoading(false);
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  // Load packages for contractual retention resolution
  useEffect(() => {
    let cancelled = false;
    if (!project?.id) {
      setSubcontractPackages([]);
      return;
    }
    loadSubcontractPackages(project.id).then((pkgs) => {
      if (!cancelled) setSubcontractPackages(pkgs);
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const selectedIpc = useMemo(() => {
    if (!selectedIpcId) return certificates.length > 0 ? certificates[certificates.length - 1] : null;
    return certificates.find((c) => c.id === selectedIpcId) || (certificates.length > 0 ? certificates[certificates.length - 1] : null);
  }, [certificates, selectedIpcId]);

  const selectedSubIpc = useMemo(() => {
    if (!selectedSubIpcId) return subcontractorIpcs.length > 0 ? subcontractorIpcs[0] : null;
    return subcontractorIpcs.find((s) => s.id === selectedSubIpcId) || (subcontractorIpcs.length > 0 ? subcontractorIpcs[0] : null);
  }, [subcontractorIpcs, selectedSubIpcId]);

  const retentionPercentByPackage = useMemo(() => {
    const map = new Map<string, number | null>();
    subcontractPackages.forEach((pkg) => map.set(pkg.code || pkg.id, getContractRetentionPercent(pkg)));
    return map;
  }, [subcontractPackages]);

  const ipcReconciliations = useMemo(
    () => certificates.map((cert) => reconcilePaymentCertificate(cert, dataDate)),
    [certificates, dataDate],
  );
  const ipcReconciliationById = useMemo(
    () => new Map(ipcReconciliations.map((rec) => [rec.id, rec])),
    [ipcReconciliations],
  );

  const subIpcReconciliations = useMemo(
    () =>
      subcontractorIpcs.map((sub) =>
        reconcileSubcontractorCertificate(
          sub,
          dataDate,
          sub.subcontractPackageCode
            ? retentionPercentByPackage.get(sub.subcontractPackageCode) ?? null
            : null,
        ),
      ),
    [subcontractorIpcs, dataDate, retentionPercentByPackage],
  );
  const subIpcReconciliationById = useMemo(
    () => new Map(subIpcReconciliations.map((rec) => [rec.id, rec])),
    [subIpcReconciliations],
  );

  const ipcSummary = useMemo(() => summarizeCertificates(ipcReconciliations, dataDate), [ipcReconciliations, dataDate]);
  const subIpcSummary = useMemo(
    () => summarizeCertificates(subIpcReconciliations, dataDate),
    [subIpcReconciliations, dataDate],
  );

  const totalCertifiedGross = ipcSummary.certifiedGrossToDate;
  const totalRetentionWithheld = ipcReconciliations
    .filter((rec) => rec.chronology.countsAsActual)
    .reduce((sum, rec) => sum + rec.deductions.retention, 0);
  const totalSubRetentionWithheld = subIpcReconciliations
    .filter((rec) => rec.chronology.countsAsActual)
    .reduce((sum, rec) => sum + rec.deductions.retention, 0);

  type CertificateRec = CertificateReconciliation & {
    retentionMatchesContract?: boolean | null;
    contractRetentionPercent?: number | null;
  };

  const renderReconciliationBadge = (rec?: CertificateRec) => {
    if (!rec) return null;
    const tone =
      rec.status === 'balanced'
        ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
        : rec.status === 'mismatch'
          ? 'bg-rose-100 text-rose-800 border-rose-300'
          : 'bg-slate-100 text-slate-600 border-slate-300';
    const label =
      rec.status === 'balanced'
        ? lang === 'ar'
          ? 'متوازن مع البنود'
          : 'Reconciled with lines'
        : rec.status === 'mismatch'
          ? lang === 'ar'
            ? 'غير متوازن مع البنود'
            : 'Header/lines mismatch'
          : lang === 'ar'
            ? 'بدون بنود تفصيلية'
            : 'Not itemized';
    return <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border whitespace-nowrap ${tone}`}>{label}</span>;
  };

  const renderChronologyBadge = (rec?: CertificateRec) => {
    if (!rec) return null;
    const cls = rec.chronology.recordClass;
    const tone =
      cls === 'actual'
        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
        : cls === 'future_dated_actual' || cls === 'undated_actual'
          ? 'bg-rose-50 text-rose-800 border-rose-300'
          : cls === 'rejected'
            ? 'bg-slate-200 text-slate-700 border-slate-300'
            : 'bg-amber-50 text-amber-900 border-amber-300';
    const label =
      cls === 'actual'
        ? lang === 'ar'
          ? 'فعلي معتمد'
          : 'Actual'
        : cls === 'pending'
          ? lang === 'ar'
            ? 'مقدم / معلق'
            : 'Pending'
          : cls === 'planned'
            ? lang === 'ar'
              ? 'مخطط / متوقع'
              : 'Forecast'
            : cls === 'rejected'
              ? lang === 'ar'
                ? 'مرفوض'
                : 'Rejected'
              : cls === 'future_dated_actual'
                ? lang === 'ar'
                  ? 'تعارض زمني'
                  : 'Future-dated actual'
                : lang === 'ar'
                  ? 'معتمد بلا تاريخ'
                  : 'Undated actual';
    return <span className={`px-1.5 py-0.5 rounded text-[9px] font-black border whitespace-nowrap ${tone}`}>{label}</span>;
  };

  const renderReconciliationPanel = (rec: CertificateRec | undefined, titleKey: 'ipc' | 'sub') => {
    void titleKey;
    if (!rec) return null;
    const ar = lang === 'ar';
    const notItemized = ar ? 'لا توجد بنود' : 'No lines';
    const rows: { label: string; headerValue: string; linesValue: string; ok: boolean | null }[] = [
      {
        label: ar ? 'إجمالي أعمال الفترة الجارية (Current Gross)' : 'Current period gross',
        headerValue: rec.headerCurrent.toLocaleString(),
        linesValue: rec.lineCount > 0 ? rec.lineCurrentSum.toLocaleString() : notItemized,
        ok: rec.lineCount > 0 ? rec.currentStatus === 'balanced' : null,
      },
      {
        label: ar ? 'الإجمالي التراكمي حتى تاريخه (Gross to Date)' : 'Cumulative gross to date',
        headerValue: rec.headerCumulative.toLocaleString(),
        linesValue: rec.cumulativeStatus === 'not_itemized' ? notItemized : rec.lineCumulativeSum.toLocaleString(),
        ok: rec.cumulativeStatus === 'not_itemized' ? null : rec.cumulativeStatus === 'balanced',
      },
      {
        label: ar ? 'المعتمد في المستخلص السابق (Previous)' : 'Previously certified',
        headerValue: rec.headerPrevious === null ? '—' : rec.headerPrevious.toLocaleString(),
        linesValue: rec.derivedPrevious === null ? notItemized : rec.derivedPrevious.toLocaleString(),
        ok: rec.derivedPrevious === null ? null : rec.previousStatus === 'balanced',
      },
      {
        label: ar ? 'صافي المبلغ المستحق (Net Payable)' : 'Net payable',
        headerValue: rec.netHeader === null ? '—' : rec.netHeader.toLocaleString(),
        linesValue: rec.netDerived === null ? notItemized : rec.netDerived.toLocaleString(),
        ok: rec.netDerived === null ? null : rec.netStatus === 'balanced',
      },
    ];

    return (
      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-800">
              {ar ? 'مطابقة الترويسة مع البنود وتاريخ البيانات' : 'Header vs Lines & Data Date Reconciliation'}
            </span>
            {renderReconciliationBadge(rec)}
            {renderChronologyBadge(rec)}
          </div>
          {rec.appliedRetentionPercent !== null && (
            <span className="text-[10px] font-bold text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200">
              {ar ? `نسبة الضمان المطبقة: ${rec.appliedRetentionPercent}%` : `Applied retention: ${rec.appliedRetentionPercent}%`}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {rows.map((row, idx) => (
            <div key={idx} className="bg-white p-2.5 rounded-lg border border-slate-200 flex justify-between items-center">
              <div>
                <span className="text-slate-600 block text-[11px]">{row.label}</span>
                <span className="font-mono font-bold text-slate-900">{row.headerValue} SAR</span>
                <span className="text-[10px] text-slate-400 block font-mono">
                  {ar ? 'مجموع البنود: ' : 'Lines: '}
                  {row.linesValue} {row.linesValue !== notItemized && 'SAR'}
                </span>
              </div>
              {row.ok !== null && (
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-black border ${
                    row.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'
                  }`}
                >
                  {row.ok ? (ar ? 'مطابق' : 'Balanced') : (ar ? 'غير مطابق' : 'Mismatch')}
                </span>
              )}
            </div>
          ))}
        </div>

        {rec.mismatchesAr.length > 0 && (
          <div className="bg-rose-50 border border-rose-200 p-2.5 rounded-lg text-[11px] space-y-1">
            <span className="font-bold text-rose-800 block">{ar ? 'ملاحظات المطابقة:' : 'Reconciliation notes:'}</span>
            <ul className="list-disc list-inside text-rose-700 space-y-0.5">
              {(ar ? rec.mismatchesAr : rec.mismatchesEn).map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  // Actions: Save new IPC
  const handleSaveIpc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project?.id) return;
    setSaveError(null);
    setSaveSuccess(null);

    const trimmedNum = newIpcNumber.trim();
    if (!trimmedNum) {
      setSaveError(lang === 'ar' ? 'رقم المستخلص مطلوب' : 'IPC number is required');
      return;
    }
    if (!newCertDate || !newPeriodStart || !newPeriodEnd) {
      setSaveError(lang === 'ar' ? 'جميع التواريخ مطلوبة' : 'All dates are required');
      return;
    }

    const isApprovedOrPaid = newIpcStatus === 'paid' || newIpcStatus === 'certified_by_consultant' || newIpcStatus === 'approved_by_client';
    if (isApprovedOrPaid && newCertDate > dataDate) {
      setSaveError(
        lang === 'ar'
          ? `لا يمكن حفظ مستخلص بحالة معتمدة (${newIpcStatus}) وتاريخ (${newCertDate}) بعد تاريخ البيانات (${dataDate})`
          : `Approved certificate dated ${newCertDate} violates Data Date ${dataDate}`,
      );
      return;
    }

    const grossToDate = Number(newPreviousGross || 0) + Number(newCurrentGross || 0);
    const netPayable =
      Number(newCurrentGross || 0) -
      Number(newAdvanceDeduction || 0) -
      Number(newRetentionDeduction || 0) -
      Number(newPenaltyDeduction || 0) +
      Number(newVatAmount || 0);

    const newRecord: PaymentCertificate = {
      id: `IPC-${Date.now().toString(36).toUpperCase()}`,
      project_id: project.id,
      ipcNumber: trimmedNum,
      certificateDate: newCertDate,
      periodStart: newPeriodStart,
      periodEnd: newPeriodEnd,
      status: newIpcStatus,
      currentGrossAmount: Number(newCurrentGross || 0),
      previousGrossAmount: Number(newPreviousGross || 0),
      grossAmountToDate: grossToDate,
      advancePaymentDeduction: Number(newAdvanceDeduction || 0),
      retentionMoneyDeduction: Number(newRetentionDeduction || 0),
      penaltyDeduction: Number(newPenaltyDeduction || 0),
      vatAmount: Number(newVatAmount || 0),
      netPayableAmount: netPayable,
      items: newIpcItems,
    };

    const res = await supabase.from('payment_certificates').insert(newRecord);
    if (res.error) {
      setSaveError(res.error.message || 'Failed to save certificate');
      return;
    }

    setCertificates((prev) => [...prev, newRecord]);
    setSelectedIpcId(newRecord.id);
    setShowAddIpcModal(false);
    setSaveSuccess(lang === 'ar' ? 'تم حفظ المستخلص بنجاح' : 'Payment certificate saved successfully');

    // Reset form
    setNewIpcNumber('');
    setNewCertDate('');
    setNewPeriodStart('');
    setNewPeriodEnd('');
    setNewCurrentGross(0);
    setNewPreviousGross(0);
    setNewAdvanceDeduction(0);
    setNewRetentionDeduction(0);
    setNewPenaltyDeduction(0);
    setNewVatAmount(0);
    setNewIpcItems([]);
  };

  // Actions: Save new Subcontractor IPC
  const handleSaveSubIpc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project?.id) return;
    setSaveError(null);
    setSaveSuccess(null);

    const trimmedNum = newSubIpcNumber.trim();
    if (!trimmedNum || !newSubName.trim() || !newSubTrade.trim()) {
      setSaveError(lang === 'ar' ? 'رقم المستخلص واسم المقاول والمهنة حقول مطلوبة' : 'IPC number, subcontractor name and trade are required');
      return;
    }
    if (!newSubCertDate || !newSubPeriodStart || !newSubPeriodEnd) {
      setSaveError(lang === 'ar' ? 'جميع التواريخ مطلوبة' : 'All dates are required');
      return;
    }

    const isApprovedOrPaid = newSubStatus === 'paid' || newSubStatus === 'approved';
    if (isApprovedOrPaid && newSubCertDate > dataDate) {
      setSaveError(
        lang === 'ar'
          ? `لا يمكن حفظ مستخلص باطن بحالة معتمدة (${newSubStatus}) وتاريخ (${newSubCertDate}) بعد تاريخ البيانات (${dataDate})`
          : `Approved subcontractor certificate dated ${newSubCertDate} violates Data Date ${dataDate}`,
      );
      return;
    }

    const netPayable = Number(newSubCurrentGross || 0) - Number(newSubRetention || 0) - Number(newSubMaterialDeductions || 0);
    const profitMargin = Number(newSubMainRevenue || 0) - Number(newSubCurrentGross || 0);
    const marginPercent = newSubMainRevenue > 0 ? Number(((profitMargin / newSubMainRevenue) * 100).toFixed(1)) : 0;

    const newRecord: SubcontractorIpc = {
      id: `SUB-IPC-${Date.now().toString(36).toUpperCase()}`,
      project_id: project.id,
      ipcNumber: trimmedNum,
      subcontractorName: newSubName.trim(),
      trade: newSubTrade.trim(),
      subcontractPackageCode: newSubPkgCode.trim() || null,
      certificateDate: newSubCertDate,
      periodStart: newSubPeriodStart,
      periodEnd: newSubPeriodEnd,
      status: newSubStatus,
      currentGrossAmount: Number(newSubCurrentGross || 0),
      grossAmountToDate: Number(newSubGrossToDate || newSubCurrentGross || 0),
      retentionDeduction: Number(newSubRetention || 0),
      materialDeductions: Number(newSubMaterialDeductions || 0),
      netPayableToSubcontractor: netPayable,
      mainContractorRevenueForSameQty: Number(newSubMainRevenue || 0),
      mainContractorProfitMarginSar: profitMargin,
      mainContractorMarginPercent: marginPercent,
      items: newSubItems,
    };

    const res = await supabase.from('subcontractor_payment_certificates').insert(newRecord);
    if (res.error) {
      setSaveError(res.error.message || 'Failed to save subcontractor certificate');
      return;
    }

    setSubcontractorIpcs((prev) => [...prev, newRecord]);
    setSelectedSubIpcId(newRecord.id);
    setShowAddSubIpcModal(false);
    setSaveSuccess(lang === 'ar' ? 'تم حفظ مستخلص مقاول الباطن بنجاح' : 'Subcontractor certificate saved successfully');

    // Reset form
    setNewSubIpcNumber('');
    setNewSubName('');
    setNewSubTrade('');
    setNewSubPkgCode('');
    setNewSubCertDate('');
    setNewSubPeriodStart('');
    setNewSubPeriodEnd('');
    setNewSubCurrentGross(0);
    setNewSubGrossToDate(0);
    setNewSubRetention(0);
    setNewSubMaterialDeductions(0);
    setNewSubMainRevenue(0);
    setNewSubItems([]);
  };

  // Actions: Delete main IPC
  const handleDeleteIpc = async (id: string) => {
    if (!project?.id) return;
    setSaveError(null);
    setSaveSuccess(null);
    if (!window.confirm(lang === 'ar' ? 'هل أنت متأكد من رغبتك بحذف هذا المستخلص؟' : 'Are you sure you want to delete this certificate?')) return;

    const res = await supabase.from('payment_certificates').delete().eq('id', id).eq('project_id', project.id);
    if (res.error) {
      setSaveError(res.error.message || 'Failed to delete certificate');
      return;
    }

    setCertificates((prev) => prev.filter((c) => c.id !== id));
    setSelectedIpcId((prev) => (prev === id ? null : prev));
    setSaveSuccess(lang === 'ar' ? 'تم حذف المستخلص بنجاح' : 'Certificate deleted successfully');
  };

  // Actions: Delete Subcontractor IPC
  const handleDeleteSubIpc = async (id: string) => {
    if (!project?.id) return;
    setSaveError(null);
    setSaveSuccess(null);
    if (!window.confirm(lang === 'ar' ? 'هل أنت متأكد من رغبتك بحذف هذا المستخلص؟' : 'Are you sure you want to delete this certificate?')) return;

    const res = await supabase.from('subcontractor_payment_certificates').delete().eq('id', id).eq('project_id', project.id);
    if (res.error) {
      setSaveError(res.error.message || 'Failed to delete certificate');
      return;
    }

    setSubcontractorIpcs((prev) => prev.filter((s) => s.id !== id));
    setSelectedSubIpcId((prev) => (prev === id ? null : prev));
    setSaveSuccess(lang === 'ar' ? 'تم حذف مستخلص الباطن بنجاح' : 'Subcontractor certificate deleted successfully');
  };

  const contractBaseline = resolveContractBaseline({ project });
  const contractValueLabel = contractBaseline.isAvailable
    ? `${contractBaseline.value.toLocaleString()} SAR`
    : lang === 'ar'
      ? 'غير متوفر (N/A) — لا توجد قيمة عقد مسجلة'
      : 'Not available (N/A) — no recorded contract value';

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
            {activeTab !== 'vos' && (
              <span className="px-2 py-0.5 rounded text-[10px] font-black bg-indigo-50 text-indigo-900 border border-indigo-200">
                {lang === 'ar' ? `تاريخ البيانات: ${dataDate}` : `Data Date: ${dataDate}`}
              </span>
            )}
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

      {/* Notifications */}
      {loadError && (
        <div className="p-3 rounded-xl border border-rose-300 bg-rose-50 text-xs font-bold text-rose-800 flex items-center justify-between">
          <span>{loadError}</span>
          <button onClick={() => setLoadError(null)} className="text-rose-600 hover:text-rose-800"><X size={16} /></button>
        </div>
      )}
      {saveError && (
        <div className="p-3 rounded-xl border border-rose-300 bg-rose-50 text-xs font-bold text-rose-800 flex items-center justify-between">
          <span>{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-rose-600 hover:text-rose-800"><X size={16} /></button>
        </div>
      )}
      {saveSuccess && (
        <div className="p-3 rounded-xl border border-emerald-300 bg-emerald-50 text-xs font-bold text-emerald-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600" />
            <span>{saveSuccess}</span>
          </div>
          <button onClick={() => setSaveSuccess(null)} className="text-emerald-600 hover:text-emerald-800"><X size={16} /></button>
        </div>
      )}

      {/* Metrics Row */}
      {activeTab !== 'vos' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="mb-1 block text-[11px] text-slate-400">{lang === 'ar' ? 'قيمة العقد المسجلة (دون أوامر التغيير)' : 'Recorded contract value (VOs excluded)'}</span>
            <div className={`text-xs font-black leading-6 ${contractBaseline.isAvailable ? 'text-slate-900' : 'text-slate-400'}`}>{contractValueLabel}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="mb-1 block text-[11px] text-slate-400">{lang === 'ar' ? 'المعتمد فعلياً حتى تاريخ البيانات' : 'Certified actual to Data Date'}</span>
            <div className="text-lg font-black text-slate-900">{totalCertifiedGross.toLocaleString()} SAR</div>
            <span className="text-[10px] font-bold text-slate-500">
              {lang === 'ar'
                ? `${ipcSummary.certifiedCount} مستخلص فعلي · ${ipcSummary.excludedCount} معلق/مخطط (متوقع +${ipcSummary.forecastCurrentTotal.toLocaleString()} SAR)`
                : `${ipcSummary.certifiedCount} actual · ${ipcSummary.excludedCount} pending/forecast (+${ipcSummary.forecastCurrentTotal.toLocaleString()} SAR)`}
            </span>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="mb-1 block text-[11px] text-slate-400">{lang === 'ar' ? 'محتجز الضمان الفعلي (حسب العقود)' : 'Retention withheld (contractual)'}</span>
            <div className="text-lg font-black text-amber-700">{totalRetentionWithheld.toLocaleString()} SAR</div>
            <span className="text-[10px] font-bold text-amber-700">{lang === 'ar' ? 'مستخلصات المقاول الرئيسي الفعلية' : 'Main-contractor actual certificates'}</span>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="mb-1 block text-[11px] text-slate-400">{lang === 'ar' ? 'محتجز مقاولي الباطن الفعلي' : 'Subcontractor retention withheld'}</span>
            <div className="text-lg font-black text-amber-700">{totalSubRetentionWithheld.toLocaleString()} SAR</div>
            <span className="text-[10px] font-bold text-slate-500">{lang === 'ar' ? `${subIpcSummary.certifiedCount} مستخلص فعلي` : `${subIpcSummary.certifiedCount} certified IPC(s)`}</span>
          </div>
        </div>
      )}

      {/* Alerts for non-empty discrepancies */}
      {activeTab !== 'vos' && (certificates.length > 0 || subcontractorIpcs.length > 0) && (ipcSummary.mismatchedCount > 0 || ipcSummary.contradictionsCount > 0 || subIpcSummary.mismatchedCount > 0 || subIpcSummary.contradictionsCount > 0) && (
        <div className="p-3 rounded-xl border border-rose-300 bg-rose-50 text-[11px] font-bold text-rose-900 flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5">
            <AlertCircle size={14} className="text-rose-600" />
            {lang === 'ar' ? 'تنبيهات مطابقة المستخلصات:' : 'Certificate reconciliation alerts:'}
          </span>
          {ipcSummary.mismatchedCount + subIpcSummary.mismatchedCount > 0 && (
            <span>
              {lang === 'ar'
                ? `${ipcSummary.mismatchedCount + subIpcSummary.mismatchedCount} مستخلص ترويسته لا تطابق بنوده`
                : `${ipcSummary.mismatchedCount + subIpcSummary.mismatchedCount} certificate(s) whose header disagrees with its lines`}
            </span>
          )}
          {ipcSummary.contradictionsCount + subIpcSummary.contradictionsCount > 0 && (
            <span>
              {lang === 'ar'
                ? `${ipcSummary.contradictionsCount + subIpcSummary.contradictionsCount} تعارض زمني (معتمد بتاريخ بعد تاريخ البيانات أو بلا تاريخ)`
                : `${ipcSummary.contradictionsCount + subIpcSummary.contradictionsCount} chronology contradiction(s) (approved after or without a date vs the Data Date)`}
            </span>
          )}
          {ipcSummary.notItemizedCount + subIpcSummary.notItemizedCount > 0 && (
            <span className="text-slate-700">
              {lang === 'ar'
                ? `${ipcSummary.notItemizedCount + subIpcSummary.notItemizedCount} مستخلص بدون بنود تفصيلية`
                : `${ipcSummary.notItemizedCount + subIpcSummary.notItemizedCount} certificate(s) without itemised lines`}
            </span>
          )}
        </div>
      )}

      {/* TAB 1: Main Contractor Payment Certificates */}
      {activeTab === 'ipcs' && (
        <div className="space-y-4">
          {loading ? (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-xs font-bold text-slate-500">
              {lang === 'ar' ? 'جاري تحميل المستخلصات...' : 'Loading certificates...'}
            </div>
          ) : certificates.length === 0 ? (
            /* Honest empty state for projects without certificates */
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center space-y-4 shadow-sm">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto text-slate-400">
                <Receipt size={24} />
              </div>
              <div className="max-w-md mx-auto space-y-1">
                <h3 className="text-base font-bold text-slate-900">
                  {lang === 'ar' ? 'لا توجد مستخلصات مسجلة للمقاول الرئيسي' : 'No Main Contractor IPCs Recorded'}
                </h3>
                <p className="text-xs text-slate-500">
                  {lang === 'ar'
                    ? 'هذا المشروع لا يحتوي على مستخلصات معتمدة أو مبالغ مصروفة مسجلة. أضف أول مستخلص أدناه.'
                    : 'This project has no certified amounts or payments recorded. Add the first certificate to begin.'}
                </p>
              </div>
              {project && (
                <button
                  onClick={() => setShowAddIpcModal(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-amber-400 text-xs font-bold rounded-xl hover:bg-slate-800 transition-colors shadow-sm cursor-pointer"
                >
                  <Plus size={14} />
                  <span>{lang === 'ar' ? 'إضافة مستخلص جديد' : 'New Payment Certificate'}</span>
                </button>
              )}
            </div>
          ) : (
            <>
              {/* IPC Selector Strip */}
              <div className="flex items-center justify-between gap-2 overflow-x-auto pb-1">
                <div className="flex items-center gap-2">
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
                        {renderReconciliationBadge(ipcReconciliationById.get(cert.id))}
                        {renderChronologyBadge(ipcReconciliationById.get(cert.id))}
                      </div>
                    </button>
                  ))}
                </div>
                {project && (
                  <button
                    onClick={() => setShowAddIpcModal(true)}
                    className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 bg-slate-900 text-amber-400 text-xs font-bold rounded-xl hover:bg-slate-800 transition-colors shadow-sm cursor-pointer"
                  >
                    <Plus size={14} />
                    <span>{lang === 'ar' ? 'مستخلص جديد' : 'New IPC'}</span>
                  </button>
                )}
              </div>

              {/* Selected Certificate Dossier View */}
              {selectedIpc && (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-6 space-y-6">
                  {/* Top Header */}
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
                      <button
                        onClick={() => handleDeleteIpc(selectedIpc.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-300 text-xs font-bold text-rose-700 hover:bg-rose-50 cursor-pointer"
                      >
                        <Trash2 size={14} />
                        <span>{lang === 'ar' ? 'حذف' : 'Delete'}</span>
                      </button>
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${
                          selectedIpc.status === 'paid'
                            ? 'bg-emerald-100 text-emerald-800'
                            : selectedIpc.status === 'certified_by_consultant'
                            ? 'bg-blue-100 text-blue-800'
                            : selectedIpc.status === 'approved_by_client'
                            ? 'bg-indigo-100 text-indigo-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {selectedIpc.status === 'paid'
                          ? 'تم الصرف (Paid)'
                          : selectedIpc.status === 'certified_by_consultant'
                          ? 'معتمد من الاستشاري'
                          : selectedIpc.status === 'approved_by_client'
                          ? 'معتمد من العميل'
                          : 'مقدم للمراجعة'}
                      </span>
                    </div>
                  </div>

                  {/* Financial Summary */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
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

                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
                      <h4 className="font-bold text-slate-900 border-b pb-1.5">{lang === 'ar' ? '2. الاستقطاعات والضريبة (Deductions & VAT)' : '2. Deductions & VAT'}</h4>
                      <div className="flex justify-between text-rose-700">
                        <span>{lang === 'ar' ? 'استقطاع الدفعة المقدمة المسجل:' : 'Recorded Advance Recovery:'}</span>
                        <span className="font-mono font-bold">- {selectedIpc.advancePaymentDeduction.toLocaleString()} SAR</span>
                      </div>
                      <div className="flex justify-between text-amber-700">
                        <span>
                          {lang === 'ar' ? 'محتجز ضمان الأعمال' : 'Retention Money'} (
                          {ipcReconciliationById.get(selectedIpc.id)?.appliedRetentionPercent ?? (lang === 'ar' ? 'غير محدد' : 'unknown')}
                          %):
                        </span>
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

                  {/* Reconciliation Panel */}
                  {renderReconciliationPanel(ipcReconciliationById.get(selectedIpc.id), 'ipc')}

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
            </>
          )}
        </div>
      )}

      {/* TAB 2: Subcontractor IPCs */}
      {activeTab === 'subcontractors' && (
        <div className="space-y-5">
          {/* Infographic Model Card */}
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

          {loading ? (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-xs font-bold text-slate-500">
              {lang === 'ar' ? 'جاري تحميل المستخلصات...' : 'Loading certificates...'}
            </div>
          ) : subcontractorIpcs.length === 0 ? (
            /* Honest empty state for projects without subcontractor certificates */
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center space-y-4 shadow-sm">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto text-slate-400">
                <Building size={24} />
              </div>
              <div className="max-w-md mx-auto space-y-1">
                <h3 className="text-base font-bold text-slate-900">
                  {lang === 'ar' ? 'لا توجد مستخلصات مسجلة لمقاولي الباطن' : 'No Subcontractor IPCs Recorded'}
                </h3>
                <p className="text-xs text-slate-500">
                  {lang === 'ar'
                    ? 'هذا المشروع لا يحتوي على تكاليف باطن أو أرباح مسجلة. أضف أول مستخلص باطن للبدء.'
                    : 'This project has no subcontractor costs or margins recorded. Add the first subcontractor certificate to begin.'}
                </p>
              </div>
              {project && (
                <button
                  onClick={() => setShowAddSubIpcModal(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-amber-400 text-xs font-bold rounded-xl hover:bg-slate-800 transition-colors shadow-sm cursor-pointer"
                >
                  <Plus size={14} />
                  <span>{lang === 'ar' ? 'إضافة مستخلص باطن جديد' : 'New Subcontractor IPC'}</span>
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Subcontractor Selector Strip */}
              <div className="flex items-center justify-between gap-2 overflow-x-auto pb-1">
                <div className="flex items-center gap-2">
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
                          {renderReconciliationBadge(subIpcReconciliationById.get(sub.id))}
                          {renderChronologyBadge(subIpcReconciliationById.get(sub.id))}
                        </div>
                        <span className="text-[11px] text-slate-300 font-normal truncate max-w-xs">{sub.subcontractorName}</span>
                      </div>
                    </button>
                  ))}
                </div>
                {project && (
                  <button
                    onClick={() => setShowAddSubIpcModal(true)}
                    className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 bg-slate-900 text-amber-400 text-xs font-bold rounded-xl hover:bg-slate-800 transition-colors shadow-sm cursor-pointer"
                  >
                    <Plus size={14} />
                    <span>{lang === 'ar' ? 'مستخلص باطن جديد' : 'New Sub IPC'}</span>
                  </button>
                )}
              </div>

              {/* Active Subcontractor IPC Dossier */}
              {selectedSubIpc && (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-6 space-y-6">
                  {/* Header */}
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
                    <div>
                      <span className="text-[11px] font-mono font-bold text-amber-900 bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
                        SUBCONTRACTOR PAYMENT CERTIFICATE: {selectedSubIpc.ipcNumber}
                      </span>
                      <h2 className="text-base font-black text-slate-900 mt-2">
                        {selectedSubIpc.subcontractorName}
                      </h2>
                      <p className="text-xs text-slate-500 font-semibold mt-0.5">
                        {selectedSubIpc.trade} · {lang === 'ar' ? `الفترة: من ${selectedSubIpc.periodStart} إلى ${selectedSubIpc.periodEnd}` : `Period: from ${selectedSubIpc.periodStart} to ${selectedSubIpc.periodEnd}`}
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
                      <button
                        onClick={() => handleDeleteSubIpc(selectedSubIpc.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-300 text-xs font-bold text-rose-700 hover:bg-rose-50 cursor-pointer"
                      >
                        <Trash2 size={14} />
                        <span>{lang === 'ar' ? 'حذف' : 'Delete'}</span>
                      </button>
                      <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
                        {selectedSubIpc.status === 'paid' ? 'تم الصرف للباطن (Paid)' : selectedSubIpc.status === 'approved' ? 'معتمد للترحيل والتكاليف' : 'مسودة (Draft)'}
                      </span>
                    </div>
                  </div>

                  {/* Reconciliation Panel */}
                  {renderReconciliationPanel(subIpcReconciliationById.get(selectedSubIpc.id), 'sub')}

                  {/* Comparison Dashboard */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                    <div className="bg-amber-50/70 p-4 rounded-xl border border-amber-200 space-y-2">
                      <span className="text-[11px] text-amber-900 font-bold block">{lang === 'ar' ? 'مستحقات مقاول الباطن (صافي التكلفة)' : 'Subcontractor Payable (Net Cost)'}</span>
                      <div className="text-xl font-black text-amber-950 font-mono">
                        {selectedSubIpc.netPayableToSubcontractor.toLocaleString()} SAR
                      </div>
                      <div className="text-[10px] text-amber-800 space-y-0.5 border-t border-amber-200/60 pt-1.5">
                        <div className="flex justify-between">
                          <span>{lang === 'ar' ? 'إجمالي الأعمال المنجزة:' : 'Gross Work:'}</span>
                          <span className="font-mono font-bold">{selectedSubIpc.currentGrossAmount.toLocaleString()} SAR</span>
                        </div>
                        <div className="flex justify-between text-rose-700">
                          <span>{lang === 'ar' ? 'محتجز ضمان الباطن:' : 'Retention:'}</span>
                          <span className="font-mono">- {selectedSubIpc.retentionDeduction.toLocaleString()} SAR</span>
                        </div>
                        <div className="flex justify-between text-rose-700">
                          <span>{lang === 'ar' ? 'خصومات تشوينات/ديزل:' : 'Material deductions:'}</span>
                          <span className="font-mono">- {selectedSubIpc.materialDeductions.toLocaleString()} SAR</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-blue-50/70 p-4 rounded-xl border border-blue-200 space-y-2">
                      <span className="text-[11px] text-blue-900 font-bold block">{lang === 'ar' ? 'إيراد المقاول الرئيسي مع المالك لنفس البنود' : 'Client Revenue for Same Work'}</span>
                      <div className="text-xl font-black text-blue-950 font-mono">
                        {selectedSubIpc.mainContractorRevenueForSameQty.toLocaleString()} SAR
                      </div>
                      <div className="text-[10px] text-blue-800 space-y-0.5 border-t border-blue-200/60 pt-1.5">
                        <div className="flex justify-between">
                          <span>{lang === 'ar' ? 'السعر التعاقدي مع المالك:' : 'Contract rate:'}</span>
                          <span className="font-mono font-bold">{lang === 'ar' ? 'معتمد في مستخلص المالك' : 'Client IPC rate'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{lang === 'ar' ? 'القيمة المكتسبة (EV) للمشروع:' : 'Earned Value (EV):'}</span>
                          <span className="font-mono font-bold">+{selectedSubIpc.mainContractorRevenueForSameQty.toLocaleString()} SAR</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-emerald-50/70 p-4 rounded-xl border border-emerald-200 space-y-2">
                      <span className="text-[11px] text-emerald-900 font-bold block">{lang === 'ar' ? 'هامش ربح المقاول الرئيسي (Gross Margin)' : 'Main Contractor Profit Margin'}</span>
                      <div className="text-xl font-black text-emerald-700 font-mono">
                        +{selectedSubIpc.mainContractorProfitMarginSar.toLocaleString()} SAR
                      </div>
                      <div className="text-[10px] text-emerald-800 space-y-0.5 border-t border-emerald-200/60 pt-1.5">
                        <div className="flex justify-between">
                          <span>{lang === 'ar' ? 'نسبة الهامش الربحي:' : 'Margin percent:'}</span>
                          <span className="font-mono font-bold text-emerald-900">%{selectedSubIpc.mainContractorMarginPercent}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{lang === 'ar' ? 'الأثر على الميزانية:' : 'Budget impact:'}</span>
                          <span className="font-bold text-emerald-700">{lang === 'ar' ? 'إيجابي (وفر تكلفة)' : 'Positive margin'}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Two-Tier Unit Price Table */}
                  {selectedSubIpc.items.length > 0 && (
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <div className="p-3 bg-slate-100 font-bold text-xs text-slate-800 flex items-center justify-between">
                        <span>{lang === 'ar' ? 'جدول مقارنة الأسعار المزدوجة (سعر المالك vs سعر الباطن) لنفس الكميات المنفذة' : 'Two-Tier Unit Rate Comparison'}</span>
                        <span className="text-[11px] text-slate-500 font-mono">Two-Tier Unit Rate Breakdown</span>
                      </div>

                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                          <tr>
                            <th className="p-3 text-right">{lang === 'ar' ? 'بيان البند والعمل المنفذ' : 'Description'}</th>
                            <th className="p-3 text-center">{lang === 'ar' ? 'الوحدة' : 'Unit'}</th>
                            <th className="p-3 text-center">{lang === 'ar' ? 'الكمية المنجزة' : 'Quantity'}</th>
                            <th className="p-3 text-center bg-amber-50/70 text-amber-900 border-x border-amber-200">{lang === 'ar' ? 'سعر الباطن (شراء)' : 'Sub Rate'}</th>
                            <th className="p-3 text-right bg-amber-50/70 text-amber-900">{lang === 'ar' ? 'مستحق الباطن (تكلفة)' : 'Sub Amount'}</th>
                            <th className="p-3 text-center bg-blue-50/70 text-blue-900 border-x border-blue-200">{lang === 'ar' ? 'سعر المالك (بيع)' : 'Client Rate'}</th>
                            <th className="p-3 text-right bg-blue-50/70 text-blue-900">{lang === 'ar' ? 'إيراد المقاول الرئيسي' : 'Client Amount'}</th>
                            <th className="p-3 text-right bg-emerald-50 text-emerald-900">{lang === 'ar' ? 'هامش الربح (SAR)' : 'Margin (SAR)'}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {selectedSubIpc.items.map((item) => (
                            <tr key={item.id} className="hover:bg-slate-50">
                              <td className="p-3 font-semibold text-slate-800 max-w-xs">{item.description}</td>
                              <td className="p-3 text-center text-slate-500 font-mono">{item.unit}</td>
                              <td className="p-3 text-center font-mono font-bold text-slate-900">{item.quantity}</td>
                              <td className="p-3 text-center font-mono font-bold text-amber-800 bg-amber-50/40 border-x border-amber-100">
                                {item.subcontractorRate} SAR
                              </td>
                              <td className="p-3 text-right font-mono font-bold text-amber-900 bg-amber-50/40">
                                {item.subcontractorAmount.toLocaleString()} SAR
                              </td>
                              <td className="p-3 text-center font-mono font-bold text-blue-800 bg-blue-50/40 border-x border-blue-100">
                                {item.mainContractorRate} SAR
                              </td>
                              <td className="p-3 text-right font-mono font-bold text-blue-900 bg-blue-50/40">
                                {item.mainContractorAmount.toLocaleString()} SAR
                              </td>
                              <td className="p-3 text-right font-mono font-black text-emerald-700 bg-emerald-50/40">
                                +{item.marginSar.toLocaleString()} SAR
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* TAB 3: Variation Orders */}
      {activeTab === 'vos' && <ScopeChangeRegister project={project} />}

      {/* MODAL: Add Main Contractor IPC */}
      {showAddIpcModal && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-base font-bold text-slate-900">
                {lang === 'ar' ? 'إضافة مستخلص جديد للمقاول الرئيسي' : 'New Main Contractor IPC'}
              </h3>
              <button onClick={() => setShowAddIpcModal(false)} className="text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveIpc} className="space-y-3 text-xs">
              {saveError && <p role="alert" className="text-rose-700">{saveError}</p>}
              <div>
                <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'رقم المستخلص *' : 'IPC Number *'}</label>
                <input
                  type="text"
                  required
                  value={newIpcNumber}
                  onChange={(e) => setNewIpcNumber(e.target.value)}
                  placeholder="e.g. IPC-01"
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'تاريخ المستخلص *' : 'Certificate Date *'}</label>
                  <input
                    type="date"
                    required
                    value={newCertDate}
                    onChange={(e) => setNewCertDate(e.target.value)}
                    className="w-full px-2 py-1.5 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'بداية الفترة *' : 'Period Start *'}</label>
                  <input
                    type="date"
                    required
                    value={newPeriodStart}
                    onChange={(e) => setNewPeriodStart(e.target.value)}
                    className="w-full px-2 py-1.5 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'نهاية الفترة *' : 'Period End *'}</label>
                  <input
                    type="date"
                    required
                    value={newPeriodEnd}
                    onChange={(e) => setNewPeriodEnd(e.target.value)}
                    className="w-full px-2 py-1.5 border rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'حالة الاعتماد' : 'Status'}</label>
                <select
                  value={newIpcStatus}
                  onChange={(e) => setNewIpcStatus(e.target.value as PaymentCertificate['status'])}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="draft">{lang === 'ar' ? 'مسودة (Draft)' : 'Draft'}</option>
                  <option value="submitted_by_contractor">{lang === 'ar' ? 'مقدم من المقاول' : 'Submitted'}</option>
                  <option value="certified_by_consultant">{lang === 'ar' ? 'معتمد من الاستشاري' : 'Certified'}</option>
                  <option value="approved_by_client">{lang === 'ar' ? 'معتمد من المالك' : 'Approved'}</option>
                  <option value="paid">{lang === 'ar' ? 'تم الصرف (Paid)' : 'Paid'}</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'إجمالي أعمال الفترة (SAR)' : 'Current Gross (SAR)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newCurrentGross}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setNewCurrentGross(val);
                      setNewVatAmount(Number((val * 0.15).toFixed(2)));
                      // Contract deductions are entered explicitly; no invented rate.
                    }}
                    className="w-full px-3 py-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'إجمالي المستخلص السابق (SAR)' : 'Previous Gross (SAR)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newPreviousGross}
                    onChange={(e) => setNewPreviousGross(Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'خصم دفعة مقدمة' : 'Advance Recovery'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newAdvanceDeduction}
                    onChange={(e) => setNewAdvanceDeduction(Number(e.target.value))}
                    className="w-full px-2 py-1.5 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'محتجز ضمان' : 'Retention'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newRetentionDeduction}
                    onChange={(e) => setNewRetentionDeduction(Number(e.target.value))}
                    className="w-full px-2 py-1.5 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'ضريبة (15% VAT)' : 'VAT (15%)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newVatAmount}
                    onChange={(e) => setNewVatAmount(Number(e.target.value))}
                    className="w-full px-2 py-1.5 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setShowAddIpcModal(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  {lang === 'ar' ? 'إلغاء' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-slate-900 text-amber-400 font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {lang === 'ar' ? 'حفظ المستخلص' : 'Save Certificate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Add Subcontractor IPC */}
      {showAddSubIpcModal && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-base font-bold text-slate-900">
                {lang === 'ar' ? 'إضافة مستخلص جديد لمقاول باطن' : 'New Subcontractor IPC'}
              </h3>
              <button onClick={() => setShowAddSubIpcModal(false)} className="text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveSubIpc} className="space-y-3 text-xs">
              {saveError && <p role="alert" className="text-rose-700">{saveError}</p>}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'رقم المستخلص *' : 'IPC Number *'}</label>
                  <input
                    type="text"
                    required
                    value={newSubIpcNumber}
                    onChange={(e) => setNewSubIpcNumber(e.target.value)}
                    placeholder="e.g. SUB-IPC-001"
                    className="w-full px-3 py-2 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'كود الباقة (اختياري)' : 'Package Code'}</label>
                  <input
                    type="text"
                    value={newSubPkgCode}
                    onChange={(e) => setNewSubPkgCode(e.target.value)}
                    placeholder="e.g. SUB-PKG-01"
                    className="w-full px-3 py-2 border rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'اسم مقاول الباطن *' : 'Subcontractor Name *'}</label>
                <input
                  type="text"
                  required
                  value={newSubName}
                  onChange={(e) => setNewSubName(e.target.value)}
                  placeholder="e.g. شركة البنيان"
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'المهنة / نطاق الأعمال *' : 'Trade / Scope *'}</label>
                <input
                  type="text"
                  required
                  value={newSubTrade}
                  onChange={(e) => setNewSubTrade(e.target.value)}
                  placeholder="e.g. أعمال الخرسانات والهياكل"
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'تاريخ المستخلص *' : 'Certificate Date *'}</label>
                  <input
                    type="date"
                    required
                    value={newSubCertDate}
                    onChange={(e) => setNewSubCertDate(e.target.value)}
                    className="w-full px-2 py-1.5 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'بداية الفترة *' : 'Period Start *'}</label>
                  <input
                    type="date"
                    required
                    value={newSubPeriodStart}
                    onChange={(e) => setNewSubPeriodStart(e.target.value)}
                    className="w-full px-2 py-1.5 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'نهاية الفترة *' : 'Period End *'}</label>
                  <input
                    type="date"
                    required
                    value={newSubPeriodEnd}
                    onChange={(e) => setNewSubPeriodEnd(e.target.value)}
                    className="w-full px-2 py-1.5 border rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'حالة الاعتماد' : 'Status'}</label>
                <select
                  value={newSubStatus}
                  onChange={(e) => setNewSubStatus(e.target.value as 'draft' | 'approved' | 'paid')}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="draft">{lang === 'ar' ? 'مسودة (Draft)' : 'Draft'}</option>
                  <option value="approved">{lang === 'ar' ? 'معتمد للترحيل والتكاليف' : 'Approved'}</option>
                  <option value="paid">{lang === 'ar' ? 'تم الصرف (Paid)' : 'Paid'}</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'إجمالي أعمال الفترة للباطن' : 'Sub Current Gross'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newSubCurrentGross}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setNewSubCurrentGross(val);
                      // Retention depends on the actual subcontract, not a default 10%.
                      setNewSubGrossToDate(val);
                    }}
                    className="w-full px-3 py-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'إيراد المقاول الرئيسي لنفس العمل' : 'Main Contractor Revenue'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newSubMainRevenue}
                    onChange={(e) => setNewSubMainRevenue(Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'محتجز ضمان الباطن' : 'Retention'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newSubRetention}
                    onChange={(e) => setNewSubRetention(Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">{lang === 'ar' ? 'خصومات تشوينات/ديزل' : 'Material Deductions'}</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newSubMaterialDeductions}
                    onChange={(e) => setNewSubMaterialDeductions(Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setShowAddSubIpcModal(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  {lang === 'ar' ? 'إلغاء' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-slate-900 text-amber-400 font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {lang === 'ar' ? 'حفظ المستخلص' : 'Save Certificate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

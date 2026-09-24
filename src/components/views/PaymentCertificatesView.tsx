import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import { resolveContractBaseline } from '@/lib/budgetForecastEngine';
import type { Project, PaymentCertificate, SubcontractPackage } from '@/types';
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
  /**
   * Business code of the subcontract package this certificate bills ('SUB-PKG-01'). It is the link
   * used to read that package's CONTRACTUAL retention percent from the database (GAP-019/020); the
   * code is never parsed as a uuid.
   */
  subcontractPackageCode?: string | null;
  grossAmountToDate: number;
  currentGrossAmount: number;
  /** Retention actually withheld on this certificate; checked against the package's contract. */
  retentionDeduction: number;
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
  const [selectedIpcId, setSelectedIpcId] = useState<string>('IPC-03');
  const [selectedSubIpcId, setSelectedSubIpcId] = useState<string>('SUB-IPC-01');
  const [showAddSubIpcModal, setShowAddSubIpcModal] = useState(false);

  // Subcontractor IPCs.
  //
  // GAP-018: SUB-IPC-001 keeps a header (215,000) that disagrees with its own lines (214,400) so the
  // reconciliation surfaces a `mismatch` with the exact delta instead of presenting both as valid.
  // GAP-020: each certificate's retention is the CONTRACTUAL percent of the package it belongs to
  // (SUB-PKG-01 = 10%, SUB-PKG-02 = 5%), not a flat rate applied by the screen.
  // GAP-021: certificates dated on or before the Data Date are actuals; SUB-IPC-003 is a draft claim.
  const [subcontractorIpcs, setSubcontractorIpcs] = useState<SubcontractorIpc[]>([
    {
      id: 'SUB-IPC-01',
      ipcNumber: 'SUB-IPC-001',
      subcontractPackageCode: 'SUB-PKG-01',
      subcontractorName: 'شركة البنيان لأعمال الخرسانات والهياكل',
      trade: 'مقاول باطن - أعمال الهيكل الإنشائي والخرسانات',
      certificateDate: '2026-08-25',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-25',
      status: 'paid',
      grossAmountToDate: 215000,
      // Header gross deliberately 600 SAR above the sum of the lines below: the reconciliation must
      // flag it, never silently accept both figures.
      currentGrossAmount: 215000,
      retentionDeduction: 21500, // 10% contractual retention of SUB-PKG-01
      materialDeductions: 4500, // ديزل وتشوينات
      netPayableToSubcontractor: 189000,
      mainContractorRevenueForSameQty: 323150,
      mainContractorProfitMarginSar: 108750,
      mainContractorMarginPercent: 33.7,
      items: [
        {
          id: 'SUB-IPC-01-L1',
          description: 'خرسانة مسلحة للقواعد والميد الأرضية (CW-002)',
          unit: 'م3',
          quantity: 280,
          subcontractorRate: 380,
          subcontractorAmount: 106400,
          mainContractorRate: 680,
          mainContractorAmount: 190400,
          marginSar: 84000,
        },
        {
          id: 'SUB-IPC-01-L2',
          description: 'حديد تسليح للقواعد والأعمدة (RS-001)',
          unit: 'طن',
          quantity: 45,
          subcontractorRate: 2400,
          subcontractorAmount: 108000,
          mainContractorRate: 2950,
          mainContractorAmount: 132750,
          marginSar: 24750,
        },
      ],
    },
    {
      id: 'SUB-IPC-02',
      ipcNumber: 'SUB-IPC-002',
      subcontractPackageCode: 'SUB-PKG-02',
      subcontractorName: 'شركة الإعمار والمساندة الخرسانية المحدودة',
      trade: 'مقاول باطن مساند - أعمال خرسانات القطاع B',
      certificateDate: '2026-09-08',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-08',
      status: 'approved',
      grossAmountToDate: 19440,
      currentGrossAmount: 19440,
      retentionDeduction: 972, // 5% contractual retention of SUB-PKG-02 (not 10%)
      materialDeductions: 0,
      netPayableToSubcontractor: 18468,
      mainContractorRevenueForSameQty: 34560,
      mainContractorProfitMarginSar: 15120,
      mainContractorMarginPercent: 43.8,
      items: [
        {
          id: 'SUB-IPC-02-L1',
          description: 'خرسانة مسلحة للأعمدة والأسقف - حصة القطاع B (CW-003)',
          unit: 'م3',
          quantity: 48,
          subcontractorRate: 405,
          subcontractorAmount: 19440,
          mainContractorRate: 720,
          mainContractorAmount: 34560,
          marginSar: 15120,
        },
      ],
    },
    {
      id: 'SUB-IPC-03',
      ipcNumber: 'SUB-IPC-003',
      subcontractPackageCode: 'SUB-PKG-01',
      subcontractorName: 'شركة البنيان لأعمال الخرسانات والهياكل',
      trade: 'مقاول باطن - أعمال الهيكل الإنشائي والخرسانات',
      certificateDate: '2026-09-11',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-10',
      // Draft claim awaiting review: excluded from paid/approved subcontractor totals (GAP-021).
      status: 'draft',
      grossAmountToDate: 240600,
      currentGrossAmount: 25600,
      retentionDeduction: 2560, // 10% contractual retention of SUB-PKG-01
      materialDeductions: 0,
      netPayableToSubcontractor: 23040,
      mainContractorRevenueForSameQty: 46080,
      mainContractorProfitMarginSar: 20480,
      mainContractorMarginPercent: 44.4,
      items: [
        {
          id: 'SUB-IPC-03-L1',
          description: 'خرسانة مسلحة للأعمدة والأسقف - حصة القطاع A (CW-003)',
          unit: 'م3',
          quantity: 64,
          subcontractorRate: 400,
          subcontractorAmount: 25600,
          mainContractorRate: 720,
          mainContractorAmount: 46080,
          marginSar: 20480,
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

  // List of Payment Certificates.
  //
  // GAP-018: every certificate that has itemised lines carries a header whose current and cumulative
  // gross equal the sum of those lines; the one certificate whose header disagrees with its lines is
  // left disagreeing on purpose so the reconciliation status reports `mismatch` instead of hiding it.
  // GAP-021: certificates dated on or before the governed Data Date (2026-09-13) are the actuals;
  // the fourth one is a Q4 forecast in `draft` and is excluded from certified totals.
  const [certificates, setCertificates] = useState<PaymentCertificate[]>([
    {
      id: 'IPC-01',
      ipcNumber: 'IPC-01',
      certificateDate: '2026-07-31',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      status: 'paid',
      grossAmountToDate: 102150,
      previousGrossAmount: 0,
      currentGrossAmount: 102150,
      advancePaymentDeduction: 10215, // 10% of the current gross
      retentionMoneyDeduction: 5107.5, // 5% main-contract retention
      penaltyDeduction: 0,
      vatAmount: 15322.5, // 15%
      netPayableAmount: 102150,
      items: [
        {
          id: 'IPC-01-L1',
          boqItemId: 'boq-01',
          boqCode: 'EW-001',
          description: 'حفريات الموقع العام ونقل المخلفات',
          unit: 'm3',
          contractQuantity: 1200,
          unitRateSar: 35,
          previousQuantity: 0,
          currentQuantity: 1200,
          cumulativeQuantity: 1200,
          cumulativeAmountSar: 42000,
          currentAmountSar: 42000,
        },
        {
          id: 'IPC-01-L2',
          boqItemId: 'boq-02',
          boqCode: 'EW-002',
          description: 'أعمال الردم بطبقات ورش المياه والدمك',
          unit: 'm3',
          contractQuantity: 450,
          unitRateSar: 45,
          previousQuantity: 0,
          currentQuantity: 450,
          cumulativeQuantity: 450,
          cumulativeAmountSar: 20250,
          currentAmountSar: 20250,
        },
        {
          id: 'IPC-01-L3',
          boqItemId: 'boq-03',
          boqCode: 'CW-001',
          description: 'خرسانة نظافة عادية أسفل القواعد',
          unit: 'm3',
          contractQuantity: 95,
          unitRateSar: 420,
          previousQuantity: 0,
          currentQuantity: 95,
          cumulativeQuantity: 95,
          cumulativeAmountSar: 39900,
          currentAmountSar: 39900,
        },
      ],
    },
    {
      id: 'IPC-02',
      ipcNumber: 'IPC-02',
      certificateDate: '2026-08-31',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      status: 'paid',
      grossAmountToDate: 425300,
      previousGrossAmount: 102150,
      currentGrossAmount: 323150,
      advancePaymentDeduction: 32315,
      retentionMoneyDeduction: 16157.5,
      penaltyDeduction: 0,
      vatAmount: 48472.5,
      netPayableAmount: 323150,
      items: [
        {
          id: 'IPC-02-L1',
          boqItemId: 'boq-01',
          boqCode: 'EW-001',
          description: 'حفريات الموقع العام ونقل المخلفات',
          unit: 'm3',
          contractQuantity: 1200,
          unitRateSar: 35,
          previousQuantity: 1200,
          currentQuantity: 0,
          cumulativeQuantity: 1200,
          cumulativeAmountSar: 42000,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-02-L2',
          boqItemId: 'boq-02',
          boqCode: 'EW-002',
          description: 'أعمال الردم بطبقات ورش المياه والدمك',
          unit: 'm3',
          contractQuantity: 450,
          unitRateSar: 45,
          previousQuantity: 450,
          currentQuantity: 0,
          cumulativeQuantity: 450,
          cumulativeAmountSar: 20250,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-02-L3',
          boqItemId: 'boq-03',
          boqCode: 'CW-001',
          description: 'خرسانة نظافة عادية أسفل القواعد',
          unit: 'm3',
          contractQuantity: 95,
          unitRateSar: 420,
          previousQuantity: 95,
          currentQuantity: 0,
          cumulativeQuantity: 95,
          cumulativeAmountSar: 39900,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-02-L4',
          boqItemId: 'boq-04',
          boqCode: 'CW-002',
          description: 'خرسانة مسلحة للقواعد والميد الأرضية',
          unit: 'm3',
          contractQuantity: 280,
          unitRateSar: 680,
          previousQuantity: 0,
          currentQuantity: 280,
          cumulativeQuantity: 280,
          cumulativeAmountSar: 190400,
          currentAmountSar: 190400,
        },
        {
          id: 'IPC-02-L5',
          boqItemId: 'boq-05',
          boqCode: 'RS-001',
          description: 'حديد تسليح للقواعد والأعمدة',
          unit: 'ton',
          contractQuantity: 45,
          unitRateSar: 2950,
          previousQuantity: 0,
          currentQuantity: 45,
          cumulativeQuantity: 45,
          cumulativeAmountSar: 132750,
          currentAmountSar: 132750,
        }
      ],
    },
    {
      id: 'IPC-03',
      ipcNumber: 'IPC-03',
      certificateDate: '2026-09-10',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-10',
      status: 'certified_by_consultant',
      grossAmountToDate: 505940,
      previousGrossAmount: 425300,
      currentGrossAmount: 80640,
      advancePaymentDeduction: 8064,
      retentionMoneyDeduction: 4032,
      penaltyDeduction: 0,
      vatAmount: 12096,
      netPayableAmount: 80640,
      items: [
        {
          id: 'IPC-03-L1',
          boqItemId: 'boq-01',
          boqCode: 'EW-001',
          description: 'حفريات الموقع العام ونقل المخلفات',
          unit: 'm3',
          contractQuantity: 1200,
          unitRateSar: 35,
          previousQuantity: 1200,
          currentQuantity: 0,
          cumulativeQuantity: 1200,
          cumulativeAmountSar: 42000,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-03-L2',
          boqItemId: 'boq-02',
          boqCode: 'EW-002',
          description: 'أعمال الردم بطبقات ورش المياه والدمك',
          unit: 'm3',
          contractQuantity: 450,
          unitRateSar: 45,
          previousQuantity: 450,
          currentQuantity: 0,
          cumulativeQuantity: 450,
          cumulativeAmountSar: 20250,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-03-L3',
          boqItemId: 'boq-03',
          boqCode: 'CW-001',
          description: 'خرسانة نظافة عادية أسفل القواعد',
          unit: 'm3',
          contractQuantity: 95,
          unitRateSar: 420,
          previousQuantity: 95,
          currentQuantity: 0,
          cumulativeQuantity: 95,
          cumulativeAmountSar: 39900,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-03-L4',
          boqItemId: 'boq-04',
          boqCode: 'CW-002',
          description: 'خرسانة مسلحة للقواعد والميد الأرضية',
          unit: 'm3',
          contractQuantity: 280,
          unitRateSar: 680,
          previousQuantity: 280,
          currentQuantity: 0,
          cumulativeQuantity: 280,
          cumulativeAmountSar: 190400,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-03-L5',
          boqItemId: 'boq-05',
          boqCode: 'RS-001',
          description: 'حديد تسليح للقواعد والأعمدة',
          unit: 'ton',
          contractQuantity: 45,
          unitRateSar: 2950,
          previousQuantity: 45,
          currentQuantity: 0,
          cumulativeQuantity: 45,
          cumulativeAmountSar: 132750,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-03-L6',
          boqItemId: 'boq-06',
          boqCode: 'CW-003',
          description: 'خرسانة مسلحة للأعمدة والأسقف لجميع الأدوار',
          unit: 'm3',
          contractQuantity: 650,
          unitRateSar: 720,
          previousQuantity: 0,
          currentQuantity: 112,
          cumulativeQuantity: 112,
          cumulativeAmountSar: 80640,
          currentAmountSar: 80640,
        }
      ],
    },
    {
      id: 'IPC-04',
      ipcNumber: 'IPC-04',
      certificateDate: '2026-12-31',
      periodStart: '2026-10-01',
      periodEnd: '2026-12-31',
      // Forecast only: a draft for the fourth quarter, dated after the Data Date, so it is reported
      // as a projection and stays out of the certified / paid totals (GAP-021).
      status: 'draft',
      grossAmountToDate: 885940,
      previousGrossAmount: 505940,
      currentGrossAmount: 380000,
      advancePaymentDeduction: 38000,
      retentionMoneyDeduction: 19000,
      penaltyDeduction: 0,
      vatAmount: 57000,
      netPayableAmount: 380000,
      items: [
        {
          id: 'IPC-04-L1',
          boqItemId: 'boq-01',
          boqCode: 'EW-001',
          description: 'حفريات الموقع العام ونقل المخلفات',
          unit: 'm3',
          contractQuantity: 1200,
          unitRateSar: 35,
          previousQuantity: 1200,
          currentQuantity: 0,
          cumulativeQuantity: 1200,
          cumulativeAmountSar: 42000,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-04-L2',
          boqItemId: 'boq-02',
          boqCode: 'EW-002',
          description: 'أعمال الردم بطبقات ورش المياه والدمك',
          unit: 'm3',
          contractQuantity: 450,
          unitRateSar: 45,
          previousQuantity: 450,
          currentQuantity: 0,
          cumulativeQuantity: 450,
          cumulativeAmountSar: 20250,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-04-L3',
          boqItemId: 'boq-03',
          boqCode: 'CW-001',
          description: 'خرسانة نظافة عادية أسفل القواعد',
          unit: 'm3',
          contractQuantity: 95,
          unitRateSar: 420,
          previousQuantity: 95,
          currentQuantity: 0,
          cumulativeQuantity: 95,
          cumulativeAmountSar: 39900,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-04-L4',
          boqItemId: 'boq-04',
          boqCode: 'CW-002',
          description: 'خرسانة مسلحة للقواعد والميد الأرضية',
          unit: 'm3',
          contractQuantity: 280,
          unitRateSar: 680,
          previousQuantity: 280,
          currentQuantity: 0,
          cumulativeQuantity: 280,
          cumulativeAmountSar: 190400,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-04-L5',
          boqItemId: 'boq-05',
          boqCode: 'RS-001',
          description: 'حديد تسليح للقواعد والأعمدة',
          unit: 'ton',
          contractQuantity: 45,
          unitRateSar: 2950,
          previousQuantity: 45,
          currentQuantity: 0,
          cumulativeQuantity: 45,
          cumulativeAmountSar: 132750,
          currentAmountSar: 0,
        },
        {
          id: 'IPC-04-L6',
          boqItemId: 'boq-06',
          boqCode: 'CW-003',
          description: 'خرسانة مسلحة للأعمدة والأسقف لجميع الأدوار (المتوقع للربع الرابع)',
          unit: 'm3',
          contractQuantity: 650,
          unitRateSar: 720,
          previousQuantity: 112,
          currentQuantity: 200,
          cumulativeQuantity: 312,
          cumulativeAmountSar: 224640,
          currentAmountSar: 144000,
        },
        {
          id: 'IPC-04-L7',
          boqItemId: 'boq-07',
          boqCode: 'MS-001',
          description: 'مباني بلك إسمنتي معزول وخفيف للجدران (المتوقع للربع الرابع)',
          unit: 'm2',
          contractQuantity: 3200,
          unitRateSar: 95,
          previousQuantity: 0,
          currentQuantity: 1600,
          cumulativeQuantity: 1600,
          cumulativeAmountSar: 152000,
          currentAmountSar: 152000,
        },
        {
          id: 'IPC-04-L8',
          boqItemId: 'boq-09',
          boqCode: 'PL-001',
          description: 'أعمال اللياسة الداخلية والخارجية (المتوقع للربع الرابع)',
          unit: 'm2',
          contractQuantity: 6400,
          unitRateSar: 42,
          previousQuantity: 0,
          currentQuantity: 2000,
          cumulativeQuantity: 2000,
          cumulativeAmountSar: 84000,
          currentAmountSar: 84000,
        }
      ],
    },
  ]);

  const selectedIpc = useMemo(() => {
    return certificates.find((c) => c.id === selectedIpcId) || certificates[certificates.length - 1];
  }, [certificates, selectedIpcId]);

  // ---------------------------------------------------------------------------
  // Commercial controls: reconciliation (GAP-018), contractual retention (GAP-020)
  // and chronology against the governed Data Date (GAP-021).
  // ---------------------------------------------------------------------------

  /** The cutoff that separates an actual certificate from a forecast or a pending claim. */
  const dataDate = project?.data_date || DEFAULT_DATA_DATE;

  /**
   * Subcontract packages are read from the relational tables so a subcontractor certificate can be
   * checked against the retention percent its own contract states (GAP-019/020).
   */
  const [subcontractPackages, setSubcontractPackages] = useState<SubcontractPackage[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const packages = await loadSubcontractPackages(project?.id);
      if (!cancelled) setSubcontractPackages(packages);
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

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

  // Portfolio totals respect the chronology: only certificates that count as actual at the Data Date
  // are certified. Drafts and pending claims are reported separately as forecast (GAP-021), so the
  // former `max(grossAmountToDate)` over every row — including future-dated ones — is gone.
  const ipcSummary = useMemo(() => summarizeCertificates(ipcReconciliations, dataDate), [ipcReconciliations, dataDate]);
  const subIpcSummary = useMemo(
    () => summarizeCertificates(subIpcReconciliations, dataDate),
    [subIpcReconciliations, dataDate],
  );

  const totalCertifiedGross = ipcSummary.certifiedGrossToDate;
  /** Retention actually withheld on certificates that count as actual — summed, never a flat 5%. */
  const totalRetentionWithheld = ipcReconciliations
    .filter((rec) => rec.chronology.countsAsActual)
    .reduce((sum, rec) => sum + rec.deductions.retention, 0);
  const totalSubRetentionWithheld = subIpcReconciliations
    .filter((rec) => rec.chronology.countsAsActual)
    .reduce((sum, rec) => sum + rec.deductions.retention, 0);

  /** A reconciliation with the optional contractual-retention fields of a subcontractor certificate. */
  type CertificateRec = CertificateReconciliation & {
    retentionMatchesContract?: boolean | null;
    contractRetentionPercent?: number | null;
  };

  /** Badge: does the certificate header agree with its own itemised lines? (GAP-018) */
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

  /** Badge: where the record sits against the governed Data Date (GAP-021). */
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

  /**
   * The reconciliation panel (GAP-018): header against itemised lines for the current, cumulative,
   * previous and net figures, plus the retention actually applied against the contractual percent.
   * Every disagreement is listed — a mismatch is never hidden behind the header figure.
   */
  const renderReconciliationPanel = (rec: CertificateRec | undefined, titleKey: 'ipc' | 'sub') => {
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
        // A subcontractor certificate's lines carry current amounts only, so its cumulative side is
        // declared not itemized instead of being compared against a sum the lines do not contain.
        linesValue: rec.cumulativeStatus === 'not_itemized' ? notItemized : rec.lineCumulativeSum.toLocaleString(),
        ok: rec.cumulativeStatus === 'not_itemized' ? null : rec.cumulativeStatus === 'balanced',
      },
      {
        label: ar ? 'المعتمد في المستخلص السابق (Previous)' : 'Previously certified',
        headerValue: rec.headerPrevious === null ? '—' : rec.headerPrevious.toLocaleString(),
        linesValue: rec.derivedPrevious === null ? notItemized : rec.derivedPrevious.toLocaleString(),
        ok: rec.previousStatus === 'not_itemized' ? null : rec.previousStatus === 'balanced',
      },
      {
        label: ar ? 'صافي المستحق بعد الاستقطاعات (Net)' : 'Net payable after deductions',
        headerValue: rec.netHeader === null ? '—' : rec.netHeader.toLocaleString(),
        linesValue: rec.netDerived === null ? '—' : rec.netDerived.toLocaleString(),
        ok: rec.netHeader !== null && rec.netDerived !== null ? rec.netStatus === 'balanced' : null,
      },
      {
        label:
          titleKey === 'sub'
            ? ar
              ? 'نسبة الضمان المطبقة مقابل النسبة التعاقدية للباقة'
              : 'Applied retention vs the package contractual percent'
            : ar
              ? 'نسبة الضمان المطبقة على الإجمالي'
              : 'Applied retention on gross',
        headerValue: rec.appliedRetentionPercent === null ? (ar ? 'غير محددة' : 'Unknown') : `${rec.appliedRetentionPercent}%`,
        linesValue:
          rec.contractRetentionPercent === null || rec.contractRetentionPercent === undefined
            ? ar
              ? 'غير منصوص عليها (N/A)'
              : 'Not stated (N/A)'
            : `${rec.contractRetentionPercent}%`,
        ok: rec.retentionMatchesContract === undefined ? null : rec.retentionMatchesContract,
      },
    ];
    const mismatches = ar ? rec.mismatchesAr : rec.mismatchesEn;

    return (
      <div
        className={`rounded-xl border p-4 space-y-3 ${
          rec.status === 'mismatch' ? 'border-rose-300 bg-rose-50/50' : 'border-slate-200 bg-slate-50/70'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle
              size={16}
              className={rec.status === 'mismatch' ? 'text-rose-600' : rec.status === 'balanced' ? 'text-emerald-600' : 'text-slate-400'}
            />
            <span className="text-xs font-black text-slate-900">
              {ar ? 'مطابقة الترويسة مع البنود التفصيلية (Reconciliation)' : 'Header vs itemised lines (Reconciliation)'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {renderReconciliationBadge(rec)}
            {renderChronologyBadge(rec)}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-white/70 text-slate-600 border-b border-slate-200">
              <tr>
                <th className="p-2 text-right font-bold">{ar ? 'البند المالي' : 'Financial line'}</th>
                <th className="p-2 text-center font-bold">{ar ? 'قيمة الترويسة' : 'Header value'}</th>
                <th className="p-2 text-center font-bold">{ar ? 'مجموع البنود' : 'Sum of lines'}</th>
                <th className="p-2 text-center font-bold">{ar ? 'الحالة' : 'Status'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 font-mono">
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="p-2 text-right font-sans font-semibold text-slate-700">{row.label}</td>
                  <td className="p-2 text-center font-bold text-slate-900">{row.headerValue}</td>
                  <td className="p-2 text-center font-bold text-slate-700">{row.linesValue}</td>
                  <td className="p-2 text-center font-sans font-black">
                    {row.ok === null ? (
                      <span className="text-slate-400">{ar ? 'لا يمكن المطابقة' : 'Not reconcilable'}</span>
                    ) : row.ok ? (
                      <span className="text-emerald-700">{ar ? 'متطابق' : 'Balanced'}</span>
                    ) : (
                      <span className="text-rose-700">{ar ? 'فرق' : 'Mismatch'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-[11px] text-slate-600 space-y-1">
          <div>
            {ar ? 'القيمة المدعومة بالبنود (المعتمدة للعرض): ' : 'Value supported by the lines (presented): '}
            <span className="font-mono font-bold text-slate-900">
              {rec.reconciledCurrent.toLocaleString()} SAR ({ar ? 'الفترة' : 'current'}) ·{' '}
              {rec.reconciledCumulative.toLocaleString()} SAR ({ar ? 'تراكمي' : 'cumulative'})
            </span>
          </div>
          <div>
            {ar ? 'تاريخ البيانات الحاكم: ' : 'Governing Data Date: '}
            <span className="font-mono font-bold text-slate-900">{rec.chronology.dataDate}</span>
            {rec.additions.total > 0 && (
              <>
                {' · '}
                {ar ? 'الإضافات المحتسبة في الصافي (ضريبة القيمة المضافة): ' : 'Additions included in the net (VAT): '}
                <span className="font-mono font-bold text-slate-900">{rec.additions.total.toLocaleString()} SAR</span>
              </>
            )}
          </div>
          <div>
            {ar ? 'مجموع المستقطعات المحتسبة: ' : 'Total deductions applied: '}
            <span className="font-mono font-bold text-slate-900">{rec.deductions.total.toLocaleString()} SAR</span>
          </div>
        </div>

        {mismatches.length > 0 && (
          <div className="rounded-lg border border-rose-300 bg-white p-2.5 space-y-1">
            <span className="text-[11px] font-black text-rose-800 block">
              {ar ? 'الفروقات المرصودة (لا يتم إخفاؤها):' : 'Detected differences (never hidden):'}
            </span>
            <ul className="list-disc pr-5 text-[11px] text-rose-800 space-y-0.5">
              {mismatches.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {!rec.chronology.countsAsActual && rec.chronology.noteAr && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-[11px] font-semibold text-amber-900">
            {ar ? rec.chronology.noteAr : rec.chronology.noteEn}
          </div>
        )}
      </div>
    );
  };

  // Contract value is shown as recorded, without adding VO exposure or claiming an approved revision.
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

      {activeTab !== 'vos' && (ipcSummary.mismatchedCount > 0 || ipcSummary.contradictionsCount > 0 || subIpcSummary.mismatchedCount > 0 || subIpcSummary.contradictionsCount > 0) && (
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
                  {renderReconciliationBadge(ipcReconciliationById.get(cert.id))}
                  {renderChronologyBadge(ipcReconciliationById.get(cert.id))}
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
                    {/* The percent shown is the one this certificate actually applied, not a fixed rate. */}
                    <span>
                      {lang === 'ar' ? 'محتجز ضمان الأعمال' : 'Retention Money'} (
                      {ipcReconciliationById.get(selectedIpc.id)?.appliedRetentionPercent ??
                        (lang === 'ar' ? 'غير محدد' : 'unknown')}
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

              {/* Header vs lines reconciliation (GAP-018) and Data Date chronology (GAP-021) */}
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
                    {renderReconciliationBadge(subIpcReconciliationById.get(sub.id))}
                    {renderChronologyBadge(subIpcReconciliationById.get(sub.id))}
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

                {/* Header vs lines reconciliation, contractual retention (GAP-018/020) and
                    Data Date chronology (GAP-021) for this subcontractor certificate */}
                {renderReconciliationPanel(subIpcReconciliationById.get(currentSubIpc.id), 'sub')}

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

      {activeTab === 'vos' && <ScopeChangeRegister project={project} />}
    </div>
  );
}

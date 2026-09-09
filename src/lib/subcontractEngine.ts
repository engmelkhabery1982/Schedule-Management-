import type { SubcontractPackage, ProgressUpdate, Activity, BoqItem, SubcontractBoqItem } from '@/types';

export const DEFAULT_SUBCONTRACTS: SubcontractPackage[] = [
  {
    id: 'SUB-PKG-01',
    subcontractNumber: 'SUB-CON-001',
    subcontractorName: 'شركة البنيان لأعمال الخرسانات والهياكل',
    contactPerson: 'م. أحمد الشمري',
    phone: '+966 50 123 4567',
    trade: 'مقاول باطن رئيسي - أعمال الهيكل الإنشائي والخرسانات (القطاع A)',
    contractDate: '2026-09-15',
    scopeDescription: 'تنفيذ أعمال النجارة والحدادة والصب ومعالجة الخرسانة للأعمدة والأسقف واللبشة بالقطاع A والمبنى الرئيسي.',
    status: 'active',
    totalSubcontractValueSar: 642000,
    totalClientEquivalentValueSar: 910500,
    totalExpectedProfitSar: 268500,
    profitMarginPercent: 29.5,
    retentionPercent: 10,
    items: [
      {
        id: 'SUB-ITM-01',
        subcontractId: 'SUB-PKG-01',
        boqCode: '02.01',
        description: 'خرسانة مسلحة عيار C35 للأساسات واللبشة (مصنعيات وصب)',
        unit: 'م3',
        assignedQuantity: 1200,
        subcontractRateSar: 350,
        subcontractTotalSar: 420000,
        clientRateSar: 480,
        clientTotalSar: 576000,
        expectedMarginSar: 156000,
        expectedMarginPercent: 27.1,
        linkedActivityCode: 'ACT-02',
        executedQuantity: 1200,
        zoneOrScope: 'اللبشة والأساسات المركزية',
        quotaPercent: 100,
      },
      {
        id: 'SUB-ITM-02',
        subcontractId: 'SUB-PKG-01',
        boqCode: '02.03',
        description: 'خرسانة مسلحة للأعمدة وجدران القص (القطاع A)',
        unit: 'م3',
        assignedQuantity: 250,
        subcontractRateSar: 380,
        subcontractTotalSar: 95000,
        clientRateSar: 550,
        clientTotalSar: 137500,
        expectedMarginSar: 42500,
        expectedMarginPercent: 30.9,
        linkedActivityCode: 'ACT-03',
        executedQuantity: 220,
        zoneOrScope: 'القطاع A (Zone A - البرج الرئيسي)',
        quotaPercent: 71.4,
      },
      {
        id: 'SUB-ITM-03',
        subcontractId: 'SUB-PKG-01',
        boqCode: '02.04',
        description: 'خرسانة مسلحة للأسقف والجسور سابقة الإجهاد (حصة القطاع A)',
        unit: 'م3',
        assignedQuantity: 240,
        subcontractRateSar: 370,
        subcontractTotalSar: 88800,
        clientRateSar: 590,
        clientTotalSar: 141600,
        expectedMarginSar: 52800,
        expectedMarginPercent: 37.3,
        linkedActivityCode: 'ACT-05',
        executedQuantity: 110,
        zoneOrScope: 'سقف الأرضي والأول (القطاع A)',
        quotaPercent: 66.7,
      },
    ],
  },
  {
    id: 'SUB-PKG-02',
    subcontractNumber: 'SUB-CON-002',
    subcontractorName: 'شركة الإعمار والمساندة الخرسانية المحدودة',
    contactPerson: 'م. خالد الدوسري',
    phone: '+966 50 987 1122',
    trade: 'مقاول باطن مساند - أعمال خرسانات القطاع B والملحقات',
    contractDate: '2026-10-05',
    scopeDescription: 'تنفيذ أعمال الخرسانة المسلحة للأعمدة والأسقف للقطاع B ومبنى الخدمات لتسريع الجدول الزمني.',
    status: 'active',
    totalSubcontractValueSar: 84100,
    totalClientEquivalentValueSar: 125800,
    totalExpectedProfitSar: 41700,
    profitMarginPercent: 33.1,
    retentionPercent: 10,
    items: [
      {
        id: 'SUB-ITM-02B',
        subcontractId: 'SUB-PKG-02',
        boqCode: '02.03',
        description: 'خرسانة مسلحة للأعمدة وجدران القص (القطاع B ومبنى الخدمات)',
        unit: 'م3',
        assignedQuantity: 100,
        subcontractRateSar: 385,
        subcontractTotalSar: 38500,
        clientRateSar: 550,
        clientTotalSar: 55000,
        expectedMarginSar: 16500,
        expectedMarginPercent: 30.0,
        linkedActivityCode: 'ACT-03',
        executedQuantity: 60,
        zoneOrScope: 'القطاع B (Zone B - مبنى الخدمات)',
        quotaPercent: 28.6,
      },
      {
        id: 'SUB-ITM-03B',
        subcontractId: 'SUB-PKG-02',
        boqCode: '02.04',
        description: 'خرسانة مسلحة للأسقف والجسور (حصة القطاع B ومبنى الخدمات)',
        unit: 'م3',
        assignedQuantity: 120,
        subcontractRateSar: 380,
        subcontractTotalSar: 45600,
        clientRateSar: 590,
        clientTotalSar: 70800,
        expectedMarginSar: 25200,
        expectedMarginPercent: 35.6,
        linkedActivityCode: 'ACT-05',
        executedQuantity: 30,
        zoneOrScope: 'سقف الدور الأول والملحق (القطاع B)',
        quotaPercent: 33.3,
      },
    ],
  },
  {
    id: 'SUB-PKG-03',
    subcontractNumber: 'SUB-CON-003',
    subcontractorName: 'مؤسسة الدقة لأعمال التكييف ومجاري الهواء (HVAC)',
    contactPerson: 'م. فهد القحطاني',
    phone: '+966 55 987 6543',
    trade: 'مقاول باطن كهروميكانيك - تصنيع وتركيب HVAC & Ducting',
    contractDate: '2026-10-01',
    scopeDescription: 'توريد وتصنيع وتركيب مجاري الهواء والدكت والعوازل لوحدات التكييف VRF.',
    status: 'active',
    totalSubcontractValueSar: 201800,
    totalClientEquivalentValueSar: 305800,
    totalExpectedProfitSar: 104000,
    profitMarginPercent: 34.0,
    retentionPercent: 10,
    items: [
      {
        id: 'SUB-ITM-04',
        subcontractId: 'SUB-PKG-03',
        boqCode: '04.01',
        description: 'توريد وتركيب دكت الصاج المجلفن والعوازل الحرارية والصوتية',
        unit: 'م2',
        assignedQuantity: 1800,
        subcontractRateSar: 95,
        subcontractTotalSar: 171000,
        clientRateSar: 145,
        clientTotalSar: 261000,
        expectedMarginSar: 90000,
        expectedMarginPercent: 34.5,
        linkedActivityCode: 'ACT-10',
        executedQuantity: 450,
        zoneOrScope: 'كامل المبنى (الأدوار 1-4)',
        quotaPercent: 100,
      },
      {
        id: 'SUB-ITM-05',
        subcontractId: 'SUB-PKG-03',
        boqCode: '04.02',
        description: 'تركيب مخارج وموزعات الهواء (Diffusers & Grilles) والمخمدات',
        unit: 'نقطة',
        assignedQuantity: 140,
        subcontractRateSar: 220,
        subcontractTotalSar: 30800,
        clientRateSar: 320,
        clientTotalSar: 44800,
        expectedMarginSar: 14000,
        expectedMarginPercent: 31.3,
        linkedActivityCode: 'ACT-10',
        executedQuantity: 25,
        zoneOrScope: 'مخارج الهواء للدور الأرضي والأول',
        quotaPercent: 100,
      },
    ],
  },
  {
    id: 'SUB-PKG-04',
    subcontractNumber: 'SUB-CON-004',
    subcontractorName: 'شركة البلاط والتشطيبات الفاخرة',
    contactPerson: 'م. سليم منصور',
    phone: '+966 54 321 0987',
    trade: 'مقاول باطن - أعمال البورسلان والرخام والتشطيبات',
    contractDate: '2026-10-15',
    scopeDescription: 'أعمال تركيب أرضيات وجدران البورسلان والجرانيت مع الغراء والترويبة.',
    status: 'active',
    totalSubcontractValueSar: 143000,
    totalClientEquivalentValueSar: 220000,
    totalExpectedProfitSar: 77000,
    profitMarginPercent: 35.0,
    retentionPercent: 10,
    items: [
      {
        id: 'SUB-ITM-06',
        subcontractId: 'SUB-PKG-04',
        boqCode: '03.02',
        description: 'توريد وتركيب بلاط بورسلان للأرضيات عالي المقاومة 60×60 سم',
        unit: 'م2',
        assignedQuantity: 2200,
        subcontractRateSar: 65,
        subcontractTotalSar: 143000,
        clientRateSar: 100,
        clientTotalSar: 220000,
        expectedMarginSar: 77000,
        expectedMarginPercent: 35.0,
        linkedActivityCode: 'ACT-09',
        executedQuantity: 300,
        zoneOrScope: 'صالات الاستقبال والممرات والمكاتب',
        quotaPercent: 100,
      },
    ],
  },
];

const STORAGE_KEY = 'construction_subcontracts_data';

export function getSubcontractPackages(projectId?: string): SubcontractPackage[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}_${projectId || 'default'}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.error('Failed to load subcontracts from localStorage', e);
  }
  return DEFAULT_SUBCONTRACTS;
}

export function saveSubcontractPackages(packages: SubcontractPackage[], projectId?: string): void {
  try {
    localStorage.setItem(`${STORAGE_KEY}_${projectId || 'default'}`, JSON.stringify(packages));
  } catch (e) {
    console.error('Failed to save subcontracts to localStorage', e);
  }
}

export interface SubcontractorPerformanceSummary {
  packageId: string;
  subcontractNumber: string;
  subcontractorName: string;
  trade: string;
  contractValueSar: number;
  clientEquivalentValueSar: number;
  totalExecutedCostSar: number;     // AC of Subcontractor (مستحق مقاول الباطن)
  totalClientEarnedValueSar: number; // EV with Client (إيراد المقاول الرئيسي المكتسب من المالك)
  grossProfitSar: number;            // هامش ربح المقاول الرئيسي
  marginPercent: number;
  retentionWithheldSar: number;      // مستقطعات ضمان الأعمال 10%
  netPayableSar: number;             // صافي المستحق للدفع
  physicalProgressPercent: number;
  itemsCount: number;
  activeItems: {
    itemId: string;
    boqCode: string;
    description: string;
    unit: string;
    assignedQuantity: number;
    executedQuantity: number;
    subcontractRate: number;
    clientRate: number;
    subcontractCostSar: number;
    clientEarnedSar: number;
    marginSar: number;
    progressPct: number;
    zoneOrScope?: string;
    quotaPercent?: number;
  }[];
}

export interface SharedBoqItemSplit {
  boqCode: string;
  description: string;
  unit: string;
  totalBoqQuantity: number;
  clientRateSar: number;
  clientTotalBudgetSar: number;
  subcontractorsCount: number;
  totalAssignedToSubs: number;
  totalExecutedBySubs: number;
  overallItemProgressPct: number;
  weightedSubcontractRate: number; // متوسط سعر الشراء المرجح
  totalSubcontractCostSar: number; // إجمالي تكلفة الباطن الفعلية AC
  totalClientEarnedSar: number;    // إجمالي إيراد المالك EV
  totalRealizedMarginSar: number;  // إجمالي هامش الربح المحقق
  marginPercent: number;
  allocations: {
    packageId: string;
    subcontractNumber: string;
    subcontractorName: string;
    zoneOrScope: string;
    assignedQty: number;
    executedQty: number;
    remainingQty: number;
    quotaPercent: number;
    subcontractRate: number;
    clientRate: number;
    subcontractCostSar: number;
    clientEarnedSar: number;
    marginSar: number;
    progressPct: number;
  }[];
}

export function calculateSharedBoqItemsMatrix(
  packages: SubcontractPackage[],
  boqItems: BoqItem[]
): SharedBoqItemSplit[] {
  // Collect all items across packages grouped by boqCode
  const mapByBoq = new Map<string, { pkg: SubcontractPackage; itm: SubcontractBoqItem }[]>();

  packages.forEach((pkg) => {
    pkg.items.forEach((itm) => {
      const code = itm.boqCode;
      if (!mapByBoq.has(code)) {
        mapByBoq.set(code, []);
      }
      mapByBoq.get(code)!.push({ pkg, itm });
    });
  });

  const results: SharedBoqItemSplit[] = [];

  mapByBoq.forEach((allocationsList, boqCode) => {
    const mainBoq = boqItems.find((b) => b.code === boqCode);
    const firstItm = allocationsList[0].itm;
    const description = mainBoq?.description || firstItm.description;
    const unit = mainBoq?.unit || firstItm.unit;
    const totalBoqQuantity = mainBoq?.quantity || allocationsList.reduce((s, x) => s + x.itm.assignedQuantity, 0);
    const clientRateSar = mainBoq?.unit_price || firstItm.clientRateSar;
    const clientTotalBudgetSar = totalBoqQuantity * clientRateSar;

    let totalAssigned = 0;
    let totalExecuted = 0;
    let totalSubCost = 0;
    let totalClientEV = 0;

    const allocations = allocationsList.map(({ pkg, itm }) => {
      const assigned = itm.assignedQuantity;
      const executed = itm.executedQuantity || 0;
      const remaining = Math.max(0, assigned - executed);
      const subCost = executed * itm.subcontractRateSar;
      const clientEV = executed * (mainBoq?.unit_price || itm.clientRateSar);
      const margin = clientEV - subCost;
      const progressPct = assigned > 0 ? Math.min(100, Number(((executed / assigned) * 100).toFixed(1))) : 0;
      const quotaPct = itm.quotaPercent || (totalBoqQuantity > 0 ? Math.round((assigned / totalBoqQuantity) * 100) : 50);

      totalAssigned += assigned;
      totalExecuted += executed;
      totalSubCost += subCost;
      totalClientEV += clientEV;

      return {
        packageId: pkg.id,
        subcontractNumber: pkg.subcontractNumber,
        subcontractorName: pkg.subcontractorName,
        zoneOrScope: itm.zoneOrScope || 'نطاق تعاقدي محدد',
        assignedQty: assigned,
        executedQty: executed,
        remainingQty: remaining,
        quotaPercent: quotaPct,
        subcontractRate: itm.subcontractRateSar,
        clientRate: itm.clientRateSar,
        subcontractCostSar: subCost,
        clientEarnedSar: clientEV,
        marginSar: margin,
        progressPct,
      };
    });

    const overallItemProgressPct = totalBoqQuantity > 0 ? Math.min(100, Number(((totalExecuted / totalBoqQuantity) * 100).toFixed(1))) : 0;
    const weightedSubRate = totalExecuted > 0 ? Math.round(totalSubCost / totalExecuted) : (allocationsList[0].itm.subcontractRateSar || 0);
    const totalRealizedMarginSar = totalClientEV - totalSubCost;
    const marginPercent = totalClientEV > 0 ? Number(((totalRealizedMarginSar / totalClientEV) * 100).toFixed(1)) : 0;

    results.push({
      boqCode,
      description,
      unit,
      totalBoqQuantity,
      clientRateSar,
      clientTotalBudgetSar,
      subcontractorsCount: allocations.length,
      totalAssignedToSubs: totalAssigned,
      totalExecutedBySubs: totalExecuted,
      overallItemProgressPct,
      weightedSubcontractRate: weightedSubRate,
      totalSubcontractCostSar: totalSubCost,
      totalClientEarnedSar: totalClientEV,
      totalRealizedMarginSar: totalRealizedMarginSar,
      marginPercent,
      allocations,
    });
  });

  return results.sort((a, b) => b.subcontractorsCount - a.subcontractorsCount);
}

export function calculateSubcontractorLedger(
  packages: SubcontractPackage[],
  activities: Activity[],
  boqItems: BoqItem[]
): {
  summaries: SubcontractorPerformanceSummary[];
  sharedBoqItems: SharedBoqItemSplit[];
  totals: {
    totalSubcontractCommitment: number;
    totalClientEquivalent: number;
    totalSubcontractorIncurredAC: number;
    totalClientRevenueEV: number;
    totalRealizedGrossProfit: number;
    overallMarginPercent: number;
    totalRetentionWithheld: number;
    totalNetPayable: number;
  };
} {
  const summaries: SubcontractorPerformanceSummary[] = packages.map((pkg) => {
    let pkgSubCost = 0;
    let pkgClientEV = 0;
    let totalAssignedWeight = 0;
    let totalExecutedWeight = 0;

    const activeItems = pkg.items.map((itm) => {
      const executedQty = itm.executedQuantity || 0;
      const subCost = executedQty * itm.subcontractRateSar;
      const clientEV = executedQty * itm.clientRateSar;
      const margin = clientEV - subCost;
      const progressPct = itm.assignedQuantity > 0 ? Math.min(100, Number(((executedQty / itm.assignedQuantity) * 100).toFixed(1))) : 0;

      pkgSubCost += subCost;
      pkgClientEV += clientEV;
      totalAssignedWeight += itm.subcontractTotalSar;
      totalExecutedWeight += subCost;

      return {
        itemId: itm.id,
        boqCode: itm.boqCode,
        description: itm.description,
        unit: itm.unit,
        assignedQuantity: itm.assignedQuantity,
        executedQuantity: executedQty,
        subcontractRate: itm.subcontractRateSar,
        clientRate: itm.clientRateSar,
        subcontractCostSar: subCost,
        clientEarnedSar: clientEV,
        marginSar: margin,
        progressPct,
        zoneOrScope: itm.zoneOrScope,
        quotaPercent: itm.quotaPercent,
      };
    });

    const retentionRate = (pkg.retentionPercent || 10) / 100;
    const retentionWithheldSar = Math.round(pkgSubCost * retentionRate);
    const netPayableSar = Math.round(pkgSubCost - retentionWithheldSar);
    const grossProfitSar = Math.round(pkgClientEV - pkgSubCost);
    const marginPercent = pkgClientEV > 0 ? Number(((grossProfitSar / pkgClientEV) * 100).toFixed(1)) : 0;
    const physicalProgressPercent = totalAssignedWeight > 0 ? Number(((totalExecutedWeight / totalAssignedWeight) * 100).toFixed(1)) : 0;

    return {
      packageId: pkg.id,
      subcontractNumber: pkg.subcontractNumber,
      subcontractorName: pkg.subcontractorName,
      trade: pkg.trade,
      contractValueSar: pkg.totalSubcontractValueSar,
      clientEquivalentValueSar: pkg.totalClientEquivalentValueSar,
      totalExecutedCostSar: Math.round(pkgSubCost),
      totalClientEarnedValueSar: Math.round(pkgClientEV),
      grossProfitSar,
      marginPercent,
      retentionWithheldSar,
      netPayableSar,
      physicalProgressPercent,
      itemsCount: pkg.items.length,
      activeItems,
    };
  });

  const sharedBoqItems = calculateSharedBoqItemsMatrix(packages, boqItems);

  const totalSubcontractCommitment = summaries.reduce((s, x) => s + x.contractValueSar, 0);
  const totalClientEquivalent = summaries.reduce((s, x) => s + x.clientEquivalentValueSar, 0);
  const totalSubcontractorIncurredAC = summaries.reduce((s, x) => s + x.totalExecutedCostSar, 0);
  const totalClientRevenueEV = summaries.reduce((s, x) => s + x.totalClientEarnedValueSar, 0);
  const totalRealizedGrossProfit = summaries.reduce((s, x) => s + x.grossProfitSar, 0);
  const overallMarginPercent = totalClientRevenueEV > 0 ? Number(((totalRealizedGrossProfit / totalClientRevenueEV) * 100).toFixed(1)) : 0;
  const totalRetentionWithheld = summaries.reduce((s, x) => s + x.retentionWithheldSar, 0);
  const totalNetPayable = summaries.reduce((s, x) => s + x.netPayableSar, 0);

  return {
    summaries,
    sharedBoqItems,
    totals: {
      totalSubcontractCommitment,
      totalClientEquivalent,
      totalSubcontractorIncurredAC,
      totalClientRevenueEV,
      totalRealizedGrossProfit,
      overallMarginPercent,
      totalRetentionWithheld,
      totalNetPayable,
    },
  };
}

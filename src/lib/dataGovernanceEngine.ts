import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  BoqItem,
  BudgetLine,
  CostTransaction,
  ProgressUpdate,
  ProcurementSubmittal,
  Resource,
  ActivityResource,
  ActivityLink,
  Risk,
  BaselineActivity,
} from '@/types';
import { runDcma14PointAudit } from '@/lib/scheduleQualityEngine';
import { resolveDataDate } from '@/lib/chronologyGuard';
import { getSubcontractPackages, calculateSubcontractorLedger } from '@/lib/subcontractEngine';
// F9.5 (Pilot Closure defect 1): the EVM pillar QUOTES canonical F6. `analyzeCostControl` +
// `selectCanonicalEvm` are the cost-control SSOT established in F9.4; neither imports `supabase`, so
// this adds no dependency cycle. `calculateProjectEvmAtDataDate` is retained ONLY as an explicitly
// labelled diagnostic comparison — it is no longer a source of user-facing EVM values anywhere here.
import { analyzeCostControl } from '@/lib/costControlEngine';
import { selectCanonicalEvm } from '@/lib/canonicalEvm';
import { buildGovernanceEvmCheck } from '@/lib/governanceEvmPillar';
import { calculateProjectEvmAtDataDate } from '@/lib/planningEngine';
import type { EvmAcSource, EvmBacSource } from '@/lib/planningEngine';

// The bilingual EVM data-quality label maps this pillar used to own moved to `governanceEvmPillar`
// with the row-building logic they render, so the pure module the harness can import is the single
// definition of how a canonical EVM fact is labelled.

export interface GovernanceCheckItem {
  id: string;
  pillar: 'network_cpm' | 'ssot_financial' | 'relational_fk' | 'evm_math' | 'fidic_commercial' | 'temporal_sequence';
  pillarNameAr: string;
  pillarNameEn: string;
  code: string;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  status: 'passed' | 'warning' | 'violation' | 'repaired';
  expectedValue: string;
  actualValue: string;
  variance: string;
  impactAr: string;
  impactEn: string;
  fixActionNameAr?: string;
  fixActionNameEn?: string;
}

export interface GovernanceAuditResult {
  overallScore: number; // 0 to 100
  ratingGrade: 'A+' | 'A' | 'B' | 'C' | 'F';
  auditTimestamp: string;
  totalChecks: number;
  passedCount: number;
  warningCount: number;
  violationCount: number;
  repairedCount: number;
  pillars: {
    id: string;
    nameAr: string;
    nameEn: string;
    score: number;
    passed: number;
    total: number;
  }[];
  checks: GovernanceCheckItem[];
  financialSsot: {
    contractValue: number;
    boqTotal: number;
    budgetBac: number;
    baselineCost: number;
    isPerfectMatch: boolean;
    maxVarianceSar: number;
  };
  /**
   * EVM snapshot copied from the canonical engine (`calculateProjectEvmAtDataDate`). A field is null
   * exactly when that engine could not derive it — no authoritative BAC source, no actual-cost
   * evidence, or a ratio whose denominator is zero — and `bacSource` / `acSource` state which of
   * those applies, so a consumer can tell a measured zero from missing data. Nothing in this shape
   * is recomputed locally by the governance engine (Final Cleanup, item 4).
   */
  evmParity: {
    dataDate: string;
    bac: number | null;
    bacSource: EvmBacSource;
    pv: number | null;
    ev: number | null;
    ac: number | null;
    acSource: EvmAcSource;
    sv: number | null;
    cv: number | null;
    vac: number | null;
    spi: number | null;
    cpi: number | null;
    /** F9.5: estimate to complete, quoted from canonical F6 (the label set the pilot reconciled). */
    etc: number | null;
    eac: number | null;
    tcpi: number | null;
    /** Canonical earned progress (EV / BAC), or null when BAC is unavailable. */
    earnedProgressPercent: number | null;
    /** Canonical planned progress (PV / BAC), or null when BAC is unavailable. */
    plannedProgressPercent: number | null;
    /** True only when every index above is a measured value derived from real inputs. */
    isRigorous: boolean;
  };
  summaryAr: string;
  summaryEn: string;
}

/**
 * Execute a comprehensive, multi-pillar Data Governance & Cross-Module Integrity Audit
 */
export async function runComprehensiveGovernanceAudit(
  project: Project,
  activities: Activity[],
  links: ActivityLink[],
  boqItems: BoqItem[],
  budgetLines: BudgetLine[],
  transactions: CostTransaction[],
  progressUpdates: ProgressUpdate[],
  submittals: ProcurementSubmittal[],
  resources: Resource[],
  activityResources: ActivityResource[],
  risks: Risk[],
  // F9.5: the project's ACTIVE APPROVED baseline rows, fetched by the caller with the same governed
  // `project_baselines!inner` query BudgetView / Dashboard / ProgressView / ScheduleView /
  // ExecutiveReportView use. F6's first-precedence BAC basis is the approved baseline, so without
  // these rows the canonical EVM this pillar quotes would fall back to unfrozen budget lines and
  // could not equal what the Dashboard and the Executive Report show. Optional and last so the
  // existing positional call keeps compiling; an omitted value degrades to F6's documented
  // budget-line/contract BAC precedence rather than to an invented budget.
  baselines: BaselineActivity[] = [],
): Promise<GovernanceAuditResult> {
  const checks: GovernanceCheckItem[] = [];

  // -------------------------------------------------------------
  // PILLAR 1: CPM Network & Structural Integrity (DCMA 14-Point)
  // -------------------------------------------------------------
  // GAP-010: the governance audit uses the governed Data Date resolution
  // (`project.data_date || DEFAULT_DATA_DATE`) so its DCMA pillar agrees with ExecutiveReportView,
  // DcmaAuditView and PortfolioView instead of evaluating at a local literal two months beyond it.
  // GAP-015: the audit's critical-path continuity point recomputes CPM, so the governance pillar
  // passes the project's own calendar and status logic rather than leaving the engine defaults.
  const dcmaAudit = runDcma14PointAudit(activities, links, [], activityResources, resolveDataDate(project), {
    calendarType: project.calendar_type,
    statusLogic: project.status_logic,
  });
  const openEnds = dcmaAudit.points.find((r) => r.id === 1);
  const leads = dcmaAudit.points.find((r) => r.id === 3);
  const hardConstraints = dcmaAudit.points.find((r) => r.id === 5);
  const negativeFloat = dcmaAudit.points.find((r) => r.id === 7);
  // Final Cleanup (item 3): GOV-NET-03 is the critical-path-continuity control, so it now consumes
  // DCMA Point 11 — the point that actually measures continuity of the driving critical chain. It
  // used to read Point 12, whose subject is float/drag consistency, which meant a check titled
  // "Critical Path Continuity" took its evidence (and its pass/fail) from an unrelated control: a
  // fragmented critical path could be reported as a connected one whenever the float fields happened
  // to be populated. Point 12 is still consumed — by GOV-NET-02, for float/drag consistency only.
  // Continuity is never recomputed here: `scheduleQualityEngine` owns that formula (GAP-015) and this
  // pillar reports its target / actualValue / passRatio as evidence.
  const criticalPathContinuity = dcmaAudit.points.find((r) => r.id === 11);
  const floatDragConsistency = dcmaAudit.points.find((r) => r.id === 12);
  const continuityGapPct = criticalPathContinuity
    ? Math.round((1 - Math.max(0, Math.min(1, criticalPathContinuity.passRatio))) * 100)
    : 100;

  checks.push({
    id: 'GOV-NET-01',
    pillar: 'network_cpm',
    pillarNameAr: 'سلامة الشبكة والمسار الحرج (CPM Network)',
    pillarNameEn: 'CPM Network & DCMA Structural Integrity',
    code: 'DCMA-01/02/03',
    titleAr: 'تكامل الروابط المنطقية وخلو الشبكة من النهايات المفتوحة والليد السالب',
    titleEn: 'Logic Links Integrity & Zero Dangling Ends / Negative Leads',
    descriptionAr: 'التحقق من أن جميع الأنشطة غير المعلمية مرتبطة بسلف وخلف وخالية من العلاقات السالبة (Negative Leads).',
    descriptionEn: 'Verifies all non-milestone activities possess predecessor and successor with 0 negative leads.',
    severity: 'critical',
    status: (openEnds?.status === 'pass' && leads?.status === 'pass') ? 'passed' : 'warning',
    expectedValue: '0% نهايات مفتوحة / 0 علاقة سالبة',
    actualValue: `${openEnds?.actualValue || '0%'} نهايات مفتوحة | ${leads?.actualValue || '0%'} ليد سالب`,
    variance: '0%',
    impactAr: 'ضمان صحة التدفق الزمني وحسابات المسار الحرج والمطالبات الزمنية TIA.',
    impactEn: 'Guarantees accurate critical path flow and defensible TIA delay claims.',
  });

  checks.push({
    id: 'GOV-NET-02',
    pillar: 'network_cpm',
    pillarNameAr: 'سلامة الشبكة والمسار الحرج (CPM Network)',
    pillarNameEn: 'CPM Network & DCMA Structural Integrity',
    code: 'DCMA-05/07/12',
    titleAr: 'انضباط القيود الزمنية (Constraints) واتساق الهوامش وكبح المسار الحرج (Float / Drag)',
    titleEn: 'Constraint Discipline & Float/Drag Consistency (<5% Hard Constraints, 0 Negative Float)',
    descriptionAr: 'التأكد من عدم وجود قيود قسرية تعطل الحساب الديناميكي، وانعدام الهوامش السالبة في خط الأساس، واكتمال حسابات Total/Free Float وقيم الكبح (Drag) لكل نشاط.',
    descriptionEn: 'Ensures no mandatory constraints hijack CPM float dynamics, that no negative float exists, and that every activity carries computed Total/Free Float and Drag values (DCMA Point 12).',
    severity: 'high',
    status:
      hardConstraints?.status === 'pass' && negativeFloat?.status === 'pass' && floatDragConsistency?.status === 'pass'
        ? 'passed'
        : 'warning',
    expectedValue: '< 5% قيود قسرية | 0 هامش سالب | هوامش وDrag مكتملة لكل الأنشطة',
    actualValue: `${hardConstraints?.actualValue || '0%'} قيود | ${negativeFloat?.actualValue || '0%'} هامش سالب | ${floatDragConsistency?.actualValue || 'غير مكتمل'} (Float/Drag)`,
    variance: '0%',
    impactAr: 'تفادي التشوهات الحسابية وتضخيم الهوامش الوهمية في الجدولة التعاقدية.',
    impactEn: 'Prevents artificial float distortion and contractual schedule disputes.',
  });

  checks.push({
    id: 'GOV-NET-03',
    pillar: 'network_cpm',
    pillarNameAr: 'سلامة الشبكة والمسار الحرج (CPM Network)',
    pillarNameEn: 'CPM Network & DCMA Structural Integrity',
    code: 'DCMA-11',
    titleAr: 'استمرارية المسار الحرج (Critical Path Continuity — DCMA Point 11)',
    titleEn: 'Critical Path Continuity (DCMA Point 11)',
    descriptionAr: 'التحقق من أن المسار الحرج يشكل سلسلة متصلة غير منقطعة عبر علاقات مُحَرِّكة (Driving) من تاريخ البدء وحتى تاريخ الإنجاز التعاقدي — والدليل هو نتيجة النقطة 11 من تدقيق DCMA نفسها دون إعادة حساب محلية.',
    descriptionEn: 'Verifies the critical path forms an unbroken chain of driving relationships from project start to the final contractual milestone, using DCMA Point 11\'s own result as evidence rather than a locally recomputed formula.',
    severity: 'critical',
    status: criticalPathContinuity?.status === 'pass' ? 'passed' : 'warning',
    expectedValue: criticalPathContinuity?.target || '100% مسار متصل بعلاقات مُحَرِّكة',
    actualValue: criticalPathContinuity
      ? `${criticalPathContinuity.actualValue} — ${criticalPathContinuity.nameAr}`
      : 'N/A — تعذر تقييم استمرارية المسار الحرج (لا نتائج CPM)',
    variance:
      continuityGapPct === 0
        ? '0 انقطاع'
        : `${continuityGapPct}% من الأنشطة الحرجة خارج السلسلة المُحَرِّكة`,
    impactAr: 'المسار الحرج هو الأساس القانوني لتسوية النزاعات ومطالبات التمديد الزمني EOT.',
    impactEn: 'Critical path is the primary legal foundation for EOT claims under FIDIC Cl. 8.4.',
  });

  // -------------------------------------------------------------
  // PILLAR 2: Single Source of Truth (SSOT) Master Financial Reconciliation
  // -------------------------------------------------------------
  const contractValue = Number(project.contract_value || 0);
  const boqTotal = boqItems.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
  const budgetBac = budgetLines.reduce((sum, line) => sum + Number(line.planned_cost || 0), 0);
  const baselineCost = boqTotal; // Baseline loaded directly from BOQ items

  const boqVariance = Math.abs(contractValue - boqTotal);
  const budgetVariance = Math.abs(contractValue - budgetBac);
  const isSsotReconciled = boqVariance < 1 && budgetVariance < 1;

  checks.push({
    id: 'GOV-FIN-01',
    pillar: 'ssot_financial',
    pillarNameAr: 'المطابقة المالية الشاملة (Financial SSOT)',
    pillarNameEn: 'Master Financial Single Source of Truth',
    code: 'SSOT-01',
    titleAr: 'تطابق القيمة التعاقدية مع إجمالي جدول الكميات (Contract Value == BOQ Total)',
    titleEn: 'Contract Value vs Master BOQ Total Parity',
    descriptionAr: 'مطابقة القيمة الإجمالية للعقد المسجلة رسمياً مع حاصل جمع كافة بنود جدول الكميات المعتمد.',
    descriptionEn: 'Verifies exact match between formal contract price and sum of approved BOQ items.',
    severity: 'critical',
    status: boqVariance < 1 ? 'passed' : 'violation',
    expectedValue: `${contractValue.toLocaleString()} ر.س`,
    actualValue: `${boqTotal.toLocaleString()} ر.س`,
    variance: `${boqVariance.toLocaleString()} ر.س`,
    impactAr: 'منع الثغرات التعاقدية ومطالبات التغيير غير المغطاة ببنود كميات.',
    impactEn: 'Eliminates contractual gaps and unauthorized out-of-scope variations.',
    fixActionNameAr: 'مزامنة وتعديل جدول الكميات تلقائياً',
    fixActionNameEn: 'Auto-Harmonize BOQ with Contract Value',
  });

  checks.push({
    id: 'GOV-FIN-02',
    pillar: 'ssot_financial',
    pillarNameAr: 'المطابقة المالية الشاملة (Financial SSOT)',
    pillarNameEn: 'Master Financial Single Source of Truth',
    code: 'SSOT-02',
    titleAr: 'تطابق الميزانية التقديرية المعتمدة مع خط الأساس (Approved BAC == CBS Total)',
    titleEn: 'Approved Budget (BAC) vs CBS Cost Lines Parity',
    descriptionAr: 'مطابقة خط الميزانية المعتمد BAC مع مجموع مراكز التكلفة الخمسة (مواد، عمالة، معدات، باطن، مصاريف موقع).',
    descriptionEn: 'Validates approved BAC matches sum of 5-element CBS line items.',
    severity: 'critical',
    status: budgetVariance < 1 ? 'passed' : 'violation',
    expectedValue: `${contractValue.toLocaleString()} ر.س`,
    actualValue: `${budgetBac.toLocaleString()} ر.س`,
    variance: `${budgetVariance.toLocaleString()} ر.س`,
    impactAr: 'ضمان دقة الرقابة المالية وعدم تجاوز السقف الائتماني للمشروع.',
    impactEn: 'Ensures strict cost control and zero project credit ceiling breach.',
    fixActionNameAr: 'إعادة ضبط أسطر الميزانية التقديرية',
    fixActionNameEn: 'Harmonize CBS Budget Lines',
  });

  // -------------------------------------------------------------
  // PILLAR 3: Relational Foreign-Key & Orphan Integrity
  // -------------------------------------------------------------
  const boqIds = new Set(boqItems.map((b) => b.id));
  const activityIds = new Set(activities.map((a) => a.id));
  const resourceIds = new Set(resources.map((r) => r.id));

  const orphanActResources = activityResources.filter(
    (ar) => !activityIds.has(ar.activity_id) || !resourceIds.has(ar.resource_id),
  );
  const orphanTransactions = transactions.filter(
    (t) => (t.activity_id && !activityIds.has(t.activity_id)) || (t.boq_item_id && !boqIds.has(t.boq_item_id)),
  );
  const orphanProgress = progressUpdates.filter((p) => !activityIds.has(p.activity_id));
  const orphanSubmittals = submittals.filter((s) => s.activity_id && !activityIds.has(s.activity_id));

  const totalOrphanCount = orphanActResources.length + orphanTransactions.length + orphanProgress.length + orphanSubmittals.length;

  checks.push({
    id: 'GOV-REL-01',
    pillar: 'relational_fk',
    pillarNameAr: 'سلامة الروابط والعلاقات المتقاطعة (Relational FK)',
    pillarNameEn: 'Relational Integrity & Zero Orphan Records',
    code: 'REL-01',
    titleAr: 'خلو النظام من السجلات المعزولة (Zero Orphan Foreign Keys in All Tables)',
    titleEn: 'Verification of Relational Integrity Across Activity, Resource & BOQ Links',
    descriptionAr: 'التأكد من أن جميع تخصيصات الموارد، المعاملات المالية، سجلات التقدم اليومي، والاعتمادات مرتبطة بكيانات حقيقية.',
    descriptionEn: 'Audits that all resource links, transactions, progress entries, and submittals point to valid parent records.',
    severity: 'high',
    status: totalOrphanCount === 0 ? 'passed' : 'violation',
    expectedValue: '0 سجلات معزولة (100% Relational Parity)',
    actualValue: `${totalOrphanCount} سجلات غير مرتبطة`,
    variance: totalOrphanCount === 0 ? '0' : `-${totalOrphanCount}`,
    impactAr: 'حماية قاعدة البيانات من الانهيارات أثناء التجميع وحسابات المؤشرات الإحصائية.',
    impactEn: 'Protects database from query corruption and metric aggregation anomalies.',
    fixActionNameAr: 'إصلاح وربط السجلات المعزولة آلياً',
    fixActionNameEn: 'Cleanse & Link Orphan Records',
  });

  // -------------------------------------------------------------
  // PILLAR 4: EVM & Progress Mathematical Consistency
  // -------------------------------------------------------------
  // F9.5 (Pilot Closure defect 1) — ROOT CAUSE OF THE VISIBLE `EVM-01/02/03` DIVERGENCE.
  //
  // This pillar published EVM under the canonical labels BAC/PV/EV/AC/SPI/CPI/EAC/TCPI/VAC from
  // `calculateProjectEvmAtDataDate` — the secondary derivation F9.4 retired as a DISPLAY source but
  // could not delete (S6 locks its contract-value-first BAC precedence and other callers use it).
  // That is where the pilot's visible rows got EV 276,918 / PV 288,359 / CPI 0.400 / EAC 5,862,875 /
  // VAC -3,517,725 while F6, the Dashboard's canonical strip and the Executive Report all showed
  // EV 755,708 / PV 781,871.43 / CPI 1.095 / EAC 2,141,689.5 / VAC +203,460.5 for the SAME project at
  // the SAME governed Data Date. It was never a BAC or AC disagreement — both derivations agree on
  // 2,345,150 and 690,000. They diverge on how each activity's budget is WEIGHTED and EARNED: the
  // secondary derivation matches an activity to the FIRST budget line of its WBS node, hands that
  // line in full to every activity in the node, re-scales to BAC and time-prorates planned value,
  // whereas F6 earns `activityBac x percent_complete` against the approved baseline.
  //
  // `forecastTrustEngine` was NOT the source: F8's `analyzeForecastTrust()` already receives the F6
  // cost strip and quotes it. The rows were this governance pillar's.
  //
  // The pillar now QUOTES canonical F6 (`analyzeCostControl` -> `selectCanonicalEvm`) and keeps the
  // secondary derivation only as an explicitly labelled DIAGNOSTIC comparison, so the divergence that
  // fooled the pilot becomes a visible reconciliation finding instead of two equally authoritative
  // sets of "EVM" numbers. Row construction lives in `governanceEvmPillar` — a pure module with no
  // `supabase` import, because THIS file cannot be bundled into the node-ESM regression harness and
  // the pillar was therefore untestable. S18 drives that same function.
  const governedDataDate = resolveDataDate(project);
  const costReport = analyzeCostControl({
    project,
    activities,
    baselines,
    budgetLines,
    costTransactions: transactions,
    progressUpdates,
    wbsNodes: [],
    boqItems,
    allocations: [],
    dataDate: governedDataDate,
    calendarType: project.calendar_type,
  });
  const canonicalEvm = selectCanonicalEvm(costReport);
  // DIAGNOSTIC ONLY. Its output must never be presented as a current value under a canonical label;
  // `buildGovernanceEvmCheck` renders it in a separately marked comparison segment of `variance`.
  const diagnosticEvm = calculateProjectEvmAtDataDate(
    project,
    activities,
    budgetLines,
    boqItems,
    transactions,
    progressUpdates,
  );

  const bacAvailable = canonicalEvm.bacSource !== 'unavailable';
  const acAvailable = canonicalEvm.acSource !== 'unavailable';
  const evmFullyMeasured =
    bacAvailable &&
    acAvailable &&
    canonicalEvm.spiStatus === 'valid' &&
    canonicalEvm.cpiStatus === 'valid' &&
    canonicalEvm.tcpiStatus === 'valid';

  checks.push(buildGovernanceEvmCheck({
    canonical: canonicalEvm,
    diagnostic: diagnosticEvm,
    diagnosticLabel: 'planningEngine.calculateProjectEvmAtDataDate',
  }));

  // -------------------------------------------------------------
  // PILLAR 5: Commercial, Subcontractor & FIDIC Controls Parity
  // -------------------------------------------------------------
  const subPackages = getSubcontractPackages(project.id);
  const subLedger = calculateSubcontractorLedger(subPackages, activities, boqItems);
  const totalSubRetention = subLedger.totals.totalRetentionWithheld;
  const totalSubIncurred = subLedger.totals.totalSubcontractorIncurredAC;
  // GAP-020: retention is a CONTRACTUAL term of each package (10%, 5%, 0%, ...), so the control
  // checks that every package was deducted at its own percent instead of assuming a flat 10%.
  const billedPackages = subLedger.summaries.filter((s) => s.totalExecutedCostSar > 0);
  const packagesWithUnknownRetention = subLedger.summaries.filter((s) => s.retentionPercent === null);
  const retentionMismatches = billedPackages.filter(
    (s) =>
      s.retentionPercent === null ||
      s.retentionWithheldSar === null ||
      Math.abs(s.retentionWithheldSar - s.totalExecutedCostSar * (s.retentionPercent / 100)) > 0.5,
  );
  const subRetentionRatio =
    totalSubIncurred > 0 && totalSubRetention !== null ? (totalSubRetention / totalSubIncurred) * 100 : null;
  const isRetentionCorrect = retentionMismatches.length === 0 && packagesWithUnknownRetention.length === 0;

  checks.push({
    id: 'GOV-FID-01',
    pillar: 'fidic_commercial',
    pillarNameAr: 'الضوابط التعاقدية وعقود الباطن (FIDIC & Commercial)',
    pillarNameEn: 'FIDIC Contractual Controls & Subcontractor Ledger Parity',
    code: 'FID-01',
    titleAr: 'انضباط استقطاعات ضمان حسن التنفيذ وفق النسبة التعاقدية لكل باقة (Contractual Retention)',
    titleEn: 'Subcontractor Retention Withheld at Each Package\'s Contractual Percent',
    descriptionAr: 'التحقق من حجز نسبة الضمان التعاقدية الخاصة بكل باقة باطن (10% أو 5% أو 0%) من دفعاتها المعتمدة، دون افتراض نسبة موحدة ودون احتساب نسبة غير منصوص عليها في العقد.',
    descriptionEn: 'Verifies that every subcontract package is deducted at its own contractual retention percent (10%, 5%, 0%, ...) rather than an assumed flat rate, and that a package without a stated percent is reported as unspecified instead of being defaulted.',
    severity: 'high',
    status: isRetentionCorrect ? 'passed' : 'warning',
    expectedValue: `${billedPackages.length} باقة مفوترة تستقطع كلٌّ منها نسبتها التعاقدية`,
    actualValue:
      packagesWithUnknownRetention.length > 0
        ? `${retentionMismatches.length} باقة غير مطابقة، و${packagesWithUnknownRetention.length} باقة نسبتها غير منصوص عليها (N/A)`
        : `${retentionMismatches.length} باقة غير مطابقة · متوسط مرجح ${subRetentionRatio === null ? 'N/A' : `${subRetentionRatio.toFixed(2)}%`}`,
    variance: `${retentionMismatches.length} باقة`,
    impactAr: 'حماية المقاول الرئيسي من المخاطر التشغيلية وضمان معالجة العيوب خلال فترة الصيانة.',
    impactEn: 'Protects main contractor from subcontractor default during Defect Notification Period.',
  });

  checks.push({
    id: 'GOV-FID-02',
    pillar: 'fidic_commercial',
    pillarNameAr: 'الضوابط التعاقدية وعقود الباطن (FIDIC & Commercial)',
    pillarNameEn: 'FIDIC Contractual Controls & Subcontractor Ledger Parity',
    code: 'FID-02',
    titleAr: 'المطابقة الثلاثية للفواتير والتوريدات (3-Way Invoice Matching Integrity)',
    titleEn: '3-Way Invoice Matching Parity (PO == GRN Goods Receipt == Vendor Invoice)',
    descriptionAr: 'ضابط معرَّف للتحقق من مطابقة فواتير الموردين ومقاولي الباطن لأوامر الشراء الرسمية ومذكرات استلام البضائع بالموقع (GRN). لا يمكن تقييمه حالياً: لا يحتوي النموذج على سجلات أوامر شراء أو استلام مواد أو فواتير موردين، والحقل الوحيد المتصل بالموضوع هو invoice_number النصي على معاملة التكلفة.',
    descriptionEn: 'A defined control that vendor/subcontractor invoices reconcile against Purchase Orders and site GRNs. It cannot be evaluated yet: the schema holds no purchase-order, goods-receipt (GRN) or vendor-invoice records — the only related field is the free-text `invoice_number` on a cost transaction.',
    severity: 'high',
    // Final Cleanup (item 5): this control was hardcoded to `status: 'passed'` with the evidence
    // strings "100% match (0 conflicts)" although nothing was ever compared — there is no PO, GRN or
    // vendor-invoice data in this schema to compare against. An unevaluated financial control
    // reported as passing is worse than one reported as unavailable: it tells an auditor the 3-way
    // match was performed. It is now a warning with explicit N/A wording until real 3-way data
    // exists. No procurement records are invented here and no procurement subsystem is built.
    status: 'warning',
    expectedValue: 'PO ↔ GRN ↔ فاتورة المورد: مطابقة ثلاثية موثقة لكل دفعة (غير متاح للقياس حالياً)',
    actualValue: 'N/A — لا توجد بيانات أوامر شراء أو استلام مواد (GRN) أو فواتير موردين في النظام، لذا لا يمكن التحقق من هذا الضابط بعد',
    variance: 'N/A (لم يُقيَّم — لا يوجد دليل للمقارنة)',
    impactAr: 'منع الدفعات المزدوجة وضبط التكاليف الفعلية ومطابقة ضريبة القيمة المضافة ZATCA.',
    impactEn: 'Prevents duplicate payments, enforces ERP financial controls, and ensures ZATCA compliance.',
  });

  // -------------------------------------------------------------
  // PILLAR 6: Temporal & Calendar Sequence Integrity
  // -------------------------------------------------------------
  // GAP-010: this pillar IS the chronology test ("no progress ahead of the Data Date"), so it must
  // run against the governed Data Date. The former local literal sat two months beyond it, which
  // meant a project without a stored data_date was audited against a cutoff that would happily pass
  // records dated after the real status date.
  const dataDateStr = resolveDataDate(project);
  const futureCompletedActs = activities.filter((a) => {
    return (a.percent_complete || 0) > 0 && a.early_start && a.early_start > dataDateStr;
  });

  checks.push({
    id: 'GOV-TMP-01',
    pillar: 'temporal_sequence',
    pillarNameAr: 'التسلسل الزمني وتاريخ البيانات (Temporal & Data Date)',
    pillarNameEn: 'Temporal Sequencing & Data Date Integrity',
    code: 'TMP-01',
    titleAr: 'توافق تقدم الأنشطة مع تاريخ البيانات (No Progress Ahead of Data Date)',
    titleEn: 'Zero Actual Progress in the Future relative to Data Date',
    descriptionAr: 'التحقق من عدم وجود أي نسب إنجاز مسجلة لأنشطة تقع بعد تاريخ قطع البيانات المحدد للمشروع.',
    descriptionEn: 'Ensures no activities record actual progress past the active project data date cutoff.',
    severity: 'critical',
    status: futureCompletedActs.length === 0 ? 'passed' : 'violation',
    expectedValue: '0 أنشطة متقدمة عن تاريخ البيانات',
    actualValue: `${futureCompletedActs.length} نشاط`,
    variance: '0 نشاط',
    impactAr: 'منع التقارير المضللة وضمان واقعية نسبة الإنجاز الفعلي المحققة على أرض الواقع.',
    impactEn: 'Prevents misleading reporting and maintains audit trail defensibility.',
  });

  // -------------------------------------------------------------
  // Calculate Totals and Scores
  // -------------------------------------------------------------
  const passedCount = checks.filter((c) => c.status === 'passed').length;
  const warningCount = checks.filter((c) => c.status === 'warning').length;
  const violationCount = checks.filter((c) => c.status === 'violation').length;
  const repairedCount = checks.filter((c) => c.status === 'repaired').length;
  const totalChecks = checks.length;

  const overallScore = Math.round(((passedCount + repairedCount + warningCount * 0.5) / totalChecks) * 100);
  let ratingGrade: 'A+' | 'A' | 'B' | 'C' | 'F' = 'A+';
  if (overallScore >= 95) ratingGrade = 'A+';
  else if (overallScore >= 85) ratingGrade = 'A';
  else if (overallScore >= 70) ratingGrade = 'B';
  else if (overallScore >= 50) ratingGrade = 'C';
  else ratingGrade = 'F';

  // -------------------------------------------------------------
  // Audit summary — generated from this run's own tallies (Final Cleanup, item 6)
  // -------------------------------------------------------------
  // Both summaries used to assert, unconditionally, that every financial, mathematical and CPM
  // reference was fully reconciled "with zero discrepancies" / "دون أي تعارض في الأرقام": the same
  // sentence was emitted for a run that had just returned violations, and it was emitted in both
  // languages, so the overstatement was bilingual and systematic. A governance report may claim only
  // what its checks produced, and Arabic and English must say the same thing.
  const listCodes = (items: GovernanceCheckItem[]) => {
    const codes = items.map((c) => `${c.code} / ${c.id}`);
    return codes.length <= 5 ? codes.join('، ') : `${codes.slice(0, 5).join('، ')} … (+${codes.length - 5})`;
  };
  const violations = checks.filter((c) => c.status === 'violation');
  const warnings = checks.filter((c) => c.status === 'warning');
  const repairedNoteAr = repairedCount > 0 ? `، ${repairedCount} مُصلَح` : '';
  const repairedNoteEn = repairedCount > 0 ? `, ${repairedCount} repaired` : '';

  let summaryAr: string;
  let summaryEn: string;
  if (violationCount > 0) {
    summaryAr = `اكتمل فحص حوكمة البيانات بنتيجة ${overallScore}% وبتقدير (${ratingGrade}) عبر ${totalChecks} ضابطاً: ${passedCount} ناجح${repairedNoteAr}، ${warningCount} تحذير، ${violationCount} مخالفة مفتوحة [${listCodes(violations)}]. لا يمكن اعتبار المرجعيات المالية والرياضية وشبكة CPM متسقة بالكامل ما دامت هناك مخالفات لم تُعالَج.`;
    summaryEn = `Data governance audit completed with a ${overallScore}% conformance score (Grade ${ratingGrade}) across ${totalChecks} controls: ${passedCount} passed${repairedNoteEn}, ${warningCount} warnings and ${violationCount} open violations [${listCodes(violations)}]. The financial, mathematical and CPM references cannot be reported as fully reconciled while violations remain open.`;
  } else if (warningCount > 0) {
    summaryAr = `اكتمل فحص حوكمة البيانات مع تحذيرات: النتيجة ${overallScore}% وبتقدير (${ratingGrade}) عبر ${totalChecks} ضابطاً: ${passedCount} ناجح${repairedNoteAr}، ${warningCount} تحذير، دون مخالفات [${listCodes(warnings)}]. بعض الضوابط ناقصة الأدلة أو غير قابلة للقياس حالياً، لذا لا يُعلَن اكتمال التسوية قبل استيفائها.`;
    summaryEn = `Data governance audit completed with warnings: ${overallScore}% conformance (Grade ${ratingGrade}) across ${totalChecks} controls: ${passedCount} passed${repairedNoteEn}, ${warningCount} warnings and no violations [${listCodes(warnings)}]. Some controls lack evidence or are not measurable yet, so full reconciliation is not claimed until they are closed.`;
  } else {
    summaryAr = `اكتمل فحص حوكمة البيانات بنتيجة ${overallScore}% وبتقدير (${ratingGrade}): ${totalChecks} ضابطاً، ${passedCount} ناجح${repairedNoteAr}، دون مخالفات ودون تحذير. المرجعيات المالية والرياضية وشبكة CPM متسقة وفق الأدلة المسجلة في هذه الجولة.`;
    summaryEn = `Data governance audit completed with a ${overallScore}% conformance score (Grade ${ratingGrade}): ${totalChecks} controls, ${passedCount} passed${repairedNoteEn}, no violations and no warnings. The financial, mathematical and CPM references reconcile on the evidence recorded in this run.`;
  }

  // Group by Pillar
  const pillarMap = new Map<string, { passed: number; total: number; nameAr: string; nameEn: string }>();
  checks.forEach((c) => {
    const p = pillarMap.get(c.pillar) || { passed: 0, total: 0, nameAr: c.pillarNameAr, nameEn: c.pillarNameEn };
    p.total += 1;
    if (c.status === 'passed' || c.status === 'repaired') p.passed += 1;
    else if (c.status === 'warning') p.passed += 0.5;
    pillarMap.set(c.pillar, p);
  });

  const pillars = Array.from(pillarMap.entries()).map(([id, val]) => ({
    id,
    nameAr: val.nameAr,
    nameEn: val.nameEn,
    score: Math.round((val.passed / val.total) * 100),
    passed: Math.floor(val.passed),
    total: val.total,
  }));

  return {
    overallScore,
    ratingGrade,
    auditTimestamp: new Date().toISOString(),
    totalChecks,
    passedCount,
    warningCount,
    violationCount,
    repairedCount,
    pillars,
    checks,
    financialSsot: {
      contractValue,
      boqTotal,
      budgetBac,
      baselineCost,
      isPerfectMatch: isSsotReconciled,
      maxVarianceSar: Math.max(boqVariance, budgetVariance),
    },
    evmParity: {
      // F9.5: quoted from canonical F6, field for field. `CanonicalEvm` already publishes `null`
      // where F6 could not measure a fact, so the old `bacAvailable ? ... : null` guards are
      // redundant here — keeping them would only risk masking a real null with a second opinion.
      // The ratio guards stay: a ratio whose status is not `valid` is rendered as not-measured.
      dataDate: canonicalEvm.dataDate,
      bac: canonicalEvm.bac,
      bacSource: canonicalEvm.bacSource,
      pv: canonicalEvm.pv,
      ev: canonicalEvm.ev,
      ac: acAvailable ? canonicalEvm.ac : null,
      acSource: canonicalEvm.acSource,
      sv: canonicalEvm.sv,
      cv: canonicalEvm.cv,
      vac: canonicalEvm.vac,
      spi: canonicalEvm.spiStatus === 'valid' ? canonicalEvm.spi : null,
      cpi: canonicalEvm.cpiStatus === 'valid' ? canonicalEvm.cpi : null,
      etc: canonicalEvm.etc,
      eac: canonicalEvm.eac,
      tcpi: canonicalEvm.tcpiStatus === 'valid' ? canonicalEvm.tcpi : null,
      earnedProgressPercent: canonicalEvm.earnedProgressPercent,
      plannedProgressPercent: canonicalEvm.plannedProgressPercent,
      isRigorous: evmFullyMeasured,
    },
    summaryAr,
    summaryEn,
  };
}

/**
 * 1-Click Data Harmonization Engine (Final Cleanup, item 7).
 *
 * Writes to the database only where a deterministic source of truth exists and the transformation is
 * defensible on its own:
 *   - orphan `progress_updates` rows, whose parent activity does not exist, are deleted. The parent
 *     record is the authority and such a row can never become valid, so removing it is a repair.
 *
 * Financial reconciliation is REPORT-ONLY. A contract value, a BOQ line and a CBS budget line are
 * commercial facts, not arithmetic residues: this routine used to invent a target (`contract_value ||
 * 2345150`) when the project had none and then "balance" the tables by rewriting the LAST BOQ item —
 * including recomputing its unit price — and the LAST budget line until they matched that fiction.
 * That fabricated both the target and the evidence, destroyed the audit trail of two real rows, and
 * made every downstream financial report agree with a number nobody approved. Settling a BOQ/budget
 * variance against the contract is a commercial decision (variation order, re-measurement, contract
 * amendment), so the variance is now reported and left for that decision.
 *
 * `success` means "the procedure completed without error" — never "the variances were resolved".
 */
export async function harmonizeAndReconcileAllProjectData(projectId: string): Promise<{ success: boolean; repairedItems: string[] }> {
  const repairedItems: string[] = [];

  try {
    // 1. Fetch current project and linked entities
    const [{ data: project }, { data: boqItems }, { data: budgetLines }, { data: activities }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', projectId).single(),
      supabase.from('boq_items').select('*').eq('project_id', projectId),
      supabase.from('budget_lines').select('*').eq('project_id', projectId),
      supabase.from('activities').select('*').eq('project_id', projectId),
    ]);

    if (!project) return { success: false, repairedItems: ['لم يتم العثور على المشروع المستهدف'] };

    const fmt = (value: number) => `${Math.round(value).toLocaleString()} ر.س`;
    const boqRows = (boqItems || []) as BoqItem[];
    const budgetRows = (budgetLines || []) as BudgetLine[];
    const contractValue = Number(project.contract_value || 0);

    // 2. Financial harmonization requires an authoritative commercial target. With no recorded
    //    contract value there is nothing to reconcile against, so nothing financial is written and
    //    the gap is returned as an explicit unresolved item for a human to close.
    if (!(contractValue > 0)) {
      repairedItems.push(
        'بند غير محسوم: لا توجد قيمة تعاقدية مسجلة للمشروع (contract_value) ولا يمكن اعتماد BAC من مصدر موثوق، لذلك أُوقفت المطابقة المالية بالكامل ولم يُجرَ أي تعديل على بنود جدول الكميات أو خطوط الميزانية. الإجراء المطلوب: إدخال القيمة التعاقدية المعتمدة أو تحديد مصدر BAC المعتمد، ثم إعادة الفحص.',
      );
    } else {
      const boqSum = boqRows.reduce((s: number, b: BoqItem) => s + Number(b.total_price || 0), 0);
      const budgetSum = budgetRows.reduce((s: number, b: BudgetLine) => s + Number(b.planned_cost || 0), 0);
      const boqVariance = boqSum - contractValue;
      const budgetVariance = budgetSum - contractValue;

      repairedItems.push(
        `القيمة التعاقدية المسجلة (${fmt(contractValue)}) هي المرجع المالي للمطابقة. المطابقة المالية في هذا الإجراء تقريرية فقط: لا يُعدَّل أي بند أو خط ميزانية آلياً.`,
      );

      if (boqRows.length === 0) {
        repairedItems.push('بند غير محسوم: لا توجد بنود جدول كميات (BOQ) لهذا المشروع، لذا يتعذر قياس الفرق مقابل القيمة التعاقدية.');
      } else if (Math.abs(boqVariance) <= 1) {
        repairedItems.push(`إجمالي جدول الكميات (${fmt(boqSum)}) مطابق للقيمة التعاقدية ضمن ±1 ر.س — لا حاجة إلى أي تعديل.`);
      } else {
        repairedItems.push(
          `فرق مُبلَّغ عنه ولم يُسوَّ آلياً: إجمالي جدول الكميات ${fmt(boqSum)} مقابل القيمة التعاقدية ${fmt(contractValue)} = ${fmt(Math.abs(boqVariance))} ${boqVariance > 0 ? '(الكميات أعلى من العقد)' : '(الكميات أقل من العقد)'}. لم يُعدَّل أي بند BOQ: تسوية هذا الفرق قرار تجاري (أمر تغييري / إعادة قياس / تعديل عقد) ولا يجوز فرضها على آخر بند في الجدول.`,
        );
      }

      if (budgetRows.length === 0) {
        repairedItems.push('بند غير محسوم: لا توجد خطوط ميزانية CBS لهذا المشروع، لذا يتعذر قياس الفرق مقابل القيمة التعاقدية.');
      } else if (Math.abs(budgetVariance) <= 1) {
        repairedItems.push(`إجمالي ميزانية CBS (${fmt(budgetSum)}) مطابق للقيمة التعاقدية ضمن ±1 ر.س — لا حاجة إلى أي تعديل.`);
      } else {
        repairedItems.push(
          `فرق مُبلَّغ عنه ولم يُسوَّ آلياً: إجمالي ميزانية CBS ${fmt(budgetSum)} مقابل القيمة التعاقدية ${fmt(contractValue)} = ${fmt(Math.abs(budgetVariance))} ${budgetVariance > 0 ? '(الميزانية أعلى من العقد)' : '(الميزانية أقل من العقد)'}. لم يُعدَّل أي خط ميزانية: موازنة الميزانية مع العقد تتطلب قراراً تجارياً موثقاً ولا تُفرض على آخر خط في الجدول.`,
        );
      }
    }

    // 3. Cleanse orphan progress records — independent of the financial question above, so it still
    //    runs when the contract value is missing. The parent activity set is the deterministic
    //    authority: a progress row pointing at a non-existent activity can never be valid.
    let orphanRemoved = 0;
    if (activities) {
      const actMap = new Set(activities.map((a: Activity) => a.id));
      const { data: rawProgress } = await supabase.from('progress_updates').select('*').eq('project_id', projectId);
      if (rawProgress) {
        const invalid = rawProgress.filter((p: ProgressUpdate) => !actMap.has(p.activity_id));
        if (invalid.length > 0) {
          for (const inv of invalid) {
            await supabase.from('progress_updates').delete().eq('id', inv.id);
            orphanRemoved += 1;
          }
          repairedItems.push(`تم حذف وتطهير ${invalid.length} سجل تقدم غير صالح ومعزول (لا يشير إلى نشاط موجود).`);
        }
      }
    }

    // 4. Closing statement — describes what this run actually did, not a blanket success claim.
    repairedItems.push(
      orphanRemoved > 0
        ? `اكتملت العملية: نُفِّذ تعديل آمن واحد (${orphanRemoved} سجل معزول). لم تُجرَ أي كتابة مالية آلية، والفروقات المالية المذكورة أعلاه معروضة للتقرير والقرار التجاري.`
        : 'اكتملت العملية دون أي كتابة على البيانات: لا توجد إصلاحات آمنة مستحقة، والمطابقة المالية معروضة كفروقات للتقرير فقط.',
    );
    return { success: true, repairedItems };
  } catch (err: any) {
    console.error('Harmonization error:', err);
    return { success: false, repairedItems: [`خطأ أثناء المعالجة: ${err?.message || 'خطأ غير معروف'}`] };
  }
}

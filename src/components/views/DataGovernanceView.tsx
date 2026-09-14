import { useState, useEffect, useMemo, Fragment } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
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
} from '@/types';
import {
  runComprehensiveGovernanceAudit,
  harmonizeAndReconcileAllProjectData,
  type GovernanceAuditResult,
  type GovernanceCheckItem,
} from '@/lib/dataGovernanceEngine';
import {
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Wrench,
  RefreshCw,
  Scale,
  FileCheck,
  TrendingUp,
  Landmark,
  Layers,
  Database,
  Printer,
  Sparkles,
  ArrowRight,
  Filter,
  Search,
  Award,
  ChevronDown,
  ChevronUp,
  Cpu,
  Clock,
  DollarSign,
  Briefcase,
} from 'lucide-react';

interface DataGovernanceViewProps {
  project: Project | null;
}

/**
 * Everything rendered on this screen is bound to the `GovernanceAuditResult` produced by
 * `dataGovernanceEngine`. The helpers below only *format* engine output: they never supply a
 * fallback figure, so a value the audit could not derive is displayed as `N/A` rather than as a
 * reassuring zero or a demo constant. (Final UI Governance Binding Fix.)
 */
const NA = 'N/A';

/** Money as returned by the engine; `N/A` when the engine reported the value as unavailable. */
function fmtMoney(value: number | null | undefined, rtl: boolean): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  const text = Math.round(value).toLocaleString();
  return rtl ? `${text} ر.س` : `${text} SAR`;
}

/** Ratio as returned by the engine (already null when it was not a measured value). */
function fmtIndex(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return value.toFixed(digits);
}

/** Progress percentage as returned by the engine (already rounded to 1 decimal there). */
function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return `${value}%`;
}

type CheckStatus = GovernanceCheckItem['status'];

/**
 * Status → label + palette. Class strings are literal module-scope constants so the Tailwind JIT
 * scanner can see every one of them.
 */
const STATUS_TONE: Record<CheckStatus, { chip: string; text: string; dot: string; ar: string; en: string }> = {
  passed: { chip: 'bg-emerald-100 text-emerald-800', text: 'text-emerald-700', dot: 'bg-emerald-500', ar: 'مطابق', en: 'Matched' },
  repaired: { chip: 'bg-blue-100 text-blue-800', text: 'text-blue-700', dot: 'bg-blue-500', ar: 'تم إصلاحه', en: 'Repaired' },
  warning: { chip: 'bg-amber-100 text-amber-800', text: 'text-amber-700', dot: 'bg-amber-500', ar: 'تحذير', en: 'Warning' },
  violation: { chip: 'bg-red-100 text-red-800', text: 'text-red-700', dot: 'bg-red-500', ar: 'مخالفة', en: 'Violation' },
};

/** Tone used when there is no check result to read a verdict from — it never claims a pass. */
const NEUTRAL_TONE = {
  chip: 'bg-slate-100 text-slate-600',
  text: 'text-slate-600',
  dot: 'bg-slate-400',
  bar: 'bg-slate-300',
  ar: NA,
  en: NA,
};

/** Palette for a percentage that is itself the verdict (pillar / network scores). */
function scoreTone(score: number | null | undefined): { chip: string; text: string; bar: string } {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return { chip: 'bg-slate-100 text-slate-600', text: 'text-slate-500', bar: 'bg-slate-300' };
  }
  if (score >= 95) return { chip: 'bg-emerald-50 text-emerald-700', text: 'text-emerald-700', bar: 'bg-emerald-500' };
  if (score >= 70) return { chip: 'bg-amber-50 text-amber-700', text: 'text-amber-700', bar: 'bg-amber-500' };
  return { chip: 'bg-red-50 text-red-700', text: 'text-red-700', bar: 'bg-red-500' };
}

/** Worst status among a set of checks — the only verdict a summary card may show. */
function worstStatus(items: (GovernanceCheckItem | null | undefined)[]): CheckStatus {
  const list = items.filter(Boolean) as GovernanceCheckItem[];
  if (list.length === 0) return 'warning';
  if (list.some((c) => c.status === 'violation')) return 'violation';
  if (list.some((c) => c.status === 'warning')) return 'warning';
  return 'passed';
}

/** Bilingual labels for the canonical EVM engine's source metadata (`evmParity.bacSource/acSource`). */
const BAC_SOURCE_LABEL: Record<string, { ar: string; en: string }> = {
  contract_value: { ar: 'القيمة التعاقدية', en: 'contract value' },
  budget_lines: { ar: 'خطوط ميزانية CBS', en: 'CBS budget lines' },
  boq_items: { ar: 'جدول الكميات (BOQ)', en: 'BOQ items' },
  caller_supplied: { ar: 'قيمة مُدخلة من المستدعي', en: 'caller-supplied scalar' },
  unavailable: { ar: 'غير متاح — لا مصدر معتمد', en: 'unavailable — no authoritative source' },
};
const AC_SOURCE_LABEL: Record<string, { ar: string; en: string }> = {
  approved_cost_transactions: { ar: 'معاملات التكلفة المعتمدة', en: 'approved cost transactions' },
  budget_line_actuals: { ar: 'التكاليف الفعلية المسجلة في خطوط الميزانية', en: 'stored budget-line actuals' },
  caller_supplied: { ar: 'قيمة مُدخلة من المستدعي', en: 'caller-supplied scalar' },
  unavailable: { ar: 'غير متاح — لا دليل تكلفة فعلية', en: 'unavailable — no actual-cost evidence' },
};
function sourceLabel(map: Record<string, { ar: string; en: string }>, key: string | undefined, rtl: boolean): string {
  if (!key) return NA;
  const found = map[key];
  if (!found) return String(key);
  return rtl ? found.ar : found.en;
}

export default function DataGovernanceView({ project }: DataGovernanceViewProps) {
  const [lang, setLang] = useState<Language>(getLanguage());
  const [loading, setLoading] = useState(true);
  const [auditResult, setAuditResult] = useState<GovernanceAuditResult | null>(null);
  const [activeTab, setActiveTab] = useState<'pillars' | 'ssot' | 'evm_math' | 'certificate'>('pillars');
  const [selectedPillar, setSelectedPillar] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCheckId, setExpandedCheckId] = useState<string | null>(null);
  const [harmonizing, setHarmonizing] = useState(false);
  const [harmonizeFeedback, setHarmonizeFeedback] = useState<string[] | null>(null);

  // Entities state
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [transactions, setTransactions] = useState<CostTransaction[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [submittals, setSubmittals] = useState<ProcurementSubmittal[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [activityResources, setActivityResources] = useState<ActivityResource[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);

  useEffect(() => {
    if (project) {
      loadAllProjectEntities();
    }
    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, [project]);

  async function loadAllProjectEntities() {
    if (!project) return;
    setLoading(true);
    try {
      const [
        { data: acts },
        { data: lnks },
        { data: boqs },
        { data: bgts },
        { data: txns },
        { data: prgs },
        { data: subs },
        { data: res },
        { data: actRes },
        { data: rsks },
      ] = await Promise.all([
        supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
        supabase.from('activity_links').select('*').eq('project_id', project.id),
        supabase.from('boq_items').select('*').eq('project_id', project.id).order('sort_order'),
        supabase.from('budget_lines').select('*').eq('project_id', project.id),
        supabase.from('cost_transactions').select('*').eq('project_id', project.id),
        supabase.from('progress_updates').select('*').eq('project_id', project.id),
        supabase.from('procurement_submittals').select('*').eq('project_id', project.id),
        supabase.from('resources').select('*').eq('project_id', project.id),
        supabase.from('activity_resources').select('*').eq('project_id', project.id),
        supabase.from('risks').select('*').eq('project_id', project.id),
      ]);

      const actData = (acts || []) as Activity[];
      const lnkData = (lnks || []) as ActivityLink[];
      const boqData = (boqs || []) as BoqItem[];
      const bgtData = (bgts || []) as BudgetLine[];
      const txnData = (txns || []) as CostTransaction[];
      const prgData = (prgs || []) as ProgressUpdate[];
      const subData = (subs || []) as ProcurementSubmittal[];
      const resData = (res || []) as Resource[];
      const actResData = (actRes || []) as ActivityResource[];
      const rskData = (rsks || []) as Risk[];

      setActivities(actData);
      setLinks(lnkData);
      setBoqItems(boqData);
      setBudgetLines(bgtData);
      setTransactions(txnData);
      setProgressUpdates(prgData);
      setSubmittals(subData);
      setResources(resData);
      setActivityResources(actResData);
      setRisks(rskData);

      const audit = await runComprehensiveGovernanceAudit(
        project,
        actData,
        lnkData,
        boqData,
        bgtData,
        txnData,
        prgData,
        subData,
        resData,
        actResData,
        rskData,
      );
      setAuditResult(audit);
    } catch (err) {
      console.error('Error during governance audit:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleHarmonizeAll() {
    if (!project) return;
    setHarmonizing(true);
    setHarmonizeFeedback(null);
    try {
      const result = await harmonizeAndReconcileAllProjectData(project.id);
      setHarmonizeFeedback(result.repairedItems);
      await loadAllProjectEntities();
    } catch (err: any) {
      setHarmonizeFeedback([`حدث خطأ: ${err?.message || 'خطأ غير معروف'}`]);
    } finally {
      setHarmonizing(false);
    }
  }

  const isRtl = lang === 'ar';

  const filteredChecks = useMemo(() => {
    if (!auditResult) return [];
    return auditResult.checks.filter((item) => {
      const matchPillar = selectedPillar === 'all' || item.pillar === selectedPillar;
      const matchQuery =
        searchQuery.trim() === '' ||
        item.titleAr.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.titleEn.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.descriptionAr.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.descriptionEn.toLowerCase().includes(searchQuery.toLowerCase());
      return matchPillar && matchQuery;
    });
  }, [auditResult, selectedPillar, searchQuery]);

  // ---------------------------------------------------------------------------
  // Values rendered by the cards/tabs below. Each one is read from the audit
  // result; anything the audit does not provide stays `null` and renders as N/A.
  // ---------------------------------------------------------------------------
  const ssot = auditResult?.financialSsot ?? null;
  const evm = auditResult?.evmParity ?? null;
  const findCheck = (id: string): GovernanceCheckItem | null =>
    auditResult?.checks.find((c) => c.id === id) ?? null;
  const netChecks = (auditResult?.checks ?? []).filter((c) => c.pillar === 'network_cpm');
  const networkPillar = auditResult?.pillars.find((p) => p.id === 'network_cpm') ?? null;
  const net01 = findCheck('GOV-NET-01');
  const net03 = findCheck('GOV-NET-03');
  const relCheck = findCheck('GOV-REL-01');
  const evmCheck = findCheck('GOV-EVM-01');
  const fid02Check = findCheck('GOV-FID-02');

  // GOV-REL-01 reports "<n> سجلات غير مرتبطة". The count is read from the engine's own text; when
  // it cannot be parsed the card shows N/A instead of defaulting to a reassuring zero.
  const orphanCount: number | null = (() => {
    if (!relCheck) return null;
    const match = /(\d+)/.exec(String(relCheck.actualValue));
    return match ? Number(match[1]) : null;
  })();

  const contractValueAvailable = !!ssot && ssot.contractValue > 0;
  const ssotStatus: CheckStatus = !ssot
    ? 'warning'
    : contractValueAvailable
      ? (ssot.isPerfectMatch ? 'passed' : 'warning')
      : 'warning';
  const ssotTone = ssot ? STATUS_TONE[ssotStatus] : NEUTRAL_TONE;
  const cpmStatus = worstStatus(netChecks);
  const cpmTone = STATUS_TONE[cpmStatus];
  const relTone = relCheck ? STATUS_TONE[relCheck.status] : NEUTRAL_TONE;

  // Certificate verdict: violations dominate warnings dominate a clean run. It is derived from the
  // audit's own tallies, never asserted unconditionally.
  const violationCount = auditResult?.violationCount ?? 0;
  const warningCount = auditResult?.warningCount ?? 0;
  const certificateVerdict: 'clean' | 'warnings' | 'violations' =
    violationCount > 0 ? 'violations' : warningCount > 0 ? 'warnings' : 'clean';
  const nonPassingChecks = (auditResult?.checks ?? []).filter(
    (c) => c.status === 'warning' || c.status === 'violation',
  );
  const nonPassingCodes = nonPassingChecks.map((c) => c.code);
  const nonPassingList =
    nonPassingCodes.length <= 6
      ? nonPassingCodes.join('، ')
      : `${nonPassingCodes.slice(0, 6).join('، ')} … (+${nonPassingCodes.length - 6})`;

  // SSOT reconciliation rows. Only references the audit result actually carries are given an amount:
  // `financialSsot.baselineCost` is a copy of the BOQ total inside the engine (not an independent
  // baseline cost load) and no S-Curve target is provided at all, so those two rows render N/A
  // instead of repeating the contract value and implying a five-way parity that was never measured.
  type SsotRow = {
    key: string;
    labelAr: string;
    labelEn: string;
    sourceAr: string;
    sourceEn: string;
    amount: number | null;
    isReference?: boolean;
  };
  const ssotRows: SsotRow[] = [
    {
      key: 'contract',
      labelAr: 'القيمة التعاقدية الرسمية (Master Contract Value)',
      labelEn: 'Official Contract Value',
      sourceAr: 'عقد المقاولة الرئيسي المعتمد',
      sourceEn: 'Approved main contract',
      amount: contractValueAvailable && ssot ? ssot.contractValue : null,
      isReference: true,
    },
    {
      key: 'boq',
      labelAr: 'إجمالي جدول الكميات التعاقدي (BOQ Aggregate Total)',
      labelEn: 'Master BOQ Aggregate Total',
      sourceAr: boqItems.length > 0 ? `مجموع ${boqItems.length} بند كميات مسجل` : 'لا توجد بنود كميات مسجلة للمشروع',
      sourceEn: boqItems.length > 0 ? `Sum of ${boqItems.length} recorded BOQ items` : 'No BOQ items recorded for this project',
      amount: boqItems.length > 0 && ssot ? ssot.boqTotal : null,
    },
    {
      key: 'budget',
      labelAr: 'الميزانية التقديرية المعتمدة (Approved Budget BAC)',
      labelEn: 'Approved Budget (BAC)',
      sourceAr: budgetLines.length > 0 ? `مجموع ${budgetLines.length} خط ميزانية CBS` : 'لا توجد خطوط ميزانية مسجلة للمشروع',
      sourceEn: budgetLines.length > 0 ? `Sum of ${budgetLines.length} CBS budget lines` : 'No budget lines recorded for this project',
      amount: budgetLines.length > 0 && ssot ? ssot.budgetBac : null,
    },
    {
      key: 'baseline',
      labelAr: 'أحمال خط الأساس المحملة بالموارد (Schedule Cost Load)',
      labelEn: 'Baseline Cost-Loaded Schedule',
      sourceAr: 'غير متوفر — لا تقدم نتيجة التدقيق قيمة مستقلة موثوقة',
      sourceEn: 'Not available — the audit result carries no independent authoritative value',
      amount: null,
    },
    {
      key: 'scurve',
      labelAr: 'نقطة النهاية لمنحنى S-Curve (Target EVM BAC)',
      labelEn: 'EVM Cumulative Target BAC',
      sourceAr: 'غير متوفر — لا تقدم نتيجة التدقيق هدفاً معتمداً لمنحنى S',
      sourceEn: 'Not available — the audit result carries no authoritative S-Curve target',
      amount: null,
    },
  ];
  const ssotAvailableCount = ssotRows.filter((r) => r.amount !== null).length;
  const referenceAmount = ssotRows[0].amount;

  // EVM tab: metric cards. Values are the engine's own (`evmParity`); the badge for each card is the
  // status of the corresponding governance check (GOV-EVM-01) — never a literal "Pass".
  const evmBannerTone = evmCheck ? STATUS_TONE[evmCheck.status] : NEUTRAL_TONE;
  const evmCards: { key: string; title: string; formula: string; value: string; available: boolean; note?: string }[] = [
    {
      key: 'bac',
      title: 'BAC — Budget at Completion',
      formula: isRtl ? 'BAC: القيمة التعاقدية ← ميزانية CBS ← BOQ' : 'BAC: contract value ← CBS budget ← BOQ',
      value: fmtMoney(evm?.bac ?? null, isRtl),
      available: (evm?.bac ?? null) !== null,
      note: isRtl ? `المصدر: ${sourceLabel(BAC_SOURCE_LABEL, evm?.bacSource, isRtl)}` : `source: ${sourceLabel(BAC_SOURCE_LABEL, evm?.bacSource, isRtl)}`,
    },
    {
      key: 'pv',
      title: 'Planned Value (PV)',
      formula: isRtl ? 'PV: القيمة المخططة المُرحّلة على تواريخ CPM حتى تاريخ البيانات' : 'PV: planned value time-phased on CPM dates up to the data date',
      value: fmtMoney(evm?.pv ?? null, isRtl),
      available: (evm?.pv ?? null) !== null,
    },
    {
      key: 'ev',
      title: 'Earned Value (EV)',
      formula: isRtl ? 'EV: من سجلات التقدم المعتمدة ونسب الإنجاز المسجلة' : 'EV: from approved progress records and recorded percent complete',
      value: fmtMoney(evm?.ev ?? null, isRtl),
      available: (evm?.ev ?? null) !== null,
    },
    {
      key: 'ac',
      title: 'Actual Cost (AC)',
      formula: isRtl ? 'AC: معاملات التكلفة المعتمدة ← التكاليف الفعلية المسجلة' : 'AC: approved cost transactions ← stored budget actuals',
      value: fmtMoney(evm?.ac ?? null, isRtl),
      available: (evm?.ac ?? null) !== null,
      note: isRtl ? `المصدر: ${sourceLabel(AC_SOURCE_LABEL, evm?.acSource, isRtl)}` : `source: ${sourceLabel(AC_SOURCE_LABEL, evm?.acSource, isRtl)}`,
    },
    { key: 'sv', title: 'Schedule Variance (SV)', formula: 'SV = EV − PV', value: fmtMoney(evm?.sv ?? null, isRtl), available: (evm?.sv ?? null) !== null },
    { key: 'cv', title: 'Cost Variance (CV)', formula: 'CV = EV − AC', value: fmtMoney(evm?.cv ?? null, isRtl), available: (evm?.cv ?? null) !== null },
    { key: 'spi', title: 'Schedule Performance Index (SPI)', formula: 'SPI = EV / PV', value: fmtIndex(evm?.spi), available: (evm?.spi ?? null) !== null },
    { key: 'cpi', title: 'Cost Performance Index (CPI)', formula: 'CPI = EV / AC', value: fmtIndex(evm?.cpi), available: (evm?.cpi ?? null) !== null },
    { key: 'eac', title: 'Estimate at Completion (EAC)', formula: 'EAC = BAC / CPI', value: fmtMoney(evm?.eac ?? null, isRtl), available: (evm?.eac ?? null) !== null },
    { key: 'vac', title: 'Variance at Completion (VAC)', formula: 'VAC = BAC − EAC', value: fmtMoney(evm?.vac ?? null, isRtl), available: (evm?.vac ?? null) !== null },
    { key: 'tcpi', title: 'To-Complete Performance Index (TCPI)', formula: 'TCPI = (BAC − EV) / (BAC − AC)', value: fmtIndex(evm?.tcpi), available: (evm?.tcpi ?? null) !== null },
    {
      key: 'earned',
      title: isRtl ? 'نسبة الإنجاز المكتسبة' : 'Earned Progress',
      formula: 'earned% = EV / BAC × 100',
      value: fmtPercent(evm?.earnedProgressPercent ?? null),
      available: (evm?.earnedProgressPercent ?? null) !== null,
    },
    {
      key: 'planned',
      title: isRtl ? 'نسبة الإنجاز المخططة' : 'Planned Progress',
      formula: 'planned% = PV / BAC × 100',
      value: fmtPercent(evm?.plannedProgressPercent ?? null),
      available: (evm?.plannedProgressPercent ?? null) !== null,
    },
    {
      key: 'datadate',
      title: isRtl ? 'تاريخ البيانات المعتمد' : 'Governed Data Date',
      formula: isRtl ? 'تاريخ القطع الذي حُسبت عنده كل القيم أعلاه' : 'The cutoff every value above was computed at',
      value: evm?.dataDate ?? NA,
      available: !!evm?.dataDate,
    },
  ];

  // Certificate: badge and wording follow the audit's own tallies, so a run with warnings or
  // violations can never render as an unconditional approval.
  const certBadge = !auditResult
    ? { label: NA, className: 'bg-slate-100 text-slate-600 border-slate-300' }
    : certificateVerdict === 'violations'
      ? {
          label: isRtl
            ? `مخالفات مفتوحة (${violationCount}) — درجة ${auditResult.ratingGrade}`
            : `OPEN VIOLATIONS (${violationCount}) — GRADE ${auditResult.ratingGrade}`,
          className: 'bg-red-100 text-red-800 border-red-300',
        }
      : certificateVerdict === 'warnings'
        ? {
            label: isRtl
              ? `اكتمل الفحص مع تحذيرات (${warningCount}) — درجة ${auditResult.ratingGrade}`
              : `AUDIT COMPLETED WITH WARNINGS (${warningCount}) — GRADE ${auditResult.ratingGrade}`,
            className: 'bg-amber-100 text-amber-800 border-amber-300',
          }
        : {
            label: `VERIFIED GRADE ${auditResult.ratingGrade}`,
            className: 'bg-emerald-100 text-emerald-800 border-emerald-300',
          };

  const projectName = project?.name ?? '';
  const certStatement = !auditResult
    ? NA
    : certificateVerdict === 'violations'
      ? isRtl
        ? `لا تُصدر هذه الشهادة إقراراً بالامتثال الكامل. خضعت بيانات المشروع "${projectName}" للفحص الآلي عبر ${auditResult.totalChecks} ضابطاً، ونتج عنه ${violationCount} مخالفة مفتوحة و${warningCount} تحذيراً، بدرجة ${auditResult.overallScore}% (${auditResult.ratingGrade}). البنود غير المطابقة: ${nonPassingList}. تجب معالجة المخالفات وإعادة الفحص قبل إصدار أي إقرار امتثال.`
        : `This certificate does NOT constitute a full-compliance attestation. Data for project "${projectName}" was audited across ${auditResult.totalChecks} controls, producing ${violationCount} open violations and ${warningCount} warnings, at ${auditResult.overallScore}% (${auditResult.ratingGrade}). Non-conforming controls: ${nonPassingList}. The violations must be resolved and the audit re-run before any compliance attestation is issued.`
      : certificateVerdict === 'warnings'
        ? isRtl
          ? `اكتمل الفحص الآلي لبيانات المشروع "${projectName}" مع تحذيرات: ${auditResult.totalChecks} ضابطاً، ${auditResult.passedCount} مطابق، ${warningCount} تحذير، دون مخالفات، بدرجة ${auditResult.overallScore}% (${auditResult.ratingGrade}). البنود الناقصة الأدلة أو غير القابلة للقياس: ${nonPassingList}. لا يُعلَن الامتثال الكامل قبل استيفائها.`
          : `The automated audit of data for project "${projectName}" completed WITH WARNINGS: ${auditResult.totalChecks} controls, ${auditResult.passedCount} passed, ${warningCount} warnings and no violations, at ${auditResult.overallScore}% (${auditResult.ratingGrade}). Controls lacking evidence or not measurable: ${nonPassingList}. Full compliance is not declared until they are closed.`
        : isRtl
          ? `تشهد هذه الشهادة بأن بيانات المشروع "${projectName}" اجتازت الفحص الآلي عبر ${auditResult.totalChecks} ضابطاً دون مخالفات ودون تحذير، بدرجة ${auditResult.overallScore}% (${auditResult.ratingGrade})، وفق الأدلة المسجلة في هذه الجولة.`
          : `This certifies that data for project "${projectName}" passed the automated audit across ${auditResult.totalChecks} controls with no violations and no warnings, scoring ${auditResult.overallScore}% (${auditResult.ratingGrade}), on the evidence recorded in this run.`;

  const fid02Note =
    fid02Check && fid02Check.status !== 'passed'
      ? isRtl
        ? ' ضابط المطابقة الثلاثية (أمر الشراء ↔ استلام المواد GRN ↔ فاتورة المورد) غير قابل للتحقق حالياً لأن النظام لا يحتوي سجلات أوامر شراء أو استلام مواد أو فواتير موردين، ولذلك هو مُعلَن N/A ضمن التحذيرات.'
        : ' The 3-way match control (PO ↔ GRN ↔ vendor invoice) cannot currently be verified because the system holds no purchase-order, goods-receipt or vendor-invoice records; it is therefore reported as N/A among the warnings.'
      : '';
  const certScopeStatement = !auditResult
    ? NA
    : isRtl
      ? `نطاق الإقرار: ${auditResult.passedCount} ضابطاً مطابقاً من أصل ${auditResult.totalChecks}، ${warningCount} تحذيراً، ${violationCount} مخالفة. لا يتضمن هذا الإقرار أي ضابط لم يُقيَّم فعلياً.${fid02Note}`
      : `Attestation scope: ${auditResult.passedCount} of ${auditResult.totalChecks} controls passed, ${warningCount} warnings, ${violationCount} violations. Nothing is attested here that was not actually evaluated.${fid02Note}`;

  if (loading || !auditResult) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent" />
        <p className="text-slate-600 font-medium">
          {isRtl ? 'جاري فحص وتدقيق حوكمة البيانات المتقاطعة...' : 'Executing Enterprise Data Governance Audit...'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fadeIn pb-12">
      {/* Executive Header Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-indigo-950 text-white p-6 rounded-2xl shadow-xl border border-slate-800 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-blue-500/10 rounded-full blur-2xl pointer-events-none" />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2.5 mb-2">
              <span className="px-3 py-1 rounded-full text-xs font-black bg-amber-400 text-slate-950 uppercase tracking-wider flex items-center gap-1.5 shadow-sm">
                <ShieldCheck size={14} className="stroke-[2.5]" />
                {isRtl ? 'مركز حوكمة البيانات والرقابة المتقاطعة' : 'Enterprise Data Governance & Cross-Module Parity'}
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                Grade {auditResult.ratingGrade} • {auditResult.overallScore}%
              </span>
            </div>
            <h1 className="text-2xl lg:text-3xl font-black tracking-tight text-white mb-2">
              {isRtl ? 'فحص جودة وتوافق البيانات وإلغاء التعارضات المالية والزمنية' : 'Data Integrity & Multi-Tier Variance Control Center'}
            </h1>
            <p className="text-slate-300 text-sm max-w-3xl leading-relaxed">
              {isRtl ? auditResult.summaryAr : auditResult.summaryEn}
            </p>
          </div>

          {/* Quick Action Control Strip */}
          <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-center">
            <button
              onClick={handleHarmonizeAll}
              disabled={harmonizing}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 text-slate-950 font-black text-xs hover:shadow-lg hover:shadow-amber-500/20 transition-all cursor-pointer disabled:opacity-50"
            >
              <Sparkles size={16} className={harmonizing ? 'animate-spin' : ''} />
              <span>{harmonizing ? (isRtl ? 'جاري التنسيق والمطابقة...' : 'Harmonizing...') : (isRtl ? 'تنسيق ومطابقة البيانات آلياً' : 'Auto-Harmonize All Data')}</span>
            </button>

            <button
              onClick={() => loadAllProjectEntities()}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 font-bold text-xs border border-slate-700 transition-colors cursor-pointer"
            >
              <RefreshCw size={14} />
              <span>{isRtl ? 'إعادة الفحص' : 'Re-Audit'}</span>
            </button>

            <button
              onClick={() => setActiveTab('certificate')}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-indigo-600/80 hover:bg-indigo-600 text-white font-bold text-xs border border-indigo-500/50 transition-colors cursor-pointer"
            >
              <Printer size={14} />
              <span>{isRtl ? 'شهادة الامتثال' : 'Audit Certificate'}</span>
            </button>
          </div>
        </div>

        {/* Harmonization Feedback Message */}
        {harmonizeFeedback && (
          <div className="mt-4 p-4 rounded-xl bg-slate-900/90 border border-emerald-500/50 text-xs text-emerald-200 animate-fadeIn space-y-1">
            <p className="font-bold flex items-center gap-2 text-emerald-400">
              <CheckCircle2 size={16} />
              {isRtl ? 'تقرير المطابقة والتنسيق الآلي المنجز:' : 'Harmonization Report:'}
            </p>
            {harmonizeFeedback.map((msg, idx) => (
              <p key={idx} className="text-slate-300 font-mono text-[11px] pl-4">
                • {msg}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Top 4 KPI Scorecard Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Overall Governance Score */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'درجة الامتثال الكلية' : 'Overall Conformance'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
              <Award size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-3xl font-black text-slate-900">{auditResult.overallScore}%</span>
            <span className="text-xs font-black px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
              Grade {auditResult.ratingGrade}
            </span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2 mt-3 overflow-hidden">
            <div
              className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${auditResult.overallScore}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {isRtl ? `${auditResult.passedCount} من أصل ${auditResult.totalChecks} معيار مطابق بالكامل` : `${auditResult.passedCount} of ${auditResult.totalChecks} checks fully passed`}
          </p>
        </div>

        {/* Card 2: SSOT Financial Triangulation */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'المطابقة المالية SSOT' : 'Financial SSOT Parity'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
              <Scale size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-2xl font-black text-slate-900">
              {contractValueAvailable && ssot ? ssot.contractValue.toLocaleString() : NA}
            </span>
            {contractValueAvailable && (
              <span className="text-xs font-bold text-slate-500">{isRtl ? 'ر.س' : 'SAR'}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className={`inline-block w-2 h-2 rounded-full ${ssotTone.dot}`} />
            <span className={`text-[11px] font-bold ${ssotTone.text}`}>
              {!ssot
                ? NA
                : !contractValueAvailable
                  ? (isRtl ? 'لا توجد قيمة تعاقدية مسجلة — المطابقة غير قابلة للتقييم' : 'No contract value recorded — parity cannot be assessed')
                  : ssot.isPerfectMatch
                    ? (isRtl ? 'مطابق: العقد = الكميات = الميزانية' : 'Reconciled: Contract = BOQ = BAC')
                    : (isRtl ? 'غير مطابق — يوجد فرق مالي غير مسوّى' : 'Not reconciled — unresolved financial variance')}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {!ssot
              ? NA
              : isRtl
                ? `أكبر فرق مسجَّل: ${fmtMoney(ssot.maxVarianceSar, isRtl)}`
                : `Max recorded variance: ${fmtMoney(ssot.maxVarianceSar, isRtl)}`}
          </p>
          <p className="text-[10px] text-slate-400 mt-1 font-mono">
            {isRtl ? 'الكميات (BOQ)' : 'BOQ'} {fmtMoney(ssot?.boqTotal, isRtl)} • {isRtl ? 'الميزانية (BAC)' : 'BAC'} {fmtMoney(ssot?.budgetBac, isRtl)}
          </p>
        </div>

        {/* Card 3: DCMA & CPM Structural Network */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'سلامة شبكة CPM' : 'CPM Network Integrity'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
              <Cpu size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className={`text-3xl font-black ${networkPillar ? scoreTone(networkPillar.score).text : 'text-slate-400'}`}>
              {networkPillar ? `${networkPillar.score}%` : NA}
            </span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${cpmTone.chip}`}>
              {networkPillar
                ? `${networkPillar.passed}/${networkPillar.total} ${isRtl ? 'فحوص الشبكة' : 'network checks'}`
                : NA}
            </span>
          </div>
          <p className="text-[11px] text-slate-600 mt-2 font-medium">
            {isRtl ? 'النهايات المفتوحة والليد السالب: ' : 'Open ends & negative leads: '}
            {net01 ? String(net01.actualValue) : NA}
          </p>
          <div className="text-[10px] text-slate-400 mt-1">
            {isRtl ? 'استمرارية المسار الحرج (DCMA-11): ' : 'Critical path continuity (DCMA-11): '}
            {net03 ? String(net03.actualValue).slice(0, 110) : NA}
          </div>
          <div className={`text-[10px] font-bold mt-1.5 ${cpmTone.text}`}>
            {isRtl ? `حالة ركيزة الشبكة: ${cpmTone.ar}` : `Network pillar status: ${cpmTone.en}`}
          </div>
        </div>

        {/* Card 4: Relational Foreign Key Integrity */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'سلامة الروابط والعلاقات' : 'Relational Parity'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center font-bold">
              <Database size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className={`text-3xl font-black ${relTone.text}`}>
              {orphanCount === null ? NA : orphanCount}
            </span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${relTone.chip}`}>
              {isRtl ? 'سجلات معزولة' : 'Orphan Records'}
            </span>
          </div>
          <p className="text-[11px] text-slate-600 mt-2 font-medium">
            {relCheck ? String(relCheck.actualValue) : NA}
          </p>
          <div className="text-[10px] text-slate-400 mt-1 line-clamp-2">
            {relCheck ? (isRtl ? relCheck.descriptionAr : relCheck.descriptionEn) : NA}
          </div>
          <div className={`text-[10px] font-bold mt-1.5 ${relTone.text}`}>
            {relCheck
              ? (isRtl ? `GOV-REL-01: ${relTone.ar}` : `GOV-REL-01: ${relTone.en}`)
              : NA}
          </div>
        </div>
      </div>

      {/* Interactive Navigation Tabs */}
      <div className="bg-white p-2 rounded-2xl border border-slate-200/80 shadow-xs flex flex-wrap gap-2">
        <button
          onClick={() => setActiveTab('pillars')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'pillars'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Layers size={15} className={activeTab === 'pillars' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'مصفوفة ركائز الحوكمة الست (6 Governance Pillars)' : '6 Governance Pillars Matrix'}</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-400 text-slate-950 font-black">
            {auditResult.checks.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('ssot')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'ssot'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Scale size={15} className={activeTab === 'ssot' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'ميزان المطابقة المالية الموحد (SSOT Triangulation)' : 'SSOT Financial Reconciliation'}</span>
        </button>

        <button
          onClick={() => setActiveTab('evm_math')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'evm_math'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <TrendingUp size={15} className={activeTab === 'evm_math' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'المدقق الرياضي لمؤشرات EVM (Mathematical Verifier)' : 'EVM Mathematical Verifier'}</span>
        </button>

        <button
          onClick={() => setActiveTab('certificate')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'certificate'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <FileCheck size={15} className={activeTab === 'certificate' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'شهادة الحوكمة والاعتماد الرسمي (Audit Certificate)' : 'Official Governance Certificate'}</span>
        </button>
      </div>

      {/* TAB 1: 6 Governance Pillars Matrix */}
      {activeTab === 'pillars' && (
        <div className="space-y-6">
          {/* Pillar Score Bars */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">
              {isRtl ? 'تحليل ركائز الحوكمة ومعدلات الامتثال' : 'Pillar Conformance Breakdown'}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {auditResult.pillars.map((pillar) => (
                <button
                  key={pillar.id}
                  onClick={() => setSelectedPillar(selectedPillar === pillar.id ? 'all' : pillar.id)}
                  className={`p-3.5 rounded-xl border text-right transition-all cursor-pointer ${
                    selectedPillar === pillar.id
                      ? 'border-amber-500 bg-amber-50/40 ring-1 ring-amber-500'
                      : 'border-slate-200 hover:border-slate-300 bg-slate-50/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-800">
                      {isRtl ? pillar.nameAr : pillar.nameEn}
                    </span>
                    <span className={`text-xs font-black px-2 py-0.5 rounded ${scoreTone(pillar.score).chip}`}>
                      {pillar.score}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-1.5 rounded-full ${scoreTone(pillar.score).bar}`}
                      style={{ width: `${pillar.score}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-slate-400 mt-2 font-mono">
                    {pillar.passed}/{pillar.total} {isRtl ? 'معايير مجتازة' : 'checks passed'}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Search & Filter Header */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search size={16} className={`absolute top-3 ${isRtl ? 'right-3' : 'left-3'} text-slate-400`} />
              <input
                type="text"
                placeholder={isRtl ? 'البحث في المعايير والنتائج والتوصيات...' : 'Search governance checks, rules, impacts...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`w-full py-2 ${isRtl ? 'pr-9 pl-4' : 'pl-9 pr-4'} text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500`}
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-500 flex items-center gap-1">
                <Filter size={13} />
                {isRtl ? 'تصفية الركيزة:' : 'Filter Pillar:'}
              </span>
              <select
                value={selectedPillar}
                onChange={(e) => setSelectedPillar(e.target.value)}
                className="text-xs font-bold bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-amber-500"
              >
                <option value="all">{isRtl ? 'كافة الركائز (الكل)' : 'All Pillars'}</option>
                <option value="network_cpm">{isRtl ? 'شبكة CPM وهندسة DCMA' : 'CPM Network'}</option>
                <option value="ssot_financial">{isRtl ? 'المطابقة المالية SSOT' : 'Financial SSOT'}</option>
                <option value="relational_fk">{isRtl ? 'سلامة الروابط والعلاقات' : 'Relational Integrity'}</option>
                <option value="evm_math">{isRtl ? 'الدقة الرياضية لـ EVM' : 'EVM Mathematics'}</option>
                <option value="fidic_commercial">{isRtl ? 'الضوابط وعقود الباطن' : 'FIDIC & Commercial'}</option>
                <option value="temporal_sequence">{isRtl ? 'التسلسل وتاريخ البيانات' : 'Temporal & Data Date'}</option>
              </select>
            </div>
          </div>

          {/* Checks Matrix Table */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-900 text-white font-bold">
                    <th className="p-3 text-center w-16">{isRtl ? 'الحالة' : 'Status'}</th>
                    <th className="p-3 w-28">{isRtl ? 'الكود والمعيار' : 'Code & Rule'}</th>
                    <th className="p-3">{isRtl ? 'معيار الفحص والتحقق' : 'Verification Objective'}</th>
                    <th className="p-3">{isRtl ? 'القيمة المستهدفة' : 'Expected'}</th>
                    <th className="p-3">{isRtl ? 'القيمة الفعلية المحسوبة' : 'Actual'}</th>
                    <th className="p-3 text-center w-24">{isRtl ? 'الانحراف' : 'Variance'}</th>
                    <th className="p-3 text-center w-16">{isRtl ? 'تفاصيل' : 'Details'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredChecks.map((item) => {
                    const isExpanded = expandedCheckId === item.id;
                    return (
                      <Fragment key={item.id}>
                        <tr
                          onClick={() => setExpandedCheckId(isExpanded ? null : item.id)}
                          className="hover:bg-slate-50/80 transition-colors cursor-pointer font-medium"
                        >
                          <td className="p-3 text-center">
                            {item.status === 'passed' && (
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700">
                                <CheckCircle2 size={14} />
                              </span>
                            )}
                            {item.status === 'warning' && (
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 text-amber-700">
                                <AlertTriangle size={14} />
                              </span>
                            )}
                            {item.status === 'violation' && (
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-700">
                                <XCircle size={14} />
                              </span>
                            )}
                          </td>
                          <td className="p-3">
                            <span className="font-mono font-black text-slate-800 bg-slate-100 px-2 py-0.5 rounded text-[11px]">
                              {item.code}
                            </span>
                          </td>
                          <td className="p-3">
                            <p className="font-bold text-slate-900">{isRtl ? item.titleAr : item.titleEn}</p>
                            <p className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">
                              {isRtl ? item.descriptionAr : item.descriptionEn}
                            </p>
                          </td>
                          <td className="p-3 text-slate-700 font-mono text-[11px]">
                            {item.expectedValue}
                          </td>
                          <td className="p-3 text-slate-900 font-mono font-bold text-[11px]">
                            {item.actualValue}
                          </td>
                          <td className="p-3 text-center font-mono font-bold text-[11px]">
                            <span className={`px-2 py-0.5 rounded ${STATUS_TONE[item.status].chip}`}>
                              {item.variance}
                            </span>
                          </td>
                          <td className="p-3 text-center text-slate-400">
                            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-slate-50/90 border-t border-b border-slate-200">
                            <td colSpan={7} className="p-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                <div className="space-y-2 bg-white p-3.5 rounded-xl border border-slate-200">
                                  <p className="font-bold text-slate-800 flex items-center gap-1.5">
                                    <ShieldCheck size={15} className="text-amber-500" />
                                    {isRtl ? 'الأثر الفني والقانوني للمعيار:' : 'Contractual & Operational Impact:'}
                                  </p>
                                  <p className="text-slate-600 leading-relaxed text-[11px]">
                                    {isRtl ? item.impactAr : item.impactEn}
                                  </p>
                                </div>

                                <div className="space-y-2 bg-white p-3.5 rounded-xl border border-slate-200">
                                  <p className="font-bold text-slate-800 flex items-center gap-1.5">
                                    <Wrench size={15} className="text-blue-500" />
                                    {isRtl ? 'آلية الحوكمة والتحقق التلقائي:' : 'Governance Control Mechanism:'}
                                  </p>
                                  <p className="text-slate-600 leading-relaxed text-[11px]">
                                    {isRtl
                                      ? 'يُقيَّم هذا الضابط عند تشغيل فحص الحوكمة على بيانات المشروع المحمّلة حالياً، وتُعرض قيمه المستهدفة والفعلية كما أعادها المحرك دون تعديل.'
                                      : 'This control is evaluated when the governance audit runs over the currently loaded project data; its expected and actual values are shown exactly as the engine returned them.'}
                                  </p>
                                  {item.fixActionNameAr && (
                                    <button
                                      onClick={handleHarmonizeAll}
                                      className="mt-2 text-[11px] font-bold text-amber-700 hover:text-amber-800 flex items-center gap-1 cursor-pointer"
                                    >
                                      <span>{isRtl ? item.fixActionNameAr : item.fixActionNameEn}</span>
                                      <ArrowRight size={12} className={isRtl ? 'rotate-180' : ''} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: SSOT Financial Triangulation — every figure bound to auditResult.financialSsot */}
      {activeTab === 'ssot' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-xs">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
              <div>
                <h3 className="text-base font-black text-slate-900">
                  {isRtl ? 'مصفوفة المطابقة المالية الموحدة (Single Source of Truth - SSOT)' : 'Master Financial Triangulation Matrix'}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {isRtl
                    ? 'مقابلة القيمة التعاقدية مع إجمالي جدول الكميات (BOQ) وخطوط الميزانية المعتمدة (BAC) بالأرقام التي أعادها محرك الحوكمة كما هي. المرجعيات التي لا تملك قيمة موثوقة تظهر N/A.'
                    : 'Contract value against the BOQ total and the approved budget lines (BAC), using exactly the figures the governance engine returned. References without an authoritative value are shown as N/A.'}
                </p>
              </div>

              <div
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl border ${
                  ssotStatus === 'passed' ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
                }`}
              >
                {ssotStatus === 'passed' ? (
                  <CheckCircle2 size={16} className="text-emerald-600" />
                ) : (
                  <AlertTriangle size={16} className="text-amber-600" />
                )}
                <span className={`text-xs font-black ${ssotStatus === 'passed' ? 'text-emerald-800' : 'text-amber-800'}`}>
                  {!ssot
                    ? NA
                    : !contractValueAvailable
                      ? (isRtl ? 'لا توجد قيمة تعاقدية — المطابقة غير قابلة للتقييم' : 'No contract value — parity cannot be assessed')
                      : ssot.isPerfectMatch
                        ? (isRtl
                            ? `مطابق ضمن حد المحرك (< 1 ر.س) — أكبر فرق ${fmtMoney(ssot.maxVarianceSar, isRtl)}`
                            : `Matched within the engine tolerance (< 1 SAR) — max variance ${fmtMoney(ssot.maxVarianceSar, isRtl)}`)
                        : (isRtl
                            ? `فرق مالي غير مسوّى: ${fmtMoney(ssot.maxVarianceSar, isRtl)}`
                            : `Unresolved financial variance: ${fmtMoney(ssot.maxVarianceSar, isRtl)}`)}
                </span>
              </div>
            </div>

            {/* Reconciliation Comparison Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-800 font-bold border-b border-slate-200">
                    <th className="p-3">{isRtl ? 'المرجعية المالية للمشروع' : 'Financial Domain Reference'}</th>
                    <th className="p-3">{isRtl ? 'المصدر الأساسي' : 'Primary Source'}</th>
                    <th className="p-3 text-center">{isRtl ? 'القيمة المسجلة (ر.س)' : 'Recorded Amount (SAR)'}</th>
                    <th className="p-3 text-center">{isRtl ? 'نسبة التطابق' : 'Parity %'}</th>
                    <th className="p-3 text-center">{isRtl ? 'الفارق المالي' : 'Variance'}</th>
                    <th className="p-3 text-center">{isRtl ? 'حالة الحوكمة' : 'Audit Status'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {ssotRows.map((row, idx) => {
                    const hasAmount = row.amount !== null;
                    const comparable = hasAmount && !row.isReference && referenceAmount !== null && referenceAmount > 0;
                    const variance = comparable ? (row.amount as number) - (referenceAmount as number) : null;
                    const matched = variance !== null && Math.abs(variance) < 1;
                    const rowTone = !hasAmount
                      ? NEUTRAL_TONE
                      : row.isReference || matched
                        ? STATUS_TONE.passed
                        : STATUS_TONE.warning;
                    return (
                      <tr key={row.key}>
                        <td className="p-3.5 font-bold text-slate-900">
                          {idx + 1}. {isRtl ? row.labelAr : row.labelEn}
                        </td>
                        <td className="p-3 text-slate-600">{isRtl ? row.sourceAr : row.sourceEn}</td>
                        <td className="p-3 text-center font-mono font-bold text-slate-900">
                          {hasAmount
                            ? (row.amount as number).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })
                            : NA}
                        </td>
                        <td className={`p-3 text-center font-mono font-bold ${rowTone.text}`}>
                          {row.isReference
                            ? (isRtl ? 'المرجع' : 'Reference')
                            : comparable
                              ? `${(((row.amount as number) / (referenceAmount as number)) * 100).toFixed(2)}%`
                              : NA}
                        </td>
                        <td className={`p-3 text-center font-mono ${rowTone.text}`}>
                          {variance === null
                            ? row.isReference
                              ? '—'
                              : NA
                            : `${variance > 0 ? '+' : variance < 0 ? '−' : ''}${Math.abs(Math.round(variance)).toLocaleString()} ر.س`}
                        </td>
                        <td className="p-3 text-center">
                          <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${rowTone.chip}`}>
                            {!hasAmount
                              ? (isRtl ? 'غير متاح' : 'Not available')
                              : row.isReference
                                ? (isRtl ? 'مرجع المطابقة' : 'Parity reference')
                                : matched
                                  ? (isRtl ? 'مطابق' : 'Matched')
                                  : (isRtl ? 'فرق غير مسوّى' : 'Unresolved variance')}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-slate-500 mt-4 leading-relaxed">
              {isRtl
                ? `المرجعيات المتاحة للمطابقة: ${ssotAvailableCount} من ${ssotRows.length}. لا تُعلَن مطابقة خماسية لأن نتيجة التدقيق الحالية لا توفر قيمة مستقلة لأحمال خط الأساس ولا هدفاً معتمداً لمنحنى S (financialSsot.baselineCost نسخة من إجمالي BOQ داخل المحرك)، لذلك يظهر هذان الصفّان N/A بدل نسخ القيمة التعاقدية.`
                : `References available for parity: ${ssotAvailableCount} of ${ssotRows.length}. No five-way parity is claimed: the current audit result provides no independent value for the baseline cost load and no authoritative S-Curve target (financialSsot.baselineCost is a copy of the BOQ total inside the engine), so those two rows show N/A instead of repeating the contract value.`}
            </p>
          </div>
        </div>
      )}

      {/* TAB 3: EVM Mathematical Verifier — bound to auditResult.evmParity only */}
      {activeTab === 'evm_math' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-xs">
            <h3 className="text-base font-black text-slate-900 mb-2">
              {isRtl ? 'المدقق الرياضي لمعادلات إدارة القيمة المكتسبة (EVM Mathematics Rigor)' : 'EVM Mathematical Verifier & Precision Engine'}
            </h3>
            <p className="text-xs text-slate-500 mb-6">
              {isRtl
                ? 'كل قيمة أدناه منسوخة كما هي من محرك EVM القانوني عند تاريخ البيانات المعتمد، ودور هذه الشاشة هو التنسيق فقط. أي مدخل لا يستطيع المحرك اشتقاقه يظهر N/A — لا يُستبدل بصفر ولا بأي رقم بديل، والصفر الظاهر هو صفر مقاس فعلاً.'
                : 'Every value below is copied verbatim from the canonical EVM engine at the governed data date; this screen only formats it. Any input the engine cannot derive is shown as N/A — never substituted with zero or another figure, and a displayed zero is a measured zero.'}
            </p>

            {/* Verdict banner — the status is the governance check's own, not a literal badge */}
            <div className={`p-4 rounded-xl border border-slate-200 mb-5 ${evmBannerTone.chip}`}>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <span className="text-xs font-black">
                  {evmCheck
                    ? isRtl
                      ? `حالة الضابط GOV-EVM-01: ${evmBannerTone.ar}`
                      : `GOV-EVM-01 status: ${evmBannerTone.en}`
                    : NA}
                </span>
                <span className="text-[11px] font-mono font-bold">
                  {isRtl ? 'تاريخ البيانات: ' : 'Data date: '}
                  {evm?.dataDate ?? NA}
                  {' • '}
                  {evm?.isRigorous
                    ? isRtl
                      ? 'كل المؤشرات مقاسة من مدخلات حقيقية'
                      : 'all indices measured from real inputs'
                    : isRtl
                      ? 'بعض المدخلات غير متاحة — قيمها N/A'
                      : 'some inputs unavailable — shown as N/A'}
                </span>
              </div>
              <p className="text-[11px] mt-2 leading-relaxed font-mono">
                {evmCheck ? String(evmCheck.actualValue) : NA}
              </p>
              <p className="text-[10px] mt-1.5 opacity-80 font-mono">
                {isRtl ? 'مصدر BAC: ' : 'BAC source: '}
                {sourceLabel(BAC_SOURCE_LABEL, evm?.bacSource, isRtl)}
                {' • '}
                {isRtl ? 'مصدر AC: ' : 'AC source: '}
                {sourceLabel(AC_SOURCE_LABEL, evm?.acSource, isRtl)}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {evmCards.map((card) => {
                const tone = card.available && evmCheck ? STATUS_TONE[evmCheck.status] : NEUTRAL_TONE;
                return (
                  <div key={card.key} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-500">{card.title}</span>
                      <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${tone.chip}`}>
                        {card.available && evmCheck ? (isRtl ? tone.ar : tone.en) : NA}
                      </span>
                    </div>
                    <p className="text-xs font-mono font-bold text-slate-800">{card.formula}</p>
                    <p className="text-xs text-slate-600 font-mono">
                      <strong className="text-slate-950 font-bold">{card.value}</strong>
                    </p>
                    {card.note && <p className="text-[10px] text-slate-500 font-mono">{card.note}</p>}
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] text-slate-500 mt-5 leading-relaxed">
              {evmCheck
                ? isRtl
                  ? `الأثر المتوقع: ${evmCheck.impactAr}`
                  : `Expected impact: ${evmCheck.impactEn}`
                : NA}
            </p>
          </div>
        </div>
      )}

      {/* TAB 4: Governance Certificate — verdict derived from the audit's own tallies */}
      {activeTab === 'certificate' && (
        <div className="bg-white p-8 rounded-2xl border border-slate-300 shadow-md max-w-4xl mx-auto print:p-0 print:border-none print:shadow-none">
          <div className="flex justify-between items-start border-b-2 border-slate-900 pb-6 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-slate-950 text-amber-400 flex items-center justify-center font-bold">
                <Award size={28} />
              </div>
              <div>
                <h2 className="text-xl font-black text-slate-950 uppercase tracking-tight">
                  {isRtl ? 'شهادة الحوكمة والاعتماد الرقمي للبيانات' : 'Certificate of Data Governance & Integrity'}
                </h2>
                <p className="text-xs text-slate-500 font-mono">
                  ISO 21500 • PMI PMBOK 7th Ed. • DCMA 14-Point • FIDIC Red Book
                </p>
              </div>
            </div>

            <div className="text-left">
              <span
                className={`inline-block px-3 py-1 rounded-full text-xs font-mono font-black border ${certBadge.className}`}
              >
                {certBadge.label}
              </span>
              <p className="text-[10px] text-slate-400 mt-1 font-mono">
                Audit Date: {new Date(auditResult.auditTimestamp).toLocaleDateString()}
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5 font-mono">
                {isRtl ? 'النتيجة' : 'Score'}: {auditResult.overallScore}% • Grade {auditResult.ratingGrade} •{' '}
                {isRtl ? 'تحذيرات' : 'warnings'} {warningCount} / {isRtl ? 'مخالفات' : 'violations'} {violationCount}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-xs text-slate-700 leading-relaxed mb-6">
            <p>{certStatement}</p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4 p-4 bg-slate-50 rounded-xl border border-slate-200 text-center">
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">
                  {isRtl ? 'القيمة التعاقدية' : 'Contract Value'}
                </p>
                <p className="text-sm font-black text-slate-900 font-mono mt-0.5">
                  {contractValueAvailable && ssot ? `${ssot.contractValue.toLocaleString()} ر.س` : NA}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">
                  {isRtl ? 'درجة الجودة' : 'Quality Score'}
                </p>
                <p className={`text-sm font-black font-mono mt-0.5 ${scoreTone(auditResult.overallScore).text}`}>
                  {auditResult.overallScore}% ({auditResult.ratingGrade})
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">
                  {isRtl ? 'ركيزة شبكة CPM' : 'CPM Network Pillar'}
                </p>
                <p
                  className={`text-sm font-black font-mono mt-0.5 ${
                    networkPillar ? scoreTone(networkPillar.score).text : 'text-slate-400'
                  }`}
                >
                  {networkPillar ? `${networkPillar.score}% (${networkPillar.passed}/${networkPillar.total})` : NA}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">
                  {isRtl ? 'السجلات المعزولة' : 'Orphan FK'}
                </p>
                <p className={`text-sm font-black font-mono mt-0.5 ${relTone.text}`}>
                  {orphanCount === null ? NA : `${orphanCount} (${isRtl ? relTone.ar : relTone.en})`}
                </p>
              </div>
            </div>

            <p className="text-slate-600 text-[11px] leading-relaxed">
              {isRtl ? auditResult.summaryAr : auditResult.summaryEn}
            </p>

            <p className="text-slate-500 text-[11px] leading-relaxed">{certScopeStatement}</p>
          </div>

          <div className="pt-6 border-t border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-4 text-[11px] text-slate-500">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className={certificateVerdict === 'clean' ? 'text-emerald-600' : 'text-amber-600'} />
              <span>{isRtl ? 'نظام الحوكمة الرقمي المعتمد' : 'Automated Enterprise Governance Engine'}</span>
            </div>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-colors cursor-pointer print:hidden"
            >
              <Printer size={14} />
              <span>{isRtl ? 'طباعة الشهادة الرسمية' : 'Print Certificate'}</span>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

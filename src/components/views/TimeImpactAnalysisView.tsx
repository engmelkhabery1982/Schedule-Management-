import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type {
  Activity,
  ActivityLink,
  DelayClaimEvent,
  DelayEventType,
  DelayResponsibility,
  P6Calendar,
  Project,
} from '@/types';
import { isAfterDataDate, resolveDataDate } from '@/lib/chronologyGuard';
import {
  assessConcurrencyEvidence,
  performTimeImpactAnalysis,
  recommendEot,
  TIA_ANALYSIS_METHOD,
  type TIAAnalysisResult,
  type TIAConcurrencyAssessment,
  type TIAEotRecommendation,
} from '@/lib/tiaEngine';
import type { CpmOptions } from '@/lib/cpmEngine';
import {
  AlertOctagon,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  DollarSign,
  FileText,
  GitPullRequest,
  Layers,
  Plus,
  Scale,
} from 'lucide-react';

interface TimeImpactAnalysisViewProps {
  project: Project | null;
}

type TabType = 'claims' | 'windows' | 'concurrency' | 'float_governance';
type FormEventType = DelayEventType | '';
type FormResponsibility = DelayResponsibility | '';

interface TIAFormState {
  claimNumber: string;
  title: string;
  description: string;
  eventType: FormEventType;
  responsibility: FormResponsibility;
  insertionLinkId: string;
  delayDurationDays: string;
  impactStartDate: string;
  dailyIndirectCostRate: string;
  contractualClause: string;
}

const INITIAL_FORM: TIAFormState = {
  claimNumber: '',
  title: '',
  description: '',
  eventType: '',
  responsibility: '',
  insertionLinkId: '',
  delayDurationDays: '',
  impactStartDate: '',
  dailyIndirectCostRate: '',
  contractualClause: '',
};

const EVENT_TYPE_LABELS: Record<DelayEventType, { en: string; ar: string }> = {
  client_delay: { en: 'Client delay', ar: 'تأخير العميل' },
  consultant_review_delay: { en: 'Consultant review delay', ar: 'تأخير مراجعة الاستشاري' },
  differing_site_conditions: { en: 'Differing site conditions', ar: 'ظروف موقع مختلفة' },
  variation_order: { en: 'Variation order', ar: 'أمر تغييري' },
  force_majeure: { en: 'Force majeure', ar: 'قوة قاهرة' },
  contractor_delay: { en: 'Contractor delay', ar: 'تأخير المقاول' },
};

function displayDate(value: string | null | undefined): string {
  return value || 'N/A';
}

function displayNumber(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'N/A'
    : `${value.toLocaleString()}${suffix}`;
}

function enrichStoredClaim(
  claim: DelayClaimEvent,
  recordedClaims: DelayClaimEvent[],
  dataDate: string,
): TIAAnalysisResult {
  const concurrencyAssessment = assessConcurrencyEvidence(claim, recordedClaims, dataDate);
  const hasVerifiedCpmMethod = claim.analysis_method === TIA_ANALYSIS_METHOD;
  const eotRecommendation = claim.status === 'approved_eot' || hasVerifiedCpmMethod
    ? recommendEot(claim, concurrencyAssessment)
    : {
        status: 'unproven' as const,
        days: null,
        note: 'Unproven / N/A — this stored record has no verified single-fragnet CPM measurement or approved EOT determination.',
      };
  return {
    ...claim,
    scenarioActivities: [],
    scenarioLinks: [],
    concurrencyAssessment,
    eotRecommendation,
    assumptions: hasVerifiedCpmMethod
      ? [
          'Stored delay event record; the in-memory scenario network is not persisted.',
          concurrencyAssessment.note,
          typeof claim.daily_indirect_cost_rate !== 'number'
            ? 'No user/contract daily rate is recorded.'
            : `Recorded daily rate: ${claim.daily_indirect_cost_rate}.`,
        ]
      : [
          'Stored record has no verified single-fragnet analysis-method marker; its CPM impact and event window are not treated as measured evidence.',
          'No source schedule scenario network is available in this stored record.',
        ],
  };
}

export default function TimeImpactAnalysisView({ project }: TimeImpactAnalysisViewProps) {
  const [activeTab, setActiveTab] = useState<TabType>('claims');
  const [claims, setClaims] = useState<TIAAnalysisResult[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [calendars, setCalendars] = useState<P6Calendar[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadNotice, setLoadNotice] = useState('');
  const [analysisError, setAnalysisError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);
  const [lang, setLang] = useState<Language>(getLanguage());
  const [form, setForm] = useState<TIAFormState>(INITIAL_FORM);

  const governedDataDate = useMemo(() => resolveDataDate(project), [project]);
  const cpmOptions = useMemo<CpmOptions>(() => ({
    calendarType: project?.calendar_type || '6_days',
    dataDate: governedDataDate,
    statusLogic: project?.status_logic || 'retained_logic',
    calendars,
  }), [project?.calendar_type, project?.status_logic, governedDataDate, calendars]);

  useEffect(() => {
    if (project) {
      void loadData();
    } else {
      setActivities([]);
      setLinks([]);
      setCalendars([]);
      setClaims([]);
      setLoading(false);
    }

    const handleLangChange = (event: Event) => {
      const detail = (event as CustomEvent<{ lang?: Language }>).detail;
      setLang(detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
    // loadData intentionally snapshots the active project for each project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    setLoadNotice('');
    const [activityResult, linkResult, calendarResult, claimResult] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('calendars').select('*').eq('project_id', project.id),
      supabase.from('delay_claims').select('*').eq('project_id', project.id).order('created_at', { ascending: false }),
    ]);

    const sourceError = activityResult.error || linkResult.error || calendarResult.error;
    if (sourceError) {
      setActivities([]);
      setLinks([]);
      setCalendars([]);
      setClaims([]);
      setLoadNotice(`Unable to load the project schedule: ${sourceError.message}`);
      setLoading(false);
      return;
    }

    const loadedActivities = (activityResult.data || []) as Activity[];
    const loadedLinks = (linkResult.data || []) as ActivityLink[];
    const loadedCalendars = (calendarResult.data || []) as P6Calendar[];
    const loadedClaims = claimResult.error ? [] : ((claimResult.data || []) as DelayClaimEvent[]);

    setActivities(loadedActivities);
    setLinks(loadedLinks);
    setCalendars(loadedCalendars);
    setClaims(loadedClaims.map((claim) => enrichStoredClaim(claim, loadedClaims, governedDataDate)));
    setExpandedClaimId(loadedClaims[0]?.id || null);

    if (claimResult.error) {
      setLoadNotice('No delay-claim records could be loaded. New TIA scenarios remain in this session only.');
    }
    setLoading(false);
  }

  const selectableLinks = useMemo(() => {
    const activityIds = new Set(activities.map((activity) => activity.id));
    return links.filter((link) => activityIds.has(link.predecessor_id) && activityIds.has(link.successor_id));
  }, [activities, links]);

  function activityName(activityId: string): string {
    const activity = activities.find((item) => item.id === activityId);
    return activity ? `${activity.code} — ${activity.name}` : activityId;
  }

  function linkDescription(link: ActivityLink): string {
    return `${activityName(link.predecessor_id)} → ${activityName(link.successor_id)} (${link.link_type}, lag ${link.lag_days}d)`;
  }

  function handleCreateClaim() {
    setAnalysisError('');
    if (!project) return;
    if (!form.eventType || !form.responsibility) {
      setAnalysisError('Select an event type and record the responsibility classification.');
      return;
    }

    const parsedRate = form.dailyIndirectCostRate.trim() === '' ? null : Number(form.dailyIndirectCostRate);
    try {
      const result = performTimeImpactAnalysis({
        projectId: project.id,
        claimNumber: form.claimNumber,
        title: form.title,
        description: form.description,
        eventType: form.eventType,
        responsibility: form.responsibility,
        insertionLinkId: form.insertionLinkId,
        delayDurationDays: Number(form.delayDurationDays),
        impactStartDate: form.impactStartDate,
        dailyIndirectCostRate: parsedRate,
        contractualClause: form.contractualClause,
        activities,
        links,
        cpmOptions,
        recordedClaims: claims,
      });

      // This is a local analysis record only; neither the source schedule nor its links are saved.
      setClaims((previous) => [result, ...previous]);
      setExpandedClaimId(result.id);
      setForm(INITIAL_FORM);
      setShowAddModal(false);
      setActiveTab('claims');
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'TIA analysis could not be completed.');
    }
  }

  const floatGovernanceList = useMemo(() => activities.map((activity) => {
    const totalFloat = Number(activity.total_float || 0);
    const isCritical = activity.is_critical;
    let ownershipStatusEn = 'Available for Project';
    let ownershipStatusAr = 'متاح للمشروع';

    if (isCritical) {
      ownershipStatusEn = 'Critical — zero float';
      ownershipStatusAr = 'مسار حرج — هامش صفري';
    } else if (totalFloat < 5) {
      ownershipStatusEn = 'Near-critical float';
      ownershipStatusAr = 'هامش قريب من الحرج';
    }

    return {
      id: activity.id,
      code: activity.code,
      name: activity.name,
      totalFloat,
      isCritical,
      ownershipStatusEn,
      ownershipStatusAr,
    };
  }), [activities]);

  function responsibilityBadge(responsibility: DelayResponsibility) {
    if (responsibility === 'excusable_compensable') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
          <CheckCircle2 size={12} />
          {lang === 'ar' ? 'تصنيف مسجل: مبرر مع تعويض' : 'Recorded: excusable / compensable'}
        </span>
      );
    }
    if (responsibility === 'excusable_non_compensable') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800">
          <Clock size={12} />
          {lang === 'ar' ? 'تصنيف مسجل: مبرر دون تعويض' : 'Recorded: excusable / non-compensable'}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-bold text-red-800">
        <AlertOctagon size={12} />
        {lang === 'ar' ? 'تصنيف مسجل: غير مبرر' : 'Recorded: non-excusable'}
      </span>
    );
  }

  function concurrencyFor(claim: TIAAnalysisResult): TIAConcurrencyAssessment {
    return claim.concurrencyAssessment || assessConcurrencyEvidence(claim, claims, governedDataDate);
  }

  function eotFor(claim: TIAAnalysisResult): TIAEotRecommendation {
    return claim.eotRecommendation || recommendEot(claim, concurrencyFor(claim));
  }

  function recommendationLabel(recommendation: TIAEotRecommendation): string {
    if (recommendation.status === 'approved') return `${recommendation.days ?? 'N/A'} ${lang === 'ar' ? 'يوم معتمد مسجل' : 'approved days recorded'}`;
    if (recommendation.status === 'not_recommended' && recommendation.days === 0) return lang === 'ar' ? '0 يوم — لم يقس CPM حركة في نهاية المشروع' : '0 days — CPM measured no finish movement';
    if (recommendation.status === 'not_recommended') return lang === 'ar' ? 'غير موصى به وفق التصنيف المسجل' : 'Not recommended under recorded classification';
    return 'Unproven / N/A';
  }

  function approvedCost(claim: TIAAnalysisResult): number | null {
    return claim.status === 'approved_eot' &&
      !isAfterDataDate(claim.start_date, governedDataDate) &&
      typeof claim.compensation_claimed_sar === 'number' &&
      Number.isFinite(claim.compensation_claimed_sar)
      ? claim.compensation_claimed_sar
      : null;
  }

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  const occurredClaims = claims.filter((claim) => !isAfterDataDate(claim.start_date, governedDataDate));
  const approvedClaims = occurredClaims.filter((claim) => claim.status === 'approved_eot');
  const claimsWithApprovedEot = approvedClaims.filter((claim) => typeof claim.eot_days_claimed === 'number' && Number.isFinite(claim.eot_days_claimed));
  const claimsWithApprovedCost = approvedClaims.filter((claim) => typeof claim.compensation_claimed_sar === 'number' && Number.isFinite(claim.compensation_claimed_sar));
  const approvedEotDays = claimsWithApprovedEot.reduce((sum, claim) => sum + (claim.eot_days_claimed ?? 0), 0);
  const approvedCompensation = claimsWithApprovedCost.reduce((sum, claim) => sum + (claim.compensation_claimed_sar ?? 0), 0);
  const futureClaims = claims.filter((claim) => isAfterDataDate(claim.start_date, governedDataDate));
  const unprovenClaims = claims.filter((claim) => claim.status !== 'approved_eot' && claim.status !== 'rejected');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <Scale className="text-blue-600" size={24} />
            {lang === 'ar' ? 'تحليل الأثر الزمني ومطالبات تمديد الوقت (TIA)' : 'Time Impact Analysis & EOT Evidence'}
          </h1>
          <p className="mt-1 max-w-3xl text-xs text-slate-500">
            {lang === 'ar'
              ? 'تحليل للقراءة فقط: خط أساس CPM للحالة القائمة، وإدخال Fragnet واحد على علاقة يحددها المستخدم. لا يتغير الجدول الأصلي.'
              : 'Read-only analysis: statused CPM baseline, then one user-defined fragnet insertion. The source schedule is not changed.'}
          </p>
        </div>
        <button
          onClick={() => { setAnalysisError(''); setShowAddModal(true); }}
          disabled={selectableLinks.length === 0}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-md transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={15} />
          {lang === 'ar' ? 'تحليل Fragnet جديد' : 'New Fragnet Analysis'}
        </button>
      </div>

      {loadNotice && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{loadNotice}</div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2">
        {([
          ['claims', FileText, lang === 'ar' ? 'تحليل الأحداث و EOT' : 'Events & EOT'],
          ['windows', Layers, lang === 'ar' ? 'النوافذ الزمنية' : 'Time Windows'],
          ['concurrency', GitPullRequest, lang === 'ar' ? 'أدلة التزامن' : 'Concurrency Evidence'],
          ['float_governance', Clock, lang === 'ar' ? 'حوكمة الهوامش' : 'Float Ownership'],
        ] as const).map(([tab, Icon, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-all ${activeTab === tab ? 'bg-slate-900 text-amber-400 shadow-sm' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><FileText size={23} /></div>
          <div>
            <div className="text-2xl font-bold text-slate-800">{claims.length}</div>
            <span className="text-xs text-slate-500">{lang === 'ar' ? 'سجلات أحداث التأخير المتاحة' : 'Available delay-event records'}</span>
            <span className="block text-[10px] font-semibold text-slate-400">{futureClaims.length} {lang === 'ar' ? 'سيناريو مستقبلي بعد تاريخ الحالة' : 'future scenario(s) after the data date'}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><Clock size={23} /></div>
          <div>
            <div className="text-2xl font-bold text-amber-700">
              {claimsWithApprovedEot.length ? `+${approvedEotDays}` : 'N/A'} {lang === 'ar' && claimsWithApprovedEot.length ? 'يوم' : claimsWithApprovedEot.length ? 'days' : ''}
            </div>
            <span className="text-xs text-slate-500">{lang === 'ar' ? 'أيام EOT المعتمدة والمسجلة' : 'Recorded approved EOT days'}</span>
            <span className="block text-[10px] font-semibold text-slate-400">{unprovenClaims.length} {lang === 'ar' ? 'بانتظار إثبات/تحديد الأحقية' : 'claim(s) remain unproven or undetermined'}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><DollarSign size={23} /></div>
          <div>
            <div className="text-2xl font-bold text-emerald-700">
              {claimsWithApprovedCost.length ? `${approvedCompensation.toLocaleString()} SAR` : 'N/A'}
            </div>
            <span className="text-xs text-slate-500">{lang === 'ar' ? 'تكاليف إطالة معتمدة ومسجلة' : 'Recorded approved prolongation cost'}</span>
            <span className="block text-[10px] font-semibold text-slate-400">{lang === 'ar' ? 'لا يُفترض أي معدل يومي' : 'No daily rate is assumed'}</span>
          </div>
        </div>
      </div>

      {activeTab === 'claims' && (
        <div className="space-y-4">
          {claims.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
              {lang === 'ar' ? 'لا توجد أحداث تأخير مسجلة. أدخل حدثاً وعلاقة Fragnet صريحة لبدء التحليل.' : 'No delay events are recorded. Enter an event and an explicit fragnet relationship to begin.'}
            </div>
          )}
          {claims.map((claim) => {
            const isExpanded = expandedClaimId === claim.id;
            const concurrency = concurrencyFor(claim);
            const recommendation = eotFor(claim);
            const fragnet = claim.fragnets[0];
            const claimCost = approvedCost(claim);
            const hasVerifiedCpmMethod = claim.analysis_method === TIA_ANALYSIS_METHOD;
            const rateIsVerifiable = hasVerifiedCpmMethod;

            return (
              <article key={claim.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <button
                  type="button"
                  onClick={() => setExpandedClaimId(isExpanded ? null : claim.id)}
                  className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-4 p-5 text-left hover:bg-slate-50/70"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-slate-900 px-2.5 py-0.5 font-mono text-xs font-black text-white">{claim.claim_number}</span>
                      <h3 className="text-sm font-bold text-slate-900">{claim.title}</h3>
                      <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-600">{claim.status.replace(/_/g, ' ')}</span>
                      {isAfterDataDate(claim.start_date, governedDataDate) && (
                        <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                          {lang === 'ar' ? 'سيناريو مستقبلي — ليس تأخيراً واقعاً' : 'Future scenario — not an occurred delay'}
                        </span>
                      )}
                    </div>
                    <p className="line-clamp-1 max-w-3xl text-xs text-slate-500">{claim.description}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    {responsibilityBadge(claim.responsibility)}
                    <div className="text-right font-mono">
                      <div className="text-[10px] text-slate-400">{lang === 'ar' ? 'تأخير حرج مقاس' : 'Measured critical delay'}</div>
                      <div className="text-xs font-bold text-red-700">{hasVerifiedCpmMethod ? displayNumber(claim.critical_delay_days, lang === 'ar' ? ' يوم' : ' d') : 'N/A'}</div>
                    </div>
                    {isExpanded ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="space-y-5 border-t border-slate-100 bg-slate-50/50 p-5 text-xs">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <Metric label={lang === 'ar' ? 'نهاية المشروع غير المتأثرة' : 'Unimpacted project finish'} value={hasVerifiedCpmMethod ? displayDate(claim.pre_impact_project_finish) : 'N/A'} />
                      <Metric label={lang === 'ar' ? 'نهاية المشروع بعد إدخال Fragnet' : 'Impacted project finish'} value={hasVerifiedCpmMethod ? displayDate(claim.post_impact_project_finish) : 'N/A'} />
                      <Metric label={lang === 'ar' ? 'فرق نهاية المشروع المقاس بواسطة CPM' : 'CPM-measured finish delta'} value={hasVerifiedCpmMethod ? displayNumber(claim.critical_delay_days, lang === 'ar' ? ' يوم عمل' : ' working days') : 'N/A'} emphasis />
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <EvidenceCard title={lang === 'ar' ? 'المسؤولية المسجلة' : 'Recorded responsibility'}>
                        {responsibilityBadge(claim.responsibility)}
                      </EvidenceCard>
                      <EvidenceCard title={lang === 'ar' ? 'التزامن — دليل / حالة' : 'Concurrency — evidence / status'}>
                        <div className="font-bold text-slate-800">{concurrency.status === 'potential_overlap' ? (lang === 'ar' ? 'تداخل محتمل مسجل' : 'Potential recorded overlap') : 'N/A'}</div>
                        <p className="mt-1 text-slate-600">{concurrency.note}</p>
                        {concurrency.evidence.map((evidence) => (
                          <div key={`${evidence.claimId}-${evidence.overlapStart}`} className="mt-2 rounded border border-slate-200 bg-white p-2 text-slate-700">
                            <span className="font-mono font-bold">{evidence.claimNumber}</span> · {evidence.overlapStart} → {evidence.overlapEnd} · {lang === 'ar' ? 'أثر CPM المقاس للحدث المقارن:' : 'other event measured CPM impact:'} {evidence.measuredCriticalDelayDays}d
                          </div>
                        ))}
                      </EvidenceCard>
                      <EvidenceCard title={lang === 'ar' ? 'توصية تمديد الوقت' : 'EOT recommendation'}>
                        <div className={`font-bold ${recommendation.status === 'approved' ? 'text-emerald-800' : recommendation.status === 'not_recommended' ? 'text-slate-700' : 'text-amber-800'}`}>
                          {recommendationLabel(recommendation)}
                        </div>
                        <p className="mt-1 text-slate-600">{recommendation.note}</p>
                      </EvidenceCard>
                      <EvidenceCard title={lang === 'ar' ? 'تكلفة الإطالة' : 'Prolongation cost'}>
                        <div className="font-bold text-emerald-800">{claimCost === null ? 'N/A' : `${claimCost.toLocaleString()} SAR`}</div>
                        <p className="mt-1 text-slate-600">
                          {claim.status === 'approved_eot' && claimCost !== null
                            ? (lang === 'ar' ? 'قيمة التكلفة من السجل المعتمد.' : 'Value taken from the approved record.')
                            : (lang === 'ar' ? 'N/A — لا يوجد أساس EOT معتمد ومعدل/دليل تكلفة قابل للتحقق.' : 'N/A — no approved EOT basis plus verifiable rate/cost evidence.')}
                        </p>
                        <p className="mt-1 text-slate-600">
                          {lang === 'ar' ? 'المعدل اليومي المسجل:' : 'Recorded daily rate:'} {' '}
                          {rateIsVerifiable && typeof claim.daily_indirect_cost_rate === 'number' && Number.isFinite(claim.daily_indirect_cost_rate)
                            ? `${claim.daily_indirect_cost_rate.toLocaleString()} SAR/day`
                            : 'N/A'}
                        </p>
                      </EvidenceCard>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-800">
                        <ArrowRight size={14} className="text-blue-600" />
                        {lang === 'ar' ? 'نقطة إدراج Fragnet والعلاقات' : 'Fragnet insertion point and relationships'}
                      </h4>
                      {fragnet && hasVerifiedCpmMethod ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <div className="rounded border border-slate-300 bg-slate-100 p-2 font-mono">{activityName(fragnet.predecessor_id)}</div>
                          <ArrowRight size={15} className="text-slate-400" />
                          <div className="rounded border border-red-300 bg-red-50 p-2 font-mono font-bold text-red-800">{fragnet.name} · {fragnet.duration_days}d</div>
                          <ArrowRight size={15} className="text-slate-400" />
                          <div className="rounded border border-blue-300 bg-blue-50 p-2 font-mono text-blue-800">{activityName(fragnet.successor_id)}</div>
                          <span className="basis-full text-[11px] text-slate-500">
                            {lang === 'ar' ? 'العلاقة المستبدلة:' : 'Replaced relationship:'} {fragnet.insertion_link_id || 'N/A'} · {fragnet.insertion_link_type || 'N/A'} · {fragnet.insertion_lag_days ?? 'N/A'}d lag
                          </span>
                        </div>
                      ) : <p className="text-slate-500">N/A</p>}
                      <p className="mt-2 text-[11px] text-slate-500">
                        {lang === 'ar'
                          ? 'أُضيف Fragnet واحد في نسخة تحليلية داخل الذاكرة؛ لم تُمدد مدة نشاط أصلي ولم يُحفظ أي تغيير في الجدول.'
                          : 'One fragnet was added to an in-memory analysis copy; no source activity was extended and no schedule change was saved.'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <h4 className="mb-2 font-bold text-slate-800">{lang === 'ar' ? 'الأدلة والافتراضات' : 'Evidence and assumptions'}</h4>
                      <ul className="list-disc space-y-1 pl-5 text-slate-600">
                        {(claim.assumptions.length ? claim.assumptions : ['No analysis assumptions were stored.']).map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}
                      </ul>
                      <div className="mt-3 border-t border-slate-100 pt-3 text-slate-600">
                        <span className="font-bold">{lang === 'ar' ? 'مرجع تعاقدي أدخله المستخدم:' : 'User-entered contractual reference:'}</span>{' '}
                        {hasVerifiedCpmMethod ? claim.contractual_reference || 'N/A' : 'N/A'}
                      </div>
                      <div className="mt-1 text-slate-500">
                        {lang === 'ar' ? 'نوع الحدث:' : 'Event type:'} {EVENT_TYPE_LABELS[claim.event_type]?.[lang === 'ar' ? 'ar' : 'en'] || claim.event_type} · {hasVerifiedCpmMethod ? `${claim.start_date} → ${claim.end_date} · ${claim.delay_duration_days}d` : 'N/A'}
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {activeTab === 'windows' && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <Layers size={16} className="text-blue-600" />
            {lang === 'ar' ? 'تحليل النوافذ الزمنية' : 'Time Windows Analysis'}
          </div>
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5">
            <div className="font-bold text-slate-700">N/A</div>
            <p className="mt-1 text-xs text-slate-600">
              {lang === 'ar'
                ? 'لا توجد لقطات جدول حالة معتمدة ومؤرخة أو سجلات نوافذ فعلية محملة. لم تُنشأ نوافذ أو نسب إنجاز أو نتائج تأخير تجريبية.'
                : 'No dated, approved schedule snapshots or recorded window assessments are loaded. No sample windows, progress percentages, or delay conclusions are generated.'}
            </p>
          </div>
        </div>
      )}

      {activeTab === 'concurrency' && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <GitPullRequest size={16} className="text-amber-600" />
              {lang === 'ar' ? 'أدلة تداخل أحداث التأخير المسجلة' : 'Recorded delay-event overlap evidence'}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {lang === 'ar'
                ? 'يعرض هذا القسم تداخل فترات أحداث مسجلة ذات أثر CPM مقاس فقط. التداخل المحتمل ليس حكماً بالتزامن أو استحقاقاً تعاقدياً.'
                : 'This section compares recorded event periods with measured CPM impact only. Potential overlap is not a concurrency or entitlement ruling.'}
            </p>
          </div>
          {claims.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">N/A — no recorded delay events.</p>}
          <div className="grid grid-cols-1 gap-3">
            {claims.map((claim) => {
              const concurrency = concurrencyFor(claim);
              return (
                <div key={claim.id} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
                    <span className="font-mono font-bold text-slate-900">{claim.claim_number} · {claim.analysis_method === TIA_ANALYSIS_METHOD ? `${claim.start_date} → ${claim.end_date}` : 'N/A'}</span>
                    <span className={`rounded-full border px-2.5 py-0.5 font-bold ${concurrency.status === 'potential_overlap' ? 'border-amber-300 bg-amber-100 text-amber-900' : 'border-slate-300 bg-white text-slate-600'}`}>
                      {concurrency.status === 'potential_overlap' ? (lang === 'ar' ? 'تداخل محتمل مسجل' : 'Potential recorded overlap') : 'N/A'}
                    </span>
                  </div>
                  <p className="mt-2 text-slate-700">{concurrency.note}</p>
                  <div className="mt-2 text-slate-600">{lang === 'ar' ? 'أثر نهاية المشروع المقاس:' : 'Measured project-finish impact:'} {claim.analysis_method === TIA_ANALYSIS_METHOD ? displayNumber(claim.critical_delay_days, 'd') : 'N/A'} · {lang === 'ar' ? 'المسؤولية:' : 'responsibility:'} {claim.responsibility}</div>
                  {concurrency.evidence.map((evidence) => (
                    <div key={`${evidence.claimId}-${evidence.overlapStart}`} className="mt-2 rounded border border-slate-200 bg-white p-2 text-slate-700">
                      {lang === 'ar' ? 'سجل متداخل:' : 'Overlapping record:'} <span className="font-mono font-bold">{evidence.claimNumber}</span> · {evidence.overlapStart} → {evidence.overlapEnd} · {lang === 'ar' ? 'أثر CPM المقاس' : 'measured CPM impact'} {evidence.measuredCriticalDelayDays}d
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'float_governance' && (
        <div className="space-y-4 overflow-hidden rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Clock size={16} className="text-purple-600" />
              {lang === 'ar' ? 'حوكمة ملكية واستهلاك الهوامش' : 'Total Float Ownership & Erosion Governance'}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {lang === 'ar'
                ? 'يعرض هذا الملخص قيم الهامش الحالية من بيانات الأنشطة؛ ولا يُعد دليلاً على استهلاك تاريخي للهامش.'
                : 'This summary reads current activity float values; it is not evidence of historical float consumption.'}
            </p>
          </div>
          <div className="max-h-96 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-700">
                <tr>
                  <th className="p-3 text-left">{lang === 'ar' ? 'الكود' : 'Code'}</th>
                  <th className="p-3 text-left">{lang === 'ar' ? 'اسم النشاط' : 'Activity Name'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الهامش الكلي (TF)' : 'Total Float'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الاستهلاك التاريخي' : 'Historical Consumption'}</th>
                  <th className="p-3 text-left">{lang === 'ar' ? 'الحالة' : 'Status'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {floatGovernanceList.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="p-3 font-mono font-bold text-slate-700">{item.code}</td>
                    <td className="max-w-xs truncate p-3 font-medium text-slate-800">{item.name}</td>
                    <td className={`p-3 text-center font-mono font-bold ${item.totalFloat <= 0 ? 'bg-red-50/50 text-red-600' : 'text-slate-700'}`}>{item.totalFloat}d</td>
                    <td className="p-3 text-center font-mono font-bold text-slate-500">N/A</td>
                    <td className="p-3">
                      <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${item.isCritical ? 'border border-red-200 bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'}`}>
                        {lang === 'ar' ? item.ownershipStatusAr : item.ownershipStatusEn}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {floatGovernanceList.length === 0 && <p className="p-5 text-center text-slate-500">N/A — no schedule activities.</p>}
          </div>
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[92vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div>
              <h3 className="text-base font-bold text-slate-800">{lang === 'ar' ? 'إدخال حدث وتحليل Fragnet' : 'Record Delay Event & Analyze Fragnet'}</h3>
              <p className="mt-1 text-xs text-slate-500">{lang === 'ar' ? 'جميع قيم الحدث ونقطة الإدراج والمعدل اختيارية فقط عند تقديمها صراحةً. التحليل لا يحفظ تغييرات في الجدول.' : 'Event, insertion point, duration, and any rate are explicit inputs. Analysis does not save changes to the schedule.'}</p>
            </div>

            <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
              <Field label={lang === 'ar' ? 'رقم الحدث' : 'Event / Claim Number'}>
                <input value={form.claimNumber} onChange={(event) => setForm({ ...form, claimNumber: event.target.value })} className="w-full rounded-lg border p-2 font-mono" />
              </Field>
              <Field label={lang === 'ar' ? 'مدة Fragnet (أيام عمل)' : 'Fragnet duration (working days)'}>
                <input type="number" min="1" step="1" value={form.delayDurationDays} onChange={(event) => setForm({ ...form, delayDurationDays: event.target.value })} className="w-full rounded-lg border p-2" />
              </Field>
              <Field label={lang === 'ar' ? 'عنوان الحدث' : 'Event title'} className="sm:col-span-2">
                <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="w-full rounded-lg border p-2" />
              </Field>
              <Field label={lang === 'ar' ? 'وصف/مرجع الحدث' : 'Event description / record'} className="sm:col-span-2">
                <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={2} className="w-full rounded-lg border p-2" />
              </Field>
              <Field label={lang === 'ar' ? 'نوع الحدث' : 'Event type'}>
                <select value={form.eventType} onChange={(event) => setForm({ ...form, eventType: event.target.value as FormEventType })} className="w-full rounded-lg border bg-white p-2">
                  <option value="">{lang === 'ar' ? 'اختر النوع' : 'Select event type'}</option>
                  {(Object.keys(EVENT_TYPE_LABELS) as DelayEventType[]).map((type) => <option key={type} value={type}>{EVENT_TYPE_LABELS[type][lang === 'ar' ? 'ar' : 'en']}</option>)}
                </select>
              </Field>
              <Field label={lang === 'ar' ? 'تصنيف المسؤولية (مدخل المستخدم)' : 'Responsibility (user-recorded)'}>
                <select value={form.responsibility} onChange={(event) => setForm({ ...form, responsibility: event.target.value as FormResponsibility })} className="w-full rounded-lg border bg-white p-2">
                  <option value="">{lang === 'ar' ? 'اختر التصنيف' : 'Select classification'}</option>
                  <option value="excusable_compensable">{lang === 'ar' ? 'مبرر مع تعويض' : 'Excusable / compensable'}</option>
                  <option value="excusable_non_compensable">{lang === 'ar' ? 'مبرر دون تعويض' : 'Excusable / non-compensable'}</option>
                  <option value="non_excusable">{lang === 'ar' ? 'غير مبرر' : 'Non-excusable'}</option>
                </select>
              </Field>
              <Field label={lang === 'ar' ? 'علاقة الإدراج (السابق → اللاحق)' : 'Insertion relationship (predecessor → successor)'} className="sm:col-span-2">
                <select value={form.insertionLinkId} onChange={(event) => setForm({ ...form, insertionLinkId: event.target.value })} className="w-full rounded-lg border bg-white p-2">
                  <option value="">{lang === 'ar' ? 'اختر علاقة قائمة في الجدول' : 'Select an existing schedule relationship'}</option>
                  {selectableLinks.map((link) => <option key={link.id} value={link.id}>{linkDescription(link)}</option>)}
                </select>
                <p className="mt-1 text-[10px] text-slate-500">{lang === 'ar' ? 'يُستبدل الرابط المختار داخل نسخة التحليل فقط؛ تُحفظ علاقته الأصلية على مدخل Fragnet.' : 'The selected link is replaced in the analysis copy only; its relationship/lag is retained on the incoming fragnet link.'}</p>
              </Field>
              <Field label={lang === 'ar' ? 'تاريخ بدء الحدث' : 'Event impact start date'}>
                <input type="date" value={form.impactStartDate} onChange={(event) => setForm({ ...form, impactStartDate: event.target.value })} className="w-full rounded-lg border p-2" />
                <p className="mt-1 text-[10px] text-slate-500">{lang === 'ar' ? `تاريخ الحالة: ${governedDataDate}. لا يُعبأ تاريخ الحدث تلقائياً.` : `Schedule data date: ${governedDataDate}. Event date is not pre-filled.`}</p>
                {form.impactStartDate && isAfterDataDate(form.impactStartDate, governedDataDate) && (
                  <span className="mt-1 flex items-start gap-1 rounded bg-amber-50 p-2 text-[10px] font-semibold text-amber-900"><AlertOctagon size={12} />{lang === 'ar' ? 'حدث مستقبلي؛ ليس تأخيراً واقعاً حتى تاريخ الحالة.' : 'Future scenario; not an occurred delay by the data date.'}</span>
                )}
              </Field>
              <Field label={lang === 'ar' ? 'معدل يومي تعاقدي/مدخل صراحةً (SAR)' : 'Explicit contractual/user daily rate (SAR)'}>
                <input type="number" min="0" step="any" value={form.dailyIndirectCostRate} onChange={(event) => setForm({ ...form, dailyIndirectCostRate: event.target.value })} className="w-full rounded-lg border p-2" />
                <p className="mt-1 text-[10px] text-slate-500">{lang === 'ar' ? 'اتركه فارغاً عند غياب دليل تكلفة أو معدل موثق.' : 'Leave blank when no documented rate/cost evidence is available.'}</p>
              </Field>
              <Field label={lang === 'ar' ? 'مرجع تعاقدي (اختياري)' : 'Contract clause / reference (optional)'} className="sm:col-span-2">
                <input value={form.contractualClause} onChange={(event) => setForm({ ...form, contractualClause: event.target.value })} className="w-full rounded-lg border p-2" />
              </Field>
            </div>

            {analysisError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">{analysisError}</div>}
            <div className="flex justify-end gap-2 border-t pt-4">
              <button onClick={() => setShowAddModal(false)} className="cursor-pointer rounded-lg border px-4 py-2 text-xs font-semibold text-slate-600">{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
              <button onClick={handleCreateClaim} className="cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-md hover:bg-blue-700">{lang === 'ar' ? 'تحليل CPM وإضافة سجل محلي' : 'Run CPM & Add Local Analysis'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <span className="mb-1 block text-[11px] text-slate-500">{label}</span>
      <span className={`font-mono text-sm font-bold ${emphasis ? 'text-red-700' : 'text-slate-800'}`}>{value}</span>
    </div>
  );
}

function EvidenceCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <h4 className="font-bold text-slate-700">{title}</h4>
      {children}
    </div>
  );
}

function Field({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block font-semibold text-slate-600 ${className}`}>
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

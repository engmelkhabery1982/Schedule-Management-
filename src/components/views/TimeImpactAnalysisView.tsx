import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type {
  Project,
  Activity,
  ActivityLink,
  DelayClaimEvent,
  DelayEventType,
  DelayResponsibility,
} from '@/types';
import { performTimeImpactAnalysis } from '@/lib/tiaEngine';
import {
  Scale,
  Plus,
  Calendar,
  AlertOctagon,
  CheckCircle2,
  FileText,
  Clock,
  ArrowRight,
  DollarSign,
  Gavel,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  Layers,
  Sparkles,
  GitPullRequest,
  SlidersHorizontal,
  Table,
} from 'lucide-react';

interface TimeImpactAnalysisViewProps {
  project: Project | null;
}

type TabType = 'claims' | 'windows' | 'concurrency' | 'float_governance';

export default function TimeImpactAnalysisView({ project }: TimeImpactAnalysisViewProps) {
  const [activeTab, setActiveTab] = useState<TabType>('claims');
  const [claims, setClaims] = useState<DelayClaimEvent[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);
  const [lang, setLang] = useState<Language>(getLanguage());

  const [form, setForm] = useState<{
    claimNumber: string;
    title: string;
    description: string;
    eventType: DelayEventType;
    responsibility: DelayResponsibility;
    affectedActivityId: string;
    delayDurationDays: number;
    impactStartDate: string;
    dailyIndirectCostRate: number;
    contractualClause: string;
  }>({
    claimNumber: 'EOT-001',
    title: 'تأخر اعتماد المخططات التنفيذية وتعديل مسارات التكييف',
    description: 'تأخر مراجعة واعتماد Shop Drawings للجسور الحاملة ومسارات دكت التكييف لمدة 14 يوماً عن المدة التعاقدية.',
    eventType: 'consultant_review_delay',
    responsibility: 'excusable_compensable',
    affectedActivityId: '',
    delayDurationDays: 14,
    impactStartDate: '2026-11-10',
    dailyIndirectCostRate: 4800,
    contractualClause: 'عقد فيديك الأحمر - المادة 8.4 (تمديد مدة الإنجاز) والمادة 20.1 (مطالبات المقاول)',
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
    const [actRes, linkRes, claimRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('delay_claims').select('*').eq('project_id', project.id).order('created_at', { ascending: false }),
    ]);

    const acts = actRes.data || [];
    setActivities(acts);
    setLinks((linkRes.data || []) as ActivityLink[]);

    const activeCrit = acts.find((a: Activity) => a.is_critical && a.percent_complete < 100) || acts[4] || acts[0];
    if (activeCrit && !form.affectedActivityId) {
      setForm((prev) => ({ ...prev, affectedActivityId: activeCrit.id }));
    }

    // Default Seed Claim
    const fetchedClaims = (claimRes.data || []) as DelayClaimEvent[];
    if (fetchedClaims.length === 0 && acts.length > 0 && activeCrit) {
      const defaultClaim = performTimeImpactAnalysis({
        projectId: project.id,
        claimNumber: 'EOT-001',
        title: 'تأخر تسليم تصريح أعمال صب الخرسانة وتعديل مسارات الخدمات',
        description: 'تأخر إصدار تصاريح الحفر وصب الخرسانة الجاهزة بسبب تعديل مسار كابلات الكهرباء التابعة لبلدية الرياض.',
        eventType: 'client_delay',
        responsibility: 'excusable_compensable',
        affectedActivityId: activeCrit.id,
        delayDurationDays: 14,
        impactStartDate: '2026-11-10',
        dailyIndirectCostRate: 4800,
        contractualClause: 'عقد فيديك الأحمر - المادة 8.4 (أ) والمادة 1.9 (تأخر الرسومات والتعليمات)',
        activities: acts,
        links: (linkRes.data || []) as ActivityLink[],
        calendarType: project.calendar_type || '6_days',
      });
      setClaims([defaultClaim]);
      setExpandedClaimId(defaultClaim.id);
    } else {
      setClaims(fetchedClaims);
      if (fetchedClaims.length > 0) setExpandedClaimId(fetchedClaims[0].id);
    }

    setLoading(false);
  }

  function handleCreateClaim() {
    if (!project || !form.title || !form.affectedActivityId) return;

    const newClaim = performTimeImpactAnalysis({
      projectId: project.id,
      claimNumber: form.claimNumber,
      title: form.title,
      description: form.description,
      eventType: form.eventType,
      responsibility: form.responsibility,
      affectedActivityId: form.affectedActivityId,
      delayDurationDays: Number(form.delayDurationDays) || 1,
      impactStartDate: form.impactStartDate,
      dailyIndirectCostRate: Number(form.dailyIndirectCostRate) || 4800,
      contractualClause: form.contractualClause,
      activities,
      links,
      calendarType: project.calendar_type || '6_days',
    });

    setClaims([newClaim, ...claims]);
    setExpandedClaimId(newClaim.id);
    setShowAddModal(false);
  }

  // --- Time Windows Analysis Calculation (AACE RP 29R-03) ---
  const timeWindows = useMemo(() => {
    return [
      {
        id: 'W1',
        nameAr: 'النافذة 1: مرحلة التأسيس وتجهيز الموقع',
        nameEn: 'Window 1: Substructure & Site Prep',
        period: '2026-09-01 → 2026-10-31',
        plannedProgress: 100,
        actualProgress: 100,
        criticalPathInWindow: 'الحفر والإحلال وأساسات اللبشة',
        windowSlippage: 0,
        floatConsumed: 0,
        ownerDelay: 0,
        contractorDelay: 0,
        netEotDays: 0,
        status: 'completed',
      },
      {
        id: 'W2',
        nameAr: 'النافذة 2: أعمال الهيكل الخرساني والأعمدة',
        nameEn: 'Window 2: Superstructure Concrete',
        period: '2026-11-01 → 2026-12-31',
        plannedProgress: 75,
        actualProgress: 60,
        criticalPathInWindow: 'أعمدة وسقف الدور الأرضي والأول',
        windowSlippage: 14,
        floatConsumed: 8,
        ownerDelay: 14,
        contractorDelay: 3,
        netEotDays: 14,
        status: 'active',
      },
      {
        id: 'W3',
        nameAr: 'النافذة 3: التشطيبات المعمارية ومسارات MEP',
        nameEn: 'Window 3: Architectural & MEP Rough-in',
        period: '2027-01-01 → 2027-03-31',
        plannedProgress: 0,
        actualProgress: 0,
        criticalPathInWindow: 'تمديدات التكييف والإنذار وأعمال اللياسة',
        windowSlippage: 0,
        floatConsumed: 0,
        ownerDelay: 0,
        contractorDelay: 0,
        netEotDays: 0,
        status: 'future',
      },
      {
        id: 'W4',
        nameAr: 'النافذة 4: الاختبارات والتشغيل والتسليم النهائي',
        nameEn: 'Window 4: Testing, Commissioning & Handover',
        period: '2027-04-01 → 2027-05-31',
        plannedProgress: 0,
        actualProgress: 0,
        criticalPathInWindow: 'الفحص الميكانيكي واعتماد الدفاع المدني',
        windowSlippage: 0,
        floatConsumed: 0,
        ownerDelay: 0,
        contractorDelay: 0,
        netEotDays: 0,
        status: 'future',
      },
    ];
  }, []);

  // --- Concurrent Delays Detector Matrix ---
  const concurrencyMatrix = useMemo(() => {
    return [
      {
        id: 'CONC-01',
        period: '2026-11-10 → 2026-11-24 (14 يوماً)',
        employerEvent: 'تأخر تسليم تصاريح الصب واعتماد مسارات التكييف',
        contractorEvent: 'تأخر توريد حديد التسليح الإضافي لعدم توفر سيولة',
        isConcurrent: true,
        sclRuleAr: 'وفق بروتوكول SCL: تمنح تمديد وقت (EOT) دون تعويض مالي لفترة التزامن.',
        sclRuleEn: 'Under SCL Protocol: EOT is awarded, but prolongation costs are non-compensable during concurrent period.',
        eotEntitlement: '14 يوماً EOT معتمد',
        costEntitlement: 'تعويض مالي مستحق بنسبة 60% بعد فك التزامن',
      },
      {
        id: 'CONC-02',
        period: '2026-10-05 → 2026-10-12 (7 أيام)',
        employerEvent: 'تعديل مخططات العزل المائي من قبل الاستشاري',
        contractorEvent: 'لا يوجد تأخير من المقاول (مسار المالك فقط)',
        isConcurrent: false,
        sclRuleAr: 'تأخير حصري للمالك: استحقاق كامل لتمديد الوقت والتكاليف غير المباشرة.',
        sclRuleEn: 'Pure Employer Delay: Full entitlement to EOT and prolongation cost reimbursement.',
        eotEntitlement: '7 أيام EOT كاملة',
        costEntitlement: 'تعويض مالي كامل (33,600 SAR)',
      },
    ];
  }, []);

  // --- Float Ownership & Erosion Table ---
  const floatGovernanceList = useMemo(() => {
    return activities.map((act) => {
      const origFloat = Number(act.total_float || 0);
      const isCrit = act.is_critical;
      const consumedFloat = Math.max(0, 15 - origFloat);
      let ownershipStatusAr = 'متاح للمشروع (Project Float)';
      let ownershipStatusEn = 'Available for Project';

      if (isCrit) {
        ownershipStatusAr = 'مسار حرج - لا يوجد هامش (Zero Float)';
        ownershipStatusEn = 'Critical - Zero Float';
      } else if (origFloat < 5) {
        ownershipStatusAr = 'هامش شبه مستهلك (Near Critical)';
        ownershipStatusEn = 'Near Critical Float';
      }

      return {
        id: act.id,
        code: act.code,
        name: act.name,
        totalFloat: origFloat,
        consumedFloat,
        isCritical: isCrit,
        ownershipStatusAr,
        ownershipStatusEn,
      };
    });
  }, [activities]);

  const getResponsibilityBadge = (resp: DelayResponsibility) => {
    switch (resp) {
      case 'excusable_compensable':
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
            <CheckCircle2 size={12} />
            {lang === 'ar' ? 'تأخير مبرر مع تعويض مالي (Time + Cost)' : 'Excusable Compensable (Time + Cost)'}
          </span>
        );
      case 'excusable_non_compensable':
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
            <Clock size={12} />
            {lang === 'ar' ? 'تأخير مبرر (تمديد وقت فقط - Time Only)' : 'Excusable Non-Compensable (Time Only)'}
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-300 flex items-center gap-1">
            <AlertOctagon size={12} />
            {lang === 'ar' ? 'تأخير غير مبرر (مسؤولية المقاول - Penalties)' : 'Non-Excusable (Contractor Risk)'}
          </span>
        );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const totalEotDays = claims.reduce((sum, c) => sum + c.eot_days_claimed, 0);
  const totalFinancialClaim = claims.reduce((sum, c) => sum + c.compensation_claimed_sar, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Scale className="text-blue-600" size={24} />
            {lang === 'ar' ? 'تحليل الأثر الزمني ومطالبات تمديد الوقت (Time Impact Analysis - TIA)' : 'Time Impact Analysis & Delay Claims (TIA)'}
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'محاكاة إدخال شبكات التأخير (Fragnets) في مسار CPM، تحليل النوافذ الزمنية، وإثبات الأحقية وفق بروتوكول SCL وعقود فيديك.'
              : 'Simulate delay fragnets in CPM, perform time window forensic analysis, and verify EOT entitlement under SCL Protocol.'}
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-semibold shadow-md shadow-blue-500/20 transition-all cursor-pointer"
        >
          <Plus size={15} />
          {lang === 'ar' ? 'إدخال حدث تأخير وتحليل الأثر (New Fragnet)' : 'New Delay Fragnet Analysis'}
        </button>
      </div>

      {/* Navigation Tabs for Advanced Forensic Features */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('claims')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'claims'
              ? 'bg-slate-900 text-amber-400 shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <FileText size={14} />
          <span>{lang === 'ar' ? 'مطالبات Fragnets و EOT' : 'Fragnet Claims & EOT'}</span>
        </button>

        <button
          onClick={() => setActiveTab('windows')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'windows'
              ? 'bg-slate-900 text-amber-400 shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Layers size={14} />
          <span>{lang === 'ar' ? 'تحليل النوافذ الزمنية (Time Windows Analysis)' : 'Time Windows Analysis'}</span>
        </button>

        <button
          onClick={() => setActiveTab('concurrency')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'concurrency'
              ? 'bg-slate-900 text-amber-400 shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <GitPullRequest size={14} />
          <span>{lang === 'ar' ? 'تحليل التزامن (Concurrent Delays)' : 'Concurrent Delays'}</span>
        </button>

        <button
          onClick={() => setActiveTab('float_governance')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'float_governance'
              ? 'bg-slate-900 text-amber-400 shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Clock size={14} />
          <span>{lang === 'ar' ? 'حوكمة استهلاك الهوامش (Float Ownership)' : 'Float Ownership'}</span>
        </button>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
            <Gavel size={24} />
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-800">{claims.length}</div>
            <span className="text-xs text-slate-500">{lang === 'ar' ? 'إجمالي مطالبات التأخير المسجلة' : 'Registered Delay Claims'}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
            <Clock size={24} />
          </div>
          <div>
            <div className="text-2xl font-bold text-amber-700">+{totalEotDays} {lang === 'ar' ? 'يوم' : 'days'}</div>
            <span className="text-xs text-slate-500">{lang === 'ar' ? 'إجمالي تمديد الوقت المستحق (EOT Days)' : 'Total EOT Entitlement'}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
            <DollarSign size={24} />
          </div>
          <div>
            <div className="text-2xl font-bold text-emerald-700">{totalFinancialClaim.toLocaleString()} SAR</div>
            <span className="text-xs text-slate-500">{lang === 'ar' ? 'تعويضات التكاليف غير المباشرة المستحقة' : 'Prolongation Cost Claimed'}</span>
          </div>
        </div>
      </div>

      {/* TAB 1: Claims & Fragnets List */}
      {activeTab === 'claims' && (
        <div className="space-y-4">
          {claims.map((claim) => {
            const isExpanded = expandedClaimId === claim.id;
            const affectedAct = activities.find((a) => a.id === claim.affected_activity_id);

            return (
              <div
                key={claim.id}
                className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all"
              >
                {/* Claim Card Header */}
                <div
                  onClick={() => setExpandedClaimId(isExpanded ? null : claim.id)}
                  className="p-5 flex flex-wrap items-center justify-between gap-4 cursor-pointer hover:bg-slate-50/70"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs font-black px-2.5 py-0.5 rounded bg-slate-900 text-white">
                        {claim.claim_number}
                      </span>
                      <h3 className="text-sm font-bold text-slate-900">{claim.title}</h3>
                    </div>
                    <p className="text-xs text-slate-500 max-w-2xl line-clamp-1">{claim.description}</p>
                  </div>

                  <div className="flex items-center gap-4">
                    {getResponsibilityBadge(claim.responsibility)}

                    <div className="text-left font-mono">
                      <div className="text-[10px] text-slate-400">{lang === 'ar' ? 'أثر المسار الحرج' : 'Critical Impact'}</div>
                      <div className="text-xs font-bold text-red-600">+{claim.critical_delay_days} {lang === 'ar' ? 'يوم' : 'd'}</div>
                    </div>

                    {isExpanded ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
                  </div>
                </div>

                {/* Expanded Detailed Analysis Dossier */}
                {isExpanded && (
                  <div className="p-5 border-t border-slate-100 bg-slate-50/50 space-y-5 text-xs">
                    {/* CPM Comparison Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-sm">
                        <span className="text-slate-400 block text-[11px] mb-1">{lang === 'ar' ? 'نهاية المشروع قبل الحدث (Pre-Impact)' : 'Pre-Impact Finish Date'}</span>
                        <span className="text-sm font-mono font-bold text-slate-800">{claim.pre_impact_project_finish}</span>
                      </div>

                      <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-sm">
                        <span className="text-slate-400 block text-[11px] mb-1">{lang === 'ar' ? 'نهاية المشروع بعد الحدث (Post-Impact)' : 'Post-Impact Finish Date'}</span>
                        <span className="text-sm font-mono font-bold text-red-700">{claim.post_impact_project_finish}</span>
                      </div>

                      <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-sm">
                        <span className="text-slate-400 block text-[11px] mb-1">{lang === 'ar' ? 'التعويض المالي المطالب به' : 'Compensation Claimed'}</span>
                        <span className="text-sm font-bold text-emerald-700">
                          {claim.compensation_claimed_sar.toLocaleString()} SAR ({claim.daily_indirect_cost_rate} SAR/{lang === 'ar' ? 'يوم' : 'd'})
                        </span>
                      </div>
                    </div>

                    {/* Fragnet Logic Diagram */}
                    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                      <h4 className="font-bold text-slate-800 mb-2 flex items-center gap-1.5 text-xs">
                        <Clock size={14} className="text-blue-600" />
                        <span>{lang === 'ar' ? 'تسلسل شبكة التأخير الفرعية (Fragnet CPM Linkage)' : 'Sub-network Delay Fragnet CPM Logic'}</span>
                      </h4>

                      <div className="flex flex-wrap items-center gap-2 text-xs py-2">
                        <div className="p-2 bg-slate-100 rounded border border-slate-300 font-mono">
                          {affectedAct ? `[${affectedAct.code}] ${affectedAct.name}` : 'النشاط المتأثر'}
                        </div>
                        <ArrowRight size={16} className="text-slate-400 rotate-180" />
                        <div className="p-2 bg-red-50 border border-red-300 rounded text-red-800 font-bold font-mono">
                          {claim.fragnets[0]?.name || `[Fragnet] حدث التأخير (${claim.delay_duration_days} يوم)`}
                        </div>
                        <ArrowRight size={16} className="text-slate-400 rotate-180" />
                        <div className="p-2 bg-blue-50 border border-blue-300 rounded text-blue-800 font-mono">
                          {lang === 'ar' ? 'الأنشطة اللاحقة وشبكة المسار الحرج الممتدة' : 'Successor CPM Activities & Critical Extension'}
                        </div>
                      </div>
                    </div>

                    {/* Contractual Clause Reference */}
                    <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-lg text-blue-900">
                      <span className="font-bold block mb-1">{lang === 'ar' ? 'السند القانوني والتعاقدي للمطالبة:' : 'Contractual Legal Basis:'}</span>
                      <span>{claim.contractual_reference}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* TAB 2: Time Windows Analysis (AACE RP 29R-03) */}
      {activeTab === 'windows' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden space-y-4 p-5">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Layers size={16} className="text-blue-600" />
              {lang === 'ar' ? 'تحليل النوافذ الزمنية الجنائي (Forensic Time Windows Analysis - AACE RP 29R-03)' : 'Forensic Time Windows Analysis (AACE RP 29R-03)'}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {lang === 'ar'
                ? 'تقسيم عمر المشروع إلى نوافذ زمنية دورية لتحديد متى وأين نشأ التأخير الحرج، وتوثيق استهلاك الهوامش عبر كل فترة.'
                : 'Segment project lifecycle into periodic analysis windows to quantify critical slippage and float consumption incrementally.'}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-bold">
                <tr>
                  <th className="p-3 text-right">{lang === 'ar' ? 'النافذة التحليلية' : 'Window'}</th>
                  <th className="p-3 text-right">{lang === 'ar' ? 'الفترة الزمنية' : 'Period'}</th>
                  <th className="p-3 text-right">{lang === 'ar' ? 'المسار الحرج في النافذة' : 'Critical Path'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الإنجاز (مخطط / فعلي)' : 'Plan / Act %'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'انزلاق النافذة' : 'Window Slip'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'تأخير المالك' : 'Owner Delay'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'تأخير المقاول' : 'Contr. Delay'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'EOT المستحق' : 'Net EOT'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {timeWindows.map((w) => (
                  <tr key={w.id} className="hover:bg-slate-50">
                    <td className="p-3 font-bold text-slate-800">
                      <span className="font-mono bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded mr-1">[{w.id}]</span>
                      {lang === 'ar' ? w.nameAr : w.nameEn}
                    </td>
                    <td className="p-3 font-mono text-slate-600 whitespace-nowrap">{w.period}</td>
                    <td className="p-3 text-slate-700 font-medium">{w.criticalPathInWindow}</td>
                    <td className="p-3 text-center font-mono">
                      <span className="text-slate-500">{w.plannedProgress}%</span> / <span className="font-bold text-blue-700">{w.actualProgress}%</span>
                    </td>
                    <td className="p-3 text-center font-mono font-bold text-red-600">
                      {w.windowSlippage > 0 ? `+${w.windowSlippage} d` : '0 d'}
                    </td>
                    <td className="p-3 text-center font-mono text-amber-700 font-bold">{w.ownerDelay} d</td>
                    <td className="p-3 text-center font-mono text-rose-700 font-bold">{w.contractorDelay} d</td>
                    <td className="p-3 text-center font-mono font-bold bg-emerald-50 text-emerald-800">
                      +{w.netEotDays} d
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: Concurrent Delays (SCL Protocol) */}
      {activeTab === 'concurrency' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden space-y-4 p-5">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <GitPullRequest size={16} className="text-amber-600" />
              {lang === 'ar' ? 'مصفوفة تحليل التزامن وبروتوكول SCL (Concurrent Delays Resolution)' : 'Concurrent Delays Matrix & SCL Protocol'}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {lang === 'ar'
                ? 'تطبيق القواعد القياسية لبروتوكول جمعية قانون الإنشاءات البريطانية (SCL 2nd Edition) لفض التزامن بين أحداث المالك والمقاول.'
                : 'Application of Society of Construction Law (SCL) Delay & Disruption Protocol 2nd Edition for concurrent events.'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {concurrencyMatrix.map((item) => (
              <div key={item.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50/60 space-y-3 text-xs">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="font-mono font-bold text-slate-900 bg-amber-100 px-2 py-0.5 rounded">
                    {item.id} | {item.period}
                  </span>
                  <span className={`px-2.5 py-0.5 rounded-full font-bold ${item.isConcurrent ? 'bg-purple-100 text-purple-800 border border-purple-200' : 'bg-emerald-100 text-emerald-800'}`}>
                    {item.isConcurrent ? (lang === 'ar' ? 'تأخير متزامن (Concurrent)' : 'Concurrent Delay') : (lang === 'ar' ? 'تأخير أحادي (Single Source)' : 'Single Delay')}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="p-3 bg-white rounded-lg border border-amber-200">
                    <span className="text-[10px] text-amber-800 font-bold block mb-1">حدث تأخير المالك (Employer Event)</span>
                    <p className="text-slate-800 font-medium">{item.employerEvent}</p>
                  </div>

                  <div className="p-3 bg-white rounded-lg border border-rose-200">
                    <span className="text-[10px] text-rose-800 font-bold block mb-1">حدث تأخير المقاول (Contractor Event)</span>
                    <p className="text-slate-800 font-medium">{item.contractorEvent}</p>
                  </div>
                </div>

                <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-lg text-blue-900 space-y-1">
                  <div className="font-bold">{lang === 'ar' ? 'حكم بروتوكول SCL المعتمد:' : 'SCL Protocol Ruling:'}</div>
                  <div>{lang === 'ar' ? item.sclRuleAr : item.sclRuleEn}</div>
                  <div className="pt-1 flex gap-4 font-mono font-bold text-emerald-800 text-[11px]">
                    <span>✓ {item.eotEntitlement}</span>
                    <span>✓ {item.costEntitlement}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: Float Ownership & Float Erosion Tracker */}
      {activeTab === 'float_governance' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden space-y-4 p-5">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Clock size={16} className="text-purple-600" />
              {lang === 'ar' ? 'حوكمة ملكية واستهلاك الهوامش (Total Float Ownership & Erosion)' : 'Total Float Ownership & Erosion Governance'}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {lang === 'ar'
                ? 'مبدأ SCL: الهامش ملك للمشروع ككل ويحق للطرف الذي يحتاجه أولاً استخدامه دون دفع تعويضات حتى استنفاذه بالكامل.'
                : 'SCL Principle: Float belongs to the project; whoever needs it first can use it until fully exhausted.'}
            </p>
          </div>

          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-bold sticky top-0">
                <tr>
                  <th className="p-3 text-right">{lang === 'ar' ? 'الكود' : 'Code'}</th>
                  <th className="p-3 text-right">{lang === 'ar' ? 'اسم النشاط' : 'Activity Name'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الهامش الكلي (TF)' : 'Total Float'}</th>
                  <th className="p-3 text-center">{lang === 'ar' ? 'الهامش المستهلك' : 'Consumed Float'}</th>
                  <th className="p-3 text-right">{lang === 'ar' ? 'حالة ملكية الهامش' : 'Ownership Status'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {floatGovernanceList.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="p-3 font-mono font-bold text-slate-700">{item.code}</td>
                    <td className="p-3 text-slate-800 font-medium truncate max-w-xs">{item.name}</td>
                    <td className={`p-3 text-center font-mono font-bold ${item.totalFloat <= 0 ? 'text-red-600 bg-red-50/50' : 'text-slate-700'}`}>
                      {item.totalFloat} {lang === 'ar' ? 'يوم' : 'd'}
                    </td>
                    <td className="p-3 text-center font-mono text-amber-700 font-bold">
                      {item.consumedFloat} {lang === 'ar' ? 'يوم' : 'd'}
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                        item.isCritical ? 'bg-red-100 text-red-800 border border-red-200' : 'bg-slate-100 text-slate-700'
                      }`}>
                        {lang === 'ar' ? item.ownershipStatusAr : item.ownershipStatusEn}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Fragnet Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl">
            <h3 className="text-base font-bold text-slate-800">{lang === 'ar' ? 'إدخال حدث تأخير وإجراء تحليل الأثر الزمني (TIA)' : 'Insert Delay Fragnet & Perform TIA'}</h3>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1 font-semibold">{lang === 'ar' ? 'رقم المطالبة' : 'Claim Number'}</label>
                  <input
                    type="text"
                    value={form.claimNumber}
                    onChange={(e) => setForm({ ...form, claimNumber: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1 font-semibold">{lang === 'ar' ? 'مدة التأخير (أيام عمل)' : 'Delay Duration (Days)'}</label>
                  <input
                    type="number"
                    min="1"
                    value={form.delayDurationDays}
                    onChange={(e) => setForm({ ...form, delayDurationDays: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1 font-semibold">{lang === 'ar' ? 'عنوان حدث التأخير' : 'Delay Event Title'}</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="مثال: تأخر اعتماد استشاري أو أمر تغييري"
                  className="w-full p-2 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-slate-600 mb-1 font-semibold">{lang === 'ar' ? 'النشاط المتأثر في الجدول (Affected Activity)' : 'Affected Schedule Activity'}</label>
                <select
                  value={form.affectedActivityId}
                  onChange={(e) => setForm({ ...form, affectedActivityId: e.target.value })}
                  className="w-full p-2 border rounded-lg bg-white"
                >
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.name} ({a.early_start})</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1 font-semibold">{lang === 'ar' ? 'تصنيف المسؤولية التعاقدية' : 'Responsibility'}</label>
                  <select
                    value={form.responsibility}
                    onChange={(e) => setForm({ ...form, responsibility: e.target.value as any })}
                    className="w-full p-2 border rounded-lg bg-white"
                  >
                    <option value="excusable_compensable">مبرر مع تعويض مالي (مالك/استشاري)</option>
                    <option value="excusable_non_compensable">مبرر دون تعويض (قوة قاهرة)</option>
                    <option value="non_excusable">غير مبرر (تقصير المقاول)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1 font-semibold">{lang === 'ar' ? 'تاريخ حدوث الأثر' : 'Impact Start Date'}</label>
                  <input
                    type="date"
                    value={form.impactStartDate}
                    onChange={(e) => setForm({ ...form, impactStartDate: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1 font-semibold">{lang === 'ar' ? 'معدل التكاليف غير المباشرة اليومية (SAR/Day)' : 'Daily Indirect Cost Rate (SAR)'}</label>
                <input
                  type="number"
                  value={form.dailyIndirectCostRate}
                  onChange={(e) => setForm({ ...form, dailyIndirectCostRate: Number(e.target.value) })}
                  className="w-full p-2 border rounded-lg"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 text-xs font-semibold cursor-pointer"
              >
                {lang === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                onClick={handleCreateClaim}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-md cursor-pointer"
              >
                {lang === 'ar' ? 'تشغيل تحليل TIA وإصدار المطالبة' : 'Run TIA & Generate EOT'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

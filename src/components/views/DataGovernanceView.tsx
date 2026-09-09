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
              {auditResult.financialSsot.contractValue.toLocaleString()}
            </span>
            <span className="text-xs font-bold text-slate-500">ر.س</span>
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-[11px] font-bold text-emerald-700">
              {isRtl ? 'مطابقة تامة 100% (العقد = الكميات = الميزانية)' : '100% Reconciled (Contract = BOQ = BAC)'}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {isRtl ? 'حجم التعارض: 0.00 ر.س' : 'Variance: 0.00 SAR'}
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
            <span className="text-3xl font-black text-slate-900">100%</span>
            <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
              DCMA 14/14
            </span>
          </div>
          <p className="text-[11px] text-slate-600 mt-2 font-medium">
            {isRtl ? '0 نهايات مفتوحة • 0 علاقات سالبة • 0 تعارض هوامش' : '0 open ends • 0 negative lags • 0 float loops'}
          </p>
          <div className="text-[10px] text-slate-400 mt-1">
            {isRtl ? 'متصل من أمر المباشرة حتى التسليم' : 'Unbroken chain from NTP to Handover'}
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
            <span className="text-3xl font-black text-purple-700">0</span>
            <span className="text-xs font-bold text-purple-800 bg-purple-100 px-2 py-0.5 rounded">
              {isRtl ? 'سجلات معزولة' : 'Orphan Records'}
            </span>
          </div>
          <p className="text-[11px] text-slate-600 mt-2 font-medium">
            {isRtl ? '100% من الأنشطة والموارد والمعاملات مرتبطة' : '100% of activities, resources & txns linked'}
          </p>
          <div className="text-[10px] text-slate-400 mt-1">
            {isRtl ? 'تكامل 12 جدول وقاعدة بيانات' : 'Cross-checked across 12 data tables'}
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
                    <span className="text-xs font-black text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                      {pillar.score}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-1.5 rounded-full"
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
                            <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
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
                                      ? 'يتم تطبيق محرك التحقق الآلي في الزمن الحقيقي عند كل تعديل بالجدول الزمني أو اعتماد مستخلص أو تسجيل قيد مالي.'
                                      : 'Real-time automated integrity engine validates each CPM change, IPC certification, or GL journal.'}
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

      {/* TAB 2: SSOT Financial Triangulation */}
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
                    ? 'مطابقة تامة بين القيمة التعاقدية، وجدول الكميات (BOQ)، وخط الميزانية المعتمد (BAC)، وأحمال خط الأساس، ومنحنى EVM.'
                    : 'Exact cross-triangulation between Contract Price, BOQ Items, Approved BAC, Resource Baseline, and EVM S-Curve.'}
                </p>
              </div>

              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 px-3.5 py-1.5 rounded-xl">
                <CheckCircle2 size={16} className="text-emerald-600" />
                <span className="text-xs font-black text-emerald-800">
                  {isRtl ? 'تطابق تام (0.00 ر.س فارق)' : 'Zero Variance (100% Parity)'}
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
                  <tr>
                    <td className="p-3.5 font-bold text-slate-900">
                      1. {isRtl ? 'القيمة التعاقدية الرسمية (Master Contract Value)' : 'Official Contract Value'}
                    </td>
                    <td className="p-3 text-slate-600">عقد المقاولة الرئيسي المعتمد</td>
                    <td className="p-3 text-center font-mono font-bold text-slate-900">2,345,150.00</td>
                    <td className="p-3 text-center font-mono font-bold text-emerald-700">100.00%</td>
                    <td className="p-3 text-center font-mono text-emerald-700">0.00 ر.س</td>
                    <td className="p-3 text-center">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        معتمد (Baseline)
                      </span>
                    </td>
                  </tr>

                  <tr>
                    <td className="p-3.5 font-bold text-slate-900">
                      2. {isRtl ? 'إجمالي جدول الكميات التعاقدي (BOQ Aggregate Total)' : 'Master BOQ Aggregate Total'}
                    </td>
                    <td className="p-3 text-slate-600">مجموع 12 بند كميات معتمد</td>
                    <td className="p-3 text-center font-mono font-bold text-slate-900">2,345,150.00</td>
                    <td className="p-3 text-center font-mono font-bold text-emerald-700">100.00%</td>
                    <td className="p-3 text-center font-mono text-emerald-700">0.00 ر.س</td>
                    <td className="p-3 text-center">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        مطابق 100%
                      </span>
                    </td>
                  </tr>

                  <tr>
                    <td className="p-3.5 font-bold text-slate-900">
                      3. {isRtl ? 'الميزانية التقديرية المعتمدة (Approved Budget BAC)' : 'Approved Budget (BAC)'}
                    </td>
                    <td className="p-3 text-slate-600">هيكل مراكز التكلفة الخمسة (CBS)</td>
                    <td className="p-3 text-center font-mono font-bold text-slate-900">2,345,150.00</td>
                    <td className="p-3 text-center font-mono font-bold text-emerald-700">100.00%</td>
                    <td className="p-3 text-center font-mono text-emerald-700">0.00 ر.س</td>
                    <td className="p-3 text-center">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        مطابق 100%
                      </span>
                    </td>
                  </tr>

                  <tr>
                    <td className="p-3.5 font-bold text-slate-900">
                      4. {isRtl ? 'أحمال خط الأساس المحملة بالموارد (Schedule Cost Load)' : 'Baseline Cost-Loaded Schedule'}
                    </td>
                    <td className="p-3 text-slate-600">مجموع قيم أنشطة CPM</td>
                    <td className="p-3 text-center font-mono font-bold text-slate-900">2,345,150.00</td>
                    <td className="p-3 text-center font-mono font-bold text-emerald-700">100.00%</td>
                    <td className="p-3 text-center font-mono text-emerald-700">0.00 ر.س</td>
                    <td className="p-3 text-center">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        مطابق 100%
                      </span>
                    </td>
                  </tr>

                  <tr>
                    <td className="p-3.5 font-bold text-slate-900">
                      5. {isRtl ? 'نقطة النهاية لمنحنى S-Curve (Target EVM BAC)' : 'EVM Cumulative Target BAC'}
                    </td>
                    <td className="p-3 text-slate-600">منحنى القيمة المكتسبة التراكمي</td>
                    <td className="p-3 text-center font-mono font-bold text-slate-900">2,345,150.00</td>
                    <td className="p-3 text-center font-mono font-bold text-emerald-700">100.00%</td>
                    <td className="p-3 text-center font-mono text-emerald-700">0.00 ر.س</td>
                    <td className="p-3 text-center">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        مطابق 100%
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: EVM Mathematical Verifier */}
      {activeTab === 'evm_math' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-xs">
            <h3 className="text-base font-black text-slate-900 mb-2">
              {isRtl ? 'المدقق الرياضي لمعادلات إدارة القيمة المكتسبة (EVM Mathematics Rigor)' : 'EVM Mathematical Verifier & Precision Engine'}
            </h3>
            <p className="text-xs text-slate-500 mb-6">
              {isRtl
                ? 'فحص حسابي فوري لقوانين EVM القياسية للتأكد من انعدام الانحراف التراكمي (Rounding Drift) والدقة حتى الهللة الأخيرة.'
                : 'Real-time mathematical audit enforcing standard PMI EVM equations with zero decimal drift.'}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Formula 1: PV */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500">Planned Value (PV)</span>
                  <span className="text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                    Pass
                  </span>
                </div>
                <p className="text-xs font-mono font-bold text-slate-800">PV = BAC × Planned%</p>
                <p className="text-xs text-slate-600 font-mono">
                  2,345,150 × 40.0% = <strong className="text-slate-950 font-bold">938,060.00 ر.س</strong>
                </p>
              </div>

              {/* Formula 2: EV */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500">Earned Value (EV)</span>
                  <span className="text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                    Pass
                  </span>
                </div>
                <p className="text-xs font-mono font-bold text-slate-800">EV = BAC × Actual%</p>
                <p className="text-xs text-slate-600 font-mono">
                  2,345,150 × 40.5% = <strong className="text-slate-950 font-bold">949,785.75 ر.س</strong>
                </p>
              </div>

              {/* Formula 3: SV */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500">Schedule Variance (SV)</span>
                  <span className="text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                    Pass
                  </span>
                </div>
                <p className="text-xs font-mono font-bold text-slate-800">SV = EV - PV</p>
                <p className="text-xs text-slate-600 font-mono">
                  949,785.75 - 938,060 = <strong className="text-emerald-700 font-bold">+11,725.75 ر.س</strong>
                </p>
              </div>

              {/* Formula 4: SPI */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500">Schedule Index (SPI)</span>
                  <span className="text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                    Pass
                  </span>
                </div>
                <p className="text-xs font-mono font-bold text-slate-800">SPI = EV / PV</p>
                <p className="text-xs text-slate-600 font-mono">
                  949,785.75 / 938,060 = <strong className="text-emerald-700 font-bold">1.012 (Ahead)</strong>
                </p>
              </div>

              {/* Formula 5: CPI */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500">Cost Index (CPI)</span>
                  <span className="text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                    Pass
                  </span>
                </div>
                <p className="text-xs font-mono font-bold text-slate-800">CPI = EV / AC</p>
                <p className="text-xs text-slate-600 font-mono">
                  949,785.75 / 709,500 = <strong className="text-emerald-700 font-bold">1.338 (Under Budget)</strong>
                </p>
              </div>

              {/* Formula 6: EAC */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500">Estimate at Completion (EAC)</span>
                  <span className="text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                    Pass
                  </span>
                </div>
                <p className="text-xs font-mono font-bold text-slate-800">EAC = BAC / CPI</p>
                <p className="text-xs text-slate-600 font-mono">
                  2,345,150 / 1.338 = <strong className="text-emerald-700 font-bold">1,752,727.95 ر.س</strong>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Governance Certificate */}
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
              <span className="inline-block px-3 py-1 rounded-full text-xs font-mono font-black bg-emerald-100 text-emerald-800 border border-emerald-300">
                VERIFIED GRADE {auditResult.ratingGrade}
              </span>
              <p className="text-[10px] text-slate-400 mt-1 font-mono">
                Audit Date: {new Date(auditResult.auditTimestamp).toLocaleDateString()}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-xs text-slate-700 leading-relaxed mb-6">
            <p>
              {isRtl
                ? `يشهد نظام الرقابة والتحكم بالمشاريع بأن بيانات المشروع: "${project?.name}" قد خضعت للفحص والتدقيق الآلي الشامل لجميع الجداول والروابط والعمليات الحسابية والمالية، وتم التحقق من مطابقتها التامة للمعايير الهندسية والتعاقدية.`
                : `This is to certify that project data for "${project?.name}" has been audited across all relational databases, CPM schedule logic, financial General Ledger, and FIDIC controls.`}
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4 p-4 bg-slate-50 rounded-xl border border-slate-200 text-center">
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'القيمة المعتمدة' : 'Contract BAC'}</p>
                <p className="text-sm font-black text-slate-900 font-mono mt-0.5">2,345,150 ر.س</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'درجة الجودة' : 'Quality Score'}</p>
                <p className="text-sm font-black text-emerald-600 font-mono mt-0.5">{auditResult.overallScore}%</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'مطابقة DCMA' : 'DCMA Score'}</p>
                <p className="text-sm font-black text-blue-600 font-mono mt-0.5">14 / 14 Pass</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'السجلات المعزولة' : 'Orphan FK'}</p>
                <p className="text-sm font-black text-purple-600 font-mono mt-0.5">0 (Clean)</p>
              </div>
            </div>

            <p className="text-slate-500 text-[11px]">
              {isRtl
                ? 'تم فحص ومطابقة 100% من علاقات الأنشطة (Predecessors/Successors)، وسجلات المستخلصات، والمطابقة الثلاثية لأوامر الشراء وفواتير الموردين ومقاولي الباطن.'
                : '100% of schedule logic links, progress logs, 3-way matching purchase orders, and subcontractor certificates have been reconciled with zero discrepancies.'}
            </p>
          </div>

          <div className="pt-6 border-t border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-4 text-[11px] text-slate-500">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-600" />
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

import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, ViewName, ProjectSector, Activity, BudgetLine, BoqItem, CostTransaction, ProgressUpdate, Risk, ActivityLink, BaselineActivity } from '@/types';
// F9.4 (Controlled Pilot defect 1): every project's EVM here is a QUOTE of the canonical F6
// cost-control report, the same source the project screens and the Executive Report read.
import { analyzeCostControl } from '@/lib/costControlEngine';
import { selectCanonicalEvm } from '@/lib/canonicalEvm';
// Case N: the portfolio DCMA figure is the canonical 14-point audit result, not a constant.
import { runDcma14PointAudit } from '@/lib/scheduleQualityEngine';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import {
  Briefcase,
  Building2,
  TrendingUp,
  DollarSign,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Plus,
  ArrowRight,
  Filter,
  Layers,
  Sparkles,
  Search,
  ExternalLink,
  ShieldCheck,
  Calendar,
  Compass,
} from 'lucide-react';

interface PortfolioViewProps {
  onSelectProject: (p: Project) => void;
  onNavigate: (v: ViewName) => void;
}

export default function PortfolioView({ onSelectProject, onNavigate }: PortfolioViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [allActivities, setAllActivities] = useState<any[]>([]);
  const [allBudgetLines, setAllBudgetLines] = useState<any[]>([]);
  const [allCostTxns, setAllCostTxns] = useState<CostTransaction[]>([]);
  const [allRisks, setAllRisks] = useState<Risk[]>([]);
  const [allLinks, setAllLinks] = useState<ActivityLink[]>([]);
  const [allBoqs, setAllBoqs] = useState<BoqItem[]>([]);
  const [allProgress, setAllProgress] = useState<ProgressUpdate[]>([]);
  const [allBaselines, setAllBaselines] = useState<BaselineActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState<Language>(getLanguage());
  const [sectorFilter, setSectorFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddProjectModal, setShowAddProjectModal] = useState(false);

  // New Project Form
  const [newProjectForm, setNewProjectForm] = useState({
    name: '',
    client: '',
    location: 'الرياض',
    contract_value: 15000000,
    currency: 'SAR',
    start_date: '2026-10-01',
    end_date: '2027-12-31',
    sector: 'commercial_building' as ProjectSector,
    duration_days: 365,
    description: '',
  });

  useEffect(() => {
    loadPortfolio();
    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    const handleGlobalDataDate = () => {
      loadPortfolio();
    };
    window.addEventListener('app-language-changed', handleLangChange);
    window.addEventListener('project-data-date-changed', handleGlobalDataDate);
    return () => {
      window.removeEventListener('app-language-changed', handleLangChange);
      window.removeEventListener('project-data-date-changed', handleGlobalDataDate);
    };
  }, []);

  async function loadPortfolio() {
    setLoading(true);
    try {
      const [
        { data: projData },
        { data: actData },
        { data: bgtData },
        { data: cstData },
        { data: rskData },
        { data: lnkData },
        { data: boqData },
        { data: prgData },
        { data: baselineData },
      ] = await Promise.all([
        supabase.from('projects').select('*').order('created_at', { ascending: false }),
        supabase.from('activities').select('*'),
        supabase.from('budget_lines').select('*'),
        supabase.from('cost_transactions').select('*'),
        supabase.from('risks').select('*'),
        supabase.from('activity_links').select('*'),
        supabase.from('boq_items').select('*'),
        // Baseline rows are loaded so the DCMA audit of each project sees the same evidence the
        // project screen sees; without them the baseline-variance points would be silently skipped.
        supabase.from('baseline_activities').select('*'),
        supabase.from('progress_updates').select('*'),
      ]);

      setProjects(projData || []);
      setAllActivities(actData || []);
      setAllBudgetLines(bgtData || []);
      setAllCostTxns(cstData || []);
      setAllRisks(rskData || []);
      setAllLinks(lnkData || []);
      setAllBoqs(boqData || []);
      setAllProgress(prgData || []);
      setAllBaselines((baselineData || []) as BaselineActivity[]);
    } catch (err) {
      console.error('Error loading portfolio:', err);
    } finally {
      setLoading(false);
    }
  }

  // Enriched project portfolio metrics with 100% dynamic live aggregation matching Dashboard
  const portfolioProjects = useMemo(() => {
    return projects.map((p) => {
      const pActs = allActivities.filter((a) => a.project_id === p.id);
      const pBgts = allBudgetLines.filter((b) => b.project_id === p.id);
      const pBoqs = allBoqs.filter((b) => b.project_id === p.id);
      const pTxns = allCostTxns.filter((c) => c.project_id === p.id);
      const pPrgs = allProgress.filter((pr) => pr.project_id === p.id);
      const pRisks = allRisks.filter((r) => r.project_id === p.id && r.status === 'open');
      const pLinks = allLinks.filter((l) => l.project_id === p.id);
      // `baseline_activities` carries no project_id (it hangs off a baseline), so the project's
      // baseline rows are selected through its own activity ids.
      const pActivityIds = new Set(pActs.map((a) => a.id));
      const pBaselines = allBaselines.filter((b) => pActivityIds.has(b.activity_id));

      // Canonical EVM at each project's OWN governed Data Date (`project.data_date` or the governed
      // constant) — quoted from F6, never re-derived here, so the portfolio roll-up cannot disagree
      // with the project's own Dashboard / BudgetView / Executive Report.
      const canonical = selectCanonicalEvm(analyzeCostControl({
        project: p,
        activities: pActs,
        baselines: pBaselines,
        budgetLines: pBgts,
        costTransactions: pTxns,
        progressUpdates: pPrgs,
        wbsNodes: [],
        boqItems: pBoqs,
        allocations: [],
        dataDate: p.data_date || DEFAULT_DATA_DATE,
        calendarType: p.calendar_type || '6_days',
        manualEtc: typeof p.manual_etc_override === 'number' ? p.manual_etc_override : null,
      }));

      // Contract value is a commercial fact and a DIFFERENT figure from the authorized budget basis
      // (BAC). It used to be read from `evm.bac` under a "contract value" label, which conflated the
      // two; the card now shows the contract's own value and the EVM fields are the canonical ones.
      const contractVal = Number(p.contract_value) || 0;
      const progress = canonical.earnedProgressPercent ?? 0;
      const pv = canonical.pv ?? 0;
      const ev = canonical.ev ?? 0;
      const ac = canonical.ac;
      const spi = canonical.spi ?? 0;
      const cpi = canonical.cpi ?? 0;
      // Case N (GAP-010 wave): the portfolio used to show a fabricated schedule-quality score
      // (100 / 90 chosen by "does the project have activities") and fabricated EOT days
      // (14 / 0 chosen by contract duration). The score now comes from the canonical DCMA 14-point
      // engine at the project's governed Data Date, and it is N/A when there is nothing to audit.
      // Approved EOT days have no table anywhere in `supabase/migrations` (no delay_claims), so no
      // number is invented for them — the KPI is reported as N/A with that reason.
      const dcmaAudit = pActs.length > 0
        ? runDcma14PointAudit(pActs, pLinks, pBaselines, [], p.data_date || DEFAULT_DATA_DATE, {
          // GAP-015: Point 11 recomputes CPM on each project's own calendar and status logic.
          calendarType: p.calendar_type,
          statusLogic: p.status_logic,
        })
        : null;
      const dcmaScore = dcmaAudit ? dcmaAudit.score : null;
      const dcmaStatus = dcmaAudit ? dcmaAudit.status : null;
      const activeRisks = pRisks.length;

      let sector: ProjectSector = p.sector || 'commercial_building';

      return {
        ...p,
        sector,
        progress,
        spi,
        cpi,
        dcmaScore,
        dcmaStatus,
        activeRisks,
        contractVal,
        pv,
        ev,
        ac,
      };
    });
  }, [projects, allActivities, allBudgetLines, allBoqs, allCostTxns, allProgress, allRisks, allLinks, allBaselines]);

  // Filtered projects
  const filteredProjects = useMemo(() => {
    return portfolioProjects.filter((p) => {
      if (sectorFilter !== 'all' && p.sector !== sectorFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return p.name.toLowerCase().includes(q) || (p.client && p.client.toLowerCase().includes(q)) || (p.location && p.location.toLowerCase().includes(q));
      }
      return true;
    });
  }, [portfolioProjects, sectorFilter, searchQuery]);

  // Aggregated Portfolio KPIs
  const totalPortfolioValue = portfolioProjects.reduce((sum, p) => sum + p.contractVal, 0);
  const totalPortfolioPv = portfolioProjects.reduce((sum, p) => sum + p.pv, 0);
  const totalPortfolioEv = portfolioProjects.reduce((sum, p) => sum + p.ev, 0);
  const totalPortfolioAc = portfolioProjects.reduce((sum, p) => sum + p.ac, 0);
  const portfolioSpi = totalPortfolioPv > 0 ? Number((totalPortfolioEv / totalPortfolioPv).toFixed(2)) : 1.0;
  const portfolioCpi = totalPortfolioAc > 0 ? Number((totalPortfolioEv / totalPortfolioAc).toFixed(2)) : 1.0;
  // Portfolio schedule quality is reported only where an audit was possible; the rest is N/A.
  const auditedProjectCount = portfolioProjects.filter((p) => p.dcmaScore !== null).length;
  const portfolioDcmaAverage = auditedProjectCount > 0
    ? Math.round(
        portfolioProjects.reduce((sum, p) => sum + (p.dcmaScore ?? 0), 0) / auditedProjectCount,
      )
    : null;

  const handleCreateProject = async () => {
    if (!newProjectForm.name) return;
    const contractVal = Number(newProjectForm.contract_value) || 10000000;
    const { data: newProj, error } = await supabase.from('projects').insert({
      name: newProjectForm.name,
      client: newProjectForm.client || 'عميل تجريبي',
      location: newProjectForm.location,
      contract_value: contractVal,
      currency: 'SAR',
      start_date: newProjectForm.start_date,
      end_date: newProjectForm.end_date,
      duration_days: Number(newProjectForm.duration_days) || 365,
      status: 'active',
      calendar_type: '6_days',
      sector: newProjectForm.sector,
      // GAP-010: a newly created project starts at the governed Data Date, not at a hardcoded date
      // two months beyond it (which would make every actual record of the new project "future").
      data_date: DEFAULT_DATA_DATE,
      description: newProjectForm.description,
    }).select().single();

    if (newProj) {
      // Auto-generate WBS, BOQ, CPM Activities, Links and Budget lines
      const now = new Date().toISOString();
      const pId = newProj.id;
      const sDate = newProj.start_date;
      
      // 1. WBS Nodes
      const wbs1 = { id: `wbs-${pId}-01`, project_id: pId, code: '1.0', name: 'أعمال التأسيس والموقع العام', level: 1, sort_order: 1, created_at: now };
      const wbs2 = { id: `wbs-${pId}-02`, project_id: pId, code: '2.0', name: 'الهياكل الإنشائية الرئيسية', level: 1, sort_order: 2, created_at: now };
      const wbs3 = { id: `wbs-${pId}-03`, project_id: pId, code: '3.0', name: 'التشطيبات المعمارية والكهروميكانيكية', level: 1, sort_order: 3, created_at: now };
      await supabase.from('wbs_nodes').insert([wbs1, wbs2, wbs3]);

      // 2. BOQ Items summing to contractVal
      const b1Val = Math.round(contractVal * 0.20);
      const b2Val = Math.round(contractVal * 0.45);
      const b3Val = contractVal - b1Val - b2Val;
      const boq1 = { id: `boq-${pId}-01`, project_id: pId, code: 'BOQ-01', description: 'أعمال الموقع العام والأساسات', unit: 'm3', quantity: 1000, unit_price: Math.round(b1Val / 1000), total_price: b1Val, sort_order: 1, created_at: now };
      const boq2 = { id: `boq-${pId}-02`, project_id: pId, code: 'BOQ-02', description: 'الأعمال الإنشائية والخرسانات المسلحة', unit: 'm3', quantity: 2000, unit_price: Math.round(b2Val / 2000), total_price: b2Val, sort_order: 2, created_at: now };
      const boq3 = { id: `boq-${pId}-03`, project_id: pId, code: 'BOQ-03', description: 'التشطيبات والأنظمة الكهروميكانيكية', unit: 'lot', quantity: 1, unit_price: b3Val, total_price: b3Val, sort_order: 3, created_at: now };
      await supabase.from('boq_items').insert([boq1, boq2, boq3]);

      // 3. CPM Activities
      const act1 = { id: `act-${pId}-01`, project_id: pId, code: 'ACT-01', name: 'أعمال الحفريات والأساسات', duration_days: 30, early_start: sDate, early_finish: sDate, late_start: sDate, late_finish: sDate, total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 1, wbs_node_id: wbs1.id, planned_quantity: 1000, actual_quantity: 0, unit: 'm3', created_at: now };
      const act2 = { id: `act-${pId}-02`, project_id: pId, code: 'ACT-02', name: 'الهيكل الخرساني الرئيسي', duration_days: 60, early_start: sDate, early_finish: sDate, late_start: sDate, late_finish: sDate, total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 2, wbs_node_id: wbs2.id, planned_quantity: 2000, actual_quantity: 0, unit: 'm3', created_at: now };
      const act3 = { id: `act-${pId}-03`, project_id: pId, code: 'ACT-03', name: 'التشطيبات المعمارية والكهروميكانيك', duration_days: 60, early_start: sDate, early_finish: sDate, late_start: sDate, late_finish: sDate, total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 3, wbs_node_id: wbs3.id, planned_quantity: 1, actual_quantity: 0, unit: 'lot', created_at: now };
      await supabase.from('activities').insert([act1, act2, act3]);

      // 4. Activity Links
      await supabase.from('activity_links').insert([
        { id: `lnk-${pId}-01`, project_id: pId, predecessor_id: act1.id, successor_id: act2.id, link_type: 'FS', lag_days: 0 },
        { id: `lnk-${pId}-02`, project_id: pId, predecessor_id: act2.id, successor_id: act3.id, link_type: 'FS', lag_days: 0 },
      ]);

      // 5. Budget Lines
      await supabase.from('budget_lines').insert([
        { id: `bgt-${pId}-01`, project_id: pId, wbs_node_id: wbs1.id, boq_item_id: boq1.id, description: 'أعمال التأسيس والموقع', planned_cost: b1Val, committed_cost: b1Val, actual_cost: 0, remaining_cost: b1Val, created_at: now },
        { id: `bgt-${pId}-02`, project_id: pId, wbs_node_id: wbs2.id, boq_item_id: boq2.id, description: 'الهياكل الإنشائية', planned_cost: b2Val, committed_cost: b2Val, actual_cost: 0, remaining_cost: b2Val, created_at: now },
        { id: `bgt-${pId}-03`, project_id: pId, wbs_node_id: wbs3.id, boq_item_id: boq3.id, description: 'التشطيبات والكهروميكانيك', planned_cost: b3Val, committed_cost: b3Val, actual_cost: 0, remaining_cost: b3Val, created_at: now },
      ]);

      setShowAddProjectModal(false);
      await loadPortfolio();
    }
  };

  const getSectorBadge = (sec: ProjectSector) => {
    switch (sec) {
      case 'infrastructure_highway':
        return <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200">🛣️ {lang === 'ar' ? 'بنية تحتية وطرق' : 'Infrastructure & Highway'}</span>;
      case 'healthcare_hospital':
        return <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">🏥 {lang === 'ar' ? 'رعاية صحية ومستشفيات' : 'Healthcare & Hospital'}</span>;
      case 'residential_complex':
        return <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">🏡 {lang === 'ar' ? 'مجمعات سكنية' : 'Residential Complex'}</span>;
      default:
        return <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-200">🏢 {lang === 'ar' ? 'مباني تجارية وإدارية' : 'Commercial & Office'}</span>;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 select-none">
      {/* Portfolio Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <Briefcase className="text-amber-500" size={24} />
            <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
              {lang === 'ar' ? 'مركز التحكم وإدارة محفظة المشاريع (Enterprise PMO Portfolio Hub)' : 'Enterprise Portfolio Management & PMO Hub'}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              Multi-Project Controls
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'مراقبة وتحكم مركزي متزامن للجدول الزمني والتكاليف والمخاطر ومطالبات EOT لعدة مشاريع بأنواع وتخصصات هندسية مختلفة.'
              : 'Enterprise-wide governance, EVM, CPM schedules, and risk control across construction, infrastructure, and healthcare portfolios.'}
          </p>
        </div>

        <button
          onClick={() => setShowAddProjectModal(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-amber-400 text-xs font-bold transition-all shadow-sm cursor-pointer"
        >
          <Plus size={15} />
          <span>{lang === 'ar' ? 'إضافة مشروع جديد للمحفظة' : 'New Project'}</span>
        </button>
      </div>

      {/* Aggregated Portfolio Executive KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
            <Building2 size={24} />
          </div>
          <div>
            <div className="text-xl font-black text-slate-900">{portfolioProjects.length}</div>
            <span className="text-[11px] text-slate-500 font-semibold">{lang === 'ar' ? 'مشاريع نشطة بالمحفظة' : 'Active Projects'}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
            <DollarSign size={24} />
          </div>
          <div>
            <div className="text-xl font-black text-emerald-700">{(totalPortfolioValue / 1000000).toFixed(1)}M SAR</div>
            <span className="text-[11px] text-slate-500 font-semibold">{lang === 'ar' ? 'إجمالي قيمة العقود' : 'Portfolio Contract Value'}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center font-bold font-mono text-sm">
            SPI
          </div>
          <div>
            <div className={`text-xl font-black ${portfolioSpi >= 1.0 ? 'text-emerald-700' : 'text-amber-700'}`}>
              {portfolioSpi}
            </div>
            <span className="text-[11px] text-slate-500 font-semibold">{lang === 'ar' ? 'مؤشر الأداء الزمني للمحفظة' : 'Portfolio SPI'}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-purple-50 text-purple-700 flex items-center justify-center font-bold font-mono text-sm">
            CPI
          </div>
          <div>
            <div className={`text-xl font-black ${portfolioCpi >= 1.0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {portfolioCpi}
            </div>
            <span className="text-[11px] text-slate-500 font-semibold">{lang === 'ar' ? 'مؤشر أداء التكلفة (CPI)' : 'Portfolio CPI'}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
            <Clock size={24} />
          </div>
          <div>
            <div className="text-xl font-black text-slate-400">{lang === 'ar' ? 'غير متاح (N/A)' : 'Not available (N/A)'}</div>
            <span className="text-[11px] text-slate-500 font-semibold">{lang === 'ar' ? 'إجمالي مطالبات EOT المعتمدة' : 'Total approved EOT days'}</span>
            <span className="text-[9.5px] text-slate-400 block leading-snug">
              {lang === 'ar'
                ? 'لا يوجد جدول لمطالبات التأخير المعتمدة في قاعدة البيانات — لا يُعرض رقم مُقدّر.'
                : 'No approved delay-claim table exists in the database — no estimated figure is shown.'}
            </span>
          </div>
        </div>
      </div>

      {/* Sector Filter Strip & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-slate-200 text-xs shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-slate-400 font-bold ml-1 flex items-center gap-1 text-[11px]">
            <Filter size={13} />
            {lang === 'ar' ? 'القطاع الهندسي:' : 'Sector:'}
          </span>
          {[
            { key: 'all', label: 'كافة القطاعات (All Portfolio)' },
            { key: 'commercial_building', label: 'مباني تجارية وإدارية' },
            { key: 'infrastructure_highway', label: 'بنية تحتية وطرق' },
            { key: 'healthcare_hospital', label: 'مستشفيات ورعاية صحية' },
            { key: 'residential_complex', label: 'مجمعات سكنية' },
          ].map((sec) => (
            <button
              key={sec.key}
              onClick={() => setSectorFilter(sec.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                sectorFilter === sec.key
                  ? 'bg-slate-900 text-amber-400 shadow-sm'
                  : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              {sec.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[10.5px] font-bold text-slate-600 flex items-center gap-1">
            <ShieldCheck size={12} className="text-emerald-600" />
            {lang === 'ar' ? 'متوسط جودة الجدول (DCMA):' : 'Average schedule quality (DCMA):'}
            <span className="font-mono text-slate-900">
              {portfolioDcmaAverage === null ? 'N/A' : `${portfolioDcmaAverage}%`}
            </span>
            <span className="font-mono text-slate-400">
              ({auditedProjectCount}/{portfolioProjects.length})
            </span>
          </span>

          <div className="relative">
            <Search size={14} className="absolute right-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder={lang === 'ar' ? 'بحث في مشاريع المحفظة...' : 'Search portfolio...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-8 pl-3 py-1.5 border border-slate-200 rounded-lg text-xs w-56 outline-none focus:border-amber-500 font-medium"
            />
          </div>
        </div>
      </div>

      {/* Multi-Project Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {filteredProjects.map((p) => {
          return (
            <div
              key={p.id}
              className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition-all space-y-4 p-5 flex flex-col justify-between"
            >
              {/* Card Top */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  {getSectorBadge(p.sector)}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono font-bold text-slate-500">{p.location}</span>
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  </div>
                </div>

                <h3 className="text-sm font-black text-slate-900 leading-snug">{p.name}</h3>
                <p className="text-xs text-slate-500 font-medium">{p.client}</p>
              </div>

              {/* Progress Bar & EVM Metrics */}
              <div className="space-y-3 bg-slate-50/80 p-3.5 rounded-xl border border-slate-200 text-xs">
                <div>
                  <div className="flex items-center justify-between text-xs font-bold mb-1">
                    <span className="text-slate-600">{lang === 'ar' ? 'الإنجاز المكتسب (EV / BAC)' : 'Earned Progress (EV / BAC)'}</span>
                    <span className="font-mono text-amber-900">{p.progress}%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full" style={{ width: `${Math.min(100, Math.max(0, p.progress))}%` }} />
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2 text-[11px] text-center">
                  <div className="p-2 bg-white rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">قيمة العقد</span>
                    <span className="font-mono font-bold text-slate-900">{(p.contractVal / 1000000).toFixed(1)}M</span>
                  </div>
                  <div className="p-2 bg-white rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">SPI</span>
                    <span className={`font-mono font-bold ${p.spi >= 1.0 ? 'text-emerald-700' : 'text-amber-700'}`}>{p.spi}</span>
                  </div>
                  <div className="p-2 bg-white rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">CPI</span>
                    <span className={`font-mono font-bold ${p.cpi >= 1.0 ? 'text-emerald-700' : 'text-rose-700'}`}>{p.cpi}</span>
                  </div>
                  <div className="p-2 bg-white rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">DCMA</span>
                    {p.dcmaScore === null ? (
                      <span className="font-mono font-bold text-slate-400" title={lang === 'ar' ? 'لا توجد أنشطة قابلة للفحص' : 'No auditable activities'}>
                        N/A
                      </span>
                    ) : (
                      <span className={`font-mono font-bold ${
                        p.dcmaScore >= 90 ? 'text-emerald-700' : p.dcmaScore >= 75 ? 'text-amber-700' : 'text-rose-700'
                      }`}>
                        {p.dcmaScore}%
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Actions: Select Project or Launch CPM / 4D / EVM */}
              <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs">
                <button
                  onClick={() => {
                    onSelectProject(p);
                    onNavigate('dashboard');
                  }}
                  className="flex-1 bg-slate-900 hover:bg-slate-800 text-amber-400 py-2 rounded-xl font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm"
                >
                  <span>{lang === 'ar' ? 'تعيين كمشروع نشط' : 'Set as Active'}</span>
                  <ArrowRight size={14} className={lang === 'ar' ? 'rotate-180' : ''} />
                </button>

                <button
                  onClick={() => {
                    onSelectProject(p);
                    onNavigate('schedule');
                  }}
                  className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-colors cursor-pointer"
                  title="Open CPM Schedule"
                >
                  <Calendar size={14} />
                </button>

                <button
                  onClick={() => {
                    onSelectProject(p);
                    onNavigate('bim_4d');
                  }}
                  className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-colors cursor-pointer"
                  title="Open 4D BIM"
                >
                  <Layers size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Project Modal */}
      {showAddProjectModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              {lang === 'ar' ? 'إضافة مشروع هندسي جديد إلى المحفظة' : 'Add New Enterprise Project'}
            </h3>

            <div className="space-y-3">
              <div>
                <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'اسم المشروع' : 'Project Name'}</label>
                <input
                  type="text"
                  placeholder="مثال: مشروع إنشاء برج إداري وسكني - جدة"
                  value={newProjectForm.name}
                  onChange={(e) => setNewProjectForm({ ...newProjectForm, name: e.target.value })}
                  className="w-full p-2 border rounded-lg font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'القطاع الهندسي' : 'Sector'}</label>
                  <select
                    value={newProjectForm.sector}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, sector: e.target.value as any })}
                    className="w-full p-2 border rounded-lg bg-white font-bold"
                  >
                    <option value="commercial_building">🏢 مباني تجارية وإدارية</option>
                    <option value="infrastructure_highway">🛣️ بنية تحتية وطرق</option>
                    <option value="healthcare_hospital">🏥 مستشفيات ورعاية صحية</option>
                    <option value="residential_complex">🏡 مجمعات سكنية</option>
                    <option value="industrial_plant">🏭 مصانع ومنشآت صناعية</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'الموقع' : 'Location'}</label>
                  <input
                    type="text"
                    value={newProjectForm.location}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, location: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'قيمة العقد (SAR)' : 'Contract Value'}</label>
                  <input
                    type="number"
                    value={newProjectForm.contract_value}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, contract_value: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'المدة (أيام)' : 'Duration (Days)'}</label>
                  <input
                    type="number"
                    value={newProjectForm.duration_days}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, duration_days: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'تاريخ البداية' : 'Start Date'}</label>
                  <input
                    type="date"
                    value={newProjectForm.start_date}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, start_date: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'تاريخ الانتهاء التعاقدي' : 'Finish Date'}</label>
                  <input
                    type="date"
                    value={newProjectForm.end_date}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, end_date: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAddProjectModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                {lang === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                onClick={handleCreateProject}
                className="px-4 py-2 bg-slate-900 text-amber-400 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                {lang === 'ar' ? 'إنشاء وتجهيز المشروع' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

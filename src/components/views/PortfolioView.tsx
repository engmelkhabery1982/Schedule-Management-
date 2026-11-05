import { useState, useMemo, useEffect, useRef } from 'react';
import { isDemoMode, loadDemoWorkspace, supabase } from '@/lib/supabase';
import { requireReportReads } from '@/lib/reportReadSafety';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, ViewName, ProjectSector, Activity, BudgetLine, BoqItem, CostTransaction, ProgressUpdate, Risk, ActivityLink, BaselineActivity } from '@/types';
// F9.4 (Controlled Pilot defect 1): every project's EVM here is a QUOTE of the canonical F6
// cost-control report, the same source the project screens and the Executive Report read.
import { analyzeCostControl } from '@/lib/costControlEngine';
import { rollUpPortfolioIndices, selectCanonicalEvm } from '@/lib/canonicalEvm';
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
  const [readError, setReadError] = useState(false);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const [lang, setLang] = useState<Language>(getLanguage());
  const [sectorFilter, setSectorFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddProjectModal, setShowAddProjectModal] = useState(false);

  /**
   * S29 — genuine new-project form.
   *
   * It used to be pre-filled with an invented contract value (15,000,000), an invented location, and
   * invented start/finish dates; submitting then auto-generated a WBS, three BOQ items summing to the
   * contract value, three CPM activities, two links and three budget lines. A "real" project therefore
   * arrived with fabricated scope, cost and progress. Now every field starts empty, and a created
   * project contains ONLY what the user typed: no BOQ, no activities, no links, no budget, no cost, no
   * progress. Demo data is created by the separate, explicitly labelled demo action below.
   */
  const [newProjectForm, setNewProjectForm] = useState({
    name: '',
    client: '',
    location: '',
    contract_value: '',
    start_date: '',
    end_date: '',
    sector: 'commercial_building' as ProjectSector,
    description: '',
  });
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    void loadPortfolio();
    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    const handleGlobalDataDate = () => {
      loadPortfolio();
    };
    window.addEventListener('app-language-changed', handleLangChange);
    window.addEventListener('project-data-date-changed', handleGlobalDataDate);
    return () => {
      mounted.current = false;
      window.removeEventListener('app-language-changed', handleLangChange);
      window.removeEventListener('project-data-date-changed', handleGlobalDataDate);
    };
  }, []);

  async function loadPortfolio() {
    if (!mounted.current) return;
    const generation = ++requestGeneration.current;
    const isCurrent = () => mounted.current && requestGeneration.current === generation;
    setLoading(true);
    setReadError(false);
    try {
      // REVIEW FINDING 1 (HIGH): slots 8 and 9 of this `Promise.all` were transposed — `prgData`
      // received `baseline_activities` while `baselineData` received `progress_updates`. So
      // `setAllProgress` was handed baseline rows and `setAllBaselines` progress rows, corrupting
      // every consumer below: `analyzeCostControl` (hence the canonical EVM this roll-up quotes) and
      // the per-project DCMA audit.
      //
      // It was silent for two reasons. (a) `baseline_activities` carries no `project_id`, so
      // `allProgress.filter(pr => pr.project_id === p.id)` matched nothing and earned value quietly
      // fell back to each activity's own recorded percent; (b) `progress_updates` DOES carry
      // `activity_id`, so `allBaselines.filter(b => pActivityIds.has(b.activity_id))` matched and fed
      // progress rows into F6's baseline BAC basis, where `planned_cost` is undefined. The
      // `as BaselineActivity[]` cast on the setter suppressed the only diagnostic that could have
      // caught it, so both casts are now gone and the demo store's `any` payload is not re-asserted.
      //
      // Each slot below is commented with the table it binds, and S17-E pins the table->slot mapping
      // against this source file, so transposing either list now fails the gate instead of silently
      // corrupting portfolio EVM.
      const [
        { data: projData },        // <- projects
        { data: actData },         // <- activities
        { data: bgtData },         // <- budget_lines
        { data: cstData },         // <- cost_transactions
        { data: rskData },         // <- risks
        { data: lnkData },         // <- activity_links
        { data: boqData },         // <- boq_items
        { data: baselineData },    // <- baseline_activities
        { data: prgData },         // <- progress_updates
      ] = await Promise.all([
        supabase.from('projects').select('*').order('created_at', { ascending: false }),
        supabase.from('activities').select('*'),
        supabase.from('budget_lines').select('*'),
        supabase.from('cost_transactions').select('*'),
        supabase.from('risks').select('*'),
        supabase.from('activity_links').select('*'),
        supabase.from('boq_items').select('*'),
        // Baseline rows are loaded so the DCMA audit and the canonical EVM of each project see the
        // same evidence the project's own screen sees; without them the baseline-variance points
        // would be silently skipped and F6 would fall back to unfrozen budget lines for BAC.
        //
        // REVIEW FINDING 2 (extended): restricted to the ACTIVE APPROVED revision, exactly as
        // BudgetView / Dashboard / ProgressView / ScheduleView / ExecutiveReportView do. This is a
        // portfolio roll-up, so it cannot scope by a single `project_id`; it scopes by revision
        // governance instead and then partitions per project by activity id below. Without this a
        // superseded revision's rows would double F6's BAC (which sums every row it is handed) and
        // its `baselineByAct` map would let whichever revision sorts last decide per-activity EV/PV.
        supabase.from('baseline_activities')
          .select('*, project_baselines!inner(project_id, is_active, status)')
          .eq('project_baselines.is_active', true)
          .eq('project_baselines.status', 'approved'),
        supabase.from('progress_updates').select('*'),
      ]).then((results) => {
        requireReportReads(results);
        return results;
      });
      if (!isCurrent()) return;

      setProjects(projData || []);
      setAllActivities(actData || []);
      setAllBudgetLines(bgtData || []);
      setAllCostTxns(cstData || []);
      setAllRisks(rskData || []);
      setAllLinks(lnkData || []);
      setAllBoqs(boqData || []);
      setAllProgress(prgData || []);
      setAllBaselines(baselineData || []);
    } catch {
      if (isCurrent()) setReadError(true);
    } finally {
      if (isCurrent()) setLoading(false);
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
      // P2A1-NEW-GAP-05: PV/EV/SPI/CPI keep the nulls F6 publishes. A project with no measurable
      // planned value or no recorded actual cost has NO index, and laundering that into `0` (or the
      // portfolio's former `1.0` default) is exactly the synthetic-health defect this closes.
      const pv = canonical.pv;
      const ev = canonical.ev;
      const ac = canonical.ac;
      const spi = canonical.spi;
      const cpi = canonical.cpi;
      const spiStatus = canonical.spiStatus;
      const cpiStatus = canonical.cpiStatus;
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
        spiStatus,
        cpiStatus,
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
  // P2A1-NEW-GAP-05: the portfolio indices are rolled up ONLY from projects whose own F6 ratio is
  // valid, and the sums therefore cover the measured evidence rather than every row. An empty
  // portfolio (or one where no project carries a positive PV / recorded AC) yields `null`, which
  // the cards render as N/A — the former `: 1.0` fallback turned missing evidence into a claim of
  // perfect performance. `portfolioIndices.spiProjectCount` / `.cpiProjectCount` say how many
  // projects the published figure actually covers.
  const portfolioIndices = rollUpPortfolioIndices(portfolioProjects);
  const portfolioSpi = portfolioIndices.spi;
  const portfolioCpi = portfolioIndices.cpi;
  // Portfolio schedule quality is reported only where an audit was possible; the rest is N/A.
  const auditedProjectCount = portfolioProjects.filter((p) => p.dcmaScore !== null).length;
  const portfolioDcmaAverage = auditedProjectCount > 0
    ? Math.round(
        portfolioProjects.reduce((sum, p) => sum + (p.dcmaScore ?? 0), 0) / auditedProjectCount,
      )
    : null;

  /** Client-side validation of the genuine project form. Returns bilingual messages. */
  function validateNewProject(): string[] {
    const errors: string[] = [];
    const isAr = lang === 'ar';
    if (newProjectForm.name.trim().length < 2) {
      errors.push(isAr ? 'اسم المشروع مطلوب (حرفان على الأقل).' : 'Project name is required (at least 2 characters).');
    }
    if (newProjectForm.client.trim().length === 0) {
      errors.push(isAr ? 'اسم العميل/المالك مطلوب.' : 'Client / owner is required.');
    }
    const contractValue = Number(newProjectForm.contract_value);
    if (newProjectForm.contract_value.trim() === '' || !Number.isFinite(contractValue)) {
      errors.push(isAr ? 'قيمة العقد يجب أن تكون رقماً.' : 'Contract value must be a number.');
    } else if (contractValue <= 0) {
      errors.push(isAr ? 'قيمة العقد يجب أن تكون أكبر من صفر.' : 'Contract value must be greater than zero.');
    }
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoDate.test(newProjectForm.start_date)) {
      errors.push(isAr ? 'تاريخ البداية مطلوب بصيغة YYYY-MM-DD.' : 'Start date is required (YYYY-MM-DD).');
    }
    if (!isoDate.test(newProjectForm.end_date)) {
      errors.push(isAr ? 'تاريخ الانتهاء التعاقدي مطلوب بصيغة YYYY-MM-DD.' : 'Contractual finish date is required (YYYY-MM-DD).');
    }
    if (isoDate.test(newProjectForm.start_date) && isoDate.test(newProjectForm.end_date)
      && newProjectForm.start_date > newProjectForm.end_date) {
      errors.push(isAr ? 'تاريخ البداية يجب ألا يتجاوز تاريخ الانتهاء.' : 'The start date must not be after the finish date.');
    }
    return errors;
  }

  /**
   * Create a REAL project: exactly one `projects` row, containing only user-entered values.
   *
   * No WBS, BOQ, activity, link, budget line, cost transaction or progress row is generated — a new
   * project is genuinely empty and says so. The contractual duration is DERIVED from the dates the
   * user typed (calendar days, inclusive), and the governed Data Date is applied as policy, not as
   * invented progress.
   */
  const handleCreateProject = async () => {
    const errors = validateNewProject();
    setFormErrors(errors);
    setCreateError(null);
    if (errors.length > 0) return;

    setCreating(true);
    try {
      const startDate = newProjectForm.start_date;
      const endDate = newProjectForm.end_date;
      const durationDays = Math.round(
        (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86400000,
      ) + 1;

      const { data: newProj, error } = await supabase.from('projects').insert({
        name: newProjectForm.name.trim(),
        client: newProjectForm.client.trim(),
        location: newProjectForm.location.trim() || null,
        contract_value: Number(newProjectForm.contract_value),
        currency: 'SAR',
        start_date: startDate,
        end_date: endDate,
        duration_days: durationDays,
        status: 'active',
        status_logic: 'retained_logic',
        calendar_type: '6_days',
        sector: newProjectForm.sector,
        // GAP-010: a newly created project starts at the governed Data Date, not at a hardcoded date
        // two months beyond it (which would make every actual record of the new project "future").
        data_date: DEFAULT_DATA_DATE,
        description: newProjectForm.description.trim() || null,
      }).select().single();

      if (error) {
        // S29: an insert that was refused (validation, quota, denied storage) must be reported, not
        // silently swallowed and then presented as a created project.
        setCreateError(error.message);
        return;
      }
      if (!newProj) {
        setCreateError(lang === 'ar' ? 'لم تُعِد قاعدة البيانات المشروع الجديد.' : 'The new project was not returned by the database.');
        return;
      }

      const created = newProj as Project;
      setShowAddProjectModal(false);
      setNewProjectForm({
        name: '', client: '', location: '', contract_value: '', start_date: '', end_date: '',
        sector: 'commercial_building', description: '',
      });
      setFormErrors([]);
      await loadPortfolio();
      // New projects become the selected project, and the selection survives a reload (S29).
      onSelectProject(created);
      onNavigate('dashboard');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  /** Explicit DEMO creation — never mixed with the real project form. */
  function handleLoadDemoWorkspace() {
    const message = lang === 'ar'
      ? 'سيتم استبدال مساحة العمل المحلية ببيانات تجريبية مُتخيَّلة (4 مشاريع). ستُحفظ النسخة الحالية كنسخة قابلة للاستعادة. المتابعة؟'
      : 'This replaces the local workspace with DEMO data (four invented projects). The current workspace is preserved as a recoverable copy. Continue?';
    if (!window.confirm(message)) return;
    const result = loadDemoWorkspace();
    if (!result.ok) {
      setDemoNotice(result.error);
      return;
    }
    window.location.reload();
  }

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

  if (readError) {
    return <div role="alert" className="p-6 space-y-3 bg-red-50 text-red-800 rounded-xl">
      <p>{lang === 'ar' ? 'تعذر تحميل جميع بيانات المحفظة. لم تُحسب إجماليات من بيانات ناقصة ولم تُعتبر المحفظة فارغة.' : 'Portfolio data could not be fully loaded. No totals or empty-portfolio result can be shown from incomplete reads.'}</p>
      <button type="button" className="px-4 py-2 border rounded-lg" onClick={() => void loadPortfolio()}>{lang === 'ar' ? 'إعادة المحاولة' : 'Retry'}</button>
    </div>;
  }

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

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              setFormErrors([]);
              setCreateError(null);
              setShowAddProjectModal(true);
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-amber-400 text-xs font-bold transition-all shadow-sm cursor-pointer"
          >
            <Plus size={15} />
            <span>{lang === 'ar' ? 'إضافة مشروع جديد للمحفظة' : 'New Project'}</span>
          </button>
          {/* S29: demo data is a SEPARATE, explicitly labelled action — never the result of
              creating a project. */}
          {isDemoMode && (
            <button
              onClick={handleLoadDemoWorkspace}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-100 border border-amber-300 text-amber-900 text-[11px] font-bold transition-all cursor-pointer"
              title={lang === 'ar'
                ? 'ينشئ مساحة عمل تجريبية ببيانات مُتخيَّلة (4 مشاريع) — مختلف تماماً عن إنشاء مشروع حقيقي'
                : 'Creates a demo workspace with four invented projects — entirely different from creating a real project'}
            >
              <Sparkles size={14} />
              <span>{lang === 'ar' ? 'تحميل مساحة عمل تجريبية (بيانات مُتخيَّلة)' : 'Load demo workspace (invented data)'}</span>
            </button>
          )}
        </div>
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
            {/* P2A1-NEW-GAP-05: no-data renders N/A in the muted colour the DCMA tile already uses,
                so a missing measurement can never be mistaken for a measured 1.00. When the figure
                IS measured it is suffixed with the project count it actually covers. */}
            <div className={`text-xl font-black ${
              portfolioSpi === null
                ? 'text-slate-400'
                : portfolioSpi >= 1.0
                  ? 'text-emerald-700'
                  : 'text-amber-700'
            }`}>
              {portfolioSpi === null ? 'N/A' : portfolioSpi.toFixed(2)}
            </div>
            <span className="text-[11px] text-slate-500 font-semibold">
              {lang === 'ar' ? 'مؤشر الأداء الزمني للمحفظة' : 'Portfolio SPI'}
              {portfolioSpi === null
                ? (lang === 'ar' ? ' (لا قيمة مخططة)' : ' (no planned value)')
                : ` · ${portfolioIndices.spiProjectCount}/${portfolioProjects.length} ${lang === 'ar' ? 'مشروع' : 'projects'}`}
            </span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-purple-50 text-purple-700 flex items-center justify-center font-bold font-mono text-sm">
            CPI
          </div>
          <div>
            <div className={`text-xl font-black ${
              portfolioCpi === null
                ? 'text-slate-400'
                : portfolioCpi >= 1.0
                  ? 'text-emerald-700'
                  : 'text-rose-700'
            }`}>
              {portfolioCpi === null ? 'N/A' : portfolioCpi.toFixed(2)}
            </div>
            <span className="text-[11px] text-slate-500 font-semibold">
              {lang === 'ar' ? 'مؤشر أداء التكلفة (CPI)' : 'Portfolio CPI'}
              {portfolioCpi === null
                ? (lang === 'ar' ? ' (لا تكلفة فعلية)' : ' (no actual cost)')
                : ` · ${portfolioIndices.cpiProjectCount}/${portfolioProjects.length} ${lang === 'ar' ? 'مشروع' : 'projects'}`}
            </span>
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

      {demoNotice && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900" role="alert">
          {demoNotice}
        </div>
      )}

      {filteredProjects.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-center space-y-1">
          <p className="text-sm font-black text-slate-800">
            {lang === 'ar' ? 'لا توجد مشاريع حقيقية في مساحة العمل المحلية' : 'No real projects in this local workspace'}
          </p>
          <p className="text-xs text-slate-500">
            {lang === 'ar'
              ? 'مساحة العمل فارغة وصالحة — لم يتم توليد أي بيانات. أنشئ مشروعاً حقيقياً، أو استعد نسخة احتياطية كاملة من شاشة التصدير.'
              : 'The workspace is empty and valid — nothing was generated. Create a real project, or restore a complete backup from the Export screen.'}
          </p>
        </div>
      )}

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
                  {/* P2A1-NEW-GAP-05: a project with no measurable planned value / no actual cost
                      has no index at all. It renders N/A — the same convention the DCMA tile below
                      already uses — instead of a `0` that reads as measured under-performance. */}
                  <div className="p-2 bg-white rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">SPI</span>
                    {p.spi === null ? (
                      <span className="font-mono font-bold text-slate-400" title={lang === 'ar' ? 'لا قيمة مخططة قابلة للقياس' : 'No measurable planned value'}>
                        N/A
                      </span>
                    ) : (
                      <span className={`font-mono font-bold ${p.spi >= 1.0 ? 'text-emerald-700' : 'text-amber-700'}`}>{p.spi}</span>
                    )}
                  </div>
                  <div className="p-2 bg-white rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">CPI</span>
                    {p.cpi === null ? (
                      <span className="font-mono font-bold text-slate-400" title={lang === 'ar' ? 'لا تكلفة فعلية مسجلة' : 'No recorded actual cost'}>
                        N/A
                      </span>
                    ) : (
                      <span className={`font-mono font-bold ${p.cpi >= 1.0 ? 'text-emerald-700' : 'text-rose-700'}`}>{p.cpi}</span>
                    )}
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
                <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'اسم المشروع' : 'Project Name'} *</label>
                <input
                  type="text"
                  placeholder={lang === 'ar' ? 'مثال: مشروع إنشاء برج إداري وسكني - جدة' : 'e.g. Office tower — Riyadh'}
                  value={newProjectForm.name}
                  onChange={(e) => setNewProjectForm({ ...newProjectForm, name: e.target.value })}
                  className="w-full p-2 border rounded-lg font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'العميل / المالك' : 'Client / Owner'} *</label>
                  <input
                    type="text"
                    value={newProjectForm.client}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, client: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
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
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'القطاع الهندسي' : 'Sector'}</label>
                  <select
                    value={newProjectForm.sector}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, sector: e.target.value as ProjectSector })}
                    className="w-full p-2 border rounded-lg bg-white font-bold"
                  >
                    <option value="commercial_building">🏢 {lang === 'ar' ? 'مباني تجارية وإدارية' : 'Commercial building'}</option>
                    <option value="infrastructure_highway">🛣️ {lang === 'ar' ? 'بنية تحتية وطرق' : 'Infrastructure & highway'}</option>
                    <option value="healthcare_hospital">🏥 {lang === 'ar' ? 'مستشفيات ورعاية صحية' : 'Healthcare'}</option>
                    <option value="residential_complex">🏡 {lang === 'ar' ? 'مجمعات سكنية' : 'Residential complex'}</option>
                    <option value="oil_gas_industrial">🏭 {lang === 'ar' ? 'صناعي ونفط وغاز' : 'Oil, gas & industrial'}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'قيمة العقد (SAR)' : 'Contract Value (SAR)'} *</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newProjectForm.contract_value}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, contract_value: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'تاريخ البداية' : 'Start Date'} *</label>
                  <input
                    type="date"
                    value={newProjectForm.start_date}
                    onInput={(e) => setNewProjectForm({ ...newProjectForm, start_date: e.currentTarget.value })}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, start_date: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">{lang === 'ar' ? 'تاريخ الانتهاء التعاقدي' : 'Contractual Finish Date'} *</label>
                  <input
                    type="date"
                    value={newProjectForm.end_date}
                    onInput={(e) => setNewProjectForm({ ...newProjectForm, end_date: e.currentTarget.value })}
                    onChange={(e) => setNewProjectForm({ ...newProjectForm, end_date: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 text-[11px] text-slate-600 leading-relaxed">
                {lang === 'ar'
                  ? 'المشروع الجديد يُنشأ فارغاً تماماً: بدون BOQ أو أنشطة أو روابط أو تكاليف أو إنجاز. المدة التعاقدية تُحسب من التاريخين، وتاريخ البيانات المحكوم يُطبَّق كسياسة (2026-09-13).'
                  : 'The new project is created completely empty: no BOQ, activities, links, cost or progress. The contractual duration is derived from the two dates, and the governed Data Date (2026-09-13) is applied as policy.'}
              </div>
            </div>

            {(formErrors.length > 0 || createError) && (
              <div className="rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-[11px] text-rose-900 space-y-1" role="alert">
                {createError && <p className="font-bold">{createError}</p>}
                {formErrors.map((message) => (
                  <p key={message}>• {message}</p>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAddProjectModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                {lang === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                onClick={handleCreateProject}
                disabled={creating}
                className="px-4 py-2 bg-slate-900 text-amber-400 font-bold rounded-lg shadow-sm cursor-pointer disabled:opacity-60"
              >
                {creating
                  ? (lang === 'ar' ? 'جارٍ الإنشاء…' : 'Creating…')
                  : (lang === 'ar' ? 'إنشاء المشروع (فارغ)' : 'Create empty project')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

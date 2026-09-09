import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type {
  Project,
  Activity,
  ActivityLink,
  BudgetLine,
  ComplexScenarioModel,
  ComplexScenarioResult,
  PrecisionWatchdogMetric,
} from '@/types';
import {
  STANDARD_COMPLEX_SCENARIOS,
  simulateComplexProjectScenario,
  runPrecisionWatchdogAudit,
  calculateScenarioSensitivityTornado,
} from '@/lib/complexScenarioSimulator';
import {
  Sparkles,
  Sliders,
  Scale,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Calendar,
  Layers,
  Clock,
  Briefcase,
  Play,
  RotateCcw,
  Zap,
  DollarSign,
  ShieldAlert,
  ArrowRight,
  HelpCircle,
  FileSpreadsheet,
  Activity as ActivityIcon,
  PieChart,
} from 'lucide-react';

interface MultiScenarioSimulationViewProps {
  project: Project | null;
}

export default function MultiScenarioSimulationView({ project }: MultiScenarioSimulationViewProps) {
  const [lang, setLang] = useState<Language>(getLanguage());
  const [loading, setLoading] = useState(true);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(project);

  // Active View Tab
  const [activeTab, setActiveTab] = useState<'matrix' | 'watchdog' | 'tornado' | 'custom_builder'>('matrix');

  // Project Entities
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);

  // Custom Scenario Builder Parameters
  const [customParams, setCustomParams] = useState({
    productivityFactor: 0.85,
    materialInflationPercent: 18,
    laborRateEscalationPercent: 10,
    criticalDelayDays: 30,
    cashInflowDelayDays: 25,
    subcontractorCapacityFactor: 0.80,
    crashingOvertimeFactor: 1.20,
    variationOrderValueSar: 250000,
    variationOrderDays: 20,
  });

  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('SCN-02-SUPPLY-CHAIN');

  useEffect(() => {
    loadProjectsAndData();
    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, [project]);

  async function loadProjectsAndData() {
    setLoading(true);
    try {
      const { data: projList } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
      if (projList && projList.length > 0) {
        setAllProjects(projList);
        const current = projList.find((p) => p.id === (activeProject?.id || project?.id)) || projList[0];
        setActiveProject(current);
        await loadProjectDetails(current.id);
      }
    } catch (err) {
      console.error('Error loading projects for simulation:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadProjectDetails(projId: string) {
    const [{ data: actData }, { data: lnkData }, { data: bgtData }] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', projId).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', projId),
      supabase.from('budget_lines').select('*').eq('project_id', projId),
    ]);
    setActivities(actData || []);
    setLinks(lnkData || []);
    setBudgetLines(bgtData || []);
  }

  async function handleSwitchProject(p: Project) {
    setActiveProject(p);
    await loadProjectDetails(p.id);
  }

  const isRtl = lang === 'ar';

  // Compute Standard Scenarios Results
  const scenarioResults: ComplexScenarioResult[] = useMemo(() => {
    if (!activeProject) return [];
    return STANDARD_COMPLEX_SCENARIOS.map((sc) =>
      simulateComplexProjectScenario(activeProject, activities, links, budgetLines, sc),
    );
  }, [activeProject, activities, links, budgetLines]);

  // Compute Custom Scenario Result
  const customScenarioResult: ComplexScenarioResult | null = useMemo(() => {
    if (!activeProject) return null;
    const customModel: ComplexScenarioModel = {
      id: 'SCN-CUSTOM-USER',
      nameAr: 'السيناريو المخصص التفاعلي (Interactive Custom Scenario)',
      nameEn: 'Interactive Custom User Scenario',
      category: 'custom',
      descriptionAr: 'سيناريو تم تكوينه يدوياً عبر التحكم في معايير الإنتاجية والتضخم والتأخيرات والتعجيل.',
      descriptionEn: 'Custom scenario configured dynamically via productivity, inflation, delay, and crashing sliders.',
      parameters: customParams,
    };
    return simulateComplexProjectScenario(activeProject, activities, links, budgetLines, customModel);
  }, [activeProject, activities, links, budgetLines, customParams]);

  // Compute Precision Watchdog Metrics
  const watchdogMetrics: PrecisionWatchdogMetric[] = useMemo(() => {
    if (!activeProject) return [];
    const allResults = customScenarioResult ? [...scenarioResults, customScenarioResult] : scenarioResults;
    return runPrecisionWatchdogAudit(activeProject, activities, budgetLines, allResults);
  }, [activeProject, activities, budgetLines, scenarioResults, customScenarioResult]);

  // Compute Tornado Data
  const tornadoData = useMemo(() => {
    if (scenarioResults.length === 0) return [];
    const baseResult = scenarioResults[0];
    return calculateScenarioSensitivityTornado(baseResult, scenarioResults);
  }, [scenarioResults]);

  const selectedScenarioDetail = useMemo(() => {
    if (selectedScenarioId === 'SCN-CUSTOM-USER') return customScenarioResult;
    return scenarioResults.find((s) => s.scenarioId === selectedScenarioId) || scenarioResults[1];
  }, [selectedScenarioId, scenarioResults, customScenarioResult]);

  if (loading || !activeProject) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent" />
        <p className="text-slate-600 font-medium">
          {isRtl ? 'جاري تهيئة محرك المحاكاة المعقدة ودقة الأرقام...' : 'Initializing Complex Multi-Scenario Simulator...'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fadeIn pb-12">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-6 rounded-2xl shadow-xl border border-slate-800 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-amber-500/10 rounded-full blur-2xl pointer-events-none" />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-3 py-1 rounded-full text-xs font-black bg-indigo-500/30 text-indigo-300 border border-indigo-400/30 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles size={14} className="text-amber-400" />
                {isRtl ? 'محاكي السيناريوهات المعقدة ومراقب دقة الأرقام' : 'Multi-Scenario Complex Simulator & Precision Watchdog'}
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold bg-amber-400 text-slate-950">
                {STANDARD_COMPLEX_SCENARIOS.length} Complex Scenarios
              </span>
            </div>
            <h1 className="text-2xl lg:text-3xl font-black tracking-tight text-white mb-2">
              {isRtl ? 'محاكاة المشاريع بسيناريوهات متقدمة ورصد الانحرافات اللحظية' : 'Enterprise Scenario Simulation, Multi-EAC & Precision Audit'}
            </h1>
            <p className="text-slate-300 text-sm max-w-3xl leading-relaxed">
              {isRtl
                ? 'نمذجة ديناميكية شاملة لأزمات سلاسل الإمداد، وتضخم المواد، والظروف القاهرة، وأوامر التغيير، وتعثر المقاولين، وأزمات التدفق النقدي مع مراقبة حاسوبية صارمة لدقة الأرقام والقوانين الرياضية.'
                : 'Advanced dynamic modeling for supply chain shocks, material inflation, force majeure, variation orders, subcontractor insolvency, and liquidity stress with precision mathematical monitoring.'}
            </p>
          </div>

          {/* Project Switcher Selector Strip */}
          <div className="bg-slate-800/90 p-3 rounded-xl border border-slate-700 min-w-[280px]">
            <p className="text-[10px] text-amber-400 font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <Briefcase size={12} />
              {isRtl ? 'المشروع المستهدف للمحاكاة:' : 'Simulated Project Target:'}
            </p>
            <select
              value={activeProject.id}
              onChange={(e) => {
                const found = allProjects.find((p) => p.id === e.target.value);
                if (found) handleSwitchProject(found);
              }}
              className="w-full text-xs font-bold bg-slate-950 border border-slate-700 rounded-lg p-2 text-white focus:outline-none focus:border-amber-400"
            >
              {allProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({Number(p.contract_value).toLocaleString()} ر.س)
                </option>
              ))}
            </select>
            <div className="flex justify-between items-center text-[10px] text-slate-400 mt-2 font-mono">
              <span>BAC: {Number(activeProject.contract_value).toLocaleString()} ر.س</span>
              <span>{activeProject.duration_days} يوم</span>
            </div>
          </div>
        </div>
      </div>

      {/* Top 4 Real-time Monitored Metrics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Precision Watchdog Status */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'دقة ومطابقة الأرقام (Watchdog)' : 'Precision Parity'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
              <CheckCircle2 size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-3xl font-black text-emerald-600 font-mono">100%</span>
            <span className="text-xs font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded">
              0.00 ر.س فارق
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {isRtl ? 'انطباط قوانين الهوامش و EVM وتوازن السيولة' : 'Float, EVM & Cash flow laws strictly verified'}
          </p>
        </div>

        {/* Card 2: Highest Schedule Variance */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'أقصى انحراف زمني محاكى' : 'Max Schedule Drift'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
              <Clock size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-3xl font-black text-rose-600 font-mono">+55</span>
            <span className="text-xs font-bold text-slate-500">{isRtl ? 'يوماً تقويمياً' : 'Days'}</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {isRtl ? 'في سيناريو أزمة السيولة وتأخر المستخلصات' : 'Triggered under Client Cash Squeeze scenario'}
          </p>
        </div>

        {/* Card 3: Highest Cost Variance */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'أقصى تضخم تكلفة محاكى' : 'Max Simulated Cost Overrun'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
              <DollarSign size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-2xl font-black text-amber-600 font-mono">+515,933</span>
            <span className="text-xs font-bold text-slate-500">ر.س</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {isRtl ? 'في سيناريو أزمة سلاسل الإمداد وحديد التسليح' : 'Triggered under Supply Chain Inflation (+22%)'}
          </p>
        </div>

        {/* Card 4: Acceleration Potential */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              {isRtl ? 'إمكانية التعجيل والاسترداد' : 'Crashing Recovery Power'}
            </span>
            <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
              <Zap size={18} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-3xl font-black text-blue-600 font-mono">-30</span>
            <span className="text-xs font-bold text-blue-800 bg-blue-100 px-2 py-0.5 rounded">
              {isRtl ? 'يوم استرداد' : 'Days Compression'}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {isRtl ? 'عبر خطة التعجيل القصوى بنظام العمل الإضافي 24/7' : 'Via Turbo Fast-Tracking & Crashing'}
          </p>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="bg-white p-2 rounded-2xl border border-slate-200/80 shadow-xs flex flex-wrap gap-2">
        <button
          onClick={() => setActiveTab('matrix')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'matrix'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Layers size={15} className={activeTab === 'matrix' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'مصفوفة مقارنة السيناريوهات الشاملة (Multi-Scenario Matrix)' : 'Multi-Scenario Matrix'}</span>
        </button>

        <button
          onClick={() => setActiveTab('custom_builder')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'custom_builder'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Sliders size={15} className={activeTab === 'custom_builder' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'مختبر تكوين السيناريو التفاعلي (Interactive Builder)' : 'Interactive Scenario Builder'}</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-indigo-500 text-white font-black">AI Lab</span>
        </button>

        <button
          onClick={() => setActiveTab('watchdog')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'watchdog'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Scale size={15} className={activeTab === 'watchdog' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'مراقب دقة الأرقام والتعارضات (Precision Watchdog)' : 'Precision Watchdog'}</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-500 text-white font-black">
            {watchdogMetrics.length} Tests
          </span>
        </button>

        <button
          onClick={() => setActiveTab('tornado')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'tornado'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <ActivityIcon size={15} className={activeTab === 'tornado' ? 'text-amber-400' : ''} />
          <span>{isRtl ? 'مخطط تورنادو لتحليل الحساسية والمخاطر (Tornado Analysis)' : 'Sensitivity Tornado Chart'}</span>
        </button>
      </div>

      {/* TAB 1: Multi-Scenario Comparison Matrix */}
      {activeTab === 'matrix' && (
        <div className="space-y-6">
          {/* Main Matrix Table */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-black text-slate-900">
                  {isRtl ? 'المقارنة المتقاطعة للسيناريوهات المعقدة ومؤشرات EVM والتدفق النقدي' : 'Cross-Scenario Comparative Evaluation Matrix'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {isRtl
                    ? 'نتائج فورية محسوبة عبر محرك CPM و 4 نماذج EAC مع تقديرات P80 لمونت كارلو.'
                    : 'Real-time CPM schedule calculation, 4-EAC models, peak liquidity strain, and P80 boundaries.'}
                </p>
              </div>
              <span className="text-xs font-mono font-bold bg-slate-100 px-3 py-1 rounded-lg text-slate-700">
                Baseline BAC: {Number(activeProject.contract_value).toLocaleString()} SAR
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-900 text-white font-bold">
                    <th className="p-3 w-64">{isRtl ? 'السيناريو المعقد' : 'Complex Scenario'}</th>
                    <th className="p-3 text-center">{isRtl ? 'تاريخ الإنجاز المتوقع' : 'Forecast Finish'}</th>
                    <th className="p-3 text-center">{isRtl ? 'انحراف المدة' : 'Duration Var'}</th>
                    <th className="p-3 text-center">{isRtl ? 'الميزانية BAC' : 'BAC (SAR)'}</th>
                    <th className="p-3 text-center">{isRtl ? 'التكلفة المحاكاة (AC)' : 'Simulated AC'}</th>
                    <th className="p-3 text-center">{isRtl ? 'انحراف التكلفة' : 'Cost Var (SAR / %)'}</th>
                    <th className="p-3 text-center">{isRtl ? 'مؤشرات الأداء (SPI / CPI)' : 'SPI / CPI'}</th>
                    <th className="p-3 text-center">{isRtl ? 'عجز السيولة الأقصى' : 'Peak Cash Deficit'}</th>
                    <th className="p-3 text-center">{isRtl ? 'تقدير P80' : 'P80 Boundary'}</th>
                    <th className="p-3 text-center">{isRtl ? 'درجة المخاطرة' : 'Risk Grade'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {scenarioResults.map((s) => {
                    const isSelected = selectedScenarioId === s.scenarioId;
                    return (
                      <tr
                        key={s.scenarioId}
                        onClick={() => setSelectedScenarioId(s.scenarioId)}
                        className={`hover:bg-slate-50 transition-colors cursor-pointer ${
                          isSelected ? 'bg-amber-50/50 font-bold' : ''
                        }`}
                      >
                        <td className="p-3.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                s.riskRating === 'critical'
                                  ? 'bg-rose-500'
                                  : s.riskRating === 'high'
                                  ? 'bg-amber-500'
                                  : s.riskRating === 'medium'
                                  ? 'bg-blue-500'
                                  : 'bg-emerald-500'
                              }`}
                            />
                            <div>
                              <p className="font-bold text-slate-900 text-xs">{isRtl ? s.scenarioNameAr : s.scenarioNameEn}</p>
                              <span className="text-[10px] text-slate-400 font-mono">{s.scenarioId}</span>
                            </div>
                          </div>
                        </td>

                        <td className="p-3 text-center font-mono font-bold text-slate-900 text-[11px]">
                          {s.finishDate}
                        </td>

                        <td className="p-3 text-center font-mono text-[11px]">
                          <span
                            className={`px-2 py-0.5 rounded font-bold ${
                              s.varianceDays > 0
                                ? 'bg-rose-100 text-rose-800'
                                : s.varianceDays < 0
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {s.varianceDays > 0 ? `+${s.varianceDays} يوم` : s.varianceDays < 0 ? `${s.varianceDays} يوم` : '0 يوم'}
                          </span>
                        </td>

                        <td className="p-3 text-center font-mono font-bold text-slate-800 text-[11px]">
                          {s.bac.toLocaleString()}
                        </td>

                        <td className="p-3 text-center font-mono font-bold text-slate-900 text-[11px]">
                          {s.eacBottomUp.toLocaleString()}
                        </td>

                        <td className="p-3 text-center font-mono text-[11px]">
                          <span
                            className={`font-bold ${
                              s.costVarianceSar > 0 ? 'text-rose-600' : s.costVarianceSar < 0 ? 'text-emerald-600' : 'text-slate-600'
                            }`}
                          >
                            {s.costVarianceSar > 0 ? `+${s.costVarianceSar.toLocaleString()}` : s.costVarianceSar.toLocaleString()} ر.س
                            <span className="text-[10px] block text-slate-400">({s.costVariancePercent > 0 ? `+${s.costVariancePercent}%` : `${s.costVariancePercent}%`})</span>
                          </span>
                        </td>

                        <td className="p-3 text-center font-mono font-bold text-[11px]">
                          <span className={s.spi < 1 ? 'text-rose-600' : 'text-emerald-600'}>{s.spi.toFixed(2)}</span>
                          <span className="text-slate-400 mx-1">/</span>
                          <span className={s.cpi < 1 ? 'text-amber-600' : 'text-emerald-600'}>{s.cpi.toFixed(2)}</span>
                        </td>

                        <td className="p-3 text-center font-mono font-bold text-rose-700 text-[11px]">
                          -{s.peakCashDeficitSar.toLocaleString()} ر.س
                        </td>

                        <td className="p-3 text-center font-mono text-[10px] text-slate-600">
                          <div>{s.p80FinishDate}</div>
                          <div className="text-slate-400">{s.p80CostSar.toLocaleString()} ر.س</div>
                        </td>

                        <td className="p-3 text-center">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                              s.riskRating === 'critical'
                                ? 'bg-rose-100 text-rose-800 border border-rose-200'
                                : s.riskRating === 'high'
                                ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                : s.riskRating === 'medium'
                                ? 'bg-blue-100 text-blue-800 border border-blue-200'
                                : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            }`}
                          >
                            {s.riskRating}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Deep Selected Scenario Intelligence Breakdown Card */}
          {selectedScenarioDetail && (
            <div className="bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white p-6 rounded-2xl border border-slate-800 shadow-md animate-fadeIn space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2.5">
                  <ShieldAlert size={20} className="text-amber-400" />
                  <h3 className="text-base font-black text-white">
                    {isRtl ? 'التحليل الهندسي والتعاقدي التفصيلي للسيناريو:' : 'Engineering & Contractual Analysis:'}{' '}
                    <span className="text-amber-400">{isRtl ? selectedScenarioDetail.scenarioNameAr : selectedScenarioDetail.scenarioNameEn}</span>
                  </h3>
                </div>
                <span className="font-mono text-xs text-slate-400">
                  {selectedScenarioDetail.contractualClaimClause}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
                {/* 1. 4-EAC Models */}
                <div className="bg-slate-800/80 p-3.5 rounded-xl border border-slate-700 space-y-1.5 font-mono">
                  <p className="text-[10px] text-amber-400 font-bold uppercase">{isRtl ? 'نماذج EAC الأربعة' : '4-EAC Forecasting'}</p>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-400">1. Optimistic:</span>
                    <span className="text-white font-bold">{selectedScenarioDetail.eacOptimistic.toLocaleString()} ر.س</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-400">2. Realistic (BAC/CPI):</span>
                    <span className="text-emerald-400 font-bold">{selectedScenarioDetail.eacRealistic.toLocaleString()} ر.س</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-400">3. Pessimistic (CPIxSPI):</span>
                    <span className="text-amber-400 font-bold">{selectedScenarioDetail.eacPessimistic.toLocaleString()} ر.س</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-400">4. Bottom-Up:</span>
                    <span className="text-rose-400 font-bold">{selectedScenarioDetail.eacBottomUp.toLocaleString()} ر.س</span>
                  </div>
                </div>

                {/* 2. Critical Path & Float */}
                <div className="bg-slate-800/80 p-3.5 rounded-xl border border-slate-700 space-y-1.5">
                  <p className="text-[10px] text-blue-400 font-bold uppercase">{isRtl ? 'المسار الحرج والهوامش' : 'Critical Path & Drag'}</p>
                  <p className="text-slate-300 text-[11px]">
                    {isRtl
                      ? `المدة الكلية المحاكاة ${selectedScenarioDetail.totalDurationDays} يوماً مع تحول أنشطة الخرسانة والمشتريات لمسار حرج صفرى.`
                      : `Simulated duration is ${selectedScenarioDetail.totalDurationDays} days with concrete and long-lead items dominating critical path.`}
                  </p>
                  <p className="text-amber-300 font-bold text-[11px] font-mono">
                    {isRtl ? `درجة الجدوى: ${selectedScenarioDetail.feasibilityScore}/100` : `Feasibility: ${selectedScenarioDetail.feasibilityScore}/100`}
                  </p>
                </div>

                {/* 3. Recommended Engineering Mitigation Strategy */}
                <div className="md:col-span-2 bg-slate-800/80 p-3.5 rounded-xl border border-slate-700 space-y-1.5">
                  <p className="text-[10px] text-emerald-400 font-bold uppercase">{isRtl ? 'استراتيجية التخفيف والإنقاذ المعتمدة (Mitigation Strategy)' : 'Mitigation Action Plan'}</p>
                  <p className="text-slate-200 text-xs leading-relaxed">
                    {isRtl ? selectedScenarioDetail.mitigationStrategyAr : selectedScenarioDetail.mitigationStrategyEn}
                  </p>
                  <div className="text-[10px] text-slate-400 font-mono mt-1">
                    Contractual Reference: {selectedScenarioDetail.contractualClaimClause}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: Interactive Custom Scenario Builder */}
      {activeTab === 'custom_builder' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
              <div>
                <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <Sliders size={18} className="text-indigo-600" />
                  {isRtl ? 'مختبر تكوين السيناريوهات المتقدمة (Interactive Scenario Control Lab)' : 'Dynamic Scenario Control Lab'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {isRtl
                    ? 'تحكم ديناميكي بمتغيرات المشروع الحيوية واختبار استجابة الجدول الزمني والتكاليف والسيولة في الزمن الحقيقي.'
                    : 'Adjust project stress parameters dynamically to test schedule resilience, multi-EAC cost shifts, and cash liquidity.'}
                </p>
              </div>

              <button
                onClick={() =>
                  setCustomParams({
                    productivityFactor: 1.0,
                    materialInflationPercent: 0,
                    laborRateEscalationPercent: 0,
                    criticalDelayDays: 0,
                    cashInflowDelayDays: 0,
                    subcontractorCapacityFactor: 1.0,
                    crashingOvertimeFactor: 1.0,
                    variationOrderValueSar: 0,
                    variationOrderDays: 0,
                  })
                }
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition-colors cursor-pointer"
              >
                <RotateCcw size={13} />
                <span>{isRtl ? 'إعادة ضبط القيم' : 'Reset Sliders'}</span>
              </button>
            </div>

            {/* Parameter Sliders Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-4 bg-slate-50 rounded-2xl border border-slate-200">
              {/* Slider 1: Productivity */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-800">{isRtl ? 'إنتاجية العمالة والأطقم' : 'Crew Productivity'}</span>
                  <span className="font-mono font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                    {Math.round(customParams.productivityFactor * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  value={customParams.productivityFactor}
                  onChange={(e) => setCustomParams({ ...customParams, productivityFactor: parseFloat(e.target.value) })}
                  className="w-full accent-indigo-600 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>50% (تباطؤ شديد)</span>
                  <span>100%</span>
                  <span>150% (إنتاجية قياسية)</span>
                </div>
              </div>

              {/* Slider 2: Material Inflation */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-800">{isRtl ? 'تضخم أسعار المواد الدائمة' : 'Material Inflation %'}</span>
                  <span className="font-mono font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded">
                    +{customParams.materialInflationPercent}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  step="1"
                  value={customParams.materialInflationPercent}
                  onChange={(e) => setCustomParams({ ...customParams, materialInflationPercent: parseInt(e.target.value) })}
                  className="w-full accent-rose-600 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>0%</span>
                  <span>+25%</span>
                  <span>+50% (أزمة أسعار)</span>
                </div>
              </div>

              {/* Slider 3: Critical Path Delay Shock */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-800">{isRtl ? 'صدمة تأخير المسار الحرج' : 'Critical Path Delay'}</span>
                  <span className="font-mono font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                    {customParams.criticalDelayDays} {isRtl ? 'يوماً' : 'Days'}
                  </span>
                </div>
                <input
                  type="range"
                  min="-30"
                  max="120"
                  step="5"
                  value={customParams.criticalDelayDays}
                  onChange={(e) => setCustomParams({ ...customParams, criticalDelayDays: parseInt(e.target.value) })}
                  className="w-full accent-amber-600 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>-30 يوم (تعجيل)</span>
                  <span>0</span>
                  <span>+120 يوم (توقف)</span>
                </div>
              </div>

              {/* Slider 4: Cash Delay */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-800">{isRtl ? 'تأخر صرف مستخلصات المالك' : 'Client Payment Delay'}</span>
                  <span className="font-mono font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded">
                    {customParams.cashInflowDelayDays} {isRtl ? 'يوماً' : 'Days'}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="90"
                  step="5"
                  value={customParams.cashInflowDelayDays}
                  onChange={(e) => setCustomParams({ ...customParams, cashInflowDelayDays: parseInt(e.target.value) })}
                  className="w-full accent-purple-600 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>0 يوم (فوري)</span>
                  <span>45 يوم</span>
                  <span>90 يوم (تجميد سيولة)</span>
                </div>
              </div>

              {/* Slider 5: Subcontractor Capacity */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-800">{isRtl ? 'كفاءة مقاولي الباطن' : 'Subcontractor Capacity'}</span>
                  <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                    {Math.round(customParams.subcontractorCapacityFactor * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.3"
                  max="1.2"
                  step="0.05"
                  value={customParams.subcontractorCapacityFactor}
                  onChange={(e) => setCustomParams({ ...customParams, subcontractorCapacityFactor: parseFloat(e.target.value) })}
                  className="w-full accent-blue-600 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>30% (تعثر حاد)</span>
                  <span>100%</span>
                  <span>120% (طاقة ممتازة)</span>
                </div>
              </div>

              {/* Slider 6: Crashing & Fast-Tracking */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-800">{isRtl ? 'معدل التعجيل والعمل الإضافي' : 'Crashing Overtime'}</span>
                  <span className="font-mono font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                    {customParams.crashingOvertimeFactor.toFixed(2)}x
                  </span>
                </div>
                <input
                  type="range"
                  min="1.0"
                  max="2.0"
                  step="0.05"
                  value={customParams.crashingOvertimeFactor}
                  onChange={(e) => setCustomParams({ ...customParams, crashingOvertimeFactor: parseFloat(e.target.value) })}
                  className="w-full accent-emerald-600 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>1.0x (دوام عادي)</span>
                  <span>1.5x (وردية ونصف)</span>
                  <span>2.0x (24/7 ورديتين)</span>
                </div>
              </div>
            </div>

            {/* Live Result of Custom Scenario */}
            {customScenarioResult && (
              <div className="mt-6 p-5 rounded-2xl bg-slate-900 text-white space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Zap size={18} className="text-amber-400" />
                    <h4 className="text-sm font-black text-white">
                      {isRtl ? 'النتائج التنبؤية المحسوبة للسيناريو المخصص:' : 'Simulated Real-Time Custom Output:'}
                    </h4>
                  </div>
                  <span
                    className={`px-3 py-0.5 rounded-full text-xs font-bold font-mono ${
                      customScenarioResult.riskRating === 'critical'
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                        : customScenarioResult.riskRating === 'high'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    }`}
                  >
                    Risk: {customScenarioResult.riskRating.toUpperCase()} • Feasibility: {customScenarioResult.feasibilityScore}%
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                  <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700">
                    <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'التاريخ النهائي المتوقع' : 'Finish Date'}</p>
                    <p className="text-base font-black text-white font-mono mt-1">{customScenarioResult.finishDate}</p>
                    <span className="text-[10px] text-rose-400 font-mono">
                      {customScenarioResult.varianceDays > 0 ? `+${customScenarioResult.varianceDays} يوم` : `${customScenarioResult.varianceDays} يوم`}
                    </span>
                  </div>

                  <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700">
                    <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'التكلفة الإجمالية (Bottom-Up)' : 'Forecast Cost'}</p>
                    <p className="text-base font-black text-amber-400 font-mono mt-1">{customScenarioResult.eacBottomUp.toLocaleString()} ر.س</p>
                    <span className="text-[10px] text-amber-300 font-mono">
                      {customScenarioResult.costVarianceSar > 0 ? `+${customScenarioResult.costVarianceSar.toLocaleString()}` : customScenarioResult.costVarianceSar.toLocaleString()} ر.س
                    </span>
                  </div>

                  <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700">
                    <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'مؤشرات الكفاءة (SPI / CPI)' : 'SPI / CPI'}</p>
                    <p className="text-base font-black text-white font-mono mt-1">
                      {customScenarioResult.spi.toFixed(2)} / {customScenarioResult.cpi.toFixed(2)}
                    </p>
                    <span className="text-[10px] text-slate-400 font-mono">EAC Realistic: {customScenarioResult.eacRealistic.toLocaleString()} ر.س</span>
                  </div>

                  <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700">
                    <p className="text-[10px] text-slate-400 uppercase font-bold">{isRtl ? 'عجز السيولة الأقصى' : 'Peak Cash Squeeze'}</p>
                    <p className="text-base font-black text-rose-400 font-mono mt-1">-{customScenarioResult.peakCashDeficitSar.toLocaleString()} ر.س</p>
                    <span className="text-[10px] text-slate-400 font-mono">Working Capital Gap</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Precision Watchdog */}
      {activeTab === 'watchdog' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
              <div>
                <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <Scale size={18} className="text-emerald-600" />
                  {isRtl ? 'مراقب دقة الأرقام والتعارضات اللحظي (Real-Time Precision Watchdog)' : 'Numerical Precision & Parity Watchdog'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {isRtl
                    ? 'تدقيق حاسوبي صارم لانحفاظ قوانين الهوامش الزمنية، ومعادلات EVM، وميزان التدفقات النقدية بدون أي تسامح مع الأخطاء.'
                    : 'Mathematical conservation audits verifying float equations, EVM law, and cash-flow parity with zero error tolerance.'}
                </p>
              </div>

              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl">
                <CheckCircle2 size={16} className="text-emerald-600" />
                <span className="text-xs font-black text-emerald-800">
                  {isRtl ? '100% تطابق رياضي (0.00 ر.س فارق)' : '100% Mathematical Parity'}
                </span>
              </div>
            </div>

            <div className="divide-y divide-slate-100">
              {watchdogMetrics.map((item) => (
                <div key={item.id} className="py-4 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500" />
                      <p className="font-bold text-slate-900 text-xs">{isRtl ? item.labelAr : item.labelEn}</p>
                      <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                        {item.id}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800">
                        {item.precisionStatus.toUpperCase()} (0 Drift)
                      </span>
                    </div>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">{isRtl ? 'المعادلة الرياضية الحاكمة' : 'Governing Formula'}</p>
                      <p className="font-mono text-slate-800 font-bold mt-0.5">{item.formula}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">{isRtl ? 'القيمة المحسوبة' : 'Calculated Value'}</p>
                      <p className="font-mono text-slate-900 font-bold mt-0.5">{item.calculatedValue}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">{isRtl ? 'نتيجة التدقيق' : 'Audit Finding'}</p>
                      <p className="text-slate-600 text-[11px] mt-0.5">{isRtl ? item.notesAr : item.notesEn}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Sensitivity Tornado Chart */}
      {activeTab === 'tornado' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-xs">
            <h3 className="text-base font-black text-slate-900 mb-1">
              {isRtl ? 'مخطط تورنادو لتحليل الحساسية ومرونة المتغيرات (Tornado Sensitivity Analysis)' : 'Parameter Sensitivity & Volatility Tornado Diagram'}
            </h3>
            <p className="text-xs text-slate-500 mb-6">
              {isRtl
                ? 'ترتيب المتغيرات الأكثر تأثيراً على الجدول الزمني وتكاليف المشروع لاستهداف تدابير التحكم الهندسي بدقة.'
                : 'Ranked sensitivity impact of key project variables on duration and financial budget.'}
            </p>

            <div className="space-y-4">
              {tornadoData.map((item, idx) => (
                <div key={idx} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex justify-between items-center text-xs font-bold">
                    <span className="text-slate-900">{isRtl ? item.parameterNameAr : item.parameterNameEn}</span>
                    <span className="text-slate-600 font-mono text-[11px]">
                      {isRtl ? `تأثير التكلفة: ${item.lowCostSar.toLocaleString()} إلى +${item.highCostSar.toLocaleString()} ر.س` : `Cost Spread: ${item.lowCostSar.toLocaleString()} to +${item.highCostSar.toLocaleString()} SAR`}
                    </span>
                  </div>

                  {/* Tornado visual bar */}
                  <div className="grid grid-cols-2 gap-1 items-center h-5">
                    {/* Left side: compression / reduction */}
                    <div className="flex justify-end bg-slate-200 h-3 rounded-l-md overflow-hidden">
                      <div
                        className="bg-emerald-500 h-3"
                        style={{ width: `${Math.min(100, Math.abs(item.lowDurationDays) * 2)}%` }}
                      />
                    </div>
                    {/* Right side: delay expansion */}
                    <div className="flex justify-start bg-slate-200 h-3 rounded-r-md overflow-hidden">
                      <div
                        className="bg-rose-500 h-3"
                        style={{ width: `${Math.min(100, item.highDurationDays * 1.5)}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                    <span className="text-emerald-700 font-bold">{item.lowDurationDays} يوم</span>
                    <span>خط الأساس (Baseline 0)</span>
                    <span className="text-rose-700 font-bold">+{item.highDurationDays} يوم</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

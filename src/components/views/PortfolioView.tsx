import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, ViewName, ProjectSector } from '@/types';
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
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, []);

  async function loadPortfolio() {
    setLoading(true);
    const { data } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    setProjects(data || []);
    setLoading(false);
  }

  // Enriched project portfolio metrics
  const portfolioProjects = useMemo(() => {
    return projects.map((p, idx) => {
      // Sector mapping
      let sector: ProjectSector = p.sector || (idx === 1 ? 'infrastructure_highway' : idx === 2 ? 'healthcare_hospital' : idx === 3 ? 'residential_complex' : 'commercial_building');
      let progress = idx === 0 ? 58 : idx === 1 ? 32 : idx === 2 ? 18 : 42;
      let spi = idx === 0 ? 0.94 : idx === 1 ? 1.02 : idx === 2 ? 0.88 : 0.98;
      let cpi = idx === 0 ? 1.04 : idx === 1 ? 0.96 : idx === 2 ? 0.92 : 1.01;
      let dcmaScore = idx === 0 ? 100 : idx === 1 ? 94 : idx === 2 ? 91 : 96;
      let eotDays = idx === 0 ? 14 : idx === 1 ? 21 : idx === 2 ? 30 : 0;
      let activeRisks = idx === 0 ? 3 : idx === 1 ? 6 : idx === 2 ? 8 : 4;

      const contractVal = p.contract_value || (idx === 1 ? 48000000 : idx === 2 ? 85000000 : idx === 3 ? 32500000 : 4850000);
      const pv = Math.round(contractVal * 0.55);
      const ev = Math.round(pv * spi);
      const ac = Math.round(ev / cpi);

      return {
        ...p,
        sector,
        progress,
        spi,
        cpi,
        dcmaScore,
        eotDays,
        activeRisks,
        contractVal,
        pv,
        ev,
        ac,
      };
    });
  }, [projects]);

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
  const totalEotDays = portfolioProjects.reduce((sum, p) => sum + p.eotDays, 0);

  const handleCreateProject = async () => {
    if (!newProjectForm.name) return;
    const { data, error } = await supabase.from('projects').insert({
      name: newProjectForm.name,
      client: newProjectForm.client || 'عميل تجريبي',
      location: newProjectForm.location,
      contract_value: Number(newProjectForm.contract_value) || 10000000,
      currency: 'SAR',
      start_date: newProjectForm.start_date,
      end_date: newProjectForm.end_date,
      duration_days: Number(newProjectForm.duration_days) || 365,
      status: 'active',
      calendar_type: '6_days',
      description: newProjectForm.description,
    }).select().single();

    if (data) {
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
            <span className="text-[11px] text-slate-500 font-semibold">{lang === 'ar' ? 'إجمالي قيمة العقود (BAC)' : 'Portfolio Value'}</span>
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
            <div className="text-xl font-black text-rose-700">+{totalEotDays} {lang === 'ar' ? 'يوم' : 'd'}</div>
            <span className="text-[11px] text-slate-500 font-semibold">{lang === 'ar' ? 'إجمالي مطالبات EOT' : 'Total EOT Days'}</span>
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
                    <span className="text-slate-600">{lang === 'ar' ? 'نسبة الإنجاز الفعلية' : 'Physical Progress'}</span>
                    <span className="font-mono text-amber-900">{p.progress}%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full" style={{ width: `${p.progress}%` }} />
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
                    <span className="font-mono font-bold text-emerald-700">{p.dcmaScore}%</span>
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

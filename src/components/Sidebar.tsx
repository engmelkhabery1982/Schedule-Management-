import { useState, useEffect } from 'react';
import { supabase, isDemoMode, resetDemoDatabase } from '@/lib/supabase';
import type { Project, ViewName } from '@/types';
import { getLanguage, setLanguage, translations, type Language } from '@/lib/i18n';
import {
  LayoutDashboard,
  Calendar,
  Scale,
  FastForward,
  GitCompare,
  ShieldCheck,
  Users,
  FileCheck2,
  FileText,
  TrendingUp,
  Wallet,
  AlertTriangle,
  Upload,
  Download,
  Building2,
  Printer,
  Menu,
  X,
  RotateCcw,
  Sparkles,
  Globe,
  Box,
  Activity as ActivitySquare,
  Receipt,
  Briefcase,
  Landmark,
} from 'lucide-react';

interface SidebarProps {
  activeView: ViewName;
  onViewChange: (view: ViewName) => void;
  project: Project | null;
  onProjectChange: (project?: Project) => void;
}

export default function Sidebar({ activeView, onViewChange, project, onProjectChange }: SidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjectList, setShowProjectList] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [currentLang, setCurrentLang] = useState<Language>(getLanguage());

  useEffect(() => {
    loadProjects();
  }, [project]);

  async function loadProjects() {
    const { data } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (data && data.length > 0) setProjects(data);
  }

  async function selectProject(p: Project) {
    setShowProjectList(false);
    onProjectChange(p);
  }

  const toggleLanguage = () => {
    const nextLang: Language = currentLang === 'ar' ? 'en' : 'ar';
    setLanguage(nextLang);
    setCurrentLang(nextLang);
  };

  const t = translations[currentLang];
  const isRtl = currentLang === 'ar';

  const navItems: { view: ViewName; label: string; icon: typeof LayoutDashboard; badge?: string }[] = [
    { view: 'portfolio', label: t.portfolio, icon: Briefcase, badge: 'PMO' },
    { view: 'dashboard', label: t.dashboard, icon: LayoutDashboard },
    { view: 'scenario_simulation', label: t.scenario_simulation, icon: Sparkles, badge: 'Sim' },
    { view: 'data_governance', label: t.data_governance, icon: ShieldCheck, badge: 'SSOT' },
    { view: 'schedule', label: t.schedule, icon: Calendar },
    { view: 'bim_4d', label: t.bim_4d, icon: Box, badge: '4D' },
    { view: 'linear_schedule', label: t.linear_schedule, icon: ActivitySquare, badge: 'TILOS' },
    { view: 'payment_certificates', label: t.payment_certificates, icon: Receipt, badge: 'IPC' },
    { view: 'financial_controls', label: t.financial_controls, icon: Landmark, badge: 'FIDIC' },
    { view: 'schedule_diff', label: t.schedule_diff, icon: GitCompare, badge: 'Diff' },
    { view: 'time_impact_analysis', label: t.time_impact_analysis, icon: Scale, badge: 'TIA' },
    { view: 'schedule_recovery', label: t.schedule_recovery, icon: FastForward, badge: 'AI' },
    { view: 'dcma_audit', label: t.dcma_audit, icon: FileCheck2 },
    { view: 'resources', label: t.resources, icon: Users },
    { view: 'procurement', label: t.procurement, icon: FileText },
    { view: 'boq', label: t.boq, icon: FileText },
    { view: 'progress', label: t.progress, icon: TrendingUp },
    { view: 'budget', label: t.budget, icon: Wallet },
    { view: 'risks', label: t.risks, icon: AlertTriangle },
    { view: 'executive_report', label: t.executive_report, icon: Printer },
    { view: 'import', label: t.import, icon: Upload },
    { view: 'export', label: t.export, icon: Download },
  ];

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className={`fixed top-4 z-50 lg:hidden bg-slate-800 text-white p-2 rounded-lg shadow-lg ${
          isRtl ? 'left-4' : 'right-4'
        }`}
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Overlay for mobile */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 h-full w-72 bg-slate-900 text-white flex flex-col z-40 transition-transform duration-300 ${
          isRtl
            ? `right-0 ${mobileOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}`
            : `left-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`
        }`}
      >
        {/* Logo / Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-tr from-amber-500 to-amber-400 rounded-xl flex items-center justify-center shadow-md shadow-amber-500/20">
              <Building2 size={22} className="text-slate-950 font-bold" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white">
                {currentLang === 'ar' ? 'إدارة وجدولة المشاريع' : 'Project Scheduling'}
              </h1>
              <p className="text-[10px] text-amber-400 font-medium">Enterprise Scheduling & Controls</p>
            </div>
          </div>

          {/* Functional Language Switcher Button */}
          <button
            onClick={toggleLanguage}
            className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-1 rounded-lg text-[10px] font-bold border border-slate-700 transition-colors cursor-pointer"
            title="تبديل اللغة / Switch Language"
          >
            <Globe size={12} className="text-amber-400" />
            <span>{currentLang === 'ar' ? 'English' : 'عربي'}</span>
          </button>
        </div>

        {/* Project selector */}
        <div className="p-3 border-b border-slate-800">
          <button
            onClick={() => setShowProjectList(!showProjectList)}
            className="w-full text-right p-2.5 bg-slate-800/80 rounded-xl hover:bg-slate-800 border border-slate-700/60 transition-colors"
          >
            <p className="text-[9px] text-slate-400 uppercase tracking-wider mb-0.5">{t.active_project}</p>
            <p className="text-xs font-bold text-white truncate">
              {project ? project.name : (currentLang === 'ar' ? 'اختر أو استورد مشروعاً' : 'Select Project')}
            </p>
          </button>

          {showProjectList && (
            <div className="mt-2 space-y-1 max-h-48 overflow-y-auto bg-slate-950/90 p-1.5 rounded-lg border border-slate-800">
              {projects.length === 0 && (
                <p className="text-xs text-slate-500 p-2 text-center">لا توجد مشاريع</p>
              )}
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectProject(p)}
                  className={`w-full text-right p-2 rounded-md text-xs font-medium hover:bg-slate-800 transition-colors ${
                    project?.id === p.id ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-slate-300'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.view;
            return (
              <button
                key={item.view}
                onClick={() => {
                  onViewChange(item.view);
                  setMobileOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-150 cursor-pointer ${
                  isActive
                    ? 'bg-gradient-to-r from-amber-500 to-amber-400 text-slate-950 shadow-md shadow-amber-500/20 font-bold'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <div className="flex items-center gap-2.5 truncate">
                  <Icon size={16} />
                  <span className="truncate">{item.label}</span>
                </div>
                {item.badge && (
                  <span
                    className={`text-[9px] font-mono font-black px-1.5 py-0.5 rounded ${
                      isActive ? 'bg-slate-950 text-amber-400' : 'bg-slate-800 text-amber-300'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Local Demo Mode & Reset Footer */}
        {isDemoMode && (
          <div className="p-2.5 mx-2.5 mb-2 bg-slate-800/60 rounded-xl border border-slate-700/50 text-[10px]">
            <div className="flex items-center gap-1.5 text-amber-400 font-medium mb-1">
              <Sparkles size={12} />
              <span>{currentLang === 'ar' ? 'وضع المعاينة الميداني (Enterprise)' : 'Enterprise Live Demo'}</span>
            </div>
            <p className="text-slate-400 text-[9px] leading-tight mb-2">
              {currentLang === 'ar' ? 'حسابات TIA والمسار الحرج تعمل بالكامل.' : 'TIA & CPM calculations active.'}
            </p>
            <button
              onClick={resetDemoDatabase}
              className="w-full flex items-center justify-center gap-1 bg-slate-700/80 hover:bg-slate-700 text-slate-200 py-1 rounded text-[10px] transition-colors cursor-pointer"
            >
              <RotateCcw size={10} />
              {currentLang === 'ar' ? 'إعادة ضبط البيانات التجريبية' : 'Reset Demo Data'}
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="p-2 border-t border-slate-800 text-[10px] text-slate-500 text-center">
          Enterprise Project Controls Platform v3.8
        </div>
      </aside>
    </>
  );
}

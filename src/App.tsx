import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getInitialSeedData } from '@/lib/mockSeed';
import { getLanguage, setLanguage, type Language } from '@/lib/i18n';
import type { Project, ViewName } from '@/types';
import Sidebar from '@/components/Sidebar';
import { Globe } from 'lucide-react';
import PortfolioView from '@/components/views/PortfolioView';
import Bim4DView from '@/components/views/Bim4DView';
import LinearScheduleView from '@/components/views/LinearScheduleView';
import PaymentCertificatesView from '@/components/views/PaymentCertificatesView';
import FinancialControlsView from '@/components/views/FinancialControlsView';
import MultiScenarioSimulationView from '@/components/views/MultiScenarioSimulationView';
import DataGovernanceView from '@/components/views/DataGovernanceView';
import Dashboard from '@/components/views/Dashboard';
import ImportView from '@/components/views/ImportView';
import BoqView from '@/components/views/BoqView';
import ScheduleView from '@/components/views/ScheduleView';
import ScheduleDiffView from '@/components/views/ScheduleDiffView';
import TimeImpactAnalysisView from '@/components/views/TimeImpactAnalysisView';
import ScheduleRecoveryView from '@/components/views/ScheduleRecoveryView';
import DcmaAuditView from '@/components/views/DcmaAuditView';
import ResourceHistogramView from '@/components/views/ResourceHistogramView';
import ProcurementView from '@/components/views/ProcurementView';
import ProgressView from '@/components/views/ProgressView';
import BudgetView from '@/components/views/BudgetView';
import RisksView from '@/components/views/RisksView';
import ExecutiveReportView from '@/components/views/ExecutiveReportView';
import ExportView from '@/components/views/ExportView';

function App() {
  const [activeView, setActiveView] = useState<ViewName>('dashboard');
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState<Language>(getLanguage());

  useEffect(() => {
    loadLastProject();

    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, []);

  async function loadLastProject() {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        setProject(data);
      } else {
        const seed = getInitialSeedData();
        if (seed.projects && seed.projects[0]) {
          setProject(seed.projects[0]);
        }
      }
    } catch (err) {
      console.error('Error loading project:', err);
      const seed = getInitialSeedData();
      if (seed.projects && seed.projects[0]) {
        setProject(seed.projects[0]);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleProjectChange(selectedProject?: Project) {
    if (selectedProject) {
      setProject(selectedProject);
      setActiveView('dashboard');
      return;
    }
    loadLastProject();
  }

  function handleProjectCreated(newProject: Project) {
    setProject(newProject);
    setActiveView('dashboard');
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        project={project}
        onProjectChange={handleProjectChange}
      />

      {/* Main content - offset for sidebar on large screens */}
      <main className={`${lang === 'ar' ? 'lg:mr-72' : 'lg:ml-72'} min-h-screen transition-all duration-300`}>
        {/* Global Navigation Top Header */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-30 px-4 sm:px-6 py-2.5 flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-slate-800">
              {lang === 'ar' ? 'المشروع:' : 'Project:'}{' '}
              <span className="text-amber-600 font-black">{project?.name || (lang === 'ar' ? 'مشروع تجريبي' : 'Demo Project')}</span>
            </span>
            <span className="hidden sm:inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
              Data Date: {project?.data_date || '2026-11-15'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Direct Global Language Toggle */}
            <button
              onClick={() => {
                const nextLang = lang === 'ar' ? 'en' : 'ar';
                setLang(nextLang);
                setLanguage(nextLang);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 transition-colors cursor-pointer"
              title="Switch Language / تبديل اللغة"
            >
              <Globe size={14} className="text-amber-600" />
              <span>{lang === 'ar' ? 'English (EN)' : 'العربية (AR)'}</span>
            </button>
          </div>
        </header>

        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
          {activeView === 'portfolio' && (
            <PortfolioView
              onSelectProject={(p) => {
                setProject(p);
                setActiveView('dashboard');
              }}
              onNavigate={setActiveView}
            />
          )}
          {activeView === 'dashboard' && <Dashboard project={project} onNavigate={setActiveView} />}
          {activeView === 'scenario_simulation' && <MultiScenarioSimulationView project={project} />}
          {activeView === 'data_governance' && <DataGovernanceView project={project} />}
          {activeView === 'schedule' && <ScheduleView project={project} />}
          {activeView === 'bim_4d' && <Bim4DView project={project} />}
          {activeView === 'linear_schedule' && <LinearScheduleView project={project} />}
          {activeView === 'payment_certificates' && <PaymentCertificatesView project={project} />}
          {activeView === 'financial_controls' && <FinancialControlsView project={project} />}
          {activeView === 'schedule_diff' && <ScheduleDiffView project={project} />}
          {activeView === 'time_impact_analysis' && <TimeImpactAnalysisView project={project} />}
          {activeView === 'schedule_recovery' && <ScheduleRecoveryView project={project} />}
          {activeView === 'dcma_audit' && <DcmaAuditView project={project} />}
          {activeView === 'resources' && <ResourceHistogramView project={project} />}
          {activeView === 'procurement' && <ProcurementView project={project} />}
          {activeView === 'boq' && <BoqView project={project} />}
          {activeView === 'progress' && <ProgressView project={project} />}
          {activeView === 'budget' && <BudgetView project={project} />}
          {activeView === 'risks' && <RisksView project={project} />}
          {activeView === 'executive_report' && <ExecutiveReportView project={project} />}
          {activeView === 'import' && <ImportView onProjectCreated={handleProjectCreated} />}
          {activeView === 'export' && <ExportView project={project} />}
        </div>
      </main>
    </div>
  );
}

export default App;

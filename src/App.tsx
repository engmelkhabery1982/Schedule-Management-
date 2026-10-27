import { useState, useEffect } from 'react';
import {
  getWorkspaceHealth,
  getWorkspaceStorage,
  isDemoMode,
  loadDemoWorkspace,
  supabase,
  type WorkspaceHealth,
} from '@/lib/supabase';
import {
  readSelectedProjectId,
  resolveStartupProject,
  writeSelectedProjectId,
  type WorkspaceStorage,
} from '@/lib/localWorkspace';
// GAP-010: the global Data Date controller falls back to the governed constant, never to a literal.
// P2A1-M01: the fallback is still needed, but it must be LABELLED — a stand-in date may never be
// presented as if the project had explicitly governed it.
import { resolveDataDateProvenance, FALLBACK_DEFAULT_DATE } from '@/lib/chronologyGuard';
import { getLanguage, setLanguage, type Language } from '@/lib/i18n';
import type { Project, ViewName } from '@/types';
import Sidebar from '@/components/Sidebar';
import { Globe, Calendar } from 'lucide-react';
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
  // S29: the shell reports what the browser actually holds. A damaged workspace is a VISIBLE state,
  // never silently replaced by demo data.
  const [workspaceHealth, setWorkspaceHealth] = useState<WorkspaceHealth | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [lang, setLang] = useState<Language>(getLanguage());
  // P2A1-M01: the Data Date and its provenance. The resolved VALUE is unchanged (a project with no
  // `data_date` still gets the governed stand-in, because screens need a date), but the controller
  // now knows — and shows — whether that date is the project's own governance or a fallback.
  const dataDateResolution = resolveDataDateProvenance(project);

  useEffect(() => {
    loadLastProject();

    const handleLangChange = (event: Event) => {
      const detail = (event as CustomEvent<{ lang?: Language }>).detail;
      setLang(detail?.lang ?? getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, []);

  /**
   * S29: open the workspace's own data.
   *
   * The previous version fell back to `getInitialSeedData()` — an UNSAVED, invented demo project —
   * whenever the workspace held no projects, so an empty-but-valid pilot looked like four fabricated
   * projects. Now: no projects means no project (`null`), and each view renders its own "no project"
   * state. The remembered selection is restored first so reopening the browser lands on the project
   * the user was working in.
   */
  async function loadLastProject() {
    setLoading(true);
    setWorkspaceHealth(getWorkspaceHealth());
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        setSelectionError(error.message);
        setProject(null);
        return;
      }
      const projects: Project[] = Array.isArray(data) ? data : [];
      const storage: WorkspaceStorage | null = getWorkspaceStorage();
      const selectedId = storage ? readSelectedProjectId(storage) : null;
      const chosen = resolveStartupProject(projects, selectedId);
      setProject(chosen);
      if (chosen && storage) writeSelectedProjectId(storage, chosen.id);
    } catch (err) {
      console.error('Error loading project:', err);
      setSelectionError(err instanceof Error ? err.message : String(err));
      setProject(null);
    } finally {
      setLoading(false);
    }
  }

  /** Persist the user's project selection (a UI preference, excluded from every backup). */
  function rememberSelection(projectId: string | null) {
    const storage = getWorkspaceStorage();
    if (storage) writeSelectedProjectId(storage, projectId);
  }

  function handleProjectChange(selectedProject?: Project) {
    if (selectedProject) {
      setProject(selectedProject);
      rememberSelection(selectedProject.id);
      setActiveView('dashboard');
      return;
    }
    loadLastProject();
  }

  function handleProjectCreated(newProject: Project) {
    setProject(newProject);
    rememberSelection(newProject.id);
    setWorkspaceHealth(getWorkspaceHealth());
    setActiveView('dashboard');
  }

  /** Explicit demo creation — the only path that writes invented demo data. */
  function handleLoadDemoWorkspace() {
    const message = lang === 'ar'
      ? 'سيتم إنشاء مساحة عمل تجريبية ببيانات مُتخيَّلة (4 مشاريع). النسخة الحالية ستُحفظ كنسخة قابلة للاستعادة قبل الاستبدال. هل تريد المتابعة؟'
      : 'This creates a DEMO workspace with four invented projects. The current workspace is saved as a recoverable copy before it is replaced. Continue?';
    if (!window.confirm(message)) return;
    const result = loadDemoWorkspace();
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    window.location.reload();
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
        <header className="bg-white border-b border-slate-200 sticky top-0 z-30 px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-slate-800">
              {lang === 'ar' ? 'المشروع:' : 'Project:'}{' '}
              <span className="text-amber-600 font-black">{project?.name || (lang === 'ar' ? 'مشروع تجريبي' : 'Demo Project')}</span>
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Unified Global Reactive Data Date Controller */}
            <div className={`flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200/80 border px-2.5 py-1 rounded-lg transition-colors shadow-2xs ${dataDateResolution.isFallback ? 'border-amber-500' : 'border-slate-300'}`}>
              <Calendar size={13} className={dataDateResolution.isFallback ? 'text-amber-500 shrink-0' : 'text-amber-600 shrink-0'} />
              <span className="text-[11px] font-bold text-slate-700 hidden sm:inline">
                {lang === 'ar' ? 'تاريخ البيانات:' : 'Data Date:'}
              </span>
              <input
                type="date"
                value={dataDateResolution.dataDate}
                onChange={async (e) => {
                  const newDate = e.target.value;
                  if (!newDate || !project) return;
                  const previous = project;
                  const updated = { ...project, data_date: newDate };
                  setProject(updated);
                  const { error } = await supabase.from('projects').update({ data_date: newDate }).eq('id', project.id);
                  if (error) {
                    // S29: a refused/failed write must not look like a saved Data Date change.
                    setProject(previous);
                    window.alert(
                      lang === 'ar'
                        ? `لم يتم حفظ تاريخ البيانات: ${error.message}`
                        : `The Data Date was not saved: ${error.message}`,
                    );
                    return;
                  }
                  window.dispatchEvent(new CustomEvent('project-data-date-changed', {
                    detail: { projectId: project.id, dataDate: newDate }
                  }));
                }}
                className="text-[11px] font-mono font-bold text-amber-700 bg-white px-2 py-0.5 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-amber-500 cursor-pointer"
                title={dataDateResolution.isFallback
                  ? (lang === 'ar'
                    ? `تحذير: هذا التاريخ افتراضي (${FALLBACK_DEFAULT_DATE}) لأن المشروع لا يحدد تاريخ بيانات خاصاً به. ${dataDateResolution.note}`
                    : `Warning: this date is a FALLBACK (${FALLBACK_DEFAULT_DATE}) — the project states no data_date of its own. ${dataDateResolution.note}`)
                  : (lang === 'ar' ? 'تعديل تاريخ قطع البيانات (Data Date Cutoff) ومزامنة كافة المؤشرات والجدول الزمني فورياً' : 'Modify Project Data Date Cutoff and live-sync schedule & EVM metrics')}
              />
              {/* P2A1-M01: the stand-in is visible, so nobody can read it as governed chronology. */}
              {dataDateResolution.isFallback && (
                <span
                  className="text-[9px] font-black uppercase tracking-wide text-amber-800 bg-amber-200 border border-amber-400 rounded px-1 py-px"
                  title={dataDateResolution.note}
                >
                  {lang === 'ar' ? 'افتراضي' : 'FALLBACK'}
                </span>
              )}
            </div>

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
          {/* S29 workspace banner: a damaged or empty local workspace is stated plainly, never
              papered over with invented projects. */}
          {workspaceHealth && (workspaceHealth.status === 'fault' || workspaceHealth.status === 'unavailable') && (
            <div className="mb-4 rounded-xl border-2 border-rose-300 bg-rose-50 p-4 text-rose-900" role="alert">
              <p className="text-sm font-black">
                {lang === 'ar' ? 'تعذّر قراءة مساحة العمل المحلية — لم يُحفظ ولم يُستبدل أي شيء' : 'The local workspace could not be read — nothing was saved and nothing was overwritten'}
              </p>
              <p className="text-xs mt-1 leading-relaxed">
                {workspaceHealth.status === 'fault' ? workspaceHealth.fault.message : workspaceHealth.message}
              </p>
              {workspaceHealth.status === 'fault' && (
                <p className="text-[11px] mt-1 font-mono break-all">
                  {lang === 'ar' ? 'نسخة محفوظة من البايتات: ' : 'Preserved byte copy: '}
                  {workspaceHealth.fault.preservedKey ?? (lang === 'ar' ? '(تعذّر إنشاء نسخة محفوظة)' : '(no copy could be written)')}
                </p>
              )}
              <button
                onClick={() => setActiveView('export')}
                className="mt-2 px-3 py-1.5 rounded-lg bg-rose-700 text-white text-xs font-bold cursor-pointer"
              >
                {lang === 'ar' ? 'فتح النسخ الاحتياطي والاستعادة' : 'Open workspace backup & restore'}
              </button>
            </div>
          )}

          {selectionError && (
            <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 text-xs" role="alert">
              {selectionError}
            </div>
          )}

          {!project && workspaceHealth && workspaceHealth.status !== 'fault' && workspaceHealth.status !== 'unavailable' && (
            <div className="mb-4 rounded-xl border border-slate-300 bg-white p-4">
              <p className="text-sm font-black text-slate-900">
                {lang === 'ar' ? 'لا توجد مشاريع في مساحة العمل المحلية' : 'No projects in this local workspace'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {lang === 'ar'
                  ? 'مساحة العمل فارغة وصالحة. أنشئ مشروعاً حقيقياً، أو استعد نسخة احتياطية، أو حمّل مساحة عمل تجريبية ببيانات مُتخيَّلة.'
                  : 'The workspace is empty and valid. Create a real project, restore a backup, or load a DEMO workspace with invented data.'}
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  onClick={() => setActiveView('portfolio')}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 text-amber-400 text-xs font-bold cursor-pointer"
                >
                  {lang === 'ar' ? 'إنشاء مشروع جديد' : 'Create a project'}
                </button>
                <button
                  onClick={() => setActiveView('export')}
                  className="px-3 py-1.5 rounded-lg bg-slate-100 border border-slate-300 text-slate-800 text-xs font-bold cursor-pointer"
                >
                  {lang === 'ar' ? 'استعادة نسخة احتياطية' : 'Restore a backup'}
                </button>
                {isDemoMode && (
                  <button
                    onClick={handleLoadDemoWorkspace}
                    className="px-3 py-1.5 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 text-xs font-bold cursor-pointer"
                  >
                    {lang === 'ar' ? 'تحميل مساحة عمل تجريبية' : 'Load demo workspace'}
                  </button>
                )}
              </div>
            </div>
          )}

          {activeView === 'portfolio' && (
            <PortfolioView
              // S29: selection is routed through the same handler as the sidebar so the remembered
              // project pointer is persisted (and survives a reload).
              onSelectProject={(p) => handleProjectChange(p)}
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

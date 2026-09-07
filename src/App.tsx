import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, ViewName } from '@/types';
import Sidebar from '@/components/Sidebar';
import Dashboard from '@/components/views/Dashboard';
import ImportView from '@/components/views/ImportView';
import BoqView from '@/components/views/BoqView';
import ScheduleView from '@/components/views/ScheduleView';
import ProgressView from '@/components/views/ProgressView';
import BudgetView from '@/components/views/BudgetView';
import RisksView from '@/components/views/RisksView';
import ExportView from '@/components/views/ExportView';

function App() {
  const [activeView, setActiveView] = useState<ViewName>('dashboard');
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLastProject();
  }, []);

  async function loadLastProject() {
    const { data } = await supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) setProject(data);
    setLoading(false);
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
      <main className="lg:mr-72 min-h-screen">
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
          {activeView === 'dashboard' && <Dashboard project={project} onNavigate={setActiveView} />}
          {activeView === 'import' && <ImportView onProjectCreated={handleProjectCreated} />}
          {activeView === 'boq' && <BoqView project={project} />}
          {activeView === 'schedule' && <ScheduleView project={project} />}
          {activeView === 'progress' && <ProgressView project={project} />}
          {activeView === 'budget' && <BudgetView project={project} />}
          {activeView === 'risks' && <RisksView project={project} />}
          {activeView === 'export' && <ExportView project={project} />}
        </div>
      </main>
    </div>
  );
}

export default App;

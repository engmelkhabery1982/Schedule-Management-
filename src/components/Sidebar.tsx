import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project } from '@/types';
import {
  LayoutDashboard, Upload, FileText, Calendar, TrendingUp,
  Wallet, AlertTriangle, Download, Building2, Menu, X
} from 'lucide-react';
import type { ViewName } from '@/types';

interface SidebarProps {
  activeView: ViewName;
  onViewChange: (view: ViewName) => void;
  project: Project | null;
  onProjectChange: () => void;
}

export default function Sidebar({ activeView, onViewChange, project, onProjectChange }: SidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjectList, setShowProjectList] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    const { data } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (data) setProjects(data);
  }

  async function selectProject(p: Project) {
    await supabase.from('projects').update({}).eq('id', p.id);
    setShowProjectList(false);
    onProjectChange();
  }

  const navItems: { view: ViewName; label: string; icon: typeof LayoutDashboard }[] = [
    { view: 'dashboard', label: 'لوحة المعلومات', icon: LayoutDashboard },
    { view: 'import', label: 'استيراد العقد والمقايسة', icon: Upload },
    { view: 'boq', label: 'جدول الكميات', icon: FileText },
    { view: 'schedule', label: 'الجدول الزمني', icon: Calendar },
    { view: 'progress', label: 'تتبع التقدم', icon: TrendingUp },
    { view: 'budget', label: 'الميزانية', icon: Wallet },
    { view: 'risks', label: 'المخاطر والمشاكل', icon: AlertTriangle },
    { view: 'export', label: 'تصدير', icon: Download },
  ];

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-4 left-4 z-50 lg:hidden bg-slate-800 text-white p-2 rounded-lg shadow-lg"
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
        className={`fixed top-0 right-0 h-full w-72 bg-slate-900 text-white flex flex-col z-40 transition-transform duration-300 ${
          mobileOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Logo / Header */}
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center">
              <Building2 size={24} className="text-slate-900" />
            </div>
            <div>
              <h1 className="text-lg font-bold">مقاولات الإنشاء</h1>
              <p className="text-xs text-slate-400">إدارة المشاريع</p>
            </div>
          </div>
        </div>

        {/* Project selector */}
        <div className="p-4 border-b border-slate-700">
          <button
            onClick={() => setShowProjectList(!showProjectList)}
            className="w-full text-right p-3 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-400 mb-1">المشروع الحالي</p>
                <p className="text-sm font-semibold truncate">
                  {project ? project.name : 'اختر مشروع'}
                </p>
              </div>
            </div>
          </button>
          {showProjectList && (
            <div className="mt-2 space-y-1 max-h-60 overflow-y-auto">
              {projects.length === 0 && (
                <p className="text-xs text-slate-500 p-2 text-center">لا توجد مشاريع بعد</p>
              )}
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectProject(p)}
                  className={`w-full text-right p-2 rounded text-sm hover:bg-slate-700 transition-colors ${
                    project?.id === p.id ? 'bg-amber-500/20 text-amber-400' : 'text-slate-300'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
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
                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all duration-200 ${
                  isActive
                    ? 'bg-amber-500 text-slate-900 font-semibold shadow-lg shadow-amber-500/20'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon size={20} />
                <span className="text-sm">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 text-xs text-slate-500 text-center">
          نظام إدارة المشاريع الإنشائية
        </div>
      </aside>
    </>
  );
}

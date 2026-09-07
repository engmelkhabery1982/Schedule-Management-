import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, ActivityLink, WbsNode, Resource, ActivityResource } from '@/types';
import { generateXer, downloadXer, downloadCsv, activitiesToCsv, activitiesToMsProjectXml } from '@/lib/xerExporter';
import { Download, FileText, FileSpreadsheet, Database, Loader } from 'lucide-react';

interface ExportViewProps {
  project: Project | null;
}

export default function ExportView({ project }: ExportViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [wbsNodes, setWbsNodes] = useState<WbsNode[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [activityResources, setActivityResources] = useState<ActivityResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, linkRes, wbsRes, resRes, arRes] = await Promise.all([
      supabase.from('activities').select('*, wbs_node:wbs_nodes(*)').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('activity_links').select('*, predecessor:activities(*), successor:activities(*)').eq('project_id', project.id),
      supabase.from('wbs_nodes').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('resources').select('*').eq('project_id', project.id),
      supabase.from('activity_resources').select('*, resource:resources(*)').eq('project_id', project.id),
    ]);
    setActivities(actRes.data || []);
    setLinks(linkRes.data || []);
    setWbsNodes(wbsRes.data || []);
    setResources(resRes.data || []);
    setActivityResources(arRes.data || []);
    setLoading(false);
  }

  function handleExportXer() {
    if (!project) return;
    setExporting(true);
    const xer = generateXer({
      project: {
        id: project.id,
        name: project.name,
        start_date: project.start_date || activities[0]?.early_start || new Date().toISOString().split('T')[0],
        end_date: project.end_date || activities[activities.length - 1]?.early_finish || new Date().toISOString().split('T')[0],
      },
      wbsNodes,
      activities,
      links,
      resources,
      activityResources,
    });
    downloadXer(xer, `${project.name.replace(/\s+/g, '_')}_Schedule.xer`);
    setExporting(false);
  }

  function handleExportActivitiesCsv() {
    if (!project) return;
    const csv = activitiesToCsv(activities);
    downloadCsv(csv, `${project.name.replace(/\s+/g, '_')}_Activities.csv`);
  }

  function handleExportMsProjectXml() {
    if (!project) return;
    const xml = activitiesToMsProjectXml(activities, project.name);
    downloadXer(xml, `${project.name.replace(/\s+/g, '_')}_Schedule.xml`);
  }

  function handleExportWbsCsv() {
    if (!project) return;
    const headers = ['Code', 'Name', 'Level', 'Parent Code'];
    const rows = wbsNodes.map((w) => {
      const parent = wbsNodes.find((p) => p.id === w.parent_id);
      return [w.code, `"${w.name.replace(/"/g, '""')}"`, w.level, parent?.code || ''].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    downloadCsv(csv, `${project.name.replace(/\s+/g, '_')}_WBS.csv`);
  }

  function handleExportResourcesCsv() {
    if (!project) return;
    const headers = ['Name', 'Type', 'Unit', 'Unit Rate (SAR)', 'Availability'];
    const rows = resources.map((r) => [
      `"${r.name}"`, r.type, r.unit, r.unit_rate, r.availability,
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    downloadCsv(csv, `${project.name.replace(/\s+/g, '_')}_Resources.csv`);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent"></div>
      </div>
    );
  }

  if (!project) {
    return <div className="text-center text-slate-400 py-8">لا يوجد مشروع محدد</div>;
  }

  const exportOptions = [
    {
      title: 'تصدير XER لبرنامج Primavera P6',
      description: 'تصدير الجدول الزمني الكامل (WBS، الأنشطة، التبعيات، الموارد) بصيغة XER المتوافقة مع Primavera P6',
      icon: Database,
      color: 'bg-red-50 text-red-600',
      action: handleExportXer,
      primary: true,
    },
    {
      title: 'تصدير الأنشطة (CSV)',
      description: 'تصدير قائمة الأنشطة مع التواريخ والمدد ونسب الإنجاز',
      icon: FileSpreadsheet,
      color: 'bg-emerald-50 text-emerald-600',
      action: handleExportActivitiesCsv,
    },
    {
      title: 'تصدير Microsoft Project (XML)',
      description: 'تصدير الأنشطة والتواريخ والمدد بصيغة XML القابلة للفتح في Microsoft Project',
      icon: FileText,
      color: 'bg-indigo-50 text-indigo-600',
      action: handleExportMsProjectXml,
    },
    {
      title: 'تصدير WBS (CSV)',
      description: 'تصدير هيكل تقسيم العمل مع الأكواد والمستويات',
      icon: FileText,
      color: 'bg-blue-50 text-blue-600',
      action: handleExportWbsCsv,
    },
    {
      title: 'تصدير الموارد (CSV)',
      description: 'تصدير قائمة الموارد مع الأسعار والوحدات',
      icon: FileSpreadsheet,
      color: 'bg-amber-50 text-amber-600',
      action: handleExportResourcesCsv,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">تصدير البيانات</h1>
        <p className="text-sm text-slate-500 mt-1">تصدير الجدول الزمني والبيانات بصيغ مختلفة للاستخدام في برامج أخرى</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-800">{wbsNodes.length}</p>
          <p className="text-xs text-slate-500">عقد WBS</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-800">{activities.length}</p>
          <p className="text-xs text-slate-500">نشاط</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-800">{links.length}</p>
          <p className="text-xs text-slate-500">تبعية</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-800">{resources.length}</p>
          <p className="text-xs text-slate-500">مورد</p>
        </div>
      </div>

      {/* Export options */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {exportOptions.map((opt) => {
          const Icon = opt.icon;
          return (
            <button
              key={opt.title}
              onClick={opt.action}
              disabled={exporting}
              className={`bg-white rounded-xl shadow-sm border p-5 text-right hover:shadow-md transition-all disabled:opacity-50 ${
                opt.primary ? 'border-red-200 ring-2 ring-red-100' : 'border-slate-200'
              }`}
            >
              <div className="flex items-start gap-4">
                <div className={`w-12 h-12 ${opt.color} rounded-lg flex items-center justify-center flex-shrink-0`}>
                  <Icon size={24} />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-slate-800 mb-1">{opt.title}</h3>
                  <p className="text-sm text-slate-500">{opt.description}</p>
                  <div className="flex items-center gap-1 mt-2 text-amber-600 text-sm font-medium">
                    <Download size={16} />
                    <span>تصدير الآن</span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {exporting && (
        <div className="flex items-center justify-center py-8">
          <Loader size={24} className="text-amber-500 animate-spin" />
          <span className="mr-2 text-sm text-slate-500">جاري التصدير...</span>
        </div>
      )}

      {/* Info note */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <p className="text-sm text-blue-700">
          ملاحظة: ملف XER هو الصيغة القياسية لاستيراد الجداول الزمنية إلى Primavera P6. يحتوي الملف على WBS والأنشطة والتبعيات والموارد. يمكن استيراده مباشرة عبر File &gt; Import &gt; Primavera XER في برنامج P6.
        </p>
      </div>
    </div>
  );
}

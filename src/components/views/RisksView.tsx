import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Risk, Issue } from '@/types';
import { AlertTriangle, Plus, X, Lightbulb, Shield } from 'lucide-react';

interface RisksViewProps {
  project: Project | null;
}

export default function RisksView({ project }: RisksViewProps) {
  const [risks, setRisks] = useState<Risk[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'risks' | 'issues'>('risks');
  const [showRiskForm, setShowRiskForm] = useState(false);
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [riskForm, setRiskForm] = useState({
    title: '', description: '', probability: 3, impact: 3, mitigation: '', category: '',
  });
  const [issueForm, setIssueForm] = useState({
    title: '', description: '', priority: 'medium', proposed_solution: '', assignee: '',
  });

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [riskRes, issueRes] = await Promise.all([
      supabase.from('risks').select('*').eq('project_id', project.id).order('severity', { ascending: false }),
      supabase.from('issues').select('*').eq('project_id', project.id).order('raised_date', { ascending: false }),
    ]);
    setRisks(riskRes.data || []);
    setIssues(issueRes.data || []);
    setLoading(false);
  }

  async function addRisk() {
    if (!project || !riskForm.title) return;
    await supabase.from('risks').insert({
      project_id: project.id,
      title: riskForm.title,
      description: riskForm.description || null,
      probability: riskForm.probability,
      impact: riskForm.impact,
      severity: riskForm.probability * riskForm.impact,
      mitigation: riskForm.mitigation || null,
      category: riskForm.category || null,
      status: 'open',
    });
    setRiskForm({ title: '', description: '', probability: 3, impact: 3, mitigation: '', category: '' });
    setShowRiskForm(false);
    await loadData();
  }

  async function addIssue() {
    if (!project || !issueForm.title) return;
    await supabase.from('issues').insert({
      project_id: project.id,
      title: issueForm.title,
      description: issueForm.description || null,
      priority: issueForm.priority,
      proposed_solution: issueForm.proposed_solution || null,
      assignee: issueForm.assignee || null,
      status: 'open',
    });
    setIssueForm({ title: '', description: '', priority: 'medium', proposed_solution: '', assignee: '' });
    setShowIssueForm(false);
    await loadData();
  }

  async function updateRiskStatus(id: string, status: string) {
    await supabase.from('risks').update({ status }).eq('id', id);
    await loadData();
  }

  async function updateIssueStatus(id: string, status: string) {
    const updates: { status: string; resolved_date?: string } = { status };
    if (status === 'resolved') updates.resolved_date = new Date().toISOString().split('T')[0];
    await supabase.from('issues').update(updates).eq('id', id);
    await loadData();
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

  function severityColor(severity: number): string {
    if (severity >= 15) return 'bg-red-100 text-red-700 border-red-200';
    if (severity >= 9) return 'bg-amber-100 text-amber-700 border-amber-200';
    return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  }

  function severityLabel(severity: number): string {
    if (severity >= 15) return 'عالية';
    if (severity >= 9) return 'متوسطة';
    return 'منخفضة';
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">المخاطر والمشاكل</h1>
          <p className="text-sm text-slate-500 mt-1">سجل المخاطر والمشاكل مع الحلول المقترحة</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <button
          onClick={() => setTab('risks')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'risks' ? 'border-amber-500 text-amber-600' : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Shield size={18} />
          المخاطر ({risks.length})
        </button>
        <button
          onClick={() => setTab('issues')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'issues' ? 'border-amber-500 text-amber-600' : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <AlertTriangle size={18} />
          المشاكل ({issues.length})
        </button>
      </div>

      {/* Risks tab */}
      {tab === 'risks' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowRiskForm(!showRiskForm)}
              className="flex items-center gap-2 bg-amber-500 text-slate-900 px-4 py-2 rounded-lg font-medium hover:bg-amber-400 transition-colors text-sm"
            >
              {showRiskForm ? <X size={18} /> : <Plus size={18} />}
              {showRiskForm ? 'إلغاء' : 'إضافة خطر'}
            </button>
          </div>

          {showRiskForm && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">العنوان *</label>
                  <input
                    type="text"
                    value={riskForm.title}
                    onChange={(e) => setRiskForm({ ...riskForm, title: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">الفئة</label>
                  <input
                    type="text"
                    value={riskForm.category}
                    onChange={(e) => setRiskForm({ ...riskForm, category: e.target.value })}
                    placeholder="مثال: مالي، تقني، بيئي"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">الاحتمالية (1-5)</label>
                  <input
                    type="number" min="1" max="5"
                    value={riskForm.probability}
                    onChange={(e) => setRiskForm({ ...riskForm, probability: Math.min(5, Math.max(1, parseInt(e.target.value) || 1)) })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">التأثير (1-5)</label>
                  <input
                    type="number" min="1" max="5"
                    value={riskForm.impact}
                    onChange={(e) => setRiskForm({ ...riskForm, impact: Math.min(5, Math.max(1, parseInt(e.target.value) || 1)) })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">الوصف</label>
                <textarea
                  value={riskForm.description}
                  onChange={(e) => setRiskForm({ ...riskForm, description: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">استراتيجية التخفيف</label>
                <textarea
                  value={riskForm.mitigation}
                  onChange={(e) => setRiskForm({ ...riskForm, mitigation: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm resize-none"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-600">مستوى الخطورة: </span>
                <span className={`px-3 py-1 rounded-full text-sm font-medium border ${severityColor(riskForm.probability * riskForm.impact)}`}>
                  {severityLabel(riskForm.probability * riskForm.impact)} ({riskForm.probability * riskForm.impact}/25)
                </span>
              </div>
              <button
                onClick={addRisk}
                className="bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-emerald-600 transition-colors text-sm"
              >
                حفظ الخطر
              </button>
            </div>
          )}

          {/* Risk cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {risks.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-8 col-span-2">لا توجد مخاطر مسجلة</p>
            )}
            {risks.map((risk) => (
              <div key={risk.id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-slate-800">{risk.title}</h4>
                    {risk.category && (
                      <span className="inline-block mt-1 px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full text-xs">{risk.category}</span>
                    )}
                  </div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium border ${severityColor(risk.severity)} flex-shrink-0`}>
                    {severityLabel(risk.severity)} ({risk.severity})
                  </span>
                </div>
                {risk.description && <p className="text-sm text-slate-600 mb-2">{risk.description}</p>}
                {risk.mitigation && (
                  <div className="mt-2 p-2 bg-blue-50 rounded-lg">
                    <p className="text-xs text-blue-600 font-medium mb-1">استراتيجية التخفيف:</p>
                    <p className="text-sm text-blue-700">{risk.mitigation}</p>
                  </div>
                )}
                <div className="flex items-center justify-between mt-3">
                  <span className="text-xs text-slate-400">الاحتمالية: {risk.probability}/5 · التأثير: {risk.impact}/5</span>
                  <select
                    value={risk.status}
                    onChange={(e) => updateRiskStatus(risk.id, e.target.value)}
                    className="text-xs border border-slate-300 rounded px-2 py-1 bg-white"
                  >
                    <option value="open">مفتوح</option>
                    <option value="monitoring">مراقبة</option>
                    <option value="closed">مغلق</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Issues tab */}
      {tab === 'issues' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setShowIssueForm(!showIssueForm)}
              className="flex items-center gap-2 bg-amber-500 text-slate-900 px-4 py-2 rounded-lg font-medium hover:bg-amber-400 transition-colors text-sm"
            >
              {showIssueForm ? <X size={18} /> : <Plus size={18} />}
              {showIssueForm ? 'إلغاء' : 'إضافة مشكلة'}
            </button>
          </div>

          {showIssueForm && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">العنوان *</label>
                  <input
                    type="text"
                    value={issueForm.title}
                    onChange={(e) => setIssueForm({ ...issueForm, title: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">الأولوية</label>
                  <select
                    value={issueForm.priority}
                    onChange={(e) => setIssueForm({ ...issueForm, priority: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm bg-white"
                  >
                    <option value="low">منخفضة</option>
                    <option value="medium">متوسطة</option>
                    <option value="high">عالية</option>
                    <option value="critical">حرجة</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">المسؤول</label>
                  <input
                    type="text"
                    value={issueForm.assignee}
                    onChange={(e) => setIssueForm({ ...issueForm, assignee: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">الوصف</label>
                <textarea
                  value={issueForm.description}
                  onChange={(e) => setIssueForm({ ...issueForm, description: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1 flex items-center gap-1">
                  <Lightbulb size={16} className="text-amber-500" />
                  الحل المقترح
                </label>
                <textarea
                  value={issueForm.proposed_solution}
                  onChange={(e) => setIssueForm({ ...issueForm, proposed_solution: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none text-sm resize-none"
                />
              </div>
              <button
                onClick={addIssue}
                className="bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium hover:bg-emerald-600 transition-colors text-sm"
              >
                حفظ المشكلة
              </button>
            </div>
          )}

          {/* Issue cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {issues.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-8 col-span-2">لا توجد مشاكل مسجلة</p>
            )}
            {issues.map((issue) => (
              <div key={issue.id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                <div className="flex items-start justify-between mb-2">
                  <h4 className="font-semibold text-slate-800">{issue.title}</h4>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium flex-shrink-0 ${
                    issue.priority === 'critical' ? 'bg-red-100 text-red-700' :
                    issue.priority === 'high' ? 'bg-orange-100 text-orange-700' :
                    issue.priority === 'medium' ? 'bg-amber-100 text-amber-700' :
                    'bg-slate-100 text-slate-600'
                  }`}>
                    {issue.priority === 'critical' ? 'حرجة' : issue.priority === 'high' ? 'عالية' : issue.priority === 'medium' ? 'متوسطة' : 'منخفضة'}
                  </span>
                </div>
                {issue.description && <p className="text-sm text-slate-600 mb-2">{issue.description}</p>}
                {issue.proposed_solution && (
                  <div className="mt-2 p-2 bg-amber-50 rounded-lg">
                    <p className="text-xs text-amber-600 font-medium mb-1 flex items-center gap-1">
                      <Lightbulb size={14} /> الحل المقترح:
                    </p>
                    <p className="text-sm text-amber-700">{issue.proposed_solution}</p>
                  </div>
                )}
                <div className="flex items-center justify-between mt-3">
                  <div className="text-xs text-slate-400">
                    {issue.assignee && <span>المسؤول: {issue.assignee} · </span>}
                    {issue.raised_date && <span>تاريخ الإبلاغ: {issue.raised_date}</span>}
                  </div>
                  <select
                    value={issue.status}
                    onChange={(e) => updateIssueStatus(issue.id, e.target.value)}
                    className="text-xs border border-slate-300 rounded px-2 py-1 bg-white"
                  >
                    <option value="open">مفتوح</option>
                    <option value="in_progress">قيد المعالجة</option>
                    <option value="resolved">تم الحل</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

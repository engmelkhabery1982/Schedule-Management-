import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, ProcurementSubmittal } from '@/types';
import {
  FileCheck2,
  Plus,
  Search,
  Filter,
  CheckCircle,
  Clock,
  AlertTriangle,
  Layers,
  ArrowRight,
  Truck,
  Building,
} from 'lucide-react';

interface ProcurementViewProps {
  project: Project | null;
}

export default function ProcurementView({ project }: ProcurementViewProps) {
  const [submittals, setSubmittals] = useState<ProcurementSubmittal[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [form, setForm] = useState<Partial<ProcurementSubmittal>>({
    type: 'shop_drawing',
    status: 'draft',
    lead_time_days: 14,
    is_critical_path: false,
  });

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [subRes, actRes] = await Promise.all([
      supabase.from('procurement_submittals').select('*').eq('project_id', project.id).order('created_at', { ascending: false }),
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
    ]);
    setSubmittals((subRes.data || []) as ProcurementSubmittal[]);
    setActivities(actRes.data || []);
    setLoading(false);
  }

  async function handleCreateSubmittal() {
    if (!project || !form.code || !form.title) return;
    const item: Partial<ProcurementSubmittal> = {
      project_id: project.id,
      activity_id: form.activity_id || null,
      code: form.code,
      title: form.title,
      type: form.type || 'shop_drawing',
      supplier_or_subcontractor: form.supplier_or_subcontractor || null,
      submittal_date: form.submittal_date || new Date().toISOString().split('T')[0],
      required_approval_date: form.required_approval_date || null,
      actual_approval_date: form.actual_approval_date || null,
      lead_time_days: Number(form.lead_time_days) || 14,
      status: form.status || 'draft',
      is_critical_path: Boolean(form.is_critical_path),
      notes: form.notes || null,
    };

    await supabase.from('procurement_submittals').insert(item);
    setShowAddModal(false);
    setForm({ type: 'shop_drawing', status: 'draft', lead_time_days: 14, is_critical_path: false });
    await loadData();
  }

  const filteredSubmittals = submittals.filter((s) => {
    if (filterType !== 'all' && s.type !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.code.toLowerCase().includes(q);
    }
    return true;
  });

  const getStatusBadge = (st: string) => {
    switch (st) {
      case 'approved':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">معتمد (Approved)</span>;
      case 'approved_with_notes':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">معتمد بملاحظات</span>;
      case 'under_review':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">قيد المراجعة</span>;
      case 'rejected':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">مرفوض (Revise)</span>;
      case 'delivered':
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-50 text-purple-700 border border-purple-200">تم التوريد للموقع</span>;
      default:
        return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-50 text-slate-600 border border-slate-200">مسودة</span>;
    }
  };

  const getTypeLabel = (t: string) => {
    switch (t) {
      case 'shop_drawing':
        return 'مخططات ورشة (Shop Drawing)';
      case 'material_submittal':
        return 'اعتماد مواد (Material Submittal)';
      case 'long_lead_item':
        return 'توريدات طويلة الأجل (Long-Lead)';
      case 'inspection_mir':
        return 'استلام وتفتيش مواد (MIR)';
      default:
        return t;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <FileCheck2 className="text-blue-600" size={24} />
            تتبع المشتريات والاعتمادات الهندسية (Engineering & Procurement Log)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            ربط مخططات الورشة (Shop Drawings) واعتمادات المواد والتوريدات ذات الفترات الطويلة بشبكة CPM.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-2 rounded-lg text-xs font-semibold shadow-md shadow-blue-500/20 transition-colors"
        >
          <Plus size={15} />
          إضافة اعتماد / أمر شراء جديد
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
            <FileCheck2 size={20} />
          </div>
          <div>
            <div className="text-xl font-bold text-slate-800">{submittals.length}</div>
            <span className="text-xs text-slate-500">إجمالي الاعتمادات</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <CheckCircle size={20} />
          </div>
          <div>
            <div className="text-xl font-bold text-emerald-700">
              {submittals.filter((s) => s.status === 'approved' || s.status === 'approved_with_notes').length}
            </div>
            <span className="text-xs text-slate-500">تم اعتمادها</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
            <Clock size={20} />
          </div>
          <div>
            <div className="text-xl font-bold text-amber-700">
              {submittals.filter((s) => s.status === 'under_review' || s.status === 'draft').length}
            </div>
            <span className="text-xs text-slate-500">قيد المراجعة</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-red-50 text-red-600 flex items-center justify-center">
            <AlertTriangle size={20} />
          </div>
          <div>
            <div className="text-xl font-bold text-red-700">
              {submittals.filter((s) => s.is_critical_path).length}
            </div>
            <span className="text-xs text-slate-500">مرتبطة بالمسار الحرج</span>
          </div>
        </div>
      </div>

      {/* Filter and Search */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200 text-xs">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute right-2.5 top-2 text-slate-400" />
            <input
              type="text"
              placeholder="بحث في الاعتمادات والموردين..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-8 pl-3 py-1.5 border border-slate-300 rounded-md bg-white text-xs w-60 outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-0.5">
            <button
              onClick={() => setFilterType('all')}
              className={`px-2.5 py-1 rounded text-xs font-medium ${filterType === 'all' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
            >
              الكل
            </button>
            <button
              onClick={() => setFilterType('shop_drawing')}
              className={`px-2.5 py-1 rounded text-xs font-medium ${filterType === 'shop_drawing' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
            >
              مخططات (Shop Drawing)
            </button>
            <button
              onClick={() => setFilterType('material_submittal')}
              className={`px-2.5 py-1 rounded text-xs font-medium ${filterType === 'material_submittal' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
            >
              مواد (Materials)
            </button>
            <button
              onClick={() => setFilterType('long_lead_item')}
              className={`px-2.5 py-1 rounded text-xs font-medium ${filterType === 'long_lead_item' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
            >
              توريدات طويلة (Long-Lead)
            </button>
          </div>
        </div>
      </div>

      {/* Submittals Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th className="text-right p-3 font-semibold">الكود</th>
                <th className="text-right p-3 font-semibold">عنوان الاعتماد / المادة</th>
                <th className="text-right p-3 font-semibold">النوع</th>
                <th className="text-right p-3 font-semibold">المورد / الجهة</th>
                <th className="text-right p-3 font-semibold">النشاط المرتبط (CPM)</th>
                <th className="text-right p-3 font-semibold">فترة التوريد</th>
                <th className="text-right p-3 font-semibold">تاريخ الاعتماد</th>
                <th className="text-center p-3 font-semibold">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredSubmittals.map((sub) => {
                const act = activities.find((a) => a.id === sub.activity_id);
                return (
                  <tr key={sub.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-3 font-mono font-bold text-slate-700">{sub.code}</td>
                    <td className="p-3 font-medium text-slate-800 max-w-sm">
                      <div className="flex items-center gap-1.5">
                        <span>{sub.title}</span>
                        {sub.is_critical_path && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] bg-red-100 text-red-700 font-bold">حرج</span>
                        )}
                      </div>
                      {sub.notes && <p className="text-[10px] text-slate-400 mt-0.5">{sub.notes}</p>}
                    </td>
                    <td className="p-3 text-slate-600">{getTypeLabel(sub.type)}</td>
                    <td className="p-3 text-slate-600">{sub.supplier_or_subcontractor || '-'}</td>
                    <td className="p-3 text-slate-600 font-mono">{act ? `${act.code} - ${act.name}` : '-'}</td>
                    <td className="p-3 text-slate-600">{sub.lead_time_days} يوم</td>
                    <td className="p-3 text-slate-600 whitespace-nowrap">{sub.actual_approval_date || sub.required_approval_date || '-'}</td>
                    <td className="p-3 text-center">{getStatusBadge(sub.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl">
            <h3 className="text-base font-bold text-slate-800">إضافة بند اعتماد / مشتريات جديد</h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-600 mb-1">كود الاعتماد (Submittal Ref)</label>
                <input
                  type="text"
                  value={form.code || ''}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="مثال: SD-STR-005"
                  className="w-full p-2 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-slate-600 mb-1">عنوان الاعتماد / المادة</label>
                <input
                  type="text"
                  value={form.title || ''}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="مثال: اعتماد مخططات تسليح الجسور والأعمدة"
                  className="w-full p-2 border rounded-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">النوع</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as any })}
                    className="w-full p-2 border rounded-lg"
                  >
                    <option value="shop_drawing">مخطط ورشة (Shop Drawing)</option>
                    <option value="material_submittal">اعتماد مادة (Material Submittal)</option>
                    <option value="long_lead_item">توريد طويل الأجل (Long-Lead Item)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-600 mb-1">النشاط المرتبط (CPM)</label>
                  <select
                    value={form.activity_id || ''}
                    onChange={(e) => setForm({ ...form, activity_id: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  >
                    <option value="">بدون ربط</option>
                    {activities.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">المورد / المقاول</label>
                  <input
                    type="text"
                    value={form.supplier_or_subcontractor || ''}
                    onChange={(e) => setForm({ ...form, supplier_or_subcontractor: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">فترة التوريد / المراجعة (أيام)</label>
                  <input
                    type="number"
                    value={form.lead_time_days || 14}
                    onChange={(e) => setForm({ ...form, lead_time_days: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="critCheck"
                  checked={form.is_critical_path || false}
                  onChange={(e) => setForm({ ...form, is_critical_path: e.target.checked })}
                />
                <label htmlFor="critCheck" className="text-slate-700 font-semibold cursor-pointer">
                  هذا الاعتماد يؤثر مباشرة على بدء نشاط حرج (Critical Path Impact)
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 text-xs font-semibold"
              >
                إلغاء
              </button>
              <button
                onClick={() => void handleCreateSubmittal()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-md"
              >
                حفظ الاعتماد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

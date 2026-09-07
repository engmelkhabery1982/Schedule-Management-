import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, ProgressUpdate, InspectionRequest, BoqItem } from '@/types';
import { TrendingUp, Save, Calendar, CheckCircle, Clock } from 'lucide-react';

interface ProgressViewProps {
  project: Project | null;
}

export default function ProgressView({ project }: ProgressViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [updates, setUpdates] = useState<ProgressUpdate[]>([]);
  const [inspections, setInspections] = useState<InspectionRequest[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [inspectionForm, setInspectionForm] = useState({ activity_id: '', boq_item_id: '', request_number: '', inspection_date: new Date().toISOString().split('T')[0], quantity: 0, parent_reference: '', notes: '' });
  const [editingInspectionId, setEditingInspectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedActivity, setSelectedActivity] = useState<string | null>(null);
  const [updateForm, setUpdateForm] = useState({
    percent_complete: 0,
    actual_quantity: 0,
    notes: '',
    update_date: new Date().toISOString().split('T')[0],
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, updRes, inspectionRes, boqRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('progress_updates').select('*').eq('project_id', project.id).order('update_date', { ascending: false }),
      supabase.from('inspection_requests').select('*').eq('project_id', project.id).order('inspection_date', { ascending: false }),
      supabase.from('boq_items').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
    ]);
    setActivities(actRes.data || []);
    setUpdates(updRes.data || []);
    setInspections((inspectionRes.data || []) as InspectionRequest[]);
    setBoqItems((boqRes.data || []) as BoqItem[]);
    setLoading(false);
  }

  async function submitInspection() {
    if (!project || !inspectionForm.activity_id || !inspectionForm.request_number || inspectionForm.quantity <= 0) {
      setMessage('أدخل رقم طلب الفحص والنشاط والكمية قبل الإرسال.');
      return;
    }
    const { error } = await supabase.from('inspection_requests').insert({
      project_id: project.id,
      request_number: inspectionForm.request_number,
      activity_id: inspectionForm.activity_id,
      boq_item_id: inspectionForm.boq_item_id || null,
      inspection_date: inspectionForm.inspection_date,
      inspected_quantity: inspectionForm.quantity,
      parent_reference: inspectionForm.parent_reference || null,
      notes: inspectionForm.notes || null,
      status: 'submitted',
    });
    if (error) {
      setMessage(`تعذر إرسال طلب الفحص: ${error.message}`);
      return;
    }
    setInspectionForm({ activity_id: '', boq_item_id: '', request_number: '', inspection_date: new Date().toISOString().split('T')[0], quantity: 0, parent_reference: '', notes: '' });
    setMessage('تم إرسال طلب الفحص للمراجعة.');
    await loadData();
  }

  async function reviewInspection(id: string, status: 'approved' | 'rejected') {
    const result = status === 'approved'
      ? await supabase.rpc('approve_inspection_request', { request_uuid: id, approver: 'operator' })
      : await supabase.from('inspection_requests').update({ status, approved_by: 'operator' }).eq('id', id).eq('status', 'submitted');
    if (result.error) {
      setMessage(`تعذر اعتماد طلب الفحص: ${result.error.message}`);
      return;
    }

    await loadData();
  }

  async function saveInspectionEdit() {
    if (!editingInspectionId) return;
    const { error } = await supabase.rpc('update_inspection_request', {
      request_uuid: editingInspectionId,
      request_data: {
        request_number: inspectionForm.request_number,
        activity_id: inspectionForm.activity_id,
        boq_item_id: inspectionForm.boq_item_id,
        inspection_date: inspectionForm.inspection_date,
        inspected_quantity: inspectionForm.quantity,
        parent_reference: inspectionForm.parent_reference,
        notes: inspectionForm.notes,
      },
    });
    if (error) {
      setMessage(`تعذر تعديل طلب الفحص: ${error.message}`);
      return;
    }
    setEditingInspectionId(null);
    setMessage('تم حفظ تعديل طلب الفحص وأعيد إلى حالة المراجعة.');
    await loadData();
  }

  async function handleSaveUpdate() {
    if (!project || !selectedActivity) return;
    setSaving(true);
    const activity = activities.find((a) => a.id === selectedActivity);
    if (!activity) {
      setMessage('تعذر تحديد النشاط للتحديث.');
      setSaving(false);
      return;
    }

    const plannedQuantity = activity.planned_quantity || 0;
    const enteredQuantity = Math.max(0, updateForm.actual_quantity);
    const calculatedPercent = plannedQuantity > 0
      ? Math.min(100, (enteredQuantity / plannedQuantity) * 100)
      : updateForm.percent_complete;
    const previousQuantity = activity.actual_quantity || 0;
    const latestApproved = updates
      .filter((update) => update.activity_id === selectedActivity && update.status === 'approved')
      .sort((a, b) => b.update_date.localeCompare(a.update_date))[0];
    if (enteredQuantity < previousQuantity) {
      setMessage('لا يمكن خفض الكمية التراكمية. استخدم تصحيحاً موثقاً بدلاً من عكس الإنجاز.');
      setSaving(false);
      return;
    }
    if (latestApproved && updateForm.update_date < latestApproved.update_date) {
      setMessage(`تاريخ التحديث يجب ألا يسبق آخر تحديث معتمد (${latestApproved.update_date}).`);
      setSaving(false);
      return;
    }

    // Store the submission first; only approved submissions update control KPIs.
    const { error: insErr } = await supabase.from('progress_updates').insert({
      project_id: project.id,
      activity_id: selectedActivity,
      update_date: updateForm.update_date,
      percent_complete: calculatedPercent,
      actual_quantity: Math.max(0, enteredQuantity - previousQuantity),
      quantity_to_date: enteredQuantity,
      notes: updateForm.notes || null,
      status: 'submitted',
    });
    if (insErr) {
      setMessage(`تعذر إرسال التحديث: ${insErr.message}`);
      setSaving(false);
      return;
    }

    // Reload
    await loadData();
    setUpdateForm({ percent_complete: 0, actual_quantity: 0, notes: '', update_date: new Date().toISOString().split('T')[0] });
    setSelectedActivity(null);
    setMessage('تم إرسال التحديث للمراجعة والاعتماد.');
    setSaving(false);
  }

  async function reviewUpdate(updateId: string, status: 'approved' | 'rejected') {
    const update = updates.find((item) => item.id === updateId);
    if (!update || !project) return;
    const { error } = status === 'approved'
      ? await supabase.rpc('approve_progress_update', { update_uuid: updateId, approver: 'operator' })
      : await supabase.from('progress_updates')
        .update({ status, approved_at: null, approved_by: 'operator' })
        .eq('id', updateId)
        .eq('status', 'submitted');
    if (error) {
      setMessage(`تعذر مراجعة التحديث: ${error.message}`);
      return;
    }
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

  if (activities.length === 0) {
    return (
      <div className="text-center py-12">
        <TrendingUp size={48} className="text-slate-300 mx-auto mb-3" />
        <p className="text-slate-500">لا توجد أنشطة. استورد المقايسة أولاً</p>
      </div>
    );
  }

  const completed = activities.filter((a) => a.percent_complete >= 100).length;
  const inProgress = activities.filter((a) => a.percent_complete > 0 && a.percent_complete < 100).length;
  const overall = activities.length > 0 ? activities.reduce((s, a) => s + a.percent_complete, 0) / activities.length : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">تتبع التقدم اليومي</h1>
        <p className="text-sm text-slate-500 mt-1">تحديث حالة الأنشطة ونسية الإنجاز</p>
      </div>
      {message && <div className="p-3 bg-blue-50 border border-blue-200 text-blue-700 rounded-lg text-sm">{message}</div>}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 mb-1">
            <TrendingUp size={18} />
            <span className="text-sm">الإنجاز الكلي</span>
          </div>
          <p className="text-2xl font-bold text-slate-800">{overall.toFixed(1)}%</p>
          <div className="h-2 bg-slate-100 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${overall}%` }} />
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 mb-1">
            <CheckCircle size={18} />
            <span className="text-sm">مكتملة</span>
          </div>
          <p className="text-2xl font-bold text-emerald-600">{completed}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 mb-1">
            <Clock size={18} />
            <span className="text-sm">قيد التنفيذ</span>
          </div>
          <p className="text-2xl font-bold text-blue-600">{inProgress}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 mb-1">
            <Calendar size={18} />
            <span className="text-sm">إجمالي الأنشطة</span>
          </div>
          <p className="text-2xl font-bold text-slate-800">{activities.length}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity list for selection */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <h3 className="font-semibold text-slate-800 p-4 border-b border-slate-100">اختر نشاطاً للتحديث</h3>
          <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
            {activities.map((act) => (
              <button
                key={act.id}
                onClick={() => {
                  setSelectedActivity(act.id);
                  setUpdateForm({
                    percent_complete: act.percent_complete,
                    actual_quantity: act.actual_quantity || 0,
                    notes: '',
                    update_date: new Date().toISOString().split('T')[0],
                  });
                }}
                className={`w-full text-right p-3 hover:bg-slate-50 transition-colors ${
                  selectedActivity === act.id ? 'bg-amber-50 border-r-4 border-amber-500' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-700 truncate">{act.name}</p>
                    <p className="text-xs text-slate-400">{act.code} · {act.duration_days} يوم</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="w-20 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${act.percent_complete}%` }} />
                    </div>
                    <span className="text-xs font-semibold text-slate-600 w-10">{act.percent_complete}%</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Update form */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4">تحديث التقدم</h3>
          {selectedActivity ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm text-slate-500 mb-1">النشاط المحدد:</p>
                <p className="text-sm font-medium text-slate-700">
                  {activities.find((a) => a.id === selectedActivity)?.name}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">التاريخ</label>
                <input
                  type="date"
                  value={updateForm.update_date}
                  onChange={(e) => setUpdateForm({ ...updateForm, update_date: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">نسبة الإنجاز (%)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={updateForm.percent_complete}
                  onChange={(e) => setUpdateForm({ ...updateForm, percent_complete: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)) })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none text-sm"
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={updateForm.percent_complete}
                  onChange={(e) => setUpdateForm({ ...updateForm, percent_complete: parseFloat(e.target.value) })}
                  className="w-full mt-2 accent-amber-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  الكمية المنفذة حتى الآن {selectedActivity && `(${activities.find((a) => a.id === selectedActivity)?.unit || 'وحدة'})`}
                </label>
                <input
                  type="number"
                  value={updateForm.actual_quantity}
                  onChange={(e) => setUpdateForm({ ...updateForm, actual_quantity: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none text-sm"
                />
                <p className="text-xs text-slate-400 mt-1">
                  يتم حساب نسبة الإنجاز تلقائياً من الكمية المخططة عند توفرها.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">ملاحظات</label>
                <textarea
                  value={updateForm.notes}
                  onChange={(e) => setUpdateForm({ ...updateForm, notes: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none text-sm resize-none"
                />
              </div>
              <button
                onClick={handleSaveUpdate}
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 bg-amber-500 text-slate-900 py-2.5 rounded-lg font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50"
              >
                <Save size={18} />
                {saving ? 'جاري الحفظ...' : 'حفظ التحديث'}
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-400 text-center py-8">اختر نشاطاً من القائمة لتحديث تقدمه</p>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h3 className="font-semibold text-slate-800 mb-2">طلبات الفحص اليومية</h3>
        <p className="text-xs text-slate-500 mb-4">الكمية المعتمدة فقط تُرحّل تلقائياً إلى التقدم والقيمة المكتسبة.</p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input value={inspectionForm.request_number} onChange={(e) => setInspectionForm({ ...inspectionForm, request_number: e.target.value })} placeholder="رقم طلب الفحص" className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <select value={inspectionForm.activity_id} onChange={(e) => setInspectionForm({ ...inspectionForm, activity_id: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
            <option value="">النشاط / البند الفرعي</option>
            {activities.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}
          </select>
          <select value={inspectionForm.boq_item_id} onChange={(e) => setInspectionForm({ ...inspectionForm, boq_item_id: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
            <option value="">البند الرئيسي (اختياري)</option>
            {boqItems.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.description}</option>)}
          </select>
          <input type="date" value={inspectionForm.inspection_date} onChange={(e) => setInspectionForm({ ...inspectionForm, inspection_date: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <input type="number" min="0" value={inspectionForm.quantity} onChange={(e) => setInspectionForm({ ...inspectionForm, quantity: parseFloat(e.target.value) || 0 })} placeholder="الكمية المفحوصة" className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <input value={inspectionForm.parent_reference} onChange={(e) => setInspectionForm({ ...inspectionForm, parent_reference: e.target.value })} placeholder="مرجع البند الرئيسي / WBS" className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <input value={inspectionForm.notes} onChange={(e) => setInspectionForm({ ...inspectionForm, notes: e.target.value })} placeholder="ملاحظات" className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <button onClick={editingInspectionId ? saveInspectionEdit : submitInspection} className="bg-amber-500 text-slate-900 rounded-lg font-semibold text-sm">{editingInspectionId ? 'حفظ تعديل الطلب' : 'إرسال طلب فحص'}</button>
        </div>
        {inspections.length > 0 && <div className="overflow-x-auto mt-4"><table className="w-full text-sm"><thead className="bg-slate-50"><tr><th className="p-2 text-right">الطلب</th><th className="p-2 text-right">التاريخ</th><th className="p-2 text-right">النشاط</th><th className="p-2 text-right">الكمية</th><th className="p-2 text-right">الحالة</th><th className="p-2 text-right">إجراء</th></tr></thead><tbody className="divide-y">{inspections.slice(0, 30).map((request) => <tr key={request.id}><td className="p-2">{request.request_number}</td><td className="p-2">{request.inspection_date}</td><td className="p-2">{activities.find((item) => item.id === request.activity_id)?.name || '-'}</td><td className="p-2">{request.inspected_quantity}</td><td className="p-2">{request.status === 'approved' ? 'معتمد ومرحل' : request.status === 'rejected' ? 'مرفوض' : 'قيد المراجعة'}</td><td className="p-2">{request.status === 'submitted' && <div className="flex gap-2"><button onClick={() => { setEditingInspectionId(request.id); setInspectionForm({ activity_id: request.activity_id, boq_item_id: request.boq_item_id || '', request_number: request.request_number, inspection_date: request.inspection_date, quantity: request.inspected_quantity, parent_reference: request.parent_reference || '', notes: request.notes || '' }); }} className="text-amber-700 text-xs font-semibold">تعديل</button><button onClick={() => reviewInspection(request.id, 'approved')} className="text-emerald-700 text-xs font-semibold">اعتماد وترحيل</button><button onClick={() => reviewInspection(request.id, 'rejected')} className="text-red-700 text-xs">رفض</button></div>}</td></tr>)}</tbody></table></div>}
      </div>

      {/* Recent updates */}
      {updates.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <h3 className="font-semibold text-slate-800 p-4 border-b border-slate-100">آخر التحديثات</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-right p-3 font-medium">التاريخ</th>
                  <th className="text-right p-3 font-medium">النشاط</th>
                  <th className="text-right p-3 font-medium">نسبة الإنجاز</th>
                  <th className="text-right p-3 font-medium">ملاحظات</th>
                  <th className="text-right p-3 font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {updates.slice(0, 20).map((u) => {
                  const act = activities.find((a) => a.id === u.activity_id);
                  return (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="p-3 text-slate-600 whitespace-nowrap">{u.update_date}</td>
                      <td className="p-3 text-slate-700 max-w-xs truncate">{act?.name || '-'}</td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          u.percent_complete >= 100 ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {u.percent_complete}%
                        </span>
                      </td>
                      <td className="p-3 text-slate-500 max-w-xs truncate">{u.notes || '-'}</td>
                      <td className="p-3">
                        {u.status === 'submitted' ? (
                          <div className="flex gap-2">
                            <button onClick={() => reviewUpdate(u.id, 'approved')} className="text-xs text-emerald-700 font-medium">اعتماد</button>
                            <button onClick={() => reviewUpdate(u.id, 'rejected')} className="text-xs text-red-700 font-medium">رفض</button>
                          </div>
                        ) : (
                          <span className={`text-xs font-medium ${u.status === 'approved' ? 'text-emerald-700' : 'text-slate-500'}`}>
                            {u.status === 'approved' ? 'معتمد' : u.status === 'rejected' ? 'مرفوض' : 'مسودة'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

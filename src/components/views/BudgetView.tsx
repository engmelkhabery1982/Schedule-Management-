import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, BudgetLine, CostTransaction, BoqItem, Activity } from '@/types';
import { Wallet, TrendingUp, TrendingDown, DollarSign, Save } from 'lucide-react';

interface BudgetViewProps {
  project: Project | null;
}

export default function BudgetView({ project }: BudgetViewProps) {
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editActual, setEditActual] = useState(0);
  const [transactions, setTransactions] = useState<CostTransaction[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [transactionForm, setTransactionForm] = useState({ description: '', amount: 0, cost_type: 'direct', boq_item_id: '', activity_id: '', vendor: '', invoice_number: '' });

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [{ data }, { data: transactionData }, { data: boqData }, { data: activityData }] = await Promise.all([
      supabase.from('budget_lines').select('*').eq('project_id', project.id),
      supabase.from('cost_transactions').select('*').eq('project_id', project.id).order('transaction_date', { ascending: false }),
      supabase.from('boq_items').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
    ]);
    setBudgetLines(data || []);
    setTransactions((transactionData || []) as CostTransaction[]);
    setBoqItems((boqData || []) as BoqItem[]);
    setActivities((activityData || []) as Activity[]);
    setLoading(false);
  }

  async function addTransaction() {
    if (!project || !transactionForm.description || transactionForm.amount <= 0) return;
    if (!transactionForm.boq_item_id && !transactionForm.activity_id) return;
    const { error } = await supabase.from('cost_transactions').insert({
      project_id: project.id,
      description: transactionForm.description,
      amount: transactionForm.amount,
      cost_type: transactionForm.cost_type,
      transaction_date: new Date().toISOString().split('T')[0],
      source: 'manual',
      status: 'submitted',
      boq_item_id: transactionForm.boq_item_id || null,
      activity_id: transactionForm.activity_id || null,
      vendor: transactionForm.vendor || null,
      invoice_number: transactionForm.invoice_number || null,
    });
    if (error) return;
    setTransactionForm({ description: '', amount: 0, cost_type: 'direct', boq_item_id: '', activity_id: '', vendor: '', invoice_number: '' });
    await loadData();
  }

  async function approveTransaction(id: string) {
    const transaction = transactions.find((item) => item.id === id);
    const { error } = await supabase.rpc('review_cost_transaction', {
      transaction_uuid: id,
      approver: (transaction?.approval_level || 0) === 0 ? 'project_control' : 'finance_manager',
      decision: 'approve',
    });
    if (!error) await loadData();
  }

  async function rejectTransaction(id: string) {
    const { error } = await supabase.rpc('review_cost_transaction', {
      transaction_uuid: id,
      approver: 'reviewer',
      decision: 'reject',
      review_notes: 'مرفوض للمراجعة والتصحيح',
    });
    if (!error) await loadData();
  }

  async function saveActual(id: string) {
    const line = budgetLines.find((l) => l.id === id);
    if (!line) return;
    const remaining = line.planned_cost - editActual;
    const { error } = await supabase.from('budget_lines').update({
      actual_cost: editActual,
      remaining_cost: remaining,
    }).eq('id', id);
    if (error) return;
    setEditingId(null);
    await loadData();
  }

  const totals = useMemo(() => {
    const planned = budgetLines.reduce((s, l) => s + (l.planned_cost || 0), 0);
    const committed = budgetLines.reduce((s, l) => s + (l.committed_cost || 0), 0);
    const lineActual = budgetLines.reduce((s, l) => s + (l.actual_cost || 0), 0);
    const transactionActual = transactions
      .filter((transaction) => transaction.status === 'approved')
      .reduce((s, t) => s + (t.amount || 0), 0);
    const actual = transactionActual > 0 ? transactionActual : lineActual;
    const remaining = budgetLines.reduce((s, l) => s + (l.remaining_cost || 0), 0);
    const variance = planned - actual;
    return { planned, committed, actual, remaining, variance };
  }, [budgetLines, transactions]);

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

  if (budgetLines.length === 0) {
    return (
      <div className="text-center py-12">
        <Wallet size={48} className="text-slate-300 mx-auto mb-3" />
        <p className="text-slate-500">لا توجد بنود ميزانية. استورد المقايسة أولاً</p>
      </div>
    );
  }

  const utilization = totals.planned > 0 ? (totals.actual / totals.planned) * 100 : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">الميزانية والتحكم في التكاليف</h1>
        <p className="text-sm text-slate-500 mt-1">جميع المبالغ بالريال السعودي</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 mb-1">
            <DollarSign size={18} />
            <span className="text-xs">المخطط</span>
          </div>
          <p className="text-lg font-bold text-slate-800">{totals.planned.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-blue-500 mb-1">
            <DollarSign size={18} />
            <span className="text-xs">ملتزم</span>
          </div>
          <p className="text-lg font-bold text-blue-700">{totals.committed.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-amber-500 mb-1">
            <DollarSign size={18} />
            <span className="text-xs">فعلي</span>
          </div>
          <p className="text-lg font-bold text-amber-700">{totals.actual.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-emerald-500 mb-1">
            <DollarSign size={18} />
            <span className="text-xs">متبقي</span>
          </div>
          <p className="text-lg font-bold text-emerald-700">{totals.remaining.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className={`flex items-center gap-2 mb-1 ${totals.variance >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
            {totals.variance >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
            <span className="text-xs">الانحراف</span>
          </div>
          <p className={`text-lg font-bold ${totals.variance >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
            {totals.variance.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Utilization bar */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-slate-600">نسبة استهلاك الميزانية</span>
          <span className="text-sm font-bold text-slate-800">{utilization.toFixed(1)}%</span>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-3">تسجيل تكلفة فعلية</h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              value={transactionForm.description}
              onChange={(e) => setTransactionForm({ ...transactionForm, description: e.target.value })}
              placeholder="وصف المصروف أو الفاتورة"
              className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500"
            />
            <select value={transactionForm.cost_type} onChange={(e) => setTransactionForm({ ...transactionForm, cost_type: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
              <option value="direct">تكلفة مباشرة</option><option value="labor">رواتب وعمالة</option><option value="materials">مواد</option><option value="equipment">إيجار معدات</option><option value="overhead">مصروفات غير مباشرة</option>
            </select>
            <select value={transactionForm.boq_item_id} onChange={(e) => setTransactionForm({ ...transactionForm, boq_item_id: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
              <option value="">تحميل على بند المقايسة</option>
              {boqItems.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.description.slice(0, 30)}</option>)}
            </select>
            <select value={transactionForm.activity_id} onChange={(e) => setTransactionForm({ ...transactionForm, activity_id: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
              <option value="">أو تحميل على نشاط</option>
              {activities.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name.slice(0, 30)}</option>)}
            </select>
            <input value={transactionForm.vendor} onChange={(e) => setTransactionForm({ ...transactionForm, vendor: e.target.value })} placeholder="المورد/المقاول" className="w-full sm:w-40 px-3 py-2 border border-slate-300 rounded-lg text-sm border-slate-300" />
            <input value={transactionForm.invoice_number} onChange={(e) => setTransactionForm({ ...transactionForm, invoice_number: e.target.value })} placeholder="رقم الفاتورة" className="w-full sm:w-32 px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            <input
              type="number"
              min="0"
              value={transactionForm.amount}
              onChange={(e) => setTransactionForm({ ...transactionForm, amount: parseFloat(e.target.value) || 0 })}
              placeholder="القيمة"
              className="w-full sm:w-32 px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500"
            />
            <button onClick={addTransaction} className="bg-amber-500 text-slate-900 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-400">
              إضافة
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-2">إجمالي الحركات المسجلة: {transactions.reduce((sum, t) => sum + t.amount, 0).toLocaleString()} ريال</p>
          {transactions.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
              {transactions.slice(0, 10).map((transaction) => (
                <div key={transaction.id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-600">{transaction.description} · {transaction.amount.toLocaleString()} ريال</span>
                  {transaction.status === 'submitted' ? (
                    <div className="flex items-center gap-2">
                      <button onClick={() => approveTransaction(transaction.id)} className="text-emerald-700 text-xs font-medium">
                        {transaction.approval_level === 0 ? 'اعتماد فني' : 'اعتماد مالي نهائي'}
                      </button>
                      <button onClick={() => rejectTransaction(transaction.id)} className="text-red-700 text-xs font-medium">رفض</button>
                    </div>
                  ) : (
                    <span className={`text-xs ${transaction.status === 'approved' ? 'text-emerald-700' : 'text-slate-500'}`}>
                      {transaction.status === 'approved' ? 'معتمد نهائيًا' : transaction.status === 'rejected' ? 'مرفوض' : 'مسودة'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${utilization > 90 ? 'bg-red-500' : utilization > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(utilization, 100)}%` }}
          />
        </div>
      </div>

      {/* Budget table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-right p-3 font-medium">البند</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">المخطط</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">ملتزم</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">فعلي</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">متبقي</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">الانحراف</th>
                <th className="text-right p-3 font-medium">إجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {budgetLines.map((line) => {
                const variance = line.planned_cost - line.actual_cost;
                return (
                  <tr key={line.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-3 text-slate-700 max-w-xs truncate">{line.description}</td>
                    <td className="p-3 text-slate-700 whitespace-nowrap">{line.planned_cost.toLocaleString()}</td>
                    <td className="p-3 text-blue-600 whitespace-nowrap">{line.committed_cost.toLocaleString()}</td>
                    <td className="p-3 text-amber-600 whitespace-nowrap">
                      {editingId === line.id ? (
                        <input
                          type="number"
                          value={editActual}
                          onChange={(e) => setEditActual(parseFloat(e.target.value) || 0)}
                          className="w-24 px-2 py-1 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-amber-500 outline-none"
                          autoFocus
                        />
                      ) : (
                        line.actual_cost.toLocaleString()
                      )}
                    </td>
                    <td className="p-3 text-emerald-600 whitespace-nowrap">{line.remaining_cost.toLocaleString()}</td>
                    <td className={`p-3 whitespace-nowrap font-medium ${variance >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {variance.toLocaleString()}
                    </td>
                    <td className="p-3">
                      {editingId === line.id ? (
                        <button
                          onClick={() => saveActual(line.id)}
                          className="flex items-center gap-1 text-emerald-600 hover:text-emerald-700 text-xs font-medium"
                        >
                          <Save size={14} /> حفظ
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingId(line.id);
                            setEditActual(line.actual_cost);
                          }}
                          className="text-amber-600 hover:text-amber-700 text-xs font-medium"
                        >
                          تحديث الفعلي
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold text-slate-800">
              <tr>
                <td className="p-3">الإجمالي</td>
                <td className="p-3">{totals.planned.toLocaleString()}</td>
                <td className="p-3 text-blue-700">{totals.committed.toLocaleString()}</td>
                <td className="p-3 text-amber-700">{totals.actual.toLocaleString()}</td>
                <td className="p-3 text-emerald-700">{totals.remaining.toLocaleString()}</td>
                <td className={`p-3 ${totals.variance >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{totals.variance.toLocaleString()}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

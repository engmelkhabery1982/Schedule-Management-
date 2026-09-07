import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, BudgetLine } from '@/types';
import { Wallet, TrendingUp, TrendingDown, DollarSign, Save } from 'lucide-react';

interface BudgetViewProps {
  project: Project | null;
}

export default function BudgetView({ project }: BudgetViewProps) {
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editActual, setEditActual] = useState(0);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const { data } = await supabase.from('budget_lines').select('*').eq('project_id', project.id);
    setBudgetLines(data || []);
    setLoading(false);
  }

  async function saveActual(id: string) {
    const line = budgetLines.find((l) => l.id === id);
    if (!line) return;
    const remaining = line.planned_cost - editActual;
    await supabase.from('budget_lines').update({
      actual_cost: editActual,
      remaining_cost: remaining,
    }).eq('id', id);
    setEditingId(null);
    await loadData();
  }

  const totals = useMemo(() => {
    const planned = budgetLines.reduce((s, l) => s + (l.planned_cost || 0), 0);
    const committed = budgetLines.reduce((s, l) => s + (l.committed_cost || 0), 0);
    const actual = budgetLines.reduce((s, l) => s + (l.actual_cost || 0), 0);
    const remaining = budgetLines.reduce((s, l) => s + (l.remaining_cost || 0), 0);
    const variance = planned - actual;
    return { planned, committed, actual, remaining, variance };
  }, [budgetLines]);

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

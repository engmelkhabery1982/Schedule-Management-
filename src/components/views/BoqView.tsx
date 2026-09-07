import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, BoqItem } from '@/types';
import { Search, FileText, Download } from 'lucide-react';

interface BoqViewProps {
  project: Project | null;
}

export default function BoqView({ project }: BoqViewProps) {
  const [items, setItems] = useState<BoqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  useEffect(() => {
    if (project) loadItems();
    else setLoading(false);
  }, [project]);

  async function loadItems() {
    if (!project) return;
    setLoading(true);
    const { data } = await supabase
      .from('boq_items')
      .select('*')
      .eq('project_id', project.id)
      .order('sort_order', { ascending: true });
    setItems(data || []);
    setLoading(false);
  }

  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter((c): c is string => Boolean(c)))], [items]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchesSearch = !search ||
        item.code.toLowerCase().includes(search.toLowerCase()) ||
        item.description.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = !categoryFilter || item.category === categoryFilter;
      return matchesSearch && matchesCategory;
    });
  }, [items, search, categoryFilter]);

  const totalValue = filteredItems.reduce((sum, i) => sum + (i.total_price || 0), 0);
  const totalQty = filteredItems.reduce((sum, i) => sum + (i.quantity || 0), 0);

  function exportCsv() {
    const headers = ['Code', 'Description', 'Unit', 'Quantity', 'Unit Price', 'Total Price', 'Category'];
    const rows = filteredItems.map(i => [
      i.code,
      `"${i.description.replace(/"/g, '""')}"`,
      i.unit || '',
      i.quantity,
      i.unit_price,
      i.total_price,
      i.category || '',
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BOQ_${project?.name || 'project'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText size={48} className="text-slate-300 mx-auto mb-3" />
        <p className="text-slate-500">لا توجد بنود مقايسة. استورد ملف المقايسة أولاً</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">جدول الكميات والمقايسة</h1>
          <p className="text-sm text-slate-500 mt-1">{items.length} بند · الإجمالي: {totalValue.toLocaleString()} ريال</p>
        </div>
        <button
          onClick={exportCsv}
          className="flex items-center gap-2 bg-slate-100 text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-200 transition-colors text-sm font-medium"
        >
          <Download size={18} />
          تصدير CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={18} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالكود أو الوصف..."
            className="w-full pr-10 pl-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none text-sm"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none text-sm bg-white"
        >
          <option value="">كل الفئات</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-right p-3 font-medium whitespace-nowrap">الكود</th>
                <th className="text-right p-3 font-medium">الوصف</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">الوحدة</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">الكمية</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">سعر الوحدة</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">الإجمالي</th>
                <th className="text-right p-3 font-medium whitespace-nowrap">الفئة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredItems.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 text-slate-500 whitespace-nowrap">{item.code}</td>
                  <td className="p-3 text-slate-700 max-w-md">{item.description}</td>
                  <td className="p-3 text-slate-500 whitespace-nowrap">{item.unit}</td>
                  <td className="p-3 text-slate-700 whitespace-nowrap">{item.quantity.toLocaleString()}</td>
                  <td className="p-3 text-slate-700 whitespace-nowrap">{item.unit_price.toLocaleString()}</td>
                  <td className="p-3 font-semibold text-slate-800 whitespace-nowrap">{item.total_price.toLocaleString()}</td>
                  <td className="p-3 whitespace-nowrap">
                    {item.category && (
                      <span className="px-2 py-1 bg-slate-100 text-slate-600 rounded-full text-xs">
                        {item.category}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold text-slate-800">
              <tr>
                <td colSpan={3} className="p-3 text-left">الإجمالي ({filteredItems.length} بند)</td>
                <td className="p-3">{totalQty.toLocaleString()}</td>
                <td></td>
                <td className="p-3">{totalValue.toLocaleString()}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

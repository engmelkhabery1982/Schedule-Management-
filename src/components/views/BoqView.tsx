import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, BoqItem, SubcontractPackage, SubcontractBoqItem } from '@/types';
import { getSubcontractPackages, saveSubcontractPackages } from '@/lib/subcontractEngine';
import {
  Search,
  FileText,
  Download,
  Building,
  Plus,
  TrendingUp,
  Percent,
  CheckCircle2,
  DollarSign,
  Layers,
  Sparkles,
  Phone,
  User,
  Shield,
  Edit,
  Save,
  Trash2,
} from 'lucide-react';

interface BoqViewProps {
  project: Project | null;
}

export default function BoqView({ project }: BoqViewProps) {
  const [items, setItems] = useState<BoqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [lang, setLang] = useState<Language>(getLanguage());
  const [activeTab, setActiveTab] = useState<'main_boq' | 'subcontract_boq'>('main_boq');

  // Subcontract Packages & BOQs State
  const [subcontracts, setSubcontracts] = useState<SubcontractPackage[]>(() =>
    getSubcontractPackages(project?.id)
  );

  useEffect(() => {
    if (subcontracts && subcontracts.length > 0) {
      saveSubcontractPackages(subcontracts, project?.id);
    }
  }, [subcontracts, project?.id]);

  const [selectedSubPkgId, setSelectedSubPkgId] = useState<string>('SUB-PKG-01');
  const [showAddSubModal, setShowAddSubModal] = useState(false);
  const [showAssignBoqModal, setShowAssignBoqModal] = useState(false);

  // New Subcontractor Package Form
  const [newSubForm, setNewSubForm] = useState({
    subcontractNumber: `SUB-CON-00${subcontracts.length + 1}`,
    subcontractorName: '',
    contactPerson: '',
    phone: '',
    trade: 'مقاول باطن - أعمال التشطيبات والديكور',
    contractDate: '2026-11-01',
    scopeDescription: '',
    retentionPercent: 10,
  });

  // Assign BOQ to Subcontractor Form
  const [assignForm, setAssignForm] = useState({
    boqCode: '01.01',
    description: 'أعمال حفريات وتجهيز منسوب التأسيس',
    unit: 'م3',
    assignedQuantity: 1000,
    subcontractRateSar: 35,
    clientRateSar: 45,
    linkedActivityCode: 'ACT-01',
  });

  useEffect(() => {
    if (project) loadItems();
    else setLoading(false);

    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
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

  // Subcontract Aggregates
  const totalSubcontractsValue = subcontracts.reduce((sum, s) => sum + s.totalSubcontractValueSar, 0);
  const totalClientEquivalentValue = subcontracts.reduce((sum, s) => sum + s.totalClientEquivalentValueSar, 0);
  const totalExpectedProfit = subcontracts.reduce((sum, s) => sum + s.totalExpectedProfitSar, 0);
  const overallMarginPercent = totalClientEquivalentValue > 0 ? Number(((totalExpectedProfit / totalClientEquivalentValue) * 100).toFixed(1)) : 0;

  const selectedSubPkg = useMemo(() => {
    return subcontracts.find((s) => s.id === selectedSubPkgId) || subcontracts[0];
  }, [subcontracts, selectedSubPkgId]);

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

  // Create new subcontractor package
  const handleCreateSubcontractor = () => {
    if (!newSubForm.subcontractorName) return;
    const newPkg: SubcontractPackage = {
      id: `SUB-PKG-0${subcontracts.length + 1}`,
      subcontractNumber: newSubForm.subcontractNumber,
      subcontractorName: newSubForm.subcontractorName,
      contactPerson: newSubForm.contactPerson || 'المدير التنفيذي',
      phone: newSubForm.phone || '+966 50 000 0000',
      trade: newSubForm.trade,
      contractDate: newSubForm.contractDate,
      scopeDescription: newSubForm.scopeDescription,
      status: 'active',
      totalSubcontractValueSar: 0,
      totalClientEquivalentValueSar: 0,
      totalExpectedProfitSar: 0,
      profitMarginPercent: 0,
      retentionPercent: Number(newSubForm.retentionPercent) || 10,
      items: [],
    };

    setSubcontracts([...subcontracts, newPkg]);
    setSelectedSubPkgId(newPkg.id);
    setShowAddSubModal(false);
  };

  // Add BOQ item to selected Subcontractor
  const handleAssignBoqItem = () => {
    if (!selectedSubPkg) return;
    const qty = Number(assignForm.assignedQuantity) || 1;
    const subRate = Number(assignForm.subcontractRateSar) || 0;
    const clientRate = Number(assignForm.clientRateSar) || 0;

    const subTotal = qty * subRate;
    const clientTotal = qty * clientRate;
    const marginSar = clientTotal - subTotal;
    const marginPct = clientTotal > 0 ? Number(((marginSar / clientTotal) * 100).toFixed(1)) : 0;

    const newItem: SubcontractBoqItem = {
      id: `SUB-ITM-${Date.now()}`,
      subcontractId: selectedSubPkg.id,
      boqCode: assignForm.boqCode,
      description: assignForm.description,
      unit: assignForm.unit,
      assignedQuantity: qty,
      subcontractRateSar: subRate,
      subcontractTotalSar: subTotal,
      clientRateSar: clientRate,
      clientTotalSar: clientTotal,
      expectedMarginSar: marginSar,
      expectedMarginPercent: marginPct,
      linkedActivityCode: assignForm.linkedActivityCode,
      executedQuantity: 0,
    };

    const updatedItems = [...selectedSubPkg.items, newItem];
    const newSubTotal = updatedItems.reduce((sum, i) => sum + i.subcontractTotalSar, 0);
    const newClientTotal = updatedItems.reduce((sum, i) => sum + i.clientTotalSar, 0);
    const newMargin = newClientTotal - newSubTotal;
    const newMarginPct = newClientTotal > 0 ? Number(((newMargin / newClientTotal) * 100).toFixed(1)) : 0;

    setSubcontracts((prev) =>
      prev.map((pkg) =>
        pkg.id === selectedSubPkg.id
          ? {
              ...pkg,
              items: updatedItems,
              totalSubcontractValueSar: newSubTotal,
              totalClientEquivalentValueSar: newClientTotal,
              totalExpectedProfitSar: newMargin,
              profitMarginPercent: newMarginPct,
            }
          : pkg
      )
    );

    setShowAssignBoqModal(false);
  };

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

  return (
    <div className="space-y-5 select-none">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="text-amber-500" size={24} />
            <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
              {lang === 'ar' ? 'المقايسة ومقايسات مقاولي الباطن (Project BOQ & Subcontracts)' : 'Project BOQ & Subcontract Packages'}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              Two-Tier Cost Control
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'إدارة جدول كميات المالك، وتخصيص مقايسات وبنود مقاولي الباطن وتحديد أسعار الشراء وهوامش ربح المقاول الرئيسي.'
              : 'Manage main contract BOQ and assign specific trade items, quantities, and buying rates to subcontractors.'}
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('main_boq')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'main_boq' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            <FileText size={14} />
            <span>{lang === 'ar' ? 'مقايسة المشروع مع المالك (Client BOQ)' : 'Main Client BOQ'}</span>
          </button>

          <button
            onClick={() => setActiveTab('subcontract_boq')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              activeTab === 'subcontract_boq' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Building size={14} />
            <span>{lang === 'ar' ? 'سجل ومقايسات مقاولي الباطن (Subcontract BOQs)' : 'Subcontract BOQ Packages'}</span>
          </button>
        </div>
      </div>

      {/* TAB 1: MAIN CLIENT BOQ */}
      {activeTab === 'main_boq' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-slate-200">
            <div className="flex flex-1 items-center gap-2">
              <div className="relative flex-1 max-w-md">
                <Search size={16} className="absolute right-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="بحث في بنود المقايسة بالكود أو الوصف..."
                  className="w-full pr-9 pl-3 py-1.5 border border-slate-300 rounded-lg text-xs outline-none focus:ring-2 focus:ring-amber-500 font-medium"
                />
              </div>

              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white font-semibold"
              >
                <option value="">كافة التصنيفات</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>

            <button
              onClick={exportCsv}
              className="flex items-center gap-1.5 bg-slate-100 text-slate-700 px-3.5 py-1.5 rounded-lg hover:bg-slate-200 transition-colors text-xs font-bold cursor-pointer"
            >
              <Download size={14} />
              تصدير CSV
            </button>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                  <tr>
                    <th className="p-3 text-right">الكود</th>
                    <th className="p-3 text-right">وصف بند الأعمال التعاقدي</th>
                    <th className="p-3 text-center">الوحدة</th>
                    <th className="p-3 text-center">الكمية التعاقدية</th>
                    <th className="p-3 text-right">سعر الوحدة للمالك (SAR)</th>
                    <th className="p-3 text-right">إجمالي البند للمالك (SAR)</th>
                    <th className="p-3 text-center">التصنيف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredItems.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-mono font-bold text-slate-800">{item.code}</td>
                      <td className="p-3 text-slate-800 font-medium max-w-md">{item.description}</td>
                      <td className="p-3 text-center font-mono text-slate-500">{item.unit}</td>
                      <td className="p-3 text-center font-mono font-bold text-slate-800">{item.quantity.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono text-slate-700">{item.unit_price.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono font-black text-emerald-700">{item.total_price.toLocaleString()}</td>
                      <td className="p-3 text-center">
                        {item.category && (
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[10px] font-semibold border border-slate-200">
                            {item.category}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-black text-slate-900 border-t">
                  <tr>
                    <td colSpan={3} className="p-3 text-left">الإجمالي ({filteredItems.length} بند):</td>
                    <td className="p-3 text-center font-mono">{totalQty.toLocaleString()}</td>
                    <td></td>
                    <td className="p-3 text-right font-mono text-emerald-800 text-sm">{totalValue.toLocaleString()} SAR</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: SUBCONTRACTOR PACKAGES & SUBCONTRACT BOQs */}
      {activeTab === 'subcontract_boq' && (
        <div className="space-y-5">
          {/* Executive Subcontracts Summary KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">عدد حزم مقاولي الباطن</span>
              <div className="text-xl font-black text-slate-900">{subcontracts.length} مقاولين معتمدين</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي التزامات الباطن (شراء)</span>
              <div className="text-xl font-black text-amber-900 font-mono">{totalSubcontractsValue.toLocaleString()} SAR</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إيراد المالك المقابل (بيع)</span>
              <div className="text-xl font-black text-blue-900 font-mono">{totalClientEquivalentValue.toLocaleString()} SAR</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-400 block mb-1">إجمالي وفر وهامش ربح المقاول</span>
              <div className="text-xl font-black text-emerald-700 font-mono">+{totalExpectedProfit.toLocaleString()} SAR</div>
              <span className="text-[10px] text-emerald-600 font-bold">متوسط الهامش: {overallMarginPercent}%</span>
            </div>
          </div>

          {/* Subcontractor Selector Bar + Add Subcontractor Button */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-slate-200">
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {subcontracts.map((pkg) => (
                <button
                  key={pkg.id}
                  onClick={() => setSelectedSubPkgId(pkg.id)}
                  className={`flex-shrink-0 px-4 py-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                    selectedSubPkgId === pkg.id
                      ? 'bg-slate-900 text-amber-400 border-slate-900 shadow-sm'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex flex-col text-right">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-amber-400">{pkg.subcontractNumber}</span>
                      <span className="text-[10px] text-slate-400">({pkg.items.length} بنود)</span>
                    </div>
                    <span className="text-[11px] text-slate-300 font-medium truncate max-w-xs">{pkg.subcontractorName}</span>
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowAddSubModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-black transition-all shadow-sm cursor-pointer flex-shrink-0"
            >
              <Plus size={15} />
              <span>إضافة مقاول باطن جديد</span>
            </button>
          </div>

          {/* Active Subcontractor Detailed Profile & BOQ Items Matrix */}
          {selectedSubPkg && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6">
              {/* Dossier Header */}
              <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-black bg-slate-900 text-amber-400 px-2.5 py-0.5 rounded">
                      {selectedSubPkg.subcontractNumber}
                    </span>
                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                      ساري ونشط بالموقع
                    </span>
                  </div>
                  <h2 className="text-lg font-black text-slate-900">{selectedSubPkg.subcontractorName}</h2>
                  <p className="text-xs text-slate-500 font-semibold">{selectedSubPkg.trade}</p>
                </div>

                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <div className="flex items-center gap-1.5 text-slate-600">
                    <User size={14} className="text-slate-400" />
                    <span>المسؤول: <strong className="text-slate-800">{selectedSubPkg.contactPerson}</strong></span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-600">
                    <Phone size={14} className="text-slate-400" />
                    <span className="font-mono text-slate-800">{selectedSubPkg.phone}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-600">
                    <Shield size={14} className="text-amber-600" />
                    <span>محتجز الضمان: <strong className="text-amber-800 font-mono">%{selectedSubPkg.retentionPercent}</strong></span>
                  </div>
                </div>
              </div>

              {/* Scope Description Box */}
              <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-700 space-y-1">
                <span className="font-bold text-slate-900 block">نطاق الأعمال المسند لمقاول الباطن (Scope of Work):</span>
                <p className="text-[11px] text-slate-600 leading-relaxed">{selectedSubPkg.scopeDescription || 'تنفيذ بنود الأعمال الخرسانية والإنشائية المحددة بالمقايسة وفق الشروط والمواصفات الفنية.'}</p>
              </div>

              {/* Subcontract Financial Breakdown Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="p-4 bg-amber-50/70 border border-amber-200 rounded-xl">
                  <span className="text-[11px] text-amber-900 font-bold block mb-1">إجمالي قيمة مقايسة الباطن (التكلفة)</span>
                  <div className="text-xl font-black text-amber-950 font-mono">
                    {selectedSubPkg.totalSubcontractValueSar.toLocaleString()} SAR
                  </div>
                  <span className="text-[10px] text-amber-800">سعر الشراء المتفق عليه بعقد الباطن</span>
                </div>

                <div className="p-4 bg-blue-50/70 border border-blue-200 rounded-xl">
                  <span className="text-[11px] text-blue-900 font-bold block mb-1">إيراد المقاول الرئيسي لنفس البنود (البيع)</span>
                  <div className="text-xl font-black text-blue-950 font-mono">
                    {selectedSubPkg.totalClientEquivalentValueSar.toLocaleString()} SAR
                  </div>
                  <span className="text-[10px] text-blue-800">سعر البيع المعتمد بمقايسة المالك</span>
                </div>

                <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-xl">
                  <span className="text-[11px] text-emerald-900 font-bold block mb-1">صافي هامش الربح المستهدف (Gross Margin)</span>
                  <div className="text-xl font-black text-emerald-700 font-mono">
                    +{selectedSubPkg.totalExpectedProfitSar.toLocaleString()} SAR
                  </div>
                  <span className="text-[10px] text-emerald-700 font-bold">نسبة الربح: %{selectedSubPkg.profitMarginPercent}</span>
                </div>
              </div>

              {/* Subcontract Assigned BOQ Items Table */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-slate-900 text-xs flex items-center gap-2">
                    <Layers size={15} className="text-amber-500" />
                    <span>جدول بنود المقايسة المسندة لمقاول الباطن وأسعار الشراء والبيع</span>
                  </h3>

                  <button
                    onClick={() => setShowAssignBoqModal(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-amber-400 text-xs font-bold cursor-pointer"
                  >
                    <Plus size={13} />
                    <span>إسناد بند جديد للباطن</span>
                  </button>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-700 border-b font-bold">
                      <tr>
                        <th className="p-3 text-right">كود البند</th>
                        <th className="p-3 text-right">بيان الأعمال المسندة للباطن</th>
                        <th className="p-3 text-center">الوحدة</th>
                        <th className="p-3 text-center">الكمية المسندة</th>
                        <th className="p-3 text-center bg-amber-50 text-amber-900 border-x border-amber-200">سعر شراء الباطن</th>
                        <th className="p-3 text-right bg-amber-50 text-amber-900">إجمالي عقد الباطن</th>
                        <th className="p-3 text-center bg-blue-50 text-blue-900 border-x border-blue-200">سعر بيع المالك</th>
                        <th className="p-3 text-right bg-blue-50 text-blue-900">إيراد المقاول الرئيسي</th>
                        <th className="p-3 text-right bg-emerald-50 text-emerald-900">هامش الربح (SAR)</th>
                        <th className="p-3 text-center">النشاط المرتبط (CPM)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium">
                      {selectedSubPkg.items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="p-3 font-mono font-bold text-slate-800">{item.boqCode}</td>
                          <td className="p-3 text-slate-800 max-w-xs">{item.description}</td>
                          <td className="p-3 text-center text-slate-500 font-mono">{item.unit}</td>
                          <td className="p-3 text-center font-mono font-bold text-slate-900">{item.assignedQuantity.toLocaleString()}</td>
                          <td className="p-3 text-center font-mono font-bold text-amber-800 bg-amber-50/40 border-x border-amber-100">
                            {item.subcontractRateSar.toLocaleString()} ر.س
                          </td>
                          <td className="p-3 text-right font-mono font-black text-amber-950 bg-amber-50/40">
                            {item.subcontractTotalSar.toLocaleString()} ر.س
                          </td>
                          <td className="p-3 text-center font-mono font-bold text-blue-800 bg-blue-50/40 border-x border-blue-100">
                            {item.clientRateSar.toLocaleString()} ر.س
                          </td>
                          <td className="p-3 text-right font-mono font-black text-blue-950 bg-blue-50/40">
                            {item.clientTotalSar.toLocaleString()} ر.س
                          </td>
                          <td className="p-3 text-right font-mono font-black text-emerald-700 bg-emerald-50/40">
                            +{item.expectedMarginSar.toLocaleString()} ر.س (%{item.expectedMarginPercent})
                          </td>
                          <td className="p-3 text-center">
                            <span className="font-mono text-[10px] bg-slate-100 px-2 py-0.5 rounded font-bold text-slate-700">
                              {item.linkedActivityCode || 'ACT-01'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-50 font-black text-slate-900 border-t">
                      <tr>
                        <td colSpan={4} className="p-3 text-left">الإجمالي لحزمة الباطن:</td>
                        <td></td>
                        <td className="p-3 text-right font-mono text-amber-900 font-bold">{selectedSubPkg.totalSubcontractValueSar.toLocaleString()} ر.س</td>
                        <td></td>
                        <td className="p-3 text-right font-mono text-blue-900 font-bold">{selectedSubPkg.totalClientEquivalentValueSar.toLocaleString()} ر.س</td>
                        <td className="p-3 text-right font-mono text-emerald-800 font-black">+{selectedSubPkg.totalExpectedProfitSar.toLocaleString()} ر.س</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal 1: Add New Subcontractor Package */}
      {showAddSubModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              إضافة مقاول باطن وتجهيز حزمة المقايسة
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">رقم اتفاقية الباطن</label>
                  <input
                    type="text"
                    value={newSubForm.subcontractNumber}
                    onChange={(e) => setNewSubForm({ ...newSubForm, subcontractNumber: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">تاريخ الاتفاقية</label>
                  <input
                    type="date"
                    value={newSubForm.contractDate}
                    onChange={(e) => setNewSubForm({ ...newSubForm, contractDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">اسم شركة / مؤسسة مقاول الباطن</label>
                <input
                  type="text"
                  placeholder="مثال: شركة الإنشاءات التخصصية للخرسانات"
                  value={newSubForm.subcontractorName}
                  onChange={(e) => setNewSubForm({ ...newSubForm, subcontractorName: e.target.value })}
                  className="w-full p-2 border rounded-lg font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">المهندس المسؤول / جهة الاتصال</label>
                  <input
                    type="text"
                    placeholder="م. خالد العتيبي"
                    value={newSubForm.contactPerson}
                    onChange={(e) => setNewSubForm({ ...newSubForm, contactPerson: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">رقم الهاتف والتواصل</label>
                  <input
                    type="text"
                    placeholder="+966 50 000 0000"
                    value={newSubForm.phone}
                    onChange={(e) => setNewSubForm({ ...newSubForm, phone: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">التخصص والمهنة</label>
                  <input
                    type="text"
                    value={newSubForm.trade}
                    onChange={(e) => setNewSubForm({ ...newSubForm, trade: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">نسبة محتجز الضمان (%)</label>
                  <input
                    type="number"
                    value={newSubForm.retentionPercent}
                    onChange={(e) => setNewSubForm({ ...newSubForm, retentionPercent: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">وصف نطاق الأعمال المسند (Scope)</label>
                <textarea
                  rows={2}
                  value={newSubForm.scopeDescription}
                  onChange={(e) => setNewSubForm({ ...newSubForm, scopeDescription: e.target.value })}
                  placeholder="حدد نطاق وحدود المسؤولية الفنية والتنفيذية..."
                  className="w-full p-2 border rounded-lg resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAddSubModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleCreateSubcontractor}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                إنشاء وتجهيز المقاول
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Assign BOQ Item to Subcontractor */}
      {showAssignBoqModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              إسناد بند مقايسة وتحديد سعر شراء مقاول الباطن
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">كود البند</label>
                  <input
                    type="text"
                    value={assignForm.boqCode}
                    onChange={(e) => setAssignForm({ ...assignForm, boqCode: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">النشاط المرتبط في CPM</label>
                  <input
                    type="text"
                    value={assignForm.linkedActivityCode}
                    onChange={(e) => setAssignForm({ ...assignForm, linkedActivityCode: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold text-blue-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">بيان ووصف البند</label>
                <input
                  type="text"
                  value={assignForm.description}
                  onChange={(e) => setAssignForm({ ...assignForm, description: e.target.value })}
                  className="w-full p-2 border rounded-lg font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">الوحدة</label>
                  <input
                    type="text"
                    value={assignForm.unit}
                    onChange={(e) => setAssignForm({ ...assignForm, unit: e.target.value })}
                    className="w-full p-2 border rounded-lg text-center"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">الكمية المسندة للباطن</label>
                  <input
                    type="number"
                    value={assignForm.assignedQuantity}
                    onChange={(e) => setAssignForm({ ...assignForm, assignedQuantity: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                <div>
                  <label className="block text-amber-900 font-bold mb-1">سعر شراء الباطن (SAR)</label>
                  <input
                    type="number"
                    value={assignForm.subcontractRateSar}
                    onChange={(e) => setAssignForm({ ...assignForm, subcontractRateSar: Number(e.target.value) })}
                    className="w-full p-2 border border-amber-300 rounded-lg font-mono font-bold text-amber-950 bg-white"
                  />
                  <span className="text-[10px] text-amber-800">التكلفة على المقاول الرئيسي</span>
                </div>
                <div>
                  <label className="block text-blue-900 font-bold mb-1">سعر بيع المالك (SAR)</label>
                  <input
                    type="number"
                    value={assignForm.clientRateSar}
                    onChange={(e) => setAssignForm({ ...assignForm, clientRateSar: Number(e.target.value) })}
                    className="w-full p-2 border border-blue-300 rounded-lg font-mono font-bold text-blue-950 bg-white"
                  />
                  <span className="text-[10px] text-blue-800">سعر العقد الأصلي مع العميل</span>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAssignBoqModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={handleAssignBoqItem}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-amber-400 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                إسناد البند وحساب الهامش
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

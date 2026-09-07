import { useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { parseBoqFile, categorizeBoqItem } from '@/lib/boqParser';
import { generateSchedule } from '@/lib/scheduleGenerator';
import type { ParsedBoqRow, Project } from '@/types';
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle, Loader, Building2 } from 'lucide-react';

interface ImportViewProps {
  onProjectCreated: (project: Project) => void;
}

export default function ImportView({ onProjectCreated }: ImportViewProps) {
  const [step, setStep] = useState<'info' | 'upload' | 'analyzing' | 'done'>('info');
  const [projectInfo, setProjectInfo] = useState({
    name: '',
    client: '',
    location: '',
    contract_value: '',
    start_date: new Date().toISOString().split('T')[0],
    description: '',
  });
  const [boqFile, setBoqFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedBoqRow[]>([]);
  const [error, setError] = useState('');
  const [parseProgress, setParseProgress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBoqFile(file);
    setError('');
    try {
      setParseProgress('جاري قراءة الملف...');
      const rows = await parseBoqFile(file);
      if (rows.length === 0) {
        setError('لم يتم العثور على بنود صالحة في الملف. تأكد من وجود أعمدة للكود والوصف والكمية والسعر');
        return;
      }
      // Auto-categorize
      for (const row of rows) {
        if (!row.category) row.category = categorizeBoqItem(row.description);
      }
      setParsedRows(rows);
      setParseProgress(`تم تحليل ${rows.length} بند بنجاح`);
    } catch {
      setError('حدث خطأ أثناء قراءة الملف. تأكد من صيغة الملف (Excel أو CSV)');
    }
  }

  async function handleImport() {
    if (!projectInfo.name || !projectInfo.start_date) {
      setError('الرجاء إدخال اسم المشروع وتاريخ البداية');
      return;
    }
    if (parsedRows.length === 0) {
      setError('الرجاء استيراد ملف المقايسة أولاً');
      return;
    }

    setStep('analyzing');
    setError('');

    try {
      // 1. Create project
      const totalValue = parsedRows.reduce((sum, r) => sum + r.total_price, 0);
      const { data: projectData, error: projectErr } = await supabase
        .from('projects')
        .insert({
          name: projectInfo.name,
          client: projectInfo.client || null,
          location: projectInfo.location || null,
          contract_value: parseFloat(projectInfo.contract_value) || totalValue,
          currency: 'SAR',
          start_date: projectInfo.start_date,
          status: 'planning',
          description: projectInfo.description || null,
        })
        .select()
        .single();

      if (projectErr || !projectData) throw new Error('فشل إنشاء المشروع');
      const project = projectData as Project;

      // 2. Insert BOQ items
      setParseProgress('جاري حفظ بنود المقايسة...');
      const boqInserts = parsedRows.map((row, i) => ({
        project_id: project.id,
        code: row.code,
        description: row.description,
        unit: row.unit,
        quantity: row.quantity,
        unit_price: row.unit_price,
        total_price: row.total_price,
        category: row.category,
        section: row.section,
        sort_order: i,
      }));
      const { error: boqErr } = await supabase
        .from('boq_items')
        .insert(boqInserts)
        .select();
      if (boqErr) throw new Error('فشل حفظ بنود المقايسة');

      // 3. Generate schedule
      setParseProgress('جاري إنشاء WBS والجدول الزمني...');
      const { data: productivityData, error: productivityError } = await supabase
        .from('productivity_rates')
        .select('category, daily_output, crew_size, difficulty_factor');
      if (productivityError) throw new Error(`فشل تحميل معدلات الإنتاجية: ${productivityError.message}`);
      const schedule = generateSchedule(parsedRows, projectInfo.start_date, productivityData || []);

      // 4. Insert WBS nodes
      const wbsInserts = schedule.wbsNodes.map((w) => ({
        project_id: project.id,
        parent_id: null,
        code: w.code,
        name: w.name,
        level: w.level,
        sort_order: w.sort_order,
      }));
      const { data: wbsData, error: wbsErr } = await supabase
        .from('wbs_nodes')
        .insert(wbsInserts)
        .select();
      if (wbsErr) throw new Error('فشل إنشاء WBS');

      // Map codes to IDs
      const wbsCodeToId: Record<string, string> = {};
      for (const w of wbsData || []) {
        wbsCodeToId[w.code] = w.id;
      }
      // Set parent IDs
      for (const w of wbsData || []) {
        const genWbs = schedule.wbsNodes.find((gw) => gw.code === w.code);
        if (genWbs?.parent_code) {
          await supabase.from('wbs_nodes').update({ parent_id: wbsCodeToId[genWbs.parent_code] }).eq('id', w.id);
        }
      }

      // 5. Insert activities
      setParseProgress('جاري إنشاء الأنشطة والتبعيات...');
      const actInserts = schedule.activities.map((a) => ({
        project_id: project.id,
        wbs_node_id: a.wbs_node_code ? wbsCodeToId[a.wbs_node_code] || null : null,
        code: a.code,
        name: a.name,
        early_start: a.early_start,
        early_finish: a.early_finish,
        late_start: a.late_start,
        late_finish: a.late_finish,
        duration_days: a.duration_days,
        planned_quantity: a.planned_quantity,
        actual_quantity: 0,
        unit: a.unit,
        percent_complete: 0,
        is_critical: a.is_critical,
        is_milestone: a.is_milestone,
        actual_start: null,
        actual_finish: null,
        sort_order: a.sort_order,
      }));
      const { data: actData, error: actErr } = await supabase
        .from('activities')
        .insert(actInserts)
        .select();
      if (actErr) throw new Error('فشل إنشاء الأنشطة');

      const actCodeToId: Record<string, string> = {};
      for (const a of actData || []) {
        actCodeToId[a.code] = a.id;
      }

      // Save the generated plan as an immutable initial baseline.
      const { data: baselineData, error: baselineErr } = await supabase
        .from('project_baselines')
        .insert({
          project_id: project.id,
          version: 1,
          name: 'Initial Baseline',
          status: 'approved',
          approved_at: new Date().toISOString(),
          is_active: true,
        })
        .select()
        .single();
      if (baselineErr || !baselineData) throw new Error('فشل إنشاء خط الأساس');

      const baselineActivities = (schedule.activities || [])
        .map((activity) => ({
          baseline_id: baselineData.id,
          activity_id: actCodeToId[activity.code],
          early_start: activity.early_start,
          early_finish: activity.early_finish,
          duration_days: activity.duration_days,
          planned_cost: schedule.budgetLines.find((line) => line.description === activity.name)?.planned_cost || 0,
        }))
        .filter((activity) => Boolean(activity.activity_id));
      const { error: baselineActivitiesErr } = await supabase
        .from('baseline_activities')
        .insert(baselineActivities);
      if (baselineActivitiesErr) throw new Error('فشل حفظ أنشطة خط الأساس');

      // 6. Insert links
      const linkInserts = schedule.links.map((l) => ({
        project_id: project.id,
        predecessor_id: actCodeToId[l.predecessor_code],
        successor_id: actCodeToId[l.successor_code],
        link_type: l.link_type,
        lag_days: l.lag_days,
      }));
      await supabase.from('activity_links').insert(linkInserts);

      // 7. Insert resources
      setParseProgress('جاري تخصيص الموارد...');
      const resInserts = schedule.resources.map((r) => ({
        project_id: project.id,
        name: r.name,
        type: r.type,
        unit: r.unit,
        unit_rate: r.unit_rate,
        availability: r.availability,
      }));
      const { data: resData, error: resErr } = await supabase
        .from('resources')
        .insert(resInserts)
        .select();
      if (resErr) throw new Error('فشل إنشاء الموارد');

      const resCodeToId: Record<string, string> = {};
      for (const r of resData || []) {
        const genRes = schedule.resources.find((gr) => gr.name === r.name);
        if (genRes) resCodeToId[genRes.code] = r.id;
      }

      // 8. Insert activity resources
      const arInserts = schedule.activityResources.map((ar) => ({
        activity_id: actCodeToId[ar.activityCode],
        resource_id: resCodeToId[ar.resourceCode],
        project_id: project.id,
        planned_quantity: ar.planned_quantity,
        actual_quantity: 0,
      }));
      await supabase.from('activity_resources').insert(arInserts);

      // 9. Insert budget lines
      setParseProgress('جاري إنشاء الميزانية...');
      const budgetInserts = schedule.budgetLines.map((b) => ({
        project_id: project.id,
        activity_id: actCodeToId[schedule.activities.find((activity) => activity.name === b.description)?.code || ''] || null,
        wbs_node_id: b.wbs_node_code ? wbsCodeToId[b.wbs_node_code] || null : null,
        description: b.description,
        planned_cost: b.planned_cost,
        committed_cost: b.committed_cost,
        actual_cost: 0,
        remaining_cost: b.remaining_cost,
      }));
      await supabase.from('budget_lines').insert(budgetInserts);

      // 10. Update project end date and duration
      const lastActivity = schedule.activities[schedule.activities.length - 1];
      const totalDays = Math.round(
        (new Date(lastActivity.early_finish).getTime() - new Date(projectInfo.start_date).getTime()) / (1000 * 60 * 60 * 24)
      );
      await supabase.from('projects').update({
        end_date: lastActivity.early_finish,
        duration_days: totalDays,
        status: 'active',
      }).eq('id', project.id);

      setStep('done');
      onProjectCreated({ ...project, end_date: lastActivity.early_finish, duration_days: totalDays, status: 'active' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ غير متوقع');
      setStep('upload');
    }
  }

  if (step === 'analyzing') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <Loader size={48} className="text-amber-500 animate-spin mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-slate-800 mb-2">جاري التحليل والمعالجة</h3>
          <p className="text-sm text-slate-500">{parseProgress}</p>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle size={40} className="text-emerald-600" />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">تم إنشاء المشروع بنجاح!</h3>
          <p className="text-sm text-slate-500 mb-6">تم إنشاء الجدول الزمني و WBS والموارد والميزانية تلقائياً</p>
        </div>
      </div>
    );
  }

  const totalValue = parsedRows.reduce((sum, r) => sum + r.total_price, 0);
  const categories = [...new Set(parsedRows.map((r) => r.category))].filter(Boolean);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">استيراد مشروع جديد</h1>
        <p className="text-sm text-slate-500">أدخل بيانات المشروع واستورد ملف المقايسة (Excel أو CSV) وسيقوم النظام بإنشاء الجدول الزمني و WBS والموارد والميزانية تلقائياً</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      )}

      {/* Step 1: Project Info */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 bg-amber-500 text-slate-900 rounded-full flex items-center justify-center font-bold text-sm">1</div>
          <h3 className="font-semibold text-slate-800">بيانات المشروع</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">اسم المشروع *</label>
            <input
              type="text"
              value={projectInfo.name}
              onChange={(e) => setProjectInfo({ ...projectInfo, name: e.target.value })}
              placeholder="مثال: إنشاء مبنى سكني"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">العميل</label>
            <input
              type="text"
              value={projectInfo.client}
              onChange={(e) => setProjectInfo({ ...projectInfo, client: e.target.value })}
              placeholder="اسم العميل"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">الموقع</label>
            <input
              type="text"
              value={projectInfo.location}
              onChange={(e) => setProjectInfo({ ...projectInfo, location: e.target.value })}
              placeholder="الرياض، السعودية"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">قيمة العقد (ريال)</label>
            <input
              type="number"
              value={projectInfo.contract_value}
              onChange={(e) => setProjectInfo({ ...projectInfo, contract_value: e.target.value })}
              placeholder="يُحسب تلقائياً من المقايسة إذا تُرك فارغاً"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">تاريخ بداية المشروع *</label>
            <input
              type="date"
              value={projectInfo.start_date}
              onChange={(e) => setProjectInfo({ ...projectInfo, start_date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">الوصف</label>
            <input
              type="text"
              value={projectInfo.description}
              onChange={(e) => setProjectInfo({ ...projectInfo, description: e.target.value })}
              placeholder="وصف مختصر للمشروع"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none"
            />
          </div>
        </div>
      </div>

      {/* Step 2: Upload BOQ */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 bg-amber-500 text-slate-900 rounded-full flex items-center justify-center font-bold text-sm">2</div>
          <h3 className="font-semibold text-slate-800">استيراد جدول الكميات (المقايسة)</h3>
        </div>

        <div
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-amber-500 hover:bg-amber-50/50 transition-all"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,.txt"
            onChange={handleFileSelect}
            className="hidden"
          />
          {boqFile ? (
            <div className="flex items-center justify-center gap-3">
              <FileSpreadsheet size={32} className="text-emerald-500" />
              <div className="text-right">
                <p className="font-medium text-slate-700">{boqFile.name}</p>
                <p className="text-sm text-slate-400">{parseProgress}</p>
              </div>
            </div>
          ) : (
            <div>
              <Upload size={32} className="text-slate-400 mx-auto mb-2" />
              <p className="text-sm text-slate-500">اضغط لاختيار ملف Excel أو CSV</p>
              <p className="text-xs text-slate-400 mt-1">الأعمدة المطلوبة: كود البند، الوصف، الوحدة، الكمية، سعر الوحدة</p>
            </div>
          )}
        </div>

        {/* Preview */}
        {parsedRows.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-slate-600">معاينة البنود المستوردة ({parsedRows.length} بند)</p>
              <p className="text-sm font-bold text-amber-600">الإجمالي: {totalValue.toLocaleString()} ريال</p>
            </div>

            {/* Category chips */}
            {categories.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {categories.map((cat) => (
                  <span key={cat} className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs">
                    {cat} ({parsedRows.filter((r) => r.category === cat).length})
                  </span>
                ))}
              </div>
            )}

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-right p-2 font-medium">الكود</th>
                    <th className="text-right p-2 font-medium">الوصف</th>
                    <th className="text-right p-2 font-medium">الوحدة</th>
                    <th className="text-right p-2 font-medium">الكمية</th>
                    <th className="text-right p-2 font-medium">سعر الوحدة</th>
                    <th className="text-right p-2 font-medium">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {parsedRows.slice(0, 10).map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="p-2 text-slate-500">{row.code}</td>
                      <td className="p-2 text-slate-700 max-w-xs truncate">{row.description}</td>
                      <td className="p-2 text-slate-500">{row.unit}</td>
                      <td className="p-2 text-slate-700">{row.quantity.toLocaleString()}</td>
                      <td className="p-2 text-slate-700">{row.unit_price.toLocaleString()}</td>
                      <td className="p-2 font-medium text-slate-800">{row.total_price.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsedRows.length > 10 && (
                <p className="text-center text-xs text-slate-400 p-2">و {parsedRows.length - 10} بند آخر...</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Submit */}
      <div className="flex justify-end">
        <button
          onClick={handleImport}
          disabled={!projectInfo.name || parsedRows.length === 0}
          className="flex items-center gap-2 bg-amber-500 text-slate-900 px-6 py-3 rounded-lg font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Building2 size={20} />
          إنشاء المشروع والجدول الزمني
        </button>
      </div>
    </div>
  );
}

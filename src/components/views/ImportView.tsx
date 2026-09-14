import { useState, useRef, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { parseBoqFile, categorizeBoqItem } from '@/lib/boqParser';
import { generateSchedule } from '@/lib/scheduleGenerator';
import { parseXerContent, type ParsedXerResult } from '@/lib/xerImporter';
import { buildXerImportPlan, persistXerImportPlan, type ReconReport, type XerImportPlan } from '@/lib/xerImportService';
import type { ParsedBoqRow, Project } from '@/types';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  Loader,
  Building2,
  Layers,
  Database,
  ArrowRight,
} from 'lucide-react';

interface ImportViewProps {
  onProjectCreated: (project: Project) => void;
}

type ImportSource = 'boq' | 'xer';

export default function ImportView({ onProjectCreated }: ImportViewProps) {
  const [importSource, setImportSource] = useState<ImportSource>('boq');
  const [step, setStep] = useState<'info' | 'analyzing' | 'done'>('info');

  // BOQ form state
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

  // XER state
  const [xerFile, setXerFile] = useState<File | null>(null);
  const [parsedXer, setParsedXer] = useState<ParsedXerResult | null>(null);
  const [xerDataDate, setXerDataDate] = useState('');
  const [xerCurrency, setXerCurrency] = useState('SAR');
  const [xerBaselineOptIn, setXerBaselineOptIn] = useState(false);
  const [finalRecon, setFinalRecon] = useState<ReconReport | null>(null);
  const [finalPlan, setFinalPlan] = useState<XerImportPlan | null>(null);

  const [error, setError] = useState('');
  const [parseProgress, setParseProgress] = useState('');

  function xerOptions() {
    return {
      projectName: projectInfo.name || parsedXer?.project?.shortName || '',
      client: projectInfo.client || null,
      location: projectInfo.location || null,
      contractValue: parseFloat(projectInfo.contract_value) || null,
      currency: xerCurrency || 'SAR',
      startDate: parsedXer?.project?.planStart || projectInfo.start_date || null,
      endDate: parsedXer?.project?.planEnd || null,
      dataDate: xerDataDate || parsedXer?.project?.dataDate || null,
      description: projectInfo.description || 'مستورد من ملف Primavera P6 (.xer)',
      createInitialBaseline: xerBaselineOptIn,
    };
  }

  const xerPlanPreview: { plan: XerImportPlan } | { planError: string } | null = useMemo(() => {
    if (!parsedXer) return null;
    try {
      return { plan: buildXerImportPlan(parsedXer, xerOptions()) };
    } catch (err) {
      return { planError: (err as Error).message || 'تعذر بناء خطة الاستيراد' };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedXer, projectInfo.name, projectInfo.client, projectInfo.location, projectInfo.contract_value, projectInfo.description, projectInfo.start_date, xerDataDate, xerCurrency, xerBaselineOptIn]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xerFileInputRef = useRef<HTMLInputElement>(null);

  async function handleBoqFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBoqFile(file);
    setError('');
    try {
      setParseProgress('جاري قراءة ملف المقايسة...');
      const rows = await parseBoqFile(file);
      if (rows.length === 0) {
        setError('لم يتم العثور على بنود صالحة في الملف. تأكد من وجود أعمدة للكود والوصف والكمية والسعر');
        return;
      }
      for (const row of rows) {
        if (!row.category) row.category = categorizeBoqItem(row.description);
      }
      setParsedRows(rows);
      setParseProgress(`تم تحليل ${rows.length} بند بنجاح`);
    } catch {
      setError('حدث خطأ أثناء قراءة الملف. تأكد من صيغة الملف (Excel أو CSV)');
    }
  }

  async function handleXerFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setXerFile(file);
    setError('');
    try {
      setParseProgress('جاري قراءة وتحليل ملف Primavera XER...');
      const text = await file.text();
      const result = parseXerContent(text);
      if (!result.project || result.activities.length === 0) {
        setError('لم يتم العثور على مشروع/أنشطة في ملف XER. تأكد من صلاحية الملف.');
        return;
      }
      setParsedXer(result);
      setFinalRecon(null);
      setFinalPlan(null);
      setXerBaselineOptIn(false);
      setXerDataDate(result.project.dataDate || '');
      setXerCurrency(result.header.currency || 'SAR');
      if (result.project.shortName && !projectInfo.name) {
        setProjectInfo((prev) => ({
          ...prev,
          name: result.project ? result.project.shortName : prev.name,
          start_date: result.project?.planStart || prev.start_date,
        }));
      }
      setParseProgress(`تم استخراج ${result.activities.length} نشاط و ${result.links.length} علاقة و ${result.wbs.length} عقدة WBS و ${result.calendars.length} تقويم`);
    } catch {
      setError('تعذر قراءة ملف XER. تأكد من أنه ملف نصي متوافق مع Primavera P6.');
    }
  }

  async function handleImportXer() {
    if (!parsedXer || parsedXer.activities.length === 0) {
      setError('الرجاء اختيار ملف XER صالح أولاً');
      return;
    }
    let plan: XerImportPlan;
    try {
      plan = buildXerImportPlan(parsedXer, xerOptions());
    } catch (err) {
      setError((err as Error).message || 'تعذر بناء خطة الاستيراد');
      return;
    }

    setStep('analyzing');
    setError('');
    setParseProgress('جاري حفظ المشروع والجدول الزمني...');

    let result: Awaited<ReturnType<typeof persistXerImportPlan>>;
    try {
      result = await persistXerImportPlan(supabase, plan);
    } catch (err) {
      setFinalPlan(plan);
      setFinalRecon(plan.recon);
      setError(`تعذر الاتصال بقاعدة البيانات: ${(err as Error).message}. لم يُحفظ أي مشروع — أعد المحاولة.`);
      setStep('info');
      return;
    }
    setFinalPlan(plan);
    setFinalRecon(plan.recon);
    if (!result.ok) {
      const cleanupNote = result.cleanedUp
        ? 'تم التراجع عن كل الصفوف الجزئية — لا يوجد مشروع نصف مستورد.'
        : `تعذر التنظيف الكامل: ${(result.cleanupErrors || []).join('؛ ')}`;
      setError(`فشل الاستيراد في خطوة (${result.failedStep}): ${result.error}. ${cleanupNote}`);
      setStep('info');
      return;
    }
    setStep('done');
  }

  async function handleImportBoq() {
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
          status: 'active',
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
      const { error: boqErr } = await supabase.from('boq_items').insert(boqInserts);
      if (boqErr) throw new Error('فشل حفظ بنود المقايسة');

      // 3. Generate schedule
      setParseProgress('جاري إنشاء WBS والجدول الزمني عبر محرك التخطيط...');
      const schedule = generateSchedule(parsedRows, projectInfo.start_date, [], project.calendar_type);

      // 4. Insert WBS nodes
      const wbsInserts = schedule.wbsNodes.map((w) => ({
        project_id: project.id,
        parent_id: null,
        code: w.code,
        name: w.name,
        level: w.level,
        sort_order: w.sort_order,
      }));
      const { data: wbsData, error: wbsErr } = await supabase.from('wbs_nodes').insert(wbsInserts).select();
      if (wbsErr) throw new Error('فشل إنشاء WBS');

      const wbsCodeToId: Record<string, string> = {};
      for (const w of wbsData || []) {
        wbsCodeToId[w.code] = w.id;
      }

      // 5. Insert activities
      setParseProgress('جاري إنشاء الأنشطة وشبكة CPM...');
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
        total_float: 0,
        free_float: 0,
        actual_start: null,
        actual_finish: null,
        sort_order: a.sort_order,
      }));
      const { data: actData, error: actErr } = await supabase.from('activities').insert(actInserts).select();
      if (actErr) throw new Error('فشل إنشاء الأنشطة');

      const actCodeToId: Record<string, string> = {};
      for (const a of actData || []) {
        actCodeToId[a.code] = a.id;
      }

      // 6. Create Baseline
      const { data: baselineData } = await supabase
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

      if (baselineData) {
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
        await supabase.from('baseline_activities').insert(baselineActivities);
      }

      // 7. Insert links
      const linkInserts = schedule.links.map((l) => ({
        project_id: project.id,
        predecessor_id: actCodeToId[l.predecessor_code],
        successor_id: actCodeToId[l.successor_code],
        link_type: l.link_type,
        lag_days: l.lag_days,
      }));
      await supabase.from('activity_links').insert(linkInserts);

      // 8. Update project dates
      const lastActivity = schedule.activities[schedule.activities.length - 1];
      const totalDays = Math.round(
        (new Date(lastActivity.early_finish).getTime() - new Date(projectInfo.start_date).getTime()) / (1000 * 60 * 60 * 24),
      );
      await supabase.from('projects').update({
        end_date: lastActivity.early_finish,
        duration_days: totalDays,
        status: 'active',
      }).eq('id', project.id);

      setStep('done');
      setTimeout(() => {
        onProjectCreated(project);
      }, 1000);
    } catch (err: any) {
      setError(err.message || 'حدث خطأ أثناء استيراد المقايسة');
      setStep('info');
    }
  }

  if (step === 'analyzing') {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center max-w-md p-8 bg-white rounded-2xl shadow-sm border border-slate-200">
          <Loader size={48} className="text-amber-500 animate-spin mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-slate-800 mb-2">جاري المعالجة وبناء شبكة المشروع</h3>
          <p className="text-sm text-slate-500">{parseProgress}</p>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    const loss = finalRecon?.hasLoss;
    return (
      <div className="flex items-start justify-center min-h-[50vh] py-8">
        <div className="w-full max-w-3xl text-center p-8 bg-white rounded-2xl shadow-sm border border-slate-200">
          <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 ${loss ? 'bg-amber-100' : 'bg-emerald-100'}`}>
            <CheckCircle size={40} className={loss ? 'text-amber-600' : 'text-emerald-600'} />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">
            {loss ? 'اكتمل الاستيراد مع ملاحظات موثقة' : 'اكتمل الاستيراد بنجاح'}
          </h3>
          <p className="text-sm text-slate-500 mb-4" dir="ltr">{finalRecon?.provenance.baseline}</p>
          {finalRecon && (
            <div className="text-right overflow-x-auto border border-slate-200 rounded-lg max-h-72 mb-4">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 sticky top-0">
                  <tr>
                    <th className="text-right p-2">البند</th>
                    <th className="text-right p-2">المصدر</th>
                    <th className="text-right p-2">المستورد</th>
                    <th className="text-right p-2">المسقط</th>
                    <th className="text-right p-2">غير مدعوم</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {finalRecon.sections.map((sec) => (
                    <tr key={sec.entity} className="hover:bg-slate-50">
                      <td className="p-2 text-slate-700 font-medium">{sec.entity}</td>
                      <td className="p-2 font-mono">{sec.source}</td>
                      <td className="p-2 font-mono text-emerald-700 font-bold">{sec.imported}</td>
                      <td className={`p-2 font-mono font-bold ${sec.dropped > 0 ? 'text-red-600' : 'text-slate-400'}`}>{sec.dropped}</td>
                      <td className={`p-2 font-mono font-bold ${sec.unsupported > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{sec.unsupported}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {finalRecon && finalRecon.droppedTotal + finalRecon.unsupportedTotal > 0 && (
            <div className="text-right max-h-56 overflow-y-auto border border-amber-200 bg-amber-50/50 rounded-lg p-3 mb-4 space-y-1">
              {finalRecon.droppedItems.map((d, i) => (
                <p key={`d${i}`} className="text-[11px] text-slate-700">
                  <span className="font-bold text-red-700">مسقط [{d.entity}]</span> <span className="font-mono">{d.code}</span> — {d.reason}
                </p>
              ))}
              {finalRecon.unsupportedItems.map((u, i) => (
                <p key={`u${i}`} className="text-[11px] text-slate-700">
                  <span className="font-bold text-amber-700">غير مدعوم [{u.entity}]</span> <span className="font-mono">{u.code}</span> — {u.reason}
                </p>
              ))}
              {(finalRecon.droppedTotal > finalRecon.droppedItems.length || finalRecon.unsupportedTotal > finalRecon.unsupportedItems.length) && (
                <p className="text-[11px] text-slate-500">+ بنود إضافية ({finalRecon.droppedTotal + finalRecon.unsupportedTotal} إجمالاً)</p>
              )}
            </div>
          )}
          <button
            onClick={() => {
              if (finalPlan) {
                onProjectCreated({ id: finalPlan.projectId, created_at: new Date().toISOString(), duration_days: null, ...finalPlan.projectRow } as unknown as Project);
              }
            }}
            className="inline-flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
          >
            الانتقال إلى المشروع
            <ArrowRight size={18} className="rotate-180" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">استيراد وبدء مشروع جديد</h1>
        <p className="text-sm text-slate-500">
          اختر مصدر الاستيراد: تحويل جدول كميات (BOQ Excel) إلى جدول زمني ذكي، أو استيراد ملف Primavera P6 (.xer) متكامل.
        </p>
      </div>

      {/* Mode Selector Tabs */}
      <div className="flex rounded-xl bg-slate-200/80 p-1 max-w-md">
        <button
          onClick={() => setImportSource('boq')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all ${
            importSource === 'boq' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <FileSpreadsheet size={18} className={importSource === 'boq' ? 'text-emerald-600' : ''} />
          مقايسة كميات (Excel/CSV)
        </button>
        <button
          onClick={() => setImportSource('xer')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all ${
            importSource === 'xer' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Database size={18} className={importSource === 'xer' ? 'text-blue-600' : ''} />
          ملف Primavera P6 (.xer)
        </button>
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
          <h3 className="font-semibold text-slate-800">بيانات المشروع الأساسية</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">اسم المشروع *</label>
            <input
              type="text"
              value={projectInfo.name}
              onChange={(e) => setProjectInfo({ ...projectInfo, name: e.target.value })}
              placeholder="مثال: إنشاء مجمع تجاري وسكني"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">العميل / المالك</label>
            <input
              type="text"
              value={projectInfo.client}
              onChange={(e) => setProjectInfo({ ...projectInfo, client: e.target.value })}
              placeholder="اسم المالك أو الجهة المستفيدة"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">الموقع الجغرافي</label>
            <input
              type="text"
              value={projectInfo.location}
              onChange={(e) => setProjectInfo({ ...projectInfo, location: e.target.value })}
              placeholder="الرياض - المملكة العربية السعودية"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">قيمة العقد (ريال)</label>
            <input
              type="number"
              value={projectInfo.contract_value}
              onChange={(e) => setProjectInfo({ ...projectInfo, contract_value: e.target.value })}
              placeholder="يُحسب تلقائياً إذا تُرك فارغاً"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">تاريخ بداية المشروع *</label>
            <input
              type="date"
              value={projectInfo.start_date}
              onChange={(e) => setProjectInfo({ ...projectInfo, start_date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">الوصف</label>
            <input
              type="text"
              value={projectInfo.description}
              onChange={(e) => setProjectInfo({ ...projectInfo, description: e.target.value })}
              placeholder="وصف ونطاق عمل المشروع"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"
            />
          </div>
        </div>
      </div>

      {/* Step 2: Upload Files based on mode */}
      {importSource === 'boq' ? (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-amber-500 text-slate-900 rounded-full flex items-center justify-center font-bold text-sm">2</div>
            <h3 className="font-semibold text-slate-800">استيراد جدول الكميات (BOQ)</h3>
          </div>

          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-emerald-500 hover:bg-emerald-50/40 transition-all"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,.txt"
              onChange={handleBoqFileSelect}
              className="hidden"
            />
            {boqFile ? (
              <div className="flex items-center justify-center gap-3">
                <FileSpreadsheet size={36} className="text-emerald-600" />
                <div className="text-right">
                  <p className="font-medium text-slate-800">{boqFile.name}</p>
                  <p className="text-xs text-emerald-600 font-semibold">{parseProgress}</p>
                </div>
              </div>
            ) : (
              <div>
                <Upload size={36} className="text-slate-400 mx-auto mb-2" />
                <p className="text-sm text-slate-600 font-medium">اضغط لاختيار ملف Excel أو CSV</p>
                <p className="text-xs text-slate-400 mt-1">يتعرف تلقائياً على الأعمدة: الكود، الوصف، الوحدة، الكمية، السعر</p>
              </div>
            )}
          </div>

          {parsedRows.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-slate-700">معاينة بنود المقايسة ({parsedRows.length} بند)</p>
                <p className="text-sm font-bold text-emerald-700">
                  الإجمالي: {parsedRows.reduce((s, r) => s + r.total_price, 0).toLocaleString()} ريال
                </p>
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-60">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600 sticky top-0">
                    <tr>
                      <th className="text-right p-2">الكود</th>
                      <th className="text-right p-2">الوصف</th>
                      <th className="text-right p-2">القسم</th>
                      <th className="text-right p-2">الكمية</th>
                      <th className="text-right p-2">السعر</th>
                      <th className="text-right p-2">الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {parsedRows.slice(0, 10).map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="p-2 font-mono text-slate-500">{r.code}</td>
                        <td className="p-2 text-slate-700 max-w-xs truncate">{r.description}</td>
                        <td className="p-2 text-slate-500">{r.category}</td>
                        <td className="p-2 font-medium">{r.quantity.toLocaleString()}</td>
                        <td className="p-2">{r.unit_price.toLocaleString()}</td>
                        <td className="p-2 font-bold text-slate-800">{r.total_price.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="mt-6 flex justify-end">
            <button
              onClick={handleImportBoq}
              disabled={!projectInfo.name || parsedRows.length === 0}
              className="flex items-center gap-2 bg-emerald-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50"
            >
              <Building2 size={20} />
              توليد الجدول الزمني الذكي والمشروع
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-sm">2</div>
            <h3 className="font-semibold text-slate-800">استيراد ملف Primavera P6 (.xer)</h3>
          </div>

          <div
            onClick={() => xerFileInputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50/40 transition-all"
          >
            <input
              ref={xerFileInputRef}
              type="file"
              accept=".xer,.txt"
              onChange={handleXerFileSelect}
              className="hidden"
            />
            {xerFile ? (
              <div className="flex items-center justify-center gap-3">
                <Database size={36} className="text-blue-600" />
                <div className="text-right">
                  <p className="font-medium text-slate-800">{xerFile.name}</p>
                  <p className="text-xs text-blue-600 font-semibold">{parseProgress}</p>
                </div>
              </div>
            ) : (
              <div>
                <Upload size={36} className="text-slate-400 mx-auto mb-2" />
                <p className="text-sm text-slate-600 font-medium">اضغط لاختيار ملف Primavera P6 (.xer)</p>
                <p className="text-xs text-slate-400 mt-1">يستخرج تلقائياً هيكل WBS، الأنشطة، العلاقات (Links)، الموارد، والتواريخ</p>
              </div>
            )}
          </div>

          {parsedXer && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-slate-500 block">عدد الأنشطة</span>
                  <span className="font-bold text-slate-800 text-sm">{parsedXer.activities.length}</span>
                </div>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-slate-500 block">العلاقات (Links)</span>
                  <span className="font-bold text-blue-700 text-sm">{parsedXer.links.length}</span>
                </div>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-slate-500 block">عقد WBS</span>
                  <span className="font-bold text-emerald-700 text-sm">{parsedXer.wbs.length}</span>
                </div>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-slate-500 block">التقويمات</span>
                  <span className="font-bold text-indigo-700 text-sm">{parsedXer.calendars.length}</span>
                </div>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-slate-500 block">الموارد / التخصيصات</span>
                  <span className="font-bold text-amber-700 text-sm">{parsedXer.resources.length} / {parsedXer.assignments.length}</span>
                </div>
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-slate-500 block">خط الأساس</span>
                  <span className={`font-bold text-sm ${parsedXer.baseline.status === 'available' ? 'text-emerald-700' : 'text-slate-500'}`}>
                    {parsedXer.baseline.status === 'available' ? `P6 (${parsedXer.baseline.tasks.length})` : 'No Baseline Imported'}
                  </span>
                </div>
              </div>

              {/* XER options: Data Date / currency provenance + explicit baseline opt-in */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 mb-1">Data Date {parsedXer.project?.dataDate ? '(من الملف)' : '(غير موجود في الملف)'}</label>
                  <input
                    type="date"
                    value={xerDataDate}
                    onChange={(e) => setXerDataDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 mb-1">العملة {parsedXer.header.currency ? `(من الملف: ${parsedXer.header.currency})` : '(الإعداد الحالي)'}</label>
                  <input
                    type="text"
                    value={xerCurrency}
                    onChange={(e) => setXerCurrency(e.target.value.toUpperCase().slice(0, 3))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div className="flex items-end pb-1">
                  {parsedXer.baseline.status === 'available' ? (
                    <p className="text-emerald-700 font-semibold">سيتم استيراد P6 Baseline من الملف ({parsedXer.baseline.tasks.length} نشاط).</p>
                  ) : (
                    <label className="flex items-center gap-2 text-slate-700 font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={xerBaselineOptIn}
                        onChange={(e) => setXerBaselineOptIn(e.target.checked)}
                        className="w-4 h-4 accent-blue-600"
                      />
                      إنشاء خط أساس ابتدائي من الخطة المستوردة
                    </label>
                  )}
                </div>
              </div>

              {/* Reconciliation report */}
              {xerPlanPreview && 'planError' in xerPlanPreview && (
                <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  <AlertCircle size={20} />
                  <span>{xerPlanPreview.planError}</span>
                </div>
              )}
              {xerPlanPreview && 'plan' in xerPlanPreview && (
                <div className="space-y-3">
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                    <p className="text-slate-700"><span className="text-slate-500">Data Date: </span><span className="font-mono font-bold">{xerPlanPreview.plan.recon.provenance.dataDate || '—'}</span> <span className="text-slate-400">({xerPlanPreview.plan.recon.provenance.dataDateSource})</span></p>
                    <p className="text-slate-700"><span className="text-slate-500">العملة: </span><span className="font-mono font-bold">{xerPlanPreview.plan.recon.provenance.currency}</span> <span className="text-slate-400">({xerPlanPreview.plan.recon.provenance.currencySource})</span></p>
                    <p className="text-slate-700"><span className="text-slate-500">منطق الحالة: </span><span className="font-mono font-bold">{xerPlanPreview.plan.recon.provenance.statusLogic}</span> <span className="text-slate-400">({xerPlanPreview.plan.recon.provenance.statusLogicSource})</span></p>
                    <p className="text-slate-700"><span className="text-slate-500">التقويم الافتراضي: </span><span className="font-bold">{xerPlanPreview.plan.recon.provenance.defaultCalendar}</span></p>
                  </div>
                  {xerPlanPreview.plan.recon.hasLoss && (
                    <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-300 rounded-lg text-amber-800 text-xs font-semibold">
                      <AlertCircle size={18} />
                      <span>تنبيه: توجد بنود مسقطة/غير مدعومة موثقة أدناه — لن يتم الادعاء بنجاح كامل.</span>
                    </div>
                  )}
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="text-right p-2">البند</th>
                          <th className="text-right p-2">المصدر</th>
                          <th className="text-right p-2">المستورد</th>
                          <th className="text-right p-2">المسقط</th>
                          <th className="text-right p-2">غير مدعوم</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {xerPlanPreview.plan.recon.sections.map((sec) => (
                          <tr key={sec.entity} className="hover:bg-slate-50">
                            <td className="p-2 text-slate-700 font-medium">
                              {sec.entity}
                              {sec.notes.map((n, i) => (
                                <span key={i} className="block text-[10px] font-normal text-slate-400">{n}</span>
                              ))}
                            </td>
                            <td className="p-2 font-mono">{sec.source}</td>
                            <td className="p-2 font-mono text-emerald-700 font-bold">{sec.imported}</td>
                            <td className={`p-2 font-mono font-bold ${sec.dropped > 0 ? 'text-red-600' : 'text-slate-400'}`}>{sec.dropped}</td>
                            <td className={`p-2 font-mono font-bold ${sec.unsupported > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{sec.unsupported}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(xerPlanPreview.plan.recon.droppedTotal > 0 || xerPlanPreview.plan.recon.unsupportedTotal > 0) && (
                    <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg p-3 space-y-1 bg-white">
                      {xerPlanPreview.plan.recon.droppedItems.map((d, i) => (
                        <p key={`d${i}`} className="text-[11px] text-slate-700">
                          <span className="font-bold text-red-700">مسقط [{d.entity}]</span> <span className="font-mono">{d.code}</span> — {d.reason}
                        </p>
                      ))}
                      {xerPlanPreview.plan.recon.unsupportedItems.map((u, i) => (
                        <p key={`u${i}`} className="text-[11px] text-slate-700">
                          <span className="font-bold text-amber-700">غير مدعوم [{u.entity}]</span> <span className="font-mono">{u.code}</span> — {u.reason}
                        </p>
                      ))}
                      {(xerPlanPreview.plan.recon.droppedTotal > xerPlanPreview.plan.recon.droppedItems.length ||
                        xerPlanPreview.plan.recon.unsupportedTotal > xerPlanPreview.plan.recon.unsupportedItems.length) && (
                        <p className="text-[11px] text-slate-500">+ بنود إضافية ({xerPlanPreview.plan.recon.droppedTotal + xerPlanPreview.plan.recon.unsupportedTotal} إجمالاً)</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-60">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600 sticky top-0">
                    <tr>
                      <th className="text-right p-2">الكود</th>
                      <th className="text-right p-2">اسم النشاط</th>
                      <th className="text-right p-2">البداية</th>
                      <th className="text-right p-2">النهاية</th>
                      <th className="text-right p-2">المدة</th>
                      <th className="text-right p-2">الإنجاز</th>
                      <th className="text-right p-2">حرج</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {parsedXer.activities.slice(0, 10).map((a, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="p-2 font-mono text-slate-500">{a.code}</td>
                        <td className="p-2 text-slate-700 max-w-xs truncate">{a.name}</td>
                        <td className="p-2">{a.earlyStart || '-'}</td>
                        <td className="p-2">{a.earlyFinish || '-'}</td>
                        <td className="p-2">{a.durationDays === null || a.durationDays === undefined ? '-' : `${a.durationDays} يوم`}</td>
                        <td className="p-2">{a.percentComplete}%</td>
                        <td className="p-2">{a.isCritical ? <span className="text-red-600 font-bold">نعم</span> : 'لا'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div className="mt-6 flex justify-end">
            <button
              onClick={handleImportXer}
              disabled={!parsedXer || parsedXer.activities.length === 0}
              className="flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              <Database size={20} />
              استيراد المشروع والشبكة من ملف P6
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { parseBoqFile, categorizeBoqItem } from '@/lib/boqParser';
import {
  EMPTY_BOQ_OVERRIDES,
  FAMILY_LABELS,
  generateBoqPlan,
  type BoqPlan,
  type BoqPlanOverrides,
} from '@/lib/boqPlanningEngine';
import {
  approveBoqBaseline,
  buildBoqPersistPlan,
  persistBoqPersistPlan,
  type BoqPersistPlan,
} from '@/lib/boqPlanService';
import { WORK_TYPE_BINDING, type BoqWorkType } from '@/lib/boqClassifier';
import { parseXerContent, type ParsedXerResult } from '@/lib/xerImporter';
import { buildXerImportPlan, persistXerImportPlan, type ReconReport, type XerImportPlan } from '@/lib/xerImportService';
import type { CalendarType, ParsedBoqRow, Project } from '@/types';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
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
  Plus,
  Trash2,
  ShieldCheck,
} from 'lucide-react';

interface ImportViewProps {
  onProjectCreated: (project: Project) => void;
}

type ImportSource = 'boq' | 'xer';

// F2: Arabic labels for the planning work-type select (engine keys stay English).
const WORK_TYPE_AR: Record<BoqWorkType, string> = {
  sub_excv: 'حفر أساسات', sub_blind: 'خرسانة نظافة', sub_waterproof: 'عزل أساسات',
  sub_rebar: 'حديد قواعد', sub_form: 'نجارة قواعد', sub_conc: 'خرسانة قواعد', sub_composite: 'قواعد كاملة (مركب)',
  vert_rebar: 'حديد أعمدة/حوائط', vert_form: 'نجارة أعمدة/حوائط', vert_conc: 'خرسانة أعمدة/حوائط', vert_composite: 'أعمدة كاملة (مركب)',
  horz_form: 'نجارة أسقف/كمرات', horz_rebar: 'حديد أسقف/كمرات', horz_conc: 'خرسانة أسقف/كمرات', horz_composite: 'سقف كامل (مركب)',
  masonry: 'مباني بلوك',
  grade_survey: 'مساحة تسوية', grade_clear: 'تنظيف موقع', grade_excv: 'حفر كميات', grade_haul: 'نقل ناتج',
  grade_fill: 'ردم هندسي', grade_compact: 'دمك', grade_final: 'تشطيب تسوية',
  pipe_survey: 'مساحة شبكات', pipe_excv: 'حفر خنادق', pipe_bedding: 'فرشة', pipe_install: 'تركيب مواسير',
  pipe_joint: 'وصلات/محابس', pipe_test: 'اختبار ضغط', pipe_backfill: 'ردم خنادق', pipe_reinstate: 'إعادة رصف',
  road_subgrade: 'تربة تأسيس', road_subbase: 'أساس مساعد', road_base: 'أساس', road_prime: 'رش تشريبي',
  road_binder: 'أسفلت رابط', road_wearing: 'أسفلت سطحي', road_asphalt_composite: 'أسفلت (مركب)',
  kerb: 'بردورات',
  review_required: 'مراجعة مطلوبة',
};

export default function ImportView({ onProjectCreated }: ImportViewProps) {
  const [importSource, setImportSource] = useState<ImportSource>('boq');
  const [step, setStep] = useState<'info' | 'analyzing' | 'done'>('info');

  // BOQ form state
  const [projectInfo, setProjectInfo] = useState({
    name: '',
    client: '',
    location: '',
    contract_value: '',
    // F9 (acceptance A): default to the governed Data Date constant — a machine-clock default could
    // silently start a project after the governed control date. The field stays user-editable.
    start_date: DEFAULT_DATA_DATE,
    description: '',
  });
  const [boqFile, setBoqFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedBoqRow[]>([]);

  // F2: BOQ planning wizard state (preview -> review -> confirm -> persist; no auto-baseline)
  const [boqCalendar, setBoqCalendar] = useState<CalendarType>('6_days');
  const [boqOverrides, setBoqOverrides] = useState<BoqPlanOverrides>(EMPTY_BOQ_OVERRIDES);
  const [boqTab, setBoqTab] = useState<'class' | 'wbs' | 'acts' | 'logic' | 'cost' | 'valid'>('class');
  const [newLink, setNewLink] = useState({ from: '', to: '', type: 'FS', lag: 0 });
  const [boqDone, setBoqDone] = useState<{ persist: BoqPersistPlan; canApprove: boolean; criticalCount: number } | null>(null);
  const [doneSource, setDoneSource] = useState<'xer' | 'boq' | null>(null);
  const [boqBaseline, setBoqBaseline] = useState<{ ok: boolean; version: number | null; error: string | null } | null>(null);

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
  const boqPlanPreview: { plan: BoqPlan } | { planError: string } | null = useMemo(() => {
    if (parsedRows.length === 0) return null;
    try {
      return {
        plan: generateBoqPlan(
          parsedRows,
          { projectName: projectInfo.name, startDate: projectInfo.start_date, calendarType: boqCalendar },
          boqOverrides,
        ),
      };
    } catch (err) {
      return { planError: (err as Error).message || 'تعذر بناء الخطة' };
    }
  }, [parsedRows, projectInfo.name, projectInfo.start_date, boqCalendar, boqOverrides]);

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
      setBoqOverrides(EMPTY_BOQ_OVERRIDES);
      setBoqTab('class');
      setBoqDone(null);
      setBoqBaseline(null);
      setDoneSource(null);
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

  // F2: confirm the reviewed plan -> persist as Draft (status 'planning', NO baseline).
  async function handleConfirmBoqPlan() {
    if (!projectInfo.name || !projectInfo.start_date) {
      setError('الرجاء إدخال اسم المشروع وتاريخ البداية');
      return;
    }
    if (!boqPlanPreview || !('plan' in boqPlanPreview)) {
      setError('لا توجد خطة صالحة للاعتماد — راجع بنود المقايسة أولاً');
      return;
    }
    const plan = boqPlanPreview.plan;
    if (!plan.canSave) {
      setError(plan.saveBlockReason || 'تعذر حفظ الخطة');
      return;
    }
    setStep('analyzing');
    setError('');
    try {
      const boqRows = parsedRows.map((row, i) => ({
        rowKey: `boq-${String(i + 1).padStart(4, '0')}`,
        code: row.code,
        description: row.description,
        unit: row.unit,
        quantity: row.quantity,
        unit_price: row.unit_price,
        total_price: row.total_price,
      }));
      const persist = buildBoqPersistPlan(
        plan,
        {
          name: projectInfo.name,
          client: projectInfo.client || undefined,
          location: projectInfo.location || undefined,
          contract_value: parseFloat(projectInfo.contract_value) || plan.recon.boqTotal,
          description: projectInfo.description || undefined,
          start_date: projectInfo.start_date,
          end_date: plan.recon.projectFinish || projectInfo.start_date,
          status: 'planning',
          currency: 'SAR',
          calendar_type: boqCalendar,
        },
        boqRows,
      );
      setParseProgress('جاري حفظ المشروع والخطة المعتمدة...');
      const result = await persistBoqPersistPlan(supabase, persist, (stepName, done, total) => {
        setParseProgress(`جاري حفظ ${stepName}... (${done}/${total})`);
      });
      if (!result.ok) {
        const cleanupNote = result.cleanedUp.length > 0
          ? ` تم التراجع عن: ${result.cleanedUp.join('، ')} — لا يوجد مشروع نصف محفوظ.`
          : '';
        throw new Error(`${result.error || 'فشل الحفظ'}${cleanupNote}`);
      }
      setBoqDone({ persist, canApprove: persist.canApproveBaseline, criticalCount: plan.findings.filter((f) => f.severity === 'critical').length });
      setDoneSource('boq');
      setStep('done');
    } catch (err: unknown) {
      setError((err as Error).message || 'حدث خطأ أثناء حفظ الخطة');
      setStep('info');
    }
  }

  // F2: explicit baseline approval only — refused while critical findings exist.
  async function handleApproveBoqBaseline() {
    if (!boqDone) return;
    setError('');
    try {
      setParseProgress('جاري اعتماد خط الأساس...');
      const acts = boqDone.persist.activities.map((a) => {
        const r = a as Record<string, unknown>;
        return {
          activity_id: String(r.id),
          planned_start: typeof r.early_start === 'string' ? r.early_start : null,
          planned_finish: typeof r.early_finish === 'string' ? r.early_finish : null,
          duration_days: Number(r.duration_days) || 0,
          planned_cost: 0,
          // F5 additive: capture baseline float for float-change analysis (null when absent).
          total_float_days: typeof r.total_float === 'number' ? (r.total_float as number) : null,
        };
      });
      // Planned cost per activity comes from the persisted budget lines in the plan.
      const costByAct = new Map<string, number>();
      for (const b of boqDone.persist.budgetLines) {
        const r = b as Record<string, unknown>;
        costByAct.set(String(r.activity_id), Number(r.planned_cost) || 0);
      }
      for (const a of acts) a.planned_cost = costByAct.get(a.activity_id) || 0;
      const res = await approveBoqBaseline(supabase, boqDone.persist.projectId, acts, { canApproveBaseline: boqDone.canApprove, criticalCount: boqDone.criticalCount }, 1, 'Initial Baseline');
      if (!res.ok) {
        setBoqBaseline({ ok: false, version: null, error: res.error });
        return;
      }
      setBoqBaseline({ ok: true, version: res.version, error: null });
    } catch (err: unknown) {
      setBoqBaseline({ ok: false, version: null, error: (err as Error).message });
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

  // F2: BOQ done branch (Draft project, explicit baseline approval only). The XER done
  // branch below is untouched.
  if (step === 'done' && doneSource === 'boq' && boqDone) {
    const r = boqDone.persist.planRecon;
    return (
      <div className="flex items-start justify-center min-h-[50vh] py-8">
        <div className="w-full max-w-3xl text-center p-8 bg-white rounded-2xl shadow-sm border border-slate-200">
          <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 bg-emerald-100">
            <CheckCircle size={40} className="text-emerald-600" />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">تم إنشاء المشروع كمسودة تخطيط</h3>
          <p className="text-sm text-slate-500 mb-4">الحالة: planning (مسودة) — لم يُنشأ أي خط أساس تلقائياً.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-4">
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
              <span className="text-slate-500 block">بنود موزعة</span>
              <span className="font-bold text-emerald-700 text-sm">{r.usableItemCount}</span>
            </div>
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
              <span className="text-slate-500 block">بنود مراجعة</span>
              <span className="font-bold text-amber-700 text-sm">{r.reviewItemCount}</span>
            </div>
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
              <span className="text-slate-500 block">أنشطة / علاقات</span>
              <span className="font-bold text-slate-800 text-sm">{r.activityCount} / {r.linkCount}</span>
            </div>
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
              <span className="text-slate-500 block">الموزع / غير الموزع</span>
              <span className="font-bold text-emerald-700 text-sm">{r.allocatedTotal.toLocaleString()}</span>
              <span className="font-bold text-red-600 text-sm"> / {r.unallocatedTotal.toLocaleString()}</span>
            </div>
          </div>
          {boqBaseline && (
            <div className={`text-sm font-semibold mb-4 p-3 rounded-lg ${boqBaseline.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
              {boqBaseline.ok ? `تم اعتماد خط الأساس v${boqBaseline.version}` : `تعذر الاعتماد: ${boqBaseline.error}`}
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
          )}
          <div className="flex flex-wrap justify-center gap-3">
            {!boqBaseline?.ok && (
              <button
                onClick={handleApproveBoqBaseline}
                disabled={!boqDone.canApprove}
                title={boqDone.canApprove ? 'اعتماد خط الأساس v1' : 'توجد ملاحظات حرجة تمنع الاعتماد — راجع تبويب التحقق'}
                className="inline-flex items-center gap-2 bg-amber-500 text-slate-900 px-6 py-3 rounded-lg font-semibold hover:bg-amber-600 transition-colors disabled:opacity-50"
              >
                <ShieldCheck size={18} />
                اعتماد خط الأساس
              </button>
            )}
            <button
              onClick={() => {
                const pr = boqDone.persist.project as unknown as Record<string, unknown>;
                onProjectCreated({ id: boqDone.persist.projectId, created_at: new Date().toISOString(), duration_days: null, ...pr } as unknown as Project);
              }}
              className="inline-flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
            >
              الانتقال إلى المشروع
              <ArrowRight size={18} className="rotate-180" />
            </button>
          </div>
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
            <div className="mt-4 space-y-4">
              {/* F2: calendar + detected families */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 mb-1">تقويم الخطة (أيام العمل)</label>
                  <select
                    value={boqCalendar}
                    onChange={(e) => setBoqCalendar(e.target.value as CalendarType)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                  >
                    <option value="6_days">6 أيام (الافتراضي)</option>
                    <option value="5_days">5 أيام</option>
                    <option value="7_days">7 أيام</option>
                  </select>
                </div>
                <div>
                  <span className="block font-medium text-slate-600 mb-1">العائلات المكتشفة (اضغط للاستبعاد/الإرجاع)</span>
                  <div className="flex flex-wrap gap-2">
                    {boqPlanPreview && 'plan' in boqPlanPreview &&
                      Array.from(new Set(boqPlanPreview.plan.classifications.map((c) => c.family))).map((fam) => {
                        const excluded = boqOverrides.excludedFamilies.includes(fam);
                        const count = boqPlanPreview.plan.classifications.filter((c) => c.family === fam).length;
                        return (
                          <button
                            key={fam}
                            onClick={() =>
                              setBoqOverrides((o) => ({
                                ...o,
                                excludedFamilies: excluded
                                  ? o.excludedFamilies.filter((f) => f !== fam)
                                  : [...o.excludedFamilies, fam],
                              }))
                            }
                            className={`px-3 py-1.5 rounded-full border text-xs font-semibold ${
                              excluded
                                ? 'bg-slate-100 text-slate-400 border-slate-200 line-through'
                                : 'bg-emerald-50 text-emerald-800 border-emerald-300'
                            }`}
                          >
                            {FAMILY_LABELS[fam]?.ar || fam} ({count})
                          </button>
                        );
                      })}
                  </div>
                </div>
              </div>

              {/* F4: leveling policy + pool capacities */}
              <div className="grid grid-cols-1 gap-3 text-xs">
                <div>
                  <span className="block font-medium text-slate-600 mb-1">سياسة الجدولة (الموارد)</span>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { v: 'respect-resources', ar: 'احترام الموارد المتاحة (تسوية تلقائية)' },
                      { v: 'logic-only', ar: 'المنطق الهندسي فقط (بدون تسوية)' },
                    ] as const).map((pl) => {
                      const active = boqOverrides.leveling.policy === pl.v;
                      return (
                        <button
                          key={pl.v}
                          onClick={() => setBoqOverrides((o) => ({ ...o, leveling: { ...o.leveling, policy: pl.v } }))}
                          className={`px-3 py-1.5 rounded-full border text-xs font-semibold ${
                            active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'
                          }`}
                        >
                          {pl.ar}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {boqOverrides.leveling.policy === 'respect-resources' && boqPlanPreview && 'plan' in boqPlanPreview && boqPlanPreview.plan.leveling.pools.length > 0 && (
                  <div>
                    <span className="block font-medium text-slate-600 mb-1">سعات الموارد (عدد الفرق/المعدات المتاحة)</span>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[...boqPlanPreview.plan.leveling.pools].sort((a, b) => a.poolKey.localeCompare(b.poolKey)).map((pl) => (
                        <label key={pl.poolKey} className="flex items-center justify-between gap-1 bg-white border border-slate-200 rounded-lg px-2 py-1.5">
                          <span className="truncate font-mono text-[10px] text-slate-700" title={`${pl.resourceName} — ذروة غير المقيّد: ${pl.peakDemand} (افتراضي: ${pl.capacityProvenance === 'user' ? 'مخصص' : 'تلقائي'})`}>
                            {pl.poolKey}{pl.capacityProvenance === 'user' ? ' *' : ''}
                          </span>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={boqOverrides.leveling.capacities[pl.poolKey] ?? ''}
                            placeholder={String(pl.capacity)}
                            onChange={(e) => {
                              const raw = e.target.value.trim();
                              setBoqOverrides((o) => {
                                const caps = { ...o.leveling.capacities };
                                if (raw === '') delete caps[pl.poolKey];
                                else {
                                  const v = Math.floor(Number(raw));
                                  if (v >= 1) caps[pl.poolKey] = v;
                                }
                                return { ...o, leveling: { ...o.leveling, capacities: caps } };
                              });
                            }}
                            className="w-14 px-1 py-0.5 border border-slate-300 rounded text-xs font-mono"
                          />
                        </label>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">فارغ = سعة افتراضية (أكبر نشاط منفرد). * = مخصصة من المستخدم.</p>
                  </div>
                )}
              </div>

              {boqPlanPreview && 'planError' in boqPlanPreview && (
                <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  <AlertCircle size={20} />
                  <span>{boqPlanPreview.planError}</span>
                </div>
              )}

              {boqPlanPreview && 'plan' in boqPlanPreview && (
                <>
                  {/* Recon strip */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <span className="text-slate-500 block">إجمالي المقايسة</span>
                      <span className="font-bold text-slate-800 text-sm">{boqPlanPreview.plan.recon.boqTotal.toLocaleString()}</span>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <span className="text-slate-500 block">الموزع / غير الموزع</span>
                      <span className="font-bold text-emerald-700 text-sm">{boqPlanPreview.plan.recon.allocatedTotal.toLocaleString()}</span>
                      <span className={`font-bold text-sm ${boqPlanPreview.plan.recon.unallocatedTotal > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                        {' / '}{boqPlanPreview.plan.recon.unallocatedTotal.toLocaleString()}
                      </span>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <span className="text-slate-500 block">أنشطة / علاقات / حرجة</span>
                      <span className="font-bold text-slate-800 text-sm">
                        {boqPlanPreview.plan.recon.activityCount} / {boqPlanPreview.plan.recon.linkCount} / {boqPlanPreview.plan.recon.criticalCount}
                      </span>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <span className="text-slate-500 block">نهاية الخطة (CPM)</span>
                      <span className="font-bold text-blue-700 text-sm font-mono">{boqPlanPreview.plan.recon.projectFinish || '—'}</span>
                      {boqPlanPreview.plan.leveling.applied && boqPlanPreview.plan.leveling.resourceDelayDays > 0 && (
                        <span className="text-amber-700 block text-[10px]">
                          +{boqPlanPreview.plan.leveling.resourceDelayDays} أيام تسوية (غير المقيّد: {boqPlanPreview.plan.leveling.unconstrained.projectFinish || '—'})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Tabs */}
                  <div className="flex flex-wrap gap-1 rounded-xl bg-slate-200/80 p-1">
                    {([
                      ['class', 'التصنيف'],
                      ['wbs', 'WBS'],
                      ['acts', 'الأنشطة'],
                      ['logic', 'العلاقات'],
                      ['cost', 'التكلفة'],
                      ['valid', 'التحقق'],
                    ] as const).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setBoqTab(key)}
                        className={`flex-1 min-w-20 px-2 py-2 rounded-lg text-xs font-semibold transition-all ${
                          boqTab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Classification tab */}
                  {boqTab === 'class' && (
                    <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-96">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-slate-600 sticky top-0">
                          <tr>
                            <th className="text-right p-2">الكود</th>
                            <th className="text-right p-2">الوصف</th>
                            <th className="text-right p-2">نوع العمل</th>
                            <th className="text-right p-2">الثقة</th>
                            <th className="text-right p-2">الموقع</th>
                            <th className="text-right p-2">تأكيد</th>
                            <th className="text-right p-2">ترتيب</th>
                            <th className="text-right p-2">توزيع الكمية</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {boqPlanPreview.plan.classifications.map((c) => {
                            const row = parsedRows[Number(c.rowKey.slice(4)) - 1];
                            return (
                              <tr key={c.rowKey} className="hover:bg-slate-50">
                                <td className="p-2 font-mono text-slate-500">{row?.code}</td>
                                <td className="p-2 text-slate-700 max-w-52">
                                  <span className="block truncate">{row?.description}</span>
                                  <span className="block text-[10px] text-slate-400">{c.reason}</span>
                                </td>
                                <td className="p-2">
                                  <select
                                    value={boqOverrides.workType[c.rowKey] || c.workType}
                                    onChange={(e) =>
                                      setBoqOverrides((o) => ({
                                        ...o,
                                        workType: { ...o.workType, [c.rowKey]: e.target.value as BoqWorkType },
                                      }))
                                    }
                                    className="px-2 py-1 border border-slate-300 rounded text-xs max-w-40"
                                  >
                                    {[...Object.keys(WORK_TYPE_BINDING), 'review_required'].map((wt) => (
                                      <option key={wt} value={wt}>{WORK_TYPE_AR[wt as BoqWorkType]}</option>
                                    ))}
                                  </select>
                                </td>
                                <td className="p-2">
                                  {c.confidence === 'high' && <span className="text-emerald-700 font-bold">عالية</span>}
                                  {c.confidence === 'medium' && <span className="text-amber-700 font-bold">متوسطة</span>}
                                  {c.confidence === 'review' && <span className="text-red-600 font-bold">مراجعة</span>}
                                </td>
                                <td className="p-2">
                                  <input
                                    type="text"
                                    placeholder={c.locationHint?.label || '—'}
                                    value={boqOverrides.location[c.rowKey] ?? ''}
                                    onChange={(e) =>
                                      setBoqOverrides((o) => {
                                        const loc = { ...o.location };
                                        if (e.target.value.trim() === '') delete loc[c.rowKey];
                                        else loc[c.rowKey] = e.target.value;
                                        return { ...o, location: loc };
                                      })
                                    }
                                    className="px-2 py-1 border border-slate-300 rounded text-xs w-24"
                                  />
                                </td>
                                <td className="p-2 text-center">
                                  {c.confidence === 'medium' ? (
                                    <input
                                      type="checkbox"
                                      checked={!!boqOverrides.confirmed[c.rowKey]}
                                      onChange={(e) =>
                                        setBoqOverrides((o) => {
                                          const conf = { ...o.confirmed };
                                          if (e.target.checked) conf[c.rowKey] = true;
                                          else delete conf[c.rowKey];
                                          return { ...o, confirmed: conf };
                                        })
                                      }
                                      className="w-4 h-4 accent-emerald-600"
                                      title="تأكيد التصنيف"
                                    />
                                  ) : (
                                    <span className="text-slate-300">—</span>
                                  )}
                                </td>
                                <td className="p-2">
                                  <input
                                    type="number"
                                    placeholder="—"
                                    value={boqOverrides.sequence[c.rowKey] ?? ''}
                                    onChange={(e) =>
                                      setBoqOverrides((o) => {
                                        const seq = { ...o.sequence };
                                        if (e.target.value === '') delete seq[c.rowKey];
                                        else seq[c.rowKey] = Number(e.target.value);
                                        return { ...o, sequence: seq };
                                      })
                                    }
                                    className="px-2 py-1 border border-slate-300 rounded text-xs w-14"
                                    title="ترتيب الجبهة في تسلسل الأطقم"
                                  />
                                </td>
                                <td className="p-2">
                                  <input
                                    type="text"
                                    placeholder="Zone A=3000; Zone B=2000"
                                    value={boqOverrides.distribution[c.rowKey] ?? ''}
                                    onChange={(e) =>
                                      setBoqOverrides((o) => {
                                        const dist = { ...o.distribution };
                                        if (e.target.value.trim() === '') delete dist[c.rowKey];
                                        else dist[c.rowKey] = e.target.value;
                                        return { ...o, distribution: dist };
                                      })
                                    }
                                    className="px-2 py-1 border border-slate-300 rounded text-xs w-40"
                                    title="توزيع الكمية بين الجبهات: التسمية=الكمية مفصولة بفاصلة منقوطة"
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* WBS tab */}
                  {boqTab === 'wbs' && (
                    <div className="border border-slate-200 rounded-lg max-h-96 overflow-y-auto p-3 space-y-1 text-xs">
                      {boqPlanPreview.plan.wbs.map((w) => (
                        <div key={w.stableId} className="flex items-center gap-2" style={{ paddingRight: `${(w.level - 1) * 20}px` }}>
                          <span className="font-mono text-slate-400">{w.code}</span>
                          <span className={w.level <= 2 ? 'font-bold text-slate-800' : 'text-slate-700'}>{w.name}</span>
                          {w.level === 1 && <Layers size={14} className="text-amber-500" />}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Activities tab */}
                  {boqTab === 'acts' && (
                    <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-96">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-slate-600 sticky top-0">
                          <tr>
                            <th className="text-right p-2">الكود</th>
                            <th className="text-right p-2">النشاط</th>
                            <th className="text-right p-2">WBS</th>
                            <th className="text-right p-2">المدة</th>
                            <th className="text-right p-2">المعدل/الأطقم</th>
                            <th className="text-right p-2">التكلفة</th>
                            <th className="text-right p-2">CPM</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {boqPlanPreview.plan.activities.map((a) => (
                            <tr key={a.stableId} className={`hover:bg-slate-50 ${a.isMilestone ? 'bg-slate-50/60' : ''}`}>
                              <td className="p-2 font-mono text-slate-500">{a.code}</td>
                              <td className="p-2 text-slate-700 max-w-52">
                                <span className="block truncate font-medium">{a.name}</span>
                                <span className="block text-[10px] text-slate-400">{a.durationNote}</span>
                              </td>
                              <td className="p-2">
                                {!a.isMilestone ? (
                                  <select
                                    value={boqOverrides.wbs[a.stableId] || a.wbsStableId}
                                    onChange={(e) =>
                                      setBoqOverrides((o) => ({ ...o, wbs: { ...o.wbs, [a.stableId]: e.target.value } }))
                                    }
                                    className="px-1 py-1 border border-slate-300 rounded text-xs max-w-28"
                                  >
                                    {boqPlanPreview.plan.wbs.map((w) => (
                                      <option key={w.stableId} value={w.stableId}>{w.code} {w.name}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="font-mono text-slate-400">
                                    {boqPlanPreview.plan.wbs.find((w) => w.stableId === a.wbsStableId)?.code}
                                  </span>
                                )}
                              </td>
                              <td className="p-2">
                                {!a.isMilestone ? (
                                  <span className="flex items-center gap-1">
                                    <input
                                      type="number"
                                      min={1}
                                      value={boqOverrides.duration[a.stableId] ?? a.durationDays}
                                      onChange={(e) =>
                                        setBoqOverrides((o) => ({
                                          ...o,
                                          duration: { ...o.duration, [a.stableId]: Math.max(1, Math.round(Number(e.target.value) || 1)) },
                                        }))
                                      }
                                      className="w-14 px-1 py-1 border border-slate-300 rounded text-xs"
                                    />
                                    <span
                                      className={`text-[10px] font-bold ${
                                        a.durationBasis === 'review'
                                          ? 'text-red-600'
                                          : a.durationBasis === 'user'
                                            ? 'text-blue-700'
                                            : a.durationBasis === 'template_default'
                      
                                              ? 'text-amber-700'
                                              : 'text-emerald-700'
                                      }`}
                                    >
                                      {a.durationBasis === 'review' ? 'مراجعة' : a.durationBasis === 'user' ? 'يدوي' : a.durationBasis === 'template_default' ? 'افتراضي' : 'إنتاجية'}
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-slate-400">Milestone</span>
                                )}
                              </td>
                              <td className="p-2">
                                {!a.isMilestone && a.quantityUnit ? (
                                  <span className="flex items-center gap-1">
                                    <input
                                      type="number"
                                      min={0.01}
                                      step="any"
                                      placeholder="المعدل"
                                      value={boqOverrides.rate[a.stableId] ?? ''}
                                      onChange={(e) =>
                                        setBoqOverrides((o) => {
                                          const rate = { ...o.rate };
                                          if (e.target.value === '') delete rate[a.stableId];
                                          else rate[a.stableId] = Number(e.target.value);
                                          return { ...o, rate };
                                        })
                                      }
                                      className="w-16 px-1 py-1 border border-slate-300 rounded text-xs"
                                    />
                                    <input
                                      type="number"
                                      min={1}
                                      placeholder="طقم"
                                      value={boqOverrides.crews[a.stableId] ?? a.crewCount}
                                      onChange={(e) =>
                                        setBoqOverrides((o) => ({
                                          ...o,
                                          crews: { ...o.crews, [a.stableId]: Math.max(1, Math.round(Number(e.target.value) || 1)) },
                                        }))
                                      }
                                      className="w-12 px-1 py-1 border border-slate-300 rounded text-xs"
                                    />
                                  </span>
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              <td className="p-2 font-bold text-slate-800">{a.plannedCost.toLocaleString()}</td>
                              <td className="p-2 font-mono text-[10px] text-slate-500">
                                {a.earlyStart?.slice(0, 10)} → {a.earlyFinish?.slice(0, 10)}
                                {a.isCritical && !a.isMilestone && <span className="text-red-600 font-bold"> حرج</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Logic tab */}
                  {boqTab === 'logic' && (
                    <div className="space-y-3">
                      <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-72">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 text-slate-600 sticky top-0">
                            <tr>
                              <th className="text-right p-2">السابق</th>
                              <th className="text-right p-2">النوع</th>
                              <th className="text-right p-2">اللاحق</th>
                              <th className="text-right p-2">Lag</th>
                              <th className="text-right p-2">الكود</th>
                              <th className="text-right p-2">القاعدة</th>
                              <th className="text-right p-2"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {boqPlanPreview.plan.links.map((l) => {
                              const from = boqPlanPreview.plan.activities.find((a) => a.stableId === l.fromActivityId);
                              const to = boqPlanPreview.plan.activities.find((a) => a.stableId === l.toActivityId);
                              return (
                                <tr key={l.stableId} className="hover:bg-slate-50">
                                  <td className="p-2 text-slate-700">{from?.code} {from?.name}</td>
                                  <td className="p-2 font-mono font-bold text-blue-700">{l.type}</td>
                                  <td className="p-2 text-slate-700">{to?.code} {to?.name}</td>
                                  <td className="p-2 font-mono">{l.lagDays}</td>
                                  <td
                                    className={`p-2 font-mono text-[10px] ${l.origin === 'resource_leveling' ? 'text-amber-700 font-bold' : 'text-indigo-700'}`}
                                    title={l.origin === 'resource_leveling' ? `تسوية موارد: ${l.resourceKey || ''}` : l.origin}
                                  >
                                    {l.origin === 'resource_leveling' ? '⚖ ' : ''}{l.ruleCode}
                                  </td>
                                  <td className="p-2 text-[10px] text-slate-400 max-w-52 truncate">{l.rule}</td>
                                  <td className="p-2">
                                    <button
                                      onClick={() => {
                                        if (l.origin === 'user') {
                                          const idx = Number(l.stableId.replace('user-link-', ''));
                                          setBoqOverrides((o) => ({ ...o, addLinks: o.addLinks.filter((_, i) => i !== idx) }));
                                        } else {
                                          setBoqOverrides((o) => ({ ...o, removeLinks: [...o.removeLinks, l.stableId] }));
                                        }
                                      }}
                                      className="text-red-500 hover:text-red-700"
                                      title="حذف العلاقة"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="flex flex-wrap items-end gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">
                        <div>
                          <label className="block font-medium text-slate-600 mb-1">السابق</label>
                          <select
                            value={newLink.from}
                            onChange={(e) => setNewLink({ ...newLink, from: e.target.value })}
                            className="px-2 py-1.5 border border-slate-300 rounded text-xs max-w-44"
                          >
                            <option value="">—</option>
                            {boqPlanPreview.plan.activities.map((a) => (
                              <option key={a.stableId} value={a.stableId}>{a.code} {a.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block font-medium text-slate-600 mb-1">النوع</label>
                          <select
                            value={newLink.type}
                            onChange={(e) => setNewLink({ ...newLink, type: e.target.value })}
                            className="px-2 py-1.5 border border-slate-300 rounded text-xs"
                          >
                            <option value="FS">FS</option>
                            <option value="SS">SS</option>
                            <option value="FF">FF</option>
                          </select>
                        </div>
                        <div>
                          <label className="block font-medium text-slate-600 mb-1">اللاحق</label>
                          <select
                            value={newLink.to}
                            onChange={(e) => setNewLink({ ...newLink, to: e.target.value })}
                            className="px-2 py-1.5 border border-slate-300 rounded text-xs max-w-44"
                          >
                            <option value="">—</option>
                            {boqPlanPreview.plan.activities.map((a) => (
                              <option key={a.stableId} value={a.stableId}>{a.code} {a.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block font-medium text-slate-600 mb-1">Lag</label>
                          <input
                            type="number"
                            value={newLink.lag}
                            onChange={(e) => setNewLink({ ...newLink, lag: Number(e.target.value) || 0 })}
                            className="w-16 px-2 py-1.5 border border-slate-300 rounded text-xs"
                          />
                        </div>
                        <button
                          onClick={() => {
                            if (!newLink.from || !newLink.to || newLink.from === newLink.to) return;
                            setBoqOverrides((o) => ({
                              ...o,
                              addLinks: [...o.addLinks, {
                                fromActivityId: newLink.from,
                                toActivityId: newLink.to,
                                type: newLink.type as 'FS' | 'SS' | 'FF',
                                lagDays: Math.max(0, Math.round(newLink.lag)),
                              }],
                            }));
                            setNewLink({ from: '', to: '', type: 'FS', lag: 0 });
                          }}
                          disabled={!newLink.from || !newLink.to}
                          className="flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50"
                        >
                          <Plus size={14} />
                          إضافة علاقة
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Cost tab */}
                  {boqTab === 'cost' && (
                    <div className="space-y-3">
                      <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-72">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 text-slate-600 sticky top-0">
                            <tr>
                              <th className="text-right p-2">النشاط</th>
                              <th className="text-right p-2">المخطط</th>
                              <th className="text-right p-2">الملزم / الفعلي</th>
                              <th className="text-right p-2">مصادر البنود</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {boqPlanPreview.plan.budgetLines.map((b) => {
                              const act = boqPlanPreview.plan.activities.find((a) => a.stableId === b.activityStableId);
                              const allocs = boqPlanPreview.plan.allocations.filter((x) => x.activityStableId === b.activityStableId);
                              return (
                                <tr key={b.stableId} className="hover:bg-slate-50">
                                  <td className="p-2 text-slate-700">{act?.code} {b.description}</td>
                                  <td className="p-2 font-bold text-slate-800">{b.plannedCost.toLocaleString()}</td>
                                  <td className="p-2 text-slate-400">0 / 0</td>
                                  <td className="p-2 text-[10px] text-slate-500">
                                    {allocs.length === 0 ? '—' : allocs.map((x) => {
                                      const r = parsedRows[Number(x.rowKey.slice(4)) - 1];
                                      return `${r?.code} (${x.costShare.toLocaleString()})`;
                                    }).join(' + ')}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                        <p className="text-slate-700">إجمالي المقايسة: <span className="font-bold">{boqPlanPreview.plan.recon.boqTotal.toLocaleString()}</span></p>
                        <p className="text-slate-700">الموزع على الأنشطة: <span className="font-bold text-emerald-700">{boqPlanPreview.plan.recon.allocatedTotal.toLocaleString()}</span></p>
                        <p className="text-slate-700">غير الموزع (بنود المراجعة): <span className={`font-bold ${boqPlanPreview.plan.recon.unallocatedTotal > 0 ? 'text-red-600' : 'text-slate-400'}`}>{boqPlanPreview.plan.recon.unallocatedTotal.toLocaleString()}</span></p>
                      </div>
                    </div>
                  )}

                  {/* Validation tab */}
                  {boqTab === 'valid' && (
                    <div className="space-y-3">
                      {/* F4: target finish + capacity recommendations (review only) */}
                      <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="font-medium text-slate-600">تاريخ الإنجاز المستهدف (اختياري)</label>
                          <input
                            type="date"
                            value={boqOverrides.leveling.targetFinish || ''}
                            onChange={(e) => setBoqOverrides((o) => ({ ...o, leveling: { ...o.leveling, targetFinish: e.target.value || null } }))}
                            className="px-2 py-1.5 border border-slate-300 rounded text-xs font-mono"
                          />
                          {boqPlanPreview.plan.leveling.targetVarianceDays !== null && (
                            <span className={`font-bold ${boqPlanPreview.plan.leveling.targetMet ? 'text-emerald-700' : 'text-red-700'}`}>
                              {boqPlanPreview.plan.leveling.targetVarianceDays > 0 ? '+' : ''}{boqPlanPreview.plan.leveling.targetVarianceDays} أيام عمل
                              {boqPlanPreview.plan.leveling.targetMet ? ' (محقق)' : ' (متجاوز)'}
                            </span>
                          )}
                        </div>
                        {boqPlanPreview.plan.leveling.recommendations.length > 0 && (
                          <div className="space-y-1">
                            <p className="font-semibold text-slate-700">توصيات السعة (من إعادة تشغيل فعلية — لا تُطبق تلقائياً):</p>
                            {boqPlanPreview.plan.leveling.recommendations.map((r) => (
                              <p key={r.poolKey} className="text-slate-600">
                                <span className="font-mono font-bold">{r.poolKey}</span>: {r.currentCapacity} ← {r.candidateCapacity} ← {r.newFinish || '—'} (توفير {r.daysSaved} أيام، التكلفة: N/A)
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {boqPlanPreview.plan.findings.length === 0 && (
                        <p className="text-xs text-emerald-700 font-semibold">لا توجد ملاحظات — الخطة جاهزة للاعتماد.</p>
                      )}
                      {(['critical', 'warning', 'info'] as const).map((sev) =>
                        boqPlanPreview.plan.findings.filter((f) => f.severity === sev).map((f, i) => (
                          <div
                            key={`${sev}-${i}`}
                            className={`text-xs p-2.5 rounded-lg border ${
                              sev === 'critical'
                                ? 'bg-red-50 border-red-200 text-red-800'
                                : sev === 'warning'
                                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                                  : 'bg-slate-50 border-slate-200 text-slate-600'
                            }`}
                          >
                            <span className="font-bold font-mono">[{f.code}]</span> {f.message}
                          </div>
                        ))
                      )}
                    </div>
                    </div>
                  )}

                  {/* Confirm bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-lg p-4">
                    <div className="text-xs space-y-1">
                      {!boqPlanPreview.plan.canSave && (
                        <p className="text-red-700 font-bold">تعذر الحفظ: {boqPlanPreview.plan.saveBlockReason}</p>
                      )}
                      {boqPlanPreview.plan.canSave && !boqPlanPreview.plan.canApproveBaseline && (
                        <p className="text-amber-700 font-semibold">يمكن الحفظ كمسودة — الاعتماد النهائي يتطلب حل الملاحظات الحرجة.</p>
                      )}
                      {boqPlanPreview.plan.canApproveBaseline && (
                        <p className="text-emerald-700 font-semibold">الخطة جاهزة: يمكن الحفظ ثم اعتماد خط الأساس.</p>
                      )}
                    </div>
                    <button
                      onClick={handleConfirmBoqPlan}
                      disabled={!boqPlanPreview.plan.canSave || !projectInfo.name}
                      className="flex items-center gap-2 bg-emerald-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50"
                    >
                      <Building2 size={20} />
                      اعتماد الخطة وإنشاء المشروع (مسودة)
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
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

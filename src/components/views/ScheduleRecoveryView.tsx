import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  ActivityLink,
  RecoveryOption,
  RecoveryPlanResult,
} from '@/types';
import { generateScheduleRecoveryPlan } from '@/lib/recoveryOptimizerEngine';
import { calculateCpm } from '@/lib/cpmEngine';
import {
  Zap,
  FastForward,
  TrendingUp,
  Sparkles,
  CheckCircle2,
  Calendar,
  Layers,
  AlertTriangle,
  Sliders,
  DollarSign,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';

interface ScheduleRecoveryViewProps {
  project: Project | null;
}

export default function ScheduleRecoveryView({ project }: ScheduleRecoveryViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetDate, setTargetDate] = useState<string>('2027-04-15');
  const [selectedOptionsMap, setSelectedOptionsMap] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, linkRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
    ]);
    const acts = actRes.data || [];
    setActivities(acts);
    setLinks((linkRes.data || []) as ActivityLink[]);

    if (project.end_date) {
      setTargetDate(project.end_date);
    }
    setLoading(false);
  }

  const rawPlan = useMemo(() => {
    return generateScheduleRecoveryPlan(
      activities,
      links,
      targetDate,
      project?.calendar_type || '6_days',
    );
  }, [activities, links, targetDate, project?.calendar_type]);

  // Merge user selections
  const plan: RecoveryPlanResult = useMemo(() => {
    const updatedOptions = rawPlan.options.map((opt) => ({
      ...opt,
      selected: selectedOptionsMap[opt.id] !== undefined ? selectedOptionsMap[opt.id] : opt.selected,
    }));

    const selectedOptions = updatedOptions.filter((o) => o.selected);
    const totalDaysRecovered = selectedOptions.reduce((sum, o) => sum + o.daysSaved, 0);
    const totalRecoveryCost = selectedOptions.reduce((sum, o) => sum + o.additionalCost, 0);

    return {
      ...rawPlan,
      options: updatedOptions,
      totalDaysRecovered,
      totalRecoveryCost,
    };
  }, [rawPlan, selectedOptionsMap]);

  function toggleOption(id: string) {
    setSelectedOptionsMap((prev) => ({
      ...prev,
      [id]: prev[id] !== undefined ? !prev[id] : !rawPlan.options.find((o) => o.id === id)?.selected,
    }));
  }

  async function handleApplyPlan() {
    if (!project) return;
    setIsApplying(true);
    const activeSelected = plan.options.filter((o) => o.selected);

    // Apply reduced duration or fast tracking
    for (const opt of activeSelected) {
      const act = activities.find((a) => a.id === opt.activityId);
      if (act) {
        const newDuration = Math.max(1, (act.duration_days || 1) - opt.daysSaved);
        await supabase.from('activities').update({
          duration_days: newDuration,
        }).eq('id', opt.activityId);
      }
    }

    // Recalculate CPM network
    const actRes = await supabase.from('activities').select('*').eq('project_id', project.id);
    const updatedActs = actRes.data || [];
    const cpm = calculateCpm(updatedActs, links, project.calendar_type || '6_days');

    for (const r of cpm.results) {
      await supabase.from('activities').update({
        early_start: r.earlyStart,
        early_finish: r.earlyFinish,
        late_start: r.lateStart,
        late_finish: r.lateFinish,
        total_float: r.totalFloat,
        free_float: r.freeFloat,
        is_critical: r.isCritical,
      }).eq('id', r.activityId);
    }

    await loadData();
    setIsApplying(false);
    setMessage(`تم تطبيق خطة الاستدراك بنجاح! تم استرجاع ${plan.totalDaysRecovered} يوماً وتحديث المسار الحرج المباشر.`);
  }

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
            <FastForward className="text-blue-600" size={24} />
            محرك خطط الاستدراك والتعجيل الآلي (Schedule Recovery & Crashing Optimizer)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            خوارزمية ذكية لاقتراح مسارات ضغط الأنشطة الحرجة (Crashing & Fast-Tracking) لتعويض التأخير بأقل تكلفة إضافية.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs">
            <Calendar size={14} className="text-blue-600" />
            <span className="text-slate-600 font-semibold">تاريخ التسليم المستهدف:</span>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="bg-transparent font-bold text-slate-900 outline-none cursor-pointer"
            />
          </div>

          <button
            onClick={() => void handleApplyPlan()}
            disabled={isApplying || plan.totalDaysRecovered === 0}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-4 py-2 rounded-lg text-xs font-bold shadow-md shadow-emerald-500/20 transition-all disabled:opacity-50 cursor-pointer"
          >
            <Zap size={14} className={isApplying ? 'animate-spin' : ''} />
            <span>تطبيق الخطة الاستدراكية على الجدول (Apply Recovery)</span>
          </button>
        </div>
      </div>

      {message && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs flex items-center justify-between animate-fadeIn">
          <span className="font-semibold">{message}</span>
          <button onClick={() => setMessage('')} className="text-emerald-600 hover:text-emerald-800 font-bold text-sm">×</button>
        </div>
      )}

      {/* Plan Metrics Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">نهاية المشروع الحالية</span>
          <div className="text-lg font-mono font-bold text-red-600 mt-1">{plan.currentFinishDate}</div>
          <span className="text-[10px] text-slate-400">قبل تنفيذ التعجيل</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">الأيام المسترجعة بالخطة</span>
          <div className="text-2xl font-black text-emerald-600 mt-1">+{plan.totalDaysRecovered} يوم</div>
          <span className="text-[10px] text-slate-400">مجموع استقطاع مسار الحرج</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-medium">التكلفة التقديرية للتعجيل</span>
          <div className="text-2xl font-black text-blue-700 mt-1">{plan.totalRecoveryCost.toLocaleString()} SAR</div>
          <span className="text-[10px] text-slate-400">ورديات عمل + طواقم إضافية</span>
        </div>

        <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 rounded-xl border border-slate-700 shadow-sm flex flex-col justify-between">
          <span className="text-xs text-slate-300 font-medium">موعد التسليم المستعاد</span>
          <div className="text-lg font-mono font-black text-amber-300 mt-1">{plan.newProjectFinishDate}</div>
          <span className="text-[10px] text-emerald-400 font-semibold">مطابق للموعد التعاقدي</span>
        </div>
      </div>

      {/* Interactive Recovery Options Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
              <Sliders size={18} className="text-blue-600" />
              <span>خيارات ومصفوفة التعجيل المقترحة (Cost vs Time Trade-off)</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              قم باختيار أو استبعاد أي إجراء تعجيل لملاحظة الأثر الفوري على تاريخ الإنجاز والميزانية.
            </p>
          </div>
          <span className="text-xs text-slate-500">{plan.options.length} إجراء متاح</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-semibold">
              <tr>
                <th className="p-3 text-center">تفعيل</th>
                <th className="p-3 text-right">النشاط المستهدف</th>
                <th className="p-3 text-right">استراتيجية التعجيل</th>
                <th className="p-3 text-right">الوفر الزمني</th>
                <th className="p-3 text-right">التكلفة الإضافية</th>
                <th className="p-3 text-right">كفاءة التكلفة (SAR/يوم)</th>
                <th className="p-3 text-right">تفاصيل الإجراء الميداني</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plan.options.map((opt) => (
                <tr
                  key={opt.id}
                  onClick={() => toggleOption(opt.id)}
                  className={`cursor-pointer transition-colors ${
                    opt.selected ? 'bg-blue-50/40 hover:bg-blue-50/70' : 'hover:bg-slate-50 opacity-60'
                  }`}
                >
                  <td className="p-3 text-center">
                    <input
                      type="checkbox"
                      checked={opt.selected}
                      onChange={() => {}}
                      className="w-4 h-4 text-blue-600 rounded cursor-pointer"
                    />
                  </td>
                  <td className="p-3 font-medium">
                    <span className="font-mono text-slate-500 ml-1">[{opt.activityCode}]</span>
                    <span className="text-slate-800 font-semibold">{opt.activityName}</span>
                  </td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded font-bold text-[10px] bg-slate-100 text-slate-800 border">
                      {opt.strategyAr}
                    </span>
                  </td>
                  <td className="p-3 font-mono font-bold text-emerald-700">-{opt.daysSaved} يوم</td>
                  <td className="p-3 font-bold text-slate-800">{opt.additionalCost.toLocaleString()} ريال</td>
                  <td className="p-3 font-mono text-blue-700 font-semibold">{opt.costPerDay.toLocaleString()} ريال/يوم</td>
                  <td className="p-3 text-slate-600 max-w-xs">{opt.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

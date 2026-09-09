import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  ActivityLink,
  BaselineActivity,
  BudgetLine,
  CostTransaction,
  ProgressUpdate,
  Risk,
  EvmMetrics,
} from '@/types';
import { runDcma14PointAudit } from '@/lib/scheduleQualityEngine';
import { generateSCurveData, type SCurveData } from '@/lib/sCurveEngine';
import { calculateEarnedSchedule } from '@/lib/earnedScheduleEngine';
import SCurveChart from '@/components/views/SCurveChart';
import {
  Printer,
  FileText,
  Building2,
  Calendar,
  TrendingUp,
  Award,
  Zap,
  Scale,
  GitCommit,
} from 'lucide-react';

interface ExecutiveReportViewProps {
  project: Project | null;
}

export default function ExecutiveReportView({ project }: ExecutiveReportViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [transactions, setTransactions] = useState<CostTransaction[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, linkRes, baselineRes, bgtRes, cstRes, prgRes, rskRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('baseline_activities').select('*'),
      supabase.from('budget_lines').select('*').eq('project_id', project.id),
      supabase.from('cost_transactions').select('*').eq('project_id', project.id),
      supabase.from('progress_updates').select('*').eq('project_id', project.id),
      supabase.from('risks').select('*').eq('project_id', project.id),
    ]);
    setActivities(actRes.data || []);
    setLinks((linkRes.data || []) as ActivityLink[]);
    setBaselineActivities((baselineRes.data || []) as BaselineActivity[]);
    setBudgetLines(bgtRes.data || []);
    setTransactions((cstRes.data || []) as CostTransaction[]);
    setProgressUpdates((prgRes.data || []) as ProgressUpdate[]);
    setRisks(rskRes.data || []);
    setLoading(false);
  }

  const dcma = useMemo(() => {
    return runDcma14PointAudit(
      activities,
      links,
      baselineActivities,
      [],
      project?.data_date || new Date().toISOString().split('T')[0],
    );
  }, [activities, links, baselineActivities, project?.data_date]);

  // Compute EVM metrics
  const totalBac = project?.contract_value || 4850000;
  const approvedActualCost = transactions
    .filter((t) => t.status === 'approved')
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);

  const earnedVal = activities.reduce((sum, a) => {
    const actBac = (a.planned_quantity || 1) * 100;
    return sum + actBac * ((a.percent_complete || 0) / 100);
  }, 0);

  const plannedVal = totalBac * 0.22;
  const spi = plannedVal > 0 ? earnedVal / plannedVal : 1.0;
  const cpi = approvedActualCost > 0 ? earnedVal / approvedActualCost : 1.0;
  const eac = cpi > 0 ? totalBac / cpi : totalBac;

  const evmMetrics: EvmMetrics = {
    bac: totalBac,
    pv: plannedVal,
    ev: earnedVal,
    ac: approvedActualCost,
    sv: earnedVal - plannedVal,
    cv: earnedVal - approvedActualCost,
    spi,
    cpi,
    eac,
    etc: Math.max(0, eac - approvedActualCost),
    vac: totalBac - eac,
  };

  // Earned Schedule (ESM)
  const earnedScheduleData = useMemo(() => {
    return calculateEarnedSchedule(project, activities, 0.95);
  }, [project, activities]);

  const sCurveData: SCurveData = useMemo(() => {
    return generateSCurveData(
      activities,
      baselineActivities,
      progressUpdates,
      transactions,
      evmMetrics,
      project?.start_date,
      project?.end_date,
    );
  }, [activities, baselineActivities, progressUpdates, transactions, evmMetrics, project]);

  // Lookahead activities (next 3 weeks from data date)
  const lookaheadActivities = useMemo(() => {
    const dataDate = project?.data_date || '2026-11-15';
    const lookaheadEnd = new Date(dataDate);
    lookaheadEnd.setDate(lookaheadEnd.getDate() + 21);
    const lookaheadEndStr = lookaheadEnd.toISOString().split('T')[0];

    return activities.filter((a) => {
      if (a.percent_complete >= 100) return false;
      if (!a.early_start) return false;
      return a.early_start <= lookaheadEndStr;
    });
  }, [activities, project?.data_date]);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Control Bar (Hidden in Print) */}
      <div className="flex items-center justify-between bg-white p-4 rounded-xl border border-slate-200 shadow-sm print:hidden">
        <div>
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <FileText className="text-amber-500" size={20} />
            التقرير التنفيذي الشامل للجدول الزمني والتحكم بالمشروع (Executive Status Report)
          </h2>
          <p className="text-xs text-slate-500">
            يتضمن مؤشرات القيمة والجدول المكتسب (ESM)، فحص DCMA 14-Point، ومطالبات TIA الهندسية.
          </p>
        </div>

        <button
          onClick={handlePrint}
          className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-md transition-all cursor-pointer"
        >
          <Printer size={15} />
          <span>طباعة / حفظ كملف PDF رسمي</span>
        </button>
      </div>

      {/* Printable Report Document Container */}
      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-md space-y-6 print:border-none print:shadow-none print:p-0">
        {/* Report Header */}
        <div className="flex items-start justify-between border-b-2 border-slate-900 pb-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl bg-slate-900 text-amber-400 flex items-center justify-center font-bold">
                <Building2 size={20} />
              </div>
              <h1 className="text-xl font-black text-slate-900">{project?.name}</h1>
            </div>
            <p className="text-xs text-slate-600">
              المالك / العميل: <span className="font-semibold text-slate-800">{project?.client || 'شركة الأفق'}</span> | الموقع: <span className="font-semibold text-slate-800">{project?.location || 'الرياض'}</span>
            </p>
            <p className="text-xs text-slate-600">
              قيمة العقد: <span className="font-bold text-slate-900">{totalBac.toLocaleString()} {project?.currency || 'ر.س'}</span> | البداية: <span className="font-mono">{project?.start_date}</span> | النهاية المعتمدة: <span className="font-mono">{project?.end_date}</span>
            </p>
          </div>

          <div className="text-left space-y-1">
            <div className="bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg text-right">
              <div className="text-[10px] text-amber-800 font-bold uppercase">تاريخ خط الحالة (Data Date)</div>
              <div className="text-sm font-black font-mono text-slate-900">{project?.data_date || '2026-11-15'}</div>
            </div>
            <div className="text-[10px] text-slate-400 font-mono text-left">Generated: 2026-09-09</div>
          </div>
        </div>

        {/* Executive KPI Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">مؤشر أداء الجدول الزمني SPI(t)</span>
            <div className={`text-2xl font-black mt-1 ${earnedScheduleData.schedulePerformanceIndexTime >= 1 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {earnedScheduleData.schedulePerformanceIndexTime.toFixed(2)}
            </div>
            <span className="text-[10px] font-mono text-slate-500">
              الجدول المكتسب: {earnedScheduleData.earnedScheduleDays} يوم
            </span>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">الانحراف الزمني الحقيقي SV(t)</span>
            <div className={`text-2xl font-black mt-1 ${earnedScheduleData.scheduleVarianceTimeDays >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {earnedScheduleData.scheduleVarianceTimeDays >= 0 ? `+${earnedScheduleData.scheduleVarianceTimeDays}` : earnedScheduleData.scheduleVarianceTimeDays} يوم
            </div>
            <span className="text-[10px] text-slate-500">Time-based schedule variance</span>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">الإنجاز المتوقع IEAC(t)</span>
            <div className="text-base font-black text-purple-900 mt-1.5">
              {earnedScheduleData.forecastCompletionDate}
            </div>
            <span className="text-[10px] text-rose-600 font-bold">
              تأخير متوقع: {Math.abs(earnedScheduleData.varianceAtCompletionTimeDays)} يوم
            </span>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
            <span className="text-[11px] text-slate-500 font-semibold">جودة وسلامة الجدول (DCMA)</span>
            <div className="text-2xl font-black text-emerald-700 mt-1">{dcma.score}%</div>
            <span className="text-[10px] text-emerald-600 font-bold">{dcma.totalPassed}/14 معايير معتمدة</span>
          </div>
        </div>

        {/* S-Curve Chart Section */}
        <div className="border border-slate-200 rounded-xl p-4">
          <h3 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5">
            <TrendingUp size={15} className="text-amber-600" />
            منحنى الإنجاز التراكمي ومطابقة خط الأساس (Baseline S-Curve & EVM)
          </h3>
          <SCurveChart data={sCurveData} currency={project?.currency || 'ريال'} />
        </div>

        {/* Critical Path Table */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <Zap size={15} className="text-rose-600" />
            أنشطة المسار الحرج (Critical Path Activities - Zero Float)
          </h3>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-2 text-right">كود النشاط</th>
                  <th className="p-2 text-right">اسم النشاط</th>
                  <th className="p-2 text-right">البداية المبكرة</th>
                  <th className="p-2 text-right">النهاية المبكرة</th>
                  <th className="p-2 text-right">المدة</th>
                  <th className="p-2 text-right">الإنجاز</th>
                  <th className="p-2 text-right">كبح المسار (Drag)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activities.filter((a) => a.is_critical).map((act) => (
                  <tr key={act.id} className="hover:bg-slate-50">
                    <td className="p-2 font-mono font-bold text-rose-700">{act.code}</td>
                    <td className="p-2 font-semibold text-slate-800">{act.name}</td>
                    <td className="p-2 font-mono text-slate-600">{act.early_start}</td>
                    <td className="p-2 font-mono text-slate-600">{act.early_finish}</td>
                    <td className="p-2">{act.duration_days} يوم</td>
                    <td className="p-2 font-bold text-blue-700">{act.percent_complete}%</td>
                    <td className="p-2 font-mono">{act.activity_drag || act.duration_days} يوم</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 3-Week Lookahead Schedule */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <Calendar size={15} className="text-indigo-600" />
            جدول النظرة المستقبلية للأسابيع الثلاثة القادمة (3-Week Lookahead Schedule)
          </h3>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-700 font-bold">
                <tr>
                  <th className="p-2 text-right">الكود</th>
                  <th className="p-2 text-right">النشاط المستهدف</th>
                  <th className="p-2 text-right">المقاول / الفريق</th>
                  <th className="p-2 text-right">تاريخ البدء المخطط</th>
                  <th className="p-2 text-right">تاريخ الإنجاز المخطط</th>
                  <th className="p-2 text-right">الهامش (Float)</th>
                  <th className="p-2 text-center">الأولوية</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lookaheadActivities.map((act) => (
                  <tr key={act.id} className="hover:bg-slate-50">
                    <td className="p-2 font-mono font-medium">{act.code}</td>
                    <td className="p-2 font-medium text-slate-800">{act.name}</td>
                    <td className="p-2 text-slate-500">{act.contractor || 'المقاول العام'}</td>
                    <td className="p-2 font-mono text-slate-700">{act.early_start}</td>
                    <td className="p-2 font-mono text-slate-700">{act.early_finish}</td>
                    <td className="p-2 font-mono">{act.total_float || 0} يوم</td>
                    <td className="p-2 text-center">
                      {act.is_critical ? (
                        <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-800 font-bold text-[10px]">حرج جداً</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-semibold text-[10px]">عادي</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Report Footer & Signatures */}
        <div className="grid grid-cols-3 gap-6 pt-8 border-t border-slate-300 text-xs text-center">
          <div className="space-y-8">
            <p className="font-semibold text-slate-700">مهندس التخطيط والجدولة (Planning Engineer)</p>
            <div className="border-b border-slate-400 w-36 mx-auto" />
          </div>
          <div className="space-y-8">
            <p className="font-semibold text-slate-700">مدير المشروع (Project Manager)</p>
            <div className="border-b border-slate-400 w-36 mx-auto" />
          </div>
          <div className="space-y-8">
            <p className="font-semibold text-slate-700">استشاري المشروع (Consultant Representative)</p>
            <div className="border-b border-slate-400 w-36 mx-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, ActivityLink, BaselineActivity, ActivityResource, DcmaAuditResult } from '@/types';
import { runDcma14PointAudit, autoFixDcmaIssues } from '@/lib/scheduleQualityEngine';
// F9.4 (Controlled Pilot defect 4): the float profile's critical bucket must use the same canonical
// criticality as F5, the dashboard and the Executive Report — not the cached `is_critical` column.
import { summarizeCanonicalCriticality } from '@/lib/scheduleControlEngine';
// GAP-010: one governed Data Date for the audit and for the label that reports it.
import { resolveDataDate } from '@/lib/chronologyGuard';
import { getLanguage, translations, type Language } from '@/lib/i18n';
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Sparkles,
  Award,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Wrench,
  Check,
} from 'lucide-react';

interface DcmaAuditViewProps {
  project: Project | null;
}

export default function DcmaAuditView({ project }: DcmaAuditViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [assignments, setAssignments] = useState<ActivityResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedPoint, setExpandedPoint] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [isFixing, setIsFixing] = useState(false);
  const [lang, setLang] = useState<Language>(getLanguage());

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);

    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, [project]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, linkRes, baselineRes, assignRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('baseline_activities').select('*'),
      supabase.from('activity_resources').select('*').eq('project_id', project.id),
    ]);
    setActivities(actRes.data || []);
    setLinks((linkRes.data || []) as ActivityLink[]);
    setBaselineActivities((baselineRes.data || []) as BaselineActivity[]);
    setAssignments((assignRes.data || []) as ActivityResource[]);
    setLoading(false);
  }

  // The audit runs at the governed Data Date (`project.data_date` or DEFAULT_DATA_DATE), the same
  // resolution the canonical EVM engine uses. The runtime clock is not a project status date, so it
  // can no longer decide which activities are late, and the displayed Data Date is the very date the
  // audit used instead of a second, unrelated literal.
  const dcmaDataDate = resolveDataDate(project);

  // F9.4 (defect 4) — canonical criticality + float profile, one source for all three buckets.
  //
  // The critical bucket used to count the persisted `activities.is_critical` column while the other
  // two buckets counted the persisted `total_float`, so the profile mixed a cached criticality flag
  // with cached float and disagreed with the canonical statused CPM (9 vs 6 in the pilot, where three
  // 100%-complete activities were still flagged critical). All three buckets now come from the same
  // canonical CPM run, so they partition the same activity set on the same evidence.
  const criticality = useMemo(
    () => summarizeCanonicalCriticality(activities, links, {
      dataDate: dcmaDataDate,
      calendarType: project?.calendar_type || '6_days',
      statusLogic: project?.status_logic || 'retained_logic',
    }),
    [activities, links, dcmaDataDate, project?.calendar_type, project?.status_logic],
  );
  const floatProfile = useMemo(() => {
    let critical = 0;
    let near = 0;
    let loose = 0;
    for (const a of activities) {
      const c = criticality.byId.get(a.id);
      if (!c) continue;
      if (c.critical) critical += 1;
      else if (c.totalFloat <= 14) near += 1;
      else loose += 1;
    }
    return { critical, near, loose };
  }, [activities, criticality]);

  const audit: DcmaAuditResult = useMemo(() => {
    return runDcma14PointAudit(
      activities,
      links,
      baselineActivities,
      assignments,
      dcmaDataDate,
      // GAP-015: Point 11 recomputes the network with the CPM engine, so it must run on the
      // project's own calendar and status logic instead of the engine defaults.
      { calendarType: project?.calendar_type, statusLogic: project?.status_logic },
    );
  }, [activities, links, baselineActivities, assignments, dcmaDataDate, project?.calendar_type, project?.status_logic]);

  async function handleAutoFix(fixType: any = 'all') {
    if (!project) return;
    setIsFixing(true);
    try {
      const result = await autoFixDcmaIssues(
        project.id,
        fixType,
        activities,
        links,
        project.calendar_type || '6_days'
      );
      // Immediately set the updated data into state so all cards & scores refresh instantly!
      setActivities(result.updatedActivities);
      setLinks(result.updatedLinks);
      if (result.updatedAssignments) {
        setAssignments(result.updatedAssignments);
      }
      setMessage(result.message);
      // Also reload from database to ensure 100% persistence verification
      await loadData();
    } catch (err: any) {
      setMessage(`خطأ أثناء المعالجة: ${err?.message || 'خطأ غير معروف'}`);
    } finally {
      setIsFixing(false);
    }
  }

  const t = translations[lang];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-600"></div>
      </div>
    );
  }

  const getStatusColor = (st: string) => {
    switch (st) {
      case 'pass':
        return 'bg-emerald-50 text-emerald-800 border-emerald-200';
      case 'warning':
        return 'bg-amber-50 text-amber-800 border-amber-200';
      default:
        return 'bg-rose-50 text-rose-800 border-rose-200';
    }
  };

  const getStatusIcon = (st: string) => {
    switch (st) {
      case 'pass':
        return <CheckCircle2 size={16} className="text-emerald-600" />;
      case 'warning':
        return <AlertTriangle size={16} className="text-amber-600" />;
      default:
        return <XCircle size={16} className="text-rose-600" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
              <ShieldCheck className="text-amber-500" size={24} />
              {lang === 'ar' ? 'فاحص جودة الجدول ومحرك التصحيح الآلي (DCMA 14-Point & Auto-Fix)' : 'DCMA 14-Point Quality Audit & Auto-Fix Engine'}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              AACE / SCL Standard
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'فحص سلامة منطق شبكة المسار الحرج (CPM) مع مقترحات وتصحيحات هندسية آلية بضغطة زر واحدة.'
              : 'Automated CPM network integrity audit with one-click engineering corrections & standard recommendations.'}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Master Auto-Fix Button */}
          <button
            onClick={() => void handleAutoFix('all')}
            disabled={isFixing}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 px-4 py-2 rounded-xl text-xs font-black shadow-md shadow-amber-500/20 transition-all disabled:opacity-50 cursor-pointer"
          >
            <Wrench size={14} className={isFixing ? 'animate-spin' : ''} />
            <span>{isFixing ? (lang === 'ar' ? 'جاري التصحيح وإعادة الحساب...' : 'Repairing & Recalculating...') : t.auto_fix_all}</span>
          </button>

          <button
            onClick={() => void loadData()}
            className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-3.5 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer"
          >
            <RefreshCw size={13} />
            {t.recheck}
          </button>
        </div>
      </div>

      {message && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl text-xs font-bold flex items-center justify-between shadow-sm animate-fadeIn">
          <span>{message}</span>
          <button onClick={() => setMessage('')} className="text-emerald-600 hover:text-emerald-800 font-bold text-base">×</button>
        </div>
      )}

      {/* Main Score Hero Card */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Score Card */}
        <div className="md:col-span-1 bg-gradient-to-br from-slate-900 to-slate-800 text-white p-5 rounded-xl shadow-sm border border-slate-700 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-slate-300 mb-2">
              <span className="font-bold">{lang === 'ar' ? 'درجة جودة الجدول الكلية' : 'Overall Schedule Quality'}</span>
              <Award size={18} className="text-amber-400" />
            </div>
            <div className="text-4xl font-black tracking-tight text-white mb-1">
              {audit.score}
              <span className="text-lg font-normal text-slate-400">/100</span>
            </div>
            <p className="text-xs text-amber-300 font-bold">
              {audit.score >= 90
                ? (lang === 'ar' ? '⭐ ممتاز (مطابق للمواصفات العالمية)' : '⭐ Excellent (Industry Compliant)')
                : audit.score >= 75
                ? (lang === 'ar' ? '⚠️ مقبول مع مقترحات تحسين' : '⚠️ Acceptable with warnings')
                : (lang === 'ar' ? '❌ يتطلب تصحيحاً هندسياً' : '❌ Actionable Deficiencies Found')}
            </p>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-700/60 text-[11px] text-slate-300">
            {audit.summary}
          </div>
        </div>

        {/* Breakdown Stats */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center items-center text-center">
          <CheckCircle2 size={28} className="text-emerald-500 mb-1" />
          <div className="text-2xl font-black text-slate-800">{audit.totalPassed} / 14</div>
          <span className="text-xs text-slate-500 font-bold mt-0.5">{lang === 'ar' ? 'معايير ناجحة تماماً' : 'Passed Points'}</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center items-center text-center">
          <AlertTriangle size={28} className="text-amber-500 mb-1" />
          <div className="text-2xl font-black text-amber-700">{audit.totalWarnings} / 14</div>
          <span className="text-xs text-slate-500 font-bold mt-0.5">{lang === 'ar' ? 'معايير بتنبيهات تحسين' : 'Warning Points'}</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center items-center text-center">
          <XCircle size={28} className="text-rose-500 mb-1" />
          <div className="text-2xl font-black text-rose-700">{audit.totalFailed} / 14</div>
          <span className="text-xs text-slate-500 font-bold mt-0.5">{lang === 'ar' ? 'معايير مخالفة' : 'Failed Points'}</span>
        </div>
      </div>

      {/* Acumen Fuse Schedule Diagnostics Hero Module */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
              <h3 className="text-sm font-black text-slate-900">
                {lang === 'ar' ? 'تشخيصات أكومان فيوز المتقدمة (Acumen Fuse Schedule Diagnostics)' : 'Deltek Acumen Fuse Diagnostics'}
              </h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-black bg-amber-100 text-amber-900 border border-amber-200">
                Logic Density & Float Profiling
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {lang === 'ar'
                ? 'تحليل كثافة الروابط المنطقية، توزيع الهامش الزمني (Float Profile)، ومؤشر التزامن لمنع اختناقات التنفيذ.'
                : 'Advanced logic density metrics, total float distributions, and activity concurrency analysis.'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          {/* 1. Logic Density */}
          <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-600 font-bold">{lang === 'ar' ? 'كثافة المنطق (Logic Density)' : 'Logic Density'}</span>
              <span className="font-mono text-[10px] bg-slate-200 px-1.5 py-0.5 rounded font-bold">Target ≥ 2.0</span>
            </div>
            <div className="text-2xl font-black text-slate-900 font-mono">
              {activities.length > 0 ? (links.length / activities.length).toFixed(2) : '0.00'}
            </div>
            <p className="text-[10px] text-slate-500">
              {lang === 'ar'
                ? `إجمالي ${links.length} علاقة على ${activities.length} نشاط (معدل ممتاز ومتزن للشبكة)`
                : `${links.length} links across ${activities.length} activities.`}
            </p>
          </div>

          {/* 2. Float Distribution Profile */}
          <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
            <span className="text-slate-600 font-bold block">{lang === 'ar' ? 'توزيع الهامش الزمني (Float Profile)' : 'Float Distribution'}</span>
            <div className="grid grid-cols-3 gap-1 text-center font-mono text-[10px]">
              <div className="bg-rose-50 border border-rose-200 p-1 rounded">
                <span className="text-rose-700 font-bold block">حرج (0d)</span>
                <span className="font-black text-rose-950">{floatProfile.critical}</span>
              </div>
              <div className="bg-amber-50 border border-amber-200 p-1 rounded">
                <span className="text-amber-700 font-bold block">1-14d</span>
                <span className="font-black text-amber-950">{floatProfile.near}</span>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 p-1 rounded">
                <span className="text-emerald-700 font-bold block">&gt; 14d</span>
                <span className="font-black text-emerald-950">{floatProfile.loose}</span>
              </div>
            </div>
          </div>

          {/* 3. Concurrency Index */}
          <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-600 font-bold">{lang === 'ar' ? 'مؤشر التزامن (Concurrency)' : 'Concurrency Index'}</span>
              <span className="font-mono text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold">Optimal</span>
            </div>
            <div className="text-2xl font-black text-slate-900 font-mono">
              3.4 <span className="text-xs text-slate-500 font-normal">أنشطة متزامنة/أسبوع</span>
            </div>
            <p className="text-[10px] text-slate-500">
              {lang === 'ar' ? 'توزيع متوازن للأعمال لتفادي ازدحام الموارد بموقع العمل' : 'Balanced resource peak concurrency'}
            </p>
          </div>
        </div>
      </div>

      {/* DCMA 14-Point Table and Details */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-bold text-slate-900 text-sm">
            {lang === 'ar'
              ? 'تفاصيل المعايير الأربعة عشر ومقترحات التصحيح (DCMA 14-Point & Corrective Proposals)'
              : '14-Point Checklist & Engineering Recommendations'}
          </h3>
          <span className="text-xs text-slate-500 font-bold">{lang === 'ar' ? 'تاريخ خط الحالة:' : 'Data Date:'} {dcmaDataDate}</span>
        </div>

        <div className="divide-y divide-slate-100">
          {audit.points.map((pt) => {
            const isExpanded = expandedPoint === pt.id;
            return (
              <div key={pt.id} className="transition-colors">
                <div
                  onClick={() => setExpandedPoint(isExpanded ? null : pt.id)}
                  className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50/80 gap-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-7 h-7 rounded-full bg-slate-900 text-amber-400 font-black text-xs flex items-center justify-center border border-slate-800">
                      {pt.id}
                    </span>
                    <div>
                      <div className="font-bold text-slate-900 text-xs flex items-center gap-2">
                        <span>{lang === 'ar' ? pt.nameAr : pt.name}</span>
                        <span className="text-[10px] text-slate-400 font-mono font-normal">({lang === 'ar' ? pt.name : pt.nameAr})</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">{pt.description}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 flex-shrink-0">
                    <div className="text-left">
                      <div className="text-[10px] text-slate-400 font-mono">{lang === 'ar' ? 'الهدف:' : 'Target:'} {pt.target}</div>
                      <div className="text-xs font-bold text-slate-800">{pt.actualValue}</div>
                    </div>

                    <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border ${getStatusColor(pt.status)}`}>
                      {getStatusIcon(pt.status)}
                      <span>{pt.status === 'pass' ? t.status_pass : pt.status === 'warning' ? t.status_warning : t.status_fail}</span>
                    </div>

                    {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                  </div>
                </div>

                {/* Expanded Details / Violations & Recommendation */}
                {isExpanded && (
                  <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 text-xs space-y-3">
                    {/* Standard Engineering Recommendation */}
                    {pt.recommendation && (
                      <div className="p-3.5 bg-blue-50/90 border border-blue-200 rounded-xl text-blue-950 space-y-1">
                        <div className="flex items-center gap-1.5 font-bold text-xs text-blue-900">
                          <Sparkles size={14} className="text-blue-600" />
                          <span>{t.recommendation_title}</span>
                        </div>
                        <p className="text-[11px] leading-relaxed text-blue-900">{pt.recommendation}</p>
                      </div>
                    )}

                    {/* Auto-Fix Trigger for this specific point if available */}
                    {pt.autoFixType && pt.status !== 'pass' && (
                      <div className="flex justify-end pt-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleAutoFix(pt.autoFixType);
                          }}
                          disabled={isFixing}
                          className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 px-3.5 py-1.5 rounded-lg text-xs font-black shadow-sm transition-all cursor-pointer"
                        >
                          <Wrench size={12} />
                          <span>{t.auto_fix_point}</span>
                        </button>
                      </div>
                    )}

                    {/* Detected items list */}
                    {pt.details.length > 0 && (
                      <div>
                        <p className="font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                          <AlertTriangle size={13} className="text-amber-600" />
                          {lang === 'ar' ? `الأنشطة والعلاقات المرصودة (${pt.details.length}):` : `Detected Items (${pt.details.length}):`}
                        </p>
                        <ul className="list-disc list-inside space-y-1 text-slate-600 pr-2 font-mono text-[11px]">
                          {pt.details.map((d, i) => (
                            <li key={i}>{d}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

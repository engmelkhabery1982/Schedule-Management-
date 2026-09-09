import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Project,
  Activity,
  BaselineActivity,
  ProjectBaseline,
  ScheduleDiffResult,
  ActivityDiffItem,
} from '@/types';
import { getLanguage, translations, type Language } from '@/lib/i18n';
import {
  GitCompare,
  Search,
  Camera,
  Calendar,
  Clock,
  Zap,
} from 'lucide-react';

interface ScheduleDiffViewProps {
  project: Project | null;
}

interface ScheduleRevision {
  id: string;
  name: string;
  createdAt: string;
  activitiesSnapshot: {
    id: string;
    code: string;
    name: string;
    duration_days: number;
    start_date: string | null;
    end_date: string | null;
    total_float?: number;
    is_critical: boolean;
    percent_complete: number;
  }[];
}

export default function ScheduleDiffView({ project }: ScheduleDiffViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [baselines, setBaselines] = useState<ProjectBaseline[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [revisions, setRevisions] = useState<ScheduleRevision[]>([]);
  const [selectedRevAId, setSelectedRevAId] = useState<string>('baseline_rev0');
  const [selectedRevBId, setSelectedRevBId] = useState<string>('live_schedule');
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<'all' | 'modified_only' | 'slippage_only' | 'critical_only'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [message, setMessage] = useState('');
  const [isSnapshotting, setIsSnapshotting] = useState(false);
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
    const [actRes, baseRes, baseActRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order'),
      supabase.from('project_baselines').select('*').eq('project_id', project.id),
      supabase.from('baseline_activities').select('*'),
    ]);

    const acts = actRes.data || [];
    setActivities(acts);
    setBaselines((baseRes.data || []) as ProjectBaseline[]);
    setBaselineActivities((baseActRes.data || []) as BaselineActivity[]);

    // Load custom revisions from localStorage
    const revStorageKey = `schedule_diff_revisions_${project.id}`;
    const storedRevs: ScheduleRevision[] = JSON.parse(localStorage.getItem(revStorageKey) || '[]');

    if (storedRevs.length === 0 && acts.length > 0) {
      const initialRevs: ScheduleRevision[] = [
        {
          id: 'rev_oct_2026',
          name: 'Rev 01 - تحديث شهر أكتوبر 2026 (Cut-off M1)',
          createdAt: '2026-10-31',
          activitiesSnapshot: acts.map((a, idx) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            duration_days: a.duration_days,
            start_date: a.early_start,
            end_date: a.early_finish,
            total_float: idx < 3 ? 0 : 5,
            is_critical: idx < 3,
            percent_complete: idx === 0 ? 100 : idx === 1 ? 80 : 0,
          })),
        },
        {
          id: 'rev_nov_2026',
          name: 'Rev 02 - تحديث شهر نوفمبر 2026 (Cut-off M2)',
          createdAt: '2026-11-30',
          activitiesSnapshot: acts.map((a, idx) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            duration_days: idx === 2 ? a.duration_days + 4 : a.duration_days,
            start_date: a.early_start,
            end_date: idx === 2 && a.early_finish ? new Date(new Date(a.early_finish).getTime() + 4 * 86400000).toISOString().split('T')[0] : a.early_finish,
            total_float: idx === 2 ? 0 : a.total_float || 0,
            is_critical: a.is_critical,
            percent_complete: idx < 2 ? 100 : idx === 2 ? 40 : 0,
          })),
        },
      ];
      localStorage.setItem(revStorageKey, JSON.stringify(initialRevs));
      setRevisions(initialRevs);
    } else {
      setRevisions(storedRevs);
    }

    setLoading(false);
  }

  const t = translations[lang];

  function handleCreateSnapshot() {
    if (!project || activities.length === 0) return;
    setIsSnapshotting(true);
    const defaultName = lang === 'ar'
      ? `Rev 0${revisions.length + 1} - لقطة بتاريخ ${new Date().toISOString().split('T')[0]}`
      : `Rev 0${revisions.length + 1} - Snapshot ${new Date().toISOString().split('T')[0]}`;
    const snapName = prompt(lang === 'ar' ? 'أدخل اسم أو وصف النسخة المحفوظة:' : 'Enter revision snapshot title:', defaultName);
    if (!snapName) {
      setIsSnapshotting(false);
      return;
    }

    const newRev: ScheduleRevision = {
      id: `rev_${Date.now()}`,
      name: snapName,
      createdAt: new Date().toISOString().split('T')[0],
      activitiesSnapshot: activities.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        duration_days: a.duration_days,
        start_date: a.early_start,
        end_date: a.early_finish,
        total_float: a.total_float,
        is_critical: a.is_critical,
        percent_complete: a.percent_complete,
      })),
    };

    const updated = [newRev, ...revisions];
    setRevisions(updated);
    localStorage.setItem(`schedule_diff_revisions_${project.id}`, JSON.stringify(updated));
    setSelectedRevBId(newRev.id);
    setMessage(lang === 'ar' ? `تم حفظ لقطة الجدول الزمني (${snapName}) وتفعيلها في المقارنة.` : `Snapshot (${snapName}) saved and activated in comparison.`);
    setIsSnapshotting(false);
  }

  const getRevisionActivities = (revId: string) => {
    if (revId === 'live_schedule') {
      return activities.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        duration_days: a.duration_days,
        start_date: a.early_start,
        end_date: a.early_finish,
        total_float: a.total_float || 0,
        is_critical: a.is_critical,
        percent_complete: a.percent_complete,
      }));
    }
    if (revId === 'baseline_rev0') {
      return activities.map((a) => {
        const base = baselineActivities.find((b) => b.activity_id === a.id);
        return {
          id: a.id,
          code: a.code,
          name: a.name,
          duration_days: base ? base.duration_days : a.duration_days,
          start_date: base ? base.early_start : a.early_start,
          end_date: base ? base.early_finish : a.early_finish,
          total_float: 0,
          is_critical: a.is_critical,
          percent_complete: 0,
        };
      });
    }
    const foundRev = revisions.find((r) => r.id === revId);
    if (foundRev) return foundRev.activitiesSnapshot;
    return [];
  };

  const diffResult: ScheduleDiffResult = useMemo(() => {
    const listA = getRevisionActivities(selectedRevAId);
    const listB = getRevisionActivities(selectedRevBId);

    const nameA = selectedRevAId === 'baseline_rev0'
      ? (lang === 'ar' ? 'خط الأساس المعتمد (Baseline Rev 0)' : 'Approved Baseline (Rev 0)')
      : selectedRevAId === 'live_schedule'
      ? (lang === 'ar' ? 'الجدول الحالي المحدث' : 'Live CPM Schedule')
      : revisions.find((r) => r.id === selectedRevAId)?.name || selectedRevAId;

    const nameB = selectedRevBId === 'live_schedule'
      ? (lang === 'ar' ? 'الجدول الحالي المحدث (Live CPM Schedule)' : 'Live CPM Schedule')
      : selectedRevBId === 'baseline_rev0'
      ? (lang === 'ar' ? 'خط الأساس المعتمد (Baseline Rev 0)' : 'Approved Baseline (Rev 0)')
      : revisions.find((r) => r.id === selectedRevBId)?.name || selectedRevBId;

    const mapA = new Map(listA.map((a) => [a.code, a]));
    const mapB = new Map(listB.map((a) => [a.code, a]));

    let addedCount = 0;
    let deletedCount = 0;
    let modifiedCount = 0;
    let criticalityShiftCount = 0;
    const diffItems: ActivityDiffItem[] = [];

    const allCodes = Array.from(new Set([...Array.from(mapA.keys()), ...Array.from(mapB.keys())]));

    allCodes.forEach((code) => {
      const actA = mapA.get(code);
      const actB = mapB.get(code);

      if (!actA && actB) {
        addedCount++;
        diffItems.push({
          activityId: actB.id,
          code: actB.code,
          name: actB.name,
          diffType: 'added',
          startBaseline: null,
          startCurrent: actB.start_date,
          startVarianceDays: 0,
          finishBaseline: null,
          finishCurrent: actB.end_date,
          finishVarianceDays: 0,
          durationBaseline: 0,
          durationCurrent: actB.duration_days,
          durationVarianceDays: actB.duration_days,
          totalFloatBaseline: 0,
          totalFloatCurrent: actB.total_float || 0,
          totalFloatVarianceDays: 0,
          criticalityBaseline: false,
          criticalityCurrent: actB.is_critical,
          criticalityShift: actB.is_critical ? 'became_critical' : 'unchanged',
          percentBaseline: 0,
          percentCurrent: actB.percent_complete,
        });
      } else if (actA && !actB) {
        deletedCount++;
        diffItems.push({
          activityId: actA.id,
          code: actA.code,
          name: actA.name,
          diffType: 'deleted',
          startBaseline: actA.start_date,
          startCurrent: null,
          startVarianceDays: 0,
          finishBaseline: actA.end_date,
          finishCurrent: null,
          finishVarianceDays: 0,
          durationBaseline: actA.duration_days,
          durationCurrent: 0,
          durationVarianceDays: -actA.duration_days,
          totalFloatBaseline: actA.total_float || 0,
          totalFloatCurrent: 0,
          totalFloatVarianceDays: 0,
          criticalityBaseline: actA.is_critical,
          criticalityCurrent: false,
          criticalityShift: actA.is_critical ? 'became_non_critical' : 'unchanged',
          percentBaseline: actA.percent_complete,
          percentCurrent: 0,
        });
      } else if (actA && actB) {
        const startVar = actA.start_date && actB.start_date
          ? Math.round((new Date(actB.start_date).getTime() - new Date(actA.start_date).getTime()) / 86400000)
          : 0;
        const finishVar = actA.end_date && actB.end_date
          ? Math.round((new Date(actB.end_date).getTime() - new Date(actA.end_date).getTime()) / 86400000)
          : 0;
        const durVar = actB.duration_days - actA.duration_days;
        const floatVar = (actB.total_float || 0) - (actA.total_float || 0);

        const isCritChanged = actA.is_critical !== actB.is_critical;
        if (isCritChanged) criticalityShiftCount++;

        const isModified = startVar !== 0 || finishVar !== 0 || durVar !== 0 || isCritChanged || actA.percent_complete !== actB.percent_complete;
        if (isModified) modifiedCount++;

        diffItems.push({
          activityId: actB.id,
          code: actB.code,
          name: actB.name,
          diffType: isModified ? 'modified' : 'unchanged',
          startBaseline: actA.start_date,
          startCurrent: actB.start_date,
          startVarianceDays: startVar,
          finishBaseline: actA.end_date,
          finishCurrent: actB.end_date,
          finishVarianceDays: finishVar,
          durationBaseline: actA.duration_days,
          durationCurrent: actB.duration_days,
          durationVarianceDays: durVar,
          totalFloatBaseline: actA.total_float || 0,
          totalFloatCurrent: actB.total_float || 0,
          totalFloatVarianceDays: floatVar,
          criticalityBaseline: actA.is_critical,
          criticalityCurrent: actB.is_critical,
          criticalityShift: !actA.is_critical && actB.is_critical ? 'became_critical' : actA.is_critical && !actB.is_critical ? 'became_non_critical' : 'unchanged',
          percentBaseline: actA.percent_complete,
          percentCurrent: actB.percent_complete,
        });
      }
    });

    const maxFinishA = listA.reduce((max, a) => !a.end_date ? max : !max || a.end_date > max ? a.end_date : max, null as string | null);
    const maxFinishB = listB.reduce((max, a) => !a.end_date ? max : !max || a.end_date > max ? a.end_date : max, null as string | null);
    const projectFinishVarianceDays = maxFinishA && maxFinishB
      ? Math.round((new Date(maxFinishB).getTime() - new Date(maxFinishA).getTime()) / 86400000)
      : 0;

    const summary = projectFinishVarianceDays === 0
      ? (lang === 'ar' ? `تاريخ إنجاز المشروع في (${nameB}) متطابق تماماً مع (${nameA}).` : `Project completion in (${nameB}) is identical to (${nameA}).`)
      : projectFinishVarianceDays > 0
      ? (lang === 'ar' ? `يوجد تأخير كلي قدره +${projectFinishVarianceDays} يوماً في موعد إنهاء المشروع في (${nameB}) مقارنة بـ (${nameA}).` : `Total project slippage of +${projectFinishVarianceDays} days detected in (${nameB}) compared to (${nameA}).`)
      : (lang === 'ar' ? `المشروع متقدم بمقدار ${Math.abs(projectFinishVarianceDays)} يوماً في (${nameB}) مقارنة بـ (${nameA}).` : `Project is ahead by ${Math.abs(projectFinishVarianceDays)} days in (${nameB}) compared to (${nameA}).`);

    return {
      baselineName: nameA,
      currentScheduleName: nameB,
      totalActivitiesCount: allCodes.length,
      addedCount,
      deletedCount,
      modifiedCount,
      criticalityShiftCount,
      projectFinishVarianceDays,
      activities: diffItems,
      summary,
    };
  }, [activities, baselineActivities, revisions, selectedRevAId, selectedRevBId, lang]);

  const filteredItems = useMemo(() => {
    return diffResult.activities.filter((item) => {
      if (filterMode === 'modified_only' && item.diffType !== 'modified' && item.diffType !== 'added') return false;
      if (filterMode === 'slippage_only' && item.finishVarianceDays <= 0) return false;
      if (filterMode === 'critical_only' && !item.criticalityCurrent) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return item.name.toLowerCase().includes(q) || item.code.toLowerCase().includes(q);
      }
      return true;
    });
  }, [diffResult, filterMode, searchQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
              <GitCompare className="text-amber-500" size={24} />
              {t.diff_title}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              Revision Matrix
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t.diff_subtitle}
          </p>
        </div>

        {/* Action Button to Take Snapshot */}
        <button
          onClick={handleCreateSnapshot}
          disabled={isSnapshotting}
          className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm cursor-pointer"
        >
          <Camera size={15} />
          {t.save_snapshot}
        </button>
      </div>

      {message && (
        <div className="p-3.5 bg-blue-50 border border-blue-200 text-blue-900 rounded-xl text-xs font-bold flex items-center justify-between shadow-sm animate-fadeIn">
          <span>{message}</span>
          <button onClick={() => setMessage('')} className="text-blue-500 hover:text-blue-700 font-bold text-base">×</button>
        </div>
      )}

      {/* Revisions Selectors Toolbar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Version A */}
        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5">
          <label className="block text-xs font-bold text-slate-700">
            {t.rev_a_label}
          </label>
          <select
            value={selectedRevAId}
            onChange={(e) => setSelectedRevAId(e.target.value)}
            className="w-full p-2 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer"
          >
            <option value="baseline_rev0">{lang === 'ar' ? 'خط الأساس الأصلي المعتمد (Baseline Rev 0)' : 'Approved Baseline (Rev 0)'}</option>
            {revisions.map((rev) => (
              <option key={rev.id} value={rev.id}>{rev.name} ({rev.createdAt})</option>
            ))}
            <option value="live_schedule">{lang === 'ar' ? 'الجدول الزمني الحي (Live Schedule)' : 'Live Schedule'}</option>
          </select>
        </div>

        {/* Version B */}
        <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200 space-y-1.5">
          <label className="block text-xs font-bold text-amber-950">
            {t.rev_b_label}
          </label>
          <select
            value={selectedRevBId}
            onChange={(e) => setSelectedRevBId(e.target.value)}
            className="w-full p-2 bg-white border border-amber-300 rounded-lg text-xs font-black text-amber-950 outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer"
          >
            <option value="live_schedule">{lang === 'ar' ? 'الجدول الزمني الحي المحدث (Live CPM Schedule)' : 'Live CPM Schedule'}</option>
            {revisions.map((rev) => (
              <option key={rev.id} value={rev.id}>{rev.name} ({rev.createdAt})</option>
            ))}
            <option value="baseline_rev0">{lang === 'ar' ? 'خط الأساس الأصلي المعتمد (Baseline Rev 0)' : 'Approved Baseline (Rev 0)'}</option>
          </select>
        </div>
      </div>

      {/* Variance KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-bold">{t.project_slip_var}</span>
          <div className={`text-2xl font-black mt-1 ${diffResult.projectFinishVarianceDays > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
            {diffResult.projectFinishVarianceDays > 0 ? `+${diffResult.projectFinishVarianceDays}` : diffResult.projectFinishVarianceDays} {lang === 'ar' ? 'يوم' : 'Days'}
          </div>
          <span className="text-[10px] text-slate-400">{lang === 'ar' ? 'مقارنة بين النسختين' : 'Between selected revisions'}</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-bold">{t.modified_activities}</span>
          <div className="text-2xl font-black text-slate-900 mt-1">{diffResult.modifiedCount}</div>
          <span className="text-[10px] text-slate-400">{lang === 'ar' ? `من أصل ${diffResult.totalActivitiesCount} نشاط` : `out of ${diffResult.totalActivitiesCount}`}</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-bold">{t.critical_shifts}</span>
          <div className="text-2xl font-black text-amber-600 mt-1">{diffResult.criticalityShiftCount}</div>
          <span className="text-[10px] text-slate-400">{lang === 'ar' ? 'أنشطة تحولت لحرجة' : 'Critical switches'}</span>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 font-bold">{t.added_activities}</span>
          <div className="text-2xl font-black text-emerald-600 mt-1">+{diffResult.addedCount}</div>
          <span className="text-[10px] text-slate-400">{lang === 'ar' ? 'غير موجودة بالنسخة الأولى' : 'New tasks in Rev B'}</span>
        </div>
      </div>

      {/* Summary Banner */}
      <div className="p-4 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-r-4 border-amber-500 rounded-xl bg-white shadow-sm flex items-center justify-between">
        <span className="font-bold text-slate-900 text-xs">{diffResult.summary}</span>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute right-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder={lang === 'ar' ? 'بحث في الأنشطة المعدلة...' : 'Search activities...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-8 pl-3 py-1.5 border border-slate-300 rounded-lg bg-white text-xs w-60 outline-none focus:border-amber-500 font-medium"
            />
          </div>

          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-0.5">
            <button
              onClick={() => setFilterMode('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                filterMode === 'all' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.filter_all} ({diffResult.activities.length})
            </button>
            <button
              onClick={() => setFilterMode('modified_only')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                filterMode === 'modified_only' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.filter_modified} ({diffResult.modifiedCount})
            </button>
            <button
              onClick={() => setFilterMode('slippage_only')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                filterMode === 'slippage_only' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.filter_slippage}
            </button>
            <button
              onClick={() => setFilterMode('critical_only')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                filterMode === 'critical_only' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.filter_critical}
            </button>
          </div>
        </div>
      </div>

      {/* Comparison Grid Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-bold">
              <tr>
                <th className="p-3 text-right">{t.activity_code}</th>
                <th className="p-3 text-right">{t.activity_name}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'بداية النسخة (A)' : 'Start (Rev A)'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'بداية النسخة (B)' : 'Start (Rev B)'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'نهاية النسخة (A)' : 'Finish (Rev A)'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'نهاية النسخة (B)' : 'Finish (Rev B)'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'انحراف النهاية (FV)' : 'Finish Var (FV)'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'مدة (A)' : 'Dur (A)'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'مدة (B)' : 'Dur (B)'}</th>
                <th className="p-3 text-center">{t.critical}</th>
                <th className="p-3 text-center">{lang === 'ar' ? 'حالة التغيير' : 'Diff Status'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {filteredItems.map((item) => (
                <tr key={item.activityId} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 font-mono font-bold text-slate-700">{item.code}</td>
                  <td className="p-3 font-bold text-slate-800 max-w-xs truncate">{item.name}</td>
                  <td className="p-3 font-mono text-slate-500">{item.startBaseline || '-'}</td>
                  <td className="p-3 font-mono text-slate-900 font-bold">{item.startCurrent || '-'}</td>
                  <td className="p-3 font-mono text-slate-500">{item.finishBaseline || '-'}</td>
                  <td className="p-3 font-mono text-slate-900 font-bold">{item.finishCurrent || '-'}</td>
                  <td className="p-3 font-mono font-black">
                    {item.finishVarianceDays > 0 ? (
                      <span className="text-rose-600">+{item.finishVarianceDays} {lang === 'ar' ? 'يوم' : 'd'}</span>
                    ) : item.finishVarianceDays < 0 ? (
                      <span className="text-emerald-600">{item.finishVarianceDays} {lang === 'ar' ? 'يوم' : 'd'}</span>
                    ) : (
                      <span className="text-slate-400">0 {lang === 'ar' ? 'يوم' : 'd'}</span>
                    )}
                  </td>
                  <td className="p-3 text-slate-500">{item.durationBaseline} {lang === 'ar' ? 'يوم' : 'd'}</td>
                  <td className="p-3 font-bold text-slate-900">{item.durationCurrent} {lang === 'ar' ? 'يوم' : 'd'}</td>
                  <td className="p-3 text-center">
                    {item.criticalityCurrent ? (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-rose-100 text-rose-700 font-bold">{t.critical}</span>
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="p-3 text-center">
                    {item.diffType === 'added' ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-800 font-bold">{lang === 'ar' ? 'مضاف' : 'Added'}</span>
                    ) : item.diffType === 'modified' ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-800 font-bold">{lang === 'ar' ? 'معدل' : 'Modified'}</span>
                    ) : (
                      <span className="text-slate-400 text-[10px]">{lang === 'ar' ? 'مطابق' : 'Unchanged'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

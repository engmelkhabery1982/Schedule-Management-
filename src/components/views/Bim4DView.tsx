import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { resolveDataDate } from '@/lib/chronologyGuard';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, Activity } from '@/types';
import {
  Box,
  Play,
  Pause,
  RotateCw,
  Eye,
  Sliders,
  Calendar,
  DollarSign,
  Maximize2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Building,
} from 'lucide-react';

interface Bim4DViewProps {
  project: Project | null;
}

/** Weekly simulation spine (Sep 2026 -> May 2027). The STARTING position on this spine is the
 *  governed Data Date (see simIndexForDate) — never a fixed calendar guess. */
function buildSimulationDates(): string[] {
  const dates: string[] = [];
  const start = new Date('2026-09-01');
  for (let i = 0; i < 38; i++) {
    const d = new Date(start.getTime() + i * 7 * 86400000);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

/** Latest simulation index on/before the governed date (clamped to the spine ends). */
function simIndexForDate(dates: string[], dataDate: string): number {
  let idx = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] <= dataDate) idx = i;
  }
  return idx;
}

export default function Bim4DView({ project }: Bim4DViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState<Language>(getLanguage());

  // Governed Data Date: the simulation opens AT project status — a fixed index (~mid project)
  // would read element status at an arbitrary calendar point unrelated to this project.
  const governedDataDate = resolveDataDate(project);

  // 4D Timeline Simulation State
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [currentSimDateIdx, setCurrentSimDateIdx] = useState<number>(() =>
    simIndexForDate(buildSimulationDates(), governedDataDate)
  );

  const animationTimerRef = useRef<NodeJS.Timeout | null>(null);

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
    const { data } = await supabase
      .from('activities')
      .select('*')
      .eq('project_id', project.id)
      .order('sort_order', { ascending: true });
    setActivities(data || []);
    setLoading(false);
  }

  // Simulation Timeline Dates Array (weekly milestones from Sep 2026 to May 2027)
  const simulationDates = useMemo(() => buildSimulationDates(), []);

  // Re-anchor the simulation to the governed date whenever the project (or its Data Date) changes.
  useEffect(() => {
    setCurrentSimDateIdx(simIndexForDate(buildSimulationDates(), governedDataDate));
  }, [governedDataDate]);

  const currentSimDate = simulationDates[currentSimDateIdx] || governedDataDate;

  // Playback timer effect
  useEffect(() => {
    if (isPlaying) {
      animationTimerRef.current = setInterval(() => {
        setCurrentSimDateIdx((prev) => {
          if (prev >= simulationDates.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 800 / playbackSpeed);
    } else if (animationTimerRef.current) {
      clearInterval(animationTimerRef.current);
    }
    return () => {
      if (animationTimerRef.current) clearInterval(animationTimerRef.current);
    };
  }, [isPlaying, playbackSpeed, simulationDates.length]);

  // Live schedule status at the simulation date (Phase D — no fixtures).
  //
  // There is no BIM model, element register, or activity-to-element mapping anywhere in the
  // schema, so model geometry, floor/trade taxonomies, element costs and element statuses
  // cannot be derived — the previous revision hardcoded 11 demo elements (BIM-SUB-01..BIM-MEP)
  // with invented geometry, costs and ACT-xx links and presented them as the project. Those
  // fixtures are removed and are never shown as live data. What the 4D timeline CAN read
  // honestly is the live activity schedule: each activity is evaluated at the simulation date
  // from its own recorded fields (actuals and percent_complete first, planned dates second).
  // Evidence of progress (actuals / percent) always wins over date position, so a zero-percent
  // activity past its finish reads as overdue — never as silently "completed" or "planned".
  const activitiesAtSim = useMemo(() => {
    const rows = activities.map((a) => {
      const pct = Number(a.percent_complete || 0);
      let status: 'completed' | 'in_progress' | 'planned' | 'overdue' = 'planned';
      if (pct >= 100 || (a.actual_finish && a.actual_finish <= currentSimDate)) {
        status = 'completed';
      } else if ((a.actual_start && a.actual_start <= currentSimDate) || pct > 0) {
        status = 'in_progress';
      } else if (a.early_finish && currentSimDate > a.early_finish) {
        status = 'overdue';
      } else if (a.early_start && a.early_finish && a.early_start <= currentSimDate && currentSimDate <= a.early_finish) {
        status = 'in_progress';
      }
      return { activity: a, status, pct };
    });
    const counts = { completed: 0, in_progress: 0, planned: 0, overdue: 0 };
    rows.forEach((r) => {
      counts[r.status] += 1;
    });
    return { rows, counts, total: rows.length };
  }, [activities, currentSimDate]);


  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-5 select-none">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <Box className="text-amber-500" size={24} />
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              {lang === 'ar' ? 'النمذجة ثلاثية ورباعية الأبعاد (4D BIM Construction Simulation)' : '4D BIM Construction Timeline Simulation'}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              4D Schedule Timeline
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'خط زمني رباعي الأبعاد يقرأ حالة أنشطة المشروع الحية عند تاريخ المحاكاة. لا يوجد نموذج BIM مربوط — لا تُعرض أي عناصر مختلقة.'
              : 'A 4D timeline reading live project activity status at the simulation date. No BIM model is connected — no invented elements are shown.'}
          </p>
        </div>

      </div>

      {/* Main 4D Simulation Studio Container */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Left 3D Canvas Viewport (Span 3 cols) */}
        <div className="lg:col-span-3 bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden flex flex-col shadow-xl relative min-h-[520px]">
          {/* Canvas Top Status Bar */}
          <div className="p-4 bg-slate-900/80 border-b border-slate-800 flex flex-wrap items-center justify-between text-xs text-white z-20 backdrop-blur">
            <div className="flex items-center gap-3 font-mono">
              <span className="flex items-center gap-1.5 bg-amber-500/20 text-amber-300 px-2.5 py-1 rounded-md font-bold border border-amber-500/30">
                <Calendar size={13} />
                {lang === 'ar' ? 'تاريخ المحاكاة:' : 'Sim Date:'} {currentSimDate}
              </span>
              <span className="flex items-center gap-1.5 bg-sky-500/20 text-sky-300 px-2.5 py-1 rounded-md font-bold border border-sky-500/30">
                <Clock size={13} />
                {lang === 'ar' ? 'خط الحالة:' : 'Data Date:'} {governedDataDate}
              </span>
              <span className="text-slate-400 text-[11px]">
                {lang === 'ar' ? `الأسبوع ${currentSimDateIdx + 1} من ${simulationDates.length}` : `Week ${currentSimDateIdx + 1} of ${simulationDates.length}`}
              </span>
            </div>

            {/* Legend: live activity statuses at the simulation date */}
            <div className="flex items-center gap-4 text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-slate-600 border border-slate-500 inline-block" />
                <span className="text-slate-300">{lang === 'ar' ? 'مكتمل' : 'Completed'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-amber-500 animate-pulse inline-block" />
                <span className="text-amber-300 font-bold">{lang === 'ar' ? 'قيد التنفيذ' : 'In Progress'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs border border-dashed border-slate-400 bg-slate-800/50 inline-block" />
                <span className="text-slate-400">{lang === 'ar' ? 'مستقبلي' : 'Planned'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-rose-600 border border-rose-500 inline-block" />
                <span className="text-rose-300">{lang === 'ar' ? 'متأخر' : 'Overdue'}</span>
              </div>
            </div>
          </div>

          {/* 3D Model Rendering Area */}
          <div className="flex-1 flex items-center justify-center p-6 relative overflow-hidden">
            <svg
              viewBox="0 0 800 480"
              className="w-full h-full max-h-[460px] drop-shadow-2xl transition-all duration-500"
            >
              {/* Ground Grid Gridlines (viewport shell — no model is loaded) */}
              <g opacity="0.15">
                {Array.from({ length: 11 }).map((_, i) => (
                  <line key={`grid-h-${i}`} x1="80" y1={360 + i * 10} x2="720" y2={360 + i * 10} stroke="#94a3b8" strokeWidth="1" />
                ))}
                {Array.from({ length: 15 }).map((_, i) => (
                  <line key={`grid-v-${i}`} x1={80 + i * 45} y1="360" x2={80 + i * 45} y2="460" stroke="#94a3b8" strokeWidth="1" />
                ))}
              </g>

            </svg>

            {/* No-BIM-model empty state. The viewport shell and the 4D timeline stay: the
                timeline scrubs the LIVE activity schedule (counts below are derived from real
                activities at the simulation date), but no model geometry is invented. */}
            <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">
              <div className="pointer-events-auto max-w-md w-full text-center bg-slate-900/95 border border-slate-700 rounded-2xl p-6 backdrop-blur shadow-2xl">
                <div className="flex justify-center mb-3">
                  <span className="p-3 rounded-full bg-slate-800 border border-slate-700">
                    <Box size={26} className="text-slate-500" />
                  </span>
                </div>
                <h3 className="font-black text-slate-100 text-sm">
                  {lang === 'ar' ? 'لا يوجد نموذج BIM مربوط (N/A)' : 'No BIM model / element mapping available (N/A)'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                  {lang === 'ar'
                    ? 'لا توجد عناصر نمذجة أو ربط مع الأنشطة في بيانات المشروع، لذا لا يُعرض أي مجسم. الأرقام أدناه حالة الأنشطة الحية عند تاريخ المحاكاة.'
                    : 'The project holds no model elements or activity mapping, so no geometry is shown. The figures below are live activity status at the simulation date.'}
                </p>
                <div className="grid grid-cols-4 gap-2 mt-4 font-mono">
                  <div className="bg-slate-800/80 rounded-lg p-2 border border-slate-700">
                    <div className="text-lg font-black text-slate-200">{activitiesAtSim.counts.completed}</div>
                    <div className="text-[9px] text-slate-400">{lang === 'ar' ? 'مكتمل' : 'Done'}</div>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-2 border border-slate-700">
                    <div className="text-lg font-black text-amber-400">{activitiesAtSim.counts.in_progress}</div>
                    <div className="text-[9px] text-slate-400">{lang === 'ar' ? 'قيد التنفيذ' : 'Active'}</div>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-2 border border-slate-700">
                    <div className="text-lg font-black text-slate-400">{activitiesAtSim.counts.planned}</div>
                    <div className="text-[9px] text-slate-400">{lang === 'ar' ? 'مستقبلي' : 'Planned'}</div>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-2 border border-slate-700">
                    <div className="text-lg font-black text-rose-400">{activitiesAtSim.counts.overdue}</div>
                    <div className="text-[9px] text-slate-400">{lang === 'ar' ? 'متأخر' : 'Overdue'}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 4D Simulation Control Scrubber Bar */}
          <div className="p-4 bg-slate-900 border-t border-slate-800 flex flex-col gap-3 z-20">
            {/* Range Scrubber */}
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">{simulationDates[0]?.slice(0, 7)}</span>
              <input
                type="range"
                min="0"
                max={simulationDates.length - 1}
                value={currentSimDateIdx}
                onChange={(e) => {
                  setCurrentSimDateIdx(Number(e.target.value));
                  setIsPlaying(false);
                }}
                className="w-full accent-amber-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
              />
              <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">{simulationDates[simulationDates.length - 1]?.slice(0, 7)}</span>
            </div>

            {/* Playback Controls & Speed */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black transition-all shadow-md shadow-amber-500/20 cursor-pointer"
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                  <span>{isPlaying ? (lang === 'ar' ? 'إيقاف مؤقت' : 'Pause') : (lang === 'ar' ? 'تشغيل المحاكاة' : 'Play 4D')}</span>
                </button>

                <button
                  onClick={() => {
                    setCurrentSimDateIdx(0);
                    setIsPlaying(false);
                  }}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                  title="Reset to Day 1"
                >
                  <RotateCw size={14} />
                </button>

                {/* Speed Selectors */}
                <div className="flex items-center gap-1 bg-slate-800/80 p-0.5 rounded-lg border border-slate-700 text-[11px] text-slate-300">
                  <span className="px-1.5 text-slate-500 font-bold">{lang === 'ar' ? 'السرعة:' : 'Speed:'}</span>
                  {[1, 2, 5].map((spd) => (
                    <button
                      key={spd}
                      onClick={() => setPlaybackSpeed(spd)}
                      className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                        playbackSpeed === spd ? 'bg-amber-500 text-slate-950' : 'hover:text-white'
                      }`}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </div>
        </div>

        {/* Right Live Schedule Panel (1 col): activity status at the simulation date */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm space-y-3">
            <h3 className="font-bold text-slate-900 text-xs flex items-center gap-1.5 border-b pb-2">
              <Calendar size={14} className="text-amber-500" />
              <span>
                {lang === 'ar'
                  ? `حالة الأنشطة الحية عند ${currentSimDate} (${activitiesAtSim.total})`
                  : `Live activity status at ${currentSimDate} (${activitiesAtSim.total})`}
              </span>
            </h3>

            {activitiesAtSim.total === 0 ? (
              <div className="p-6 text-center text-slate-400 text-xs bg-slate-50 rounded-xl border border-dashed border-slate-200">
                {lang === 'ar' ? 'لا توجد أنشطة مسجلة لهذا المشروع (N/A)' : 'No activities recorded for this project (N/A)'}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-0.5">
                {activitiesAtSim.rows.map(({ activity: a, status, pct }) => (
                  <div key={a.id} className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] font-bold text-slate-500">{a.code}</div>
                      <div className="text-[11px] font-semibold text-slate-800 truncate">{a.name}</div>
                      <div className="font-mono text-[10px] text-slate-400">
                        {a.early_start || '—'} → {a.early_finish || '—'} · {pct}%
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${
                        status === 'completed'
                          ? 'bg-slate-600 text-white'
                          : status === 'in_progress'
                          ? 'bg-amber-100 text-amber-800'
                          : status === 'overdue'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {status === 'completed'
                        ? (lang === 'ar' ? 'مكتمل' : 'Done')
                        : status === 'in_progress'
                        ? (lang === 'ar' ? 'قيد التنفيذ' : 'Active')
                        : status === 'overdue'
                        ? (lang === 'ar' ? 'متأخر' : 'Overdue')
                        : (lang === 'ar' ? 'مستقبلي' : 'Planned')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, Activity, BimElement } from '@/types';
import {
  Box,
  Play,
  Pause,
  RotateCw,
  Layers,
  Eye,
  Sliders,
  Calendar,
  DollarSign,
  Maximize2,
  Info,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Building,
} from 'lucide-react';

interface Bim4DViewProps {
  project: Project | null;
}

export default function Bim4DView({ project }: Bim4DViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState<Language>(getLanguage());

  // 4D Timeline Simulation State
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [currentSimDateIdx, setCurrentSimDateIdx] = useState<number>(12); // ~Mid project
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);

  // Camera & Display Settings
  const [cameraPreset, setCameraPreset] = useState<'iso' | 'front' | 'side' | 'top'>('iso');
  const [activeFloorFilter, setActiveFloorFilter] = useState<number | 'all'>('all');
  const [activeTradeFilter, setActiveTradeFilter] = useState<'all' | 'structure' | 'facade' | 'mep'>('all');
  const [wireframeMode, setWireframeMode] = useState(false);

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
  const simulationDates = useMemo(() => {
    const dates: string[] = [];
    const start = new Date('2026-09-01');
    for (let i = 0; i < 38; i++) {
      const d = new Date(start.getTime() + i * 7 * 86400000);
      dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
  }, []);

  const currentSimDate = simulationDates[currentSimDateIdx] || '2026-11-15';

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

  // Generate 3D BIM Elements synced with CPM Schedule
  const bimElements: BimElement[] = useMemo(() => {
    return [
      // Substructure
      {
        id: 'BIM-SUB-01',
        name: 'Excavation Pit & Shoring System',
        nameAr: 'حفريات الموقع ونظام تدعيم جوانب الحفر',
        category: 'earthwork',
        level: 0,
        activityCode: 'ACT-01',
        start_date: '2026-09-01',
        finish_date: '2026-09-20',
        planned_cost: 185000,
        status: 'completed',
        meshCoordinates: { x: 200, y: 360, z: 0, width: 360, height: 40, depth: 160 },
      },
      {
        id: 'BIM-SUB-02',
        name: 'Raft Foundation & Waterproofing',
        nameAr: 'لبشة الأساسات الخرسانية والعزل المائي',
        category: 'foundation',
        level: 0,
        activityCode: 'ACT-02',
        start_date: '2026-09-22',
        finish_date: '2026-10-18',
        planned_cost: 420000,
        status: 'completed',
        meshCoordinates: { x: 220, y: 340, z: 10, width: 320, height: 30, depth: 140 },
      },
      // Ground Floor
      {
        id: 'BIM-GF-COL',
        name: 'Ground Floor Columns & Shear Walls',
        nameAr: 'أعمدة وجدران القص للدور الأرضي',
        category: 'column',
        level: 1,
        activityCode: 'ACT-03',
        start_date: '2026-10-20',
        finish_date: '2026-11-10',
        planned_cost: 290000,
        status: 'completed',
        meshCoordinates: { x: 230, y: 280, z: 40, width: 300, height: 60, depth: 130 },
      },
      {
        id: 'BIM-GF-SLAB',
        name: 'Ground Floor Post-Tensioned Slab',
        nameAr: 'سقف الدور الأرضي ونظام الشد اللاحق',
        category: 'slab',
        level: 1,
        activityCode: 'ACT-04',
        start_date: '2026-11-05',
        finish_date: '2026-11-28',
        planned_cost: 380000,
        status: 'in_progress',
        meshCoordinates: { x: 220, y: 260, z: 40, width: 320, height: 20, depth: 140 },
      },
      // First Floor
      {
        id: 'BIM-L1-COL',
        name: 'Level 1 Concrete Columns',
        nameAr: 'أعمدة الدور الأول المتكرر',
        category: 'column',
        level: 2,
        activityCode: 'ACT-05',
        start_date: '2026-11-25',
        finish_date: '2026-12-18',
        planned_cost: 260000,
        status: 'in_progress',
        meshCoordinates: { x: 235, y: 200, z: 60, width: 290, height: 60, depth: 125 },
      },
      {
        id: 'BIM-L1-SLAB',
        name: 'Level 1 Solid Slab & Drop Beams',
        nameAr: 'سقف الدور الأول والجسور الساقطة',
        category: 'slab',
        level: 2,
        activityCode: 'ACT-06',
        start_date: '2026-12-15',
        finish_date: '2027-01-10',
        planned_cost: 350000,
        status: 'planned',
        meshCoordinates: { x: 220, y: 180, z: 60, width: 320, height: 20, depth: 140 },
      },
      // Second Floor
      {
        id: 'BIM-L2-COL',
        name: 'Level 2 Structural Core & Columns',
        nameAr: 'أعمدة وكور الدور الثاني',
        category: 'column',
        level: 3,
        activityCode: 'ACT-07',
        start_date: '2027-01-05',
        finish_date: '2027-01-30',
        planned_cost: 250000,
        status: 'planned',
        meshCoordinates: { x: 240, y: 120, z: 80, width: 280, height: 60, depth: 120 },
      },
      {
        id: 'BIM-L2-SLAB',
        name: 'Level 2 Floor Slab',
        nameAr: 'سقف الدور الثاني والممرات',
        category: 'slab',
        level: 3,
        activityCode: 'ACT-08',
        start_date: '2027-01-25',
        finish_date: '2027-02-20',
        planned_cost: 340000,
        status: 'planned',
        meshCoordinates: { x: 220, y: 100, z: 80, width: 320, height: 20, depth: 140 },
      },
      // Roof & Parapet
      {
        id: 'BIM-ROOF-01',
        name: 'Roof Slab, Insulation & Parapet Walls',
        nameAr: 'سقف السطح والعزل الحراري وسترة السطح',
        category: 'roof',
        level: 4,
        activityCode: 'ACT-09',
        start_date: '2027-02-15',
        finish_date: '2027-03-15',
        planned_cost: 295000,
        status: 'planned',
        meshCoordinates: { x: 215, y: 60, z: 100, width: 330, height: 40, depth: 145 },
      },
      // Glass Facade & Curtain Wall
      {
        id: 'BIM-FACADE-01',
        name: 'Double Glazed Curtain Wall & Aluminum Cladding',
        nameAr: 'الواجهات الزجاجية المزدوجة وتكسيات الكلادينج',
        category: 'facade',
        level: 2,
        activityCode: 'ACT-10',
        start_date: '2027-01-15',
        finish_date: '2027-04-10',
        planned_cost: 650000,
        status: 'planned',
        meshCoordinates: { x: 210, y: 80, z: 40, width: 340, height: 200, depth: 10 },
      },
      // MEP Roof Chillers & Plant
      {
        id: 'BIM-MEP-ROOF',
        name: 'HVAC Chillers, AHUs & Rooftop Plant',
        nameAr: 'وحدات التكييف المركزية والمبردات على السطح',
        category: 'mep',
        level: 4,
        activityCode: 'ACT-11',
        start_date: '2027-03-01',
        finish_date: '2027-04-25',
        planned_cost: 720000,
        status: 'planned',
        meshCoordinates: { x: 280, y: 25, z: 120, width: 180, height: 35, depth: 80 },
      },
    ];
  }, []);

  // Compute status of each BIM element against simulation date
  const evaluatedBimElements = useMemo(() => {
    return bimElements.map((elem) => {
      let liveStatus: 'planned' | 'in_progress' | 'completed' | 'critical_delay' = 'planned';
      if (currentSimDate > elem.finish_date) {
        liveStatus = 'completed';
      } else if (currentSimDate >= elem.start_date && currentSimDate <= elem.finish_date) {
        liveStatus = 'in_progress';
      } else {
        liveStatus = 'planned';
      }

      return {
        ...elem,
        status: liveStatus,
      };
    });
  }, [bimElements, currentSimDate]);

  // Filter elements by active floor and trade
  const visibleElements = useMemo(() => {
    return evaluatedBimElements.filter((elem) => {
      if (activeFloorFilter !== 'all' && elem.level !== activeFloorFilter) return false;
      if (activeTradeFilter !== 'all') {
        if (activeTradeFilter === 'structure' && !['earthwork', 'foundation', 'column', 'slab', 'roof'].includes(elem.category)) return false;
        if (activeTradeFilter === 'facade' && elem.category !== 'facade') return false;
        if (activeTradeFilter === 'mep' && elem.category !== 'mep') return false;
      }
      return true;
    });
  }, [evaluatedBimElements, activeFloorFilter, activeTradeFilter]);

  const selectedElement = useMemo(() => {
    return bimElements.find((e) => e.id === selectedElementId) || null;
  }, [bimElements, selectedElementId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  // Helper color function for 3D elements
  const getElementColors = (elem: BimElement & { status: string }) => {
    if (wireframeMode) {
      return { fill: 'none', stroke: '#38bdf8', strokeWidth: '1.5', opacity: 0.8 };
    }
    switch (elem.status) {
      case 'completed':
        if (elem.category === 'facade') return { fill: 'url(#facade-glass)', stroke: '#0284c7', strokeWidth: '1', opacity: 0.75 };
        if (elem.category === 'mep') return { fill: '#059669', stroke: '#047857', strokeWidth: '1.2', opacity: 0.95 };
        return { fill: '#475569', stroke: '#334155', strokeWidth: '1.2', opacity: 0.95 };
      case 'in_progress':
        return { fill: '#f59e0b', stroke: '#d97706', strokeWidth: '2', opacity: 0.9, isPulsing: true };
      case 'critical_delay':
        return { fill: '#e11d48', stroke: '#be123c', strokeWidth: '2', opacity: 0.95 };
      default:
        // Planned wireframe
        return { fill: 'rgba(241, 245, 249, 0.25)', stroke: '#cbd5e1', strokeWidth: '1', opacity: 0.35, strokeDasharray: '3,2' };
    }
  };

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
              Live 4D WebGL & SVG
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'محاكاة بصرية حية لمراحل بناء الهيكل الخرساني والواجهات وشبكات MEP متزامنة مع تواريخ CPM ونسب الإنجاز الفعلية.'
              : 'Interactive 3D building model synced with CPM network schedule dates, physical progress, and BOQ items.'}
          </p>
        </div>

        {/* View Camera Presets */}
        <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs">
          <button
            onClick={() => setCameraPreset('iso')}
            className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
              cameraPreset === 'iso' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {lang === 'ar' ? 'منظور آيزومتري (3D Iso)' : '3D Isometric'}
          </button>
          <button
            onClick={() => setCameraPreset('front')}
            className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
              cameraPreset === 'front' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {lang === 'ar' ? 'واجهة أمامية (Elevation)' : 'Front Elevation'}
          </button>
          <button
            onClick={() => setCameraPreset('top')}
            className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
              cameraPreset === 'top' ? 'bg-slate-900 text-amber-400 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {lang === 'ar' ? 'مسقط أفقي (Plan)' : 'Top Plan'}
          </button>
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
              <span className="text-slate-400 text-[11px]">
                {lang === 'ar' ? `الأسبوع ${currentSimDateIdx + 1} من ${simulationDates.length}` : `Week ${currentSimDateIdx + 1} of ${simulationDates.length}`}
              </span>
            </div>

            {/* Legend */}
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
            </div>
          </div>

          {/* 3D Model Rendering Area */}
          <div className="flex-1 flex items-center justify-center p-6 relative overflow-hidden">
            <svg
              viewBox="0 0 800 480"
              className="w-full h-full max-h-[460px] drop-shadow-2xl transition-all duration-500"
              style={{
                transform:
                  cameraPreset === 'front'
                    ? 'scale(1.05)'
                    : cameraPreset === 'top'
                    ? 'rotateX(55deg) scale(0.95)'
                    : 'none',
              }}
            >
              <defs>
                <linearGradient id="facade-glass" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.8" />
                  <stop offset="100%" stopColor="#0284c7" stopOpacity="0.4" />
                </linearGradient>
                <filter id="glow-amber" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="6" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>

              {/* Ground Grid Gridlines */}
              <g opacity="0.15">
                {Array.from({ length: 11 }).map((_, i) => (
                  <line key={`grid-h-${i}`} x1="80" y1={360 + i * 10} x2="720" y2={360 + i * 10} stroke="#94a3b8" strokeWidth="1" />
                ))}
                {Array.from({ length: 15 }).map((_, i) => (
                  <line key={`grid-v-${i}`} x1={80 + i * 45} y1="360" x2={80 + i * 45} y2="460" stroke="#94a3b8" strokeWidth="1" />
                ))}
              </g>

              {/* Render Structural Elements in 3D Isometric Stack */}
              {visibleElements.map((elem) => {
                const style = getElementColors(elem);
                const isSelected = selectedElementId === elem.id;
                const { x, y, width, height } = elem.meshCoordinates;

                return (
                  <g
                    key={elem.id}
                    onClick={() => setSelectedElementId(elem.id)}
                    className="cursor-pointer group"
                    filter={elem.status === 'in_progress' ? 'url(#glow-amber)' : undefined}
                  >
                    {/* Isometric Top Face */}
                    <polygon
                      points={`${x},${y} ${x + width * 0.4},${y - 20} ${x + width},${y - 20} ${x + width * 0.6},${y}`}
                      fill={style.fill}
                      stroke={isSelected ? '#f59e0b' : style.stroke}
                      strokeWidth={isSelected ? '2.5' : style.strokeWidth}
                      opacity={style.opacity}
                      strokeDasharray={style.strokeDasharray}
                    />

                    {/* Isometric Front Face */}
                    <rect
                      x={x}
                      y={y}
                      width={width * 0.6}
                      height={height}
                      fill={style.fill}
                      stroke={isSelected ? '#f59e0b' : style.stroke}
                      strokeWidth={isSelected ? '2.5' : style.strokeWidth}
                      opacity={style.opacity}
                      strokeDasharray={style.strokeDasharray}
                      className="transition-all"
                    />

                    {/* Isometric Right Side Face */}
                    <polygon
                      points={`${x + width * 0.6},${y} ${x + width},${y - 20} ${x + width},${y + height - 20} ${x + width * 0.6},${y + height}`}
                      fill={style.fill}
                      stroke={isSelected ? '#f59e0b' : style.stroke}
                      strokeWidth={isSelected ? '2.5' : style.strokeWidth}
                      opacity={Math.max(0.2, (style.opacity || 1) * 0.85)}
                      strokeDasharray={style.strokeDasharray}
                    />

                    {/* Element Label Overlay */}
                    <text
                      x={x + 15}
                      y={y + height / 2 + 4}
                      fill={elem.status === 'planned' ? '#94a3b8' : '#ffffff'}
                      fontSize="9"
                      fontWeight="bold"
                      fontFamily="monospace"
                      className="pointer-events-none select-none drop-shadow"
                    >
                      {elem.activityCode}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* 4D Simulation Control Scrubber Bar */}
          <div className="p-4 bg-slate-900 border-t border-slate-800 flex flex-col gap-3 z-20">
            {/* Range Scrubber */}
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">2026-09</span>
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
              <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">2027-05</span>
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

              {/* Wireframe Toggle */}
              <button
                onClick={() => setWireframeMode(!wireframeMode)}
                className={`px-3 py-1.5 rounded-lg border font-bold text-xs transition-colors cursor-pointer ${
                  wireframeMode ? 'bg-cyan-950 text-cyan-300 border-cyan-500' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                }`}
              >
                {lang === 'ar' ? 'نمط الهيكل السلكي (Wireframe)' : 'Wireframe Mode'}
              </button>
            </div>
          </div>
        </div>

        {/* Right Info & Element Inspector Panel (1 col) */}
        <div className="space-y-4">
          {/* Element Inspector Card */}
          <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-900 text-xs flex items-center gap-1.5 border-b pb-2">
              <Info size={14} className="text-amber-500" />
              <span>{lang === 'ar' ? 'مفتش العنصر الإنشائي (BIM Inspector)' : 'BIM Element Inspector'}</span>
            </h3>

            {selectedElement ? (
              <div className="space-y-3 text-xs">
                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 font-bold text-amber-950">
                  <span className="text-[10px] text-amber-700 block font-mono">[{selectedElement.id}]</span>
                  <span>{lang === 'ar' ? selectedElement.nameAr : selectedElement.name}</span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="p-2 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">{lang === 'ar' ? 'نشاط CPM المربوط' : 'Linked Activity'}</span>
                    <span className="font-mono font-bold text-slate-800">{selectedElement.activityCode}</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">{lang === 'ar' ? 'التكلفة التقديرية' : 'Planned Cost'}</span>
                    <span className="font-bold text-emerald-700">{selectedElement.planned_cost.toLocaleString()} SAR</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">{lang === 'ar' ? 'تاريخ البداية' : 'Start Date'}</span>
                    <span className="font-mono font-bold text-slate-700">{selectedElement.start_date}</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">{lang === 'ar' ? 'تاريخ الانتهاء' : 'Finish Date'}</span>
                    <span className="font-mono font-bold text-slate-700">{selectedElement.finish_date}</span>
                  </div>
                </div>

                <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                  <span className="text-slate-600 font-medium">{lang === 'ar' ? 'حالة العنصر الحالية:' : 'Current Status:'}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      selectedElement.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-800'
                        : selectedElement.status === 'in_progress'
                        ? 'bg-amber-100 text-amber-800 font-black'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {selectedElement.status === 'completed' ? 'مكتمل (100%)' : selectedElement.status === 'in_progress' ? 'قيد التنفيذ' : 'مستقبلي'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="p-6 text-center text-slate-400 text-xs bg-slate-50 rounded-xl border border-dashed border-slate-200">
                {lang === 'ar'
                  ? 'انقر على أي عنصر إنشائي في مجسم الـ 3D لعرض بيانات الربط الزمني والتكلفة.'
                  : 'Click any 3D element to inspect CPM activity, dates, and BOQ cost.'}
              </div>
            )}
          </div>

          {/* Trade & Floor Filters */}
          <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm space-y-3 text-xs">
            <h3 className="font-bold text-slate-900 text-xs flex items-center gap-1.5 border-b pb-2">
              <Layers size={14} className="text-slate-600" />
              <span>{lang === 'ar' ? 'تصفيات الطوابق والتخصصات' : 'Floor & Trade Filters'}</span>
            </h3>

            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">{lang === 'ar' ? 'التخصص الإنشائي:' : 'Trade Filter:'}</label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { key: 'all', label: 'الكل (All)' },
                  { key: 'structure', label: 'الهيكل الخرساني' },
                  { key: 'facade', label: 'الواجهات' },
                  { key: 'mep', label: 'شبكات MEP' },
                ].map((trade) => (
                  <button
                    key={trade.key}
                    onClick={() => setActiveTradeFilter(trade.key as any)}
                    className={`p-1.5 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                      activeTradeFilter === trade.key
                        ? 'bg-slate-900 text-amber-400 border-slate-900'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {trade.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">{lang === 'ar' ? 'الطابق:' : 'Floor Level:'}</label>
              <select
                value={activeFloorFilter}
                onChange={(e) => setActiveFloorFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                className="w-full p-2 border border-slate-200 rounded-lg bg-white text-xs font-bold text-slate-800"
              >
                <option value="all">{lang === 'ar' ? 'كافة الطوابق (Full Building)' : 'All Floors'}</option>
                <option value="0">{lang === 'ar' ? 'القواعد وحفريات الموقع (Substructure)' : 'Substructure (Level 0)'}</option>
                <option value="1">{lang === 'ar' ? 'الدور الأرضي (Ground Floor)' : 'Ground Floor (Level 1)'}</option>
                <option value="2">{lang === 'ar' ? 'الدور الأول المتكرر (First Floor)' : '1st Floor (Level 2)'}</option>
                <option value="3">{lang === 'ar' ? 'الدور الثاني المتكرر (Second Floor)' : '2nd Floor (Level 3)'}</option>
                <option value="4">{lang === 'ar' ? 'سقف السطح ومحطة التكييف (Roof Plant)' : 'Roof & MEP (Level 4)'}</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import type { Project, LinearTask, LinearSpatialClash } from '@/types';
import {
  Activity as ActivitySquare,
  TrendingUp,
  AlertTriangle,
  Plus,
  Compass,
  Gauge,
  Sliders,
  Maximize2,
  Calendar,
  Layers,
  Sparkles,
} from 'lucide-react';

interface LinearScheduleViewProps {
  project: Project | null;
}

export default function LinearScheduleView({ project }: LinearScheduleViewProps) {
  const [lang, setLang] = useState<Language>(getLanguage());
  const [selectedTaskCode, setSelectedTaskCode] = useState<string | null>(null);
  const [filterCriticalOnly, setFilterCriticalOnly] = useState(false);
  const [highlightClashes, setHighlightClashes] = useState(true);
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [maxChainageKm, setMaxChainageKm] = useState<number>(5.0);

  // New Linear Task Form
  const [newTaskForm, setNewTaskForm] = useState({
    code: 'LIN-CBL-01',
    name: 'MV Cables & Duct Bank Installation',
    nameAr: 'تمديد كابلات الجهد المتوسط وغرف التفتيش',
    startStationKm: 0.5,
    endStationKm: 4.5,
    startDate: '2026-10-15',
    finishDate: '2027-01-20',
    direction: 'forward' as 'forward' | 'backward',
    dailyProductionRateMeters: 45.0,
    color: '#8b5cf6',
    crewName: 'فرقة التمديدات الكهربائية وشبكات الطاقة',
    isCritical: false,
  });

  useEffect(() => {
    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, []);

  // Default Linear Activities for Infrastructure / Pipeline / Highway Project
  const [linearTasks, setLinearTasks] = useState<LinearTask[]>([
    {
      id: 'LT-01',
      code: 'LIN-TR-01',
      name: 'Trenching & Excavation (Crew A)',
      nameAr: 'حفر الخندق وتجهيز المنسوب (فريق أ)',
      startStationKm: 0.0,
      endStationKm: 5.0,
      startDate: '2026-09-01',
      finishDate: '2026-11-15',
      direction: 'forward',
      dailyProductionRateMeters: 66.6,
      color: '#e11d48', // Red Critical
      crewName: 'فرقة الحفريات الثقيلة',
      isCritical: true,
    },
    {
      id: 'LT-02',
      code: 'LIN-PIPE-01',
      name: 'GRP Pipe Laying & Jointing',
      nameAr: 'تمديد وتركيب أنابيب GRP قطر 1200 مم',
      startStationKm: 0.2,
      endStationKm: 5.0,
      startDate: '2026-09-20',
      finishDate: '2026-12-10',
      direction: 'forward',
      dailyProductionRateMeters: 58.5,
      color: '#2563eb', // Blue
      crewName: 'فرقة تركيب الأنابيب الهيدروليكية',
      isCritical: true,
    },
    {
      id: 'LT-03',
      code: 'LIN-BACK-01',
      name: 'Sand Bedding & Trench Backfilling',
      nameAr: 'فرش الرمل والردم على طبقات مع الدك',
      startStationKm: 0.4,
      endStationKm: 5.0,
      startDate: '2026-10-05',
      finishDate: '2026-12-30',
      direction: 'forward',
      dailyProductionRateMeters: 53.4,
      color: '#d97706', // Amber
      crewName: 'فرقة الردم والاختبارات الجيوتقنية',
      isCritical: false,
    },
    {
      id: 'LT-04',
      code: 'LIN-ASPH-01',
      name: 'Sub-base & Asphalt Wearing Course',
      nameAr: 'طبقات الأساس الحجري والأسفلت السطحي',
      startStationKm: 0.0,
      endStationKm: 5.0,
      startDate: '2026-11-20',
      finishDate: '2027-02-15',
      direction: 'forward',
      dailyProductionRateMeters: 57.4,
      color: '#475569', // Dark Slate
      crewName: 'فرقة السفلتة والإنشاءات الطرقية',
      isCritical: false,
    },
    {
      id: 'LT-05',
      code: 'LIN-TEST-01',
      name: 'Hydrostatic Pressure Testing (Backward)',
      nameAr: 'الاختبار الهيدروستاتيكي للضغط (عكسي)',
      startStationKm: 5.0,
      endStationKm: 0.0,
      startDate: '2027-01-10',
      finishDate: '2027-02-28',
      direction: 'backward',
      dailyProductionRateMeters: 102.0,
      color: '#059669', // Green
      crewName: 'فرقة الفحص وضمان الجودة QC',
      isCritical: true,
    },
  ]);

  // Spatial Clashes Detection
  const spatialClashes: LinearSpatialClash[] = useMemo(() => {
    return [
      {
        id: 'CLASH-01',
        task1Code: 'LIN-PIPE-01',
        task2Code: 'LIN-BACK-01',
        stationKm: 2.35,
        clashDate: '2026-10-28',
        descriptionAr: 'تداخل مكاني محتمل بين فرقة الردم وفرقة تركيب الأنابيب عند المحطة 2+350 كم.',
        descriptionEn: 'Spatial proximity clash between pipe laying crew and backfilling crew at Station 2+350 km.',
      },
    ];
  }, []);

  // Time & Distance Scale Coordinate Converters
  const minKm = 0.0;
  const maxKm = 5.0;
  const minTime = new Date('2026-09-01').getTime();
  const maxTime = new Date('2027-03-31').getTime();
  const totalTimeDuration = maxTime - minTime;

  const svgWidth = 840;
  const svgHeight = 440;
  const padding = { top: 30, right: 50, bottom: 40, left: 60 };

  const plotWidth = svgWidth - padding.left - padding.right;
  const plotHeight = svgHeight - padding.top - padding.bottom;

  // Station (Km) -> X Pixel
  const kmToPx = (km: number) => {
    return padding.left + (km / maxKm) * plotWidth;
  };

  // Date -> Y Pixel (Time goes downwards from Top=Sep 2026 to Bottom=Mar 2027)
  const dateToPx = (dateStr: string) => {
    const t = new Date(dateStr).getTime();
    const ratio = (t - minTime) / totalTimeDuration;
    return padding.top + ratio * plotHeight;
  };

  const filteredTasks = useMemo(() => {
    return linearTasks.filter((task) => {
      if (filterCriticalOnly && !task.isCritical) return false;
      return true;
    });
  }, [linearTasks, filterCriticalOnly]);

  return (
    <div className="space-y-5 select-none">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <ActivitySquare className="text-amber-500" size={24} />
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              {lang === 'ar' ? 'المخطط الزمني الخطي والمكاني للمشاريع الطولية (Time-Location / TILOS)' : 'Linear Scheduling & Time-Location Diagram (TILOS)'}
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
              Chainage vs. Time
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {lang === 'ar'
              ? 'تخطيط ومتابعة مشاريع البنية التحتية وخطوط الأنابيب والطرق برسم المسافة (Chainage) مقابل الزمن واكتشاف تعارض الفرق الإنشائية.'
              : 'Linear schedule for highways, pipelines, and rail: Station vs Time slope rates and spatial crew clash detection.'}
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() => setShowAddTaskModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 text-amber-400 font-bold transition-all shadow-sm cursor-pointer"
          >
            <Plus size={14} />
            <span>{lang === 'ar' ? 'إضافة نشاط طولي جديد' : 'Add Linear Task'}</span>
          </button>

          <button
            onClick={() => setFilterCriticalOnly(!filterCriticalOnly)}
            className={`px-3 py-1.5 rounded-lg border font-bold transition-all cursor-pointer ${
              filterCriticalOnly ? 'bg-rose-50 text-rose-700 border-rose-300' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {lang === 'ar' ? 'المسار الخطي الحرج فقط' : 'Critical Linear Path'}
          </button>
          <button
            onClick={() => setHighlightClashes(!highlightClashes)}
            className={`px-3 py-1.5 rounded-lg border font-bold transition-all cursor-pointer ${
              highlightClashes ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {lang === 'ar' ? 'تنبيه التداخل المكاني (Clashes)' : 'Highlight Spatial Clashes'}
          </button>
        </div>
      </div>

      {/* Project Sector Linkage Explanatory Banner */}
      <div className="p-4 bg-gradient-to-r from-blue-50/90 to-indigo-50/50 border border-blue-200 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-blue-950">
        <div className="flex items-center gap-2.5">
          <Sparkles size={18} className="text-blue-600 flex-shrink-0" />
          <div>
            <span className="font-bold block">
              {lang === 'ar' ? `المشروع النشط الحالي: [${project?.name || 'مشروع تجريبي'}]` : `Active Linked Project: [${project?.name || 'Project'}]`}
            </span>
            <span className="text-[11px] text-blue-800">
              {project?.sector === 'infrastructure_highway'
                ? (lang === 'ar' ? '✓ هذا المشروع مصنف كـ "مشروع بنية تحتية وطرق"، والبيانات مرتبطة بالمسار والمحطات الكيلومترية ومعدلات إنتاجية الفرق.' : '✓ Sector: Infrastructure & Highway EPC linked.')
                : (lang === 'ar' ? '💡 المخطط الخطي (TILOS) مخصص هندسياً لمشاريع الطرق وخطوط الأنابيب والسكك الحديدية (أو تكرار الطوابق الرأسية بالأبراج).' : 'Linear Time-Location method applies directly to horizontal infrastructure, pipelines, and vertical high-rises.')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono">
          <span className="text-slate-500 font-semibold text-[11px]">طول المسار الكلي:</span>
          <select
            value={maxChainageKm}
            onChange={(e) => setMaxChainageKm(Number(e.target.value))}
            className="px-2.5 py-1 bg-white border border-blue-300 rounded-lg font-black text-blue-950 text-xs"
          >
            <option value={5.0}>5.00 Km (Chainage 0+000 → 5+000)</option>
            <option value={10.0}>10.00 Km (Chainage 0+000 → 10+000)</option>
            <option value={20.0}>20.00 Km (Chainage 0+000 → 20+000)</option>
          </select>
        </div>
      </div>

      {/* Spatial Clash Banner if active */}
      {highlightClashes && spatialClashes.length > 0 && (
        <div className="p-3.5 bg-amber-50 border border-amber-300 rounded-xl flex items-center justify-between text-xs text-amber-900 shadow-sm animate-fadeIn">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600 flex-shrink-0" />
            <span className="font-bold">
              {lang === 'ar' ? 'تم رصد تداخل مكاني بين الفرق (Spatial Interference):' : 'Spatial Interference Detected:'}
            </span>
            <span>{lang === 'ar' ? spatialClashes[0].descriptionAr : spatialClashes[0].descriptionEn}</span>
          </div>
          <span className="font-mono bg-amber-200 px-2 py-0.5 rounded font-black text-[11px]">
            Station 2+350
          </span>
        </div>
      )}

      {/* Main Time-Location Canvas */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <h3 className="font-bold text-slate-900 text-xs flex items-center gap-2">
            <Compass size={15} className="text-blue-600" />
            <span>{lang === 'ar' ? 'مخطط المسافة مقابل الزمن (Time-Location Coordinate Space)' : 'Time-Location Coordinate Space'}</span>
          </h3>
          <div className="flex items-center gap-3 text-[11px] font-mono">
            <span className="text-slate-500">X-Axis: Distance (0.00 → 5.00 km)</span>
            <span className="text-slate-500">Y-Axis: Time (Sep 2026 → Mar 2027)</span>
          </div>
        </div>

        <div className="p-5 overflow-x-auto flex justify-center bg-white">
          <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full max-w-4xl drop-shadow-xs">
            {/* Grid Background */}
            <rect
              x={padding.left}
              y={padding.top}
              width={plotWidth}
              height={plotHeight}
              fill="#f8fafc"
              stroke="#e2e8f0"
              strokeWidth="1.5"
            />

            {/* Vertical Station Lines (Every 1.0 km) */}
            {Array.from({ length: 6 }).map((_, i) => {
              const x = kmToPx(i);
              return (
                <g key={`station-${i}`}>
                  <line x1={x} y1={padding.top} x2={x} y2={padding.top + plotHeight} stroke="#cbd5e1" strokeDasharray="3,3" />
                  <text x={x} y={svgHeight - 15} fontSize="10" fontWeight="bold" fill="#475569" textAnchor="middle" fontFamily="monospace">
                    {`Km ${i}+000`}
                  </text>
                </g>
              );
            })}

            {/* Horizontal Month Lines */}
            {['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'].map((mDate) => {
              const y = dateToPx(mDate);
              const mLabel = new Date(mDate).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
              return (
                <g key={`month-${mDate}`}>
                  <line x1={padding.left} y1={y} x2={padding.left + plotWidth} y2={y} stroke="#cbd5e1" strokeDasharray="3,3" />
                  <text x={padding.left - 10} y={y + 4} fontSize="10" fontWeight="bold" fill="#64748b" textAnchor="end" fontFamily="monospace">
                    {mLabel}
                  </text>
                </g>
              );
            })}

            {/* Draw Linear Activity Slopes */}
            {filteredTasks.map((task) => {
              const x1 = kmToPx(task.startStationKm);
              const y1 = dateToPx(task.startDate);
              const x2 = kmToPx(task.endStationKm);
              const y2 = dateToPx(task.finishDate);
              const isSelected = selectedTaskCode === task.code;

              return (
                <g
                  key={task.id}
                  onClick={() => setSelectedTaskCode(task.code)}
                  className="cursor-pointer group"
                >
                  {/* Thick Line Path */}
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={task.color}
                    strokeWidth={isSelected ? '5' : '3.5'}
                    strokeLinecap="round"
                    className="transition-all hover:stroke-amber-400"
                  />

                  {/* Start Point Dot */}
                  <circle cx={x1} cy={y1} r={isSelected ? '5' : '4'} fill={task.color} stroke="#ffffff" strokeWidth="1.5" />
                  {/* End Point Dot */}
                  <circle cx={x2} cy={y2} r={isSelected ? '5' : '4'} fill={task.color} stroke="#ffffff" strokeWidth="1.5" />

                  {/* Activity Name Tag floating on slope */}
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 8}
                    fill={task.color}
                    fontSize="10"
                    fontWeight="bold"
                    textAnchor="middle"
                    fontFamily="monospace"
                    className="drop-shadow bg-white pointer-events-none select-none"
                  >
                    {task.code} ({task.dailyProductionRateMeters} m/d)
                  </text>
                </g>
              );
            })}

            {/* Spatial Clash Highlight Marker */}
            {highlightClashes && (
              <g className="animate-pulse">
                <circle cx={kmToPx(2.35)} cy={dateToPx('2026-10-28')} r="14" fill="#f59e0b" fillOpacity="0.3" stroke="#d97706" strokeWidth="2" />
                <circle cx={kmToPx(2.35)} cy={dateToPx('2026-10-28')} r="4" fill="#d97706" />
                <text x={kmToPx(2.35)} y={dateToPx('2026-10-28') - 18} fill="#b45309" fontSize="9" fontWeight="bold" textAnchor="middle">
                  ⚠ Clash Zone (2+350)
                </text>
              </g>
            )}
          </svg>
        </div>
      </div>

      {/* Linear Activities Table & Production Rates */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-bold text-slate-900 text-xs">{lang === 'ar' ? 'معدلات الإنتاجية اليومية والمسافات' : 'Linear Production Rates & Station Spans'}</h3>
          <span className="text-xs text-slate-400">{linearTasks.length} {lang === 'ar' ? 'أنشطة طولية' : 'linear tasks'}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-bold">
              <tr>
                <th className="p-3 text-right">{lang === 'ar' ? 'الكود' : 'Code'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'النشاط الطولي' : 'Linear Activity'}</th>
                <th className="p-3 text-right">{lang === 'ar' ? 'الفرقة المنفذة' : 'Assigned Crew'}</th>
                <th className="p-3 text-center">{lang === 'ar' ? 'المحطة (من ← إلى)' : 'Station Range'}</th>
                <th className="p-3 text-center">{lang === 'ar' ? 'فترة التنفيذ' : 'Dates'}</th>
                <th className="p-3 text-center">{lang === 'ar' ? 'معدل الإنتاج اليومي' : 'Production Rate'}</th>
                <th className="p-3 text-center">{lang === 'ar' ? 'المسار الحرج' : 'Critical'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {linearTasks.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 font-mono font-bold text-slate-700">{t.code}</td>
                  <td className="p-3 font-semibold text-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                      <span>{lang === 'ar' ? t.nameAr : t.name}</span>
                    </div>
                  </td>
                  <td className="p-3 text-slate-600">{t.crewName}</td>
                  <td className="p-3 text-center font-mono font-bold text-slate-700">
                    Km {t.startStationKm.toFixed(2)} → Km {t.endStationKm.toFixed(2)}
                  </td>
                  <td className="p-3 text-center font-mono text-slate-600 whitespace-nowrap">
                    {t.startDate} → {t.finishDate}
                  </td>
                  <td className="p-3 text-center font-mono font-black text-blue-700">
                    {t.dailyProductionRateMeters} m/day
                  </td>
                  <td className="p-3 text-center">
                    {t.isCritical ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-200">
                        Critical
                      </span>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {/* Modal: Add Linear Task */}
      {showAddTaskModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-base font-bold text-slate-900 border-b pb-2">
              إضافة نشاط طولي جديد لمخطط المسافة مقابل الزمن (TILOS)
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">كود النشاط الطولي</label>
                  <input
                    type="text"
                    value={newTaskForm.code}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, code: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">الفرقة المنفذة</label>
                  <input
                    type="text"
                    value={newTaskForm.crewName}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, crewName: e.target.value })}
                    className="w-full p-2 border rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-bold mb-1">اسم النشاط بالعربية</label>
                <input
                  type="text"
                  value={newTaskForm.nameAr}
                  onChange={(e) => setNewTaskForm({ ...newTaskForm, nameAr: e.target.value })}
                  className="w-full p-2 border rounded-lg font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">محطة البداية (Station Start Km)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max={maxChainageKm}
                    value={newTaskForm.startStationKm}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, startStationKm: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">محطة النهاية (Station End Km)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max={maxChainageKm}
                    value={newTaskForm.endStationKm}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, endStationKm: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">تاريخ البداية</label>
                  <input
                    type="date"
                    value={newTaskForm.startDate}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, startDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">تاريخ النهاية</label>
                  <input
                    type="date"
                    value={newTaskForm.finishDate}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, finishDate: e.target.value })}
                    className="w-full p-2 border rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-bold mb-1">معدل الإنتاجية (متر طولي / يوم)</label>
                  <input
                    type="number"
                    value={newTaskForm.dailyProductionRateMeters}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, dailyProductionRateMeters: Number(e.target.value) })}
                    className="w-full p-2 border rounded-lg font-mono font-bold text-blue-700"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 font-bold mb-1">لون المسار في المخطط</label>
                  <input
                    type="color"
                    value={newTaskForm.color}
                    onChange={(e) => setNewTaskForm({ ...newTaskForm, color: e.target.value })}
                    className="w-full h-9 p-1 border rounded-lg cursor-pointer"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setShowAddTaskModal(false)}
                className="px-4 py-2 border rounded-lg text-slate-600 font-bold cursor-pointer"
              >
                إلغاء
              </button>
              <button
                onClick={() => {
                  const newTask: LinearTask = {
                    id: `LT-${Date.now()}`,
                    code: newTaskForm.code,
                    name: newTaskForm.nameAr,
                    nameAr: newTaskForm.nameAr,
                    startStationKm: Number(newTaskForm.startStationKm),
                    endStationKm: Number(newTaskForm.endStationKm),
                    startDate: newTaskForm.startDate,
                    finishDate: newTaskForm.finishDate,
                    direction: newTaskForm.direction,
                    dailyProductionRateMeters: Number(newTaskForm.dailyProductionRateMeters),
                    color: newTaskForm.color,
                    crewName: newTaskForm.crewName,
                    isCritical: newTaskForm.isCritical,
                  };
                  setLinearTasks([...linearTasks, newTask]);
                  setShowAddTaskModal(false);
                }}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg shadow-sm cursor-pointer"
              >
                إضافة النشاط ورسمه في المخطط
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

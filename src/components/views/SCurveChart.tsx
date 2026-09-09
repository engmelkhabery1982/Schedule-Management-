import { useState, useMemo } from 'react';
import type { SCurveData, SCurvePoint } from '@/lib/sCurveEngine';
import { TrendingUp, Layers, HelpCircle, Eye, EyeOff } from 'lucide-react';

interface SCurveChartProps {
  data: SCurveData;
  currency?: string;
}

export default function SCurveChart({ data, currency = 'ريال' }: SCurveChartProps) {
  const [hoveredPoint, setHoveredPoint] = useState<SCurvePoint | null>(null);
  const [showPvLate, setShowPvLate] = useState(true);
  const [showForecast, setShowForecast] = useState(true);

  const { points, bac, currentEv, currentAc, forecastEac } = data;

  const chartHeight = 280;
  const chartWidth = 700;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };

  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;

  // Maximum value for Y axis (10% higher than max of BAC or EAC)
  const maxY = useMemo(() => {
    let max = Math.max(bac, forecastEac, currentAc, currentEv, 1000);
    points.forEach((p) => {
      max = Math.max(max, p.pvEarlyCumulative, p.pvLateCumulative, p.evCumulative || 0, p.acCumulative || 0, p.forecastCumulative || 0);
    });
    return Math.ceil(max * 1.1);
  }, [points, bac, forecastEac, currentAc, currentEv]);

  const numPoints = points.length;

  const getX = (index: number) => {
    if (numPoints <= 1) return padding.left + innerWidth / 2;
    return padding.left + (index / (numPoints - 1)) * innerWidth;
  };

  const getY = (value: number) => {
    const ratio = Math.max(0, Math.min(1, value / maxY));
    return padding.top + innerHeight - ratio * innerHeight;
  };

  // Generate SVG path strings
  const pvEarlyPath = useMemo(() => {
    if (points.length === 0) return '';
    return points.reduce((acc, p, idx) => {
      const x = getX(idx);
      const y = getY(p.pvEarlyCumulative);
      return idx === 0 ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
    }, '');
  }, [points, maxY]);

  const pvLatePath = useMemo(() => {
    if (points.length === 0) return '';
    return points.reduce((acc, p, idx) => {
      const x = getX(idx);
      const y = getY(p.pvLateCumulative);
      return idx === 0 ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
    }, '');
  }, [points, maxY]);

  // Banana Curve Fill Area between PV Early and PV Late
  const bananaAreaPath = useMemo(() => {
    if (points.length === 0) return '';
    let forward = '';
    let backward = '';
    points.forEach((p, idx) => {
      const x = getX(idx);
      const yEarly = getY(p.pvEarlyCumulative);
      const yLate = getY(p.pvLateCumulative);
      if (idx === 0) {
        forward = `M ${x} ${yEarly}`;
      } else {
        forward += ` L ${x} ${yEarly}`;
      }
      backward = ` L ${x} ${yLate}` + backward;
    });
    return `${forward} ${backward} Z`;
  }, [points, maxY]);

  const evPath = useMemo(() => {
    const validPoints = points.filter((p) => p.evCumulative !== null);
    if (validPoints.length === 0) return '';
    return validPoints.reduce((acc, p) => {
      const idx = points.indexOf(p);
      const x = getX(idx);
      const y = getY(p.evCumulative as number);
      return acc === '' ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
    }, '');
  }, [points, maxY]);

  const acPath = useMemo(() => {
    const validPoints = points.filter((p) => p.acCumulative !== null);
    if (validPoints.length === 0) return '';
    return validPoints.reduce((acc, p) => {
      const idx = points.indexOf(p);
      const x = getX(idx);
      const y = getY(p.acCumulative as number);
      return acc === '' ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
    }, '');
  }, [points, maxY]);

  const forecastPath = useMemo(() => {
    const lastPastPoint = points.filter((p) => p.acCumulative !== null).slice(-1)[0];
    const futurePoints = points.filter((p) => p.forecastCumulative !== null);
    if (!lastPastPoint || futurePoints.length === 0) return '';

    const startIdx = points.indexOf(lastPastPoint);
    let pathStr = `M ${getX(startIdx)} ${getY(lastPastPoint.acCumulative || currentAc)}`;

    futurePoints.forEach((p) => {
      const idx = points.indexOf(p);
      pathStr += ` L ${getX(idx)} ${getY(p.forecastCumulative as number)}`;
    });
    return pathStr;
  }, [points, currentAc, maxY]);

  if (points.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 text-center text-slate-400">
        لا توجد بيانات كافية لرسم منحنى S-Curve حالياً.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <TrendingUp size={20} className="text-blue-600" />
            منحنى الأداء التراكمي (S-Curve & EVM Analysis)
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            مقارنة القيمة المخططة (PV Early/Late) مع القيمة المكتسبة (EV) والتكلفة الفعلية (AC) والتوقع المستقبلي (EAC).
          </p>
        </div>

        {/* Toggles */}
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => setShowPvLate(!showPvLate)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded border transition-colors ${
              showPvLate ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-slate-50 text-slate-500 border-slate-200'
            }`}
          >
            {showPvLate ? <Eye size={12} /> : <EyeOff size={12} />}
            منطقة المرونة (Banana Curve)
          </button>
          <button
            onClick={() => setShowForecast(!showForecast)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded border transition-colors ${
              showForecast ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-500 border-slate-200'
            }`}
          >
            {showForecast ? <Eye size={12} /> : <EyeOff size={12} />}
            توقع الإنجاز (EAC)
          </button>
        </div>
      </div>

      {/* SVG Chart */}
      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-auto max-h-72 select-none"
          onMouseLeave={() => setHoveredPoint(null)}
        >
          <defs>
            <linearGradient id="bananaGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#93c5fd" stopOpacity="0.05" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const yVal = padding.top + innerHeight * (1 - ratio);
            const labelVal = Math.round(maxY * ratio);
            return (
              <g key={ratio}>
                <line
                  x1={padding.left}
                  y1={yVal}
                  x2={chartWidth - padding.right}
                  y2={yVal}
                  stroke="#e2e8f0"
                  strokeDasharray="4,4"
                />
                <text
                  x={padding.left - 8}
                  y={yVal + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="#94a3b8"
                  className="font-mono"
                >
                  {(labelVal / 1000).toFixed(0)}k
                </text>
              </g>
            );
          })}

          {/* Banana Curve fill area */}
          {showPvLate && bananaAreaPath && (
            <path d={bananaAreaPath} fill="url(#bananaGradient)" />
          )}

          {/* PV Late Curve (dashed blue) */}
          {showPvLate && pvLatePath && (
            <path
              d={pvLatePath}
              fill="none"
              stroke="#93c5fd"
              strokeWidth="2"
              strokeDasharray="5,5"
            />
          )}

          {/* PV Early Curve (Solid Blue) */}
          {pvEarlyPath && (
            <path
              d={pvEarlyPath}
              fill="none"
              stroke="#2563eb"
              strokeWidth="2.5"
            />
          )}

          {/* Forecast Curve (Dashed Amber/Orange) */}
          {showForecast && forecastPath && (
            <path
              d={forecastPath}
              fill="none"
              stroke="#f59e0b"
              strokeWidth="2.5"
              strokeDasharray="6,4"
            />
          )}

          {/* EV Curve (Solid Emerald Green) */}
          {evPath && (
            <path
              d={evPath}
              fill="none"
              stroke="#10b981"
              strokeWidth="3"
            />
          )}

          {/* AC Curve (Solid Red/Rose) */}
          {acPath && (
            <path
              d={acPath}
              fill="none"
              stroke="#ef4444"
              strokeWidth="2.5"
            />
          )}

          {/* Data Points and Interaction Circles */}
          {points.map((p, idx) => {
            const x = getX(idx);
            const isHovered = hoveredPoint?.date === p.date;

            return (
              <g
                key={p.date}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredPoint(p)}
              >
                {/* Invisible hover capture bar */}
                <rect
                  x={x - innerWidth / (numPoints * 2)}
                  y={padding.top}
                  width={innerWidth / numPoints}
                  height={innerHeight}
                  fill="transparent"
                />

                {/* X Axis labels (selectively spaced) */}
                {(idx % Math.ceil(numPoints / 6) === 0 || idx === numPoints - 1) && (
                  <text
                    x={x}
                    y={chartHeight - 12}
                    textAnchor="middle"
                    fontSize="10"
                    fill="#64748b"
                  >
                    {p.label}
                  </text>
                )}

                {/* Hover Guide Line */}
                {isHovered && (
                  <line
                    x1={x}
                    y1={padding.top}
                    x2={x}
                    y2={padding.top + innerHeight}
                    stroke="#64748b"
                    strokeWidth="1.5"
                    strokeDasharray="3,3"
                  />
                )}

                {/* Early PV dot */}
                <circle
                  cx={x}
                  cy={getY(p.pvEarlyCumulative)}
                  r={isHovered ? 5 : 3}
                  fill="#2563eb"
                />

                {/* EV dot */}
                {p.evCumulative !== null && (
                  <circle
                    cx={x}
                    cy={getY(p.evCumulative)}
                    r={isHovered ? 6 : 4}
                    fill="#10b981"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                )}

                {/* AC dot */}
                {p.acCumulative !== null && (
                  <circle
                    cx={x}
                    cy={getY(p.acCumulative)}
                    r={isHovered ? 5 : 3.5}
                    fill="#ef4444"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* Floating Tooltip */}
        {hoveredPoint && (
          <div className="mt-2 p-3 bg-slate-900 text-white rounded-lg shadow-lg text-xs grid grid-cols-2 sm:grid-cols-4 gap-3 animate-fadeIn">
            <div>
              <span className="text-slate-400 block">التاريخ</span>
              <span className="font-semibold text-white">{hoveredPoint.date}</span>
            </div>
            <div>
              <span className="text-blue-300 block flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
                المخطط المبكر (PV Early)
              </span>
              <span className="font-semibold">{hoveredPoint.pvEarlyCumulative.toLocaleString()} {currency}</span>
            </div>
            <div>
              <span className="text-emerald-300 block flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                المكتسب الفعلي (EV)
              </span>
              <span className="font-semibold">
                {hoveredPoint.evCumulative !== null ? `${hoveredPoint.evCumulative.toLocaleString()} ${currency}` : 'قيد التنفيذ'}
              </span>
            </div>
            <div>
              <span className="text-rose-300 block flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" />
                التكلفة الفعلية (AC)
              </span>
              <span className="font-semibold">
                {hoveredPoint.acCumulative !== null ? `${hoveredPoint.acCumulative.toLocaleString()} ${currency}` : 'قيد التنفيذ'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Legend & Summary Footer */}
      <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-1 bg-blue-600 rounded" />
            <span className="text-slate-700 font-medium">PV Early (المخطط المبكر)</span>
          </div>
          {showPvLate && (
            <div className="flex items-center gap-1.5">
              <span className="w-3.5 h-1 border-t-2 border-dashed border-blue-400" />
              <span className="text-slate-500">PV Late (المخطط المتأخر)</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-1 bg-emerald-500 rounded" />
            <span className="text-emerald-700 font-medium">EV (القيمة المكتسبة)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-1 bg-rose-500 rounded" />
            <span className="text-rose-700 font-medium">AC (التكلفة الفعلية)</span>
          </div>
          {showForecast && (
            <div className="flex items-center gap-1.5">
              <span className="w-3.5 h-1 border-t-2 border-dashed border-amber-500" />
              <span className="text-amber-700">EAC (توقع الإكمال)</span>
            </div>
          )}
        </div>

        <div className="text-slate-500">
          الميزانية الإجمالية (BAC): <span className="font-bold text-slate-800">{bac.toLocaleString()} {currency}</span>
        </div>
      </div>
    </div>
  );
}

import type { Activity, BoqItem, CostTransaction, EvmMetrics, ProgressUpdate, Project } from '@/types';
import { calculateProjectEvmAtDataDate, type EvmBudgetLineInput } from '@/lib/planningEngine';
import { generateSCurveData, type SCurveData } from '@/lib/sCurveEngine';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';

export interface MonthlyDataPoint {
  /**
   * Bucket index on the shared S-Curve axis (0 = project start bucket). Named `monthIndex` for
   * compatibility with existing consumers; buckets are 7 / 14 / 30 days apart depending on the
   * project span, so this is a bucket sequence number rather than a calendar month.
   */
  monthIndex: number;
  monthLabel: string;
  date: string;
  pvCumulative: number;
  evCumulative: number;
  acCumulative: number;
  pvIncremental: number;
  evIncremental: number;
}

export interface EarnedScheduleResult {
  actualTimeElapsedMonths: number; // AT (Actual Time)
  actualTimeElapsedDays: number;
  plannedDurationMonths: number; // PD (Planned Duration)
  plannedDurationDays: number;
  earnedScheduleMonths: number; // ES (Earned Schedule)
  earnedScheduleDays: number;
  scheduleVarianceTimeMonths: number; // SV(t) = ES - AT
  scheduleVarianceTimeDays: number;
  schedulePerformanceIndexTime: number; // SPI(t) = ES / AT
  costPerformanceIndex: number; // CPI = EV / AC (canonical EVM)
  estimatedDurationAtCompletionMonths: number; // IEAC(t) = PD / SPI(t)
  estimatedDurationAtCompletionDays: number;
  varianceAtCompletionTimeMonths: number; // VAC(t) = PD - IEAC(t)
  varianceAtCompletionTimeDays: number;
  forecastCompletionDate: string;
  plannedCompletionDate: string;
  status: 'ahead' | 'on_track' | 'delayed' | 'critical_delay';
  timeDivergenceNote: string;
  comparisonWithTraditionalEvm: {
    evmSvAmount: number; // SV = EV - PV
    evmSpi: number; // SPI = EV / PV
    esmSvDays: number; // SV(t) in days
    esmSpi: number; // SPI(t)
    paradoxExplanation: string;
  };
  sCurvePoints: MonthlyDataPoint[];
}

/**
 * Everything Earned Schedule needs, and nothing it is allowed to invent (GAP-007).
 *
 * The engine derives NO economic value of its own. `evm` is the canonical Wave-2 project EVM
 * (`calculateProjectEvmAtDataDate`); when the caller does not already hold it, the engine calls
 * that same canonical function exactly once with the source data below. `sCurve` is the canonical
 * financial S-Curve whose planned-value curve Earned Schedule maps EV onto; when absent it is
 * generated once from the same sources, so both features always share ONE PV curve.
 */
export interface EarnedScheduleSources {
  project: Project | null;
  activities: Activity[];
  /** Canonical EVM at the governed Data Date. Preferred: computed once by the caller. */
  evm?: EvmMetrics & { dataDate?: string };
  /** Canonical S-Curve. Preferred: the same object rendered by the S-Curve chart. */
  sCurve?: SCurveData;
  /** Source data used only when `evm` / `sCurve` are not supplied (canonical EVM, called once). */
  budgetLines?: EvmBudgetLineInput[];
  boqItems?: BoqItem[];
  costTransactions?: CostTransaction[];
  progressUpdates?: ProgressUpdate[];
  /** Explicit cutoff; otherwise `evm.dataDate` -> `project.data_date` -> governed DEFAULT_DATA_DATE. */
  overrideDataDate?: string;
}

const DAY_MS = 86400000;
/** Documented unit convention of this interface: one "month" = 30 calendar days. */
const DAYS_PER_MONTH = 30;

function parseDate(d: string): number {
  return new Date(`${d}T00:00:00Z`).getTime();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseDate(toIso) - parseDate(fromIso)) / DAY_MS);
}

/**
 * Earned Schedule (ESM) — maps canonical EV onto the canonical planned-value curve to express
 * schedule performance in TIME units instead of currency.
 *
 * FORMULAS AND UNITS (all time quantities are CALENDAR DAYS on the S-Curve date axis, measured
 * from the project start; "months" fields are those days divided by 30):
 *
 *   PD    = planned duration            = project end date - project start date
 *   AT    = actual time elapsed         = clamp(data date - project start date, 0, PD)
 *   ES    = earned schedule             = the time at which the cumulative PV curve reaches EV
 *   SV(t) = ES - AT                                          [days]
 *   SPI(t)= ES / AT                                          [ratio, dimensionless]
 *   IEAC(t)= PD / SPI(t)                                     [days]
 *   VAC(t)= PD - IEAC(t)                                     [days]
 *   CPI   = canonical EVM CPI (EV / AC)                       [ratio] — never re-derived here
 *
 * ES is obtained by inverting the cumulative PV curve, with EXPLICIT boundaries (GAP-023):
 *
 *   A. EV <= 0 (or non-finite)                     -> ES = 0. Nothing has been earned, so no
 *      point of the planned curve has been reached. SPI(t) is then 0 whenever AT > 0.
 *   B. 0 < EV < PV(last)                           -> take C = the last bucket with
 *      PV(C) <= EV and PV(C+1) > PV(C), then
 *         I  = (EV - PV(C)) / (PV(C+1) - PV(C))     in [0, 1)   [dimensionless]
 *         ES = t(C) + I * (t(C+1) - t(C))                       [days]
 *      i.e. linear interpolation in TIME between the two surrounding planned-value points. A flat
 *      segment (PV(C+1) == PV(C)) is skipped, never divided by.
 *   C. EV >= PV(last) (== canonical BAC)           -> ES = PD, clamped. Earned value at or beyond
 *      the final planned value means the whole planned duration has been earned; the curve is NOT
 *      extrapolated past its last point.
 *
 * The former implementation indexed one point beyond the end of the curve and substituted
 * `PV(C) + 1` for the missing next point, which turned a currency difference (EV - BAC, in SAR)
 * into a count of MONTHS: an EV of 1.2 x BAC on a 125M SAR project produced an earned schedule of
 * 750,000,390 days and an SPI(t) of 2,941,178. Because ES is now clamped to [0, PD] by
 * construction, no currency amount can enter a time quantity and no overflow is reachable.
 *
 * Degenerate boundary: when ES = 0 while AT > 0, SPI(t) = 0 and IEAC(t) = PD / SPI(t) is
 * mathematically unbounded. Rather than emit Infinity (or a fabricated cap), the engine reports
 * IEAC(t) = PD as an explicit NOT-COMPUTABLE floor with VAC(t) = 0, sets the forecast completion
 * date to the planned completion date, and says so in `timeDivergenceNote` with a
 * `critical_delay` status. For any ES > 0 the exact formula is used and is finite.
 */
export function calculateEarnedSchedule(sources: EarnedScheduleSources): EarnedScheduleResult {
  const { project, activities } = sources;

  // Governed Data Date: explicit override -> canonical EVM data date -> project -> constant.
  // `new Date()` is never used as the cutoff and no date literal is repeated here (GAP-007).
  const dataDate =
    sources.overrideDataDate || sources.evm?.dataDate || project?.data_date || DEFAULT_DATA_DATE;

  if (!project || activities.length === 0) {
    return {
      actualTimeElapsedMonths: 0,
      actualTimeElapsedDays: 0,
      plannedDurationMonths: 0,
      plannedDurationDays: 0,
      earnedScheduleMonths: 0,
      earnedScheduleDays: 0,
      scheduleVarianceTimeMonths: 0,
      scheduleVarianceTimeDays: 0,
      schedulePerformanceIndexTime: 1.0,
      costPerformanceIndex: 1.0,
      estimatedDurationAtCompletionMonths: 0,
      estimatedDurationAtCompletionDays: 0,
      varianceAtCompletionTimeMonths: 0,
      varianceAtCompletionTimeDays: 0,
      forecastCompletionDate: dataDate,
      plannedCompletionDate: project?.end_date || dataDate,
      status: 'on_track',
      timeDivergenceNote: 'لا توجد بيانات كافية للحساب.',
      comparisonWithTraditionalEvm: {
        evmSvAmount: 0,
        evmSpi: 1.0,
        esmSvDays: 0,
        esmSpi: 1.0,
        paradoxExplanation: 'البيانات قيد الإعداد.',
      },
      sCurvePoints: [],
    };
  }

  // Canonical EVM — consumed when supplied, otherwise computed here exactly once. There is no
  // second EVM implementation in this engine: BAC, PV, EV, AC, CPI and SPI all come from it.
  const evm =
    sources.evm ||
    calculateProjectEvmAtDataDate(
      project,
      activities,
      sources.budgetLines || [],
      sources.boqItems || [],
      sources.costTransactions || [],
      sources.progressUpdates || [],
      dataDate,
    );

  // The SAME planned-value curve the S-Curve feature renders (shared, not duplicated).
  const sCurve =
    sources.sCurve ||
    generateSCurveData(
      activities,
      [],
      sources.progressUpdates || [],
      sources.costTransactions || [],
      evm,
      project.start_date,
      project.end_date,
      dataDate,
      { project, budgetLines: sources.budgetLines || [], boqItems: sources.boqItems || [] },
    );

  const curvePoints = sCurve.points;
  const curveStart = curvePoints.length > 0 ? curvePoints[0].date : project.start_date || dataDate;
  const curveEnd =
    curvePoints.length > 0 ? curvePoints[curvePoints.length - 1].date : project.end_date || dataDate;

  const startDateIso = project.start_date || curveStart;
  const endDateIso = project.end_date || curveEnd;

  // PD and AT in calendar days, both clamped to the planned span so no derived value can escape it.
  const plannedDurationDays = Math.max(0, daysBetween(startDateIso, endDateIso));
  const actualDaysElapsed = Math.max(
    0,
    Math.min(plannedDurationDays, daysBetween(startDateIso, dataDate)),
  );
  const plannedDurationMonths = plannedDurationDays / DAYS_PER_MONTH;
  const actualMonthsElapsed = actualDaysElapsed / DAYS_PER_MONTH;

  // ---- ES: read time back off the cumulative planned-value curve, with explicit boundaries ----
  const pvFinal = curvePoints.length > 0 ? curvePoints[curvePoints.length - 1].pvEarlyCumulative : 0;
  const earnedValue = Number(evm.ev || 0);
  /** time of bucket i, in calendar days from the project start */
  const timeAt = (i: number) => Math.max(0, daysBetween(startDateIso, curvePoints[i].date));

  let earnedScheduleDays = 0;
  if (!Number.isFinite(earnedValue) || earnedValue <= 0) {
    // Boundary A: nothing earned -> no planned time reached.
    earnedScheduleDays = 0;
  } else if (pvFinal <= 0 || earnedValue >= pvFinal || curvePoints.length < 2) {
    // Boundary C: earned value at or beyond the final planned value (== canonical BAC) -> the whole
    // planned duration is earned. No extrapolation beyond the last point of the curve.
    earnedScheduleDays = plannedDurationDays;
  } else {
    // Boundary B: linear interpolation in time between the two surrounding planned-value points.
    let segment = -1;
    for (let i = 0; i < curvePoints.length - 1; i++) {
      const pvI = curvePoints[i].pvEarlyCumulative;
      const pvNext = curvePoints[i + 1].pvEarlyCumulative;
      // A flat segment carries no planned value, so it cannot be inverted; skip it instead of
      // dividing by zero.
      if (pvNext > pvI && earnedValue >= pvI && earnedValue < pvNext) {
        segment = i;
        break;
      }
    }
    if (segment < 0) {
      // EV is below the first positive planned value: the earned time is inside the first segment.
      earnedScheduleDays = 0;
    } else {
      const pvC = curvePoints[segment].pvEarlyCumulative;
      const pvC1 = curvePoints[segment + 1].pvEarlyCumulative;
      const tC = timeAt(segment);
      const tC1 = timeAt(segment + 1);
      const fraction = (earnedValue - pvC) / (pvC1 - pvC); // in [0, 1)
      earnedScheduleDays = tC + fraction * (tC1 - tC);
    }
  }
  // ES can never leave the planned span: this single clamp is what makes the overflow unreachable.
  earnedScheduleDays = Math.max(0, Math.min(plannedDurationDays, earnedScheduleDays));

  const earnedScheduleMonths = earnedScheduleDays / DAYS_PER_MONTH;

  // ---- Time-based variances and indices ----
  const scheduleVarianceTimeDays = earnedScheduleDays - actualDaysElapsed;
  const scheduleVarianceTimeMonths = scheduleVarianceTimeDays / DAYS_PER_MONTH;
  // AT = 0 means no time has elapsed, so the ratio is undefined and reported as neutral 1.0.
  const schedulePerformanceIndexTime =
    actualDaysElapsed > 0 ? earnedScheduleDays / actualDaysElapsed : 1.0;
  // CPI is the canonical EVM value. It is never re-derived here from a synthetic AC ratio.
  const costPerformanceIndex = Number.isFinite(evm.cpi) ? evm.cpi : 1.0;

  // IEAC(t) = PD / SPI(t), with the SPI(t) = 0 boundary handled explicitly (no Infinity).
  const durationForecastComputable = schedulePerformanceIndexTime > 0 && plannedDurationDays > 0;
  const estimatedDurationAtCompletionDays = durationForecastComputable
    ? plannedDurationDays / schedulePerformanceIndexTime
    : plannedDurationDays;
  const estimatedDurationAtCompletionMonths = estimatedDurationAtCompletionDays / DAYS_PER_MONTH;
  const varianceAtCompletionTimeDays = durationForecastComputable
    ? plannedDurationDays - estimatedDurationAtCompletionDays
    : 0;
  const varianceAtCompletionTimeMonths = varianceAtCompletionTimeDays / DAYS_PER_MONTH;

  const forecastCompletionDate = durationForecastComputable
    ? formatDate(parseDate(startDateIso) + Math.round(estimatedDurationAtCompletionDays) * DAY_MS)
    : endDateIso;
  const plannedCompletionDate = endDateIso;

  // Traditional EVM comparison — canonical values, not recomputed ones.
  const evmSvAmount = Number(evm.sv || 0);
  const evmSpi = Number.isFinite(evm.spi) ? evm.spi : 1.0;

  let status: EarnedScheduleResult['status'] = 'on_track';
  let timeDivergenceNote = '';

  if (!durationForecastComputable && actualDaysElapsed > 0) {
    status = 'critical_delay';
    timeDivergenceNote = `لم يتم تحقيق أي قيمة مكتسبة حتى تاريخ البيانات ${dataDate} رغم مضي ${actualDaysElapsed} يوماً من أصل ${plannedDurationDays} يوماً. لا يمكن حساب المدة المتوقعة للإنجاز (IEAC(t)) عند SPI(t) = 0، لذلك يُعرض الحد الأدنى المخطط ${plannedDurationDays} يوماً وليس تقديراً.`;
  } else if (scheduleVarianceTimeDays >= 0) {
    status = 'ahead';
    timeDivergenceNote = `المشروع متقدم زمنياً بمقدار +${Math.round(scheduleVarianceTimeDays)} يوماً عن المخطط (ES = ${Math.round(earnedScheduleDays)} يوم مقابل AT = ${actualDaysElapsed} يوم).`;
  } else if (scheduleVarianceTimeDays >= -7) {
    status = 'on_track';
    timeDivergenceNote = `المشروع ضمن النطاق المقبول للتذبذب الزمني (تأخير طفيف قدره ${Math.abs(Math.round(scheduleVarianceTimeDays))} يوماً).`;
  } else if (scheduleVarianceTimeDays >= -21) {
    status = 'delayed';
    timeDivergenceNote = `يوجد تأخير زمني قدره ${Math.abs(Math.round(scheduleVarianceTimeDays))} يوماً بمعدل كفاءة زمنية SPI(t) = ${schedulePerformanceIndexTime.toFixed(2)}. يتطلب تدابير تصحيحية.`;
  } else {
    status = 'critical_delay';
    timeDivergenceNote = `تأخير زمني حرج قدره ${Math.abs(Math.round(scheduleVarianceTimeDays))} يوماً. التاريخ المتوقع لإنهاء المشروع سيتأخر حتى ${forecastCompletionDate}. يوصى بتفعيل خطة التعجيل الفوري (Schedule Crashing).`;
  }

  const paradoxExplanation =
    evmSpi < 0.95 && schedulePerformanceIndexTime < 0.95
      ? 'يتوافق المؤشران الزمني والمالي على وجود تأخر، إلا أن SPI(t) يعطي تقديراً أدق بالوحدات الزمنية الفعلية (أيام/أشهر) بدلاً من الفروقات النقدية.'
      : 'تظهر ميزة Earned Schedule في إلغاء الانحراف الشهير لمؤشر SPI الكلاسيكي الذي يتقارب بشكل مضلل نحو 1.0 مع اقتراب نهاية المشروع حتى في حال استمرار التأخير.';

  return {
    actualTimeElapsedMonths: Number(actualMonthsElapsed.toFixed(2)),
    actualTimeElapsedDays: actualDaysElapsed,
    plannedDurationMonths: Number(plannedDurationMonths.toFixed(2)),
    plannedDurationDays,
    earnedScheduleMonths: Number(earnedScheduleMonths.toFixed(2)),
    earnedScheduleDays: Math.round(earnedScheduleDays),
    scheduleVarianceTimeMonths: Number(scheduleVarianceTimeMonths.toFixed(2)),
    scheduleVarianceTimeDays: Math.round(scheduleVarianceTimeDays),
    schedulePerformanceIndexTime: Number(schedulePerformanceIndexTime.toFixed(3)),
    costPerformanceIndex: Number(costPerformanceIndex.toFixed(3)),
    estimatedDurationAtCompletionMonths: Number(estimatedDurationAtCompletionMonths.toFixed(2)),
    estimatedDurationAtCompletionDays: Math.round(estimatedDurationAtCompletionDays),
    varianceAtCompletionTimeMonths: Number(varianceAtCompletionTimeMonths.toFixed(2)),
    varianceAtCompletionTimeDays: Math.round(varianceAtCompletionTimeDays),
    forecastCompletionDate,
    plannedCompletionDate,
    status,
    timeDivergenceNote,
    comparisonWithTraditionalEvm: {
      evmSvAmount: Math.round(evmSvAmount),
      evmSpi: Number(evmSpi.toFixed(3)),
      esmSvDays: Math.round(scheduleVarianceTimeDays),
      esmSpi: Number(schedulePerformanceIndexTime.toFixed(3)),
      paradoxExplanation,
    },
    // The shared S-Curve buckets, projected onto this interface's point shape. Earned/actual values
    // are null on forecast buckets, which map to 0 here because this series is "actual to date".
    sCurvePoints: curvePoints.map((p, i) => ({
      monthIndex: i,
      monthLabel: p.label,
      date: p.date,
      pvCumulative: p.pvEarlyCumulative,
      evCumulative: p.evCumulative ?? 0,
      acCumulative: p.acCumulative ?? 0,
      pvIncremental: p.periodPv,
      evIncremental: p.periodEv ?? 0,
    })),
  };
}

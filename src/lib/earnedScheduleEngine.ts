import type { Activity, Project } from '@/types';

export interface MonthlyDataPoint {
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
  costPerformanceIndex: number; // CPI = EV / AC
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
 * Calculates Earned Schedule (ES) metrics from Project & Activities.
 * Maps EV against the baseline PV(t) curve to derive time-based performance indices.
 */
export function calculateEarnedSchedule(
  project: Project | null,
  activities: Activity[],
  actualCostBudgetRatio: number = 0.95
): EarnedScheduleResult {
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
      forecastCompletionDate: new Date().toISOString().split('T')[0],
      plannedCompletionDate: new Date().toISOString().split('T')[0],
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

  const startDate = new Date(project.start_date || '2026-09-15');
  const endDate = new Date(project.end_date || '2027-05-15');
  const plannedDurationDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
  const plannedDurationMonths = Math.max(1, plannedDurationDays / 30);

  // Determine current evaluation date (e.g. status date or demo cut-off)
  const today = new Date(project.data_date || '2026-11-20');
  const actualDaysElapsed = Math.max(1, Math.min(plannedDurationDays, Math.round((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))));
  const actualMonthsElapsed = actualDaysElapsed / 30;

  // Calculate Total Budget (BAC), Cumulative PV, and Cumulative EV
  const bac = project.contract_value || activities.reduce((sum, a) => sum + (a.planned_quantity || 1) * 100, 0);
  
  // Calculate current average project progress
  const currentProjectProgress = activities.length > 0
    ? (activities.reduce((sum, a) => sum + (a.percent_complete || 0), 0) / activities.length) / 100
    : 0.28;

  // Build monthly cumulative PV curve
  const totalMonthsCount = Math.max(6, Math.ceil(plannedDurationMonths));
  const sCurvePoints: MonthlyDataPoint[] = [];

  for (let m = 0; m <= totalMonthsCount; m++) {
    const pointDate = new Date(startDate.getTime() + m * 30 * 24 * 60 * 60 * 1000);
    const progressFactor = m / totalMonthsCount;
    // Sigmoid curve
    const sVal = 1 / (1 + Math.exp(-6 * (progressFactor - 0.5)));
    const sMin = 1 / (1 + Math.exp(-6 * (0 - 0.5)));
    const sMax = 1 / (1 + Math.exp(-6 * (1 - 0.5)));
    const normalizedPvFactor = Math.max(0, Math.min(1, (sVal - sMin) / (sMax - sMin)));
    const pvCum = Math.round(bac * normalizedPvFactor);

    let evCum = 0;
    let acCum = 0;

    if (m <= Math.ceil(actualMonthsElapsed)) {
      if (m === 0) {
        evCum = 0;
        acCum = 0;
      } else {
        const weight = Math.min(1, m / actualMonthsElapsed);
        evCum = Math.round(bac * currentProjectProgress * weight);
        acCum = Math.round(evCum * actualCostBudgetRatio);
      }
    }

    const prevPv = m > 0 ? sCurvePoints[m - 1].pvCumulative : 0;
    const prevEv = m > 0 ? sCurvePoints[m - 1].evCumulative : 0;

    sCurvePoints.push({
      monthIndex: m,
      monthLabel: `شهر ${m}`,
      date: pointDate.toISOString().split('T')[0],
      pvCumulative: pvCum,
      evCumulative: m <= Math.ceil(actualMonthsElapsed) ? evCum : 0,
      acCumulative: m <= Math.ceil(actualMonthsElapsed) ? acCum : 0,
      pvIncremental: Math.max(0, pvCum - prevPv),
      evIncremental: m <= Math.ceil(actualMonthsElapsed) ? Math.max(0, evCum - prevEv) : 0,
    });
  }

  // Current EV and PV at Actual Time
  const currentEv = bac * currentProjectProgress;
  const currentPvIndex = Math.min(Math.floor(actualMonthsElapsed), sCurvePoints.length - 1);
  const currentPv = sCurvePoints[currentPvIndex]?.pvCumulative || (bac * (actualMonthsElapsed / plannedDurationMonths));
  const currentAc = currentEv * actualCostBudgetRatio;

  // === EARNED SCHEDULE (ES) ALGORITHM ===
  let C = 0;
  for (let i = 0; i < sCurvePoints.length - 1; i++) {
    if (sCurvePoints[i].pvCumulative <= currentEv && currentEv <= sCurvePoints[i + 1].pvCumulative) {
      C = i;
      break;
    }
    if (currentEv > sCurvePoints[sCurvePoints.length - 1].pvCumulative) {
      C = sCurvePoints.length - 1;
    }
  }

  const pvC = sCurvePoints[C]?.pvCumulative || 0;
  const pvCPlus1 = sCurvePoints[C + 1]?.pvCumulative || (pvC + 1);
  const I = (pvCPlus1 - pvC) > 0 ? (currentEv - pvC) / (pvCPlus1 - pvC) : 0;
  
  // Earned Schedule in Months and Days
  const earnedScheduleMonths = Math.max(0, C + I);
  const earnedScheduleDays = Math.round(earnedScheduleMonths * 30);

  // Time-based variances & indices
  const scheduleVarianceTimeMonths = earnedScheduleMonths - actualMonthsElapsed;
  const scheduleVarianceTimeDays = Math.round(scheduleVarianceTimeMonths * 30);
  const schedulePerformanceIndexTime = actualMonthsElapsed > 0 ? earnedScheduleMonths / actualMonthsElapsed : 1.0;
  const costPerformanceIndex = currentAc > 0 ? currentEv / currentAc : 1.0;

  // Forecast Duration & Completion Date
  const estimatedDurationAtCompletionMonths = schedulePerformanceIndexTime > 0 ? plannedDurationMonths / schedulePerformanceIndexTime : plannedDurationMonths;
  const estimatedDurationAtCompletionDays = Math.round(estimatedDurationAtCompletionMonths * 30);
  const varianceAtCompletionTimeMonths = plannedDurationMonths - estimatedDurationAtCompletionMonths;
  const varianceAtCompletionTimeDays = Math.round(varianceAtCompletionTimeMonths * 30);

  const forecastEndDateObj = new Date(startDate.getTime() + estimatedDurationAtCompletionDays * 24 * 60 * 60 * 1000);
  const forecastCompletionDate = forecastEndDateObj.toISOString().split('T')[0];

  // Traditional EVM comparison metrics
  const evmSvAmount = currentEv - currentPv;
  const evmSpi = currentPv > 0 ? currentEv / currentPv : 1.0;

  let status: EarnedScheduleResult['status'] = 'on_track';
  let timeDivergenceNote = '';

  if (scheduleVarianceTimeDays >= 0) {
    status = 'ahead';
    timeDivergenceNote = `المشروع متقدم زمنياً بمقدار +${scheduleVarianceTimeDays} يوماً عن المخطط (ES = ${earnedScheduleDays} يوم مقابل AT = ${actualDaysElapsed} يوم).`;
  } else if (scheduleVarianceTimeDays >= -7) {
    status = 'on_track';
    timeDivergenceNote = `المشروع ضمن النطاق المقبول للتذبذب الزمني (تأخير طفيف قدره ${Math.abs(scheduleVarianceTimeDays)} يوماً).`;
  } else if (scheduleVarianceTimeDays >= -21) {
    status = 'delayed';
    timeDivergenceNote = `يوجد تأخير زمني قدره ${Math.abs(scheduleVarianceTimeDays)} يوماً بمعدل كفاءة زمنية SPI(t) = ${schedulePerformanceIndexTime.toFixed(2)}. يتطلب تدابير تصحيحية.`;
  } else {
    status = 'critical_delay';
    timeDivergenceNote = `تأخير زمني حرج قدره ${Math.abs(scheduleVarianceTimeDays)} يوماً. التاريخ المتوقع لإنهاء المشروع سيتأخر حتى ${forecastCompletionDate}. يوصى بتفعيل خطة التعجيل الفوري (Schedule Crashing).`;
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
    earnedScheduleDays,
    scheduleVarianceTimeMonths: Number(scheduleVarianceTimeMonths.toFixed(2)),
    scheduleVarianceTimeDays,
    schedulePerformanceIndexTime: Number(schedulePerformanceIndexTime.toFixed(3)),
    costPerformanceIndex: Number(costPerformanceIndex.toFixed(3)),
    estimatedDurationAtCompletionMonths: Number(estimatedDurationAtCompletionMonths.toFixed(2)),
    estimatedDurationAtCompletionDays,
    varianceAtCompletionTimeMonths: Number(varianceAtCompletionTimeMonths.toFixed(2)),
    varianceAtCompletionTimeDays,
    forecastCompletionDate,
    plannedCompletionDate: project.end_date || '2027-05-15',
    status,
    timeDivergenceNote,
    comparisonWithTraditionalEvm: {
      evmSvAmount: Math.round(evmSvAmount),
      evmSpi: Number(evmSpi.toFixed(3)),
      esmSvDays: scheduleVarianceTimeDays,
      esmSpi: Number(schedulePerformanceIndexTime.toFixed(3)),
      paradoxExplanation,
    },
    sCurvePoints,
  };
}

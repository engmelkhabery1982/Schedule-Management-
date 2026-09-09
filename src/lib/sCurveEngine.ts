import type { Activity, BaselineActivity, CostTransaction, ProgressUpdate, EvmMetrics } from '@/types';

export interface SCurvePoint {
  date: string; // 'YYYY-MM-DD'
  label: string; // Arabic display e.g. 'أكتوبر 2026' or 'W1-Oct'
  pvEarlyCumulative: number;
  pvLateCumulative: number;
  evCumulative: number | null; // null for future periods
  acCumulative: number | null; // null for future periods
  forecastCumulative: number | null; // projection for future
  periodPv: number;
  periodEv: number | null;
  periodAc: number | null;
}

export interface SCurveData {
  points: SCurvePoint[];
  bac: number;
  currentEv: number;
  currentAc: number;
  forecastEac: number;
  dataDate: string;
}

function parseDate(d: string): number {
  return new Date(`${d}T00:00:00Z`).getTime();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

export function generateSCurveData(
  activities: Activity[],
  baselineActivities: BaselineActivity[],
  progressUpdates: ProgressUpdate[],
  costTransactions: CostTransaction[],
  evm: EvmMetrics,
  projectStartDate?: string | null,
  projectEndDate?: string | null,
): SCurveData {
  if (activities.length === 0) {
    return {
      points: [],
      bac: evm.bac,
      currentEv: evm.ev,
      currentAc: evm.ac,
      forecastEac: evm.eac,
      dataDate: new Date().toISOString().split('T')[0],
    };
  }

  // Determine overall project date span
  let minTime = Infinity;
  let maxTime = -Infinity;

  activities.forEach((act) => {
    if (act.early_start) minTime = Math.min(minTime, parseDate(act.early_start));
    if (act.early_finish) maxTime = Math.max(maxTime, parseDate(act.early_finish));
    if (act.late_finish) maxTime = Math.max(maxTime, parseDate(act.late_finish));
  });

  if (projectStartDate) minTime = Math.min(minTime, parseDate(projectStartDate));
  if (projectEndDate) maxTime = Math.max(maxTime, parseDate(projectEndDate));

  if (minTime === Infinity || maxTime === -Infinity) {
    const today = Date.now();
    minTime = today;
    maxTime = today + 90 * 86400000;
  }

  // Generate weekly/bi-weekly cut-off points
  const DAY_MS = 86400000;
  const totalDurationDays = Math.max(14, Math.round((maxTime - minTime) / DAY_MS));
  // Step size: 7 days if short project (< 120 days), 14 days if medium, 30 days if long (> 360 days)
  const stepDays = totalDurationDays > 360 ? 30 : totalDurationDays > 120 ? 14 : 7;
  const stepMs = stepDays * DAY_MS;

  const cutOffDates: number[] = [];
  let currentCutoff = minTime;
  while (currentCutoff <= maxTime + stepMs) {
    cutOffDates.push(currentCutoff);
    currentCutoff += stepMs;
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const todayTime = parseDate(todayStr);

  const totalBac = Math.max(
    evm.bac,
    activities.reduce((sum, act) => sum + (act.planned_quantity || 1) * 100, 0),
  );

  // Assign a planned cost weight to each activity
  const actCostMap = new Map<string, number>();
  const totalWeights = activities.reduce((s, a) => s + Math.max(1, a.planned_quantity || 1), 0);

  activities.forEach((act) => {
    const weight = Math.max(1, act.planned_quantity || 1) / totalWeights;
    actCostMap.set(act.id, totalBac * weight);
  });

  // Calculate Cumulative PV (Early and Late) for each cutoff date
  const points: SCurvePoint[] = [];
  let lastValidEv = 0;
  let lastValidAc = 0;

  // Process approved progress updates sorted by date
  const approvedUpdates = [...progressUpdates]
    .filter((u) => u.status === 'approved')
    .sort((a, b) => a.update_date.localeCompare(b.update_date));

  // Process approved cost transactions sorted by date
  const approvedCosts = [...costTransactions]
    .filter((c) => c.status === 'approved')
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));

  for (let i = 0; i < cutOffDates.length; i++) {
    const cutoff = cutOffDates[i];
    const cutoffStr = formatDate(cutoff);
    const d = new Date(cutoff);
    const label = d.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' });

    // Early PV calculation
    let pvEarly = 0;
    let pvLate = 0;

    activities.forEach((act) => {
      const cost = actCostMap.get(act.id) || 0;
      const actStartEarly = act.early_start ? parseDate(act.early_start) : minTime;
      const actFinishEarly = act.early_finish ? parseDate(act.early_finish) : maxTime;
      const actStartLate = act.late_start ? parseDate(act.late_start) : actStartEarly;
      const actFinishLate = act.late_finish ? parseDate(act.late_finish) : actFinishEarly;

      // Early progression
      if (cutoff >= actFinishEarly) {
        pvEarly += cost;
      } else if (cutoff > actStartEarly && actFinishEarly > actStartEarly) {
        const ratio = (cutoff - actStartEarly) / (actFinishEarly - actStartEarly);
        pvEarly += cost * Math.max(0, Math.min(1, ratio));
      }

      // Late progression
      if (cutoff >= actFinishLate) {
        pvLate += cost;
      } else if (cutoff > actStartLate && actFinishLate > actStartLate) {
        const ratio = (cutoff - actStartLate) / (actFinishLate - actStartLate);
        pvLate += cost * Math.max(0, Math.min(1, ratio));
      }
    });

    const isPastOrPresent = cutoff <= todayTime + stepMs / 2;

    // EV up to this cutoff
    let evVal: number | null = null;
    let acVal: number | null = null;
    let forecastVal: number | null = null;

    if (isPastOrPresent) {
      // Calculate EV from approved updates or EVM
      const updatesToDate = approvedUpdates.filter((u) => parseDate(u.update_date) <= cutoff);
      if (updatesToDate.length > 0) {
        // Average progress to date
        const latestPerAct = new Map<string, number>();
        updatesToDate.forEach((u) => latestPerAct.set(u.activity_id, u.percent_complete));
        let sumWeighted = 0;
        activities.forEach((act) => {
          const pct = latestPerAct.get(act.id) || (act.actual_start && parseDate(act.actual_start) <= cutoff ? act.percent_complete : 0);
          const cost = actCostMap.get(act.id) || 0;
          sumWeighted += cost * (pct / 100);
        });
        evVal = Math.round(sumWeighted);
      } else {
        // Proportional to current EV
        const timeRatio = Math.max(0, Math.min(1, (cutoff - minTime) / Math.max(1, todayTime - minTime)));
        evVal = Math.round(evm.ev * timeRatio);
      }

      // Calculate AC from cost transactions
      const costsToDate = approvedCosts.filter((c) => parseDate(c.transaction_date) <= cutoff);
      if (costsToDate.length > 0) {
        acVal = Math.round(costsToDate.reduce((sum, c) => sum + Number(c.amount || 0), 0));
      } else {
        const timeRatio = Math.max(0, Math.min(1, (cutoff - minTime) / Math.max(1, todayTime - minTime)));
        acVal = Math.round(evm.ac * timeRatio);
      }

      lastValidEv = evVal || lastValidEv;
      lastValidAc = acVal || lastValidAc;
    } else {
      // Future Projection (Forecast EAC Curve)
      const remainingTime = maxTime - todayTime;
      const currentOffset = cutoff - todayTime;
      const progressFactor = remainingTime > 0 ? Math.min(1, currentOffset / remainingTime) : 1;
      const remainingCost = Math.max(0, evm.eac - lastValidAc);
      forecastVal = Math.round(lastValidAc + remainingCost * progressFactor);
    }

    const prevPv = i > 0 ? points[i - 1].pvEarlyCumulative : 0;
    const prevEv = i > 0 && points[i - 1].evCumulative !== null ? (points[i - 1].evCumulative as number) : 0;
    const prevAc = i > 0 && points[i - 1].acCumulative !== null ? (points[i - 1].acCumulative as number) : 0;

    points.push({
      date: cutoffStr,
      label,
      pvEarlyCumulative: Math.round(pvEarly),
      pvLateCumulative: Math.round(pvLate),
      evCumulative: evVal,
      acCumulative: acVal,
      forecastCumulative: forecastVal,
      periodPv: Math.max(0, Math.round(pvEarly - prevPv)),
      periodEv: evVal !== null ? Math.max(0, Math.round(evVal - prevEv)) : null,
      periodAc: acVal !== null ? Math.max(0, Math.round(acVal - prevAc)) : null,
    });
  }

  return {
    points,
    bac: totalBac,
    currentEv: lastValidEv || evm.ev,
    currentAc: lastValidAc || evm.ac,
    forecastEac: evm.eac,
    dataDate: todayStr,
  };
}

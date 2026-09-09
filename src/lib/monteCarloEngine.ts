import type { Activity, ActivityLink, Risk, CalendarType } from '@/types';
import { getCalendar, addWorkingDays } from './calendarEngine';

export interface MonteCarloResult {
  iterations: number;
  p50Finish: string;
  p80Finish: string;
  p90Finish: string;
  p50Cost: number;
  p80Cost: number;
  p90Cost: number;
  scheduleDistribution: { days: number; count: number; finishDate: string }[];
  criticalityIndex: { activityCode: string; activityName: string; probability: number }[];
}

// Sample from Triangular Distribution
function sampleTriangular(min: number, mode: number, max: number): number {
  const u = Math.random();
  const f = (mode - min) / Math.max(0.001, max - min);
  if (u <= f) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  } else {
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
}

export function runMonteCarloSimulation(
  activities: Activity[],
  links: ActivityLink[],
  risks: Risk[],
  totalBudget: number,
  iterations = 500,
  calendarType: CalendarType = '6_days',
): MonteCarloResult {
  const calendar = getCalendar(calendarType);

  if (activities.length === 0) {
    const today = new Date().toISOString().split('T')[0];
    return {
      iterations: 0,
      p50Finish: today,
      p80Finish: today,
      p90Finish: today,
      p50Cost: totalBudget,
      p80Cost: totalBudget,
      p90Cost: totalBudget,
      scheduleDistribution: [],
      criticalityIndex: [],
    };
  }

  // Map predecessor links
  const predecessors = new Map<string, ActivityLink[]>();
  links.forEach((l) => {
    predecessors.set(l.successor_id, [...(predecessors.get(l.successor_id) || []), l]);
  });

  const projectStart = activities.reduce((earliest, a) => {
    if (!a.early_start) return earliest;
    return !earliest || a.early_start < earliest ? a.early_start : earliest;
  }, new Date().toISOString().split('T')[0]);

  // Estimate 3-point durations for each activity
  const openRisks = risks.filter((r) => r.status === 'open');
  const avgRiskMultiplier = 1 + (openRisks.reduce((sum, r) => sum + r.severity, 0) / Math.max(1, openRisks.length * 25)) * 0.4;

  const activityRanges = activities.map((act) => {
    const baseDuration = act.is_milestone ? 0 : Math.max(1, act.duration_days);
    const optimistic = Math.max(1, Math.round(baseDuration * 0.85));
    const mostLikely = baseDuration;
    const pessimistic = Math.max(mostLikely, Math.round(baseDuration * avgRiskMultiplier));
    return {
      id: act.id,
      code: act.code,
      name: act.name,
      optimistic,
      mostLikely,
      pessimistic,
      isMilestone: act.is_milestone,
    };
  });

  const durationResults: number[] = []; // project duration in days for each run
  const costResults: number[] = [];
  const criticalCounts = new Map<string, number>();
  activities.forEach((a) => criticalCounts.set(a.id, 0));

  for (let iter = 0; iter < iterations; iter++) {
    // 1. Sample durations
    const sampledDurations = new Map<string, number>();
    activityRanges.forEach((range) => {
      if (range.isMilestone) {
        sampledDurations.set(range.id, 0);
      } else {
        const sampled = Math.round(sampleTriangular(range.optimistic, range.mostLikely, range.pessimistic));
        sampledDurations.set(range.id, Math.max(1, sampled));
      }
    });

    // 2. Forward pass to find finish dates
    const finishes = new Map<string, number>(); // relative duration from project start in working days
    let maxProjectDuration = 0;
    let criticalEndAct = '';

    activities.forEach((act) => {
      const preds = predecessors.get(act.id) || [];
      let startDay = 0;

      if (preds.length > 0) {
        for (const p of preds) {
          const predFinish = finishes.get(p.predecessor_id) || 0;
          const lag = p.lag_days || 0;
          startDay = Math.max(startDay, predFinish + lag);
        }
      }

      const dur = sampledDurations.get(act.id) || 0;
      const finishDay = startDay + dur;
      finishes.set(act.id, finishDay);

      if (finishDay >= maxProjectDuration) {
        maxProjectDuration = finishDay;
        criticalEndAct = act.id;
      }
    });

    if (criticalEndAct) {
      criticalCounts.set(criticalEndAct, (criticalCounts.get(criticalEndAct) || 0) + 1);
    }

    durationResults.push(maxProjectDuration);

    // 3. Sample cost with risk volatility
    const costVariation = sampleTriangular(0.95, 1.0, 1.15 + (avgRiskMultiplier - 1));
    costResults.push(Math.round(totalBudget * costVariation));
  }

  // Sort results to calculate percentiles
  durationResults.sort((a, b) => a - b);
  costResults.sort((a, b) => a - b);

  const p50Idx = Math.floor(iterations * 0.5);
  const p80Idx = Math.floor(iterations * 0.8);
  const p90Idx = Math.floor(iterations * 0.9);

  const p50Days = durationResults[p50Idx] || 0;
  const p80Days = durationResults[p80Idx] || 0;
  const p90Days = durationResults[p90Idx] || 0;

  const p50Finish = addWorkingDays(projectStart, p50Days, calendar);
  const p80Finish = addWorkingDays(projectStart, p80Days, calendar);
  const p90Finish = addWorkingDays(projectStart, p90Days, calendar);

  // Criticality Index
  const criticalityIndex = activities.map((a) => ({
    activityCode: a.code,
    activityName: a.name,
    probability: Math.round(((criticalCounts.get(a.id) || 0) / iterations) * 100),
  })).sort((a, b) => b.probability - a.probability);

  return {
    iterations,
    p50Finish,
    p80Finish,
    p90Finish,
    p50Cost: costResults[p50Idx] || totalBudget,
    p80Cost: costResults[p80Idx] || totalBudget,
    p90Cost: costResults[p90Idx] || totalBudget,
    scheduleDistribution: [],
    criticalityIndex,
  };
}

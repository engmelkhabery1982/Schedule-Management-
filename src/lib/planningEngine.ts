import type { ParsedBoqRow, EvmMetrics, Activity, Risk, BoqItem, BudgetLine } from '@/types';

export interface ProductivityRule {
  category: string;
  daily_output: number;
  crew_size: number;
  difficulty_factor: number;
}

export interface SmartActivityPlan {
  code: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  duration_days: number;
  planned_cost: number;
  early_start: string;
  early_finish: string;
  predecessor_code: string | null;
}

const DEFAULT_PRODUCTIVITY: Record<string, ProductivityRule> = {
  Foundations: { category: 'Foundations', daily_output: 25, crew_size: 6, difficulty_factor: 1 },
  Earthworks: { category: 'Earthworks', daily_output: 120, crew_size: 5, difficulty_factor: 1 },
  'Concrete Works': { category: 'Concrete Works', daily_output: 40, crew_size: 8, difficulty_factor: 1 },
  'Reinforcement Steel': { category: 'Reinforcement Steel', daily_output: 2.5, crew_size: 5, difficulty_factor: 1 },
  Masonry: { category: 'Masonry', daily_output: 35, crew_size: 6, difficulty_factor: 1 },
  'Roofing & Insulation': { category: 'Roofing & Insulation', daily_output: 60, crew_size: 5, difficulty_factor: 1 },
  Plastering: { category: 'Plastering', daily_output: 80, crew_size: 5, difficulty_factor: 1 },
  'Tiling & Flooring': { category: 'Tiling & Flooring', daily_output: 45, crew_size: 5, difficulty_factor: 1 },
  'Doors & Windows': { category: 'Doors & Windows', daily_output: 8, crew_size: 4, difficulty_factor: 1 },
  Electrical: { category: 'Electrical', daily_output: 12, crew_size: 5, difficulty_factor: 1 },
  'Plumbing & Drainage': { category: 'Plumbing & Drainage', daily_output: 10, crew_size: 5, difficulty_factor: 1 },
  HVAC: { category: 'HVAC', daily_output: 4, crew_size: 4, difficulty_factor: 1 },
  Painting: { category: 'Painting', daily_output: 100, crew_size: 5, difficulty_factor: 1 },
  General: { category: 'General', daily_output: 20, crew_size: 4, difficulty_factor: 1 },
};

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + Math.max(0, days));
  return result;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function getProductivityRule(category: string, rules: ProductivityRule[] = []): ProductivityRule {
  return rules.find((rule) => rule.category === category) || DEFAULT_PRODUCTIVITY[category] || DEFAULT_PRODUCTIVITY.General;
}

export function calculateProductionDuration(quantity: number, category: string, rules: ProductivityRule[] = []): number {
  const rule = getProductivityRule(category, rules);
  if (quantity <= 0) return 1;
  return Math.max(1, Math.ceil((quantity / rule.daily_output) * rule.difficulty_factor));
}

export function generateSmartActivityPlans(
  rows: ParsedBoqRow[],
  startDate: string,
  rules: ProductivityRule[] = [],
): SmartActivityPlan[] {
  let cursor = new Date(startDate);
  let predecessorCode: string | null = null;

  return rows.map((row, index) => {
    const category = row.category || 'General';
    const duration = calculateProductionDuration(row.quantity, category, rules);
    const start = new Date(cursor);
    const finish = addDays(start, duration);
    const plan: SmartActivityPlan = {
      code: `SMART-ACT-${String(index + 1).padStart(3, '0')}`,
      name: row.description.substring(0, 100),
      category,
      quantity: row.quantity,
      unit: row.unit,
      duration_days: duration,
      planned_cost: row.total_price,
      early_start: formatDate(start),
      early_finish: formatDate(finish),
      predecessor_code: predecessorCode,
    };
    predecessorCode = plan.code;
    cursor = addDays(finish, 1);
    return plan;
  });
}

export function calculateEvmMetrics(
  bac: number,
  plannedProgress: number,
  actualProgress: number,
  actualCost: number,
): EvmMetrics {
  const pv = bac * Math.max(0, Math.min(plannedProgress, 1));
  const ev = bac * Math.max(0, Math.min(actualProgress, 1));
  const sv = ev - pv;
  const cv = ev - actualCost;
  const spi = pv > 0 ? ev / pv : 1;
  const cpi = actualCost > 0 ? ev / actualCost : 1;
  const eac = cpi > 0 ? bac / cpi : bac;
  return {
    bac,
    pv,
    ev,
    ac: actualCost,
    sv,
    cv,
    spi,
    cpi,
    eac,
    etc: Math.max(0, eac - actualCost),
    vac: bac - eac,
  };
}

export function calculateQuantityBasedEvm(
  activities: Activity[],
  boqItems: BoqItem[],
  budgetLines: BudgetLine[],
  plannedProgress: number,
  actualCost: number,
): EvmMetrics {
  const boqById = new Map(boqItems.map((item) => [item.id, item]));
  const bac = budgetLines.reduce((sum, line) => sum + Number(line.approved_budget ?? line.estimated_cost ?? line.planned_cost ?? 0), 0);
  
  const quantityEv = activities.reduce((sum, activity) => {
    const boqId = activity.wbs_node?.boq_item_id;
    const item = boqId ? boqById.get(boqId) : undefined;
    const value = item ? Number(item.unit_price || 0) * Math.min(Number(item.quantity || 0), Math.max(0, Number(activity.actual_quantity || 0))) : 0;
    return sum + value;
  }, 0);

  // Fallback to progress-weighted EV if BOQ unit link is not mapped
  const totalActCount = Math.max(1, activities.length);
  const weightedEv = activities.reduce((sum, act) => {
    return sum + (Math.max(0, Math.min(100, Number(act.percent_complete || 0))) / 100) * (bac / totalActCount);
  }, 0);

  const ev = quantityEv > 0 ? quantityEv : (weightedEv > 0 ? weightedEv : bac * 0.405);
  const pv = bac * Math.max(0, Math.min(plannedProgress || 0.40, 1));
  const effectiveAc = actualCost > 0 ? actualCost : Math.round(ev * 0.96);
  const sv = ev - pv;
  const cv = ev - effectiveAc;
  const spi = pv > 0 ? Math.max(0.1, ev / pv) : 1;
  const cpi = effectiveAc > 0 ? Math.max(0.1, ev / effectiveAc) : 1;
  const eac = cpi > 0 ? bac / cpi : bac;
  return { bac, pv, ev, ac: effectiveAc, sv, cv, spi, cpi, eac, etc: Math.max(0, eac - effectiveAc), vac: bac - eac };
}

export function calculateWeightedProgress(
  activities: Activity[],
  weights: Map<string, number>,
): number {
  if (activities.length === 0) return 0;
  let weightedValue = 0;
  let totalWeight = 0;
  activities.forEach((activity) => {
    const weight = Math.max(0, weights.get(activity.id) || 0);
    weightedValue += weight * Math.max(0, Math.min(100, Number(activity.percent_complete || 0)));
    totalWeight += weight;
  });
  return totalWeight > 0
    ? weightedValue / totalWeight / 100
    : activities.reduce((sum, activity) => sum + Number(activity.percent_complete || 0), 0) / activities.length / 100;
}

export function forecastFinishDate(
  plannedFinish: string | null,
  spi: number,
  today = new Date(),
): string | null {
  if (!plannedFinish) return null;
  if (spi <= 0) return null;
  const planned = new Date(`${plannedFinish}T00:00:00Z`);
  const remainingDays = Math.max(0, Math.ceil((planned.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));
  const forecast = new Date(today);
  forecast.setUTCDate(forecast.getUTCDate() + Math.ceil(remainingDays / spi));
  return forecast.toISOString().split('T')[0];
}

export interface ForecastScenarios {
  optimistic: string | null;
  realistic: string | null;
  pessimistic: string | null;
}

export interface ForecastAnalysis {
  scenarios: ForecastScenarios;
  cost: {
    optimistic: number;
    realistic: number;
    pessimistic: number;
  };
  confidence: number;
  volatility: number;
  riskExposure: {
    cost: number;
    days: number;
  };
}

export function forecastFinishScenarios(
  plannedStart: string | null,
  plannedFinish: string | null,
  actualProgress: number,
  spi: number,
  today = new Date(),
): ForecastScenarios {
  if (!plannedStart || !plannedFinish || actualProgress >= 1) {
    return { optimistic: plannedFinish, realistic: plannedFinish, pessimistic: plannedFinish };
  }

  const start = new Date(`${plannedStart}T00:00:00Z`);
  const finish = new Date(`${plannedFinish}T00:00:00Z`);
  const totalDays = Math.max(1, Math.ceil((finish.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
  const remainingDays = Math.max(0, totalDays * (1 - Math.max(0, Math.min(1, actualProgress))));
  const calculate = (performanceIndex: number): string => {
    const forecast = new Date(today);
    forecast.setUTCDate(forecast.getUTCDate() + Math.ceil(remainingDays / Math.max(0.25, performanceIndex)));
    return forecast.toISOString().split('T')[0];
  };
  return {
    optimistic: calculate(Math.max(1, spi)),
    realistic: calculate(spi),
    pessimistic: calculate(Math.min(0.75, spi)),
  };
}

export function analyzeForecast(
  plannedStart: string | null,
  plannedFinish: string | null,
  bac: number,
  actualCost: number,
  actualProgress: number,
  spi: number,
  cpi: number,
  criticalCount: number,
  nearCriticalCount: number,
  risks: Risk[] = [],
): ForecastAnalysis {
  const safeCpi = Math.max(0.25, cpi || 1);
  const safeSpi = Math.max(0.25, spi || 1);
  const volatility = Math.min(1, Math.abs(1 - safeSpi) * 0.6 + Math.abs(1 - safeCpi) * 0.4);
  const confidence = Math.round(Math.max(0, Math.min(100, 100 - volatility * 70 - criticalCount * 2 - nearCriticalCount)));
  const remaining = Math.max(0, 1 - Math.max(0, Math.min(1, actualProgress)));
  const openRisks = risks.filter((risk) => risk.status === 'open');
  const riskExposure = openRisks.reduce((exposure, risk) => ({
    cost: exposure.cost + bac * (Math.max(0, Math.min(5, Number(risk.probability || 0))) / 5)
      * (Math.max(0, Math.min(5, Number(risk.impact || 0))) / 5) * 0.05,
    days: exposure.days + (Math.max(0, Math.min(5, Number(risk.probability || 0))) / 5)
      * (Math.max(0, Math.min(5, Number(risk.impact || 0))) / 5) * 5,
  }), { cost: 0, days: 0 });
  return {
    scenarios: forecastFinishScenarios(plannedStart, plannedFinish, actualProgress, safeSpi),
    cost: {
      optimistic: actualCost + (bac * remaining) / Math.max(1, safeCpi * 1.15),
      realistic: actualCost + (bac * remaining) / safeCpi,
      pessimistic: actualCost + (bac * remaining) / Math.max(0.25, safeCpi * 0.8),
    },
    confidence,
    volatility,
    riskExposure,
  };
}

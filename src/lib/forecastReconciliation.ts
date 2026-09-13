/**
 * Finish-forecast reconciliation — GAP-041.
 *
 * Two legitimate, different methods answer "when will this project finish?", and the screens used
 * to show them with labels that made them look like one conflicting date:
 *
 *   1. CPM Deterministic Early Finish — the latest `early_finish` produced by the CPM forward pass.
 *      A deterministic schedule date: it follows from the network logic, durations and calendars,
 *      and it does not move with cost or progress performance.
 *   2. Earned Schedule Trend Forecast — the completion date implied by `IEAC(t) = PD / SPI(t)`
 *      (Wave 5, `@/lib/earnedScheduleEngine`). A performance-based trend forecast: it moves with
 *      measured progress and is NOT computable when `SPI(t)` is 0.
 *
 * This module does not reconcile them to a single number and it does not implement either method.
 * It reads both, names both, and reports the difference in days so a report can show
 * "CPM says X, the earned-schedule trend says Y, delta N days" instead of one ambiguous date.
 * When the trend forecast is not computable the result says so explicitly (`esTrendFinish: null`
 * plus `esAvailability`) rather than substituting the planned date or any other fabricated value.
 *
 * Boundary: `@/lib/earnedScheduleEngine` and `@/lib/cpmEngine` are consumed as they are; nothing
 * here changes their formulas, and no view needs its own copy of this logic.
 */
import type { Activity } from '@/types';
import type { EarnedScheduleResult } from '@/lib/earnedScheduleEngine';

export type FinishForecastMethod = 'cpm_deterministic' | 'earned_schedule_trend';

/** Method labels, exported so every screen names the two methods identically. */
export const FINISH_METHOD_LABELS: Record<
  FinishForecastMethod,
  { nameAr: string; nameEn: string; basisAr: string; basisEn: string }
> = {
  cpm_deterministic: {
    nameAr: 'النهاية المبكرة الحتمية (CPM)',
    nameEn: 'CPM Deterministic Early Finish',
    basisAr: 'أقصى نهاية مبكرة لأنشطة الشبكة من المرور الأمامي لحساب CPM — تاريخ حتمي مشتق من منطق الجدول والمدد والتقويم، ولا يتأثر بأداء التكلفة أو التقدم.',
    basisEn:
      'The latest early finish across the network from the CPM forward pass — a deterministic schedule date derived from network logic, durations and calendars, independent of cost or progress performance.',
  },
  earned_schedule_trend: {
    nameAr: 'تنبؤ الجدول المكتسب الاتجاهي (IEAC(t))',
    nameEn: 'Earned Schedule Trend Forecast',
    basisAr: 'تاريخ الإنجاز المتوقع من IEAC(t) = PD / SPI(t) — تنبؤ اتجاهي قائم على الأداء الزمني المقاس، وغير قابل للحساب عندما يكون SPI(t) = 0.',
    basisEn:
      'The completion date implied by IEAC(t) = PD / SPI(t) — a performance-based trend forecast that is not computable when SPI(t) is 0.',
  },
};

/** Why the earned-schedule trend forecast is unavailable, when it is. */
export type EsForecastAvailability =
  | 'computable'
  | 'no_earned_schedule' // no Earned Schedule result was supplied
  | 'no_planned_duration' // PD = 0: no project span to forecast against
  | 'spi_t_zero'; // SPI(t) = 0: IEAC(t) = PD / SPI(t) is unbounded (Wave 5 reports a PD floor)

export interface FinishForecastReconciliation {
  /** Method 1: latest `early_finish` across the project's activities, or null when there is none. */
  cpmEarlyFinish: string | null;
  /** How many activities carried an `early_finish` (0 means the CPM date is unavailable too). */
  cpmActivityCount: number;
  /** Method 2: the trend forecast date, or null when it is not computable. Never a substitute date. */
  esTrendFinish: string | null;
  esAvailability: EsForecastAvailability;
  esComputable: boolean;
  /**
   * `esTrendFinish - cpmEarlyFinish` in calendar days; positive means the earned-schedule trend is
   * later than the deterministic CPM finish. Null unless both dates exist.
   */
  deltaDays: number | null;
  /** True only when both methods produced a date, i.e. when a delta is meaningful. */
  bothAvailable: boolean;
  /** The labels a screen should render next to each date. */
  labels: typeof FINISH_METHOD_LABELS;
}

const DAY_MS = 86_400_000;

/** Calendar days from `fromIso` to `toIso` (UTC midnight parsing, so it is timezone independent). */
function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.NaN;
  return Math.round((to - from) / DAY_MS);
}

/**
 * The deterministic CPM finish of a project: the latest `early_finish` in its activity network.
 * ISO `YYYY-MM-DD` strings compare correctly as strings, so no date parsing is involved.
 * `actual_finish` is deliberately NOT used: this is the CPM early finish of the current plan, which
 * is what the schedule screen reports, not an actuals roll-up.
 */
export function calculateCpmDeterministicEarlyFinish(activities: Activity[]): string | null {
  const list = Array.isArray(activities) ? activities : [];
  let latest: string | null = null;
  let count = 0;
  list.forEach((activity) => {
    const finish = activity?.early_finish;
    if (typeof finish !== 'string' || !finish) return;
    count += 1;
    if (latest === null || finish > latest) latest = finish;
  });
  return count > 0 ? latest : null;
}

/**
 * Read both finish methods and report them side by side with their delta (GAP-041).
 *
 * `esComputable` mirrors the Earned Schedule engine's own documented condition for a computable
 * IEAC(t) (`SPI(t) > 0` and `PD > 0`); when it is false the engine returns its PD floor and the
 * planned completion date, which must NOT be presented as a trend forecast, so `esTrendFinish` is
 * null and `esAvailability` explains why.
 */
export function reconcileFinishForecasts(
  activities: Activity[],
  earnedSchedule: EarnedScheduleResult | null | undefined,
): FinishForecastReconciliation {
  const cpmEarlyFinish = calculateCpmDeterministicEarlyFinish(activities);
  const cpmActivityCount = (Array.isArray(activities) ? activities : []).filter(
    (activity) => typeof activity?.early_finish === 'string' && activity.early_finish !== '',
  ).length;

  let esAvailability: EsForecastAvailability = 'computable';
  if (!earnedSchedule) esAvailability = 'no_earned_schedule';
  else if (!(earnedSchedule.plannedDurationDays > 0)) esAvailability = 'no_planned_duration';
  else if (!(earnedSchedule.schedulePerformanceIndexTime > 0)) esAvailability = 'spi_t_zero';

  const esComputable = esAvailability === 'computable';
  const esTrendFinish = esComputable && earnedSchedule ? earnedSchedule.forecastCompletionDate : null;

  const bothAvailable = cpmEarlyFinish !== null && esTrendFinish !== null;
  const deltaDays = bothAvailable ? daysBetweenIso(cpmEarlyFinish as string, esTrendFinish as string) : null;

  return {
    cpmEarlyFinish,
    cpmActivityCount,
    esTrendFinish,
    esAvailability,
    esComputable,
    deltaDays: deltaDays !== null && Number.isFinite(deltaDays) ? deltaDays : null,
    bothAvailable,
    labels: FINISH_METHOD_LABELS,
  };
}

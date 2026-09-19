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
 * P2A1-NEW-GAP-03 — which "CPM says X" is authoritative.
 * ------------------------------------------------------
 * The deterministic side used to be read off the STORED `activities.early_finish` column. Those
 * dates are a persisted snapshot of some earlier CPM run (or, in seed data, hand-authored), so they
 * do not move when the schedule is statused: on the shipped pilot seed the stored column says
 * 2027-02-28 while the statused F5 CPM — the same engine Dashboard, ScheduleView and F5 itself
 * publish — forecasts 2027-03-03. ProgressView and the Executive Report therefore showed a
 * "deterministic finish" that contradicted every other screen for the same project at the same
 * governed Data Date.
 *
 * The authoritative deterministic project forecast finish is now the F5 STATUSSED CPM forecast
 * finish. Callers pass it explicitly (`statusedForecastFinish`), or derive it with
 * `resolveDeterministicForecastFinish`, which runs the governed statused CPM once rather than
 * reading frozen activity dates. The stored-column quote is still available
 * (`calculateCpmDeterministicEarlyFinish`) and is still what an actuals-free "stored plan" reading
 * means, but it is never presented as the CURRENT project forecast: `deterministicFinishSource`
 * states which basis a consumer is looking at, so the two can never be confused again.
 *
 * Boundary: `@/lib/earnedScheduleEngine`, `@/lib/cpmEngine` and `@/lib/scheduleControlEngine` are
 * consumed as they are; nothing here changes their formulas, and no view needs its own copy of this
 * logic.
 */
import type { Activity, ActivityLink, BaselineActivity, CalendarType, ProgressUpdate } from '@/types';
import type { EarnedScheduleResult } from '@/lib/earnedScheduleEngine';
import { analyzeScheduleControl } from '@/lib/scheduleControlEngine';

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
  /** P2A1-NEW-GAP-04: the Earned Schedule run measured nothing (no project / no activities), so
   *  there is no trend forecast — not a zero index, an absence of evidence. */
  | 'es_unmeasured'
  | 'spi_t_zero'; // SPI(t) = 0: IEAC(t) = PD / SPI(t) is unbounded (Wave 5 reports a PD floor)

/**
 * P2A1-NEW-GAP-03: which basis produced the deterministic finish, so a consumer can never present
 * a frozen stored date as the statused forecast (or vice versa).
 *
 * - `f5_statused_cpm`     — the governed statused CPM forecast finish. AUTHORITATIVE.
 * - `stored_early_finish` — the stored `activities.early_finish` column: a persisted snapshot of an
 *                           earlier CPM run. Quoted only when no statused forecast could be
 *                           resolved; it is NOT the current project forecast.
 * - `unavailable`         — neither basis produced a date.
 */
export type DeterministicFinishSource = 'f5_statused_cpm' | 'stored_early_finish' | 'unavailable';

export interface FinishForecastReconciliation {
  /**
   * Method 1: the authoritative deterministic project forecast finish — the F5 statused CPM
   * forecast finish when available, otherwise the latest stored `early_finish` (see
   * `deterministicFinishSource`, which always says which one this is).
   */
  cpmEarlyFinish: string | null;
  /** P2A1-NEW-GAP-03: the basis `cpmEarlyFinish` was read from. */
  deterministicFinishSource: DeterministicFinishSource;
  /** How many activities carried an `early_finish` (0 means the stored-date basis is unavailable). */
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
 * The STORED deterministic CPM finish of a project: the latest `early_finish` in its activity
 * network. ISO `YYYY-MM-DD` strings compare correctly as strings, so no date parsing is involved.
 * `actual_finish` is deliberately NOT used: this is the CPM early finish of the stored plan, not an
 * actuals roll-up.
 *
 * P2A1-NEW-GAP-03: this is a quote of a PERSISTED column, which is a snapshot of an earlier CPM run
 * and does not move when the schedule is statused. It is therefore NOT the current project forecast.
 * Screens that report the deterministic finish must pass the F5 statused forecast finish to
 * `reconcileFinishForecasts` (or derive it with `resolveDeterministicForecastFinish`); this function
 * remains only as the stored-plan reading, and `deterministicFinishSource` names it wherever it is
 * still returned.
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
 * P2A1-NEW-GAP-03: the authoritative deterministic project forecast finish.
 *
 * The statused F5 CPM is the canonical schedule-control engine, so its `project.forecastFinish` is
 * the deterministic finish every screen must report. This helper exists so a surface that does not
 * already hold an F5 report derives one instead of falling back to frozen activity dates — and so
 * all of them derive it the same way (there is exactly one call to `analyzeScheduleControl` here).
 */
export interface DeterministicFinishSources {
  activities: Activity[];
  links: ActivityLink[];
  baselines?: BaselineActivity[];
  progressUpdates?: ProgressUpdate[];
  /** Governed Data Date. */
  dataDate: string;
  calendarType?: CalendarType;
  statusLogic?: 'retained_logic' | 'progress_override';
}

export function resolveDeterministicForecastFinish(sources: DeterministicFinishSources): string | null {
  const report = analyzeScheduleControl({
    activities: sources.activities,
    links: sources.links,
    baselines: sources.baselines || [],
    progressUpdates: sources.progressUpdates || [],
    previousSnapshot: null,
    dataDate: sources.dataDate,
    calendarType: sources.calendarType || '6_days',
    statusLogic: sources.statusLogic || 'retained_logic',
  });
  return report.project.forecastFinish;
}

/**
 * Read both finish methods and report them side by side with their delta (GAP-041).
 *
 * `esComputable` mirrors the Earned Schedule engine's own documented condition for a computable
 * IEAC(t) (`SPI(t) > 0` and `PD > 0`); when it is false the engine returns its PD floor and the
 * planned completion date, which must NOT be presented as a trend forecast, so `esTrendFinish` is
 * null and `esAvailability` explains why.
 *
 * P2A1-NEW-GAP-03: `statusedForecastFinish` is the F5 statused CPM forecast finish. When supplied
 * it IS the deterministic finish — the stored `early_finish` column is a persisted snapshot that a
 * statused schedule has already moved past, and quoting it would show ProgressView / the Executive
 * Report a different project finish from F5, Dashboard and ScheduleView. Without it the stored-date
 * quote is still returned, but `deterministicFinishSource` names it as such.
 */
export function reconcileFinishForecasts(
  activities: Activity[],
  earnedSchedule: EarnedScheduleResult | null | undefined,
  statusedForecastFinish?: string | null,
): FinishForecastReconciliation {
  const storedFinish = calculateCpmDeterministicEarlyFinish(activities);
  const statusedFinish =
    typeof statusedForecastFinish === 'string' && statusedForecastFinish !== ''
      ? statusedForecastFinish
      : null;
  const cpmEarlyFinish = statusedFinish ?? storedFinish;
  const deterministicFinishSource: DeterministicFinishSource =
    statusedFinish !== null ? 'f5_statused_cpm' : storedFinish !== null ? 'stored_early_finish' : 'unavailable';
  const cpmActivityCount = (Array.isArray(activities) ? activities : []).filter(
    (activity) => typeof activity?.early_finish === 'string' && activity.early_finish !== '',
  ).length;

  let esAvailability: EsForecastAvailability = 'computable';
  if (!earnedSchedule) esAvailability = 'no_earned_schedule';
  // P2A1-NEW-GAP-04: an unmeasured Earned Schedule (no project / no activities) has no trend
  // forecast at all. It is not "SPI(t) = 0" — that label describes a measured zero index — and it
  // must be named as the no-data state it is so a screen can say so instead of implying a forecast.
  else if (earnedSchedule.measured === false || earnedSchedule.schedulePerformanceIndexTime === null) {
    esAvailability = 'es_unmeasured';
  }
  else if (!(earnedSchedule.plannedDurationDays > 0)) esAvailability = 'no_planned_duration';
  else if (!(earnedSchedule.schedulePerformanceIndexTime > 0)) esAvailability = 'spi_t_zero';

  const esComputable = esAvailability === 'computable';
  const esTrendFinish = esComputable && earnedSchedule ? earnedSchedule.forecastCompletionDate : null;
  // `forecastCompletionDate` is null whenever the run measured nothing, so both guards agree.

  const bothAvailable = cpmEarlyFinish !== null && esTrendFinish !== null;
  const deltaDays = bothAvailable ? daysBetweenIso(cpmEarlyFinish as string, esTrendFinish as string) : null;

  return {
    cpmEarlyFinish,
    deterministicFinishSource,
    cpmActivityCount,
    esTrendFinish,
    esAvailability,
    esComputable,
    deltaDays: deltaDays !== null && Number.isFinite(deltaDays) ? deltaDays : null,
    bothAvailable,
    labels: FINISH_METHOD_LABELS,
  };
}

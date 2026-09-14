/**
 * Chronology guard — the single place where "is this record allowed to count as an actual?" is
 * answered (GAP-010).
 *
 * AGENTS.md §7.2 states the invariant: no actual / progress / cost / certification / payment /
 * receipt record may be dated after the Data Date. A record dated in the future is not illegal by
 * itself — a planned delivery, a draft certificate or a forecast index reading is legitimate — but
 * it may never be summed into an *actual* total, and it may never be displayed as something that
 * already happened.
 *
 * This module is deliberately tiny and pure: it resolves the governed Data Date exactly the way the
 * canonical EVM engine does (`override` -> `project.data_date` -> `DEFAULT_DATA_DATE`) and classifies
 * dates against it. It contains no second Data Date literal and no calculation of its own, so views
 * cannot drift from the engines (AGENTS.md §7.6).
 */

import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';

/** Anything that carries the governed status date column. */
export interface DataDateBearer {
  data_date?: string | null;
}

/**
 * Resolve the Data Date a screen must use.
 *
 * Resolution order matches `calculateProjectEvmAtDataDate` in `src/lib/planningEngine.ts`
 * (`overrideDataDate || project.data_date || DEFAULT_DATA_DATE`), so every consumer of this helper
 * agrees with the canonical EVM / Earned Schedule results for the same project.
 */
export function resolveDataDate(project: DataDateBearer | null | undefined, override?: string | null): string {
  return override || project?.data_date || DEFAULT_DATA_DATE;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when the value is a usable `YYYY-MM-DD` calendar date. */
export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DATE.test(value);
}

function toUtcMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

/**
 * Signed calendar-day distance `to - from` (negative when `to` precedes `from`).
 * Returns null when either side is not a valid ISO date, so a caller can render N/A instead of
 * inventing a number.
 */
export function calendarDaysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  const delta = toUtcMs(to) - toUtcMs(from);
  if (!Number.isFinite(delta)) return null;
  return Math.round(delta / 86400000);
}

/** True when `date` is on or before the Data Date — i.e. it may describe something that happened. */
export function isOnOrBeforeDataDate(date: string | null | undefined, dataDate: string): boolean {
  if (!isIsoDate(date) || !isIsoDate(dataDate)) return false;
  return toUtcMs(date) <= toUtcMs(dataDate);
}

/** True when `date` is strictly after the Data Date — i.e. it can only be a plan or a forecast. */
export function isAfterDataDate(date: string | null | undefined, dataDate: string): boolean {
  if (!isIsoDate(date) || !isIsoDate(dataDate)) return false;
  return toUtcMs(date) > toUtcMs(dataDate);
}

/**
 * Chronological class of a record.
 *
 * - `actual`        — dated on or before the Data Date: may enter actual / cumulative totals.
 * - `future_planned`— dated after the Data Date: must be reported as planned / forecast / draft and
 *                     must stay out of every actual total.
 * - `undated`       — no usable date: never an actual, because nothing places it in time.
 */
export type ChronologyClass = 'actual' | 'future_planned' | 'undated';

export function classifyByDate(date: string | null | undefined, dataDate: string): ChronologyClass {
  if (!isIsoDate(date)) return 'undated';
  return isOnOrBeforeDataDate(date, dataDate) ? 'actual' : 'future_planned';
}

/**
 * Split a list into what already happened and what is still forward-looking.
 *
 * `getDate` picks the date that makes the record an actual (delivery date, certificate date,
 * transaction date, invoice date, index reading date …). The split is stable: `actual` keeps the
 * input order, `futurePlanned` likewise, and `undated` is reported separately so a missing date can
 * never be silently treated as either.
 */
export function splitByChronology<T>(
  items: readonly T[],
  getDate: (item: T) => string | null | undefined,
  dataDate: string,
): { actual: T[]; futurePlanned: T[]; undated: T[] } {
  const actual: T[] = [];
  const futurePlanned: T[] = [];
  const undated: T[] = [];
  items.forEach((item) => {
    const klass = classifyByDate(getDate(item), dataDate);
    if (klass === 'actual') actual.push(item);
    else if (klass === 'future_planned') futurePlanned.push(item);
    else undated.push(item);
  });
  return { actual, futurePlanned, undated };
}

/** Sum a numeric field, tolerating null / undefined / non-finite values (they contribute nothing). */
export function sumNumeric<T>(items: readonly T[], getNumber: (item: T) => number | null | undefined): number {
  return items.reduce((total, item) => {
    const value = getNumber(item);
    return typeof value === 'number' && Number.isFinite(value) ? total + value : total;
  }, 0);
}

/**
 * Latest date among a set of records, or null when none carries a usable date.
 * Used to show the evidence horizon of a total (e.g. "actuals up to 2026-09-12").
 */
export function latestDate<T>(items: readonly T[], getDate: (item: T) => string | null | undefined): string | null {
  let best: string | null = null;
  items.forEach((item) => {
    const date = getDate(item);
    if (!isIsoDate(date)) return;
    if (best === null || toUtcMs(date) > toUtcMs(best)) best = date;
  });
  return best;
}

/** Earliest date among a set of records, or null when none carries a usable date. */
export function earliestDate<T>(items: readonly T[], getDate: (item: T) => string | null | undefined): string | null {
  let best: string | null = null;
  items.forEach((item) => {
    const date = getDate(item);
    if (!isIsoDate(date)) return;
    if (best === null || toUtcMs(date) < toUtcMs(best)) best = date;
  });
  return best;
}

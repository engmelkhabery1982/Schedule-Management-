import type { CalendarType, P6Calendar, ProjectCalendar } from '@/types';

// Standard Calendars
// 0 = Sunday, 1 = Monday, 2 = Tuesday, 3 = Wednesday, 4 = Thursday, 5 = Friday, 6 = Saturday
export const DEFAULT_CALENDARS: Record<CalendarType, ProjectCalendar> = {
  // 6 Days / Week: Sunday through Thursday + Saturday (Friday is weekend) - Standard Gulf & Middle East Construction
  '6_days': {
    type: '6_days',
    workDays: [0, 1, 2, 3, 4, 6], // Friday (5) off
    holidays: [],
    hoursPerDay: 8,
  },
  // 5 Days / Week: Sunday through Thursday (Friday & Saturday off)
  '5_days': {
    type: '5_days',
    workDays: [0, 1, 2, 3, 4], // Friday (5) & Saturday (6) off
    holidays: [],
    hoursPerDay: 8,
  },
  // 7 Days / Week: Continuous operations
  '7_days': {
    type: '7_days',
    workDays: [0, 1, 2, 3, 4, 5, 6],
    holidays: [],
    hoursPerDay: 8,
  },
};

export function getCalendar(type?: CalendarType, customHolidays: string[] = []): ProjectCalendar {
  const base = DEFAULT_CALENDARS[type || '6_days'] || DEFAULT_CALENDARS['6_days'];
  return {
    ...base,
    holidays: [...base.holidays, ...customHolidays],
  };
}

export function isWorkingDay(date: Date | string, calendar: ProjectCalendar): boolean {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : new Date(date);
  const dayOfWeek = d.getUTCDay();
  const dateStr = d.toISOString().split('T')[0];

  if (!calendar.workDays.includes(dayOfWeek)) {
    return false;
  }
  if (calendar.holidays.includes(dateStr)) {
    return false;
  }
  return true;
}

export function getNextWorkingDay(date: Date | string, calendar: ProjectCalendar): string {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : new Date(date);
  while (!isWorkingDay(d, calendar)) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().split('T')[0];
}

export function getPreviousWorkingDay(date: Date | string, calendar: ProjectCalendar): string {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : new Date(date);
  while (!isWorkingDay(d, calendar)) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().split('T')[0];
}

/**
 * Add working days to a start date.
 * If duration = 0 (milestone), returns startDate.
 * In construction planning:
 * If activity starts on Monday with duration 1 day -> finishes on Monday.
 * If activity starts on Monday with duration 2 days -> finishes on Tuesday.
 * Formula: for duration > 1, add (duration - 1) working days.
 */
export function addWorkingDays(startDateStr: string, durationDays: number, calendar: ProjectCalendar): string {
  if (durationDays <= 0) {
    return startDateStr;
  }

  let current = new Date(`${startDateStr}T00:00:00Z`);
  // Ensure start date is on a working day
  if (!isWorkingDay(current, calendar)) {
    const nextWk = getNextWorkingDay(current, calendar);
    current = new Date(`${nextWk}T00:00:00Z`);
  }

  let added = 1;
  while (added < durationDays) {
    current.setUTCDate(current.getUTCDate() + 1);
    if (isWorkingDay(current, calendar)) {
      added++;
    }
  }

  return current.toISOString().split('T')[0];
}

/**
 * Subtract working days from an end date to find start date.
 */
export function subtractWorkingDays(endDateStr: string, durationDays: number, calendar: ProjectCalendar): string {
  if (durationDays <= 0) {
    return endDateStr;
  }

  let current = new Date(`${endDateStr}T00:00:00Z`);
  // Ensure end date is on a working day
  if (!isWorkingDay(current, calendar)) {
    const prevWk = getPreviousWorkingDay(current, calendar);
    current = new Date(`${prevWk}T00:00:00Z`);
  }

  let subtracted = 1;
  while (subtracted < durationDays) {
    current.setUTCDate(current.getUTCDate() - 1);
    if (isWorkingDay(current, calendar)) {
      subtracted++;
    }
  }

  return current.toISOString().split('T')[0];
}

/**
 * Calculate working days between two dates inclusive.
 */
export function countWorkingDays(startDateStr: string, endDateStr: string, calendar: ProjectCalendar): number {
  const start = new Date(`${startDateStr}T00:00:00Z`);
  const end = new Date(`${endDateStr}T00:00:00Z`);

  if (start > end) {
    return -countWorkingDays(endDateStr, startDateStr, calendar);
  }

  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    if (isWorkingDay(current, calendar)) {
      count++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}

/**
 * Shift a date by a SIGNED number of working days, preserving the sign of the offset (GAP-012).
 *
 *   offsetWorkingDays(d,  0) -> d unchanged (no snapping: the caller owns calendar alignment)
 *   offsetWorkingDays(d, +n) -> the nth working day AFTER d
 *   offsetWorkingDays(d, -n) -> the nth working day BEFORE d
 *
 * This is a thin signed wrapper around the two inclusive primitives above — NOT a second
 * calendar implementation. Because `addWorkingDays` / `subtractWorkingDays` count the anchor day
 * as day 1, a shift of n working days is expressed as n + 1.
 *
 * Relationship lags must always travel through this helper so a lead (negative lag) can never be
 * clipped by a `Math.max(...)` guard: a positive lag pushes a successor later / pulls a
 * predecessor earlier, and a negative lag does exactly the mirror image.
 *
 * A non-finite or zero offset resolves to the anchor date unchanged, so a malformed lag can
 * neither fabricate a shift nor leak NaN into a date.
 */
export function offsetWorkingDays(dateStr: string, offsetDays: number, calendar: ProjectCalendar): string {
  if (!Number.isFinite(offsetDays) || offsetDays === 0) {
    return dateStr;
  }
  if (offsetDays > 0) {
    return addWorkingDays(dateStr, offsetDays + 1, calendar);
  }
  return subtractWorkingDays(dateStr, Math.abs(offsetDays) + 1, calendar);
}

/**
 * Calculate the successor early start based on predecessor early finish for an FS link.
 * For FS with Lag = 0: Next working day after predecessor early finish.
 *
 * Event pairs and lag convention per relationship type (GAP-012 / GAP-013). `lag` is a SIGNED
 * number of WORKING days and its sign is always preserved — a negative lag is a lead:
 *
 *   FS  predecessor FINISH -> successor START   ES_succ = (EF_pred + 1 working day) + lag
 *   SS  predecessor START  -> successor START   ES_succ = ES_pred + lag
 *   FF  predecessor FINISH -> successor FINISH  EF_succ = EF_pred + lag
 *   SF  predecessor START  -> successor FINISH  EF_succ = ES_pred + lag
 *
 * For FF and SF the function returns the successor START implied by that finish, using the
 * engine's inclusive duration convention (an activity of n working days occupies exactly n
 * working days, counting its start day as day 1, so start = finish - (n - 1) working days).
 * A zero-duration successor (milestone) starts on its finish day.
 *
 * F1.1: `lagDays` may be FRACTIONAL (an exact hour-derived value such as +0.5d for +4h on
 * an 8h/day calendar). The fractional part is placed by `forwardLagShift` — the working day
 * containing the lag-shifted instant — never by naive Math.round. Whole-day lags round to
 * themselves, so every legacy caller is byte-identical.
 */
export function calculateLinkDate(
  predStart: string,
  predFinish: string,
  succDuration: number,
  linkType: 'FS' | 'SS' | 'FF' | 'SF',
  lagDays: number,
  calendar: ProjectCalendar,
  succCalendar: ProjectCalendar | null = null,
): string {
  // F1.1: fractional (hour-derived) lags place by forwardLagShift — the working day
  // containing the lag-shifted instant; whole-day lags shift identically to before.
  const shift = forwardLagShift(lagDays, linkType);
  // F1.1: when the successor runs on its own calendar, its placement honours it: the
  // FF/SF finish-to-start conversion spans the successor's working days (the lag shift
  // itself stays on the predecessor `calendar` = the P6 lag basis), and every branch's
  // result snaps forward onto the successor calendar. Null keeps legacy behaviour
  // verbatim; same-calendar links are unaffected (conversion and snap are identities).
  const convCal = succCalendar || calendar;
  let placed: string;
  switch (linkType) {
    case 'SS': {
      // Start-to-Start: Successor Start = Predecessor Start + Lag.
      // Zero lag keeps the accepted behaviour of snapping a predecessor start that falls on a
      // non-working day onto the calendar; any non-zero lag shifts by exactly `lag` working days.
      placed = shift === 0 ? getNextWorkingDay(predStart, calendar) : offsetWorkingDays(predStart, shift, calendar);
      break;
    }
    case 'FF': {
      // Finish-to-Finish: Successor Finish = Predecessor Finish + Lag
      const targetFinish = offsetWorkingDays(predFinish, shift, calendar);
      // Successor Start = targetFinish - (duration - 1) working days
      placed = subtractWorkingDays(targetFinish, Math.max(1, succDuration), convCal);
      break;
    }
    case 'SF': {
      // Start-to-Finish: Successor Finish = Predecessor Start + Lag
      const targetFinish = offsetWorkingDays(predStart, shift, calendar);
      placed = subtractWorkingDays(targetFinish, Math.max(1, succDuration), convCal);
      break;
    }
    case 'FS':
    default: {
      // Finish-to-Start: Successor Start = (Predecessor Finish + 1 working day) + Lag.
      // A negative lag (lead) pulls the successor start back from that zero-lag date, so it may
      // legitimately fall before the predecessor finish. The engine's data-date floor still
      // applies downstream, which is the only clamp a lead is subject to.
      const nextDay = new Date(`${predFinish}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const firstValidDay = getNextWorkingDay(nextDay, calendar);
      placed = offsetWorkingDays(firstValidDay, shift, calendar);
      break;
    }
  }
  return succCalendar ? getNextWorkingDay(placed, succCalendar) : placed;
}

// ============================================================================
// F1.1 · Imported-calendar execution + hour-faithful lag placement.
//
// This section is the single source of truth for (a) resolving which working
// calendar governs an activity and (b) placing fractional (hour-derived) lags.
// cpmEngine consumes these helpers; it MUST NOT reimplement them.
// ============================================================================

/**
 * Tolerance for float noise around whole-day lags (e.g. database NUMERIC rounding of
 * an exact fraction). Lags within EPS of an integer behave as that integer; anything
 * coarser than ~0.1 working seconds keeps its fractional placement.
 */
const LAG_ROUND_EPS = 1e-6;

function floorLag(value: number): number {
  return Math.floor(value + LAG_ROUND_EPS);
}

function ceilLag(value: number): number {
  return Math.ceil(value - LAG_ROUND_EPS);
}

/**
 * The fractional working-day lag the engine executes for a link.
 *
 * Precedence is fixed and documented: the import-authoritative exact value wins when it
 * is a finite number; otherwise the legacy whole-day column is used verbatim. Writers
 * that change a relationship's meaning (import, DCMA auto-fix) must therefore keep the
 * two columns coherent — the engine never guesses which one is stale.
 */
export function effectiveLinkLagDays(link: { lag_days_exact?: number | null; lag_days?: number | null }): number {
  const exact = link.lag_days_exact === null || link.lag_days_exact === undefined ? NaN : Number(link.lag_days_exact);
  if (Number.isFinite(exact)) return exact;
  return Number(link.lag_days || 0);
}

/**
 * Forward-pass day shift for a (possibly fractional) lag.
 *
 * Day-granular placement rule: the result is the working day CONTAINING the lag-shifted
 * instant. A start-anchored shift (FS gap day, SS/SF predecessor start) begins at hour 0
 * of its day, so a positive fraction stays inside the day while a negative fraction
 * spills into an earlier day — floor. A finish-anchored shift (FF predecessor finish)
 * begins at the last hour of its day, so a positive fraction spills into a later day
 * while a negative fraction stays inside — ceil. Unknown link types follow the FS rule,
 * matching the `default` branch of `calculateLinkDate`.
 */
export function forwardLagShift(fracLagDays: number, linkType: string): number {
  if (!Number.isFinite(fracLagDays)) return 0;
  if (linkType === 'FF') return ceilLag(fracLagDays);
  return floorLag(fracLagDays);
}

/**
 * Backward-pass day shift for a (possibly fractional) lag: the exact inverse of the
 * forward rule, so forward(backward(x)) never drifts by a day. For whole-day lags this
 * reduces to the long-standing convention (FS: -lag - 1 for the mandatory gap day,
 * SS/SF/FF: -lag); for fractions it negates the rounded forward shift instead of
 * rounding the negation, which would invert the anchor physics.
 */
export function backwardLagShift(fracLagDays: number, linkType: string): number {
  if (!Number.isFinite(fracLagDays)) return linkType === 'FS' ? -1 : 0;
  if (linkType === 'FF') return -ceilLag(fracLagDays);
  if (linkType === 'FS') return -floorLag(fracLagDays) - 1;
  return -floorLag(fracLagDays);
}

// ---------------------------------------------------------------------------
// P6 calendar -> execution calendar
// ---------------------------------------------------------------------------

export type ExecutionCalendarSource =
  | 'activity_calendar' // full P6 calendar: work pattern (+ usable exceptions) drives CPM
  | 'activity_calendar_partial' // work pattern drives CPM; exceptions were unsupported and stay out
  | 'project_fallback' // activity names a calendar that is missing/unusable -> project calendar
  | 'legacy'; // no calendar assignment: pre-F1.1 behaviour (activity calendar_type, else project)

export interface ResolvedExecutionCalendar {
  calendar: ProjectCalendar;
  source: ExecutionCalendarSource;
  /** P6 calendar name when one was assigned (even when it fell back), else null. */
  calendarName: string | null;
}

/**
 * Validate an F1 `workweek_json` blob ({ day_hours: { "1": 8, ... } }, P6 DaysOfWeek
 * 1..7 Sunday-first) into JS weekdays (0 = Sunday .. 6 = Saturday). Returns null when the
 * pattern is absent, malformed, or degenerate (zero working days — executing on it would
 * loop forever in the working-day scanners, so the caller must fall back instead).
 */
export function p6WorkweekWorkDays(workweekJson: unknown): number[] | null {
  if (!workweekJson || typeof workweekJson !== 'object' || Array.isArray(workweekJson)) return null;
  const dayHours = (workweekJson as Record<string, unknown>)['day_hours'];
  if (!dayHours || typeof dayHours !== 'object' || Array.isArray(dayHours)) return null;
  const workDays: number[] = [];
  for (let p6Day = 1; p6Day <= 7; p6Day += 1) {
    const hours = (dayHours as Record<string, unknown>)[String(p6Day)];
    if (typeof hours === 'number' && Number.isFinite(hours) && hours > 0) {
      workDays.push(p6Day - 1);
    }
  }
  return workDays.length > 0 ? workDays : null;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const roundTrip = new Date(Date.UTC(y, m - 1, d)).toISOString().split('T')[0];
  return roundTrip === value;
}

/**
 * Validate an F1 `exceptions_json` blob into non-working ISO dates. Entries that are not
 * real calendar dates are dropped — corrupt data can neither crash the scan nor be
 * assumed into the schedule.
 */
export function p6ExceptionHolidays(exceptionsJson: unknown): string[] {
  if (!Array.isArray(exceptionsJson)) return [];
  return [...new Set(exceptionsJson.filter(isIsoDate))].sort();
}

function displayTypeForWorkDays(workDays: number[]): CalendarType {
  // Display hint only: every date primitive below reads `workDays`, never `type`.
  if (workDays.length === 5) return '5_days';
  if (workDays.length === 6) return '6_days';
  return '7_days';
}

/**
 * Convert a stored P6 calendar row into an execution calendar. `workweekUsable` is false
 * when no working pattern can be validated — the caller must fall back to the project
 * calendar and report it. Exceptions are honoured only when the stored pattern status
 * allows them; 'exceptions_unsupported' rows keep their (dropped-at-import) exceptions
 * out of the calculation, and pre-F1.1 rows with a NULL status trust the stored JSON.
 */
export function executionCalendarFromP6(p6: P6Calendar): { calendar: ProjectCalendar; workweekUsable: boolean; exceptionsUsable: boolean } {
  const workDays = p6WorkweekWorkDays(p6.workweek_json);
  const status = p6.pattern_status || (p6.workweek_json ? 'parsed' : 'no_data');
  const exceptionsUsable = status !== 'exceptions_unsupported';
  if (!workDays) {
    return {
      calendar: { type: '6_days', workDays: [], holidays: [], hoursPerDay: 8 },
      workweekUsable: false,
      exceptionsUsable,
    };
  }
  const dayHours = (p6.workweek_json as Record<string, unknown>)['day_hours'] as Record<string, unknown>;
  const maxDayHours = Object.values(dayHours).reduce<number>(
    (max, h) => (typeof h === 'number' && Number.isFinite(h) && h > max ? h : max),
    0,
  );
  const hoursPerDay = p6.hours_per_day !== null && p6.hours_per_day !== undefined
    && Number.isFinite(Number(p6.hours_per_day)) && Number(p6.hours_per_day) > 0
    ? Number(p6.hours_per_day)
    : maxDayHours > 0 ? maxDayHours : 8;
  return {
    calendar: {
      type: displayTypeForWorkDays(workDays),
      workDays,
      holidays: exceptionsUsable ? p6ExceptionHolidays(p6.exceptions_json) : [],
      hoursPerDay,
    },
    workweekUsable: true,
    exceptionsUsable,
  };
}

/**
 * Resolve the execution calendar for one activity.
 *
 *   - Assigned + usable P6 calendar  -> its work pattern (+ exceptions) drives CPM.
 *   - Assigned + work-pattern-only   -> pattern drives CPM, exceptions stay out (partial).
 *   - Assigned + missing/unusable    -> project-calendar fallback (reported, never silent).
 *   - Not assigned                   -> byte-identical legacy path (calendar_type, else project).
 *
 * The P6 branch is self-contained: a P6 calendar carries its own exceptions, so the
 * shared project `customHolidays` are NOT merged into it (merging them would silently
 * rewrite imported P6 semantics). The legacy branch keeps the historical merge verbatim.
 */
export function resolveActivityExecutionCalendar(
  activity: { calendar_id?: string | null; calendar_type?: CalendarType },
  calendarsById: ReadonlyMap<string, P6Calendar>,
  defaultCalendar: ProjectCalendar,
  customHolidays: string[],
): ResolvedExecutionCalendar {
  const assignedId = activity.calendar_id || null;
  if (assignedId) {
    const p6 = calendarsById.get(assignedId);
    if (p6) {
      const { calendar, workweekUsable, exceptionsUsable } = executionCalendarFromP6(p6);
      if (workweekUsable) {
        return {
          calendar,
          source: exceptionsUsable ? 'activity_calendar' : 'activity_calendar_partial',
          calendarName: p6.name,
        };
      }
      return {
        calendar: activity.calendar_type
          ? getCalendar(activity.calendar_type, customHolidays)
          : defaultCalendar,
        source: 'project_fallback',
        calendarName: p6.name,
      };
    }
    return {
      calendar: activity.calendar_type
        ? getCalendar(activity.calendar_type, customHolidays)
        : defaultCalendar,
      source: 'project_fallback',
      calendarName: null,
    };
  }
  if (activity.calendar_type) {
    return { calendar: getCalendar(activity.calendar_type, customHolidays), source: 'legacy', calendarName: null };
  }
  return { calendar: defaultCalendar, source: 'legacy', calendarName: null };
}

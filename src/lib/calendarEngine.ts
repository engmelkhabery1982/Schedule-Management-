import type { CalendarType, ProjectCalendar } from '@/types';

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
 * Calculate the successor early start based on predecessor early finish for an FS link.
 * For FS with Lag = 0: Next working day after predecessor early finish.
 */
export function calculateLinkDate(
  predStart: string,
  predFinish: string,
  succDuration: number,
  linkType: 'FS' | 'SS' | 'FF' | 'SF',
  lagDays: number,
  calendar: ProjectCalendar,
): string {
  switch (linkType) {
    case 'SS': {
      // Start-to-Start: Successor Start = Predecessor Start + Lag
      if (lagDays === 0) return getNextWorkingDay(predStart, calendar);
      if (lagDays > 0) return addWorkingDays(predStart, lagDays + 1, calendar);
      return subtractWorkingDays(predStart, Math.abs(lagDays) + 1, calendar);
    }
    case 'FF': {
      // Finish-to-Finish: Successor Finish = Predecessor Finish + Lag
      let targetFinish = predFinish;
      if (lagDays > 0) targetFinish = addWorkingDays(predFinish, lagDays + 1, calendar);
      else if (lagDays < 0) targetFinish = subtractWorkingDays(predFinish, Math.abs(lagDays) + 1, calendar);
      // Successor Start = targetFinish - succDuration
      return subtractWorkingDays(targetFinish, Math.max(1, succDuration), calendar);
    }
    case 'SF': {
      // Start-to-Finish: Successor Finish = Predecessor Start + Lag
      let targetFinish = predStart;
      if (lagDays > 0) targetFinish = addWorkingDays(predStart, lagDays + 1, calendar);
      else if (lagDays < 0) targetFinish = subtractWorkingDays(predStart, Math.abs(lagDays) + 1, calendar);
      return subtractWorkingDays(targetFinish, Math.max(1, succDuration), calendar);
    }
    case 'FS':
    default: {
      // Finish-to-Start: Successor Start = (Predecessor Finish + 1 working day) + Lag
      const nextDay = new Date(`${predFinish}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const firstValidDay = getNextWorkingDay(nextDay, calendar);
      if (lagDays <= 0) return firstValidDay;
      return addWorkingDays(firstValidDay, lagDays + 1, calendar);
    }
  }
}

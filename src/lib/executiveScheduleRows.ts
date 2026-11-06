import { analyzeScheduleControl, type ScheduleControlInput } from './scheduleControlEngine';

/** Presentation projection only: every current row quotes the same F5 run as its project finish. */
export function executiveScheduleRows(input: ScheduleControlInput) {
  const report = analyzeScheduleControl(input);
  const current = new Map(report.statused.map(row => [row.id, row]));
  const rows = input.activities.map(activity => {
    const row = current.get(activity.id);
    return {
      ...activity,
      // F5's current-start/current-finish semantics: a started activity keeps its actual start.
      // The remaining-work CPM start can lie later and is not the start of the whole activity.
      early_start: row?.actualStart || row?.earlyStart || null,
      early_finish: row?.actualFinish || row?.earlyFinish || null,
      percent_complete: row?.percentComplete ?? 0,
      total_float: row?.totalFloat ?? null,
      is_critical: row?.critical ?? false,
      completed: row?.completed ?? false,
    };
  });
  return { rows, forecastFinish: report.project.forecastFinish };
}

-- =====================================================================================
-- Wave 11 · schema-drift closure (projects): the schedule-control columns the application
-- already reads and writes.
--
-- `src/types/index.ts` declares `Project.data_date`, `Project.status_logic` and
-- `Project.calendar_type`, and the app persists all three against the `projects` table:
--
--   data_date      App.tsx (status-date picker), ScheduleView.handleDataDateChange,
--                  ImportView (imported schedule header)
--   calendar_type  ScheduleView.handleCalendarChange
--   status_logic   ScheduleView.handleStatusLogicChange, ProgressView (out-of-sequence mode)
--
-- No migration ever created these columns, so on a real Postgres/Supabase backend every one of
-- those UPDATE statements failed and the value silently never round-tripped (the demo-mode store in
-- `src/lib/supabase.ts` keeps its own object shape, which is why the drift went unnoticed).
-- This migration adds the columns and their allowed values. It rewrites no history and touches no
-- other table.
--
-- Types / defaults mirror the TypeScript contract:
--
--   data_date      date, NULLABLE — exactly like `data_date?: string | null`. The column
--                                   deliberately has NO SQL default: `resolveDataDate()` in
--                                   `src/lib/chronologyGuard.ts` resolves
--                                   `override || project.data_date || DEFAULT_DATA_DATE`, so the
--                                   governed default stays defined in ONE place
--                                   (`src/lib/projectControlsConstants.ts`). Existing rows are
--                                   backfilled with that governed value once, below.
--   status_logic   text NOT NULL DEFAULT 'retained_logic'  — the app default in ScheduleView and
--                                   in `calculateCpm` (`options.statusLogic || 'retained_logic'`).
--   calendar_type  text NOT NULL DEFAULT '6_days'          — the app default in ScheduleView and
--                                   in `calculateCpm` (`options.calendarType || '6_days'`).
--
-- Both NOT NULL columns carry their DEFAULT in the same ADD COLUMN statement, which is how
-- Postgres backfills pre-existing rows, so no row is left without a value and no row is dropped.
-- =====================================================================================

ALTER TABLE projects ADD COLUMN IF NOT EXISTS data_date date;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status_logic text NOT NULL DEFAULT 'retained_logic';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS calendar_type text NOT NULL DEFAULT '6_days';

-- Allowed values, matching `Project['status_logic']` and `CalendarType` in src/types/index.ts.
-- Idempotent house style: drop-then-add, so re-running this migration is safe.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_logic_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_logic_check
  CHECK (status_logic IN ('retained_logic', 'progress_override'));

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_calendar_type_check;
ALTER TABLE projects ADD CONSTRAINT projects_calendar_type_check
  CHECK (calendar_type IN ('6_days', '5_days', '7_days'));

-- Robustness for a partially migrated database: normalise any NULL left behind by an earlier
-- attempt before the NOT NULL invariant is asserted. Both statements are no-ops on a clean run.
UPDATE projects SET status_logic = 'retained_logic' WHERE status_logic IS NULL;
UPDATE projects SET calendar_type = '6_days' WHERE calendar_type IS NULL;
ALTER TABLE projects ALTER COLUMN status_logic SET NOT NULL;
ALTER TABLE projects ALTER COLUMN calendar_type SET NOT NULL;

-- Backfill: a project with no stored status date is audited at the governed Data Date. The literal
-- below is a one-time copy of `DEFAULT_DATA_DATE` (src/lib/projectControlsConstants.ts) at the time
-- of this migration; it is NOT a second source of truth — runtime resolution stays in
-- `resolveDataDate()`, and a future change of the constant must be made there, not here.
UPDATE projects SET data_date = '2026-09-13' WHERE data_date IS NULL;

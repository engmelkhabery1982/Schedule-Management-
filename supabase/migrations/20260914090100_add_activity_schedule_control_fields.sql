-- =====================================================================================
-- Wave 11 · schema-drift closure (activities): the five schedule-control columns the CPM
-- engine, the schedule views and the DCMA audit already read and write.
--
--   free_float              written by ScheduleView.recalculatePersistedSchedule,
--                           ResourceHistogramView, ScheduleRecoveryView, ImportView
--                           (all from `CpmResult.freeFloat`); rendered by ScheduleView /
--                           the i18n column set ('الهامش الحر (FF)').
--   remaining_duration_days written by ProgressView (progress approval) and carried by the
--                           ScheduleView edit form; read by CPM as the remaining work span.
--   constraint_type         written by ScheduleView.saveEdit and read by `calculateCpm`
--                           (forward/backward constraint application) and by DCMA Point 5.
--   constraint_date         same path as constraint_type.
--   expected_finish_date    read by `calculateCpm` (expected-finish override) and written by
--                           ScheduleView.saveEdit.
--
-- None of these columns existed in any migration, so every persisted value was lost on a real
-- Postgres/Supabase backend. This migration adds them; it rewrites no history.
--
-- Type decisions:
--   * free_float mirrors the existing `total_float numeric(15,2) NOT NULL DEFAULT 0` convention and
--     carries NO lower-bound CHECK on purpose. Negative float is real evidence that the network
--     cannot meet its own dates; clamping it to 0 at the storage layer would hide exactly the
--     condition DCMA Point 7 (negative float) exists to report.
--   * remaining_duration_days stays NULLABLE — a NOT NULL DEFAULT would claim "no remaining work"
--     for every historical row, which is a fabricated status, not a default. Where a value IS
--     recorded it must be a non-negative day count.
--   * constraint_date / expected_finish_date are NULLABLE and are NEVER backfilled: a date the
--     planner did not record must not be invented by a migration.
-- =====================================================================================

ALTER TABLE activities ADD COLUMN IF NOT EXISTS free_float numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS remaining_duration_days int;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS constraint_type text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS constraint_date date;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS expected_finish_date date;

-- Remaining duration: unknown (NULL) is legal, a negative day count is not.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_remaining_duration_check;
ALTER TABLE activities ADD CONSTRAINT activities_remaining_duration_check
  CHECK (remaining_duration_days IS NULL OR remaining_duration_days >= 0);

-- Allowed constraint types, matching `ActivityConstraintType` in src/types/index.ts. A value
-- outside this set is rejected by the database instead of being silently ignored by the CPM engine.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_constraint_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_constraint_type_check
  CHECK (constraint_type IS NULL OR constraint_type IN (
    'ASAP', 'ALAP', 'MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT', 'MS', 'MF'
  ));

-- ---------------------------------------------------------------------------------------
-- Remaining known drift, deliberately NOT closed here (out of Wave 11 scope, reported for the
-- Final Closure Audit): activities.activity_type, activities.calendar_type,
-- activities.calendar_id, activities.percent_complete_type, activities.activity_drag,
-- activities.is_longest_path, activities.physical/duration/units_percent_complete,
-- activities.duration_type, activities.milestone_type, activities.discipline,
-- activities.contractor, activities.suspend_date, activities.resume_date, the denormalised
-- predecessors/successors/resources carriers, and projects.sector. Each is declared optional in
-- `src/types/index.ts`, so nothing in this migration is required by them.
-- ---------------------------------------------------------------------------------------

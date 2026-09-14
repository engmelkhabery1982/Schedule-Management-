-- =====================================================================================
-- Phase F1 · Primavera XER schedule fidelity (additive only, no redesign).
--
-- The XER importer must preserve P6 schedule semantics end to end. Three gaps have no
-- destination in the current schema; each addition below is the minimal column/table that
-- closes one gap, with its XER source field and downstream consumer:
--
--   1. calendars table + activities.calendar_id
--      XER source: CALENDAR (clndr_id, clndr_name, clndr_type, day_hr_cnt, week_hr_cnt,
--        base_clndr_id, clndr_data work pattern + exceptions) and TASK.clndr_id.
--      Why required: a P6 activity's calendar governs its hours-to-days basis and its
--        working pattern; without a destination the assignment is dropped and every
--        duration silently converts on an assumed 8h/day.
--      Downstream consumer: the import reconciliation report (calendar-assignment
--        survival) and the conversion-basis audit trail stored per activity at import.
--        Canonical CPM keeps running on the project calendar_type; per-activity P6
--        calendars are reference data in F1 (documented, not silently applied).
--
--   2. activities.activity_type
--      XER source: TASK.task_type (TT_Task, TT_Rsrc, TT_LOE, TT_Mile, TT_FinMile, TT_WBS).
--      Why required: milestone/LOE/WBS-summary semantics come from the type, not from a
--        zero duration; deriving them from duration_days invents milestones.
--      Downstream consumer: cpmEngine (milestone detection), ScheduleView (type column +
--        edit form, which already writes this column), scheduleQualityEngine. This also
--        closes the pre-existing drift Wave 11 reported for this column.
--
--   3. activity_resources.remaining_quantity
--      XER source: TASKRSRC.remain_qty.
--      Why required: remaining units are neither planned nor actual; folding them into
--        either column would fabricate a quantity.
--      Downstream consumer: the import reconciliation report and the resource-assignment
--        readers (activity_resources consumers) which today see planned/actual only.
--
-- Deliberately NOT added (parsed by the importer, reported as unpersisted, no silent loss):
-- duration_type, percent_complete_type, milestone_type, suspend/resume dates, priority,
-- secondary constraints, float paths, UDFs, activity codes, financial-period summaries.
-- Each has no reader in the application today; adding unread columns would be dead schema.
-- =====================================================================================

-- 1a. P6 calendars referenced by TASK.clndr_id.
CREATE TABLE IF NOT EXISTS calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  p6_clndr_id text NOT NULL,
  name text NOT NULL,
  clndr_type text,
  is_default boolean NOT NULL DEFAULT false,
  hours_per_day numeric(8,2),
  hours_per_week numeric(10,2),
  base_p6_clndr_id text,
  -- Parsed work pattern: {"day_hours": {"1": 0, "2": 8, ...}, "working_days": 5,
  -- "day_index_base": "P6 DaysOfWeek 1..7 (Sunday-first convention)"}. NULL when the
  -- file carries no (parseable) clndr_data; never synthesised.
  workweek_json jsonb,
  -- Non-working exception dates (ISO strings) decoded from clndr_data. NULL when absent
  -- or when the exception block carries working-time overrides the parser cannot model.
  exceptions_json jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, p6_clndr_id)
);

-- 1b. Activity -> P6 calendar assignment.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS calendar_id uuid REFERENCES calendars(id) ON DELETE SET NULL;

-- 2. P6 activity type, constrained to the application's ActivityType contract.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_type text;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_activity_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_activity_type_check
  CHECK (activity_type IS NULL OR activity_type IN (
    'task_dependent', 'resource_dependent', 'level_of_effort',
    'start_milestone', 'finish_milestone', 'wbs_summary'
  ));

-- 3. Remaining assignment units.
ALTER TABLE activity_resources ADD COLUMN IF NOT EXISTS remaining_quantity numeric(15,3);

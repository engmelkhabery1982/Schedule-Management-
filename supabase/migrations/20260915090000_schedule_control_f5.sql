-- F5 (Schedule Updating & Control Intelligence): minimal additive schema.
--
-- 1. `baseline_activities.total_float` (NULLABLE): captures the activity total float at
--    baseline-approval time so float change (current TF - baseline TF) is computable.
--    Legacy rows keep NULL and the control engine reports float change as N/A for them
--    (never a fabricated zero). Written only by the additive F5 extension of
--    `approveBoqBaseline`; no existing baseline logic changes.
--
-- 2. `schedule_update_snapshots`: one deterministic row per (project, data_date) holding the
--    decision numbers of that update (forecast finish, progress, critical/near-critical
--    counts, delays, slipped milestones) plus a versioned `details` JSON blob with the
--    per-activity evidence (forecast finish, TF, critical flag, calendar, link signature)
--    that powers update-to-update comparison (critical-path migration, float erosion,
--    forecast accuracy, logic-change detection). This table is ADDITIVE: EVM-owned
--    `forecast_snapshots` and `recovery_snapshots` are untouched.

ALTER TABLE baseline_activities
  ADD COLUMN IF NOT EXISTS total_float numeric(12,2);

COMMENT ON COLUMN baseline_activities.total_float IS
  'F5: activity total float (working days) at baseline approval; NULL for legacy baselines (float change then reads N/A).';

CREATE TABLE IF NOT EXISTS schedule_update_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_date date NOT NULL,
  forecast_finish date,
  progress_pct numeric(8,3),
  critical_count int NOT NULL DEFAULT 0,
  near_critical_count int NOT NULL DEFAULT 0,
  total_delay_days int,
  delay_vs_previous_days int,
  milestones_slipped int NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, data_date)
);

CREATE INDEX IF NOT EXISTS idx_sched_snapshots_project_date
  ON schedule_update_snapshots(project_id, data_date DESC);

COMMENT ON TABLE schedule_update_snapshots IS
  'F5: deterministic per-update control snapshot. Aggregates are columns; per-activity evidence lives in details (schema version 1, see scheduleControlEngine). Missing inputs persist as NULL, never as defaults.';

ALTER TABLE schedule_update_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_schedule_update_snapshots" ON schedule_update_snapshots;
CREATE POLICY "anon_crud_schedule_update_snapshots" ON schedule_update_snapshots FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

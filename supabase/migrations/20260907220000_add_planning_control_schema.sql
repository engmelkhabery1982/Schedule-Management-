-- Planning and control foundation: immutable baselines, productivity and actual costs.

CREATE TABLE IF NOT EXISTS productivity_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  unit text NOT NULL,
  daily_output numeric(15,3) NOT NULL CHECK (daily_output > 0),
  crew_size numeric(10,2) NOT NULL DEFAULT 1,
  difficulty_factor numeric(10,3) NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  UNIQUE(category, unit)
);

INSERT INTO productivity_rates(category, unit, daily_output, crew_size, difficulty_factor) VALUES
  ('Foundations', 'م3', 25, 6, 1),
  ('Earthworks', 'م3', 120, 5, 1),
  ('Concrete Works', 'م3', 40, 8, 1),
  ('Reinforcement Steel', 'طن', 2.5, 5, 1),
  ('Masonry', 'م2', 35, 6, 1),
  ('Roofing & Insulation', 'م2', 60, 5, 1),
  ('Plastering', 'م2', 80, 5, 1),
  ('Tiling & Flooring', 'م2', 45, 5, 1),
  ('Doors & Windows', 'وحدة', 8, 4, 1),
  ('Electrical', 'نقطة', 12, 5, 1),
  ('Plumbing & Drainage', 'نقطة', 10, 5, 1),
  ('HVAC', 'وحدة', 4, 4, 1),
  ('Painting', 'م2', 100, 5, 1),
  ('General', 'وحدة', 20, 4, 1)
ON CONFLICT (category, unit) DO NOTHING;

CREATE TABLE IF NOT EXISTS project_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version int NOT NULL DEFAULT 1,
  name text NOT NULL DEFAULT 'Initial Baseline',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  approved_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, version)
);

ALTER TABLE project_baselines ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
ALTER TABLE project_baselines ALTER COLUMN approved_at DROP DEFAULT;
ALTER TABLE project_baselines DROP CONSTRAINT IF EXISTS project_baselines_status_check;
ALTER TABLE project_baselines ADD CONSTRAINT project_baselines_status_check CHECK (status IN ('draft', 'submitted', 'approved', 'rejected'));
UPDATE project_baselines SET status = 'approved' WHERE approved_at IS NOT NULL AND status = 'draft';

CREATE TABLE IF NOT EXISTS baseline_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_id uuid NOT NULL REFERENCES project_baselines(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  early_start date NOT NULL,
  early_finish date NOT NULL,
  duration_days int NOT NULL DEFAULT 0,
  planned_cost numeric(15,2) NOT NULL DEFAULT 0,
  UNIQUE(baseline_id, activity_id)
);

CREATE TABLE IF NOT EXISTS cost_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id uuid REFERENCES activities(id) ON DELETE SET NULL,
  boq_item_id uuid REFERENCES boq_items(id) ON DELETE SET NULL,
  category text,
  transaction_date date NOT NULL DEFAULT CURRENT_DATE,
  description text NOT NULL,
  cost_type text NOT NULL DEFAULT 'direct',
  amount numeric(15,2) NOT NULL CHECK (amount >= 0),
  source text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE activities ADD COLUMN IF NOT EXISTS planned_quantity numeric(15,3) NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS actual_quantity numeric(15,3) NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS total_float numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_progress_check;
ALTER TABLE activities ADD CONSTRAINT activities_progress_check CHECK (percent_complete >= 0 AND percent_complete <= 100);
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_duration_check;
ALTER TABLE activities ADD CONSTRAINT activities_duration_check CHECK (duration_days >= 0 AND planned_quantity >= 0 AND actual_quantity >= 0);
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS quantity_to_date numeric(15,3) NOT NULL DEFAULT 0;
ALTER TABLE progress_updates DROP CONSTRAINT IF EXISTS progress_updates_progress_check;
ALTER TABLE progress_updates ADD CONSTRAINT progress_updates_progress_check CHECK (percent_complete >= 0 AND percent_complete <= 100 AND actual_quantity >= 0 AND quantity_to_date >= 0);
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'submitted';
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS rejected_reason text;
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'submitted';
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS rejected_reason text;

ALTER TABLE progress_updates DROP CONSTRAINT IF EXISTS progress_updates_status_check;
ALTER TABLE progress_updates ADD CONSTRAINT progress_updates_status_check CHECK (status IN ('draft', 'submitted', 'approved', 'rejected'));
ALTER TABLE cost_transactions DROP CONSTRAINT IF EXISTS cost_transactions_status_check;
ALTER TABLE cost_transactions ADD CONSTRAINT cost_transactions_status_check CHECK (status IN ('draft', 'submitted', 'approved', 'rejected'));

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  table_name text NOT NULL,
  record_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedule_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_format text NOT NULL,
  source_filename text NOT NULL,
  activity_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('draft', 'applied', 'rejected')),
  created_at timestamptz DEFAULT now(),
  applied_at timestamptz
);

CREATE TABLE IF NOT EXISTS schedule_revision_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES schedule_revisions(id) ON DELETE CASCADE,
  activity_code text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  alert_type text NOT NULL CHECK (alert_type IN ('schedule', 'cost', 'data_quality', 'resource')),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  message text NOT NULL,
  activity_id uuid REFERENCES activities(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  first_seen_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  UNIQUE(project_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  spi numeric(10,4) NOT NULL,
  cpi numeric(10,4) NOT NULL,
  forecast_finish date,
  optimistic_finish date,
  pessimistic_finish date,
  eac_realistic numeric(15,2) NOT NULL DEFAULT 0,
  risk_cost_exposure numeric(15,2) NOT NULL DEFAULT 0,
  risk_days_exposure numeric(10,2) NOT NULL DEFAULT 0,
  confidence numeric(5,2) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  volatility numeric(5,4) NOT NULL DEFAULT 0 CHECK (volatility >= 0),
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, snapshot_date)
);
ALTER TABLE forecast_snapshots ADD COLUMN IF NOT EXISTS risk_cost_exposure numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE forecast_snapshots ADD COLUMN IF NOT EXISTS risk_days_exposure numeric(10,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS recovery_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  required_spi numeric(10,4) NOT NULL DEFAULT 1,
  remaining_quantity numeric(15,3) NOT NULL DEFAULT 0,
  required_daily_quantity numeric(15,3) NOT NULL DEFAULT 0,
  cost_gap numeric(15,2) NOT NULL DEFAULT 0,
  feasibility text NOT NULL CHECK (feasibility IN ('feasible', 'strained', 'unlikely', 'not_required')),
  action text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS scenario_simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_simulations_project_name ON scenario_simulations(project_id, name);

CREATE INDEX IF NOT EXISTS idx_baselines_project ON project_baselines(project_id);
CREATE INDEX IF NOT EXISTS idx_baseline_activities_baseline ON baseline_activities(baseline_id);
CREATE INDEX IF NOT EXISTS idx_cost_transactions_project_date ON cost_transactions(project_id, transaction_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_activity_link
  ON activity_links(predecessor_id, successor_id, link_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_baseline_per_project
  ON project_baselines(project_id) WHERE is_active = true;

ALTER TABLE productivity_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseline_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_revision_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_simulations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_crud_productivity_rates" ON productivity_rates;
CREATE POLICY "anon_crud_productivity_rates" ON productivity_rates FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_crud_project_baselines" ON project_baselines;
CREATE POLICY "anon_crud_project_baselines" ON project_baselines FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_crud_baseline_activities" ON baseline_activities;
CREATE POLICY "anon_crud_baseline_activities" ON baseline_activities FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_crud_cost_transactions" ON cost_transactions;
CREATE POLICY "anon_crud_cost_transactions" ON cost_transactions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_read_audit_logs" ON audit_logs;
CREATE POLICY "anon_read_audit_logs" ON audit_logs FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_crud_schedule_revisions" ON schedule_revisions;
CREATE POLICY "anon_crud_schedule_revisions" ON schedule_revisions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_crud_schedule_revision_items" ON schedule_revision_items;
CREATE POLICY "anon_crud_schedule_revision_items" ON schedule_revision_items FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_crud_project_alerts" ON project_alerts;
CREATE POLICY "anon_crud_project_alerts" ON project_alerts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_read_forecast_snapshots" ON forecast_snapshots;
CREATE POLICY "anon_read_forecast_snapshots" ON forecast_snapshots FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_forecast_snapshots" ON forecast_snapshots;
CREATE POLICY "anon_insert_forecast_snapshots" ON forecast_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_read_recovery_snapshots" ON recovery_snapshots;
CREATE POLICY "anon_read_recovery_snapshots" ON recovery_snapshots FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_recovery_snapshots" ON recovery_snapshots;
CREATE POLICY "anon_insert_recovery_snapshots" ON recovery_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_crud_scenario_simulations" ON scenario_simulations;
CREATE POLICY "anon_crud_scenario_simulations" ON scenario_simulations FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION record_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  row_data jsonb;
  project_uuid uuid;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  project_uuid := NULLIF(row_data->>'project_id', '')::uuid;
  INSERT INTO audit_logs(project_id, table_name, record_id, action, old_data, new_data)
  VALUES (
    project_uuid,
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS audit_progress_updates ON progress_updates;
CREATE TRIGGER audit_progress_updates AFTER INSERT OR UPDATE OR DELETE ON progress_updates FOR EACH ROW EXECUTE FUNCTION record_audit_event();
DROP TRIGGER IF EXISTS audit_cost_transactions ON cost_transactions;
CREATE TRIGGER audit_cost_transactions AFTER INSERT OR UPDATE OR DELETE ON cost_transactions FOR EACH ROW EXECUTE FUNCTION record_audit_event();
DROP TRIGGER IF EXISTS audit_activities ON activities;
CREATE TRIGGER audit_activities AFTER INSERT OR UPDATE OR DELETE ON activities FOR EACH ROW EXECUTE FUNCTION record_audit_event();
DROP TRIGGER IF EXISTS audit_project_alerts ON project_alerts;
CREATE TRIGGER audit_project_alerts AFTER INSERT OR UPDATE OR DELETE ON project_alerts FOR EACH ROW EXECUTE FUNCTION record_audit_event();

CREATE OR REPLACE FUNCTION prevent_approved_baseline_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_TABLE_NAME = 'project_baselines' OR (
      TG_TABLE_NAME = 'baseline_activities'
      AND EXISTS (
        SELECT 1
        FROM project_baselines b
        WHERE b.id = NULLIF(to_jsonb(OLD)->>'baseline_id', '')::uuid
          AND b.status = 'approved'
      )
    ) THEN
      RAISE EXCEPTION 'Approved baseline records are immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS immutable_project_baselines ON project_baselines;
CREATE TRIGGER immutable_project_baselines BEFORE UPDATE OR DELETE ON project_baselines FOR EACH ROW EXECUTE FUNCTION prevent_approved_baseline_change();
DROP TRIGGER IF EXISTS immutable_baseline_activities ON baseline_activities;
CREATE TRIGGER immutable_baseline_activities BEFORE UPDATE OR DELETE ON baseline_activities FOR EACH ROW EXECUTE FUNCTION prevent_approved_baseline_change();

CREATE OR REPLACE FUNCTION prevent_approved_control_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Approved control records are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS immutable_approved_progress ON progress_updates;
CREATE TRIGGER immutable_approved_progress BEFORE UPDATE OR DELETE ON progress_updates FOR EACH ROW EXECUTE FUNCTION prevent_approved_control_record_change();
DROP TRIGGER IF EXISTS immutable_approved_cost ON cost_transactions;
CREATE TRIGGER immutable_approved_cost BEFORE UPDATE OR DELETE ON cost_transactions FOR EACH ROW EXECUTE FUNCTION prevent_approved_control_record_change();

CREATE OR REPLACE FUNCTION validate_alert_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'resolved' AND NEW.status <> 'resolved' THEN
    RAISE EXCEPTION 'Resolved alerts cannot be reopened directly';
  END IF;
  IF NEW.status = 'acknowledged' AND NEW.acknowledged_at IS NULL THEN
    NEW.acknowledged_at := now();
  END IF;
  IF NEW.status = 'resolved' AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS governed_project_alert_transition ON project_alerts;
CREATE TRIGGER governed_project_alert_transition BEFORE UPDATE ON project_alerts FOR EACH ROW EXECUTE FUNCTION validate_alert_transition();

CREATE OR REPLACE FUNCTION validate_project_boundaries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  related_project uuid;
BEGIN
  IF TG_TABLE_NAME = 'activity_links' THEN
    SELECT project_id INTO related_project FROM activities WHERE id = NEW.predecessor_id;
    IF related_project IS NULL OR related_project <> NEW.project_id THEN RAISE EXCEPTION 'Predecessor belongs to another project'; END IF;
    SELECT project_id INTO related_project FROM activities WHERE id = NEW.successor_id;
    IF related_project IS NULL OR related_project <> NEW.project_id THEN RAISE EXCEPTION 'Successor belongs to another project'; END IF;
  ELSIF TG_TABLE_NAME = 'activity_resources' THEN
    SELECT project_id INTO related_project FROM activities WHERE id = NEW.activity_id;
    IF related_project IS NULL OR related_project <> NEW.project_id THEN RAISE EXCEPTION 'Activity assignment crosses project boundary'; END IF;
    SELECT project_id INTO related_project FROM resources WHERE id = NEW.resource_id;
    IF related_project IS NULL OR related_project <> NEW.project_id THEN RAISE EXCEPTION 'Resource assignment crosses project boundary'; END IF;
  ELSIF TG_TABLE_NAME = 'progress_updates' OR TG_TABLE_NAME = 'cost_transactions' THEN
    SELECT project_id INTO related_project FROM activities WHERE id = NEW.activity_id;
    IF NEW.activity_id IS NOT NULL AND (related_project IS NULL OR related_project <> NEW.project_id) THEN RAISE EXCEPTION 'Control record crosses project boundary'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_activity_link_project ON activity_links;
CREATE TRIGGER validate_activity_link_project BEFORE INSERT OR UPDATE ON activity_links FOR EACH ROW EXECUTE FUNCTION validate_project_boundaries();
DROP TRIGGER IF EXISTS validate_activity_resource_project ON activity_resources;
CREATE TRIGGER validate_activity_resource_project BEFORE INSERT OR UPDATE ON activity_resources FOR EACH ROW EXECUTE FUNCTION validate_project_boundaries();
DROP TRIGGER IF EXISTS validate_progress_project ON progress_updates;
CREATE TRIGGER validate_progress_project BEFORE INSERT OR UPDATE ON progress_updates FOR EACH ROW EXECUTE FUNCTION validate_project_boundaries();
DROP TRIGGER IF EXISTS validate_cost_project ON cost_transactions;
CREATE TRIGGER validate_cost_project BEFORE INSERT OR UPDATE ON cost_transactions FOR EACH ROW EXECUTE FUNCTION validate_project_boundaries();

CREATE OR REPLACE FUNCTION approve_progress_update(update_uuid uuid, approver text DEFAULT 'operator')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  update_row progress_updates%ROWTYPE;
  activity_row activities%ROWTYPE;
  approved_quantity numeric;
BEGIN
  SELECT * INTO update_row FROM progress_updates WHERE id = update_uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Progress update not found'; END IF;
  IF update_row.status <> 'submitted' THEN RAISE EXCEPTION 'Only submitted progress updates can be approved'; END IF;
  SELECT * INTO activity_row FROM activities WHERE id = update_row.activity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Activity not found'; END IF;
  approved_quantity := GREATEST(activity_row.actual_quantity, update_row.quantity_to_date);
  UPDATE progress_updates
    SET status = 'approved', approved_at = now(), approved_by = approver
    WHERE id = update_uuid;
  UPDATE activities
    SET actual_quantity = approved_quantity,
        percent_complete = CASE WHEN planned_quantity > 0 THEN LEAST(100, approved_quantity / planned_quantity * 100) ELSE update_row.percent_complete END,
        actual_start = CASE WHEN approved_quantity > 0 THEN COALESCE(actual_start, update_row.update_date) ELSE actual_start END,
        actual_finish = CASE WHEN planned_quantity > 0 AND approved_quantity >= planned_quantity THEN update_row.update_date ELSE actual_finish END
    WHERE id = update_row.activity_id;
END;
$$;

CREATE OR REPLACE FUNCTION approve_cost_transaction(transaction_uuid uuid, approver text DEFAULT 'operator')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE cost_transactions
    SET status = 'approved', approved_at = now(), approved_by = approver
    WHERE id = transaction_uuid AND status = 'submitted';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only submitted cost transactions can be approved'; END IF;
END;
$$;

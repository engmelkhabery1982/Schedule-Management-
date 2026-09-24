-- Launch Batch 3A: scope baseline snapshots and governed VO lifecycle.
-- Reuses project_baselines as the versioned approval header; the current-scope table below is
-- only a pointer to its single authoritative scope revision, not a second baseline data model.

BEGIN;

ALTER TABLE project_baselines
  ADD COLUMN IF NOT EXISTS baseline_kind text NOT NULL DEFAULT 'schedule',
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approval_reference text;

ALTER TABLE project_baselines
  DROP CONSTRAINT IF EXISTS project_baselines_baseline_kind_check,
  ADD CONSTRAINT project_baselines_baseline_kind_check
    CHECK (baseline_kind IN ('schedule', 'scope', 'integrated')),
  DROP CONSTRAINT IF EXISTS project_baselines_scope_approval_evidence_check,
  ADD CONSTRAINT project_baselines_scope_approval_evidence_check
    CHECK (
      status <> 'approved'
      OR baseline_kind = 'schedule'
      OR (
        approved_at IS NOT NULL
        AND NULLIF(btrim(approved_by), '') IS NOT NULL
        AND NULLIF(btrim(approval_reference), '') IS NOT NULL
      )
    );

-- Baseline creation is now atomic through the RPC below. Prevent direct client inserts from
-- bypassing evidence capture or creating an active schedule baseline outside that transaction.
DROP POLICY IF EXISTS "anon_crud_project_baselines" ON project_baselines;
DROP POLICY IF EXISTS "anon_read_project_baselines" ON project_baselines;
CREATE POLICY "anon_read_project_baselines" ON project_baselines
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_crud_baseline_activities" ON baseline_activities;
DROP POLICY IF EXISTS "anon_read_baseline_activities" ON baseline_activities;
CREATE POLICY "anon_read_baseline_activities" ON baseline_activities
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON project_baselines, baseline_activities FROM anon, authenticated;
GRANT SELECT ON project_baselines, baseline_activities TO anon, authenticated;

CREATE TABLE IF NOT EXISTS project_scope_baseline_current (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  baseline_id uuid NOT NULL UNIQUE REFERENCES project_baselines(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS baseline_boq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  baseline_id uuid NOT NULL REFERENCES project_baselines(id) ON DELETE RESTRICT,
  source_boq_item_id uuid REFERENCES boq_items(id) ON DELETE SET NULL,
  item_code text NOT NULL,
  description text NOT NULL,
  unit text,
  original_quantity numeric(15,3),
  original_unit_price numeric(15,2),
  original_value numeric(15,2),
  category text,
  section text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (baseline_id, source_boq_item_id),
  CHECK (original_quantity IS NULL OR original_quantity::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  CHECK (original_unit_price IS NULL OR original_unit_price::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  CHECK (original_value IS NULL OR original_value::text NOT IN ('NaN', 'Infinity', '-Infinity'))
);

CREATE TABLE IF NOT EXISTS baseline_wbs_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  baseline_id uuid NOT NULL REFERENCES project_baselines(id) ON DELETE RESTRICT,
  source_wbs_node_id uuid REFERENCES wbs_nodes(id) ON DELETE SET NULL,
  source_parent_id uuid,
  parent_code text,
  node_code text NOT NULL,
  node_name text NOT NULL,
  level integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  boq_item_id uuid REFERENCES boq_items(id) ON DELETE SET NULL,
  boq_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (baseline_id, source_wbs_node_id)
);

CREATE INDEX IF NOT EXISTS idx_baseline_boq_items_revision ON baseline_boq_items(baseline_id);
CREATE INDEX IF NOT EXISTS idx_baseline_wbs_nodes_revision ON baseline_wbs_nodes(baseline_id);

ALTER TABLE project_scope_baseline_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseline_boq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseline_wbs_nodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_project_scope_baseline_current" ON project_scope_baseline_current;
CREATE POLICY "anon_read_project_scope_baseline_current" ON project_scope_baseline_current
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_read_baseline_boq_items" ON baseline_boq_items;
CREATE POLICY "anon_read_baseline_boq_items" ON baseline_boq_items
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_read_baseline_wbs_nodes" ON baseline_wbs_nodes;
CREATE POLICY "anon_read_baseline_wbs_nodes" ON baseline_wbs_nodes
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON project_scope_baseline_current, baseline_boq_items, baseline_wbs_nodes FROM anon, authenticated;
GRANT SELECT ON project_scope_baseline_current, baseline_boq_items, baseline_wbs_nodes TO anon, authenticated;

CREATE OR REPLACE FUNCTION validate_project_scope_baseline_pointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id uuid;
  v_status text;
  v_kind text;
BEGIN
  SELECT project_id, status, baseline_kind
    INTO v_project_id, v_status, v_kind
    FROM project_baselines
    WHERE id = NEW.baseline_id;
  IF NOT FOUND
    OR v_project_id <> NEW.project_id
    OR v_status <> 'approved'
    OR v_kind NOT IN ('scope', 'integrated') THEN
    RAISE EXCEPTION 'Current scope pointer must reference an approved scope baseline in the same project';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_project_scope_baseline_pointer ON project_scope_baseline_current;
CREATE TRIGGER validate_project_scope_baseline_pointer
  BEFORE INSERT OR UPDATE ON project_scope_baseline_current
  FOR EACH ROW EXECUTE FUNCTION validate_project_scope_baseline_pointer();

CREATE OR REPLACE FUNCTION prevent_approved_scope_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_baseline_id uuid;
BEGIN
  v_baseline_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.baseline_id ELSE NEW.baseline_id END;
  IF EXISTS (
    SELECT 1 FROM project_baselines
    WHERE id = v_baseline_id AND status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Approved scope baseline snapshots are immutable; create a new baseline revision';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS immutable_baseline_boq_items ON baseline_boq_items;
CREATE TRIGGER immutable_baseline_boq_items
  BEFORE UPDATE OR DELETE ON baseline_boq_items
  FOR EACH ROW EXECUTE FUNCTION prevent_approved_scope_snapshot_change();
DROP TRIGGER IF EXISTS immutable_baseline_wbs_nodes ON baseline_wbs_nodes;
CREATE TRIGGER immutable_baseline_wbs_nodes
  BEFORE UPDATE OR DELETE ON baseline_wbs_nodes
  FOR EACH ROW EXECUTE FUNCTION prevent_approved_scope_snapshot_change();

CREATE TABLE IF NOT EXISTS variation_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  vo_number text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  cause text NOT NULL CHECK (cause IN ('client_request', 'design_change', 'site_condition', 'authority_requirement', 'other')),
  source text NOT NULL DEFAULT '',
  source_reference text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn')),
  requested_date date NOT NULL,
  requested_by text NOT NULL,
  submitted_at timestamptz,
  approval_date date,
  approved_by text,
  approval_reference text,
  approval_evidence_reference text,
  rejection_date date,
  rejected_by text,
  rejection_reference text,
  rejection_reason text,
  withdrawn_date date,
  withdrawn_by text,
  withdrawal_reason text,
  schedule_impact_days numeric(10,2) CHECK (schedule_impact_days IS NULL OR schedule_impact_days::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  schedule_impact_reference text,
  notes text,
  revision_of_id uuid REFERENCES variation_orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NULLIF(btrim(vo_number), '') IS NOT NULL),
  CHECK (
    status <> 'approved'
    OR (
      approval_date IS NOT NULL
      AND NULLIF(btrim(approved_by), '') IS NOT NULL
      AND NULLIF(btrim(approval_reference), '') IS NOT NULL
      AND NULLIF(btrim(approval_evidence_reference), '') IS NOT NULL
    )
  ),
  CHECK (
    status <> 'rejected'
    OR (
      rejection_date IS NOT NULL
      AND NULLIF(btrim(rejected_by), '') IS NOT NULL
      AND NULLIF(btrim(rejection_reason), '') IS NOT NULL
    )
  ),
  CHECK (
    status <> 'withdrawn'
    OR (
      withdrawn_date IS NOT NULL
      AND NULLIF(btrim(withdrawn_by), '') IS NOT NULL
      AND NULLIF(btrim(withdrawal_reason), '') IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS variation_order_boq_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  variation_order_id uuid NOT NULL REFERENCES variation_orders(id) ON DELETE RESTRICT,
  boq_item_id uuid NOT NULL REFERENCES boq_items(id) ON DELETE RESTRICT,
  quantity_impact numeric(15,3),
  value_impact numeric(15,2),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variation_order_id, boq_item_id),
  CHECK (quantity_impact IS NULL OR quantity_impact::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  CHECK (value_impact IS NULL OR value_impact::text NOT IN ('NaN', 'Infinity', '-Infinity'))
);

CREATE TABLE IF NOT EXISTS variation_order_wbs_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  variation_order_id uuid NOT NULL REFERENCES variation_orders(id) ON DELETE RESTRICT,
  wbs_node_id uuid NOT NULL REFERENCES wbs_nodes(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variation_order_id, wbs_node_id)
);

CREATE TABLE IF NOT EXISTS variation_order_activity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  variation_order_id uuid NOT NULL REFERENCES variation_orders(id) ON DELETE RESTRICT,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variation_order_id, activity_id)
);

CREATE TABLE IF NOT EXISTS variation_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  variation_order_id uuid NOT NULL REFERENCES variation_orders(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  from_status text CHECK (from_status IS NULL OR from_status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn')),
  to_status text NOT NULL CHECK (to_status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn')),
  actor text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reference text,
  evidence_reference text,
  notes text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_variation_orders_project_number_ci
  ON variation_orders(project_id, lower(btrim(vo_number)));
CREATE INDEX IF NOT EXISTS idx_variation_orders_project_status ON variation_orders(project_id, status, requested_date);
CREATE INDEX IF NOT EXISTS idx_variation_order_boq_impacts_project_item ON variation_order_boq_impacts(project_id, boq_item_id);
CREATE INDEX IF NOT EXISTS idx_variation_order_wbs_links_project_node ON variation_order_wbs_links(project_id, wbs_node_id);
CREATE INDEX IF NOT EXISTS idx_variation_order_activity_links_project_activity ON variation_order_activity_links(project_id, activity_id);
CREATE INDEX IF NOT EXISTS idx_variation_order_events_parent ON variation_order_events(variation_order_id, changed_at);

ALTER TABLE variation_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE variation_order_boq_impacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE variation_order_wbs_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE variation_order_activity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE variation_order_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_variation_orders" ON variation_orders;
CREATE POLICY "anon_read_variation_orders" ON variation_orders FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_read_variation_order_boq_impacts" ON variation_order_boq_impacts;
CREATE POLICY "anon_read_variation_order_boq_impacts" ON variation_order_boq_impacts FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_read_variation_order_wbs_links" ON variation_order_wbs_links;
CREATE POLICY "anon_read_variation_order_wbs_links" ON variation_order_wbs_links FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_read_variation_order_activity_links" ON variation_order_activity_links;
CREATE POLICY "anon_read_variation_order_activity_links" ON variation_order_activity_links FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_read_variation_order_events" ON variation_order_events;
CREATE POLICY "anon_read_variation_order_events" ON variation_order_events FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON variation_orders, variation_order_boq_impacts,
  variation_order_wbs_links, variation_order_activity_links, variation_order_events FROM anon, authenticated;
GRANT SELECT ON variation_orders, variation_order_boq_impacts, variation_order_wbs_links,
  variation_order_activity_links, variation_order_events TO anon, authenticated;

CREATE OR REPLACE FUNCTION protect_variation_order_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_has_reference boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Variation order history cannot be deleted; use a governed withdrawal or revision';
  END IF;
  IF OLD.id <> NEW.id OR OLD.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'Variation order identity and project are immutable';
  END IF;
  IF OLD.status IN ('approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'Terminal variation order history is immutable; create a governed revision';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status IN ('submitted', 'withdrawn'))
      OR (OLD.status = 'submitted' AND NEW.status IN ('under_review', 'approved', 'rejected', 'withdrawn'))
      OR (OLD.status = 'under_review' AND NEW.status IN ('approved', 'rejected', 'withdrawn'))
    ) THEN
      RAISE EXCEPTION 'Invalid variation order lifecycle transition';
    END IF;
    IF NEW.status = 'submitted' THEN
      SELECT EXISTS (
        SELECT 1 FROM variation_order_boq_impacts WHERE variation_order_id = OLD.id
        UNION ALL
        SELECT 1 FROM variation_order_wbs_links WHERE variation_order_id = OLD.id
        UNION ALL
        SELECT 1 FROM variation_order_activity_links WHERE variation_order_id = OLD.id
      ) INTO v_has_reference;
      IF NOT v_has_reference THEN
        RAISE EXCEPTION 'A variation order needs a BOQ, WBS or activity reference before submission';
      END IF;
    END IF;
    IF NEW.status = 'approved' AND (
      NEW.approval_date IS NULL
      OR NULLIF(btrim(NEW.approved_by), '') IS NULL
      OR NULLIF(btrim(NEW.approval_reference), '') IS NULL
      OR NULLIF(btrim(NEW.approval_evidence_reference), '') IS NULL
    ) THEN
      RAISE EXCEPTION 'Approval requires an explicit date, approver, reference and evidence';
    END IF;
    IF NEW.status = 'rejected' AND (
      NEW.rejection_date IS NULL
      OR NULLIF(btrim(NEW.rejected_by), '') IS NULL
      OR NULLIF(btrim(NEW.rejection_reason), '') IS NULL
    ) THEN
      RAISE EXCEPTION 'Rejection requires an explicit date, reviewer and reason';
    END IF;
    IF NEW.status = 'withdrawn' AND (
      NEW.withdrawn_date IS NULL
      OR NULLIF(btrim(NEW.withdrawn_by), '') IS NULL
      OR NULLIF(btrim(NEW.withdrawal_reason), '') IS NULL
    ) THEN
      RAISE EXCEPTION 'Withdrawal requires an explicit date, actor and reason';
    END IF;
  ELSIF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Submitted variation orders are read-only; withdraw and create a revision';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_variation_order_lifecycle ON variation_orders;
CREATE TRIGGER protect_variation_order_lifecycle
  BEFORE UPDATE OR DELETE ON variation_orders
  FOR EACH ROW EXECUTE FUNCTION protect_variation_order_lifecycle();

CREATE OR REPLACE FUNCTION protect_variation_order_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id uuid;
  v_project_id uuid;
  v_status text;
  v_item_project uuid;
BEGIN
  v_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.variation_order_id ELSE NEW.variation_order_id END;
  v_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  SELECT project_id, status INTO v_item_project, v_status FROM variation_orders WHERE id = v_order_id;
  IF NOT FOUND OR v_item_project <> v_project_id OR v_status <> 'draft' THEN
    RAISE EXCEPTION 'Variation order references can only be changed on a project-matched draft';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'variation_order_boq_impacts' THEN
      IF NOT EXISTS (SELECT 1 FROM boq_items WHERE id = NEW.boq_item_id AND project_id = v_project_id) THEN
        RAISE EXCEPTION 'BOQ impact crosses project boundary';
      END IF;
    ELSIF TG_TABLE_NAME = 'variation_order_wbs_links' THEN
      IF NOT EXISTS (SELECT 1 FROM wbs_nodes WHERE id = NEW.wbs_node_id AND project_id = v_project_id) THEN
        RAISE EXCEPTION 'WBS link crosses project boundary';
      END IF;
    ELSIF TG_TABLE_NAME = 'variation_order_activity_links' THEN
      IF NOT EXISTS (SELECT 1 FROM activities WHERE id = NEW.activity_id AND project_id = v_project_id) THEN
        RAISE EXCEPTION 'Activity link crosses project boundary';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS protect_variation_order_boq_impacts ON variation_order_boq_impacts;
CREATE TRIGGER protect_variation_order_boq_impacts
  BEFORE INSERT OR UPDATE OR DELETE ON variation_order_boq_impacts
  FOR EACH ROW EXECUTE FUNCTION protect_variation_order_references();
DROP TRIGGER IF EXISTS protect_variation_order_wbs_links ON variation_order_wbs_links;
CREATE TRIGGER protect_variation_order_wbs_links
  BEFORE INSERT OR UPDATE OR DELETE ON variation_order_wbs_links
  FOR EACH ROW EXECUTE FUNCTION protect_variation_order_references();
DROP TRIGGER IF EXISTS protect_variation_order_activity_links ON variation_order_activity_links;
CREATE TRIGGER protect_variation_order_activity_links
  BEFORE INSERT OR UPDATE OR DELETE ON variation_order_activity_links
  FOR EACH ROW EXECUTE FUNCTION protect_variation_order_references();

CREATE OR REPLACE FUNCTION prevent_variation_order_event_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Variation order audit history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS immutable_variation_order_events ON variation_order_events;
CREATE TRIGGER immutable_variation_order_events
  BEFORE UPDATE OR DELETE ON variation_order_events
  FOR EACH ROW EXECUTE FUNCTION prevent_variation_order_event_change();

CREATE OR REPLACE FUNCTION approve_project_scope_baseline(
  p_project_id uuid,
  p_name text,
  p_approval_reference text,
  p_approved_by text,
  p_approved_at timestamptz,
  p_activity_rows jsonb DEFAULT '[]'::jsonb,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version integer;
  v_baseline_id uuid;
  v_previous_scope_baseline_id uuid;
  v_kind text;
  v_active boolean;
  v_activity_count integer;
BEGIN
  IF p_project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Scope baseline requires an existing project';
  END IF;
  IF p_approved_at IS NULL
    OR NULLIF(btrim(p_approved_by), '') IS NULL
    OR NULLIF(btrim(p_approval_reference), '') IS NULL THEN
    RAISE EXCEPTION 'Scope baseline approval requires an approver, approval date and evidence reference';
  END IF;
  IF p_activity_rows IS NULL OR jsonb_typeof(p_activity_rows) <> 'array' THEN
    RAISE EXCEPTION 'Baseline activity rows must be a JSON array';
  END IF;

  -- Serialize approvals per project so concurrent callers cannot allocate the same revision.
  PERFORM 1 FROM projects WHERE id = p_project_id FOR UPDATE;
  SELECT baseline_id INTO v_previous_scope_baseline_id
  FROM project_scope_baseline_current
  WHERE project_id = p_project_id
  FOR UPDATE;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
  FROM project_baselines WHERE project_id = p_project_id;
  IF p_expected_version IS NOT NULL AND p_expected_version <> v_version THEN
    RAISE EXCEPTION 'Baseline version changed; refresh scope history and retry';
  END IF;

  v_activity_count := jsonb_array_length(p_activity_rows);
  v_kind := CASE WHEN v_activity_count > 0 THEN 'integrated' ELSE 'scope' END;
  v_active := v_activity_count > 0;
  IF v_active AND EXISTS (
    SELECT 1 FROM project_baselines
    WHERE project_id = p_project_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'An active schedule baseline already exists; use a scope-only revision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_activity_rows) AS a(
      activity_id uuid,
      early_start date,
      early_finish date,
      duration_days integer,
      planned_cost numeric,
      total_float numeric
    )
    WHERE a.activity_id IS NULL OR a.early_start IS NULL OR a.early_finish IS NULL
      OR a.duration_days IS NULL OR a.planned_cost IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM activities act WHERE act.id = a.activity_id AND act.project_id = p_project_id
      )
  ) THEN
    RAISE EXCEPTION 'Baseline activity evidence must have valid dates/costs and belong to the project';
  END IF;
  IF (
    SELECT count(*) <> count(DISTINCT a.activity_id)
    FROM jsonb_to_recordset(p_activity_rows) AS a(activity_id uuid)
  ) THEN
    RAISE EXCEPTION 'Baseline activity rows must have unique activity references';
  END IF;
  IF v_previous_scope_baseline_id IS NULL AND EXISTS (
    SELECT 1 FROM boq_items bi
    WHERE bi.project_id = p_project_id
      AND (
        (bi.quantity IS NOT NULL AND bi.quantity::text IN ('NaN', 'Infinity', '-Infinity'))
        OR (bi.unit_price IS NOT NULL AND bi.unit_price::text IN ('NaN', 'Infinity', '-Infinity'))
        OR (bi.total_price IS NOT NULL AND bi.total_price::text IN ('NaN', 'Infinity', '-Infinity'))
      )
  ) THEN
    RAISE EXCEPTION 'Original BOQ basis contains a non-finite number';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wbs_nodes w
    WHERE w.project_id = p_project_id AND (
      (w.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM wbs_nodes parent WHERE parent.id = w.parent_id AND parent.project_id = p_project_id
      ))
      OR (w.boq_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM boq_items bi WHERE bi.id = w.boq_item_id AND bi.project_id = p_project_id
      ))
    )
  ) THEN
    RAISE EXCEPTION 'WBS snapshot contains a cross-project or unresolved parent/BOQ reference';
  END IF;

  INSERT INTO project_baselines(
    project_id, version, name, status, approved_at, approved_by, approval_reference,
    baseline_kind, is_active
  ) VALUES (
    p_project_id, v_version, COALESCE(NULLIF(btrim(p_name), ''), 'Approved Scope Baseline'),
    'approved', p_approved_at, btrim(p_approved_by), btrim(p_approval_reference), v_kind, v_active
  ) RETURNING id INTO v_baseline_id;

  IF v_previous_scope_baseline_id IS NULL THEN
    INSERT INTO baseline_boq_items(
      project_id, baseline_id, source_boq_item_id, item_code, description, unit,
      original_quantity, original_unit_price, original_value, category, section, sort_order
    )
    SELECT
      p_project_id, v_baseline_id, bi.id, bi.code, bi.description, bi.unit,
      bi.quantity, bi.unit_price, bi.total_price, bi.category, bi.section, COALESCE(bi.sort_order, 0)
    FROM boq_items bi
    WHERE bi.project_id = p_project_id;
  ELSE
    -- Later approved WBS/scope revisions retain the first contracted BOQ basis. Current BOQ rows
    -- may contain post-award additions/edits; those must be governed as VO impacts, never rebased.
    INSERT INTO baseline_boq_items(
      project_id, baseline_id, source_boq_item_id, item_code, description, unit,
      original_quantity, original_unit_price, original_value, category, section, sort_order
    )
    SELECT
      p_project_id, v_baseline_id, prior.source_boq_item_id, prior.item_code, prior.description, prior.unit,
      prior.original_quantity, prior.original_unit_price, prior.original_value,
      prior.category, prior.section, prior.sort_order
    FROM baseline_boq_items prior
    WHERE prior.baseline_id = v_previous_scope_baseline_id;
  END IF;

  INSERT INTO baseline_wbs_nodes(
    project_id, baseline_id, source_wbs_node_id, source_parent_id, parent_code,
    node_code, node_name, level, sort_order, boq_item_id, boq_code
  )
  SELECT
    p_project_id, v_baseline_id, w.id, w.parent_id, parent.code,
    w.code, w.name, COALESCE(w.level, 0), COALESCE(w.sort_order, 0), w.boq_item_id, bi.code
  FROM wbs_nodes w
  LEFT JOIN wbs_nodes parent ON parent.id = w.parent_id AND parent.project_id = p_project_id
  LEFT JOIN boq_items bi ON bi.id = w.boq_item_id AND bi.project_id = p_project_id
  WHERE w.project_id = p_project_id;

  INSERT INTO baseline_activities(
    baseline_id, activity_id, early_start, early_finish, duration_days, planned_cost, total_float
  )
  SELECT
    v_baseline_id, a.activity_id, a.early_start, a.early_finish,
    a.duration_days, a.planned_cost, a.total_float
  FROM jsonb_to_recordset(p_activity_rows) AS a(
    activity_id uuid,
    early_start date,
    early_finish date,
    duration_days integer,
    planned_cost numeric,
    total_float numeric
  );

  INSERT INTO project_scope_baseline_current(project_id, baseline_id, updated_at)
  VALUES (p_project_id, v_baseline_id, now())
  ON CONFLICT (project_id) DO UPDATE
    SET baseline_id = EXCLUDED.baseline_id, updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'baseline_id', v_baseline_id,
    'version', v_version,
    'activity_count', v_activity_count,
    'boq_item_count', (SELECT count(*) FROM baseline_boq_items WHERE baseline_id = v_baseline_id),
    'wbs_node_count', (SELECT count(*) FROM baseline_wbs_nodes WHERE baseline_id = v_baseline_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION approve_project_scope_baseline(uuid, text, text, text, timestamptz, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_project_scope_baseline(uuid, text, text, text, timestamptz, jsonb, integer) TO anon, authenticated;

CREATE OR REPLACE FUNCTION save_variation_order_draft(
  p_project_id uuid,
  p_header jsonb,
  p_boq_impacts jsonb,
  p_wbs_ids uuid[],
  p_activity_ids uuid[],
  p_actor text,
  p_variation_order_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_existing variation_orders%ROWTYPE;
  v_saved variation_orders%ROWTYPE;
  v_before_boq_impacts jsonb := '[]'::jsonb;
  v_before_wbs_ids jsonb := '[]'::jsonb;
  v_before_activity_ids jsonb := '[]'::jsonb;
  v_after_boq_impacts jsonb := '[]'::jsonb;
  v_after_wbs_ids jsonb := '[]'::jsonb;
  v_after_activity_ids jsonb := '[]'::jsonb;
  v_number text;
  v_title text;
  v_cause text;
  v_source text;
  v_requested_by text;
  v_requested_date date;
  v_revision_of_id uuid;
  v_schedule_impact numeric;
BEGIN
  IF p_project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Variation order requires an existing project';
  END IF;
  IF NULLIF(btrim(p_actor), '') IS NULL OR p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'Draft save requires an actor and header';
  END IF;
  IF p_boq_impacts IS NULL OR jsonb_typeof(p_boq_impacts) <> 'array' THEN
    RAISE EXCEPTION 'BOQ impact lines must be a JSON array';
  END IF;

  v_number := NULLIF(btrim(p_header->>'vo_number'), '');
  v_title := NULLIF(btrim(p_header->>'title'), '');
  v_cause := NULLIF(btrim(p_header->>'cause'), '');
  v_source := NULLIF(btrim(p_header->>'source'), '');
  v_requested_by := NULLIF(btrim(p_header->>'requested_by'), '');
  v_requested_date := NULLIF(p_header->>'requested_date', '')::date;
  v_revision_of_id := NULLIF(p_header->>'revision_of_id', '')::uuid;
  v_schedule_impact := NULLIF(p_header->>'schedule_impact_days', '')::numeric;

  IF v_number IS NULL OR v_title IS NULL OR v_source IS NULL OR v_requested_by IS NULL OR v_requested_date IS NULL
    OR v_cause IS NULL OR v_cause NOT IN ('client_request', 'design_change', 'site_condition', 'authority_requirement', 'other') THEN
    RAISE EXCEPTION 'Draft requires a unique number, title, valid cause/source, requester and requested date';
  END IF;
  IF v_revision_of_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM variation_orders
    WHERE id = v_revision_of_id AND project_id = p_project_id AND status IN ('approved', 'rejected', 'withdrawn')
  ) THEN
    RAISE EXCEPTION 'A correction must reference a terminal VO in the same project';
  END IF;

  IF p_variation_order_id IS NULL THEN
    INSERT INTO variation_orders(
      project_id, vo_number, title, description, cause, source, source_reference,
      status, requested_date, requested_by, schedule_impact_days,
      schedule_impact_reference, notes, revision_of_id
    ) VALUES (
      p_project_id, v_number, v_title, COALESCE(p_header->>'description', ''), v_cause,
      v_source, NULLIF(btrim(p_header->>'source_reference'), ''),
      'draft', v_requested_date, v_requested_by, v_schedule_impact,
      NULLIF(btrim(p_header->>'schedule_impact_reference'), ''), NULLIF(btrim(p_header->>'notes'), ''), v_revision_of_id
    ) RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_existing FROM variation_orders WHERE id = p_variation_order_id FOR UPDATE;
    IF NOT FOUND OR v_existing.project_id <> p_project_id OR v_existing.status <> 'draft' THEN
      RAISE EXCEPTION 'Only a draft VO in this project can be edited';
    END IF;
    UPDATE variation_orders SET
      vo_number = v_number,
      title = v_title,
      description = COALESCE(p_header->>'description', ''),
      cause = v_cause,
      source = v_source,
      source_reference = NULLIF(btrim(p_header->>'source_reference'), ''),
      requested_date = v_requested_date,
      requested_by = v_requested_by,
      schedule_impact_days = v_schedule_impact,
      schedule_impact_reference = NULLIF(btrim(p_header->>'schedule_impact_reference'), ''),
      notes = NULLIF(btrim(p_header->>'notes'), ''),
      revision_of_id = v_revision_of_id,
      updated_at = now()
    WHERE id = p_variation_order_id
    RETURNING id INTO v_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_boq_impacts) AS impact(
      boq_item_id uuid, quantity_impact numeric, value_impact numeric, notes text
    )
    WHERE impact.boq_item_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM boq_items b WHERE b.id = impact.boq_item_id AND b.project_id = p_project_id)
  ) THEN
    RAISE EXCEPTION 'BOQ impact references must belong to the project';
  END IF;
  IF (
    SELECT count(*) <> count(DISTINCT impact.boq_item_id)
    FROM jsonb_to_recordset(p_boq_impacts) AS impact(boq_item_id uuid)
  ) THEN
    RAISE EXCEPTION 'A VO may reference each BOQ item only once';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_wbs_ids, ARRAY[]::uuid[])) AS ref(id)
    WHERE NOT EXISTS (SELECT 1 FROM wbs_nodes w WHERE w.id = ref.id AND w.project_id = p_project_id)
  ) THEN
    RAISE EXCEPTION 'WBS references must belong to the project';
  END IF;
  IF EXISTS (
    SELECT ref.id FROM unnest(COALESCE(p_wbs_ids, ARRAY[]::uuid[])) AS ref(id)
    GROUP BY ref.id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'WBS references must be unique';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_activity_ids, ARRAY[]::uuid[])) AS ref(id)
    WHERE NOT EXISTS (SELECT 1 FROM activities a WHERE a.id = ref.id AND a.project_id = p_project_id)
  ) THEN
    RAISE EXCEPTION 'Activity references must belong to the project';
  END IF;
  IF EXISTS (
    SELECT ref.id FROM unnest(COALESCE(p_activity_ids, ARRAY[]::uuid[])) AS ref(id)
    GROUP BY ref.id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Activity references must be unique';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.boq_item_id), '[]'::jsonb)
    INTO v_before_boq_impacts FROM variation_order_boq_impacts line WHERE line.variation_order_id = v_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(link) ORDER BY link.wbs_node_id), '[]'::jsonb)
    INTO v_before_wbs_ids FROM variation_order_wbs_links link WHERE link.variation_order_id = v_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(link) ORDER BY link.activity_id), '[]'::jsonb)
    INTO v_before_activity_ids FROM variation_order_activity_links link WHERE link.variation_order_id = v_id;

  DELETE FROM variation_order_boq_impacts WHERE variation_order_id = v_id;
  INSERT INTO variation_order_boq_impacts(
    project_id, variation_order_id, boq_item_id, quantity_impact, value_impact, notes
  )
  SELECT p_project_id, v_id, impact.boq_item_id, impact.quantity_impact, impact.value_impact,
    NULLIF(btrim(impact.notes), '')
  FROM jsonb_to_recordset(p_boq_impacts) AS impact(
    boq_item_id uuid, quantity_impact numeric, value_impact numeric, notes text
  );

  DELETE FROM variation_order_wbs_links WHERE variation_order_id = v_id;
  INSERT INTO variation_order_wbs_links(project_id, variation_order_id, wbs_node_id)
  SELECT p_project_id, v_id, ref.id FROM unnest(COALESCE(p_wbs_ids, ARRAY[]::uuid[])) AS ref(id);

  DELETE FROM variation_order_activity_links WHERE variation_order_id = v_id;
  INSERT INTO variation_order_activity_links(project_id, variation_order_id, activity_id)
  SELECT p_project_id, v_id, ref.id FROM unnest(COALESCE(p_activity_ids, ARRAY[]::uuid[])) AS ref(id);

  SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.boq_item_id), '[]'::jsonb)
    INTO v_after_boq_impacts FROM variation_order_boq_impacts line WHERE line.variation_order_id = v_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(link) ORDER BY link.wbs_node_id), '[]'::jsonb)
    INTO v_after_wbs_ids FROM variation_order_wbs_links link WHERE link.variation_order_id = v_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(link) ORDER BY link.activity_id), '[]'::jsonb)
    INTO v_after_activity_ids FROM variation_order_activity_links link WHERE link.variation_order_id = v_id;
  SELECT * INTO v_saved FROM variation_orders WHERE id = v_id;

  INSERT INTO variation_order_events(
    project_id, variation_order_id, event_type, from_status, to_status, actor, reference, notes, details
  ) VALUES (
    p_project_id, v_id,
    CASE WHEN p_variation_order_id IS NOT NULL THEN 'draft_updated'
      WHEN v_revision_of_id IS NOT NULL THEN 'revision_created' ELSE 'created' END,
    CASE WHEN p_variation_order_id IS NOT NULL THEN 'draft' ELSE NULL END,
    'draft', btrim(p_actor), COALESCE(v_revision_of_id::text, v_number),
    CASE WHEN p_variation_order_id IS NOT NULL THEN 'Draft header and references updated' ELSE NULL END,
    jsonb_build_object(
      'before_header', CASE WHEN p_variation_order_id IS NOT NULL THEN to_jsonb(v_existing) ELSE NULL END,
      'after_header', to_jsonb(v_saved),
      'before_boq_impacts', v_before_boq_impacts,
      'after_boq_impacts', v_after_boq_impacts,
      'before_wbs_links', v_before_wbs_ids,
      'after_wbs_links', v_after_wbs_ids,
      'before_activity_links', v_before_activity_ids,
      'after_activity_links', v_after_activity_ids
    )
  );
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION transition_variation_order(
  p_variation_order_id uuid,
  p_expected_status text,
  p_next_status text,
  p_actor text,
  p_effective_date date DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_evidence_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order variation_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM variation_orders WHERE id = p_variation_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Variation order does not exist'; END IF;
  IF v_order.status <> p_expected_status THEN RAISE EXCEPTION 'Variation order status changed; refresh before retrying'; END IF;
  IF NULLIF(btrim(p_actor), '') IS NULL THEN RAISE EXCEPTION 'Lifecycle transition requires an accountable actor'; END IF;
  IF NOT (
    (v_order.status = 'draft' AND p_next_status IN ('submitted', 'withdrawn'))
    OR (v_order.status = 'submitted' AND p_next_status IN ('under_review', 'approved', 'rejected', 'withdrawn'))
    OR (v_order.status = 'under_review' AND p_next_status IN ('approved', 'rejected', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'Invalid variation order lifecycle transition';
  END IF;
  IF p_next_status = 'submitted' AND NOT (
    EXISTS (SELECT 1 FROM variation_order_boq_impacts WHERE variation_order_id = v_order.id)
    OR EXISTS (SELECT 1 FROM variation_order_wbs_links WHERE variation_order_id = v_order.id)
    OR EXISTS (SELECT 1 FROM variation_order_activity_links WHERE variation_order_id = v_order.id)
  ) THEN
    RAISE EXCEPTION 'A variation order needs a BOQ, WBS or activity reference before submission';
  END IF;
  IF p_next_status IN ('approved', 'rejected', 'withdrawn') AND p_effective_date IS NULL THEN
    RAISE EXCEPTION 'Terminal lifecycle transitions require an explicit effective date';
  END IF;
  IF p_next_status = 'approved' AND (
    NULLIF(btrim(p_reference), '') IS NULL OR NULLIF(btrim(p_evidence_reference), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Approval requires both an approval reference and evidence reference';
  END IF;
  IF p_next_status = 'rejected' AND NULLIF(btrim(p_notes), '') IS NULL THEN
    RAISE EXCEPTION 'Rejection requires a recorded reason';
  END IF;
  IF p_next_status = 'withdrawn' AND NULLIF(btrim(p_notes), '') IS NULL THEN
    RAISE EXCEPTION 'Withdrawal requires a recorded reason';
  END IF;

  UPDATE variation_orders SET
    status = p_next_status,
    submitted_at = CASE WHEN p_next_status = 'submitted' THEN now() ELSE submitted_at END,
    approval_date = CASE WHEN p_next_status = 'approved' THEN p_effective_date ELSE approval_date END,
    approved_by = CASE WHEN p_next_status = 'approved' THEN btrim(p_actor) ELSE approved_by END,
    approval_reference = CASE WHEN p_next_status = 'approved' THEN btrim(p_reference) ELSE approval_reference END,
    approval_evidence_reference = CASE WHEN p_next_status = 'approved' THEN btrim(p_evidence_reference) ELSE approval_evidence_reference END,
    rejection_date = CASE WHEN p_next_status = 'rejected' THEN p_effective_date ELSE rejection_date END,
    rejected_by = CASE WHEN p_next_status = 'rejected' THEN btrim(p_actor) ELSE rejected_by END,
    rejection_reference = CASE WHEN p_next_status = 'rejected' THEN NULLIF(btrim(p_reference), '') ELSE rejection_reference END,
    rejection_reason = CASE WHEN p_next_status = 'rejected' THEN btrim(p_notes) ELSE rejection_reason END,
    withdrawn_date = CASE WHEN p_next_status = 'withdrawn' THEN p_effective_date ELSE withdrawn_date END,
    withdrawn_by = CASE WHEN p_next_status = 'withdrawn' THEN btrim(p_actor) ELSE withdrawn_by END,
    withdrawal_reason = CASE WHEN p_next_status = 'withdrawn' THEN btrim(p_notes) ELSE withdrawal_reason END,
    updated_at = now()
  WHERE id = v_order.id;

  INSERT INTO variation_order_events(
    project_id, variation_order_id, event_type, from_status, to_status, actor, changed_at,
    reference, evidence_reference, notes, details
  ) VALUES (
    v_order.project_id, v_order.id, p_next_status, v_order.status, p_next_status, btrim(p_actor), now(),
    NULLIF(btrim(p_reference), ''), NULLIF(btrim(p_evidence_reference), ''), NULLIF(btrim(p_notes), ''),
    jsonb_build_object(
      'effective_date', p_effective_date,
      'reference', NULLIF(btrim(p_reference), ''),
      'evidence_reference', NULLIF(btrim(p_evidence_reference), ''),
      'notes', NULLIF(btrim(p_notes), '')
    )
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION save_variation_order_draft(uuid, jsonb, jsonb, uuid[], uuid[], text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION transition_variation_order(uuid, text, text, text, date, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_variation_order_draft(uuid, jsonb, jsonb, uuid[], uuid[], text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION transition_variation_order(uuid, text, text, text, date, text, text, text) TO anon, authenticated;

COMMIT;

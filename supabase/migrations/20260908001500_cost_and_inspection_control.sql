ALTER TABLE budget_lines ADD COLUMN IF NOT EXISTS estimated_cost numeric(15,2);
ALTER TABLE budget_lines ADD COLUMN IF NOT EXISTS approved_budget numeric(15,2);
ALTER TABLE budget_lines ADD COLUMN IF NOT EXISTS budget_basis text NOT NULL DEFAULT 'engineer_estimate';
UPDATE budget_lines SET estimated_cost = COALESCE(estimated_cost, planned_cost), approved_budget = COALESCE(approved_budget, planned_cost);

ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS invoice_number text;
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS vendor text;
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS quantity numeric(15,3) NOT NULL DEFAULT 1 CHECK (quantity > 0);
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS unit_rate numeric(15,2);
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS wbs_node_id uuid REFERENCES wbs_nodes(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS inspection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_number text NOT NULL,
  boq_item_id uuid REFERENCES boq_items(id) ON DELETE SET NULL,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  parent_reference text,
  inspection_date date NOT NULL DEFAULT CURRENT_DATE,
  inspected_quantity numeric(15,3) NOT NULL CHECK (inspected_quantity > 0),
  approved_quantity numeric(15,3) NOT NULL DEFAULT 0 CHECK (approved_quantity >= 0),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','approved','rejected')),
  inspector text,
  notes text,
  approved_at timestamptz,
  approved_by text,
  rejected_reason text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, request_number)
);

ALTER TABLE inspection_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_inspection_requests" ON inspection_requests;
CREATE POLICY "anon_crud_inspection_requests" ON inspection_requests FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION recompute_budget_line_actuals(target_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE budget_lines bl
  SET actual_cost = COALESCE((
    SELECT SUM(ct.amount) FROM cost_transactions ct
    WHERE ct.project_id = target_project AND ct.status = 'approved'
      AND ((ct.boq_item_id IS NOT NULL AND ct.boq_item_id = bl.boq_item_id)
        OR (ct.wbs_node_id IS NOT NULL AND ct.wbs_node_id = bl.wbs_node_id)
        OR (ct.activity_id IS NOT NULL AND ct.activity_id IN (
          SELECT a.id FROM activities a WHERE a.wbs_node_id = bl.wbs_node_id
        )))
  ), 0),
  remaining_cost = COALESCE(bl.approved_budget, bl.planned_cost) - COALESCE((
    SELECT SUM(ct.amount) FROM cost_transactions ct
    WHERE ct.project_id = target_project AND ct.status = 'approved'
      AND ((ct.boq_item_id IS NOT NULL AND ct.boq_item_id = bl.boq_item_id)
        OR (ct.wbs_node_id IS NOT NULL AND ct.wbs_node_id = bl.wbs_node_id)
        OR (ct.activity_id IS NOT NULL AND ct.activity_id IN (
          SELECT a.id FROM activities a WHERE a.wbs_node_id = bl.wbs_node_id
        )))
  ), 0)
  WHERE bl.project_id = target_project;
END;
$$;

CREATE OR REPLACE FUNCTION sync_budget_after_cost_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM recompute_budget_line_actuals(COALESCE(NEW.project_id, OLD.project_id));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_budget_after_cost_change ON cost_transactions;
CREATE TRIGGER sync_budget_after_cost_change AFTER INSERT OR UPDATE OR DELETE ON cost_transactions
FOR EACH ROW EXECUTE FUNCTION sync_budget_after_cost_change();

CREATE OR REPLACE FUNCTION approve_inspection_request(request_uuid uuid, approver text DEFAULT 'operator')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  request_row inspection_requests%ROWTYPE;
  activity_row activities%ROWTYPE;
  approved_to_date numeric;
BEGIN
  SELECT * INTO request_row FROM inspection_requests WHERE id = request_uuid FOR UPDATE;
  IF NOT FOUND OR request_row.status <> 'submitted' THEN RAISE EXCEPTION 'Only submitted inspection requests can be approved'; END IF;
  SELECT * INTO activity_row FROM activities WHERE id = request_row.activity_id FOR UPDATE;
  IF NOT FOUND OR activity_row.project_id <> request_row.project_id THEN RAISE EXCEPTION 'Inspection activity project mismatch'; END IF;
  approved_to_date := LEAST(activity_row.planned_quantity, activity_row.actual_quantity + request_row.inspected_quantity);
  UPDATE inspection_requests SET status = 'approved', approved_quantity = request_row.inspected_quantity, approved_at = now(), approved_by = approver WHERE id = request_uuid;
  UPDATE activities SET actual_quantity = approved_to_date,
    percent_complete = CASE WHEN planned_quantity > 0 THEN LEAST(100, approved_to_date / planned_quantity * 100) ELSE percent_complete END,
    actual_start = COALESCE(actual_start, request_row.inspection_date),
    actual_finish = CASE WHEN planned_quantity > 0 AND approved_to_date >= planned_quantity THEN request_row.inspection_date ELSE actual_finish END
    WHERE id = request_row.activity_id;
  INSERT INTO progress_updates(project_id, activity_id, update_date, percent_complete, actual_quantity, quantity_to_date, status, approved_at, approved_by, notes)
  VALUES (request_row.project_id, request_row.activity_id, request_row.inspection_date,
    CASE WHEN activity_row.planned_quantity > 0 THEN LEAST(100, approved_to_date / activity_row.planned_quantity * 100) ELSE activity_row.percent_complete END,
    request_row.inspected_quantity, approved_to_date, 'approved', now(), approver,
    COALESCE('Inspection ' || request_row.request_number, 'Approved inspection'));
END;
$$;

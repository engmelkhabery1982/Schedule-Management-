ALTER TABLE resources ADD COLUMN IF NOT EXISTS ownership text NOT NULL DEFAULT 'company' CHECK (ownership IN ('company','rental','subcontractor'));
ALTER TABLE resources ADD COLUMN IF NOT EXISTS shift_hours numeric(8,2) NOT NULL DEFAULT 8 CHECK (shift_hours > 0);
ALTER TABLE resources ADD COLUMN IF NOT EXISTS rental_rate numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS cost_rate numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS subcontractor text;

ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS approval_level int NOT NULL DEFAULT 0 CHECK (approval_level >= 0 AND approval_level <= 2);
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS submitted_by text;
ALTER TABLE budget_lines ADD COLUMN IF NOT EXISTS activity_id uuid REFERENCES activities(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('cost_transaction','inspection_request','progress_update')),
  entity_id uuid NOT NULL,
  approval_level int NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted','approved','rejected','edited')),
  actor text NOT NULL,
  notes text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE approval_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_approval_events" ON approval_events;
CREATE POLICY "anon_crud_approval_events" ON approval_events FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION review_cost_transaction(
  transaction_uuid uuid,
  approver text DEFAULT 'operator',
  decision text DEFAULT 'approve',
  review_notes text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  tx cost_transactions%ROWTYPE;
  next_level int;
BEGIN
  SELECT * INTO tx FROM cost_transactions WHERE id = transaction_uuid FOR UPDATE;
  IF NOT FOUND OR tx.status <> 'submitted' THEN RAISE EXCEPTION 'Only submitted cost transactions can be reviewed'; END IF;
  IF decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Invalid review decision'; END IF;
  IF decision = 'reject' THEN
    UPDATE cost_transactions SET status = 'rejected', rejected_reason = review_notes WHERE id = transaction_uuid;
    INSERT INTO approval_events(project_id, entity_type, entity_id, approval_level, action, actor, notes)
      VALUES (tx.project_id, 'cost_transaction', tx.id, tx.approval_level + 1, 'rejected', approver, review_notes);
    RETURN;
  END IF;
  next_level := tx.approval_level + 1;
  IF next_level >= 2 THEN
    UPDATE cost_transactions SET status = 'approved', approval_level = 2, approved_at = now(), approved_by = approver WHERE id = transaction_uuid;
  ELSE
    UPDATE cost_transactions SET approval_level = next_level WHERE id = transaction_uuid;
  END IF;
  INSERT INTO approval_events(project_id, entity_type, entity_id, approval_level, action, actor, notes)
    VALUES (tx.project_id, 'cost_transaction', tx.id, next_level, 'approved', approver, review_notes);
END;
$$;

CREATE OR REPLACE FUNCTION update_inspection_request(request_uuid uuid, request_data jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE inspection_requests
  SET request_number = COALESCE(request_data->>'request_number', request_number),
      activity_id = COALESCE((request_data->>'activity_id')::uuid, activity_id),
      boq_item_id = CASE WHEN request_data ? 'boq_item_id' THEN NULLIF(request_data->>'boq_item_id','')::uuid ELSE boq_item_id END,
      inspection_date = COALESCE((request_data->>'inspection_date')::date, inspection_date),
      inspected_quantity = COALESCE((request_data->>'inspected_quantity')::numeric, inspected_quantity),
      parent_reference = COALESCE(request_data->>'parent_reference', parent_reference),
      notes = COALESCE(request_data->>'notes', notes)
  WHERE id = request_uuid AND status IN ('draft','submitted');
  IF NOT FOUND THEN RAISE EXCEPTION 'Only draft or submitted inspection requests can be edited'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION recompute_resource_budget(target_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE budget_lines bl
  SET planned_cost = COALESCE((
    SELECT SUM(ar.planned_quantity * COALESCE(NULLIF(r.cost_rate, 0), NULLIF(r.rental_rate, 0), r.unit_rate))
    FROM activity_resources ar
    JOIN resources r ON r.id = ar.resource_id
    WHERE ar.project_id = target_project AND ar.activity_id = bl.activity_id
  ), bl.planned_cost),
  estimated_cost = COALESCE((
    SELECT SUM(ar.planned_quantity * COALESCE(NULLIF(r.cost_rate, 0), NULLIF(r.rental_rate, 0), r.unit_rate))
    FROM activity_resources ar
    JOIN resources r ON r.id = ar.resource_id
    WHERE ar.project_id = target_project AND ar.activity_id = bl.activity_id
  ), bl.estimated_cost, bl.planned_cost)
  WHERE bl.project_id = target_project AND bl.activity_id IS NOT NULL;
END;
$$;

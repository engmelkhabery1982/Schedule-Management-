-- =====================================================================================
-- Phase F2 · BOQ <-> Activity traceability (additive only, no redesign).
--
-- The BOQ planning engine decomposes BOQ items into template-driven activities
-- (many-to-many: one item can feed several activities, one activity can aggregate
-- several items). No current table stores that mapping with its cost/quantity shares:
-- budget_lines carries EITHER boq_item_id OR activity_id per cost-control row, and
-- wbs_nodes.boq_item_id is a single optional link, so per-activity cost provenance
-- ("which riyals of which BOQ item fund this activity, and by which rule") has no
-- destination. One mapping table closes the gap:
--
--   activity_boq_allocations
--      Why required: every riyal of BOQ planned cost must be traceable to the
--        activity/activities that consume it, without double counting, and every
--        generated activity must show its quantity/cost basis. The allocation row
--        records the pair, the shares, the rule that split them, and whether the row
--        was engine-generated (vs a future manual planning adjustment).
--      Source: derived at BOQ-plan build time from ParsedBoqRow amounts/quantities and
--        the planning template cost weights (never from rates, actuals, or guesses).
--      Downstream consumers: the BOQ reconciliation report (allocated vs unallocated
--        per item), the review-required gate that blocks baseline approval while any
--        BOQ amount is unallocated, and cost-variance readers that join activity cost
--        back to BOQ provenance.
--
-- Deliberately NOT added: provenance columns on activities/boq_items (the mapping row
-- plus budget_lines.budget_basis='boq_generated' already answer "why does this cost
-- exist"); a planning-warnings table (validation findings are recomputed
-- deterministically from the plan inputs on every preview, so persisting them would
-- create stale duplicates).
-- =====================================================================================

CREATE TABLE IF NOT EXISTS activity_boq_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  boq_item_id uuid NOT NULL REFERENCES boq_items(id) ON DELETE CASCADE,
  -- Share of the BOQ item's quantity consumed by this activity, in the BOQ item's own
  -- unit. NULL when the item maps to steps with incompatible units (composite split):
  -- a quantity share would be meaningless there, so only the cost share is recorded.
  quantity_share numeric(15,3),
  -- Share of the BOQ item's total_price consumed by this activity (SAR, cents-exact).
  cost_share numeric(15,2) NOT NULL DEFAULT 0,
  -- Rule that produced this row: 'single_step_full' | 'template_weight_split' |
  -- 'zero_intrinsic' (template-intrinsic step with no mapped cost).
  allocation_basis text NOT NULL DEFAULT 'single_step_full',
  -- True for engine-generated rows. Reserved for future manual planning adjustments.
  is_generated boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(activity_id, boq_item_id)
);

CREATE INDEX IF NOT EXISTS idx_alloc_project ON activity_boq_allocations(project_id);
CREATE INDEX IF NOT EXISTS idx_alloc_activity ON activity_boq_allocations(activity_id);
CREATE INDEX IF NOT EXISTS idx_alloc_boq ON activity_boq_allocations(boq_item_id);

COMMENT ON TABLE activity_boq_allocations IS
  'F2: many-to-many BOQ item <-> generated activity cost/quantity provenance. Every planned riyal traceable, no double counting.';

ALTER TABLE activity_boq_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_activity_boq_allocations" ON activity_boq_allocations;
CREATE POLICY "anon_crud_activity_boq_allocations" ON activity_boq_allocations FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

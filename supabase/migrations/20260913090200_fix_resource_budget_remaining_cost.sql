-- GAP-035 (Medium) — recompute_resource_budget() left remaining_cost stale.
--
-- PROBLEM
--   The procedure recomputed planned_cost and estimated_cost for activity-linked budget lines
--   from activity_resources x resources rates, but never touched remaining_cost. After a
--   recompute the row could show a remaining_cost derived from an older planned_cost, so
--   planned_cost - actual_cost <> remaining_cost even though the procedure had just rewritten
--   planned_cost.
--
-- INVARIANT NOW ENFORCED
--   remaining_cost = planned_cost - actual_cost
--   using the SAME final planned_cost value this procedure writes in the same statement, so the
--   three columns can never disagree after a recompute.
--
-- NULL HANDLING (deterministic, no silent surprises)
--   * A line whose activity has no activity_resources rows yields a NULL resource sum: the
--     previously stored planned_cost is kept (existing behaviour preserved) and remaining_cost
--     is still recomputed from it — it is no longer left stale.
--   * planned_cost and actual_cost are both nullable in the schema, so each is wrapped in
--     COALESCE(..., 0) for the remaining_cost arithmetic. A line with no budget basis at all
--     therefore yields remaining_cost = -actual_cost (a pure overrun) instead of NULL.
--   * estimated_cost keeps its exact previous expression, including the distinction between
--     "no resource data" (keep the stored estimate) and "resource data present" (overwrite it).
--     The raw resource sum is carried separately in the CTE so that distinction survives.
--
-- NEGATIVE remaining_cost IS ALLOWED ON PURPOSE (no clamping)
--   Evidence that the project model does not clamp:
--     * No CHECK constraint exists on budget_lines.remaining_cost anywhere in the schema.
--     * The application's own write path, BudgetView.saveActual(), stores
--       `remaining = line.planned_cost - editActual` with no Math.max(0, ...) — an overrun is
--       already persisted as a negative number by the UI.
--     * recompute_budget_line_actuals() likewise computes basis - actual with no floor.
--   A negative remaining_cost is therefore a real overrun signal, and MAX(..., 0) would hide
--   exactly the cost problem this column exists to surface. Reported inconsistency: the seed
--   row bgt-p3-01 carries remaining_cost 0 while actual_cost (24,320,000) exceeds planned_cost
--   (21,900,000); that hand-written seed value contradicts the model, is seed data rather than
--   schema, and is left untouched in this wave.
--
-- SCOPE NOTE
--   recompute_resource_budget() is currently not invoked by any trigger or by the application
--   (verified across migrations and src), so this correction changes no live behaviour today;
--   it removes a latent trap for the resource-driven budget path.

CREATE OR REPLACE FUNCTION recompute_resource_budget(target_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  WITH res AS (
    -- Resource-driven planned cost per activity-linked budget line. NULL when the activity has
    -- no resource assignments (SUM over zero rows), which the final CTE distinguishes from 0.
    SELECT
      bl.id AS budget_line_id,
      SUM(ar.planned_quantity * COALESCE(NULLIF(r.cost_rate, 0), NULLIF(r.rental_rate, 0), r.unit_rate))
        AS resource_planned_cost
    FROM budget_lines bl
    JOIN activity_resources ar
      ON ar.activity_id = bl.activity_id
     AND ar.project_id = bl.project_id
    JOIN resources r ON r.id = ar.resource_id
    WHERE bl.project_id = target_project
      AND bl.activity_id IS NOT NULL
    GROUP BY bl.id
  ),
  final AS (
    SELECT
      bl.id AS budget_line_id,
      res.resource_planned_cost AS raw_resource_cost,
      COALESCE(res.resource_planned_cost, bl.planned_cost) AS final_planned_cost
    FROM budget_lines bl
    LEFT JOIN res ON res.budget_line_id = bl.id
    WHERE bl.project_id = target_project
      AND bl.activity_id IS NOT NULL
  )
  UPDATE budget_lines bl
  SET planned_cost   = f.final_planned_cost,
      estimated_cost = COALESCE(f.raw_resource_cost, bl.estimated_cost, bl.planned_cost),
      remaining_cost = COALESCE(f.final_planned_cost, 0) - COALESCE(bl.actual_cost, 0)
  FROM final f
  WHERE bl.id = f.budget_line_id;
END;
$$;

-- PA-13 / PA-14 — unified remaining_cost basis + explicit cost allocation (cost-control wave).
--
-- PA-13 — ONE remaining_cost DEFINITION IN EVERY PATH
--   remaining_cost = COALESCE(approved_budget, planned_cost, 0) - COALESCE(actual_cost, 0)
--   * approved_budget present  -> it is the basis (verified case A).
--   * approved_budget NULL     -> planned_cost is the basis (verified case B).
--   * actual exceeds the basis -> remaining_cost goes NEGATIVE. A negative value is a real
--     overrun signal and is stored as-is; it is never clamped to zero (verified case C).
--   Applied here to recompute_budget_line_actuals() and recompute_resource_budget(). The
--   application write path BudgetView.saveActual() uses the same expression, and the seed row
--   bgt-p3-01 is corrected to -2,420,000 under the same rule (PA-16, in src/lib/mockSeed.ts).
--   NOTE: the previous recompute_budget_line_actuals() used COALESCE(approved_budget,
--   planned_cost) WITHOUT the trailing 0, so a line with neither basis produced a NULL
--   remaining_cost instead of -actual_cost. That NULL hole is closed here.
--
-- PA-14 — SHARED-WBS ALLOCATION: NO MORE "OLDEST LINE / LOWEST ID" TIE-BREAK
--   The previous function picked an arbitrary winner (created_at, then lowest id) when several
--   budget lines matched one transaction. That silent choice is removed. Allocation is now:
--     Rank 0: explicit ct.budget_line_id (new nullable FK, see below). ABSOLUTE priority: a
--             transaction that carries it matches ONLY that line (same project, enforced by the
--             JOIN) and never falls back to inference — not even when the id is dangling, in
--             which case the transaction stays unallocated instead of landing somewhere by
--             inference. Verified case D.
--     Rank 1: boq_item_id direct match.   Rank 2: explicit wbs_node_id match.
--     Rank 3: activity_id resolved through activities.wbs_node_id.
--   Legacy transactions (budget_line_id IS NULL) auto-allocate ONLY when exactly ONE budget
--   line matches at the winning (lowest) precedence rank. Unique match -> allocated
--   (verified case E). Ambiguous match (e.g. sibling lines sharing one WBS node) -> the
--   transaction contributes to NO line: it stays Unallocated / needs allocation, is never
--   spread and never double-counted (verified case F). Because each transaction yields at
--   most one allocation row, SUM(actual_cost) == SUM(amount of allocated approved tx).
--   Legacy rows keep budget_line_id NULL; the function resolves them at recompute time with
--   the unique-only rule, so no data rewrite / backfill is required. Write paths persist
--   budget_line_id whenever it is known at entry (BudgetView.addTransaction).
--
-- UNCHANGED ON PURPOSE
--   * Only status = 'approved' transactions with non-NULL amount are allocated, as before.
--   * The sync_budget_after_cost_change trigger resolves recompute_budget_line_actuals() by
--     name at call time, so it picks up the new body automatically (no trigger change).
--   * recompute_resource_budget() keeps its exact planned_cost / estimated_cost expressions;
--     only the remaining_cost basis is unified (approved_budget first, then the freshly
--     recomputed planned_cost, then 0).

-- PA-14: explicit allocation target. Nullable: NULL means "infer at recompute time with the
-- unique-only rule" (legacy behaviour for existing rows).
ALTER TABLE cost_transactions ADD COLUMN IF NOT EXISTS budget_line_id uuid REFERENCES budget_lines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cost_transactions_budget_line ON cost_transactions(budget_line_id);

CREATE OR REPLACE FUNCTION recompute_budget_line_actuals(target_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  WITH candidate AS (
    -- Every (transaction, budget line) pair that matches through ANY path, with the rank of
    -- the highest-precedence path that this specific pair satisfies.
    SELECT
      ct.id            AS tx_id,
      ct.amount        AS tx_amount,
      bl.id            AS budget_line_id,
      CASE
        -- Rank 0: explicit allocation. Absolute priority: when the transaction carries a
        -- budget_line_id it matches ONLY that line and never falls back to ranks 1-3.
        WHEN ct.budget_line_id IS NOT NULL THEN
          CASE WHEN bl.id = ct.budget_line_id THEN 0 ELSE NULL END
        WHEN ct.boq_item_id IS NOT NULL AND bl.boq_item_id IS NOT NULL
             AND ct.boq_item_id = bl.boq_item_id
          THEN 1
        WHEN ct.wbs_node_id IS NOT NULL AND bl.wbs_node_id IS NOT NULL
             AND ct.wbs_node_id = bl.wbs_node_id
          THEN 2
        WHEN ct.activity_id IS NOT NULL AND bl.wbs_node_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM activities a
               WHERE a.id = ct.activity_id
                 AND a.project_id = ct.project_id
                 AND a.wbs_node_id = bl.wbs_node_id
             )
          THEN 3
        ELSE NULL  -- this pair matches no allocation path
      END AS precedence_rank
    FROM cost_transactions ct
    JOIN budget_lines bl
      ON bl.project_id = ct.project_id
    WHERE ct.project_id = target_project
      AND ct.status = 'approved'
      AND ct.amount IS NOT NULL
  ),
  best_rank AS (
    -- The winning precedence rank per transaction (explicit 0 beats every inferred rank).
    SELECT c.tx_id, MIN(c.precedence_rank) AS min_rank
    FROM candidate c
    WHERE c.precedence_rank IS NOT NULL
    GROUP BY c.tx_id
  ),
  winners AS (
    -- Lines matching at the winning rank, with the contender count per transaction.
    SELECT c.tx_id, c.budget_line_id, c.tx_amount,
           COUNT(*) OVER (PARTITION BY c.tx_id) AS contender_count
    FROM candidate c
    JOIN best_rank b ON b.tx_id = c.tx_id AND b.min_rank = c.precedence_rank
  ),
  allocation AS (
    -- PA-14: allocate ONLY when the winner is unique. An explicit budget_line_id always
    -- yields exactly one candidate row, so it always allocates. Ambiguous legacy matches
    -- allocate to NO line: no arbitrary pick, no spreading, no double counting.
    SELECT w.tx_id, w.budget_line_id, w.tx_amount
    FROM winners w
    WHERE w.contender_count = 1
  ),
  totals AS (
    SELECT a.budget_line_id, SUM(a.tx_amount) AS allocated_actual
    FROM allocation a
    GROUP BY a.budget_line_id
  ),
  scope AS (
    -- PA-13 unified basis: approved_budget, else planned_cost, else 0.
    SELECT bl.id, COALESCE(bl.approved_budget, bl.planned_cost, 0) AS budget_basis
    FROM budget_lines bl
    WHERE bl.project_id = target_project
  )
  UPDATE budget_lines bl
  SET actual_cost    = COALESCE(t.allocated_actual, 0),
      remaining_cost = s.budget_basis - COALESCE(t.allocated_actual, 0)
  FROM scope s
  LEFT JOIN totals t ON t.budget_line_id = s.id
  WHERE bl.id = s.id;
END;
$$;

CREATE OR REPLACE FUNCTION recompute_resource_budget(target_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  WITH res AS (
    -- Resource-driven planned cost per activity-linked budget line. NULL when the activity has
    -- no resource assignments (SUM over zero rows), which the final CTE distinguishes from 0.
    -- (Expression unchanged; only the remaining_cost basis below is unified per PA-13.)
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
      -- PA-13 unified basis: approved_budget first, then the freshly recomputed planned_cost.
      -- Negative (overrun) is stored as-is, never clamped; NULL basis yields -actual.
      remaining_cost = COALESCE(bl.approved_budget, f.final_planned_cost, 0) - COALESCE(bl.actual_cost, 0)
  FROM final f
  WHERE bl.id = f.budget_line_id;
END;
$$;

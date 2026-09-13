-- GAP-032 (Critical) — cost allocation integrity for budget lines.
--
-- PROBLEM
--   The previous recompute_budget_line_actuals() matched a cost transaction to a budget line
--   with three non-exclusive OR conditions evaluated independently per budget line:
--
--     (ct.boq_item_id = bl.boq_item_id)
--     OR (ct.wbs_node_id = bl.wbs_node_id)
--     OR (ct.activity_id IN (SELECT a.id FROM activities a WHERE a.wbs_node_id = bl.wbs_node_id))
--
--   Because the predicate is evaluated once per budget line, a single transaction that carries
--   more than one reference (or whose activity sits in a WBS node shared by several budget
--   lines) was summed into EVERY line it matched. The same SAR was therefore counted two or
--   more times across the project's budget, inflating actual_cost and understating
--   remaining_cost.
--
--   This is reachable from the shipped UI and from the seed data, not only in theory:
--     * BudgetView.addTransaction()      -> inserts boq_item_id AND activity_id together.
--     * ProgressView subcontract posting -> inserts activity_id AND boq_item_id together.
--     * mockSeed project 1: budget lines bgt-p1-01 and bgt-p1-02 BOTH reference wbs node
--       wbs-p1-01, and activities act-01..act-04 all belong to wbs-p1-01. Transaction cst-01
--       (40,500 SAR, boq-01 + act-01) matched bgt-p1-01 through the BOQ path and matched
--       bgt-p1-02 through the activity->WBS path, so it was booked twice.
--
-- BUDGET LINE MODEL (inspected before designing the fix)
--   budget_lines has NO unique constraint on (project_id, boq_item_id) or
--   (project_id, wbs_node_id); the only index is the non-unique idx_budget_project. Multiple
--   budget lines may therefore legitimately share the same BOQ item or the same WBS node, and
--   the seed data already does. Uniqueness must NOT be assumed, so allocation needs an explicit
--   deterministic tie-break rather than a uniqueness constraint added after the fact.
--
-- FIX — ONE deterministic, exclusive allocation per transaction per recomputation pass
--   Precedence (most specific commercial reference first):
--     1. boq_item_id  direct match against bl.boq_item_id
--     2. else explicit wbs_node_id match against bl.wbs_node_id
--     3. else activity_id resolved through activities.wbs_node_id -> bl.wbs_node_id
--     4. else UNALLOCATED: the transaction contributes to no budget line. It is never spread
--        onto an arbitrary line, and it never disappears from cost_transactions itself.
--   Tie-break when several budget lines match at the SAME precedence rank (only possible
--   because sibling lines may share a WBS node): oldest budget line first (created_at ASC
--   NULLS LAST), then lowest budget_lines.id. This makes the result stable and repeatable —
--   the same inputs always produce the same allocation — while guaranteeing that a transaction
--   lands on exactly one line.
--
--   DISTINCT ON (transaction) enforces the invariant structurally: each approved transaction
--   yields at most one (transaction, budget line) allocation row, so
--   SUM(actual_cost over all lines) == SUM(amount over all allocatable approved transactions).
--
-- UNCHANGED ON PURPOSE
--   * remaining_cost keeps the existing basis COALESCE(approved_budget, planned_cost) - actual.
--     Changing that basis is a commercial decision, not an allocation fix. NOTE: this differs
--     from the planned_cost basis mandated for recompute_resource_budget() in
--     20260913090200_fix_resource_budget_remaining_cost.sql; the divergence is reported for a
--     later wave rather than silently harmonised here.
--   * Only status = 'approved' transactions are allocated, as before.
--   * The sync_budget_after_cost_change trigger is untouched; it resolves this function by name
--     at call time, so it picks up the new body automatically.

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
      bl.created_at    AS budget_line_created_at,
      CASE
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
  allocation AS (
    -- Exclusivity: one row per transaction, from the highest-precedence matching path only.
    SELECT DISTINCT ON (c.tx_id)
      c.tx_id,
      c.budget_line_id,
      c.tx_amount
    FROM candidate c
    WHERE c.precedence_rank IS NOT NULL
    ORDER BY
      c.tx_id,
      c.precedence_rank ASC,                 -- 1 boq, then 2 wbs, then 3 activity->wbs
      c.budget_line_created_at ASC NULLS LAST, -- deterministic sibling tie-break
      c.budget_line_id ASC                     -- final deterministic tie-break
  ),
  totals AS (
    SELECT a.budget_line_id, SUM(a.tx_amount) AS allocated_actual
    FROM allocation a
    GROUP BY a.budget_line_id
  ),
  scope AS (
    SELECT bl.id, COALESCE(bl.approved_budget, bl.planned_cost) AS budget_basis
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

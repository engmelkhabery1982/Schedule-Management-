-- PA-15 — activate recompute_resource_budget() for real (trigger wiring only).
--
-- CONTEXT
--   recompute_resource_budget() recomputes planned_cost (and the PA-13 remaining_cost basis)
--   for activity-linked budget lines from activity_resources x resources rates, but nothing
--   ever called it: no trigger referenced it and the application never invoked it, so
--   resource-driven lines silently kept stale planned_cost after assignments or rates changed.
--   This migration wires the two change sources to the function. The equation itself is NOT
--   touched here (PA-13 owns it): planned/estimated expressions and the unified
--   COALESCE(approved_budget, planned, 0) - COALESCE(actual, 0) basis are used exactly as
--   shipped by 20260914120000_fix_cost_control_remaining_and_allocation.sql.
--
-- TRIGGER 1 — activity_resources (assignments)
--   AFTER INSERT OR DELETE OR UPDATE OF (activity_id, resource_id, project_id,
--   planned_quantity) — i.e. every column the recompute reads. An update that touches only
--   actual_quantity (which the recompute never reads) does not fire, avoiding pointless
--   recomputes. AFTER timing: the recompute always sees the post-change assignment set.
--   Scoping: NEW.project_id on INSERT/UPDATE, OLD.project_id on DELETE (project_id is
--   NOT NULL on this table, so no fallback lookup is needed). An UPDATE that moves the row
--   across projects recomputes BOTH the old and the new project.
--
-- TRIGGER 2 — resources (rates)
--   AFTER UPDATE OF (cost_rate, rental_rate, unit_rate) — the exact three rate columns the
--   recompute reads via COALESCE(NULLIF(cost_rate,0), NULLIF(rental_rate,0), unit_rate).
--   Renames, type changes, availability edits, etc. never fire it. Inside, an
--   IS NOT DISTINCT FROM guard additionally skips no-op rewrites of identical values.
--   Scoping: recompute runs once per DISTINCT project_id found in activity_resources for
--   that resource_id — i.e. only the affected projects, never a full-table recompute.
--   A resource with zero assignments loops over zero rows and changes nothing.
--
-- LOOP FREEDOM (verified, not assumed)
--   * recompute_resource_budget() writes ONLY budget_lines (planned/estimated/remaining).
--   * No trigger exists ON budget_lines anywhere in supabase/migrations (audited: audit
--     triggers write audit_logs only; validate triggers are BEFORE + write nothing; the
--     sync_budget_after_cost_change trigger lives ON cost_transactions and likewise only
--     writes budget_lines). The dependency graph
--         activity_resources / resources  -->  budget_lines  -->  (nothing)
--     is therefore acyclic: firing trigger 1/2 can never cascade back onto its own table.
--   * The trigger functions themselves perform no writes to their own tables.
--   * AFTER ROW timing + one scoped PERFORM per affected project keeps every cascade to
--     exactly one recompute pass per touched project.
--
-- DELIBERATELY NOT DONE HERE
--   * No one-time backfill over existing rows: historical activity-linked lines recompute
--     on their next assignment/rate touch. A deploy-time full sweep would rewrite stored
--     planned_cost project-wide without a triggering business event.
--   * No trigger on budget_lines.actual_cost: actuals are owned by the cost-transaction
--     path (sync_budget_after_cost_change), and cross-linking the two recomputes would
--     create the very trigger cycle this file avoids.

CREATE OR REPLACE FUNCTION sync_resource_budget_after_assignment_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_resource_budget(OLD.project_id);
    RETURN OLD;
  END IF;
  PERFORM recompute_resource_budget(NEW.project_id);
  IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    -- The assignment moved across projects: the old project lost a cost driver too.
    PERFORM recompute_resource_budget(OLD.project_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_resource_budget_after_assignment_change ON activity_resources;
CREATE TRIGGER sync_resource_budget_after_assignment_change
AFTER INSERT OR DELETE OR UPDATE OF activity_id, resource_id, project_id, planned_quantity
ON activity_resources
FOR EACH ROW EXECUTE FUNCTION sync_resource_budget_after_assignment_change();

CREATE OR REPLACE FUNCTION sync_resource_budget_after_rate_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  affected_project uuid;
BEGIN
  -- Column-level trigger already limits firing to rate updates; this guard skips no-op
  -- rewrites (UPDATE that writes back identical rate values).
  IF OLD.cost_rate IS NOT DISTINCT FROM NEW.cost_rate
     AND OLD.rental_rate IS NOT DISTINCT FROM NEW.rental_rate
     AND OLD.unit_rate IS NOT DISTINCT FROM NEW.unit_rate THEN
    RETURN NEW;
  END IF;
  -- Only affected projects: each DISTINCT project using this resource, one scoped pass each.
  FOR affected_project IN
    SELECT DISTINCT ar.project_id
    FROM activity_resources ar
    WHERE ar.resource_id = NEW.id
  LOOP
    PERFORM recompute_resource_budget(affected_project);
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_resource_budget_after_rate_change ON resources;
CREATE TRIGGER sync_resource_budget_after_rate_change
AFTER UPDATE OF cost_rate, rental_rate, unit_rate
ON resources
FOR EACH ROW EXECUTE FUNCTION sync_resource_budget_after_rate_change();

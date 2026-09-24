-- Launch Batch 2C — persist verified demand evidence and atomically apply the approved preview.
--
-- TASKRSRC planned/remain quantities are totals, not a daily work profile. Do not divide them by
-- duration or otherwise invent a resource-use curve. Legacy/imported assignments remain NULL and
-- therefore produce N/A until a verified time-phased profile is supplied.
ALTER TABLE public.activity_resources
  ADD COLUMN IF NOT EXISTS daily_demand_profile jsonb;
ALTER TABLE public.activity_resources
  DROP CONSTRAINT IF EXISTS activity_resources_daily_demand_profile_array_check;
ALTER TABLE public.activity_resources
  ADD CONSTRAINT activity_resources_daily_demand_profile_array_check
  CHECK (daily_demand_profile IS NULL OR jsonb_typeof(daily_demand_profile) = 'array');
COMMENT ON COLUMN public.activity_resources.daily_demand_profile IS
  'Verified remaining resource units by activity working-day offset: [{"workday_offset":0,"units":1}]. NULL means unphased; resource leveling must report N/A, not infer a profile.';

-- The client performs analysis without writes, builds a statused scenario, and reruns canonical CPM.
-- This RPC checks that every evidence table and project control still matches the evaluation
-- snapshot, then persists all requested activity dates and the single canonical CPM result in one
-- PostgreSQL statement/transaction. Any stale input, malformed row, RLS error, trigger error, or
-- missing target raises and rolls back the whole transaction.
CREATE OR REPLACE FUNCTION public.apply_resource_leveling_scenario(
  p_project_id uuid,
  p_expected_activities jsonb,
  p_expected_links jsonb,
  p_expected_resources jsonb,
  p_expected_assignments jsonb,
  p_expected_calendars jsonb,
  p_expected_controls jsonb,
  p_activity_patches jsonb,
  p_cpm_results jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expected jsonb;
  v_actual jsonb;
  v_controls jsonb;
  v_patch jsonb;
  v_result jsonb;
  v_row_id uuid;
  v_rows bigint;
  v_count bigint;
  v_unique bigint;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'Resource-leveling Apply requires a project id';
  END IF;
  IF jsonb_typeof(p_expected_activities) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_expected_links) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_expected_resources) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_expected_assignments) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_expected_calendars) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_expected_controls) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_activity_patches) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_cpm_results) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Resource-leveling Apply payloads have an invalid shape';
  END IF;

  -- Lock the project's evidence rows before comparing the evaluation snapshot. This prevents an
  -- update/delete race between the stale-input check and the schedule writes.
  PERFORM id FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource-leveling Apply project does not exist';
  END IF;
  PERFORM id FROM public.activities WHERE project_id = p_project_id ORDER BY id FOR UPDATE;
  PERFORM id FROM public.activity_links WHERE project_id = p_project_id ORDER BY id FOR UPDATE;
  PERFORM id FROM public.resources WHERE project_id = p_project_id ORDER BY id FOR UPDATE;
  PERFORM id FROM public.activity_resources WHERE project_id = p_project_id ORDER BY id FOR UPDATE;
  PERFORM id FROM public.calendars WHERE project_id = p_project_id ORDER BY id FOR UPDATE;

  -- Compare full row snapshots, not only timestamps or selected fields. Sorting makes the JSON
  -- equality independent of query order while preserving every field used by schedule/resource logic.
  SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json->>'id'), '[]'::jsonb)
  INTO v_actual
  FROM (SELECT to_jsonb(a) AS row_json FROM public.activities a WHERE a.project_id = p_project_id) AS snapshot_rows;
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'id'), '[]'::jsonb)
  INTO v_expected
  FROM jsonb_array_elements(p_expected_activities) AS items(item);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Resource-leveling inputs changed in activities; analyze again before Apply';
  END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json->>'id'), '[]'::jsonb)
  INTO v_actual
  FROM (SELECT to_jsonb(l) AS row_json FROM public.activity_links l WHERE l.project_id = p_project_id) AS snapshot_rows;
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'id'), '[]'::jsonb)
  INTO v_expected
  FROM jsonb_array_elements(p_expected_links) AS items(item);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Resource-leveling inputs changed in activity_links; analyze again before Apply';
  END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json->>'id'), '[]'::jsonb)
  INTO v_actual
  FROM (SELECT to_jsonb(r) AS row_json FROM public.resources r WHERE r.project_id = p_project_id) AS snapshot_rows;
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'id'), '[]'::jsonb)
  INTO v_expected
  FROM jsonb_array_elements(p_expected_resources) AS items(item);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Resource-leveling inputs changed in resources; analyze again before Apply';
  END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json->>'id'), '[]'::jsonb)
  INTO v_actual
  FROM (SELECT to_jsonb(ar) AS row_json FROM public.activity_resources ar WHERE ar.project_id = p_project_id) AS snapshot_rows;
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'id'), '[]'::jsonb)
  INTO v_expected
  FROM jsonb_array_elements(p_expected_assignments) AS items(item);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Resource-leveling inputs changed in activity_resources; analyze again before Apply';
  END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json->>'id'), '[]'::jsonb)
  INTO v_actual
  FROM (SELECT to_jsonb(c) AS row_json FROM public.calendars c WHERE c.project_id = p_project_id) AS snapshot_rows;
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'id'), '[]'::jsonb)
  INTO v_expected
  FROM jsonb_array_elements(p_expected_calendars) AS items(item);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Resource-leveling inputs changed in calendars; analyze again before Apply';
  END IF;

  SELECT jsonb_build_object(
    'calendar_type', p.calendar_type,
    'data_date', p.data_date,
    'status_logic', p.status_logic
  ) INTO v_controls
  FROM public.projects p WHERE p.id = p_project_id;
  IF v_controls IS DISTINCT FROM p_expected_controls THEN
    RAISE EXCEPTION 'Project schedule controls changed; analyze again before Apply';
  END IF;

  -- Snapshot rows must all be scoped to this project; never allow a caller to smuggle foreign data.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_expected_activities) AS item(value)
    WHERE value->>'project_id' IS DISTINCT FROM p_project_id::text
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_expected_links) AS item(value)
    WHERE value->>'project_id' IS DISTINCT FROM p_project_id::text
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_expected_resources) AS item(value)
    WHERE value->>'project_id' IS DISTINCT FROM p_project_id::text
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_expected_assignments) AS item(value)
    WHERE value->>'project_id' IS DISTINCT FROM p_project_id::text
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_expected_calendars) AS item(value)
    WHERE value->>'project_id' IS DISTINCT FROM p_project_id::text
  ) THEN
    RAISE EXCEPTION 'Resource-leveling snapshot crosses project boundary';
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.activities WHERE project_id = p_project_id;
  IF v_count = 0 OR jsonb_array_length(p_cpm_results) <> v_count THEN
    RAISE EXCEPTION 'Canonical CPM result must cover every project activity';
  END IF;
  SELECT COUNT(DISTINCT item->>'activity_id') INTO v_unique
  FROM jsonb_array_elements(p_cpm_results) AS items(item);
  IF v_unique <> jsonb_array_length(p_cpm_results) THEN
    RAISE EXCEPTION 'Canonical CPM result contains duplicate or missing activity ids';
  END IF;
  IF jsonb_array_length(p_activity_patches) = 0 THEN
    RAISE EXCEPTION 'Resource-leveling Apply requires at least one evaluated date shift';
  END IF;
  SELECT COUNT(DISTINCT item->>'activity_id') INTO v_unique
  FROM jsonb_array_elements(p_activity_patches) AS items(item);
  IF v_unique <> jsonb_array_length(p_activity_patches) THEN
    RAISE EXCEPTION 'Resource-leveling Apply contains duplicate or missing activity patch ids';
  END IF;

  -- Date patches are restricted to the evaluated CPM start date. Actual/progress fields are never
  -- written and activities with actual/completed work may not be shifted.
  FOR v_patch IN SELECT value FROM jsonb_array_elements(p_activity_patches) AS patches(value) LOOP
    IF jsonb_typeof(v_patch) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_patch->'activity_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_patch->'early_start') IS DISTINCT FROM 'string'
      OR (v_patch->>'early_start') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid resource-leveling activity patch';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_cpm_results) AS results(value)
      WHERE value->>'activity_id' = v_patch->>'activity_id'
        AND value->>'early_start' = v_patch->>'early_start'
    ) THEN
      RAISE EXCEPTION 'Resource-leveling activity patch does not match canonical CPM result';
    END IF;

    v_row_id := (v_patch->>'activity_id')::uuid;
    IF EXISTS (
      SELECT 1 FROM public.activities a
      WHERE a.id = v_row_id AND a.project_id = p_project_id
        AND (a.actual_start IS NOT NULL OR a.actual_finish IS NOT NULL
          OR COALESCE(a.percent_complete, 0) > 0 OR COALESCE(a.actual_quantity, 0) > 0
          OR EXISTS (
            SELECT 1 FROM public.activity_resources ar
            WHERE ar.project_id = p_project_id AND ar.activity_id = v_row_id
              AND COALESCE(ar.actual_quantity, 0) > 0
          ))
    ) THEN
      RAISE EXCEPTION 'Resource-leveling cannot shift activity % with actual/completed work', v_row_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.activities WHERE id = v_row_id AND project_id = p_project_id) THEN
      RAISE EXCEPTION 'Resource-leveling activity % was not found in the requested project', v_row_id;
    END IF;
  END LOOP;

  -- Save the full canonical CPM result for the exact scenario. Any failure aborts this transaction.
  FOR v_result IN SELECT value FROM jsonb_array_elements(p_cpm_results) AS results(value) LOOP
    IF jsonb_typeof(v_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_result->'activity_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'early_start') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'early_finish') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'late_start') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'late_finish') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'total_float') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_result->'free_float') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_result->'is_critical') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(v_result->'activity_drag') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid canonical CPM resource-leveling result';
    END IF;

    v_row_id := (v_result->>'activity_id')::uuid;
    UPDATE public.activities
    SET early_start = (v_result->>'early_start')::date,
        early_finish = (v_result->>'early_finish')::date,
        late_start = (v_result->>'late_start')::date,
        late_finish = (v_result->>'late_finish')::date,
        total_float = (v_result->>'total_float')::numeric,
        free_float = (v_result->>'free_float')::numeric,
        is_critical = (v_result->>'is_critical')::boolean,
        activity_drag = (v_result->>'activity_drag')::numeric
    WHERE id = v_row_id AND project_id = p_project_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Canonical CPM resource-leveling result for activity % was not saved', v_row_id;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_resource_leveling_scenario(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_resource_leveling_scenario(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) TO anon, authenticated;

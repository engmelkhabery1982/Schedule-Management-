-- Launch Batch 2A — commit an evaluated recovery scenario and its CPM output atomically.
--
-- Supabase invokes this function as one PostgreSQL statement/transaction. Any validation error,
-- constraint/RLS error, trigger error, or missing-row check raises an exception and rolls back
-- every recovery-assumption and CPM update made by this invocation.
-- `activity_drag` is part of the already-calculated result persisted by ScheduleRecoveryView but
-- was only declared in the application model; add it nullable so this atomic writer works on a
-- database created solely from repository migrations without fabricating historical values.
ALTER TABLE public.activities ADD COLUMN IF NOT EXISTS activity_drag numeric(15,2);

CREATE OR REPLACE FUNCTION public.apply_schedule_recovery_scenario(
  p_project_id uuid,
  p_activity_patches jsonb,
  p_link_patches jsonb,
  p_cpm_results jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_patch jsonb;
  v_values jsonb;
  v_result jsonb;
  v_row_id uuid;
  v_rows bigint;
  v_expected_cpm_rows bigint;
  v_unique_rows bigint;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'Recovery Apply requires a project id';
  END IF;
  IF jsonb_typeof(p_activity_patches) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_link_patches) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_cpm_results) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Recovery Apply payloads must be JSON arrays';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Recovery Apply project does not exist';
  END IF;

  -- Reject duplicate targets so the transaction cannot apply ambiguous competing patches.
  SELECT COUNT(DISTINCT item->>'id') INTO v_unique_rows
  FROM jsonb_array_elements(p_activity_patches) AS items(item);
  IF v_unique_rows <> jsonb_array_length(p_activity_patches) THEN
    RAISE EXCEPTION 'Recovery Apply contains duplicate or missing activity patch ids';
  END IF;

  SELECT COUNT(DISTINCT item->>'id') INTO v_unique_rows
  FROM jsonb_array_elements(p_link_patches) AS items(item);
  IF v_unique_rows <> jsonb_array_length(p_link_patches) THEN
    RAISE EXCEPTION 'Recovery Apply contains duplicate or missing link patch ids';
  END IF;

  SELECT COUNT(*) INTO v_expected_cpm_rows
  FROM public.activities
  WHERE project_id = p_project_id;
  IF jsonb_array_length(p_cpm_results) <> v_expected_cpm_rows THEN
    RAISE EXCEPTION 'Recovery Apply CPM result must cover every project activity';
  END IF;
  SELECT COUNT(DISTINCT item->>'activityId') INTO v_unique_rows
  FROM jsonb_array_elements(p_cpm_results) AS items(item);
  IF v_unique_rows <> jsonb_array_length(p_cpm_results) THEN
    RAISE EXCEPTION 'Recovery Apply CPM result contains duplicate or missing activity ids';
  END IF;

  -- Duration assumptions are deliberately whitelisted; an unexpected field aborts the entire RPC.
  FOR v_patch IN SELECT value FROM jsonb_array_elements(p_activity_patches) AS patches(value) LOOP
    IF jsonb_typeof(v_patch) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_patch->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_patch->'values') IS DISTINCT FROM 'object'
      OR v_patch->'values' = '{}'::jsonb THEN
      RAISE EXCEPTION 'Invalid recovery activity patch';
    END IF;

    v_values := v_patch->'values';
    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_values) AS keys(key)
      WHERE key NOT IN ('duration_days', 'remaining_duration_days')
    ) THEN
      RAISE EXCEPTION 'Recovery activity patch contains a non-recovery field';
    END IF;

    IF v_values ? 'duration_days' THEN
      IF jsonb_typeof(v_values->'duration_days') IS DISTINCT FROM 'number'
        OR (v_values->>'duration_days') !~ '^[0-9]+$'
        OR (v_values->>'duration_days')::integer < 1 THEN
        RAISE EXCEPTION 'Recovery duration_days must be a positive whole number';
      END IF;
    END IF;
    IF v_values ? 'remaining_duration_days' THEN
      IF jsonb_typeof(v_values->'remaining_duration_days') IS DISTINCT FROM 'number'
        OR (v_values->>'remaining_duration_days') !~ '^[0-9]+$'
        OR (v_values->>'remaining_duration_days')::integer < 1 THEN
        RAISE EXCEPTION 'Recovery remaining_duration_days must be a positive whole number';
      END IF;
    END IF;

    v_row_id := (v_patch->>'id')::uuid;
    UPDATE public.activities
    SET duration_days = CASE
          WHEN v_values ? 'duration_days' THEN (v_values->>'duration_days')::integer
          ELSE duration_days
        END,
        remaining_duration_days = CASE
          WHEN v_values ? 'remaining_duration_days' THEN (v_values->>'remaining_duration_days')::integer
          ELSE remaining_duration_days
        END
    WHERE id = v_row_id AND project_id = p_project_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Recovery activity % was not updated in the requested project', v_row_id;
    END IF;
  END LOOP;

  -- Fast-tracking currently changes only the selected FS relationship to SS; lag is untouched.
  FOR v_patch IN SELECT value FROM jsonb_array_elements(p_link_patches) AS patches(value) LOOP
    IF jsonb_typeof(v_patch) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_patch->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_patch->'values') IS DISTINCT FROM 'object'
      OR v_patch->'values' = '{}'::jsonb THEN
      RAISE EXCEPTION 'Invalid recovery link patch';
    END IF;

    v_values := v_patch->'values';
    IF (SELECT COUNT(*) FROM jsonb_object_keys(v_values)) <> 1
      OR jsonb_typeof(v_values->'link_type') IS DISTINCT FROM 'string'
      OR v_values->>'link_type' <> 'SS' THEN
      RAISE EXCEPTION 'Recovery link patch must contain only the FS-to-SS relationship change';
    END IF;

    v_row_id := (v_patch->>'id')::uuid;
    UPDATE public.activity_links
    SET link_type = v_values->>'link_type'
    WHERE id = v_row_id AND project_id = p_project_id AND upper(link_type) = 'FS';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Recovery link % was not an FS link in the requested project', v_row_id;
    END IF;
  END LOOP;

  -- Persist the one canonical CPM calculation supplied for the exact evaluated scenario.
  FOR v_result IN SELECT value FROM jsonb_array_elements(p_cpm_results) AS results(value) LOOP
    IF jsonb_typeof(v_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_result->'activityId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'earlyStart') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'earlyFinish') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'lateStart') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'lateFinish') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_result->'totalFloat') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_result->'freeFloat') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_result->'isCritical') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(v_result->'activityDrag') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid canonical CPM recovery result';
    END IF;

    v_row_id := (v_result->>'activityId')::uuid;
    UPDATE public.activities
    SET early_start = (v_result->>'earlyStart')::date,
        early_finish = (v_result->>'earlyFinish')::date,
        late_start = (v_result->>'lateStart')::date,
        late_finish = (v_result->>'lateFinish')::date,
        total_float = (v_result->>'totalFloat')::numeric,
        free_float = (v_result->>'freeFloat')::numeric,
        is_critical = (v_result->>'isCritical')::boolean,
        activity_drag = (v_result->>'activityDrag')::numeric
    WHERE id = v_row_id AND project_id = p_project_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'CPM recovery result for activity % was not saved in the requested project', v_row_id;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_schedule_recovery_scenario(uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_schedule_recovery_scenario(uuid, jsonb, jsonb, jsonb) TO anon, authenticated;

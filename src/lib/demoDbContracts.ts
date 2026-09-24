/**
 * F9.4 (Controlled Pilot defect 2) — the demo database's stored-procedure contracts.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * This app runs against a real Supabase schema when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
 * are configured, and against an in-memory + LocalStorage demo store otherwise (see
 * `src/lib/supabase.ts`). The Controlled Pilot ran in demo mode, and pressing Approve on the
 * "Controlled Pilot cost transaction — 100 SAR" row did nothing at all: the badge stayed Pending,
 * no error appeared, and a reload showed the same row unchanged.
 *
 * The cause was not in the button. `approveTransaction` correctly calls
 * `supabase.rpc('review_cost_transaction', …)` and correctly gates on the returned `{ error }`. But
 * the demo store's `mockRpc` implemented exactly one function — `approve_progress_update` — and for
 * EVERY other name it fell through to `return { data: true, error: null }` without touching the
 * store. An unimplemented write therefore reported success: the handler saw no error, showed no
 * message, called `loadData()`, and re-read the row it had never changed.
 *
 * So the contracts live here as pure functions over a plain object store, mirroring the SQL in
 * `supabase/migrations/` statement for statement:
 *
 *   - the demo store can no longer claim a write succeeded that it did not perform;
 *   - an unimplemented function name is an explicit error naming the function, never a false
 *     success (see `unimplementedRpcError`);
 *   - the contract is unit-testable headlessly (S17-B) without a browser, LocalStorage or Supabase.
 *
 * NO MIGRATION IS REQUIRED for this defect. `review_cost_transaction` already exists in
 * `20260908004500_governed_reviews_and_resources.sql` and is correct; the schema already carries
 * `status`, `approved_at`, `approved_by`, `rejected_reason` and `approval_level`. The defect was
 * entirely the demo store's failure to honour that contract. Nothing here renames a column or
 * alters a table.
 *
 * THE CONTRACT BEING MIRRORED (20260908004500_governed_reviews_and_resources.sql)
 * ------------------------------------------------------------------------------
 *   review_cost_transaction(transaction_uuid, approver='operator', decision='approve',
 *                           review_notes=NULL) RETURNS void
 *     SELECT * INTO tx FROM cost_transactions WHERE id = transaction_uuid FOR UPDATE;
 *     IF NOT FOUND OR tx.status <> 'submitted'
 *        THEN RAISE EXCEPTION 'Only submitted cost transactions can be reviewed';
 *     IF decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Invalid review decision';
 *     reject  -> status='rejected', rejected_reason=review_notes
 *                + approval_events(approval_level = tx.approval_level + 1, action='rejected')
 *     approve -> next_level = tx.approval_level + 1
 *                next_level >= 2 -> status='approved', approval_level=2,
 *                                   approved_at=now(), approved_by=approver
 *                otherwise       -> approval_level=next_level   (status stays 'submitted')
 *                + approval_events(approval_level = next_level, action='approved')
 *
 * Note the two-level gate: it is the database's segregation-of-duties rule, not a bug, so it is
 * reproduced faithfully here. A transaction entering at `approval_level` 0 needs two approvals to
 * reach `approved`. Because the pilot UI showed only the status badge, a legitimate level advance
 * was indistinguishable from nothing happening — which is why the caller now surfaces the level and
 * the outcome of every press instead of staying silent.
 */

/**
 * A cost-transaction row as the demo store holds it.
 *
 * The declared fields are exactly the columns the `review_cost_transaction` contract reads and
 * writes (`20260907220000_add_planning_control_schema.sql` adds `status`, `approved_at`,
 * `approved_by`, `rejected_reason`; `20260908004500_governed_reviews_and_resources.sql` adds
 * `approval_level`). Everything else on the row passes through untouched via the index signature,
 * so this contract never has to model the whole table — and never reaches for `any`.
 */
export interface DemoCostTransactionRow {
  id?: unknown;
  project_id?: unknown;
  status?: unknown;
  approval_level?: unknown;
  approved_at?: unknown;
  approved_by?: unknown;
  rejected_reason?: unknown;
  [key: string]: unknown;
}

/** Shape of the demo store: table name -> rows. Mirrors `DbState` in `src/lib/supabase.ts`. */
export type DemoDb = Record<string, Record<string, unknown>[]>;

/** Shape of a supabase-js RPC result the UI already knows how to gate on. */
export interface DemoRpcResult {
  data: unknown;
  error: { message: string; details?: string; hint?: string } | null;
}

/** Parameters of the `review_cost_transaction` RPC, with the SQL defaults applied. */
export interface ReviewCostTransactionParams {
  transaction_uuid?: string | null;
  approver?: string | null;
  decision?: string | null;
  review_notes?: string | null;
}

/** Parameters of the one-statement recovery RPC mirrored by the demo store. */
export interface AtomicScheduleRecoveryParams {
  p_project_id?: unknown;
  p_activity_patches?: unknown;
  p_link_patches?: unknown;
  p_cpm_results?: unknown;
}

/** Parameters of the stale-input-guarded resource-leveling transaction. */
export interface AtomicResourceLevelingParams {
  p_project_id?: unknown;
  p_expected_activities?: unknown;
  p_expected_links?: unknown;
  p_expected_resources?: unknown;
  p_expected_assignments?: unknown;
  p_expected_calendars?: unknown;
  p_expected_controls?: unknown;
  p_activity_patches?: unknown;
  p_cpm_results?: unknown;
}

/** `approval_level` is `NOT NULL DEFAULT 0` in the schema; a demo row may simply omit it. */
function approvalLevelOf(row: { approval_level?: unknown } | null | undefined): number {
  const raw = Number(row?.approval_level ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Error for an RPC the demo store does not implement.
 *
 * This is the specific failure mode that made the pilot defect invisible: returning
 * `{ data: true, error: null }` for an unknown function tells the caller the write succeeded. The
 * message names the function so the failed database step is identifiable from the UI alone.
 */
export function unimplementedRpcError(fnName: string): DemoRpcResult {
  return {
    data: null,
    error: {
      message: `Demo database cannot execute RPC "${fnName}": no local contract is implemented for it.`,
      details:
        'The write was NOT performed. Implement this function in src/lib/demoDbContracts.ts '
        + '(mirroring its SQL migration) or configure a real Supabase connection.',
      hint: `rpc:${fnName}`,
    },
  };
}

/**
 * Atomic local-store mirror of `apply_schedule_recovery_scenario`.
 *
 * All assumption patches, link patches, and canonical CPM result fields are applied to private row
 * clones first. The live demo store is replaced only after the final CPM row validates, so any
 * mid-Apply failure leaves its activities and links byte-for-byte unchanged just like the SQL RPC.
 */
export function applyScheduleRecoveryScenario(
  db: DemoDb,
  params: AtomicScheduleRecoveryParams,
): DemoRpcResult {
  const projectId = params?.p_project_id;
  const activityPatches = params?.p_activity_patches;
  const linkPatches = params?.p_link_patches;
  const cpmResults = params?.p_cpm_results;
  const fail = (message: string, hint: string): DemoRpcResult => ({
    data: null,
    error: { message, details: 'No part of this recovery Apply was committed.', hint },
  });
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const uniqueStringIds = (rows: unknown[], field: string): boolean => {
    const ids = rows.map((row) => isRecord(row) ? row[field] : null);
    return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length;
  };
  const isPositiveWholeNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;
  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const isDate = (value: unknown): value is string =>
    typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

  if (typeof projectId !== 'string' || !projectId) return fail('Recovery Apply requires a project id', 'rpc:recovery:project_id');
  if (!Array.isArray(activityPatches) || !Array.isArray(linkPatches) || !Array.isArray(cpmResults)) {
    return fail('Recovery Apply payloads must be arrays', 'rpc:recovery:payload_shape');
  }
  if (!(db['projects'] || []).some((project) => String(project.id) === projectId)) {
    return fail('Recovery Apply project does not exist', 'rpc:recovery:project_missing');
  }
  if (!uniqueStringIds(activityPatches, 'id')) return fail('Recovery Apply has duplicate or missing activity patch ids', 'rpc:recovery:activity_ids');
  if (!uniqueStringIds(linkPatches, 'id')) return fail('Recovery Apply has duplicate or missing link patch ids', 'rpc:recovery:link_ids');

  const liveActivities = db['activities'] || [];
  const liveLinks = db['activity_links'] || [];
  const projectActivityCount = liveActivities.filter((activity) => String(activity.project_id) === projectId).length;
  if (cpmResults.length !== projectActivityCount || !uniqueStringIds(cpmResults, 'activityId')) {
    return fail('Recovery Apply CPM result must uniquely cover every project activity', 'rpc:recovery:cpm_coverage');
  }

  // These clones are the in-memory transaction workspace. Nothing above or below mutates `db` until
  // every recovery assumption, relationship and CPM field has passed validation.
  const stagedActivities = liveActivities.map((activity) => ({ ...activity }));
  const stagedLinks = liveLinks.map((link) => ({ ...link }));

  for (const rawPatch of activityPatches) {
    if (!isRecord(rawPatch) || typeof rawPatch.id !== 'string' || !isRecord(rawPatch.values)) {
      return fail('Invalid recovery activity patch', 'rpc:recovery:activity_patch');
    }
    const values = rawPatch.values;
    const keys = Object.keys(values);
    if (keys.length === 0 || keys.some((key) => key !== 'duration_days' && key !== 'remaining_duration_days')) {
      return fail('Recovery activity patch contains unsupported fields', 'rpc:recovery:activity_fields');
    }
    if ('duration_days' in values && !isPositiveWholeNumber(values.duration_days)) {
      return fail('Recovery duration_days must be a positive whole number', 'rpc:recovery:duration');
    }
    if ('remaining_duration_days' in values && !isPositiveWholeNumber(values.remaining_duration_days)) {
      return fail('Recovery remaining_duration_days must be a positive whole number', 'rpc:recovery:remaining_duration');
    }
    const index = stagedActivities.findIndex((activity) =>
      String(activity.id) === rawPatch.id && String(activity.project_id) === projectId,
    );
    if (index < 0) return fail(`Recovery activity ${rawPatch.id} was not found in the project`, 'rpc:recovery:activity_missing');
    stagedActivities[index] = { ...stagedActivities[index], ...values };
  }

  for (const rawPatch of linkPatches) {
    if (!isRecord(rawPatch) || typeof rawPatch.id !== 'string' || !isRecord(rawPatch.values)) {
      return fail('Invalid recovery link patch', 'rpc:recovery:link_patch');
    }
    const values = rawPatch.values;
    if (Object.keys(values).length !== 1 || values.link_type !== 'SS') {
      return fail('Recovery link patch must contain only the FS-to-SS relationship change', 'rpc:recovery:link_fields');
    }
    const index = stagedLinks.findIndex((link) =>
      String(link.id) === rawPatch.id && String(link.project_id) === projectId,
    );
    if (index < 0) return fail(`Recovery link ${rawPatch.id} was not found in the project`, 'rpc:recovery:link_missing');
    if (String(stagedLinks[index].link_type).toUpperCase() !== 'FS') {
      return fail(`Recovery link ${rawPatch.id} is no longer an FS link`, 'rpc:recovery:link_not_fs');
    }
    stagedLinks[index] = { ...stagedLinks[index], ...values };
  }

  // Validate and stage results one row at a time. A malformed later result deliberately exercises
  // the same rollback boundary as a database error after earlier activity/link/CPM writes.
  for (const rawResult of cpmResults) {
    if (
      !isRecord(rawResult)
      || typeof rawResult.activityId !== 'string'
      || !isDate(rawResult.earlyStart)
      || !isDate(rawResult.earlyFinish)
      || !isDate(rawResult.lateStart)
      || !isDate(rawResult.lateFinish)
      || !isFiniteNumber(rawResult.totalFloat)
      || !isFiniteNumber(rawResult.freeFloat)
      || typeof rawResult.isCritical !== 'boolean'
      || !isFiniteNumber(rawResult.activityDrag)
    ) return fail('Invalid canonical CPM recovery result', 'rpc:recovery:cpm_result');

    const index = stagedActivities.findIndex((activity) =>
      String(activity.id) === rawResult.activityId && String(activity.project_id) === projectId,
    );
    if (index < 0) return fail(`CPM recovery result for activity ${rawResult.activityId} was not found`, 'rpc:recovery:cpm_activity_missing');
    stagedActivities[index] = {
      ...stagedActivities[index],
      early_start: rawResult.earlyStart,
      early_finish: rawResult.earlyFinish,
      late_start: rawResult.lateStart,
      late_finish: rawResult.lateFinish,
      total_float: rawResult.totalFloat,
      free_float: rawResult.freeFloat,
      is_critical: rawResult.isCritical,
      activity_drag: rawResult.activityDrag,
    };
  }

  db['activities'] = stagedActivities;
  db['activity_links'] = stagedLinks;
  return { data: null, error: null };
}

/**
 * Atomic demo-store mirror of `apply_resource_leveling_scenario`.
 *
 * The input snapshots are compared before staging any writes, then all activity changes are applied
 * to private clones. A failed/stale request leaves the live store untouched, matching the single
 * PostgreSQL transaction used by the production RPC.
 */
export function applyResourceLevelingScenario(
  db: DemoDb,
  params: AtomicResourceLevelingParams,
): DemoRpcResult {
  const projectId = params?.p_project_id;
  const expectedActivities = params?.p_expected_activities;
  const expectedLinks = params?.p_expected_links;
  const expectedResources = params?.p_expected_resources;
  const expectedAssignments = params?.p_expected_assignments;
  const expectedCalendars = params?.p_expected_calendars;
  const expectedControls = params?.p_expected_controls;
  const patches = params?.p_activity_patches;
  const cpmResults = params?.p_cpm_results;
  const fail = (message: string, hint: string): DemoRpcResult => ({
    data: null,
    error: { message, details: 'No part of this resource-leveling Apply was committed.', hint },
  });
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const isDate = (value: unknown): value is string =>
    typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
  const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const uniqueIds = (rows: unknown[], field: string): boolean => {
    const ids = rows.map((row) => isRecord(row) ? row[field] : null);
    return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length;
  };
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  };
  const rowSet = (rows: unknown[]): string => JSON.stringify(
    rows.map((row) => stable(row)).sort((a, b) => {
      const aId = isRecord(a) ? String(a.id ?? '') : '';
      const bId = isRecord(b) ? String(b.id ?? '') : '';
      return aId.localeCompare(bId);
    }),
  );

  if (typeof projectId !== 'string' || !projectId) return fail('Resource-leveling Apply requires a project id', 'rpc:resource_leveling:project_id');
  const payloadArrays = [expectedActivities, expectedLinks, expectedResources, expectedAssignments, expectedCalendars, patches, cpmResults];
  if (!payloadArrays.every(Array.isArray) || !isRecord(expectedControls)) {
    return fail('Resource-leveling Apply payloads have an invalid shape', 'rpc:resource_leveling:payload_shape');
  }
  const project = (db['projects'] || []).find((row) => String(row.id) === projectId);
  if (!project) return fail('Resource-leveling Apply project does not exist', 'rpc:resource_leveling:project_missing');

  const tableSnapshots: Array<[string, unknown[]]> = [
    ['activities', expectedActivities as unknown[]],
    ['activity_links', expectedLinks as unknown[]],
    ['resources', expectedResources as unknown[]],
    ['activity_resources', expectedAssignments as unknown[]],
    ['calendars', expectedCalendars as unknown[]],
  ];
  for (const [table, expected] of tableSnapshots) {
    const actual = (db[table] || []).filter((row) => String(row.project_id) === projectId);
    if (rowSet(actual) !== rowSet(expected)) {
      return fail(`Resource-leveling inputs changed in ${table}; analyze again before Apply`, `rpc:resource_leveling:stale:${table}`);
    }
    if (expected.some((row) => !isRecord(row) || String(row.project_id) !== projectId)) {
      return fail(`Resource-leveling snapshot crosses project boundary in ${table}`, `rpc:resource_leveling:project_scope:${table}`);
    }
  }
  const actualControls = {
    calendar_type: project.calendar_type ?? null,
    data_date: project.data_date ?? null,
    status_logic: project.status_logic ?? null,
  };
  if (JSON.stringify(stable(actualControls)) !== JSON.stringify(stable(expectedControls))) {
    return fail('Project schedule controls changed; analyze again before Apply', 'rpc:resource_leveling:stale:controls');
  }

  const liveActivities = db['activities'] || [];
  const projectActivities = liveActivities.filter((row) => String(row.project_id) === projectId);
  if (!uniqueIds(patches as unknown[], 'activity_id') || (patches as unknown[]).length === 0) {
    return fail('Resource-leveling Apply requires unique shifted activity ids', 'rpc:resource_leveling:patch_ids');
  }
  if ((cpmResults as unknown[]).length !== projectActivities.length || !uniqueIds(cpmResults as unknown[], 'activity_id')) {
    return fail('Canonical CPM result must uniquely cover every project activity', 'rpc:resource_leveling:cpm_coverage');
  }
  const cpmByActivity = new Map<string, Record<string, unknown>>();
  for (const rawResult of cpmResults as unknown[]) {
    if (
      !isRecord(rawResult)
      || typeof rawResult.activity_id !== 'string'
      || !isDate(rawResult.early_start)
      || !isDate(rawResult.early_finish)
      || !isDate(rawResult.late_start)
      || !isDate(rawResult.late_finish)
      || !isFiniteNumber(rawResult.total_float)
      || !isFiniteNumber(rawResult.free_float)
      || typeof rawResult.is_critical !== 'boolean'
      || !isFiniteNumber(rawResult.activity_drag)
    ) return fail('Invalid canonical CPM result in resource-leveling payload', 'rpc:resource_leveling:cpm_result');
    cpmByActivity.set(rawResult.activity_id, rawResult);
  }

  for (const rawPatch of patches as unknown[]) {
    if (!isRecord(rawPatch) || typeof rawPatch.activity_id !== 'string' || !isDate(rawPatch.early_start)) {
      return fail('Invalid resource-leveling activity patch', 'rpc:resource_leveling:activity_patch');
    }
    const activity = projectActivities.find((row) => String(row.id) === rawPatch.activity_id);
    const cpm = cpmByActivity.get(rawPatch.activity_id);
    if (!activity || !cpm) return fail(`Shifted activity ${rawPatch.activity_id} is not in the evaluated project CPM`, 'rpc:resource_leveling:activity_missing');
    if (cpm.early_start !== rawPatch.early_start) return fail(`Shifted activity ${rawPatch.activity_id} does not match the evaluated CPM result`, 'rpc:resource_leveling:patch_cpm_mismatch');
    const assignmentHasActual = (db['activity_resources'] || []).some((assignment) =>
      String(assignment.project_id) === projectId
        && String(assignment.activity_id) === rawPatch.activity_id
        && Number(assignment.actual_quantity || 0) > 0,
    );
    if (
      activity.actual_start !== null && activity.actual_start !== undefined
      || activity.actual_finish !== null && activity.actual_finish !== undefined
      || Number(activity.percent_complete || 0) > 0
      || Number(activity.actual_quantity || 0) > 0
      || assignmentHasActual
    ) return fail(`Activity ${rawPatch.activity_id} contains actual/completed work and cannot be shifted`, 'rpc:resource_leveling:actual_work');
  }

  // All validation is complete. Stage every canonical CPM row privately and publish once.
  const stagedActivities = liveActivities.map((row) => ({ ...row }));
  for (const rawResult of cpmResults as Array<Record<string, unknown>>) {
    const index = stagedActivities.findIndex((row) => String(row.id) === String(rawResult.activity_id) && String(row.project_id) === projectId);
    if (index < 0) return fail(`CPM result activity ${String(rawResult.activity_id)} disappeared before commit`, 'rpc:resource_leveling:cpm_activity_missing');
    stagedActivities[index] = {
      ...stagedActivities[index],
      early_start: rawResult.early_start,
      early_finish: rawResult.early_finish,
      late_start: rawResult.late_start,
      late_finish: rawResult.late_finish,
      total_float: rawResult.total_float,
      free_float: rawResult.free_float,
      is_critical: rawResult.is_critical,
      activity_drag: rawResult.activity_drag,
    };
  }
  db['activities'] = stagedActivities;
  return { data: null, error: null };
}

/**
 * Faithful demo-store implementation of the `review_cost_transaction` stored procedure.
 *
 * Mutates `db` in place (the demo store's own convention) and returns the supabase-js shaped result.
 * `nowIso` is injected by the caller rather than read here, so this function stays pure and the
 * approval timestamp shape is explicit: an ISO-8601 `timestamptz` string, exactly what the SQL
 * `now()` produces and what the seeded rows already carry (e.g. `2026-07-16T10:00:00Z`).
 *
 * Every failure returns a real `error` and performs no write, so the UI can never present a failed
 * approval as a success.
 */
export function applyReviewCostTransaction(
  db: DemoDb,
  params: ReviewCostTransactionParams,
  nowIso: string,
): DemoRpcResult {
  const approver = params?.approver ?? 'operator';
  const decision = params?.decision ?? 'approve';
  const reviewNotes = params?.review_notes ?? null;
  const uuid = params?.transaction_uuid ?? null;

  const rows = (db['cost_transactions'] || []) as DemoCostTransactionRow[];
  const index = uuid === null ? -1 : rows.findIndex((r) => String(r.id) === String(uuid));
  const tx: DemoCostTransactionRow | null = index >= 0 ? rows[index] : null;

  // IF NOT FOUND OR tx.status <> 'submitted' THEN RAISE EXCEPTION
  if (!tx) {
    return {
      data: null,
      error: {
        message: 'Only submitted cost transactions can be reviewed',
        details: `No cost_transactions row with id ${uuid === null ? '(none supplied)' : `"${uuid}"`}.`,
        hint: 'rpc:review_cost_transaction:row_not_found',
      },
    };
  }
  if (String(tx.status) !== 'submitted') {
    return {
      data: null,
      error: {
        message: 'Only submitted cost transactions can be reviewed',
        details: `Transaction ${String(tx.id)} has status "${String(tx.status)}", which is not reviewable.`,
        hint: 'rpc:review_cost_transaction:status_not_submitted',
      },
    };
  }
  // IF decision NOT IN ('approve','reject') THEN RAISE EXCEPTION
  if (decision !== 'approve' && decision !== 'reject') {
    return {
      data: null,
      error: {
        message: 'Invalid review decision',
        details: `decision must be 'approve' or 'reject'; received "${decision}".`,
        hint: 'rpc:review_cost_transaction:invalid_decision',
      },
    };
  }

  const currentLevel = approvalLevelOf(tx);
  const nextLevel = currentLevel + 1;
  const updated: DemoCostTransactionRow = { ...tx };
  let action: 'approved' | 'rejected';

  if (decision === 'reject') {
    // UPDATE cost_transactions SET status='rejected', rejected_reason=review_notes
    updated.status = 'rejected';
    updated.rejected_reason = reviewNotes;
    action = 'rejected';
  } else if (nextLevel >= 2) {
    // UPDATE ... SET status='approved', approval_level=2, approved_at=now(), approved_by=approver
    updated.status = 'approved';
    updated.approval_level = 2;
    updated.approved_at = nowIso;
    updated.approved_by = approver;
    action = 'approved';
  } else {
    // UPDATE ... SET approval_level=next_level   (status deliberately stays 'submitted')
    updated.approval_level = nextLevel;
    action = 'approved';
  }

  const nextRows = rows.slice();
  nextRows[index] = updated;
  db['cost_transactions'] = nextRows as Record<string, unknown>[];

  // INSERT INTO approval_events(...) — the audit trail the SQL function writes on every decision.
  db['approval_events'] = [
    ...(db['approval_events'] || []),
    {
      id: `aprev-${updated.id}-${nextLevel}-${action}`,
      project_id: updated.project_id,
      entity_type: 'cost_transaction',
      entity_id: updated.id,
      approval_level: nextLevel,
      action,
      actor: approver,
      notes: reviewNotes,
      created_at: nowIso,
    },
  ];

  // RETURNS void: supabase-js surfaces a void RPC as `data: null` with no error. The caller reads
  // the row back (it reloads its data), so no payload is invented here.
  return { data: null, error: null };
}

/**
 * Read-back of a transaction's reviewable state, so a caller can tell the user what a press
 * actually did. Without this the two-level gate is invisible: a legitimate `approval_level` 0 -> 1
 * advance leaves the status badge unchanged, which is exactly the "no visible state change" the
 * pilot reported.
 */
export interface CostTransactionReviewState {
  status: string;
  approvalLevel: number;
  /** True once `status === 'approved'` — the state the approved-only AC filter keys on. */
  isApproved: boolean;
  /** True while the row still needs another approval level before it becomes `approved`. */
  awaitingFurtherApproval: boolean;
  /** Human-readable outcome of the last decision, for a notice that is not a bare success. */
  levelsRemaining: number;
}

export function reviewStateOf(
  tx: { status?: unknown; approval_level?: unknown } | null | undefined,
): CostTransactionReviewState | null {
  if (!tx) return null;
  const level = approvalLevelOf(tx);
  const isApproved = String(tx.status) === 'approved';
  const awaitingFurtherApproval = String(tx.status) === 'submitted' && level < 2;
  return {
    status: String(tx.status),
    approvalLevel: level,
    isApproved,
    awaitingFurtherApproval,
    levelsRemaining: isApproved ? 0 : Math.max(0, 2 - level),
  };
}

/* -------------------------------------------------------------------------
 * P2A1-M02 — the cost-transaction PROJECT BOUNDARY.
 *
 * `cost_transactions.activity_id` is a nullable foreign key
 * (`REFERENCES activities(id) ON DELETE SET NULL`), so the database accepts a row whose activity
 * lives in ANOTHER project — and, in demo mode, a row whose activity does not exist at all, because
 * the in-memory store enforces no referential integrity whatsoever. Either row is then summed into
 * canonical AC by F6, which simply adds every approved in-period transaction it is handed.
 *
 * LIVE BEHAVIOUR BEING MIRRORED (20260907220000_add_planning_control_schema.sql)
 * -----------------------------------------------------------------------------
 *   CREATE TRIGGER validate_cost_project BEFORE INSERT OR UPDATE ON cost_transactions
 *     FOR EACH ROW EXECUTE FUNCTION validate_project_boundaries();
 *
 *   -- inside validate_project_boundaries(), for 'progress_updates' / 'cost_transactions':
 *   SELECT project_id INTO related_project FROM activities WHERE id = NEW.activity_id;
 *   IF NEW.activity_id IS NOT NULL
 *      AND (related_project IS NULL OR related_project <> NEW.project_id)
 *   THEN RAISE EXCEPTION 'Control record crosses project boundary'; END IF;
 *
 * Two facts follow from that statement and are reproduced exactly:
 *   - `activity_id IS NULL` is LEGAL (the cost is project-level, attributed by WBS/BOQ or not at
 *     all), so only rows that actually name an activity are checked.
 *   - `related_project IS NULL` (the activity does not exist) and `related_project <> project_id`
 *     (the activity exists but belongs to another project) raise the SAME exception: from the
 *     project's point of view both are "this transaction does not belong here".
 *
 * The predicate is a pure function of an activity -> owning-project lookup so that BOTH consumers of
 * the rule can share one definition:
 *   1. the demo store's write path (`src/lib/supabase.ts`), which mirrors the trigger by REJECTING
 *      the write — exactly what `RAISE EXCEPTION` does;
 *   2. F6 (`costControlEngine`), which QUARANTINES such a row out of canonical AC and reports it, so
 *      a row that is already stored (seeded, imported, or written before this guard existed) can
 *      never reach actual cost.
 * ----------------------------------------------------------------------- */

/** The result of evaluating the project boundary for one control record. */
export type ProjectBoundaryVerdict =
  | { crosses: false }
  | { crosses: true; reason: 'activity_not_found' | 'foreign_project'; activityProjectId: string | null };

/**
 * Does naming this activity cross the record's project boundary?
 *
 * `lookupActivityProject` returns the owning `project_id` of an activity id, or null/undefined when
 * no such activity exists — it is the only database access the rule needs, so the demo store can
 * pass a whole-DB scan and F6 can pass its own project-scoped activity set.
 */
export function controlRecordCrossesProjectBoundary(
  activityId: unknown,
  projectId: unknown,
  lookupActivityProject: (id: string) => string | null | undefined,
): ProjectBoundaryVerdict {
  // `NEW.activity_id IS NOT NULL` — a project-level cost carries no activity and is always legal.
  if (activityId === null || activityId === undefined || activityId === '') return { crosses: false };
  const id = String(activityId);
  const relatedProject = lookupActivityProject(id);
  if (relatedProject === null || relatedProject === undefined) {
    return { crosses: true, reason: 'activity_not_found', activityProjectId: null };
  }
  if (String(relatedProject) !== String(projectId)) {
    return { crosses: true, reason: 'foreign_project', activityProjectId: String(relatedProject) };
  }
  return { crosses: false };
}

/** A `cost_transactions` / `progress_updates` row as far as the boundary rule is concerned. */
export interface ControlRecordProjectRef {
  id?: unknown;
  project_id?: unknown;
  activity_id?: unknown;
}

/**
 * The demo store's verdict for one control-record write, shaped like the PostgREST error the real
 * database returns when the trigger fires.
 *
 * `message` quotes the SQL exception verbatim so a failure is diagnosable from the UI alone.
 */
export interface ProjectBoundaryCheck {
  error: { message: string; details: string; hint: string } | null;
}

export function checkControlRecordProjectBoundary(
  db: DemoDb,
  tableName: 'cost_transactions',
  row: ControlRecordProjectRef,
): ProjectBoundaryCheck {
  const activities = (db['activities'] || []) as Array<Record<string, unknown>>;
  const verdict = controlRecordCrossesProjectBoundary(row.activity_id, row.project_id, (id) => {
    const act = activities.find((a) => String(a.id) === id);
    return act ? (act.project_id as string | null | undefined) : null;
  });
  if (!verdict.crosses) return { error: null };
  const reason = verdict.reason === 'activity_not_found'
    ? `No activities row with id "${String(row.activity_id)}".`
    : `Activity "${String(row.activity_id)}" belongs to project "${verdict.activityProjectId}", not "${String(row.project_id)}".`;
  return {
    error: {
      message: 'Control record crosses project boundary',
      details: `${tableName} row "${String(row.id ?? '(new)')}" references an activity outside its own project. ${reason}`,
      hint: `trigger:validate_project_boundaries:${verdict.reason}`,
    },
  };
}

/* -------------------------------------------------------------------------
 * REVIEW FINDING 2 (F9.4) — governed baseline evidence.
 *
 * `baseline_activities` has NO `project_id` column: it hangs off `project_baselines`, the revision
 * header that carries `project_id`, `is_active` and `status`. Filtering baseline rows client-side by
 * `activity_id` alone therefore proves only that a row belongs to one of this project's activities —
 * it says nothing about WHICH REVISION it belongs to. Every superseded revision of the same activity
 * passes that filter.
 *
 * That matters because F6 treats the rows it is handed as the authorized budget: `analyzeCostControl`
 * sets BAC = sum(`planned_cost`) over ALL of them, and builds `baselineByAct` as a Map keyed by
 * `activity_id`, so when two revisions cover one activity the LAST row in array order silently wins
 * and decides that activity's BAC — and therefore its EV (`activityBac x percent_complete`) and its
 * PV window (baseline `early_start` / `early_finish`). A stale revision reaching F6 changes BAC, PV
 * and EV without any error being raised anywhere.
 *
 * This function is the single, headlessly testable definition of the evidence set every governed
 * screen must read — the exact semantics of the PostgREST query
 *   baseline_activities
 *     -> project_baselines!inner(project_id, is_active, status)
 *     -> project_id = <this project>, is_active = true, status = 'approved'
 * used by BudgetView, Dashboard, ProgressView, ScheduleView and ExecutiveReportView. `!inner` is
 * load-bearing: a row whose `baseline_id` does not resolve to a revision header is EXCLUDED, never
 * waved through (the demo store's dot-notation `eq` used to fail open on exactly those rows).
 *
 * Pass `projectId: null` for a cross-project roll-up (PortfolioView), which cannot scope to one
 * project but must still see only active approved revisions.
 * ----------------------------------------------------------------------- */

/** A `baseline_activities` row as the demo store holds it. */
export interface DemoBaselineActivityRow extends Record<string, unknown> {
  id?: unknown;
  baseline_id?: unknown;
  activity_id?: unknown;
  planned_cost?: unknown;
}

/** A `project_baselines` revision header as the demo store holds it. */
export interface DemoProjectBaselineRow extends Record<string, unknown> {
  id?: unknown;
  project_id?: unknown;
  is_active?: unknown;
  status?: unknown;
}

/**
 * The governed baseline evidence set for one project (or, with `projectId === null`, for every
 * project) — active approved revisions only, orphaned rows excluded.
 *
 * Deterministic: rows are returned in store order, unreordered, so a caller's "last row wins"
 * behaviour cannot be perturbed by this function.
 */
export function selectGovernedBaselineActivities(
  db: DemoDb,
  projectId: string | null,
): DemoBaselineActivityRow[] {
  const revisions = (db['project_baselines'] || []) as DemoProjectBaselineRow[];
  const rows = (db['baseline_activities'] || []) as DemoBaselineActivityRow[];
  return rows.filter((row) => {
    const parent = revisions.find((rev) => rev.id === row.baseline_id);
    // `!inner`: no resolvable revision header means the row is not governed evidence at all.
    if (!parent) return false;
    if (parent.is_active !== true) return false;
    if (String(parent.status) !== 'approved') return false;
    if (projectId !== null && String(parent.project_id) !== projectId) return false;
    return true;
  });
}

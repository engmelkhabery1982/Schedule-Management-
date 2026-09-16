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

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { getInitialSeedData } from './mockSeed';
import {
  applyReviewCostTransaction,
  applyScheduleRecoveryScenario,
  applyResourceLevelingScenario,
  unimplementedRpcError,
  type AtomicResourceLevelingParams,
  type AtomicScheduleRecoveryParams,
  type ReviewCostTransactionParams,
} from './demoDbContracts';
import {
  applyApproveProjectScopeBaseline,
  applySaveVariationOrderDraft,
  applyTransitionVariationOrder,
  type SaveVariationOrderDraftRpcParams,
  type ScopeBaselineRpcParams,
  type TransitionVariationOrderRpcParams,
} from './scopeChangeDbContracts';
import {
  commitWorkspace,
  listPreservedCopies,
  loadWorkspaceState,
  readWorkspace,
  resetWorkspaceToEmpty,
  seedDemoWorkspace,
  tableRows,
  type WorkspaceFault,
  type WorkspaceMutateResult,
  type WorkspaceState,
  type WorkspaceStorage,
} from './localWorkspace';
import { MockQueryBuilder, type LocalQueryError, type LocalWorkspacePort } from './localQueryBuilder';

const envUrl = import.meta.env?.VITE_SUPABASE_URL;
const envAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;

const hasValidSupabaseEnv = Boolean(
  envUrl &&
  envAnonKey &&
  envUrl.startsWith('https://') &&
  !envUrl.includes('placeholder') &&
  !envAnonKey.includes('placeholder'),
);

export const isDemoMode = !hasValidSupabaseEnv;

/* -------------------------------------------------------------------------
 * S29 (SCH-20261027-SAFETY) — local workspace wiring.
 *
 * The three storage defects lived in this file (swallowed write errors, seed-on-read of a valid
 * empty workspace, and seed-over-corrupt-JSON). The semantics now live in `localWorkspace.ts`, which
 * never writes on read, preserves failed payloads, commits atomically, and reports every failure.
 * This file is only the adapter: browser storage -> port -> query builder / RPC contracts.
 * ---------------------------------------------------------------------- */

/** The browser's LocalStorage, or null when it cannot even be touched (denied/private mode). */
function browserStorage(): WorkspaceStorage | null {
  try {
    if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null;
    const storage = (globalThis as unknown as { localStorage?: WorkspaceStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

const unavailableStorage: WorkspaceStorage = {
  getItem() {
    throw new Error('LocalStorage is not available');
  },
  setItem() {
    throw new Error('LocalStorage is not available');
  },
  removeItem() {
    throw new Error('LocalStorage is not available');
  },
};

function activeStorage(): WorkspaceStorage {
  return browserStorage() ?? unavailableStorage;
}

/** The browser's LocalStorage (null when unavailable) — for backup/restore and selection storage. */
export function getWorkspaceStorage(): WorkspaceStorage | null {
  return browserStorage();
}

const demoPort: LocalWorkspacePort = {
  read() {
    const { state, fault } = loadWorkspaceState(activeStorage());
    return {
      state,
      error: fault ? { message: `${fault.message} — nothing was read and nothing was written.`, kind: 'workspace_fault' } : null,
    };
  },
  commit<T>(mutate: (draft: WorkspaceState) => WorkspaceMutateResult<T>) {
    const result = commitWorkspace<T>(activeStorage(), mutate);
    if (!result.ok) return { data: null, error: result.error as LocalQueryError };
    return { data: result.data, error: null };
  },
};

/**
 * Health of the local workspace for the shell banner: what the user's browser actually holds.
 * `status: 'ok'` includes the valid-but-empty workspace (no invented project is ever shown).
 */
export type WorkspaceHealth =
  | { status: 'ok'; projectCount: number; activityCount: number; empty: boolean; migrated: boolean }
  | { status: 'absent' }
  | { status: 'fault'; fault: WorkspaceFault }
  | { status: 'unavailable'; message: string };

export function getWorkspaceHealth(): WorkspaceHealth {
  const storage = browserStorage();
  if (!storage) {
    return { status: 'unavailable', message: 'This browser exposes no local storage, so nothing can be saved.' };
  }
  const loaded = readWorkspace(storage);
  if (loaded.status === 'fault') return { status: 'fault', fault: loaded.fault };
  if (loaded.status === 'absent') return { status: 'absent' };
  const projectCount = tableRows(loaded.state, 'projects').length;
  const activityCount = tableRows(loaded.state, 'activities').length;
  return {
    status: 'ok',
    projectCount,
    activityCount,
    empty: projectCount === 0 && activityCount === 0,
    migrated: loaded.migrated,
  };
}

/** Byte copies preserved by the loader (damaged payloads, pre-restore / pre-reset snapshots). */
export function listLocalWorkspaceCopies() {
  const storage = browserStorage();
  return storage ? listPreservedCopies(storage) : [];
}

/**
 * Explicit "Demo workspace" action. It is the ONLY path that writes the invented demo seed; the
 * previous bytes are preserved before they are replaced (see `seedDemoWorkspace`).
 */
export function loadDemoWorkspace(): { ok: boolean; error: string | null } {
  const storage = browserStorage();
  if (!storage) return { ok: false, error: 'This browser exposes no local storage.' };
  const result = seedDemoWorkspace(storage, getInitialSeedData() as unknown as Record<string, Record<string, unknown>[]>, 'demo');
  return result.ok ? { ok: true, error: null } : { ok: false, error: result.error.message };
}

/**
 * Start a valid, empty workspace (no projects, no activities). The previous bytes are preserved
 * first. This replaces the old behaviour where an empty workspace was silently re-seeded on read.
 */
export function startEmptyWorkspace(): { ok: boolean; error: string | null } {
  const storage = browserStorage();
  if (!storage) return { ok: false, error: 'This browser exposes no local storage.' };
  const result = resetWorkspaceToEmpty(storage);
  return result.ok ? { ok: true, error: null } : { ok: false, error: result.error.message };
}

/**
 * "Reset demo data" — the pre-existing sidebar action, kept under its original name for callers, but
 * now an explicit demo creation that preserves what it replaces instead of deleting the key.
 */
export function resetDemoDatabase(): void {
  const message = window.confirm(
    'Load the DEMO workspace (four invented projects)? The current workspace is preserved as a recoverable copy before it is replaced.',
  );
  if (!message) return;
  const result = loadDemoWorkspace();
  if (!result.ok) {
    // Never pretend a reset happened: surface the failure and leave the current data in place.
    window.alert(result.error);
    return;
  }
  window.location.reload();
}

/** RPC arguments arrive untyped from the UI; each contract narrows them itself. */
type RpcParams = Record<string, unknown>;

async function mockRpc(fnName: string, params: RpcParams) {
  const storage = activeStorage();
  if (fnName === 'approve_progress_update') {
    const outcome = commitWorkspace<boolean>(storage, (draft) => {
      const update = tableRows(draft, 'progress_updates').find((p) => p.id === params.p_update_id);
      if (!update) {
        return { ok: false, error: { message: `No progress update with id "${String(params.p_update_id)}"`, kind: 'validation' } };
      }
      update.status = 'approved';
      update.approved_at = new Date().toISOString();
      const activity = tableRows(draft, 'activities').find((a) => a.id === update.activity_id);
      if (activity) {
        activity.percent_complete = update.percent_complete;
        activity.actual_quantity = update.actual_quantity;
      }
      return { ok: true, data: true };
    });
    return outcome.ok ? { data: outcome.data ?? true, error: null } : { data: null, error: outcome.error };
  }

  // Every remaining function is a contract over the store. The contract mutates the DRAFT; the commit
  // persists it and reports failure. A rejected contract never touches storage, and — critically — a
  // rejected *write* can no longer be reported as success.
  interface ContractOutcome { data?: unknown; error: { message?: string } | null }
  const contracts: Record<string, (db: Record<string, Record<string, unknown>[]>, p: RpcParams) => ContractOutcome> = {
    // F9.4 (Controlled Pilot defect 2): implements `review_cost_transaction` statement for statement.
    review_cost_transaction: (db, p) =>
      applyReviewCostTransaction(db, p as unknown as ReviewCostTransactionParams, new Date().toISOString()),
    apply_schedule_recovery_scenario: (db, p) =>
      applyScheduleRecoveryScenario(db, p as unknown as AtomicScheduleRecoveryParams),
    apply_resource_leveling_scenario: (db, p) =>
      applyResourceLevelingScenario(db, p as unknown as AtomicResourceLevelingParams),
    approve_project_scope_baseline: (db, p) =>
      applyApproveProjectScopeBaseline(db, p as unknown as ScopeBaselineRpcParams),
    save_variation_order_draft: (db, p) =>
      applySaveVariationOrderDraft(db, p as unknown as SaveVariationOrderDraftRpcParams),
    transition_variation_order: (db, p) =>
      applyTransitionVariationOrder(db, p as unknown as TransitionVariationOrderRpcParams),
  };

  const contract = contracts[fnName];
  if (!contract) {
    // An RPC this store does not implement is a FAILURE, not a success. Returning `{ data: true }`
    // here is what made the approval defect invisible: the caller gates on `error`, so a false success
    // is indistinguishable from a committed write. The message names the function that is missing.
    return unimplementedRpcError(fnName);
  }

  let contractResult: ContractOutcome = { data: null, error: { message: `RPC ${fnName} produced no result` } };
  const commitResult = commitWorkspace(storage, (draft) => {
    contractResult = contract(draft as unknown as Record<string, Record<string, unknown>[]>, params);
    if (contractResult.error) {
      return {
        ok: false,
        error: {
          message: contractResult.error.message || `RPC ${fnName} rejected the request`,
          kind: 'validation' as const,
        },
      };
    }
    return { ok: true, data: contractResult.data };
  });
  if (!commitResult.ok) return { data: null, error: commitResult.error };
  return { data: contractResult.data ?? null, error: null };
}

export const supabase: any = hasValidSupabaseEnv
  ? createSupabaseClient(envUrl, envAnonKey, { auth: { persistSession: false } })
  : {
      from: (tableName: string) => new MockQueryBuilder(tableName, demoPort),
      rpc: mockRpc,
    };

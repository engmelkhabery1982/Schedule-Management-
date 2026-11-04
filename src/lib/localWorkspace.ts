/**
 * S29 (SCH-20261027-SAFETY) — the single owner of the browser-local workspace.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The demo/pilot store used to be three small functions inside `src/lib/supabase.ts`:
 *
 *   1. `saveDb()` wrapped `localStorage.setItem` in `try {} catch { console.warn }`, so a denied or
 *      quota-exceeded write returned normally — every caller (query builder, RPC contracts, views)
 *      then reported success for a write that never reached the disk. A reload silently lost it.
 *   2. `loadDb()` re-seeded the demo data whenever the stored state did not contain a non-empty
 *      `projects` AND a non-empty `activities` array. A perfectly valid workspace that the user had
 *      deliberately emptied (no projects yet, or a new project with no activities) was therefore
 *      REPLACED by four invented demo projects every time it was read.
 *   3. `loadDb()` caught JSON.parse failures, warned, and then seed-wrote over the damaged bytes. The
 *      original payload — the only copy of the user's data — was destroyed by the recovery path.
 *
 * The repair keeps bytes sacred and makes failure loud:
 *
 *   - reads NEVER write. There is no seed-on-read path at all; a missing workspace loads as an empty
 *     state and the UI offers explicit, clearly-labelled actions.
 *   - seed data is written only by `seedDemoWorkspace()` (an explicit "Demo workspace" action) or by
 *     a caller that explicitly asks for it. Nothing is seeded implicitly, ever.
 *   - a write is one atomic commit: mutate a deep clone, serialize, persist, read the bytes back and
 *     compare. Any failure (SecurityError, QuotaExceededError, verification mismatch) returns an
 *     error object and leaves the stored bytes exactly as they were.
 *   - parse / shape / version / migration failures keep the exact original bytes: the payload is
 *     copied to a `__preserved__` key (identical payloads collapse to one copy), the primary key is
 *     left untouched, and the caller receives a typed fault instead of invented data.
 *   - a versioned, complete backup/restore owns all persisted tables; restoring validates the backup
 *     completely BEFORE touching any byte, writes a recoverable pre-restore copy first, and rolls
 *     back to the exact previous bytes if the new state cannot be verified.
 *
 * The module is deliberately free of React, Supabase and `import.meta` so the headless validation
 * harness (`npm run validate:controls`, section S29) can exercise the real code against synthetic
 * storage — including denied and quota-exceeded writes — rather than a copy of it.
 */

// ---------------------------------------------------------------------------
// Constants — the on-disk contract.
// ---------------------------------------------------------------------------

/** Primary LocalStorage key for the local workspace (unchanged: existing pilots keep their data). */
export const WORKSPACE_STORAGE_KEY = 'schedule_mgmt_db_v5';

/**
 * Current workspace schema version.
 *
 *   1 = the original unversioned shape (tables only, no `__meta`).
 *   2 = same tables, plus `__meta` { schema_version, workspace_kind, created_at }.
 *
 * Version 2 changes no row shape, so the 1 -> 2 migration is lossless by construction.
 */
export const WORKSPACE_SCHEMA_VERSION = 2;

/** Reserved key holding the workspace's own version/kind metadata (never a table). */
export const WORKSPACE_META_KEY = '__meta';

/** Prefix for preserved (never overwritten, never auto-restored) fault payloads. */
export const PRESERVED_KEY_PREFIX = `${WORKSPACE_STORAGE_KEY}__preserved__`;

/** Prefix for the automatic recoverable copy written before a restore. */
export const PRE_RESTORE_KEY_PREFIX = `${WORKSPACE_STORAGE_KEY}__pre_restore__`;

/** Prefix for the recoverable copy written before a clean-workspace reset. */
export const PRE_RESET_KEY_PREFIX = `${WORKSPACE_STORAGE_KEY}__pre_reset__`;

/**
 * Selected-project pointer. It is a UI preference, NOT workspace data: it carries no business
 * record and is deliberately excluded from every backup (see `buildBackup`).
 */
export const SELECTED_PROJECT_STORAGE_KEY = 'schedule_mgmt_selected_project';

/**
 * Project-scoped auxiliary stores that belong to the workspace but live under their own keys
 * (pre-existing features predate the single-key store):
 *
 *   schedule_diff_revisions_<projectId>        monthly cut-off revision snapshots + activity snapshots
 *   construction_subcontracts_data_<projectId> legacy subcontract register (imported once)
 *   construction_subcontracts_db_import_<proj>  the timestamp of that one-time import
 *
 * They are BUSINESS data, so a complete workspace backup must carry them. The whitelist is exact:
 * any other key in the browser (language preference, selected project, Supabase auth tokens, other
 * applications' data) is never read and never exported.
 */
export const AUXILIARY_STORAGE_PREFIXES = [
  'schedule_diff_revisions_',
  'construction_subcontracts_data_',
  'construction_subcontracts_db_import_',
] as const;

/** Backup file format identity. CSV/XER/P6 exports are NOT workspace backups. */
export const BACKUP_FORMAT = 'schedule-management.local-workspace-backup';

/** Supported backup envelope versions. */
export const BACKUP_FORMAT_VERSION = 1;

/** A table plus the rules the restore validator applies to its rows. */
export interface PersistedTableSpec {
  /** Table name as used by `supabase.from('<name>')`. */
  readonly name: string;
  /**
   * Row field that identifies the row. `null` for the composite-key
   * `project_scope_baseline_current` table (PK = project_id).
   */
  readonly idField: string | null;
  /** Rows carry `project_id`, which must resolve to a project in the same backup. */
  readonly projectScoped: boolean;
  /** What this table holds, for the restore preview and the inventory docs. */
  readonly label: string;
}

/**
 * COMPLETE inventory of every table the local workspace persists.
 *
 * Derived from every `supabase.from('<table>')` call in `src/` (read or write) at the time of this
 * task; `scripts/validate-controls.ts` S29 re-derives the list from the source tree and fails if a
 * table is used by the app but missing here, or listed here but never used.
 */
export const PERSISTED_TABLES: readonly PersistedTableSpec[] = [
  { name: 'projects', idField: 'id', projectScoped: false, label: 'Projects (portfolio)' },
  { name: 'wbs_nodes', idField: 'id', projectScoped: true, label: 'WBS nodes' },
  { name: 'boq_items', idField: 'id', projectScoped: true, label: 'BOQ items' },
  { name: 'activities', idField: 'id', projectScoped: true, label: 'CPM activities' },
  { name: 'activity_links', idField: 'id', projectScoped: true, label: 'Activity logic links' },
  { name: 'resources', idField: 'id', projectScoped: true, label: 'Resources' },
  { name: 'activity_resources', idField: 'id', projectScoped: true, label: 'Activity resource assignments' },
  { name: 'activity_boq_allocations', idField: 'id', projectScoped: true, label: 'Activity ↔ BOQ allocations' },
  { name: 'budget_lines', idField: 'id', projectScoped: true, label: 'Budget lines' },
  { name: 'cost_transactions', idField: 'id', projectScoped: true, label: 'Cost transactions' },
  { name: 'progress_updates', idField: 'id', projectScoped: true, label: 'Progress updates (approvals)' },
  { name: 'risks', idField: 'id', projectScoped: true, label: 'Risks' },
  { name: 'issues', idField: 'id', projectScoped: true, label: 'Issues' },
  { name: 'procurement_submittals', idField: 'id', projectScoped: true, label: 'Procurement submittals' },
  { name: 'inspection_requests', idField: 'id', projectScoped: true, label: 'Inspection requests (WIR/IR)' },
  { name: 'calendars', idField: 'id', projectScoped: true, label: 'Project calendars' },
  { name: 'project_alerts', idField: 'id', projectScoped: true, label: 'Project alerts' },
  { name: 'delay_claims', idField: 'id', projectScoped: true, label: 'Delay / EOT claims' },
  { name: 'schedule_update_snapshots', idField: 'id', projectScoped: true, label: 'Schedule update snapshots' },
  { name: 'cost_control_snapshots', idField: 'id', projectScoped: true, label: 'Cost control snapshots' },
  { name: 'subcontract_packages', idField: 'id', projectScoped: true, label: 'Subcontract packages' },
  { name: 'subcontract_items', idField: 'id', projectScoped: true, label: 'Subcontract items' },
  { name: 'project_baselines', idField: 'id', projectScoped: true, label: 'Baseline revisions' },
  { name: 'baseline_activities', idField: 'id', projectScoped: false, label: 'Baseline activity snapshots' },
  { name: 'baseline_wbs_nodes', idField: 'id', projectScoped: true, label: 'Baseline WBS snapshots' },
  { name: 'baseline_boq_items', idField: 'id', projectScoped: true, label: 'Baseline BOQ snapshots' },
  { name: 'project_scope_baseline_current', idField: null, projectScoped: true, label: 'Active scope baseline pointer' },
  { name: 'variation_orders', idField: 'id', projectScoped: true, label: 'Variation orders' },
  { name: 'variation_order_boq_impacts', idField: 'id', projectScoped: false, label: 'Variation order BOQ impacts' },
  { name: 'variation_order_wbs_links', idField: 'id', projectScoped: false, label: 'Variation order WBS links' },
  { name: 'variation_order_activity_links', idField: 'id', projectScoped: false, label: 'Variation order activity links' },
  { name: 'variation_order_events', idField: 'id', projectScoped: false, label: 'Variation order audit events' },
];

/** Table names only (fast membership checks and inventory assertions). */
export const PERSISTED_TABLE_NAMES: readonly string[] = PERSISTED_TABLES.map((t) => t.name);

const TABLE_SPEC_BY_NAME = new Map(PERSISTED_TABLES.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Basic types.
// ---------------------------------------------------------------------------

export type WorkspaceRow = Record<string, unknown>;
export type WorkspaceTables = Record<string, WorkspaceRow[]>;

/** `demo` = explicit demo seed, `user` = real user data, `restored` = restored from a backup. */
export type WorkspaceKind = 'demo' | 'user' | 'restored' | 'legacy';

export interface WorkspaceMeta {
  schema_version: number;
  workspace_kind: WorkspaceKind;
  created_at: string;
  updated_at?: string;
}

/**
 * The persisted workspace: one array of rows per inventoried table, plus the reserved `__meta`
 * envelope carrying the schema version. The index signature is `unknown` because `__meta` is not a
 * table; read rows through `tableRows()` / write through `setTableRows()`.
 */
export type WorkspaceState = Record<string, unknown> & { __meta: WorkspaceMeta };

/** Rows of one table (never throws; a missing table reads as empty). */
export function tableRows(state: WorkspaceState, table: string): WorkspaceRow[] {
  const rows = state[table];
  return Array.isArray(rows) ? (rows as WorkspaceRow[]) : [];
}

/** Replace one table's rows (used by the query builder and the RPC contracts). */
export function setTableRows(state: WorkspaceState, table: string, rows: WorkspaceRow[]): void {
  state[table] = rows;
}

/**
 * The minimal LocalStorage surface this module needs. `Storage` satisfies it; so does a synthetic
 * Map-backed store in the validation harness (including one that throws, to simulate a browser with
 * storage denied or full).
 */
export type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
  Partial<Pick<Storage, 'key' | 'length'>>;

export type WorkspaceFaultKind =
  | 'storage_unavailable'
  | 'malformed_json'
  | 'invalid_shape'
  | 'unsupported_version'
  | 'migration_failed';

export interface WorkspaceFault {
  kind: WorkspaceFaultKind;
  /** Human-readable, shown in the UI and in the commit error message. */
  message: string;
  /** The exact bytes that could not be loaded (never rewritten). */
  raw: string | null;
  /** Key holding a preserved copy of `raw`, or null when preservation itself failed. */
  preservedKey: string | null;
}

export type WorkspaceLoad =
  | { status: 'absent'; state: WorkspaceState; migrated: false }
  | { status: 'ok'; state: WorkspaceState; migrated: boolean; migratedFrom: number | null }
  | { status: 'fault'; fault: WorkspaceFault };

export interface WorkspaceWriteError {
  message: string;
  kind: 'workspace_fault' | 'validation' | 'write_failed';
}

export type WorkspaceMutateResult<T> =
  | { ok: true; data?: T }
  | { ok: false; error: WorkspaceWriteError };

export type WorkspaceCommitResult<T> =
  | { ok: true; data: T | null; state: WorkspaceState }
  | { ok: false; error: WorkspaceWriteError };

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep clone via the JSON representation the store actually persists. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Deterministic serialization (sorted object keys, insertion order preserved for arrays) used for
 * checksums. Two states with the same content always produce the same string, regardless of the key
 * order they were built with.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * 53-bit FNV-1a over the canonical UTF-16 code units of `text`, rendered as 16 hex characters.
 * It is an integrity check (truncation / hand-editing detector), not a cryptographic signature.
 */
export function stableChecksum(text: string): string {
  let hashLow = 0x811c9dc5;
  let hashHigh = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hashLow ^= code & 0xff;
    hashLow = Math.imul(hashLow, 0x01000193) >>> 0;
    hashHigh ^= (code >>> 8) & 0xff;
    hashHigh = Math.imul(hashHigh, 0x01000193) >>> 0;
  }
  return `${hashHigh.toString(16).padStart(8, '0')}${hashLow.toString(16).padStart(8, '0')}`;
}

function emptyTables(): WorkspaceTables {
  const tables: WorkspaceTables = {};
  for (const spec of PERSISTED_TABLES) tables[spec.name] = [];
  return tables;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stamp(): string {
  return nowIso().replace(/[:.]/g, '-');
}

export function createEmptyWorkspace(kind: WorkspaceKind = 'user', createdAt: string = nowIso()): WorkspaceState {
  return {
    ...emptyTables(),
    __meta: { schema_version: WORKSPACE_SCHEMA_VERSION, workspace_kind: kind, created_at: createdAt },
  };
}

/**
 * True when the state holds no business rows at all. Used by the UI to distinguish "empty but
 * valid" (offer New project / Load demo / Restore) from "has data".
 */
export function isEmptyWorkspace(state: WorkspaceState): boolean {
  return PERSISTED_TABLES.every((spec) => tableRows(state, spec.name).length === 0);
}

// ---------------------------------------------------------------------------
// Preservation of bytes that failed to load.
// ---------------------------------------------------------------------------

function listStorageKeys(storage: WorkspaceStorage): string[] {
  const keys: string[] = [];
  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') throw new Error('storage enumeration unavailable');
  const length = storage.length;
  for (let i = 0; i < length; i += 1) {
    const key = storage.key(i);
    if (key === null || keys.includes(key)) throw new Error('storage enumeration changed');
    keys.push(key);
  }
  if (storage.length !== length) throw new Error('storage enumeration changed');
  return keys;
}

/**
 * Copy `raw` under a preserved key. Idempotent: an identical payload already preserved is reused,
 * so repeatedly reading a damaged workspace does not fill the browser with copies.
 *
 * Returns the key holding the copy, or null when the copy itself could not be written (the primary
 * key is still never modified, so the original bytes survive either way).
 */
export function preserveRawBytes(
  storage: WorkspaceStorage,
  raw: string,
  reason: WorkspaceFaultKind | 'pre_restore' | 'pre_reset',
): string | null {
  const prefix = reason === 'pre_restore'
    ? PRE_RESTORE_KEY_PREFIX
    : reason === 'pre_reset'
      ? PRE_RESET_KEY_PREFIX
      : PRESERVED_KEY_PREFIX;
  try {
    for (const key of listStorageKeys(storage)) {
      if (!key.startsWith(PRESERVED_KEY_PREFIX) || !key.includes(`__${reason}`)) continue;
      if (storage.getItem(key) === raw) return key;
    }
    const key = `${prefix}${reason}__${stamp()}`;
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) return null;
    return key;
  } catch {
    return null;
  }
}

/** Every preserved / pre-restore / pre-reset copy in storage, newest first. */
export function listPreservedCopies(
  storage: WorkspaceStorage,
): Array<{ key: string; bytes: number; createdAt: string | null }> {
  const out: Array<{ key: string; bytes: number; createdAt: string | null }> = [];
  for (const key of listStorageKeys(storage)) {
    if (!key.startsWith(PRESERVED_KEY_PREFIX)
      && !key.startsWith(PRE_RESTORE_KEY_PREFIX)
      && !key.startsWith(PRE_RESET_KEY_PREFIX)) continue;
    let bytes = 0;
    try {
      bytes = (storage.getItem(key) ?? '').length;
    } catch {
      bytes = 0;
    }
    out.push({ key, bytes, createdAt: extractIsoDate(key) });
  }
  return out.sort((a, b) => (a.createdAt === b.createdAt ? a.key.localeCompare(b.key) : (b.createdAt ?? '').localeCompare(a.createdAt ?? '')));
}

function extractIsoDate(key: string): string | null {
  const match = key.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)/);
  if (!match) return null;
  const normalised = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
  return normalised;
}

// ---------------------------------------------------------------------------
// Auxiliary project-scoped stores (revisions, legacy subcontract register).
// ---------------------------------------------------------------------------

export interface AuxiliaryEntry {
  key: string;
  /** Project the key is scoped to, or null when the suffix is not a project id. */
  projectId: string | null;
  /** Exact stored string (never re-serialized), so a restore is byte-faithful. */
  raw: string;
}

export function auxiliaryPrefixOf(key: string): string | null {
  for (const prefix of AUXILIARY_STORAGE_PREFIXES) {
    if (key.startsWith(prefix)) return prefix;
  }
  return null;
}

export function isAuxiliaryKey(key: string): boolean {
  return auxiliaryPrefixOf(key) !== null;
}

/** Read every whitelisted auxiliary store for the projects in `projectIds` (null = all). */
export function readAuxiliaryStores(
  storage: WorkspaceStorage,
  projectIds: Set<string> | null = null,
): AuxiliaryEntry[] {
  const entries: AuxiliaryEntry[] = [];
  for (const key of listStorageKeys(storage).sort()) {
    const prefix = auxiliaryPrefixOf(key);
    if (!prefix) continue;
    const projectId = key.slice(prefix.length) || null;
    if (projectIds && projectId !== null && !projectIds.has(projectId)) continue;
    const raw = storage.getItem(key);
    if (raw === null) throw new Error(`auxiliary store disappeared: ${key}`);
    entries.push({ key, projectId, raw });
  }
  return entries;
}

/** Write auxiliary entries back; returns the first failure without hiding it. */
export function writeAuxiliaryStores(
  storage: WorkspaceStorage,
  entries: AuxiliaryEntry[],
): { ok: true } | { ok: false; error: string } {
  for (const entry of entries) {
    if (!isAuxiliaryKey(entry.key)) {
      return { ok: false, error: `refusing to write a non-workspace key: ${entry.key}` };
    }
    try {
      storage.setItem(entry.key, entry.raw);
      if (storage.getItem(entry.key) !== entry.raw) {
        return { ok: false, error: `auxiliary store ${entry.key} could not be verified after writing` };
      }
    } catch (err) {
      return {
        ok: false,
        error: `auxiliary store ${entry.key} could not be written (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Migration.
// ---------------------------------------------------------------------------

export class WorkspaceMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMigrationError';
  }
}

export interface MigrationResult {
  state: WorkspaceState;
  fromVersion: number;
}

/**
 * 1 -> 2: stamp `__meta` and guarantee every inventoried table exists as an array.
 *
 * No row is added, removed or rewritten: the migration asserts what it needs (rows are JSON objects)
 * and fails loudly if the legacy payload is not a table store at all, instead of guessing.
 */
function migrateV1ToV2(input: WorkspaceTables, meta: Partial<WorkspaceMeta>): WorkspaceState {
  const migrated: WorkspaceTables = {};
  for (const key of Object.keys(input)) {
    const rows = input[key];
    if (!Array.isArray(rows)) {
      throw new WorkspaceMigrationError(`table "${key}" is not an array of rows`);
    }
    for (const row of rows) {
      if (!isPlainObject(row)) {
        throw new WorkspaceMigrationError(`table "${key}" contains a row that is not an object`);
      }
    }
    migrated[key] = deepClone(rows);
  }
  for (const spec of PERSISTED_TABLES) {
    if (!migrated[spec.name]) migrated[spec.name] = [];
  }
  return {
    ...migrated,
    __meta: {
      schema_version: WORKSPACE_SCHEMA_VERSION,
      workspace_kind: (meta.workspace_kind as WorkspaceKind | undefined) ?? 'legacy',
      created_at: meta.created_at ?? nowIso(),
    },
  };
}

const MIGRATIONS: Record<number, (input: WorkspaceTables, meta: Partial<WorkspaceMeta>) => WorkspaceState> = {
  1: migrateV1ToV2,
};

export type NormalizeResult =
  | { ok: true; state: WorkspaceState; fromVersion: number; migrated: boolean }
  | { ok: false; fault: { kind: WorkspaceFaultKind; message: string } };

/**
 * Parse-free normalization of an already-decoded payload: shape -> version -> migration.
 *
 * Pure: it never touches storage. `readWorkspace` turns the result into a typed fault, and the
 * restore validator reuses it for backup payloads.
 */
export function normalizeWorkspaceState(parsed: unknown): NormalizeResult {
  if (!isPlainObject(parsed)) {
    return { ok: false, fault: { kind: 'invalid_shape', message: 'workspace payload is not an object' } };
  }
  const tableInput: WorkspaceTables = {};
  for (const key of Object.keys(parsed)) {
    if (key === WORKSPACE_META_KEY) continue;
    const value = parsed[key];
    if (!Array.isArray(value)) {
      return { ok: false, fault: { kind: 'invalid_shape', message: `table "${key}" is not an array` } };
    }
    tableInput[key] = value as WorkspaceRow[];
  }

  const rawMeta = parsed[WORKSPACE_META_KEY];
  let meta: Partial<WorkspaceMeta> = {};
  let version = 1;
  if (rawMeta !== undefined) {
    if (!isPlainObject(rawMeta)) {
      return { ok: false, fault: { kind: 'invalid_shape', message: `"${WORKSPACE_META_KEY}" is not an object` } };
    }
    meta = rawMeta as Partial<WorkspaceMeta>;
    const declared = rawMeta.schema_version;
    if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
      return {
        ok: false,
        fault: { kind: 'invalid_shape', message: `"${WORKSPACE_META_KEY}.schema_version" is not a positive integer` },
      };
    }
    version = declared;
  }

  if (version > WORKSPACE_SCHEMA_VERSION) {
    return {
      ok: false,
      fault: {
        kind: 'unsupported_version',
        message: `workspace schema version ${version} is newer than this build (${WORKSPACE_SCHEMA_VERSION}); nothing was changed`,
      },
    };
  }

  if (version === WORKSPACE_SCHEMA_VERSION) {
    return {
      ok: true,
      state: { ...tableInput, __meta: { ...(meta as WorkspaceMeta), schema_version: WORKSPACE_SCHEMA_VERSION } },
      fromVersion: version,
      migrated: false,
    };
  }

  try {
    let currentTables: WorkspaceTables = tableInput;
    let currentMeta: Partial<WorkspaceMeta> = meta;
    for (let v = version; v < WORKSPACE_SCHEMA_VERSION; v += 1) {
      const step = MIGRATIONS[v];
      if (!step) throw new WorkspaceMigrationError(`no migration registered from schema version ${v}`);
      const next = step(currentTables, currentMeta);
      currentTables = next as unknown as WorkspaceTables;
      currentMeta = next.__meta;
    }
    return { ok: true, state: currentTables as unknown as WorkspaceState, fromVersion: version, migrated: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, fault: { kind: 'migration_failed', message: `migration failed: ${message}` } };
  }
}

// ---------------------------------------------------------------------------
// Read (never writes).
// ---------------------------------------------------------------------------

/**
 * Load the workspace for a query. This function NEVER writes to storage:
 *
 *   - absent key                  -> `{ status: 'absent' }` with a valid empty state (no seeding);
 *   - valid key                   -> `{ status: 'ok' }`, migrating in memory only when the stored
 *                                    schema version is older than this build;
 *   - unreadable bytes            -> `{ status: 'fault' }`, bytes preserved and left in place.
 */
export function readWorkspace(storage: WorkspaceStorage): WorkspaceLoad {
  let raw: string | null;
  try {
    raw = storage.getItem(WORKSPACE_STORAGE_KEY);
  } catch (err) {
    return {
      status: 'fault',
      fault: {
        kind: 'storage_unavailable',
        message: `local workspace storage is unavailable (${err instanceof Error ? err.message : String(err)})`,
        raw: null,
        preservedKey: null,
      },
    };
  }

  if (raw === null) {
    return { status: 'absent', state: createEmptyWorkspace('user'), migrated: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: 'fault',
      fault: {
        kind: 'malformed_json',
        message: 'the stored local workspace is not valid JSON; the damaged bytes were preserved and nothing was overwritten',
        raw,
        preservedKey: preserveRawBytes(storage, raw, 'malformed_json'),
      },
    };
  }

  const normalized = normalizeWorkspaceState(parsed);
  if (!normalized.ok) {
    const { kind, message } = normalized.fault;
    return {
      status: 'fault',
      fault: {
        kind,
        message,
        raw,
        preservedKey: preserveRawBytes(storage, raw, kind),
      },
    };
  }

  return {
    status: 'ok',
    state: normalized.state,
    migrated: normalized.migrated,
    migratedFrom: normalized.migrated ? normalized.fromVersion : null,
  };
}

/** Convenience: the state a reader should use, plus the fault (if any). */
export function loadWorkspaceState(storage: WorkspaceStorage): { state: WorkspaceState; fault: WorkspaceFault | null } {
  const loaded = readWorkspace(storage);
  if (loaded.status === 'fault') {
    return { state: createEmptyWorkspace('user'), fault: loaded.fault };
  }
  return { state: loaded.state, fault: null };
}

// ---------------------------------------------------------------------------
// Atomic commit (the only write path).
// ---------------------------------------------------------------------------

function writeError(message: string, kind: WorkspaceWriteError['kind']): WorkspaceWriteError {
  return { message, kind };
}

/**
 * One atomic write:
 *
 *   1. read the current bytes (a fault aborts the write — damaged bytes are never overwritten by an
 *      ordinary save);
 *   2. let `mutate` change a deep clone;
 *   3. serialize, persist, then read the bytes back and compare them with what was written;
 *   4. on any failure restore the exact previous bytes (or remove the key when it was absent) and
 *      return an error, so no caller can report a write that did not happen.
 */
export function commitWorkspace<T>(
  storage: WorkspaceStorage,
  mutate: (draft: WorkspaceState) => WorkspaceMutateResult<T>,
): WorkspaceCommitResult<T> {
  const loaded = readWorkspace(storage);
  if (loaded.status === 'fault') {
    return {
      ok: false,
      error: writeError(`local workspace could not be read, so nothing was saved: ${loaded.fault.message}`, 'workspace_fault'),
    };
  }

  const previousRaw = loaded.status === 'absent'
    ? null
    : safeGetRaw(storage);

  const draft = deepClone(loaded.state);
  const mutation = mutate(draft);
  if (!mutation.ok) return { ok: false, error: mutation.error };

  draft.__meta = {
    ...draft.__meta,
    schema_version: WORKSPACE_SCHEMA_VERSION,
    updated_at: nowIso(),
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(draft);
  } catch (err) {
    return {
      ok: false,
      error: writeError(`local workspace could not be serialized (${err instanceof Error ? err.message : String(err)})`, 'validation'),
    };
  }

  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, serialized);
  } catch (err) {
    // Denied (SecurityError) or full (QuotaExceededError): the stored bytes were never replaced, so
    // there is nothing to roll back — but the caller MUST see the failure.
    return {
      ok: false,
      error: writeError(
        `local workspace write failed, nothing was saved (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`,
        'write_failed',
      ),
    };
  }

  const verification = verifyPersistedBytes(storage, serialized);
  if (!verification.ok) {
    rollback(storage, previousRaw);
    return { ok: false, error: writeError(verification.message, 'write_failed') };
  }

  return { ok: true, data: (mutation.data ?? null) as T | null, state: draft };
}

function safeGetRaw(storage: WorkspaceStorage): string | null {
  try {
    return storage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function verifyPersistedBytes(storage: WorkspaceStorage, expected: string): { ok: true } | { ok: false; message: string } {
  let readBack: string | null;
  try {
    readBack = storage.getItem(WORKSPACE_STORAGE_KEY);
  } catch (err) {
    return { ok: false, message: `local workspace could not be verified after writing (${err instanceof Error ? err.message : String(err)})` };
  }
  if (readBack !== expected) {
    return { ok: false, message: 'local workspace verification failed: the bytes read back differ from the bytes written' };
  }
  return { ok: true };
}

function rollback(storage: WorkspaceStorage, previousRaw: string | null): void {
  try {
    if (previousRaw === null) storage.removeItem(WORKSPACE_STORAGE_KEY);
    else storage.setItem(WORKSPACE_STORAGE_KEY, previousRaw);
  } catch {
    // The store is refusing writes entirely; the caller already receives a failure either way.
  }
}

// ---------------------------------------------------------------------------
// Explicit workspace lifecycle actions (never implicit).
// ---------------------------------------------------------------------------

function writeWholeState(
  storage: WorkspaceStorage,
  state: WorkspaceState,
): { ok: true; state: WorkspaceState } | { ok: false; error: WorkspaceWriteError } {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch (err) {
    return { ok: false, error: writeError(`workspace could not be serialized (${err instanceof Error ? err.message : String(err)})`, 'validation') };
  }
  const previousRaw = safeGetRaw(storage);
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, serialized);
  } catch (err) {
    return {
      ok: false,
      error: writeError(
        `local workspace write failed, nothing was saved (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`,
        'write_failed',
      ),
    };
  }
  const verification = verifyPersistedBytes(storage, serialized);
  if (!verification.ok) {
    rollback(storage, previousRaw);
    return { ok: false, error: writeError(verification.message, 'write_failed') };
  }
  return { ok: true, state };
}

/**
 * Explicit demo creation. The ONLY path that writes invented demo data, and it is never reached
 * implicitly: the caller (a clearly labelled "Load demo workspace" button) asks for it.
 *
 * Any existing bytes are preserved under `__pre_reset__` first; a failed preservation aborts the
 * action so the user's data is never replaced unrecoverably.
 */
export function seedDemoWorkspace(
  storage: WorkspaceStorage,
  seedTables: WorkspaceTables,
  kind: WorkspaceKind = 'demo',
  createdAt: string = nowIso(),
): { ok: true; state: WorkspaceState } | { ok: false; error: WorkspaceWriteError } {
  const existing = safeGetRaw(storage);
  if (existing !== null && existing.length > 0) {
    const preserved = preserveRawBytes(storage, existing, 'pre_reset');
    if (preserved === null) {
      return {
        ok: false,
        error: writeError('the current workspace could not be preserved, so the demo workspace was not loaded', 'write_failed'),
      };
    }
  }
  const state: WorkspaceState = {
    ...emptyTables(),
    ...deepClone(seedTables),
    __meta: { schema_version: WORKSPACE_SCHEMA_VERSION, workspace_kind: kind, created_at: createdAt },
  };
  return writeWholeState(storage, state);
}

/**
 * Start over with a valid EMPTY workspace (no projects, no activities — and no seed).
 * The previous bytes are preserved first and the action fails if they cannot be.
 */
export function resetWorkspaceToEmpty(
  storage: WorkspaceStorage,
  createdAt: string = nowIso(),
): { ok: true; state: WorkspaceState } | { ok: false; error: WorkspaceWriteError } {
  const existing = safeGetRaw(storage);
  if (existing !== null && existing.length > 0) {
    const preserved = preserveRawBytes(storage, existing, 'pre_reset');
    if (preserved === null) {
      return {
        ok: false,
        error: writeError('the current workspace could not be preserved, so it was not cleared', 'write_failed'),
      };
    }
  }
  return writeWholeState(storage, createEmptyWorkspace('user', createdAt));
}

// ---------------------------------------------------------------------------
// Selected project (UI preference; excluded from backups).
// ---------------------------------------------------------------------------

export function readSelectedProjectId(storage: WorkspaceStorage): string | null {
  try {
    const value = storage.getItem(SELECTED_PROJECT_STORAGE_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function writeSelectedProjectId(storage: WorkspaceStorage, projectId: string | null): boolean {
  try {
    if (projectId === null) storage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
    else storage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the project to open on boot: the remembered selection when it still exists, otherwise the
 * newest project. `null` when the workspace has no projects at all (no invented fallback project).
 */
export function resolveStartupProject<T extends { id: string; created_at?: string | null }>(
  projects: T[],
  selectedId: string | null,
): T | null {
  if (projects.length === 0) return null;
  if (selectedId) {
    const remembered = projects.find((p) => p.id === selectedId);
    if (remembered) return remembered;
  }
  return [...projects].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
}

// ---------------------------------------------------------------------------
// Versioned workspace backup.
// ---------------------------------------------------------------------------

export interface WorkspaceBackup {
  format: typeof BACKUP_FORMAT;
  format_version: number;
  schema_version: number;
  created_at: string;
  source: {
    workspace_kind: WorkspaceKind;
    project_count: number;
    row_count: number;
  };
  /** Only inventoried tables — never other browser keys, credentials or UI preferences. */
  tables: WorkspaceTables;
  /** Whitelisted project-scoped auxiliary stores (cut-off revisions, legacy subcontract register). */
  auxiliary: AuxiliaryEntry[];
  counts: Record<string, number>;
  checksum: string;
}

export function backupChecksum(tables: WorkspaceTables, auxiliary: AuxiliaryEntry[] = []): string {
  const ordered: WorkspaceTables = {};
  for (const name of [...Object.keys(tables)].sort()) ordered[name] = tables[name];
  const aux = [...auxiliary]
    .map((entry) => ({ key: entry.key, raw: entry.raw }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return stableChecksum(canonicalJson({ tables: ordered, auxiliary: aux }));
}

/** Build the complete, self-describing backup object from a workspace state. */
export function buildBackup(
  state: WorkspaceState,
  createdAt: string = nowIso(),
  auxiliary: AuxiliaryEntry[] = [],
): WorkspaceBackup {
  const tables: WorkspaceTables = {};
  const counts: Record<string, number> = {};
  let rowCount = 0;
  for (const spec of PERSISTED_TABLES) {
    const rows = deepClone(tableRows(state, spec.name));
    tables[spec.name] = rows;
    counts[spec.name] = rows.length;
    rowCount += rows.length;
  }
  return {
    format: BACKUP_FORMAT,
    format_version: BACKUP_FORMAT_VERSION,
    schema_version: state.__meta?.schema_version ?? WORKSPACE_SCHEMA_VERSION,
    created_at: createdAt,
    source: {
      workspace_kind: (state.__meta?.workspace_kind ?? 'user') as WorkspaceKind,
      project_count: tables.projects.length,
      row_count: rowCount,
    },
    tables,
    auxiliary: [...auxiliary],
    counts,
    checksum: backupChecksum(tables, auxiliary),
  };
}

/** Pretty-printed backup text; the pretty print is what a human inspects and archives. */
export function serializeBackup(backup: WorkspaceBackup): string {
  return JSON.stringify(backup, null, 2);
}

export function backupFileName(backup: WorkspaceBackup): string {
  return `schedule-workspace-backup_${backup.created_at.replace(/[:.]/g, '-')}.json`;
}

// ---------------------------------------------------------------------------
// Backup validation + restore.
// ---------------------------------------------------------------------------

export type BackupErrorCode =
  | 'not_json'
  | 'not_an_object'
  | 'unknown_format'
  | 'unsupported_format_version'
  | 'unsupported_schema_version'
  | 'unknown_table'
  | 'invalid_table'
  | 'invalid_row'
  | 'duplicate_id'
  | 'missing_reference'
  | 'project_mismatch'
  | 'date_order'
  | 'chronology'
  | 'required_field'
  | 'invalid_auxiliary'
  | 'checksum_mismatch';

export interface BackupIssue {
  code: BackupErrorCode;
  path: string;
  message: string;
}

export interface BackupSummary {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  workspaceKind: WorkspaceKind;
  counts: Array<{ table: string; label: string; rows: number }>;
  totalRows: number;
  projects: Array<{ id: string; name: string; start_date: string | null; end_date: string | null; data_date: string | null; contract_value: number | null }>;
  checksum: string;
  checksumVerified: boolean;
  approvals: { progressApproved: number; progressOther: number; costApproved: number; costOther: number };
  dataDates: string[];
  /** Whitelisted project-scoped auxiliary stores carried by the file. */
  auxiliary: Array<{ key: string; bytes: number }>;
}

export interface BackupValidation {
  ok: boolean;
  errors: BackupIssue[];
  warnings: string[];
  summary: BackupSummary | null;
  /** Normalized, fully validated state — the ONLY thing restore accepts. */
  state: WorkspaceState | null;
  /** Fully validated auxiliary stores (whitelisted keys only). */
  auxiliary: AuxiliaryEntry[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDateValue(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validate a backup payload COMPLETELY before anything is restored.
 *
 * Checks, in order: JSON -> envelope identity/version -> table inventory -> per-row shape/ids ->
 * project relationships -> baseline/VO relationships -> date ordering -> Data Date chronology ->
 * approvals fields -> checksum. A single error means `ok === false` and `state === null`; restore
 * will then decline to touch storage, leaving the workspace byte-identical.
 */
export function validateBackup(input: string | unknown): BackupValidation {
  const errors: BackupIssue[] = [];
  const warnings: string[] = [];
  const fail = (code: BackupErrorCode, path: string, message: string): BackupValidation => {
    errors.push({ code, path, message });
    return { ok: false, errors, warnings, summary: null, state: null, auxiliary: [] };
  };

  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return fail('not_json', 'file', 'the selected file is not valid JSON');
    }
  }
  if (!isPlainObject(parsed)) return fail('not_an_object', 'file', 'the backup root is not an object');

  if (parsed.format !== BACKUP_FORMAT) {
    return fail('unknown_format', 'format',
      `this is not a ${BACKUP_FORMAT} file (CSV/XER exports are schedules, not workspace backups)`);
  }
  const formatVersion = parsed.format_version;
  if (formatVersion !== BACKUP_FORMAT_VERSION) {
    return fail('unsupported_format_version', 'format_version',
      `backup format version ${String(formatVersion)} is not supported by this build (${BACKUP_FORMAT_VERSION})`);
  }
  const schemaVersion = parsed.schema_version;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return fail('required_field', 'schema_version', 'schema_version must be an integer');
  }
  if (schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    return fail('unsupported_schema_version', 'schema_version',
      `backup schema version ${schemaVersion} is newer than this build (${WORKSPACE_SCHEMA_VERSION})`);
  }
  const tablesInput = parsed.tables;
  if (!isPlainObject(tablesInput)) return fail('required_field', 'tables', 'tables must be an object');

  for (const key of Object.keys(tablesInput)) {
    if (!TABLE_SPEC_BY_NAME.has(key)) {
      return fail('unknown_table', `tables.${key}`,
        `table "${key}" is not part of the local workspace inventory; refusing to restore unknown data`);
    }
    if (!Array.isArray(tablesInput[key])) {
      return fail('invalid_table', `tables.${key}`, `table "${key}" is not an array`);
    }
  }
  for (const spec of PERSISTED_TABLES) {
    if (tablesInput[spec.name] === undefined) {
      warnings.push(`table "${spec.name}" is absent from the backup and will be restored as empty`);
    }
  }

  const tables: WorkspaceTables = {};
  for (const spec of PERSISTED_TABLES) {
    const rows = (tablesInput[spec.name] as unknown[] | undefined) ?? [];
    const out: WorkspaceRow[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const path = `tables.${spec.name}[${i}]`;
      if (!isPlainObject(row)) {
        return fail('invalid_row', path, 'row is not an object');
      }
      if (spec.idField) {
        const id = row[spec.idField];
        if (typeof id !== 'string' || id.trim() === '') {
          return fail('required_field', `${path}.${spec.idField}`, `"${spec.name}" row has no id`);
        }
        if (seenIds.has(id)) {
          return fail('duplicate_id', `${path}.${spec.idField}`, `duplicate id "${id}" in "${spec.name}"`);
        }
        seenIds.add(id);
      }
      out.push(deepClone(row));
    }
    tables[spec.name] = out;
  }

  // --- id indexes for relationship checks ---------------------------------
  const projectRows = tables.projects;
  const projectIds = new Set(projectRows.map((p) => String(p.id)));
  const projectById = new Map(projectRows.map((p) => [String(p.id), p]));
  const index = (name: string): Map<string, WorkspaceRow> =>
    new Map(tables[name].map((row) => [String(row.id), row]));
  const activityById = index('activities');
  const wbsById = index('wbs_nodes');
  const boqById = index('boq_items');
  const resourceById = index('resources');
  const baselineById = index('project_baselines');

  // --- project required fields + date ordering ----------------------------
  const dataDates: string[] = [];
  const projectsSummary: BackupSummary['projects'] = [];
  for (let i = 0; i < projectRows.length; i += 1) {
    const p = projectRows[i];
    const path = `tables.projects[${i}]`;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) return fail('required_field', `${path}.name`, 'project name is required');
    const contractValue = num(p.contract_value);
    if (contractValue === null || contractValue < 0) {
      return fail('required_field', `${path}.contract_value`, 'contract_value must be a finite number >= 0');
    }
    const start = p.start_date;
    const end = p.end_date;
    if (start !== null && start !== undefined && !isIsoDateValue(start)) {
      return fail('required_field', `${path}.start_date`, 'start_date must be YYYY-MM-DD');
    }
    if (end !== null && end !== undefined && !isIsoDateValue(end)) {
      return fail('required_field', `${path}.end_date`, 'end_date must be YYYY-MM-DD');
    }
    if (isIsoDateValue(start) && isIsoDateValue(end) && start > end) {
      return fail('date_order', path, `start_date ${start} is after end_date ${end}`);
    }
    if (p.data_date !== null && p.data_date !== undefined) {
      if (!isIsoDateValue(p.data_date)) {
        return fail('required_field', `${path}.data_date`, 'data_date must be YYYY-MM-DD');
      }
      dataDates.push(p.data_date);
    }
    projectsSummary.push({
      id: String(p.id),
      name,
      start_date: isIsoDateValue(start) ? start : null,
      end_date: isIsoDateValue(end) ? end : null,
      data_date: p.data_date === null || p.data_date === undefined ? null : String(p.data_date),
      contract_value: contractValue,
    });
  }

  // --- project references ------------------------------------------------
  for (const spec of PERSISTED_TABLES) {
    if (!spec.projectScoped) continue;
    const rows = tables[spec.name];
    for (let i = 0; i < rows.length; i += 1) {
      const projectId = rows[i].project_id;
      if (typeof projectId !== 'string' || !projectIds.has(projectId)) {
        return fail('missing_reference', `tables.${spec.name}[${i}].project_id`,
          `"${spec.name}" row references project "${String(projectId)}" which is not in this backup`);
      }
    }
  }

  // --- same-project relationship checks ----------------------------------
  for (let i = 0; i < tables.wbs_nodes.length; i += 1) {
    const node = tables.wbs_nodes[i];
    if (node.parent_id === null || node.parent_id === undefined) continue;
    const parent = wbsById.get(String(node.parent_id));
    if (!parent) {
      return fail('missing_reference', `tables.wbs_nodes[${i}].parent_id`, 'parent WBS node does not exist');
    }
    if (parent.project_id !== node.project_id) {
      return fail('project_mismatch', `tables.wbs_nodes[${i}].parent_id`, 'parent WBS node belongs to another project');
    }
  }

  for (let i = 0; i < tables.activities.length; i += 1) {
    const activity = tables.activities[i];
    const path = `tables.activities[${i}]`;
    const duration = activity.duration_days;
    if (duration !== null && duration !== undefined && (num(duration) === null || (num(duration) as number) < 0)) {
      return fail('required_field', `${path}.duration_days`, 'duration_days must be a finite number >= 0');
    }
    // Actual dates are recorded execution, unlike future planned dates. Restoring them must obey
    // the same governed cut-off as progress/cost rows; a checksum alone does not establish validity.
    const activityProject = projectById.get(String(activity.project_id));
    const activityDataDate = activityProject && isIsoDateValue(activityProject.data_date)
      ? activityProject.data_date : null;
    for (const field of ['actual_start', 'actual_finish'] as const) {
      const value = activity[field];
      if (value === null || value === undefined) continue;
      if (!isIsoDateValue(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        return fail('required_field', `${path}.${field}`, `${field} must be a real YYYY-MM-DD date or null`);
      }
      if (activityDataDate && value > activityDataDate) {
        return fail('chronology', `${path}.${field}`,
          `${field} dated ${value} is after the project Data Date ${activityDataDate}`);
      }
    }
    if (isIsoDateValue(activity.actual_start) && isIsoDateValue(activity.actual_finish)
      && activity.actual_start > activity.actual_finish) {
      return fail('date_order', path, 'activity actual_start is after actual_finish');
    }
    if (activity.wbs_node_id !== null && activity.wbs_node_id !== undefined) {
      const wbs = wbsById.get(String(activity.wbs_node_id));
      if (!wbs) return fail('missing_reference', `${path}.wbs_node_id`, 'activity WBS node does not exist');
      if (wbs.project_id !== activity.project_id) {
        return fail('project_mismatch', `${path}.wbs_node_id`, 'activity WBS node belongs to another project');
      }
    }
    if (isIsoDateValue(activity.early_start) && isIsoDateValue(activity.early_finish)
      && activity.early_start > activity.early_finish) {
      return fail('date_order', path, 'activity early_start is after early_finish');
    }
    if (isIsoDateValue(activity.late_start) && isIsoDateValue(activity.late_finish)
      && activity.late_start > activity.late_finish) {
      return fail('date_order', path, 'activity late_start is after late_finish');
    }
  }

  for (let i = 0; i < tables.activity_links.length; i += 1) {
    const link = tables.activity_links[i];
    const path = `tables.activity_links[${i}]`;
    const predecessor = activityById.get(String(link.predecessor_id));
    const successor = activityById.get(String(link.successor_id));
    if (!predecessor) return fail('missing_reference', `${path}.predecessor_id`, 'predecessor activity does not exist');
    if (!successor) return fail('missing_reference', `${path}.successor_id`, 'successor activity does not exist');
    if (predecessor.project_id !== link.project_id || successor.project_id !== link.project_id) {
      return fail('project_mismatch', path, 'link connects activities of another project');
    }
    if (link.predecessor_id === link.successor_id) {
      return fail('project_mismatch', path, 'link connects an activity to itself');
    }
  }

  for (let i = 0; i < tables.activity_resources.length; i += 1) {
    const row = tables.activity_resources[i];
    const path = `tables.activity_resources[${i}]`;
    const activity = activityById.get(String(row.activity_id));
    const resource = resourceById.get(String(row.resource_id));
    if (!activity) return fail('missing_reference', `${path}.activity_id`, 'activity does not exist');
    if (!resource) return fail('missing_reference', `${path}.resource_id`, 'resource does not exist');
    if (activity.project_id !== row.project_id || resource.project_id !== row.project_id) {
      return fail('project_mismatch', path, 'resource assignment crosses projects');
    }
  }

  for (let i = 0; i < tables.activity_boq_allocations.length; i += 1) {
    const row = tables.activity_boq_allocations[i];
    const path = `tables.activity_boq_allocations[${i}]`;
    const activity = activityById.get(String(row.activity_id));
    if (!activity) return fail('missing_reference', `${path}.activity_id`, 'activity does not exist');
    if (row.boq_item_id !== null && row.boq_item_id !== undefined) {
      const boq = boqById.get(String(row.boq_item_id));
      if (!boq) return fail('missing_reference', `${path}.boq_item_id`, 'BOQ item does not exist');
      if (boq.project_id !== row.project_id) {
        return fail('project_mismatch', `${path}.boq_item_id`, 'BOQ item belongs to another project');
      }
    }
  }

  for (let i = 0; i < tables.budget_lines.length; i += 1) {
    const row = tables.budget_lines[i];
    const path = `tables.budget_lines[${i}]`;
    if (row.wbs_node_id !== null && row.wbs_node_id !== undefined) {
      const wbs = wbsById.get(String(row.wbs_node_id));
      if (!wbs) return fail('missing_reference', `${path}.wbs_node_id`, 'budget line WBS node does not exist');
      if (wbs.project_id !== row.project_id) {
        return fail('project_mismatch', `${path}.wbs_node_id`, 'budget line WBS node belongs to another project');
      }
    }
    if (row.boq_item_id !== null && row.boq_item_id !== undefined) {
      const boq = boqById.get(String(row.boq_item_id));
      if (!boq) return fail('missing_reference', `${path}.boq_item_id`, 'budget line BOQ item does not exist');
      if (boq.project_id !== row.project_id) {
        return fail('project_mismatch', `${path}.boq_item_id`, 'budget line BOQ item belongs to another project');
      }
    }
    for (const field of ['planned_cost', 'committed_cost', 'actual_cost', 'remaining_cost']) {
      const value = row[field];
      if (value !== null && value !== undefined && num(value) === null) {
        return fail('required_field', `${path}.${field}`, `${field} must be numeric or null`);
      }
    }
  }

  // --- cost transactions: boundary + Data Date chronology ----------------
  let costApproved = 0;
  let costOther = 0;
  for (let i = 0; i < tables.cost_transactions.length; i += 1) {
    const row = tables.cost_transactions[i];
    const path = `tables.cost_transactions[${i}]`;
    const amount = num(row.amount);
    if (amount === null) return fail('required_field', `${path}.amount`, 'amount must be a finite number');
    if (row.activity_id !== null && row.activity_id !== undefined) {
      const activity = activityById.get(String(row.activity_id));
      if (!activity) return fail('missing_reference', `${path}.activity_id`, 'cost transaction activity does not exist');
      if (activity.project_id !== row.project_id) {
        return fail('project_mismatch', `${path}.activity_id`, 'cost transaction activity belongs to another project');
      }
    }
    if (row.status === 'approved') costApproved += 1;
    else costOther += 1;
    if (isIsoDateValue(row.transaction_date)) {
      const project = projectById.get(String(row.project_id));
      const dataDate = project && isIsoDateValue(project.data_date) ? project.data_date : null;
      if (dataDate && row.transaction_date > dataDate) {
        return fail('chronology', path,
          `cost transaction dated ${row.transaction_date} is after the project Data Date ${dataDate}`);
      }
    }
  }

  // --- progress updates: approvals + Data Date chronology ----------------
  let progressApproved = 0;
  let progressOther = 0;
  for (let i = 0; i < tables.progress_updates.length; i += 1) {
    const row = tables.progress_updates[i];
    const path = `tables.progress_updates[${i}]`;
    const activity = activityById.get(String(row.activity_id));
    if (!activity) return fail('missing_reference', `${path}.activity_id`, 'progress update activity does not exist');
    if (activity.project_id !== row.project_id) {
      return fail('project_mismatch', `${path}.activity_id`, 'progress update activity belongs to another project');
    }
    const percent = row.percent_complete;
    if (percent !== null && percent !== undefined) {
      const value = num(percent);
      if (value === null || value < 0 || value > 100) {
        return fail('required_field', `${path}.percent_complete`, 'percent_complete must be 0..100 or null');
      }
    }
    if (row.status === 'approved') progressApproved += 1;
    else progressOther += 1;
    if (isIsoDateValue(row.update_date)) {
      const project = projectById.get(String(row.project_id));
      const projectDataDate = project && isIsoDateValue(project.data_date) ? project.data_date : null;
      if (projectDataDate && row.update_date > projectDataDate) {
        return fail('chronology', path,
          `progress update dated ${row.update_date} is after the project Data Date ${projectDataDate}`);
      }
    }
  }

  // --- baseline relationships -------------------------------------------
  for (let i = 0; i < tables.baseline_activities.length; i += 1) {
    const row = tables.baseline_activities[i];
    const path = `tables.baseline_activities[${i}]`;
    const baseline = baselineById.get(String(row.baseline_id));
    if (!baseline) return fail('missing_reference', `${path}.baseline_id`, 'baseline revision does not exist');
    const activity = activityById.get(String(row.activity_id));
    if (!activity) return fail('missing_reference', `${path}.activity_id`, 'baseline activity does not exist');
    if (activity.project_id !== baseline.project_id) {
      return fail('project_mismatch', path, 'baseline revision and its activity belong to different projects');
    }
  }
  for (const spec of ['baseline_wbs_nodes', 'baseline_boq_items', 'project_scope_baseline_current'] as const) {
    for (let i = 0; i < tables[spec].length; i += 1) {
      const row = tables[spec][i];
      if (!baselineById.has(String(row.baseline_id))) {
        return fail('missing_reference', `tables.${spec}[${i}].baseline_id`, 'baseline revision does not exist');
      }
    }
  }

  // --- auxiliary project-scoped stores ------------------------------------
  const auxiliaryInput = parsed.auxiliary;
  const auxiliary: AuxiliaryEntry[] = [];
  if (auxiliaryInput !== undefined && auxiliaryInput !== null) {
    if (!Array.isArray(auxiliaryInput)) {
      return fail('invalid_auxiliary', 'auxiliary', 'auxiliary must be an array');
    }
    const seenAuxKeys = new Set<string>();
    for (let i = 0; i < auxiliaryInput.length; i += 1) {
      const entry = auxiliaryInput[i];
      const path = `auxiliary[${i}]`;
      if (!isPlainObject(entry)) return fail('invalid_auxiliary', path, 'auxiliary entry is not an object');
      const key = entry.key;
      const raw = entry.raw;
      if (typeof key !== 'string' || key.length === 0) {
        return fail('invalid_auxiliary', `${path}.key`, 'auxiliary entry has no key');
      }
      if (!isAuxiliaryKey(key)) {
        return fail('invalid_auxiliary', `${path}.key`,
          `"${key}" is not a workspace-owned auxiliary store; unrelated browser keys are never restored`);
      }
      if (seenAuxKeys.has(key)) {
        return fail('invalid_auxiliary', `${path}.key`, `duplicate auxiliary store "${key}"`);
      }
      seenAuxKeys.add(key);
      if (typeof raw !== 'string' || raw.length === 0) {
        return fail('invalid_auxiliary', `${path}.raw`, 'auxiliary entry has no raw payload');
      }
      // The payload is opaque: `schedule_diff_revisions_*` and `construction_subcontracts_data_*` hold
      // JSON arrays, while `construction_subcontracts_db_import_*` holds a bare timestamp. The bytes
      // are restored exactly as stored, so validity of their inner format is the owning feature's
      // business — the checksum, not a guessed schema, is what detects tampering.
      const projectId = key.slice(auxiliaryPrefixOf(key)!.length) || null;
      if (projectId !== null && !projectIds.has(projectId)) {
        warnings.push(`auxiliary store "${key}" refers to project "${projectId}", which is not in this backup (kept as-is)`);
      }
      auxiliary.push({ key, projectId, raw });
    }
  }

  // --- checksum ----------------------------------------------------------
  const recomputed = backupChecksum(tables, auxiliary);
  const declared = typeof parsed.checksum === 'string' ? parsed.checksum : null;
  let checksumVerified = false;
  if (declared === null) {
    warnings.push('the backup declares no checksum; integrity could not be verified (structure was still fully validated)');
  } else if (declared !== recomputed) {
    return fail('checksum_mismatch', 'checksum',
      'the backup checksum does not match its contents; the file was modified or truncated');
  } else {
    checksumVerified = true;
  }

  const createdAt = typeof parsed.created_at === 'string' ? parsed.created_at : nowIso();
  const kind = (isPlainObject(parsed.source) && typeof parsed.source.workspace_kind === 'string'
    ? parsed.source.workspace_kind
    : 'restored') as WorkspaceKind;

  const state: WorkspaceState = {
    ...tables,
    __meta: { schema_version: WORKSPACE_SCHEMA_VERSION, workspace_kind: 'restored', created_at: createdAt },
  };

  const summary: BackupSummary = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    createdAt,
    workspaceKind: kind,
    counts: PERSISTED_TABLES.map((spec) => ({ table: spec.name, label: spec.label, rows: tables[spec.name].length })),
    totalRows: PERSISTED_TABLES.reduce((sum, spec) => sum + tables[spec.name].length, 0),
    projects: projectsSummary,
    checksum: declared ?? recomputed,
    checksumVerified,
    approvals: { progressApproved, progressOther, costApproved, costOther },
    dataDates: [...new Set(dataDates)].sort(),
    auxiliary: auxiliary.map((entry) => ({ key: entry.key, bytes: entry.raw.length })),
  };

  if (tables.projects.length === 0) {
    warnings.push('this backup contains no projects (valid, empty workspace)');
  }
  return { ok: true, errors, warnings, summary, state, auxiliary };
}

export interface RestoreResult {
  ok: boolean;
  error: string | null;
  preRestoreKey: string | null;
  preRestoreBytes: string | null;
  /** Exact bytes of the auxiliary stores the restore is about to replace (for the recovery file). */
  preRestoreAuxiliary: AuxiliaryEntry[];
  state: WorkspaceState | null;
}

/**
 * Restore a VALIDATED state. Callers must pass the state returned by `validateBackup`; this function
 * refuses anything that does not re-validate, and never mutates storage without a recoverable copy.
 *
 * Sequence: capture current bytes -> write pre-restore copy (abort if that fails) -> write the new
 * state -> verify the bytes -> roll back to the exact previous bytes on any failure.
 */
export function restoreWorkspace(
  storage: WorkspaceStorage,
  validation: BackupValidation,
  createdAt: string = nowIso(),
): RestoreResult {
  const none = (error: string): RestoreResult => ({
    ok: false,
    error,
    preRestoreKey: null,
    preRestoreBytes: null,
    preRestoreAuxiliary: [],
    state: null,
  });

  if (!validation.ok || !validation.state) {
    return none(validation.errors[0]?.message ?? 'the backup did not pass validation, nothing was restored');
  }

  // Never trust a caller-supplied state: rebuild the envelope and validate it again.
  const rebuilt = serializeBackup(buildBackup(validation.state, createdAt, validation.auxiliary));
  const revalidated = validateBackup(rebuilt);
  if (!revalidated.ok || !revalidated.state) {
    return none(revalidated.errors[0]?.message ?? 'the backup did not pass validation, nothing was restored');
  }

  let previousRaw: string | null;
  let previousAuxiliary: AuxiliaryEntry[];
  try {
    previousRaw = storage.getItem(WORKSPACE_STORAGE_KEY);
    previousAuxiliary = readAuxiliaryStores(storage);
  } catch (err) {
    return none(`complete pre-restore snapshot failed: ${String(err)}; nothing was restored`);
  }
  let preRestoreKey: string | null = null;
  const failed = (error: string): RestoreResult => ({
    ok: false, error, preRestoreKey, preRestoreBytes: previousRaw,
    preRestoreAuxiliary: previousAuxiliary, state: null,
  });
  // Preserve the historical main-byte copy contract AND a complete raw recovery archive.
  // Neither depends on the old workspace being valid JSON or on it having any projects.
  let recoveryKey = `${PRE_RESTORE_KEY_PREFIX}${stamp()}__auxiliary`;
  try {
    const baseKey = recoveryKey;
    let suffix = 0;
    while (storage.getItem(recoveryKey) !== null) recoveryKey = `${baseKey}_${++suffix}`;
    const archive = JSON.stringify({ main_workspace_bytes: previousRaw, auxiliary: previousAuxiliary });
    storage.setItem(recoveryKey, archive);
    if (storage.getItem(recoveryKey) !== archive) throw new Error('recovery archive verification failed');
    if (previousRaw !== null) {
      preRestoreKey = preserveRawBytes(storage, previousRaw, 'pre_restore');
      if (preRestoreKey === null) throw new Error('main recovery copy failed');
    }
  } catch (err) {
    return failed(`pre-restore protection failed: ${String(err)}; nothing was restored`);
  }

  const before = new Map<string, string | null>([
    [WORKSPACE_STORAGE_KEY, previousRaw],
    ...previousAuxiliary.map((e): [string, string] => [e.key, e.raw]),
  ]);
  const desired = new Map<string, string | null>([
    [WORKSPACE_STORAGE_KEY, JSON.stringify(revalidated.state)],
    ...previousAuxiliary.map((e): [string, null] => [e.key, null]),
    ...revalidated.auxiliary.map((e): [string, string] => [e.key, e.raw]),
  ]);
  const attempted: string[] = [];
  const put = (key: string, raw: string | null) => {
    if (raw === null) storage.removeItem(key);
    else storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error(`verification failed: ${key}`);
  };
  try {
    for (const [key, raw] of desired) {
      if (!before.has(key)) before.set(key, null);
      attempted.push(key); // Include a throwing write: browser adapters may mutate then throw.
      put(key, raw);
    }
    for (const [key, raw] of desired) {
      if (storage.getItem(key) !== raw) throw new Error(`final verification failed: ${key}`);
    }
    const actual = readAuxiliaryStores(storage);
    if (actual.length !== revalidated.auxiliary.length
      || actual.some(e => desired.get(e.key) !== e.raw)) throw new Error('auxiliary set verification failed');
  } catch (err) {
    const failures: string[] = [];
    for (const key of attempted.reverse()) {
      try { put(key, before.get(key) ?? null); }
      catch (rollbackError) { failures.push(`${key}: ${String(rollbackError)}`); }
    }
    return failed(`restore failed: ${String(err)}; ${failures.length
      ? `ROLLBACK FAILED: ${failures.join('; ')}` : 'rollback verified'}; recovery archive: ${recoveryKey}`);
  }

  return {
    ok: true,
    error: null,
    preRestoreKey,
    preRestoreBytes: previousRaw,
    preRestoreAuxiliary: previousAuxiliary,
    state: revalidated.state,
  };
}

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { getInitialSeedData } from './mockSeed';
import {
  applyReviewCostTransaction,
  applyScheduleRecoveryScenario,
  checkControlRecordProjectBoundary,
  unimplementedRpcError,
} from './demoDbContracts';

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

// In-memory + LocalStorage reactive mock database
const LOCAL_STORAGE_KEY = 'schedule_mgmt_db_v5';

type DbState = Record<string, Record<string, any>[]>;

function loadDb(): DbState {
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (
        parsed &&
        Array.isArray(parsed.projects) &&
        parsed.projects.length > 0 &&
        Array.isArray(parsed.activities) &&
        parsed.activities.length > 0
      ) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('LocalStorage not accessible, using memory store');
  }
  const initial = getInitialSeedData();
  saveDb(initial as unknown as DbState);
  return initial as unknown as DbState;
}

function saveDb(data: DbState): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to save to localStorage');
  }
}

export function resetDemoDatabase(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch (e) {
    // Ignore
  }
  const initial = getInitialSeedData();
  saveDb(initial as unknown as DbState);
  window.location.reload();
}

class MockQueryBuilder<T = any> implements PromiseLike<{ data: any; error: any }> {
  private tableName: string;
  private filters: Array<(item: Record<string, any>) => boolean> = [];
  private orderConfig: { col: string; ascending: boolean } | null = null;
  private limitCount: number | null = null;
  private action: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: any = null;
  private upsertOptions: { onConflict?: string } | undefined;
  private returnSingle = false;
  private returnMaybeSingle = false;

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  select(_columns = '*') {
    return this;
  }

  eq(column: string, value: any) {
    this.filters.push((item) => {
      if (column.includes('.')) {
        const parts = column.split('.');
        const direct = item[parts[0]];
        if (direct && typeof direct === 'object') {
          return direct[parts[1]] === value;
        }
        // REVIEW FINDING 2 (defence in depth): this returned `true`, i.e. a row whose joined parent is
        // absent or null PASSED the filter. That is the opposite of PostgREST `!inner` semantics,
        // where a row with no matching parent is excluded — so it failed OPEN on exactly the rows the
        // governed baseline query exists to keep out: a `baseline_activities` row whose `baseline_id`
        // no longer resolves (deleted or never-existing `project_baselines` revision) sailed through
        // `.eq('project_baselines.project_id', …)` and into F6's BAC basis. Now it fails CLOSED,
        // matching the real database. Every dot-notation `eq` in the app is a governed
        // `project_baselines!inner` baseline query, so this narrows only those, and every seeded
        // baseline row resolves to a real revision — no legitimate row is dropped.
        return false;
      }
      return item[column] === value;
    });
    return this;
  }

  in(column: string, values: any[]) {
    this.filters.push((item) => values.includes(item[column]));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderConfig = {
      col: column,
      ascending: options?.ascending !== false,
    };
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.returnSingle = true;
    return this;
  }

  maybeSingle() {
    this.returnMaybeSingle = true;
    return this;
  }

  insert(records: any) {
    this.action = 'insert';
    this.payload = records;
    return this;
  }

  upsert(records: any, options?: { onConflict?: string }) {
    this.action = 'upsert';
    this.payload = records;
    this.upsertOptions = options;
    return this;
  }

  update(updateFields: any) {
    this.action = 'update';
    this.payload = updateFields;
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  private execute(): { data: any; error: any } {
    const db = loadDb();
    const table = db[this.tableName] || [];

    if (this.action === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = items.map((item) => ({
        id: item.id || `rec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        created_at: item.created_at || new Date().toISOString(),
        ...item,
      }));
      // P2A1-M02: mirror the live `validate_cost_project` trigger (`validate_project_boundaries()`).
      // A cost transaction that names an activity which does not exist, or which belongs to another
      // project, raises 'Control record crosses project boundary' BEFORE the row is written. Demo
      // mode used to accept it silently, and canonical AC then summed it. One failing row fails the
      // whole statement, exactly as the database would roll the statement back.
      if (this.tableName === 'cost_transactions') {
        for (const item of inserted) {
          const { error } = checkControlRecordProjectBoundary(db, 'cost_transactions', item);
          if (error) return { data: null, error };
        }
      }
      db[this.tableName] = [...table, ...inserted];
      saveDb(db);
      const res = Array.isArray(this.payload) ? inserted : inserted[0];
      return { data: res, error: null };
    }

    if (this.action === 'upsert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const conflictKeys = (this.upsertOptions?.onConflict || 'id').split(',').map((k) => k.trim());
      const currentTable = [...table];

      for (const item of items) {
        const matchIndex = currentTable.findIndex((existing) =>
          conflictKeys.every((k) => existing[k] !== undefined && String(existing[k]) === String(item[k])),
        );

        const recordToSave = {
          id: item.id || (matchIndex >= 0 ? currentTable[matchIndex].id : `rec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`),
          created_at: (matchIndex >= 0 ? currentTable[matchIndex].created_at : undefined) || new Date().toISOString(),
          ...item,
        };

        if (matchIndex >= 0) {
          currentTable[matchIndex] = { ...currentTable[matchIndex], ...recordToSave };
        } else {
          currentTable.push(recordToSave);
        }
      }

      db[this.tableName] = currentTable;
      saveDb(db);
      return { data: items, error: null };
    }

    if (this.action === 'update') {
      let updatedItems: any[] = [];
      const updatedTable = table.map((item) => {
        const matches = this.filters.length === 0 || this.filters.every((f) => f(item));
        if (matches) {
          const updated = { ...item, ...this.payload };
          updatedItems.push(updated);
          return updated;
        }
        return item;
      });
      // P2A1-M02: the trigger is BEFORE INSERT OR UPDATE, so the NEW row (the merged result) is what
      // the boundary is evaluated against — re-pointing a row at another project's activity fails.
      if (this.tableName === 'cost_transactions') {
        for (const item of updatedItems) {
          const { error } = checkControlRecordProjectBoundary(db, 'cost_transactions', item);
          if (error) return { data: null, error };
        }
      }
      db[this.tableName] = updatedTable;
      saveDb(db);
      return { data: updatedItems, error: null };
    }

    if (this.action === 'delete') {
      const remaining = table.filter((item) => !this.filters.every((f) => f(item)));
      db[this.tableName] = remaining;
      saveDb(db);
      return { data: null, error: null };
    }

    // Default: select
    let records = table.map((r) => ({ ...r }));

    // Relations
    records = records.map((record) => {
      const enriched = { ...record };
      if (this.tableName === 'activities' && record.wbs_node_id) {
        const wbs = (db['wbs_nodes'] || []).find((w) => w.id === record.wbs_node_id);
        enriched.wbs_node = wbs ? { ...wbs } : null;
      }
      if (this.tableName === 'activity_resources' && record.resource_id) {
        const rsrc = (db['resources'] || []).find((r) => r.id === record.resource_id);
        enriched.resource = rsrc ? { ...rsrc } : null;
      }
      if (this.tableName === 'activity_links') {
        enriched.predecessor = (db['activities'] || []).find((a) => a.id === record.predecessor_id) || null;
        enriched.successor = (db['activities'] || []).find((a) => a.id === record.successor_id) || null;
      }
      if (this.tableName === 'baseline_activities' && record.baseline_id) {
        const base = (db['project_baselines'] || []).find((b) => b.id === record.baseline_id);
        enriched.project_baselines = base ? { ...base } : null;
      }
      return enriched;
    });

    for (const filter of this.filters) {
      records = records.filter(filter);
    }

    if (this.orderConfig) {
      const { col, ascending } = this.orderConfig;
      records.sort((a, b) => {
        const valA = a[col];
        const valB = b[col];
        if (valA === valB) return 0;
        if (valA === null || valA === undefined) return 1;
        if (valB === null || valB === undefined) return -1;
        if (typeof valA === 'number' && typeof valB === 'number') {
          return ascending ? valA - valB : valB - valA;
        }
        return ascending ? String(valA).localeCompare(String(valB)) : String(valB).localeCompare(String(valA));
      });
    }

    if (this.limitCount !== null) {
      records = records.slice(0, this.limitCount);
    }

    if (this.returnSingle) {
      return {
        data: records[0] || null,
        error: records.length === 0 ? { message: 'Row not found' } : null,
      };
    }

    if (this.returnMaybeSingle) {
      return {
        data: records[0] || null,
        error: null,
      };
    }

    return { data: records as any, error: null };
  }

  then<TResult1 = { data: any; error: any }>(
    onfulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<TResult1> {
    const result = this.execute();
    return Promise.resolve(onfulfilled ? onfulfilled(result) : (result as unknown as TResult1));
  }
}

const mockRpc = async (fnName: string, params: any) => {
  const db = loadDb();
  if (fnName === 'approve_progress_update') {
    const update = (db['progress_updates'] || []).find((p) => p.id === params.p_update_id);
    if (update) {
      update.status = 'approved';
      update.approved_at = new Date().toISOString();
      const activity = (db['activities'] || []).find((a) => a.id === update.activity_id);
      if (activity) {
        activity.percent_complete = update.percent_complete;
        activity.actual_quantity = update.actual_quantity;
      }
      saveDb(db);
    }
    return { data: true, error: null };
  }
  // F9.4 (Controlled Pilot defect 2): the cost-transaction review procedure is now implemented
  // against the demo store, mirroring `review_cost_transaction` from
  // 20260908004500_governed_reviews_and_resources.sql statement for statement. Previously this
  // function name fell through to the unconditional `{ data: true, error: null }` below, so pressing
  // Approve reported success while writing nothing — the row stayed Pending and no error surfaced.
  if (fnName === 'review_cost_transaction') {
    const result = applyReviewCostTransaction(db, params, new Date().toISOString());
    // Persist only a write that actually happened; a rejected contract must not touch the store.
    if (!result.error) saveDb(db);
    return result;
  }
  if (fnName === 'apply_schedule_recovery_scenario') {
    const result = applyScheduleRecoveryScenario(db, params);
    // The contract stages all rows privately and mutates the store only on full success; saveDb is
    // therefore one local commit and an RPC error leaves LocalStorage untouched.
    if (!result.error) saveDb(db);
    return result;
  }
  // An RPC this store does not implement is a FAILURE, not a success. Returning `{ data: true }`
  // here is what made the approval defect invisible: the caller gates on `error`, so a false success
  // is indistinguishable from a committed write. The message names the function that is missing.
  return unimplementedRpcError(fnName);
};

export const supabase: any = hasValidSupabaseEnv
  ? createSupabaseClient(envUrl, envAnonKey, { auth: { persistSession: false } })
  : {
      from: (tableName: string) => new MockQueryBuilder(tableName),
      rpc: mockRpc,
    };

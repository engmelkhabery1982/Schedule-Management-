/**
 * S29 (SCH-20261027-SAFETY) — the demo store's query builder, extracted from `supabase.ts` so it is
 * testable without Supabase, React or a browser.
 *
 * The builder is unchanged in behaviour EXCEPT for the one thing this task repairs: every write goes
 * through `LocalWorkspacePort.commit`, which only reports success once the bytes are on the disk and
 * have been read back. A denied or quota-exceeded write, or a damaged workspace, therefore returns an
 * `{ error }` that callers already know how to gate on — instead of the old silent success.
 *
 * `commit` also gives the builder statement atomicity: the mutation runs against a deep clone that is
 * discarded unless the whole statement is both accepted (contract validation) and persisted.
 */

import { setTableRows, tableRows, type WorkspaceMutateResult, type WorkspaceRow, type WorkspaceState, type WorkspaceWriteError } from './localWorkspace';
import { checkControlRecordProjectBoundary } from './demoDbContracts';

export type LocalQueryError = WorkspaceWriteError;

export interface LocalQueryResult<T = unknown> {
  data: T;
  error: LocalQueryError | null;
}

export interface LocalWorkspacePort {
  /** Current state, or an error message when the workspace cannot be read at all. */
  read(): { state: WorkspaceState; error: LocalQueryError | null };
  /** Atomic write; resolves `{ error }` unless the mutation was persisted and verified. */
  commit(mutate: (draft: WorkspaceState) => WorkspaceMutateResult<unknown>): { data: unknown; error: LocalQueryError | null };
}

type Row = WorkspaceRow;

function newRowId(): string {
  return `rec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

function rowsOf(state: WorkspaceState, table: string): Row[] {
  return tableRows(state, table);
}

function validationError(message: string): LocalQueryError {
  return { message, kind: 'validation' };
}

export class MockQueryBuilder<T = unknown> implements PromiseLike<LocalQueryResult<T>> {
  private tableName: string;
  private io: LocalWorkspacePort;
  private filters: Array<(item: Row) => boolean> = [];
  private orderConfig: { col: string; ascending: boolean } | null = null;
  private limitCount: number | null = null;
  private action: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: unknown = null;
  private upsertOptions: { onConflict?: string } | undefined;
  private returnSingle = false;
  private returnMaybeSingle = false;

  constructor(tableName: string, io: LocalWorkspacePort) {
    this.tableName = tableName;
    this.io = io;
  }

  select(columns = '*') {
    // Column projection is not modelled by the demo store: every read returns whole rows, exactly as
    // before. The parameter is accepted (and referenced) so the call signature matches supabase-js.
    void columns;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((item) => {
      if (column.includes('.')) {
        const parts = column.split('.');
        const direct = item[parts[0]];
        if (direct && typeof direct === 'object') {
          return (direct as Record<string, unknown>)[parts[1]] === value;
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

  in(column: string, values: unknown[]) {
    this.filters.push((item) => values.includes(item[column]));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderConfig = { col: column, ascending: options?.ascending !== false };
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

  insert(records: unknown) {
    this.action = 'insert';
    this.payload = records;
    return this;
  }

  upsert(records: unknown, options?: { onConflict?: string }) {
    this.action = 'upsert';
    this.payload = records;
    this.upsertOptions = options;
    return this;
  }

  update(updateFields: unknown) {
    this.action = 'update';
    this.payload = updateFields;
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  private matchesFilters(item: Row): boolean {
    return this.filters.every((f) => f(item));
  }

  private write(): LocalQueryResult<T> {
    const mutation = this.io.commit((draft) => this.applyWrite(draft));
    if (mutation.error) return { data: null as unknown as T, error: mutation.error };
    return { data: mutation.data as unknown as T, error: null };
  }

  /** The statement itself, applied to the draft state. Errors here abort the whole statement. */
  private applyWrite(draft: WorkspaceState): WorkspaceMutateResult<unknown> {
    const table = rowsOf(draft, this.tableName);

    if (this.action === 'insert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const inserted = items.map((item) => ({
        id: item.id || newRowId(),
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
          const { error } = checkControlRecordProjectBoundary(draft as unknown as Record<string, Record<string, unknown>[]>, 'cost_transactions', item);
          if (error) return { ok: false, error: validationError(`${error.message} — ${error.details}`) };
        }
      }
      setTableRows(draft, this.tableName, [...table, ...inserted]);
      return { ok: true, data: Array.isArray(this.payload) ? inserted : inserted[0] };
    }

    if (this.action === 'upsert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const conflictKeys = (this.upsertOptions?.onConflict || 'id').split(',').map((k) => k.trim());
      const currentTable = [...table];

      for (const item of items) {
        const matchIndex = currentTable.findIndex((existing) =>
          conflictKeys.every((k) => existing[k] !== undefined && String(existing[k]) === String(item[k])),
        );
        const recordToSave: Row = {
          id: item.id || (matchIndex >= 0 ? currentTable[matchIndex].id : newRowId()),
          created_at: (matchIndex >= 0 ? currentTable[matchIndex].created_at : undefined) || new Date().toISOString(),
          ...item,
        };
        if (matchIndex >= 0) currentTable[matchIndex] = { ...currentTable[matchIndex], ...recordToSave };
        else currentTable.push(recordToSave);
      }

      setTableRows(draft, this.tableName, currentTable);
      return { ok: true, data: items };
    }

    if (this.action === 'update') {
      const updatedItems: Row[] = [];
      const updatedTable = table.map((item) => {
        if (this.filters.length === 0 || this.matchesFilters(item)) {
          const updated = { ...item, ...(this.payload as Row) };
          updatedItems.push(updated);
          return updated;
        }
        return item;
      });
      // P2A1-M02: the trigger is BEFORE INSERT OR UPDATE, so the NEW row (the merged result) is what
      // the boundary is evaluated against — re-pointing a row at another project's activity fails.
      if (this.tableName === 'cost_transactions') {
        for (const item of updatedItems) {
          const { error } = checkControlRecordProjectBoundary(draft as unknown as Record<string, Record<string, unknown>[]>, 'cost_transactions', item);
          if (error) return { ok: false, error: validationError(`${error.message} — ${error.details}`) };
        }
      }
      setTableRows(draft, this.tableName, updatedTable);
      return { ok: true, data: updatedItems };
    }

    // delete
    const remaining = table.filter((item) => !this.matchesFilters(item));
    setTableRows(draft, this.tableName, remaining);
    return { ok: true, data: null };
  }

  private read(): LocalQueryResult<T> {
    const { state, error } = this.io.read();
    if (error) return { data: null as unknown as T, error };

    const table = rowsOf(state, this.tableName);
    let records: Row[] = table.map((r) => ({ ...r }));

    // Relations
    records = records.map((record) => {
      const enriched: Row = { ...record };
      if (this.tableName === 'activities' && record.wbs_node_id) {
        const wbs = rowsOf(state, 'wbs_nodes').find((w) => w.id === record.wbs_node_id);
        enriched.wbs_node = wbs ? { ...wbs } : null;
      }
      if (this.tableName === 'activity_resources' && record.resource_id) {
        const rsrc = rowsOf(state, 'resources').find((r) => r.id === record.resource_id);
        enriched.resource = rsrc ? { ...rsrc } : null;
      }
      if (this.tableName === 'activity_links') {
        enriched.predecessor = rowsOf(state, 'activities').find((a) => a.id === record.predecessor_id) || null;
        enriched.successor = rowsOf(state, 'activities').find((a) => a.id === record.successor_id) || null;
      }
      if (this.tableName === 'baseline_activities' && record.baseline_id) {
        const base = rowsOf(state, 'project_baselines').find((b) => b.id === record.baseline_id);
        enriched.project_baselines = base ? { ...base } : null;
      }
      return enriched;
    });

    for (const filter of this.filters) records = records.filter(filter);

    if (this.orderConfig) {
      const { col, ascending } = this.orderConfig;
      records.sort((a, b) => {
        const valA = a[col];
        const valB = b[col];
        if (valA === valB) return 0;
        if (valA === null || valA === undefined) return 1;
        if (valB === null || valB === undefined) return -1;
        if (typeof valA === 'number' && typeof valB === 'number') return ascending ? valA - valB : valB - valA;
        return ascending ? String(valA).localeCompare(String(valB)) : String(valB).localeCompare(String(valA));
      });
    }

    if (this.limitCount !== null) records = records.slice(0, this.limitCount);

    if (this.returnSingle) {
      return {
        data: (records[0] || null) as unknown as T,
        error: records.length === 0 ? { message: 'Row not found', kind: 'validation' as const } : null,
      };
    }
    if (this.returnMaybeSingle) {
      return { data: (records[0] || null) as unknown as T, error: null };
    }
    return { data: records as unknown as T, error: null };
  }

  private execute(): LocalQueryResult<T> {
    if (this.action === 'select') return this.read();
    return this.write();
  }

  then<TResult1 = LocalQueryResult<T>>(
    onfulfilled?: ((value: LocalQueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<TResult1> {
    const result = this.execute();
    return Promise.resolve(onfulfilled ? onfulfilled(result) : (result as unknown as TResult1));
  }
}

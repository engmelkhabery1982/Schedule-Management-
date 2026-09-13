-- inspection_requests schema drift — the table does not accept the payload the application writes.
--
-- EVIDENCE (exact current insert payload, inspected before choosing columns)
--   src/components/views/ProgressView.tsx, submitInspection():
--     supabase.from('inspection_requests').insert({
--       project_id, request_number, activity_id, boq_item_id, inspection_date,
--       inspected_quantity, approved_quantity, parent_reference, notes, status,
--       executor_type, subcontractor_id, subcontractor_name, zone_or_scope,
--       subcontract_unit_rate, client_unit_rate, subcontractor_cost, client_earned_value,
--       profit_margin_sar })
--   The first ten columns exist (20260908001500_cost_and_inspection_control.sql). The last nine do
--   not, so every WIR submission against a real Supabase database fails with an unknown-column
--   error while appearing to work against the in-memory demo store.
--   src/types/index.ts InspectionRequest already declares exactly those nine fields as optional
--   (`executor_type?`, `subcontractor_id?: string | null`, `subcontract_unit_rate?: number`, ...),
--   i.e. the application treats them as nullable. Readers (ProgressView archive/history tables and
--   approveInspection) use `req.<field> || <derived>` fallbacks, so a NULL row behaves exactly like
--   the absent key the mock returns today.
--   20260913090100_add_progress_update_execution_fields.sql added the same nine fields to
--   progress_updates and explicitly deferred inspection_requests to this commercial wave.
--
-- TYPE DECISIONS — identical to progress_updates, on purpose
--   * text for executor_type / subcontractor_id / subcontractor_name / zone_or_scope.
--     subcontractor_id stays TEXT (not uuid): the values are subcontract package business codes
--     ('SUB-PKG-01'), the same convention documented in the progress_updates migration and now
--     backed by subcontract_packages.code (20260913130000_add_subcontract_commercial_tables.sql).
--   * numeric(15,2) for subcontract_unit_rate / client_unit_rate / subcontractor_cost /
--     client_earned_value / profit_margin_sar — the house standard for SAR amounts, and the same
--     type as the matching progress_updates columns, so a value copied from an inspection into a
--     progress update keeps its precision. No floats hold money.
--   * profit_margin_sar may legitimately be NEGATIVE (a loss-making package) so no CHECK (>= 0);
--     subcontractor_cost / client_earned_value are amounts produced from quantity * rate and are
--     left unconstrained rather than inventing a rule the application does not enforce.
--   * executor_type gets the same two-value CHECK as progress_updates ('self_direct',
--     'subcontractor'); NULL passes, so rows recorded before this migration stay valid.
--
-- NULLABILITY — no NOT NULL and no DEFAULT, same reasoning as the progress_updates migration:
--   existing inspection rows predate these fields, so their true values are UNKNOWN. `DEFAULT 0`
--   would backfill fabricated financial zeros into historical commercial records, and NOT NULL
--   would reject writers that legitimately omit a field (subcontract_unit_rate is written as
--   `undefined` for self-direct work, which Supabase strips from the payload).
--
-- GAP-020 NOTE
--   These columns are where an unpriced subcontract shows up as NULL. The application no longer
--   substitutes 70% of the client rate for a missing subcontract rate; a NULL rate/cost/margin is
--   the persisted form of the explicit "unpriced (N/A)" state.
--
-- COMPATIBILITY FK (option A of the wave brief)
--   subcontract_package_id uuid is added next to the TEXT subcontractor_id so new writes can carry
--   the relational link while every existing code-based reference keeps working. Nullable,
--   ON DELETE SET NULL, no backfill, no reinterpretation of existing text values.
--
-- NOT ADDED (reported)
--   * retention_deducted: written to progress_updates (three ProgressView sites) but never to
--     inspection_requests, so no column is created for it.
--   * No change to boq_item_id. It is declared uuid with an FK to boq_items, while the payload
--     writes `inspectionForm.boq_item_id || act?.code || null` — i.e. it can fall back to an
--     activity/BOQ CODE string, which a uuid column rejects. Changing that column's type (or the
--     payload's meaning) is a breaking data decision outside this wave's "add only required
--     columns" scope; it is reported as unresolved commercial-data ambiguity.

ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS executor_type text;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS subcontractor_id text;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS subcontractor_name text;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS zone_or_scope text;
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS subcontract_unit_rate numeric(15,2);
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS client_unit_rate numeric(15,2);
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS subcontractor_cost numeric(15,2);
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS client_earned_value numeric(15,2);
ALTER TABLE inspection_requests ADD COLUMN IF NOT EXISTS profit_margin_sar numeric(15,2);

ALTER TABLE inspection_requests DROP CONSTRAINT IF EXISTS inspection_requests_executor_type_check;
ALTER TABLE inspection_requests ADD CONSTRAINT inspection_requests_executor_type_check
  CHECK (executor_type IN ('self_direct', 'subcontractor'));

ALTER TABLE inspection_requests
  ADD COLUMN IF NOT EXISTS subcontract_package_id uuid REFERENCES subcontract_packages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inspection_requests_subcontract_package
  ON inspection_requests(subcontract_package_id);

-- The inspection_requests RLS policy is `USING (true) WITH CHECK (true)` and column-agnostic, and
-- record_audit_event() stores to_jsonb(NEW), so the audit trail picks the new columns up with no
-- policy or procedure edit.

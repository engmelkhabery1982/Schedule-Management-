-- GAP-033 (High) — progress_updates is missing the execution / commercial columns that the
-- application already writes, so every real insert against Supabase fails with an
-- unknown-column error.
--
-- EVIDENCE (inspected before choosing types and nullability)
--   src/types/index.ts  ProgressUpdate declares these fields as OPTIONAL (`?`), several as
--     `string | null` / `number`, i.e. the application treats them as nullable.
--   Writers — src/components/views/ProgressView.tsx:
--     line ~354 single daily entry      -> executor_type, subcontractor_id, subcontractor_name,
--                                          subcontract_unit_rate, client_unit_rate,
--                                          subcontractor_cost, client_earned_value,
--                                          profit_margin_sar, retention_deducted
--     line ~456 bulk daily entry sheet  -> same nine fields
--     line ~623 approved inspection     -> the same nine fields PLUS zone_or_scope
--   Because ProgressView writes zone_or_scope into progress_updates, it is added here even
--   though it was not in the original nine-field list: the acceptance requirement is that the
--   table accepts the fields ProgressView currently writes.
--   Readers (ProgressView lines ~250, ~284, ~594, ~2377, ~2663) use `value || derived`
--   fallbacks, so a NULL coming back from the database behaves exactly like the absent key the
--   in-memory mock returns today.
--
-- TYPE DECISIONS
--   * subcontractor_id is TEXT, not uuid. The values are subcontract package business codes
--     ('SUB-PKG-01', 'SUB-PKG-02', 'SUB-PKG-03' from src/lib/subcontractEngine.ts) and the
--     field is user-editable free text in the ProgressView executor selector. A uuid column
--     would reject every current insert.
--   * No foreign key is added for subcontractor_id: there is no subcontractor / subcontract
--     package table in the schema (verified across all migrations) and this wave must not
--     create one. When the commercial data-model wave introduces that table, this column
--     should be migrated to a uuid FK — flagged as a follow-up because it is a breaking change
--     requiring data migration.
--   * Monetary and unit-rate columns use numeric(15,2), the documented house standard for SAR
--     amounts ("All monetary values stored as numeric(15,2) in SAR") and the same type already
--     used by resources.unit_rate and cost_transactions.unit_rate. No float/double precision
--     anywhere: floats must not hold money. The application rounds these values with
--     Math.round() before writing, so the 2-decimal scale loses nothing.
--   * profit_margin_sar is client_earned_value - subcontractor_cost and can legitimately be
--     NEGATIVE (a loss-making package), so no CHECK (>= 0) is added. retention_deducted is a
--     deduction amount and is likewise left unconstrained rather than inventing a rule.
--   * executor_type gets a CHECK for the two values the application can emit
--     ('self_direct', 'subcontractor'); NULL passes the constraint, so existing rows and
--     records that omit the field remain valid.
--
-- NULLABILITY — deliberately no NOT NULL and no DEFAULT
--   Existing progress_updates rows were recorded before these fields existed, so their true
--   values are UNKNOWN. A `DEFAULT 0` would backfill fabricated financial zeros into historical
--   cost/revenue records; a NOT NULL would reject writers that legitimately omit a field
--   (subcontract_unit_rate is written as `undefined` for self-direct work, which Supabase
--   strips from the payload). Every new column is therefore nullable with no default.
--
-- RLS / POLICIES / INDEXES / PROCEDURES — inspected, nothing needed
--   * The progress_updates policy is `USING (true) WITH CHECK (true)`; it is column-agnostic,
--     so no policy change is required for the new columns.
--   * No index is added: every query against progress_updates in the application filters by
--     project_id (plus status / update_date ordering) and never by these columns.
--   * approve_progress_update() declares `progress_updates%ROWTYPE` and record_audit_event()
--     stores to_jsonb(NEW), so both adapt to the new columns automatically; the audit trail
--     starts capturing them with no procedure edit.
--   * The existing progress_updates_progress_check and progress_updates_status_check
--     constraints do not reference the new columns and are left untouched.
--
-- NOT ADDED (reported, out of this wave)
--   * ProgressUpdate also declares subcontract_item_id, but nothing in the application ever
--     writes it, so no column is created for it (speculative schema growth).
--   * inspection_requests receives the same class of fields from ProgressView (~line 528) and
--     is missing them too. That is subcontract persistence (GAP-019), explicitly deferred to
--     the later commercial/data-model wave, so it is reported and not fixed here.

ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS executor_type text;
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS subcontractor_id text;
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS subcontractor_name text;
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS zone_or_scope text;
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS subcontract_unit_rate numeric(15,2);
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS client_unit_rate numeric(15,2);
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS subcontractor_cost numeric(15,2);
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS client_earned_value numeric(15,2);
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS profit_margin_sar numeric(15,2);
ALTER TABLE progress_updates ADD COLUMN IF NOT EXISTS retention_deducted numeric(15,2);

ALTER TABLE progress_updates DROP CONSTRAINT IF EXISTS progress_updates_executor_type_check;
ALTER TABLE progress_updates ADD CONSTRAINT progress_updates_executor_type_check
  CHECK (executor_type IN ('self_direct', 'subcontractor'));

-- GAP-019 (High) — the commercial subcontract source of truth is the browser, not the database.
--
-- EVIDENCE (inspected before designing the schema)
--   src/lib/subcontractEngine.ts
--     STORAGE_KEY = 'construction_subcontracts_data'; getSubcontractPackages(projectId) reads
--     localStorage[`construction_subcontracts_data_<projectId>`] and otherwise returns the module
--     constant DEFAULT_SUBCONTRACTS (4 packages). saveSubcontractPackages() writes that same key.
--     Consequences: per-browser data, no audit trail, no referential integrity, no project
--     isolation (DEFAULT_SUBCONTRACTS is returned for EVERY project id), and two equal-priority
--     writable stores (DB for cost_transactions / progress_updates, localStorage for packages).
--   src/types/index.ts — SubcontractPackage / SubcontractBoqItem declare the exact field list this
--     schema has to carry: package identity (id, subcontractNumber, subcontractorName,
--     contactPerson, phone, trade, contractDate, scopeDescription, status), contractual money
--     (totalSubcontractValueSar, totalClientEquivalentValueSar), contractual retention
--     (retentionPercent) and the item list (boqCode, description, unit, assignedQuantity,
--     subcontractRateSar, clientRateSar, linkedActivityCode, executedQuantity, zoneOrScope,
--     quotaPercent).
--   Writers: src/components/views/ProgressView.tsx (approved inspection increments an item's
--     executedQuantity), src/components/views/BoqView.tsx (creates packages, assigns BOQ items).
--   Readers: ProgressView subcontract ledger, BoqView subcontract BOQ tab,
--     src/lib/dataGovernanceEngine.ts (FIDIC commercial pillar).
--   Verified across all existing migrations: no subcontract / subcontractor table exists, which is
--     also why 20260913090100_add_progress_update_execution_fields.sql had to leave
--     progress_updates.subcontractor_id as TEXT without a foreign key. That migration flagged this
--     table as the follow-up; this is it.
--
-- ID / BUSINESS-KEY STRATEGY (reported, option A of the wave brief)
--   Existing references are business codes, not UUIDs: package ids 'SUB-PKG-01'..'SUB-PKG-04' and
--   progress_updates.subcontractor_id / inspection_requests.subcontractor_id hold those same codes.
--   Reinterpreting a 'SUB-PKG-01' string as a uuid would fail, so:
--     * subcontract_packages.id   = uuid internal PK (new, database-generated)
--     * subcontract_packages.code = the business code, UNIQUE per project (carries 'SUB-PKG-01')
--     * subcontract_items.id      = uuid internal PK
--     * subcontract_items.code    = the business item code ('SUB-ITM-01'), UNIQUE per package
--   The application keeps using the business code as its in-memory identity
--   (SubcontractPackage.id === code) so no existing payload, selector default ('SUB-PKG-01') or
--   stored progress_updates row changes meaning. progress_updates / inspection_requests keep their
--   TEXT subcontractor_id as a compatibility field and gain a nullable
--   subcontract_package_id uuid FK for relational integrity going forward (see the ALTERs at the
--   end of this file and in 20260913130100_add_inspection_request_commercial_fields.sql).
--   No existing value is rewritten and no code string is parsed as a uuid.
--
-- TYPE DECISIONS
--   * Money and unit rates are numeric(15,2) — the documented house standard for SAR amounts, the
--     same type used by cost_transactions.amount and progress_update commercial columns. No floats.
--   * Quantities are numeric(15,3), matching activities.planned_quantity / actual_quantity and
--     inspection_requests.inspected_quantity.
--   * retention_percent is numeric(5,2) and NULLABLE with no default on purpose (GAP-020). A
--     `DEFAULT 10` would re-create the hardcoded 10% deduction this wave removes: an unknown
--     contractual retention must stay unknown (the application reports N/A) instead of silently
--     becoming 10%. 0 is a legitimate contractual value (retention-free package) and is therefore
--     allowed by the CHECK.
--   * subcontract_rate_sar / client_rate_sar are NULLABLE with no default (GAP-020): a missing rate
--     means "unpriced", which the application must surface as N/A. `DEFAULT 0` would turn an
--     unpriced item into a free one and fabricate a 100% margin.
--   * Derived money is deliberately NOT stored: item contract amounts
--     (assigned_quantity * subcontract_rate_sar), executed amounts
--     (executed_quantity * subcontract_rate_sar), client equivalents, expected profit and margin
--     percentages are computed by src/lib/commercialControlsEngine.ts. Storing them next to their
--     inputs is exactly how the IPC header/line drift (GAP-018) appears.
--   * value_basis distinguishes the two legitimate package-amount rules the commercial policy
--     allows: 'itemized' (package amount must equal the sum of item contract amounts) and
--     'lump_sum' (a documented lump sum overrides the item sum). Default 'itemized'.
--   * execution_status on items separates planned / submitted / approved / certified (GAP-021) so a
--     quantity can exist without being an actual. Default 'planned' — a newly created item is not an
--     executed actual until it is approved.
--   * execution_date is the date the executed quantity was achieved/approved. Records treated as
--     actual at the governed Data Date must have execution_date <= Data Date; the application
--     enforces and reports this (GAP-021). No CHECK against a data date is added here because the
--     Data Date lives on projects and moves; a trigger comparing to a mutable column would reject
--     legitimate historical corrections.
--   * linked_activity_code / boq_code are kept as TEXT business codes (the current model uses
--     'ACT-002' / 'CW-003' style codes) AND nullable uuid FKs are added alongside them
--     (linked_activity_id, boq_item_id) so relational integrity is available without breaking any
--     existing text reference. ON DELETE SET NULL: losing an activity must not delete a commercial
--     record.
--   * status vocabulary: 'planned' is added to the application's existing
--     ('active','completed','suspended') because GAP-021 requires future packages to be
--     distinguishable from executed ones; 'terminated' is included as the standard FIDIC outcome.
--
-- NOT ADDED (reported, deliberately)
--   * No advance-payment / advance-recovery columns: SubcontractPackage models no advance terms
--     today (only the main-contractor PaymentCertificate does), and inventing contractual rules is
--     out of scope. Net payable therefore deducts retention and recorded other deductions only.
--   * No subcontractor master table: the current model stores the subcontractor name/contact on the
--     package. Normalising it would require a data migration and an identity decision that is not
--     part of this wave.
--   * No historical rewrite: this is a new migration only.

CREATE TABLE IF NOT EXISTS subcontract_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  subcontract_number text,
  subcontractor_name text NOT NULL,
  contact_person text,
  phone text,
  trade text,
  scope_description text,
  contract_date date,
  status text NOT NULL DEFAULT 'active',
  total_subcontract_value_sar numeric(15,2),
  total_client_equivalent_value_sar numeric(15,2),
  value_basis text NOT NULL DEFAULT 'itemized',
  retention_percent numeric(5,2),
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, code)
);

ALTER TABLE subcontract_packages DROP CONSTRAINT IF EXISTS subcontract_packages_status_check;
ALTER TABLE subcontract_packages ADD CONSTRAINT subcontract_packages_status_check
  CHECK (status IN ('planned', 'active', 'completed', 'suspended', 'terminated'));

ALTER TABLE subcontract_packages DROP CONSTRAINT IF EXISTS subcontract_packages_value_basis_check;
ALTER TABLE subcontract_packages ADD CONSTRAINT subcontract_packages_value_basis_check
  CHECK (value_basis IN ('itemized', 'lump_sum'));

ALTER TABLE subcontract_packages DROP CONSTRAINT IF EXISTS subcontract_packages_retention_range;
ALTER TABLE subcontract_packages ADD CONSTRAINT subcontract_packages_retention_range
  CHECK (retention_percent IS NULL OR (retention_percent >= 0 AND retention_percent <= 100));

ALTER TABLE subcontract_packages DROP CONSTRAINT IF EXISTS subcontract_packages_value_non_negative;
ALTER TABLE subcontract_packages ADD CONSTRAINT subcontract_packages_value_non_negative
  CHECK (
    (total_subcontract_value_sar IS NULL OR total_subcontract_value_sar >= 0)
    AND (total_client_equivalent_value_sar IS NULL OR total_client_equivalent_value_sar >= 0)
  );

CREATE TABLE IF NOT EXISTS subcontract_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES subcontract_packages(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  boq_item_id uuid REFERENCES boq_items(id) ON DELETE SET NULL,
  boq_code text,
  linked_activity_id uuid REFERENCES activities(id) ON DELETE SET NULL,
  linked_activity_code text,
  description text NOT NULL,
  unit text,
  assigned_quantity numeric(15,3) NOT NULL DEFAULT 0,
  subcontract_rate_sar numeric(15,2),
  client_rate_sar numeric(15,2),
  executed_quantity numeric(15,3) NOT NULL DEFAULT 0,
  execution_status text NOT NULL DEFAULT 'planned',
  execution_date date,
  zone_or_scope text,
  quota_percent numeric(5,2),
  created_at timestamptz DEFAULT now(),
  UNIQUE(package_id, code)
);

ALTER TABLE subcontract_items DROP CONSTRAINT IF EXISTS subcontract_items_execution_status_check;
ALTER TABLE subcontract_items ADD CONSTRAINT subcontract_items_execution_status_check
  CHECK (execution_status IN ('planned', 'submitted', 'approved', 'certified'));

ALTER TABLE subcontract_items DROP CONSTRAINT IF EXISTS subcontract_items_quantity_non_negative;
ALTER TABLE subcontract_items ADD CONSTRAINT subcontract_items_quantity_non_negative
  CHECK (assigned_quantity >= 0 AND executed_quantity >= 0);

ALTER TABLE subcontract_items DROP CONSTRAINT IF EXISTS subcontract_items_rate_non_negative;
ALTER TABLE subcontract_items ADD CONSTRAINT subcontract_items_rate_non_negative
  CHECK (
    (subcontract_rate_sar IS NULL OR subcontract_rate_sar >= 0)
    AND (client_rate_sar IS NULL OR client_rate_sar >= 0)
  );

ALTER TABLE subcontract_items DROP CONSTRAINT IF EXISTS subcontract_items_quota_range;
ALTER TABLE subcontract_items ADD CONSTRAINT subcontract_items_quota_range
  CHECK (quota_percent IS NULL OR (quota_percent >= 0 AND quota_percent <= 100));

-- Executed quantity without an execution status of approved/certified is a claim, not an actual.
-- An execution_date is required for the two statuses that make a quantity count as actual, so a
-- record can never be treated as executed at the Data Date without a date to test (GAP-021).
ALTER TABLE subcontract_items DROP CONSTRAINT IF EXISTS subcontract_items_actual_requires_date;
ALTER TABLE subcontract_items ADD CONSTRAINT subcontract_items_actual_requires_date
  CHECK (execution_status NOT IN ('approved', 'certified') OR execution_date IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_subcontract_packages_project ON subcontract_packages(project_id);
CREATE INDEX IF NOT EXISTS idx_subcontract_items_package ON subcontract_items(package_id);
CREATE INDEX IF NOT EXISTS idx_subcontract_items_project ON subcontract_items(project_id);
CREATE INDEX IF NOT EXISTS idx_subcontract_items_execution ON subcontract_items(project_id, execution_status);

ALTER TABLE subcontract_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_subcontract_packages" ON subcontract_packages;
CREATE POLICY "anon_crud_subcontract_packages" ON subcontract_packages
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE subcontract_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_subcontract_items" ON subcontract_items;
CREATE POLICY "anon_crud_subcontract_items" ON subcontract_items
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Project isolation (CASE L). validate_project_boundaries() is a fixed IF/ELSIF chain over the
-- tables that existed in 20260907220000; rather than rewriting that historical function, the
-- commercial tables get their own boundary guard.
CREATE OR REPLACE FUNCTION validate_subcontract_project_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  package_project uuid;
  related_project uuid;
BEGIN
  IF TG_TABLE_NAME = 'subcontract_items' THEN
    SELECT project_id INTO package_project FROM subcontract_packages WHERE id = NEW.package_id;
    IF package_project IS NULL THEN
      RAISE EXCEPTION 'Subcontract item references a missing package';
    END IF;
    IF package_project <> NEW.project_id THEN
      RAISE EXCEPTION 'Subcontract item crosses project boundary';
    END IF;
    IF NEW.boq_item_id IS NOT NULL THEN
      SELECT project_id INTO related_project FROM boq_items WHERE id = NEW.boq_item_id;
      IF related_project IS NULL OR related_project <> NEW.project_id THEN
        RAISE EXCEPTION 'Subcontract item BOQ link crosses project boundary';
      END IF;
    END IF;
    IF NEW.linked_activity_id IS NOT NULL THEN
      SELECT project_id INTO related_project FROM activities WHERE id = NEW.linked_activity_id;
      IF related_project IS NULL OR related_project <> NEW.project_id THEN
        RAISE EXCEPTION 'Subcontract item activity link crosses project boundary';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_subcontract_item_project ON subcontract_items;
CREATE TRIGGER validate_subcontract_item_project
  BEFORE INSERT OR UPDATE ON subcontract_items
  FOR EACH ROW EXECUTE FUNCTION validate_subcontract_project_boundary();

-- Audit trail: record_audit_event() is generic (TG_TABLE_NAME + row project_id), so the commercial
-- tables join the same governed audit log as progress_updates and cost_transactions.
DROP TRIGGER IF EXISTS audit_subcontract_packages ON subcontract_packages;
CREATE TRIGGER audit_subcontract_packages
  AFTER INSERT OR UPDATE OR DELETE ON subcontract_packages
  FOR EACH ROW EXECUTE FUNCTION record_audit_event();

DROP TRIGGER IF EXISTS audit_subcontract_items ON subcontract_items;
CREATE TRIGGER audit_subcontract_items
  AFTER INSERT OR UPDATE OR DELETE ON subcontract_items
  FOR EACH ROW EXECUTE FUNCTION record_audit_event();

-- Compatibility FK (option A): progress_updates.subcontractor_id stays TEXT and keeps holding the
-- business code ('SUB-PKG-01'); this nullable uuid column is the relational link for new writes.
-- No existing row is modified and no text value is reinterpreted.
ALTER TABLE progress_updates
  ADD COLUMN IF NOT EXISTS subcontract_package_id uuid REFERENCES subcontract_packages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_progress_updates_subcontract_package
  ON progress_updates(subcontract_package_id);

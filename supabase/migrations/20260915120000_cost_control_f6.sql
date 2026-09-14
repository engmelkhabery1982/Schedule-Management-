-- F6 (Cost Control & Forecast Integrity): minimal additive schema.
--
-- 1. `cost_control_snapshots`: one deterministic row per (project, data_date) holding the
--    decision numbers of that cost update (BAC/PV/EV/AC, CPI/SPI, ETC/EAC/VAC, committed,
--    recommended method, forecast confidence) plus a versioned `details` JSON blob with the
--    EAC method ledger and the per-activity evidence (EV/AC/percent) that powers
--    update-to-update comparison (EAC drift, burn rate, anomalies, time-cost consistency).
--    This table is ADDITIVE: EVM-owned `forecast_snapshots` (SPI/CPI/finish-only shape) is
--    untouched.
--
-- 2. `projects.manual_etc_override` (NULLABLE): user-supplied remaining-cost re-estimate (SAR).
--    NULL means "not supplied" — the engine then never uses the manual EAC method. Stored
--    explicitly so the manual forecast is auditable instead of a silent input.

CREATE TABLE IF NOT EXISTS cost_control_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_date date NOT NULL,
  bac numeric(15,2),
  pv numeric(15,2),
  ev numeric(15,2),
  ac numeric(15,2),
  cpi numeric(10,4),
  spi numeric(10,4),
  etc numeric(15,2),
  eac numeric(15,2),
  vac numeric(15,2),
  committed numeric(15,2),
  forecast_confidence text,
  recommended_method text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, data_date)
);

CREATE INDEX IF NOT EXISTS idx_cost_snapshots_project_date
  ON cost_control_snapshots(project_id, data_date DESC);

COMMENT ON TABLE cost_control_snapshots IS
  'F6: deterministic per-update cost-control snapshot. Aggregates are columns; the EAC method ledger and per-activity cost evidence live in details (schema version 1, see costControlEngine). Missing inputs persist as NULL, never as defaults.';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS manual_etc_override numeric(15,2);

COMMENT ON COLUMN projects.manual_etc_override IS
  'F6: user-supplied remaining-cost re-estimate (SAR). NULL = not supplied; the manual EAC method is then inapplicable.';

ALTER TABLE cost_control_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_cost_control_snapshots" ON cost_control_snapshots;
CREATE POLICY "anon_crud_cost_control_snapshots" ON cost_control_snapshots FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

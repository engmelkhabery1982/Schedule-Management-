-- Upsert requires UPDATE and its USING predicate in addition to INSERT.
DROP POLICY IF EXISTS "anon_update_forecast_snapshots" ON forecast_snapshots;
CREATE POLICY "anon_update_forecast_snapshots"
  ON forecast_snapshots FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_forecast_snapshots" ON forecast_snapshots;
CREATE POLICY "anon_delete_forecast_snapshots"
  ON forecast_snapshots FOR DELETE
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "anon_update_recovery_snapshots" ON recovery_snapshots;
CREATE POLICY "anon_update_recovery_snapshots"
  ON recovery_snapshots FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_recovery_snapshots" ON recovery_snapshots;
CREATE POLICY "anon_delete_recovery_snapshots"
  ON recovery_snapshots FOR DELETE
  TO anon, authenticated
  USING (true);

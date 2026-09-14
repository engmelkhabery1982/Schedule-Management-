-- =====================================================================================
-- Phase F1.1 · Execute imported calendars and lag semantics faithfully (additive only).
--
-- F1 persisted P6 calendars and calendar assignments, but canonical CPM still scheduled
-- every activity on the project calendar_type and every lag as rounded whole days. Three
-- gaps have no destination in the current schema; each addition below is the minimal
-- column/policy that closes one gap, with its XER source field and runtime consumer:
--
--   1. activity_links.lag_hours
--      XER source: TASKPRED.lag_hr_cnt (signed hours, exact as filed).
--      Why required: F1 stored only Math.round(hours / predecessor hpd) in lag_days, so a
--        +4h lag on an 8h/day calendar is indistinguishable from +8h once persisted. The
--        original value/unit must survive for faithful execution and for diagnostics.
--      Runtime consumer: ScheduleView links panel (original value/unit display) and
--        xerExporter (lossless lag_hr_cnt round trip). The CPM engine consumes the
--        precomputed day equivalent (column 2), never re-deriving from this column.
--
--   2. activity_links.lag_days_exact
--      XER source: derived at import from TASKPRED.lag_hr_cnt / predecessor-calendar
--        day_hr_cnt (same hours-per-day basis F1 used for lag_days, unrounded).
--      Why required: sub-day lags need a fractional working-day value the day-granular
--        CPM can place without silent rounding; re-deriving it at calc time would depend
--        on calendar availability and could disagree with the import basis.
--      Runtime consumer: cpmEngine via calendarEngine (effectiveLinkLagDays +
--        per-relationship-type floor/ceil placement). NULL (legacy/manual links) keeps
--        the exact legacy lag_days path, byte for byte.
--
--   3. calendars.pattern_status
--      XER source: importer parse outcome for CALENDAR.clndr_data
--        ('parsed' | 'no_data' | 'unparseable' | 'exceptions_unsupported').
--      Why required: workweek_json/exceptions_json alone cannot tell "no exceptions in
--        file" from "exceptions dropped as unmodellable", so the execution layer cannot
--        decide between full use, work-pattern-only use, or project-calendar fallback.
--      Runtime consumer: calendarEngine.resolveActivityExecutionCalendar (fallback
--        decision) and ScheduleView calendar diagnostics (fallback/partial badges).
--        Rows imported before this migration are backfilled deterministically below
--        (stored JSON present -> 'parsed', else 'no_data'); the resolver treats a
--        remaining NULL the same way, so no row is ever unreadable.
--
--   4. calendars RLS policy (missing in F1)
--      Why required: without an access policy the application role cannot SELECT the
--        calendars table on a hosted backend, which would silently force every activity
--        onto the project-calendar fallback and deaden this phase. Mirrors the
--        anon_crud_* style of the base schema; no data change.
-- =====================================================================================

-- 1 + 2. Lossless lag provenance + exact fractional execution input.
ALTER TABLE activity_links ADD COLUMN IF NOT EXISTS lag_hours numeric(12,2);
ALTER TABLE activity_links ADD COLUMN IF NOT EXISTS lag_days_exact numeric(14,6);

COMMENT ON COLUMN activity_links.lag_hours IS
  'F1.1: exact signed XER lag hours (TASKPRED.lag_hr_cnt). Display + export round trip; CPM consumes lag_days_exact.';
COMMENT ON COLUMN activity_links.lag_days_exact IS
  'F1.1: exact fractional working-day lag (lag_hr_cnt / predecessor-calendar hpd at import). CPM execution input; NULL keeps legacy lag_days path.';

-- 3. Calendar usability status for the execution layer.
ALTER TABLE calendars ADD COLUMN IF NOT EXISTS pattern_status text;
ALTER TABLE calendars DROP CONSTRAINT IF EXISTS calendars_pattern_status_check;
ALTER TABLE calendars ADD CONSTRAINT calendars_pattern_status_check
  CHECK (pattern_status IS NULL OR pattern_status IN (
    'parsed', 'no_data', 'unparseable', 'exceptions_unsupported'
  ));
-- Deterministic backfill for F1-imported rows: stored JSON is trusted as parsed output.
UPDATE calendars
SET pattern_status = CASE WHEN workweek_json IS NULL THEN 'no_data' ELSE 'parsed' END
WHERE pattern_status IS NULL;

COMMENT ON COLUMN calendars.pattern_status IS
  'F1.1: clndr_data parse outcome (parsed | no_data | unparseable | exceptions_unsupported). Drives CPM calendar fallback + diagnostics.';

-- 4. Access policy so the app can read calendars on a hosted backend (F1 gap).
ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_crud_calendars" ON calendars;
CREATE POLICY "anon_crud_calendars" ON calendars FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

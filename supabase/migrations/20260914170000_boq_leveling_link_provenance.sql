-- =====================================================================================
-- Phase F4 · Link provenance for resource-leveled BOQ schedules (additive only).
--
-- The BOQ planning engine classifies every generated relationship (template flow,
-- crew continuity, zone progression, milestone fan, user logic, resource leveling)
-- with a stable rule code, but activity_links had no destination for that
-- provenance: origin/rule_code/resource_key were lost at save time, so ScheduleView
-- could not distinguish engineering logic from resource-leveling constraints after
-- reload. Three nullable columns close the gap:
--
--   origin        Why the link exists: template | sequence | crewflow | milestone |
--                 user | resource_leveling. NULL for legacy/XER/manual links.
--   rule_code     Stable engine rule code (e.g. CREW_CONTINUITY_EXCV,
--                 RESOURCE_LEVEL_EQ_CONCRETE_PUMP). NULL when unknown.
--   resource_key  Governing resource pool for leveling links (e.g.
--                 eq-concrete-pump). NULL for non-leveling links.
--
-- Deliberately NOT added: anything behavioral (no backfill — existing rows keep
-- NULL, which readers treat as "engineering/unknown logic"); no new tables; no RLS
-- or index changes (provenance is display-only, never a query path).
-- Downstream consumer: ScheduleView renders resource_leveling links distinctly.
-- =====================================================================================

ALTER TABLE activity_links ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE activity_links ADD COLUMN IF NOT EXISTS rule_code text;
ALTER TABLE activity_links ADD COLUMN IF NOT EXISTS resource_key text;

COMMENT ON COLUMN activity_links.origin IS 'F4: logic provenance (template|sequence|crewflow|milestone|user|resource_leveling); NULL = legacy/unknown';
COMMENT ON COLUMN activity_links.rule_code IS 'F4: stable engine rule code; NULL = unknown';
COMMENT ON COLUMN activity_links.resource_key IS 'F4: governing resource pool for leveling links; NULL = non-leveling link';

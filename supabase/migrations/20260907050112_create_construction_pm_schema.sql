/*
# Construction Project Management Schema

## Overview
Creates a complete schema for a construction project management application for a Saudi contracting company.
Supports: project contracts, BOQ (bill of quantities) import, WBS generation, activity scheduling,
resource planning, progress tracking, budget management, risk/issue tracking, and KPI dashboards.

## Tables

1. **projects** — Top-level project info: name, client, location, contract value, dates, currency (SAR).
2. **boq_items** — Bill of Quantities line items: code, description, unit, quantity, unit_price, total, category/section.
3. **wbs_nodes** — Work Breakdown Structure tree: parent-child hierarchy, levels, codes.
4. **activities** — Schedule activities linked to WBS nodes: dates, durations, progress, dependencies, critical path flag.
5. **activity_links** — Predecessor/successor relationships between activities (FS, SS, FF, SF) with lag.
6. **resources** — Resource catalog: labor, equipment, material with unit rates.
7. **activity_resources** — Assignment of resources to activities with planned quantities.
8. **progress_updates** — Daily progress entries per activity: percent complete, actual dates, notes.
9. **risks** — Risk register: probability, impact, severity score, mitigation strategy, status.
10. **issues** — Issue log: description, status, proposed solution, dates.
11. **budget_lines** — Budget tracking per BOQ item or WBS node: planned, committed, actual costs.

## Security
- Single-tenant app (no auth). All policies use `TO anon, authenticated` with `USING (true)`.
- RLS enabled on every table.

## Notes
1. All monetary values stored as numeric(15,2) in SAR.
2. All dates stored as date (not timestamp) for schedule clarity.
3. WBS nodes use parent_id self-reference for hierarchy.
4. Activity links use a junction table for many-to-many predecessor relationships.
*/

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  client text,
  location text,
  contract_value numeric(15,2) DEFAULT 0,
  currency text DEFAULT 'SAR',
  start_date date,
  end_date date,
  duration_days int,
  status text DEFAULT 'planning',
  description text,
  created_at timestamptz DEFAULT now()
);

-- BOQ Items
CREATE TABLE IF NOT EXISTS boq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text NOT NULL,
  unit text,
  quantity numeric(15,3) DEFAULT 0,
  unit_price numeric(15,2) DEFAULT 0,
  total_price numeric(15,2) DEFAULT 0,
  category text,
  section text,
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- WBS Nodes
CREATE TABLE IF NOT EXISTS wbs_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES wbs_nodes(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  level int DEFAULT 0,
  sort_order int DEFAULT 0,
  boq_item_id uuid REFERENCES boq_items(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- Activities
CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_node_id uuid REFERENCES wbs_nodes(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  early_start date,
  early_finish date,
  late_start date,
  late_finish date,
  duration_days int DEFAULT 0,
  percent_complete numeric(5,2) DEFAULT 0,
  is_critical boolean DEFAULT false,
  is_milestone boolean DEFAULT false,
  actual_start date,
  actual_finish date,
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Activity Links (predecessor relationships)
CREATE TABLE IF NOT EXISTS activity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predecessor_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  successor_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  link_type text DEFAULT 'FS',
  lag_days int DEFAULT 0
);

-- Resources
CREATE TABLE IF NOT EXISTS resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'labor',
  unit text DEFAULT 'day',
  unit_rate numeric(15,2) DEFAULT 0,
  availability numeric(10,2) DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Activity Resources
CREATE TABLE IF NOT EXISTS activity_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  planned_quantity numeric(15,3) DEFAULT 0,
  actual_quantity numeric(15,3) DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Progress Updates
CREATE TABLE IF NOT EXISTS progress_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  update_date date NOT NULL,
  percent_complete numeric(5,2) DEFAULT 0,
  actual_quantity numeric(15,3) DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);

-- Risks
CREATE TABLE IF NOT EXISTS risks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  probability int DEFAULT 3,
  impact int DEFAULT 3,
  severity int DEFAULT 9,
  mitigation text,
  status text DEFAULT 'open',
  category text,
  identified_date date DEFAULT CURRENT_DATE,
  created_at timestamptz DEFAULT now()
);

-- Issues
CREATE TABLE IF NOT EXISTS issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  status text DEFAULT 'open',
  priority text DEFAULT 'medium',
  proposed_solution text,
  assignee text,
  raised_date date DEFAULT CURRENT_DATE,
  resolved_date date,
  created_at timestamptz DEFAULT now()
);

-- Budget Lines
CREATE TABLE IF NOT EXISTS budget_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_node_id uuid REFERENCES wbs_nodes(id) ON DELETE SET NULL,
  boq_item_id uuid REFERENCES boq_items(id) ON DELETE SET NULL,
  description text,
  planned_cost numeric(15,2) DEFAULT 0,
  committed_cost numeric(15,2) DEFAULT 0,
  actual_cost numeric(15,2) DEFAULT 0,
  remaining_cost numeric(15,2) DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_boq_items_project ON boq_items(project_id);
CREATE INDEX IF NOT EXISTS idx_wbs_nodes_project ON wbs_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_wbs_nodes_parent ON wbs_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id);
CREATE INDEX IF NOT EXISTS idx_activities_wbs ON activities(wbs_node_id);
CREATE INDEX IF NOT EXISTS idx_activity_links_pred ON activity_links(predecessor_id);
CREATE INDEX IF NOT EXISTS idx_activity_links_succ ON activity_links(successor_id);
CREATE INDEX IF NOT EXISTS idx_progress_activity ON progress_updates(activity_id);
CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_budget_project ON budget_lines(project_id);

-- RLS: Enable on all tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE boq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE wbs_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE risks ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;

-- Policies: single-tenant, no auth, all data is shared
-- Using a helper pattern: drop if exists, then create

-- projects
DROP POLICY IF EXISTS "anon_crud_projects" ON projects;
CREATE POLICY "anon_crud_projects" ON projects FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- boq_items
DROP POLICY IF EXISTS "anon_crud_boq_items" ON boq_items;
CREATE POLICY "anon_crud_boq_items" ON boq_items FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- wbs_nodes
DROP POLICY IF EXISTS "anon_crud_wbs_nodes" ON wbs_nodes;
CREATE POLICY "anon_crud_wbs_nodes" ON wbs_nodes FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- activities
DROP POLICY IF EXISTS "anon_crud_activities" ON activities;
CREATE POLICY "anon_crud_activities" ON activities FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- activity_links
DROP POLICY IF EXISTS "anon_crud_activity_links" ON activity_links;
CREATE POLICY "anon_crud_activity_links" ON activity_links FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- resources
DROP POLICY IF EXISTS "anon_crud_resources" ON resources;
CREATE POLICY "anon_crud_resources" ON resources FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- activity_resources
DROP POLICY IF EXISTS "anon_crud_activity_resources" ON activity_resources;
CREATE POLICY "anon_crud_activity_resources" ON activity_resources FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- progress_updates
DROP POLICY IF EXISTS "anon_crud_progress_updates" ON progress_updates;
CREATE POLICY "anon_crud_progress_updates" ON progress_updates FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- risks
DROP POLICY IF EXISTS "anon_crud_risks" ON risks;
CREATE POLICY "anon_crud_risks" ON risks FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- issues
DROP POLICY IF EXISTS "anon_crud_issues" ON issues;
CREATE POLICY "anon_crud_issues" ON issues FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- budget_lines
DROP POLICY IF EXISTS "anon_crud_budget_lines" ON budget_lines;
CREATE POLICY "anon_crud_budget_lines" ON budget_lines FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

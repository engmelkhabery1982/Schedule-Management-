export interface Project {
  id: string;
  name: string;
  client: string | null;
  location: string | null;
  contract_value: number;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  status: string;
  description: string | null;
  created_at: string;
}

export interface BoqItem {
  id: string;
  project_id: string;
  code: string;
  description: string;
  unit: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
  category: string | null;
  section: string | null;
  sort_order: number;
  created_at: string;
}

export interface WbsNode {
  id: string;
  project_id: string;
  parent_id: string | null;
  code: string;
  name: string;
  level: number;
  sort_order: number;
  boq_item_id: string | null;
  created_at: string;
  children?: WbsNode[];
}

export interface Activity {
  id: string;
  project_id: string;
  wbs_node_id: string | null;
  code: string;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  late_start: string | null;
  late_finish: string | null;
  duration_days: number;
  percent_complete: number;
  is_critical: boolean;
  is_milestone: boolean;
  actual_start: string | null;
  actual_finish: string | null;
  sort_order: number;
  created_at: string;
  wbs_node?: WbsNode | null;
  predecessors?: ActivityLink[];
  successors?: ActivityLink[];
  resources?: ActivityResource[];
}

export interface ActivityLink {
  id: string;
  project_id: string;
  predecessor_id: string;
  successor_id: string;
  link_type: string;
  lag_days: number;
  predecessor?: Activity;
  successor?: Activity;
}

export interface Resource {
  id: string;
  project_id: string;
  name: string;
  type: string;
  unit: string;
  unit_rate: number;
  availability: number;
  created_at: string;
}

export interface ActivityResource {
  id: string;
  activity_id: string;
  resource_id: string;
  project_id: string;
  planned_quantity: number;
  actual_quantity: number;
  created_at: string;
  resource?: Resource;
}

export interface ProgressUpdate {
  id: string;
  project_id: string;
  activity_id: string;
  update_date: string;
  percent_complete: number;
  actual_quantity: number;
  notes: string | null;
  created_at: string;
}

export interface Risk {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  probability: number;
  impact: number;
  severity: number;
  mitigation: string | null;
  status: string;
  category: string | null;
  identified_date: string | null;
  created_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  proposed_solution: string | null;
  assignee: string | null;
  raised_date: string | null;
  resolved_date: string | null;
  created_at: string;
}

export interface BudgetLine {
  id: string;
  project_id: string;
  wbs_node_id: string | null;
  boq_item_id: string | null;
  description: string | null;
  planned_cost: number;
  committed_cost: number;
  actual_cost: number;
  remaining_cost: number;
  created_at: string;
}

export interface ParsedBoqRow {
  code: string;
  description: string;
  unit: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  category: string;
  section: string;
}

export type ViewName =
  | 'dashboard'
  | 'import'
  | 'boq'
  | 'schedule'
  | 'progress'
  | 'budget'
  | 'risks'
  | 'export';

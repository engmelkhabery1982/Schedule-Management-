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
  total_float?: number;
  duration_days: number;
  planned_quantity: number;
  actual_quantity: number;
  unit: string | null;
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
  quantity_to_date: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  approved_at: string | null;
  rejected_reason: string | null;
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

export interface ProductivityRate {
  id: string;
  category: string;
  unit: string;
  daily_output: number;
  crew_size: number;
  difficulty_factor: number;
  created_at: string;
}

export interface BaselineActivity {
  id: string;
  baseline_id: string;
  activity_id: string;
  early_start: string;
  early_finish: string;
  duration_days: number;
  planned_cost: number;
}

export type BaselineStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface EvmMetrics {
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  spi: number;
  cpi: number;
  eac: number;
  etc: number;
  vac: number;
}

export interface CostTransaction {
  id: string;
  project_id: string;
  activity_id: string | null;
  boq_item_id: string | null;
  category: string | null;
  transaction_date: string;
  description: string;
  cost_type: string;
  amount: number;
  source: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  approved_at: string | null;
  rejected_reason: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  project_id: string | null;
  table_name: string;
  record_id: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
}

export interface ProjectAlert {
  id: string;
  project_id: string;
  fingerprint: string;
  alert_type: 'schedule' | 'cost' | 'data_quality' | 'resource';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  activity_id: string | null;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface ForecastSnapshot {
  id: string;
  project_id: string;
  snapshot_date: string;
  spi: number;
  cpi: number;
  forecast_finish: string | null;
  optimistic_finish: string | null;
  pessimistic_finish: string | null;
  eac_realistic: number;
  confidence: number;
  volatility: number;
  created_at: string;
}

export interface RecoverySnapshot {
  id: string;
  project_id: string;
  snapshot_date: string;
  required_spi: number;
  remaining_quantity: number;
  required_daily_quantity: number;
  cost_gap: number;
  feasibility: 'feasible' | 'strained' | 'unlikely' | 'not_required';
  action: string;
  created_at: string;
}

export interface ScenarioSimulation {
  id: string;
  project_id: string;
  name: string;
  input: Record<string, number>;
  result: Record<string, number | string | null>;
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

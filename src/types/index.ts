export type CalendarType = '6_days' | '5_days' | '7_days';

export type ActivityType =
  | 'task_dependent'     // Task Dependent (default)
  | 'resource_dependent' // Resource Dependent
  | 'level_of_effort'    // Level of Effort (LOE - stretches between boundaries)
  | 'start_milestone'    // Start Milestone (0 duration)
  | 'finish_milestone'   // Finish Milestone (0 duration)
  | 'wbs_summary';       // WBS Summary (rolls up child tasks)

export type ActivityConstraintType =
  | 'ASAP' // As Soon As Possible (default)
  | 'ALAP' // As Late As Possible
  | 'MSO'  // Must Start On
  | 'MFO'  // Must Finish On
  | 'SNET' // Start No Earlier Than
  | 'SNLT' // Start No Later Than
  | 'FNET' // Finish No Earlier Than
  | 'FNLT' // Finish No Later Than
  | 'MS'   // Mandatory Start
  | 'MF';  // Mandatory Finish

export type PercentCompleteType = 'duration' | 'physical' | 'units';

export type DurationType =
  | 'fixed_duration_units'
  | 'fixed_duration_time'
  | 'fixed_units'
  | 'fixed_units_time';

export type ProjectSector =
  | 'commercial_building'
  | 'infrastructure_highway'
  | 'healthcare_hospital'
  | 'residential_complex'
  | 'oil_gas_industrial';

export interface ProjectCalendar {
  type: CalendarType;
  workDays: number[]; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  holidays: string[]; // 'YYYY-MM-DD'
  hoursPerDay: number;
}

export interface Project {
  id: string;
  name: string;
  client: string | null;
  location: string | null;
  contract_value: number;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  data_date?: string | null; // Status Date / Data Date
  status_logic?: 'retained_logic' | 'progress_override';
  duration_days: number | null;
  status: string;
  description: string | null;
  calendar_type?: CalendarType;
  sector?: ProjectSector;
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
  // Rollup metrics
  early_start?: string | null;
  early_finish?: string | null;
  duration_days?: number;
  planned_cost?: number;
  actual_cost?: number;
  percent_complete?: number;
  is_collapsed?: boolean;
}

export interface Activity {
  id: string;
  project_id: string;
  wbs_node_id: string | null;
  code: string;
  name: string;
  activity_type?: ActivityType;
  calendar_type?: CalendarType;
  early_start: string | null;
  early_finish: string | null;
  late_start: string | null;
  late_finish: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  expected_finish_date?: string | null;
  total_float?: number;
  free_float?: number;
  duration_days: number;
  remaining_duration_days?: number;
  planned_quantity: number;
  actual_quantity: number;
  unit: string | null;
  percent_complete: number;
  physical_percent_complete?: number;
  duration_percent_complete?: number;
  units_percent_complete?: number;
  percent_complete_type?: PercentCompleteType;
  duration_type?: DurationType;
  /** P6 calendar assignment (calendars.id). Null when the source carries none. */
  calendar_id?: string | null;
  constraint_type?: ActivityConstraintType | null;
  constraint_date?: string | null;
  activity_drag?: number;
  is_longest_path?: boolean;
  suspend_date?: string | null;
  resume_date?: string | null;
  discipline?: string | null;
  contractor?: string | null;
  is_critical: boolean;
  is_milestone: boolean;
  milestone_type?: 'start' | 'finish' | null;
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
  link_type: 'FS' | 'SS' | 'FF' | 'SF' | string;
  lag_days: number;
  /**
   * Optional audit timestamp.
   * Compatibility field: the auto-fix routines in `src/lib/scheduleQualityEngine.ts` stamp
   * newly created links with `created_at`, while the `activity_links` table in
   * `supabase/migrations/20260907050112_create_construction_pm_schema.sql` does not define
   * that column. Optional so links loaded from the database remain valid without it.
   */
  created_at?: string;
  is_driving?: boolean;
  driving_float?: number;
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
  ownership?: 'company' | 'rental' | 'subcontractor';
  shift_hours?: number;
  rental_rate?: number;
  cost_rate?: number;
  subcontractor?: string | null;
}

export interface ActivityResource {
  id: string;
  activity_id: string;
  resource_id: string;
  project_id: string;
  planned_quantity: number;
  actual_quantity: number;
  /** Remaining units (P6 TASKRSRC.remain_qty). Null when the source carries none. */
  remaining_quantity?: number | null;
  created_at: string;
  resource?: Resource;
}

/** P6 working calendar imported from XER (reference data; CPM runs on project calendar_type). */
export interface P6Calendar {
  id: string;
  project_id: string;
  /** CALENDAR.clndr_id from the file (stringified; stable within one import). */
  p6_clndr_id: string;
  name: string;
  clndr_type: string | null;
  is_default: boolean;
  hours_per_day: number | null;
  hours_per_week: number | null;
  base_p6_clndr_id: string | null;
  workweek_json: Record<string, unknown> | null;
  exceptions_json: string[] | null;
  created_at: string;
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
  // Execution Party & Subcontractor tracking
  executor_type?: 'self_direct' | 'subcontractor';
  subcontractor_id?: string | null;
  /**
   * Relational uuid of the owning `subcontract_packages` row (GAP-019, strategy A). The text
   * `subcontractor_id` above keeps holding the business code ('SUB-PKG-01') for compatibility and is
   * never parsed as a uuid.
   */
  subcontract_package_id?: string | null;
  subcontractor_name?: string | null;
  subcontract_item_id?: string | null;
  zone_or_scope?: string | null;
  /**
   * The commercial values are nullable on purpose: when the subcontract package states no rate or no
   * retention, the record keeps null and the UI reports N/A instead of carrying an estimate (GAP-020).
   */
  subcontract_unit_rate?: number | null;
  client_unit_rate?: number | null;
  subcontractor_cost?: number | null;
  client_earned_value?: number | null;
  profit_margin_sar?: number | null;
  retention_deducted?: number | null;
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
  estimated_cost?: number;
  approved_budget?: number;
  budget_basis?: string;
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

/**
 * Baseline header row, aligned with the SQL table `project_baselines`
 * (`supabase/migrations/20260907220000_add_planning_control_schema.sql`):
 *
 *   id uuid PK · project_id uuid NOT NULL · version int NOT NULL DEFAULT 1 ·
 *   name text NOT NULL DEFAULT 'Initial Baseline' ·
 *   status text NOT NULL DEFAULT 'draft' CHECK (draft|submitted|approved|rejected) ·
 *   approved_at timestamptz (nullable) · is_active boolean NOT NULL DEFAULT true ·
 *   created_at timestamptz DEFAULT now() · UNIQUE(project_id, version)
 *
 * `version` and `name` are NOT NULL in SQL but optional here on purpose: writes rely on the
 * database defaults (`DEFAULT 1` / `DEFAULT 'Initial Baseline'`, see the insert in
 * `src/components/views/ImportView.tsx`) and the seed records in `src/lib/mockSeed.ts` omit
 * both. Declaring them required would force a mock-data change, which is out of scope for the
 * compilation-baseline wave.
 */
export interface ProjectBaseline {
  id: string;
  project_id: string;
  /** SQL `version int NOT NULL DEFAULT 1`; part of `UNIQUE(project_id, version)`. */
  version?: number;
  /** SQL `name text NOT NULL DEFAULT 'Initial Baseline'`. */
  name?: string;
  /** SQL `status text NOT NULL DEFAULT 'draft'` with a CHECK constraint. */
  status: BaselineStatus;
  /** SQL `approved_at timestamptz`, nullable — stamped when the baseline is approved. */
  approved_at?: string | null;
  /** SQL `is_active boolean NOT NULL DEFAULT true`. */
  is_active: boolean;
  /** SQL `created_at timestamptz DEFAULT now()`. */
  created_at: string;

  /** Derived aggregate (computed from `baseline_activities`), not persisted on `project_baselines`. */
  total_duration_days?: number;
  /** Derived aggregate (computed from `baseline_activities`), not persisted on `project_baselines`. */
  planned_cost?: number;
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
  invoice_number?: string | null;
  vendor?: string | null;
  quantity?: number;
  unit?: string | null;
  unit_rate?: number | null;
  wbs_node_id?: string | null;
  budget_line_id?: string | null;
  approval_level?: number;
  submitted_by?: string | null;
}

export interface InspectionRequest {
  id: string;
  project_id: string;
  request_number: string;
  boq_item_id: string | null;
  activity_id: string;
  parent_reference: string | null;
  inspection_date: string;
  inspected_quantity: number;
  approved_quantity: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  inspector: string | null;
  notes: string | null;
  approved_at: string | null;
  approved_by: string | null;
  rejected_reason: string | null;
  created_at: string;
  // Execution Party & Subcontractor tracking
  executor_type?: 'self_direct' | 'subcontractor';
  subcontractor_id?: string | null;
  /**
   * Relational uuid of the owning `subcontract_packages` row (GAP-019, strategy A); the text
   * `subcontractor_id` keeps the business code and is never parsed as a uuid.
   */
  subcontract_package_id?: string | null;
  subcontractor_name?: string | null;
  zone_or_scope?: string | null;
  /** Null when the covering package item is not priced — never an estimate (GAP-020). */
  subcontract_unit_rate?: number | null;
  client_unit_rate?: number | null;
  subcontractor_cost?: number | null;
  client_earned_value?: number | null;
  profit_margin_sar?: number | null;
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

// DCMA 14-Point Types
/**
 * Every automated repair action the DCMA 14-Point engine can emit.
 *
 * Kept in sync with the `fixType` parameter of `applyDcmaAutoFix` in
 * `src/lib/scheduleQualityEngine.ts`, which is the single place that implements these actions.
 * Widening this union only describes actions the engine already performs — it does not add,
 * remove, or alter any DCMA check or repair logic.
 */
export type DcmaAutoFixType =
  | 'all'
  | 'fix_missing_logic'
  | 'fix_negative_lags'
  | 'fix_hard_constraints'
  | 'fix_relationship_types'
  | 'fix_negative_float'
  | 'fix_high_float'
  | 'fix_invalid_dates'
  | 'fix_resource_loading'
  | 'fix_bei_execution'
  | 'fix_milestones';

export interface DcmaPointResult {
  id: number;
  name: string;
  nameAr: string;
  description: string;
  target: string;
  actualValue: string | number;
  passRatio: number; // 0 to 1
  status: 'pass' | 'warning' | 'fail';
  details: string[];
  recommendation?: string;
  autoFixType?: DcmaAutoFixType;
  weight: number;
}

export interface DcmaAuditResult {
  score: number; // 0 - 100
  status: 'excellent' | 'acceptable' | 'poor' | 'critical';
  points: DcmaPointResult[];
  totalPassed: number;
  totalWarnings: number;
  totalFailed: number;
  summary: string;
  bei: number; // Baseline Execution Index
  criticalPathLengthDays: number;
}

// Resource Leveling & Histogram Types
export interface ResourceDailyUsage {
  date: string;
  resourceId: string;
  resourceName: string;
  units: number;
  limit: number;
  isOverallocated: boolean;
}

export interface ResourceSummaryItem {
  id: string;
  name: string;
  type: string;
  unit: string;
  maxAvailability: number;
  peakAllocated: number;
  avgAllocated: number;
  isOverallocated: boolean;
  overallocatedDaysCount: number;
}

export interface ResourceHistogramData {
  dates: string[];
  timeBuckets: {
    dateLabel: string;
    startDate: string;
    endDate: string;
    resourceUnits: Record<string, number>; // resourceId -> units
    totalUnits: number;
    isOverallocated: boolean;
  }[];
  resourceSummaries: ResourceSummaryItem[];
}

// Procurement & Submittal Item
/**
 * Procurement / material submittal row.
 *
 * Two shapes coexist in the codebase today, so the interface accepts both:
 *  1. The application form shape written by `src/components/views/ProcurementView.tsx`
 *     (`code`, `type`, `submittal_date`, `required_approval_date`, `lead_time_days`, ...).
 *  2. The seed shape produced by `src/lib/mockSeed.ts` (`submittal_code`, `submittal_type`,
 *     `revision`, `submitted_date`, `reviewed_date`, `review_comments`, `consultant_reviewer`).
 *
 * There is no `procurement_submittals` table in `supabase/migrations`, so neither shape is
 * pinned by SQL yet. Fields that only one of the two shapes supplies are optional; the seed
 * compatibility fields are marked `@deprecated` and must be consolidated into the canonical
 * names in a later, dedicated wave (no seed value or calculation is changed here).
 */
export interface ProcurementSubmittal {
  id: string;
  project_id: string;
  activity_id: string | null;
  /** Canonical submittal code. Optional because seed records carry `submittal_code` instead. */
  code?: string;
  title: string;
  /** Canonical submittal category. Optional because seed records carry `submittal_type` instead. */
  type?: 'shop_drawing' | 'material_submittal' | 'long_lead_item' | 'inspection_mir';
  supplier_or_subcontractor?: string | null;
  submittal_date?: string | null;
  required_approval_date?: string | null;
  actual_approval_date?: string | null;
  lead_time_days?: number;
  status: 'draft' | 'submitted' | 'under_review' | 'approved' | 'approved_with_notes' | 'rejected' | 'delivered';
  is_critical_path?: boolean;
  notes?: string | null;
  created_at: string;

  // --- Seed compatibility fields (used by src/lib/mockSeed.ts only) -----------------------
  /** @deprecated compatibility field — consolidate into `type`. */
  submittal_type?: string;
  /** @deprecated compatibility field — consolidate into `code`. */
  submittal_code?: string;
  /** @deprecated compatibility field — submittal revision label, e.g. `'0'`, `'1'`. */
  revision?: string;
  /** @deprecated compatibility field — consolidate into `submittal_date`. */
  submitted_date?: string | null;
  /** @deprecated compatibility field — consolidate into `actual_approval_date`. */
  reviewed_date?: string | null;
  /** @deprecated compatibility field — consolidate into `notes`. */
  review_comments?: string | null;
  /** @deprecated compatibility field — consolidate into `supplier_or_subcontractor`. */
  consultant_reviewer?: string | null;
}

// Time Impact Analysis (TIA) & Delay Claim Types
export type DelayEventType =
  | 'client_delay'
  | 'consultant_review_delay'
  | 'differing_site_conditions'
  | 'variation_order'
  | 'force_majeure'
  | 'contractor_delay';

export type DelayResponsibility =
  | 'excusable_compensable'     // Owner fault -> Time + Prolongation Cost
  | 'excusable_non_compensable' // Force majeure -> Time only
  | 'non_excusable';            // Contractor fault -> Liquidated damages

export interface FragnetItem {
  id: string;
  code: string;
  name: string;
  duration_days: number;
  predecessor_id: string;
  successor_id: string;
  impact_date: string;
}

export interface DelayClaimEvent {
  id: string;
  project_id: string;
  claim_number: string;
  title: string;
  description: string;
  event_type: DelayEventType;
  responsibility: DelayResponsibility;
  start_date: string;
  end_date: string;
  affected_activity_id: string;
  delay_duration_days: number;
  fragnets: FragnetItem[];
  pre_impact_project_finish: string;
  post_impact_project_finish: string;
  critical_delay_days: number;
  eot_days_claimed: number;
  daily_indirect_cost_rate: number;
  compensation_claimed_sar: number;
  status: 'draft' | 'submitted_to_consultant' | 'under_determination' | 'approved_eot' | 'rejected';
  contractual_reference: string;
  created_at: string;
}

// Schedule Recovery & Crashing Optimizer Types
export interface RecoveryOption {
  id: string;
  activityId: string;
  activityCode: string;
  activityName: string;
  strategy: 'crashing' | 'fast_tracking' | 'overtime' | 'crew_doubling';
  strategyAr: string;
  daysSaved: number;
  additionalCost: number;
  costPerDay: number;
  feasibilityScore: number; // 0-100%
  description: string;
  selected: boolean;
}

export interface RecoveryPlanResult {
  targetFinishDate: string;
  currentFinishDate: string;
  requiredCompressionDays: number;
  totalDaysRecovered: number;
  totalRecoveryCost: number;
  newProjectFinishDate: string;
  options: RecoveryOption[];
  feasibilityRating: 'high' | 'moderate' | 'difficult';
  summary: string;
}

// Smart Schedule Diff & Comparison Types
export interface ActivityDiffItem {
  activityId: string;
  code: string;
  name: string;
  diffType: 'added' | 'deleted' | 'modified' | 'unchanged';
  startBaseline: string | null;
  startCurrent: string | null;
  startVarianceDays: number;
  finishBaseline: string | null;
  finishCurrent: string | null;
  finishVarianceDays: number;
  durationBaseline: number;
  durationCurrent: number;
  durationVarianceDays: number;
  totalFloatBaseline: number;
  totalFloatCurrent: number;
  totalFloatVarianceDays: number;
  criticalityBaseline: boolean;
  criticalityCurrent: boolean;
  criticalityShift: 'became_critical' | 'became_non_critical' | 'unchanged';
  percentBaseline: number;
  percentCurrent: number;
}

export interface ScheduleDiffResult {
  baselineName: string;
  currentScheduleName: string;
  totalActivitiesCount: number;
  addedCount: number;
  deletedCount: number;
  modifiedCount: number;
  criticalityShiftCount: number;
  projectFinishVarianceDays: number;
  activities: ActivityDiffItem[];
  summary: string;
}

export interface ComplexScenarioModel {
  id: string;
  nameAr: string;
  nameEn: string;
  category: 'supply_chain' | 'force_majeure' | 'scope_creep' | 'subcontractor_default' | 'cash_squeeze' | 'acceleration' | 'custom';
  descriptionAr: string;
  descriptionEn: string;
  parameters: {
    productivityFactor: number; // 0.5 to 1.5
    materialInflationPercent: number; // -10 to +50%
    laborRateEscalationPercent: number; // -10 to +40%
    criticalDelayDays: number; // 0 to 120 days
    cashInflowDelayDays: number; // 0 to 90 days
    subcontractorCapacityFactor: number; // 0.3 to 1.2
    crashingOvertimeFactor: number; // 1.0 to 2.0
    variationOrderValueSar: number;
    variationOrderDays: number;
  };
}

/**
 * Probabilistic percentile envelope of a complex scenario run (GAP-029).
 *
 * Structurally separate from the deterministic scenario result on purpose: the deterministic
 * figures are the scenario's explicitly modelled deltas (productivity, inflation, VO days, crashing),
 * while these values are percentiles read off an actual Monte Carlo distribution sampled around
 * those deltas. A deterministic multiplier is never presented as a percentile, and when no valid
 * simulation exists the envelope says so instead of inventing P80.
 */
export interface ScenarioProbabilisticEnvelope {
  /** True only when every percentile below was sampled from a valid simulation. */
  valid: boolean;
  source: 'monte_carlo' | 'unavailable';
  /** Valid iterations behind the percentiles. */
  iterations: number;
  /** Working-day duration percentiles; monotonic (P50 <= P80 <= P90) or null when unavailable. */
  p50DurationDays: number | null;
  p80DurationDays: number | null;
  p90DurationDays: number | null;
  /** SAR cost percentiles of the distribution centred on the deterministic scenario cost outcome. */
  p50CostSar: number | null;
  p80CostSar: number | null;
  p90CostSar: number | null;
  /** Simulated finish dates per percentile, so a consumer never recomputes them differently. */
  p50FinishDate: string | null;
  p90FinishDate: string | null;
  /**
   * Observed simulated range behind the percentiles. The deterministic scenario outcome is the
   * MODE (most likely value) of these distributions, not their median, so it sits inside the range
   * rather than at its centre -- a risk-loaded distribution is right-skewed by design.
   */
  minDurationDays: number | null;
  maxDurationDays: number | null;
  minCostSar: number | null;
  maxCostSar: number | null;
  /** Deterministic most-likely network length (working days) the envelope was anchored to. */
  deterministicNetworkDurationDays: number;
  /** Factor applied to activity durations so the sampled centre matches the scenario duration. */
  durationScaleFactor: number;
  /** Open risks that widened the pessimistic bound; 0 => dispersion is optimistic-side only. */
  openRiskCount: number;
  /**
   * False when the run had no positive cost basis: the duration percentiles still stand, but every
   * cost percentile is null (N/A) and the published cost is the deterministic scenario outcome.
   */
  costAvailable: boolean;
  /** Reproducibility seed when the caller supplied one; null means a stochastic run. */
  seed: number | string | null;
  /** Validation failure or modelling caveat, bilingual. Null when there is nothing to qualify. */
  noteAr: string | null;
  noteEn: string | null;
}

export interface ComplexScenarioResult {
  scenarioId: string;
  scenarioNameAr: string;
  scenarioNameEn: string;
  category: string;
  finishDate: string;
  varianceDays: number;
  totalDurationDays: number;
  criticalPathLength: number;
  /** Scenario BAC = canonical BAC + the scenario's variation-order value. */
  bac: number;
  /** Canonical BAC at the Data Date (SSOT) — never a `contract_value || 1000000` fallback. */
  baselineBacSar: number;
  /** Explicit scenario budget delta, so the simulated part is separable from the measured part. */
  variationOrderValueSar: number;
  /** Measured EV at the Data Date. A fact, not a simulation input (GAP-040). */
  canonicalEvSar: number;
  /** Measured AC at the Data Date. A fact, not a simulation input (GAP-040). */
  canonicalAcSar: number;
  /** Measured canonical indices the scenario deltas are applied to. */
  baselineCpi: number;
  baselineSpi: number;
  /** The simulation's own cost outcome (formerly reported as `eacBottomUp`). */
  simulatedCostOutcomeSar: number;
  /** Deterministic multi-EAC family — identical to BudgetView for identical inputs (GAP-047). */
  eacOptimistic: number;
  eacRealistic: number;
  eacPessimistic: number;
  eacBottomUp: number;
  /** Per-model validity, so a consumer renders "—" instead of a placeholder number. */
  eacModelStatuses: {
    optimistic: ForecastModelStatus;
    realistic: ForecastModelStatus;
    pessimistic: ForecastModelStatus;
    bottomUp: ForecastModelStatus;
  };
  costVarianceSar: number;
  costVariancePercent: number;
  /** Scenario-adjusted indices = canonical index x the simulated delta factor (1.0 when neutral). */
  spi: number;
  cpi: number;
  peakCashDeficitSar: number;
  /**
   * P80 finish date read from the SIMULATED duration distribution (GAP-029) -- never the former
   * `deterministic duration x 1.08`. When no valid simulation exists it falls back to the
   * deterministic scenario finish date and `probabilisticEnvelope.valid` is false, so a consumer can
   * always tell a sampled percentile from a deterministic outcome.
   */
  p80FinishDate: string;
  /** P80 cost read from the simulated cost distribution -- never `deterministic cost x 1.06`. */
  p80CostSar: number;
  /** The sampled envelope behind the two P80 fields, separated from the deterministic deltas. */
  probabilisticEnvelope: ScenarioProbabilisticEnvelope;
  feasibilityScore: number; // 0-100
  contractualClaimClause: string;
  riskRating: 'low' | 'medium' | 'high' | 'critical';
  mitigationStrategyAr: string;
  mitigationStrategyEn: string;
}

export interface PrecisionWatchdogMetric {
  id: string;
  category: 'cpm_float' | 'evm_conservation' | 'ssot_cost' | 'cashflow_integrity' | 'statistical_bounds';
  labelAr: string;
  labelEn: string;
  formula: string;
  calculatedValue: string;
  expectedValue: string;
  deviation: number;
  precisionStatus: 'exact' | 'acceptable' | 'drift_detected';
  notesAr: string;
  notesEn: string;
}

export type ViewName =
  | 'portfolio'
  | 'dashboard'
  | 'scenario_simulation'
  | 'data_governance'
  | 'schedule'
  | 'bim_4d'
  | 'linear_schedule'
  | 'payment_certificates'
  | 'financial_controls'
  | 'schedule_diff'
  | 'time_impact_analysis'
  | 'schedule_recovery'
  | 'dcma_audit'
  | 'resources'
  | 'procurement'
  | 'boq'
  | 'progress'
  | 'budget'
  | 'risks'
  | 'import'
  | 'export'
  | 'executive_report';

export interface PortfolioKpiSummary {
  totalProjects: number;
  totalContractValue: number;
  totalPv: number;
  totalEv: number;
  totalAc: number;
  portfolioSpi: number;
  portfolioCpi: number;
  criticalProjectsCount: number;
  activeRisksCount: number;
}

// 4D BIM Simulation Element Types
export interface BimElement {
  id: string;
  name: string;
  nameAr: string;
  category: 'earthwork' | 'foundation' | 'column' | 'slab' | 'facade' | 'mep' | 'roof';
  level: number; // 0 = Substructure, 1 = Ground, 2 = 1st floor, 3 = 2nd floor, 4 = Roof
  activityId?: string;
  activityCode?: string;
  start_date: string;
  finish_date: string;
  planned_cost: number;
  status: 'planned' | 'in_progress' | 'completed' | 'critical_delay';
  meshCoordinates: {
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    depth: number;
  };
}

// Linear Scheduling (Time-Location / TILOS) Types
export interface LinearTask {
  id: string;
  code: string;
  name: string;
  nameAr: string;
  startStationKm: number; // e.g. 0.00 to 5.00 km
  endStationKm: number;
  startDate: string;
  finishDate: string;
  direction: 'forward' | 'backward';
  dailyProductionRateMeters: number;
  color: string;
  crewName: string;
  isCritical: boolean;
  activityId?: string;
}

export interface LinearSpatialClash {
  id: string;
  task1Code: string;
  task2Code: string;
  stationKm: number;
  clashDate: string;
  descriptionAr: string;
  descriptionEn: string;
}

// Interim Payment Certificate (IPC) & Variation Orders Types
export interface PaymentCertificateItem {
  id: string;
  boqItemId: string;
  boqCode: string;
  description: string;
  unit: string;
  contractQuantity: number;
  unitRateSar: number;
  previousQuantity: number;
  currentQuantity: number;
  cumulativeQuantity: number;
  cumulativeAmountSar: number;
  currentAmountSar: number;
}

export interface PaymentCertificate {
  id: string;
  ipcNumber: string; // e.g. "IPC-004"
  certificateDate: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'submitted_by_contractor' | 'certified_by_consultant' | 'approved_by_client' | 'paid';
  grossAmountToDate: number;
  previousGrossAmount: number;
  currentGrossAmount: number;
  advancePaymentDeduction: number; // 10%
  retentionMoneyDeduction: number; // 5% or 10%
  penaltyDeduction: number;
  vatAmount: number; // 15%
  netPayableAmount: number;
  items: PaymentCertificateItem[];
}

export interface VariationOrder {
  id: string;
  voNumber: string; // e.g. "VO-001"
  title: string;
  description: string;
  reason: 'client_request' | 'design_change' | 'site_condition' | 'authority_requirement';
  claimedCostSar: number;
  approvedCostSar: number;
  claimedTimeDays: number;
  approvedTimeDays: number;
  status: 'pending_review' | 'approved' | 'rejected' | 'negotiation';
  submissionDate: string;
  approvalDate?: string;
  impactedActivityCode?: string;
}

// Subcontractor Package & Subcontract BOQ Assignment Types
export interface SubcontractBoqItem {
  /**
   * Application-facing identity: the subcontract item BUSINESS CODE ('SUB-ITM-01'). It is kept as
   * `id` so existing selectors, payloads and stored progress_updates references keep working
   * (GAP-019 compatibility strategy A); the relational uuid lives in `itemId`.
   */
  id: string;
  subcontractId: string;
  /** Internal uuid PK of `subcontract_items` (GAP-019). Absent for legacy in-memory records. */
  itemId?: string | null;
  /** Internal uuid of the owning `subcontract_packages` row. */
  packageId?: string | null;
  /** Owning project, denormalised on the row so project isolation can be queried and enforced. */
  project_id?: string | null;
  /** Business code column of `subcontract_items` (same value as `id` when loaded from the DB). */
  code?: string | null;
  boqItemId?: string;
  /** Relational link to `activities.id`; `linkedActivityCode` stays as the text business code. */
  linkedActivityId?: string | null;
  /**
   * Commercial chronology (GAP-021): a quantity is only an actual when its status says it happened
   * and its execution date is on or before the governed Data Date.
   */
  executionStatus?: 'planned' | 'submitted' | 'approved' | 'certified';
  executionDate?: string | null;
  boqCode: string;
  description: string;
  unit: string;
  assignedQuantity: number;
  /**
   * سعر شراء مقاول الباطن. `null` يعني أن البند غير مُسعّر: تُعرض التكلفة N/A ولا تُقدّر أبداً من
   * سعر المالك (GAP-020).
   */
  subcontractRateSar: number | null;
  subcontractTotalSar: number;
  /** سعر بيع المالك للمقاول الرئيسي؛ `null` عندما يكون جانب المالك غير مُسعّر. */
  clientRateSar: number | null;
  clientTotalSar: number;
  expectedMarginSar: number;
  expectedMarginPercent: number;
  linkedActivityCode?: string;
  executedQuantity?: number;
  zoneOrScope?: string;       // نطاق العمل أو المنطقة الجغرافية (مثل: Zone A, مبنى 1, مرحلة التوريد)
  /** النسبة المئوية من إجمالي كمية البند الرئيسي (مثل: 60%, 40%)؛ `null` = غير مسجلة. */
  quotaPercent?: number | null;
}

export interface SubcontractPackage {
  /**
   * Application-facing identity: the package BUSINESS CODE ('SUB-PKG-01'). Existing code matches on
   * it (executor selectors, progress_updates.subcontractor_id, inspection payloads), so it is
   * preserved as `id`; the relational uuid lives in `packageId` (GAP-019 strategy A).
   */
  id: string;
  /** Internal uuid PK of `subcontract_packages`. Absent for legacy in-memory records. */
  packageId?: string | null;
  /** Owning project. A package always belongs to exactly one project (GAP-019 / project isolation). */
  projectId?: string | null;
  /** Business code column of `subcontract_packages` (same value as `id` when loaded from the DB). */
  code?: string | null;
  /**
   * How the package amount relates to its items (GAP-018 applied to subcontracts): 'itemized' means
   * the package value must equal the sum of item contract amounts; 'lump_sum' means a documented
   * lump sum overrides that sum. Defaults to 'itemized' when absent.
   */
  valueBasis?: 'itemized' | 'lump_sum';
  subcontractNumber: string; // e.g. "SUB-CON-001"
  subcontractorName: string;
  contactPerson: string;
  phone: string;
  trade: string; // e.g. "أعمال الهيكل الإنشائي والخرسانات", "أعمال تمديدات التكييف والدكت"
  contractDate: string;
  scopeDescription: string;
  /** 'planned' packages are future commercial commitments and never enter actual totals (GAP-021). */
  status: 'planned' | 'active' | 'completed' | 'suspended' | 'terminated';
  totalSubcontractValueSar: number;
  totalClientEquivalentValueSar: number;
  /**
   * Derived from the items (client equivalent - subcontract value). Kept on the shape for existing
   * consumers but never treated as an independent source of truth (GAP-018).
   */
  totalExpectedProfitSar: number;
  profitMarginPercent: number;
  /**
   * Contractual retention of THIS package. `null` means the contract does not specify one, which is
   * reported as N/A — it is never defaulted to 10% (GAP-020). 0 is a legitimate retention-free term.
   */
  retentionPercent: number | null;
  items: SubcontractBoqItem[];
}

// -------------------------------------------------------------
// Financial & Cost Control Advanced Types (AACE / PMI Standard)
// -------------------------------------------------------------

/**
 * Cost Breakdown Structure cost-nature categories.
 *
 * `unclassified` is a first-class category, not an error state (UG-050): the cost tables in this
 * schema carry no cost-nature column (`budget_lines` has none at all; `cost_transactions.category`
 * and `boq_items.category` hold BOQ trade names such as `Earthworks`), so an amount can only be
 * attributed to a cost nature when a record explicitly names one. Every unmapped amount is
 * reported here instead of being spread over the five named centers by a fixed percentage.
 */
export type CbsCategory = 'labor' | 'materials' | 'equipment' | 'subcontractors' | 'overheads' | 'unclassified';

/**
 * Provenance of a committed-cost figure (UG-051). Distinguishes "no commitment data exists" from
 * "commitments are recorded and they total zero", so a consumer never has to invent an amount.
 */
export type CommittedCostStatus =
  | 'recorded' // at least one budget line carries a committed_cost value
  | 'zero_recorded' // budget lines exist and every committed_cost is exactly 0
  | 'no_commitment_data'; // no budget lines, or every committed_cost is null/undefined

/**
 * Validity of one EAC model (GAP-009 / GAP-040 / GAP-047). A model whose denominator is not a
 * measured value is reported as not computable instead of being silently clamped or returned as
 * NaN / Infinity.
 */
export type ForecastModelStatus =
  | 'valid' // every input the model needs is a measured value
  | 'valid_estimated_etc' // bottom-up model used the documented contingency factor, not a real estimate
  | 'empty_no_data' // BAC, EV and AC are all zero: nothing has been budgeted, earned or spent
  | 'index_not_measured' // the model needs CPI/SPI but the supplied index is a canonical sentinel
  | 'denominator_not_positive'; // the model's own denominator is <= 0

/** Feasibility band of a TCPI reading (GAP-042). `not_assessable` replaces the old silent 1.0. */
export type TcpiFeasibility = 'easy' | 'realistic' | 'hard' | 'unachievable' | 'not_assessable';

/** Where a contract baseline figure came from (GAP-043). `none` means "not available". */
export type ContractBaselineSource = 'contract_value' | 'budget_lines_total' | 'boq_total' | 'none';

export interface CbsCostCenter {
  id: string;
  category: CbsCategory;
  nameAr: string;
  nameEn: string;
  /** Planned cost attributed to this center from real budget lines (UG-050). */
  budgetAllocatedSar: number;
  /** Committed cost attributed to this center from real `budget_lines.committed_cost`. */
  committedCostSar: number;
  /** Actual cost attributed to this center from real approved cost transactions. */
  actualCostSar: number;
  /** `budgetAllocatedSar - actualCostSar`, the same convention as `varianceSar`. */
  remainingCostSar: number;
  varianceSar: number; // Budget - Actual
  /** 0 when this center has no planned amount, so a percentage is never divided by zero. */
  variancePercent: number;
  /** Provenance of `committedCostSar` (UG-051). */
  committedCostStatus: CommittedCostStatus;
  /** Number of real records attributed to this center (0 = nothing in the data maps here). */
  mappedRecordCount: number;
  /** True for the explicit Unclassified / Other bucket that absorbs every unmapped amount. */
  isUnclassified: boolean;
  description: string;
}

// Cash-flow legs that have no source table in the schema (owner receivables / IPC collection,
// monthly PV phasing) are `null` = N/A and must be rendered as N/A — never filled with invented
// demo values. Only cashOutCommittedSar is bound to real records (approved cost_transactions).
export interface MonthlyCashFlowBucket {
  periodMonth: string; // e.g. "2026-09", "2026-10"
  monthLabel: string;  // e.g. "سبتمبر 2026"
  plannedValueSar: number | null;
  cashInGrossSar: number | null;       // فواتير المالك — N/A: لا يوجد جدول مستخلصات/تحصيل
  cashInNetReceivedSar: number | null; // المحصل الفعلي بعد الخصومات — N/A
  cashOutCommittedSar: number;  // رواتب + مواد + معدات + باطن (approved cost_transactions)
  netMonthlyCashFlowSar: number | null;// In - Out — N/A حتى تتوفر بيانات التحصيل
  cumulativeCashFlowSar: number | null;// الرصيد التراكمي — N/A
  isDeficit: boolean | null;    // null = غير محدد (يحتاج التدفق الداخل)
  fundingGapSar: number | null;
}

export interface ReserveBurnItem {
  id: string;
  reserveType: 'contingency' | 'management';
  nameAr: string;
  allocatedAmountSar: number;
  spentToDateSar: number;
  remainingAmountSar: number;
  utilizationPercent: number;
  associatedRiskTitle: string;
  authorizationNotes: string;
  status: 'healthy' | 'caution' | 'exhausted';
}

/**
 * The multi-EAC comparison is produced by `calculateMultiEacForecast` in
 * `@/lib/budgetForecastEngine` (SSOT for GAP-009 / GAP-040 / GAP-047 / GAP-042) and its result
 * type `MultiEacForecast` lives with that engine. This view-model duplicate was removed in Wave 6:
 * keeping a second shape here is what allowed BudgetView and the scenario simulator to drift.
 */

// -------------------------------------------------------------
// Advanced Contractual & Commercial Risk Control Types (FIDIC)
// -------------------------------------------------------------

export interface BankGuaranteeItem {
  id: string;
  guaranteeType: 'advance_payment' | 'performance_bond' | 'maintenance_defect' | 'letter_of_credit';
  bondNumber: string;
  issuingBank: string;
  beneficiary: string; // e.g. "وزارة النقل / المالك"
  issueDate: string;
  expiryDate: string;
  initialAmountSar: number;
  currentAmountSar: number;
  reductionPercentage: number;
  status: 'active' | 'expiring_soon' | 'released' | 'extended';
  daysUntilExpiry: number;
  notes: string;
}

export interface MaterialsOnSiteItem {
  id: string;
  code: string;
  description: string;
  deliveryDate: string;
  unit: string;
  deliveredQuantity: number;
  unitRateSar: number;
  totalDeliveredValueSar: number;
  advancePaymentPercentage: number; // e.g. 75% or 80%
  certifiedAmountSar: number;
  installedAndRecoveredQty: number;
  remainingSiteBalanceQty: number;
  remainingCertifiedBalanceSar: number;
  status: 'stored_on_site' | 'partially_installed' | 'fully_incorporated';
  inspectionReportNo: string;
}

export interface ProlongationAndLdCalc {
  dailySiteOverheadRateSar: number; // رواتب + مكاتب + حراسة + كهرباء / يوم
  excusableCompensableEotDays: number;
  totalProlongationCostClaimSar: number;
  unexcusedDelayDays: number;
  dailyLdPenaltyRateSar: number;
  totalLdPenaltySar: number;
  maxLdCapSar: number; // 10% of Contract Value
  isLdCapped: boolean;
  netDelayFinancialImpactSar: number; // Prolongation Claim - LDs
}

export interface PriceEscalationItem {
  id: string;
  materialCategory: 'rebar' | 'ready_mix_concrete' | 'diesel' | 'asphalt';
  nameAr: string;
  weightCoefficient: number; // e.g. 0.25
  baselineIndexDate: string;
  baselineIndexValue: number; // L0 / M0
  currentIndexDate: string;
  currentIndexValue: number;  // Ln / Mn
  escalationRatio: number;    // (Mn - M0) / M0
  quantityConsumed: number;
  unit: string;
  baselineUnitRateSar: number;
  escalationAdjustmentSar: number; // Net Payable (+) or Deductible (-)
}

export interface ThreeWayMatchingInvoice {
  id: string;
  poNumber: string;
  poDate: string;
  poAmountSar: number;
  grnInspectionNumber: string; // Goods Receipt Note / Material Inspection Report
  grnDate: string;
  grnInspectedAmountSar: number;
  invoiceNumber: string;
  invoiceDate: string;
  vendorName: string;
  invoiceAmountSar: number;
  priceVarianceSar: number;
  quantityVarianceSar: number;
  matchingStatus: 'fully_matched' | 'price_discrepancy' | 'quantity_discrepancy' | 'blocked_for_review';
  approvalStatus: 'approved_for_payment' | 'on_hold' | 'rejected';
}




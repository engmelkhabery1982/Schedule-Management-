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
  // Execution Party & Subcontractor tracking
  executor_type?: 'self_direct' | 'subcontractor';
  subcontractor_id?: string | null;
  subcontractor_name?: string | null;
  subcontract_item_id?: string | null;
  zone_or_scope?: string | null;
  subcontract_unit_rate?: number;
  client_unit_rate?: number;
  subcontractor_cost?: number;
  client_earned_value?: number;
  profit_margin_sar?: number;
  retention_deducted?: number;
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

export interface ProjectBaseline {
  id: string;
  project_id: string;
  name: string;
  code: string;
  description: string | null;
  snapshot_date: string;
  is_active: boolean;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  total_duration_days?: number;
  planned_cost?: number;
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
  // Earned Schedule Management (ESM) metrics in time units
  earned_schedule_months?: number;
  actual_time_months?: number;
  sv_t_days?: number;
  spi_t?: number;
  ieac_t_date?: string;
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
  invoice_number?: string | null;
  vendor?: string | null;
  quantity?: number;
  unit?: string | null;
  unit_rate?: number | null;
  wbs_node_id?: string | null;
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
  subcontractor_name?: string | null;
  zone_or_scope?: string | null;
  subcontract_unit_rate?: number;
  client_unit_rate?: number;
  subcontractor_cost?: number;
  client_earned_value?: number;
  profit_margin_sar?: number;
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
  autoFixType?: 'fix_missing_logic' | 'fix_negative_lags' | 'fix_hard_constraints' | 'fix_relationship_types' | 'fix_negative_float' | 'all';
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
export interface ProcurementSubmittal {
  id: string;
  project_id: string;
  activity_id: string | null;
  code: string;
  title: string;
  type: 'shop_drawing' | 'material_submittal' | 'long_lead_item' | 'inspection_mir';
  supplier_or_subcontractor: string | null;
  submittal_date: string | null;
  required_approval_date: string | null;
  actual_approval_date: string | null;
  lead_time_days: number;
  status: 'draft' | 'submitted' | 'under_review' | 'approved' | 'approved_with_notes' | 'rejected' | 'delivered';
  is_critical_path: boolean;
  notes: string | null;
  created_at: string;
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

export interface ComplexScenarioResult {
  scenarioId: string;
  scenarioNameAr: string;
  scenarioNameEn: string;
  category: string;
  finishDate: string;
  varianceDays: number;
  totalDurationDays: number;
  criticalPathLength: number;
  bac: number;
  eacOptimistic: number;
  eacRealistic: number;
  eacPessimistic: number;
  eacBottomUp: number;
  costVarianceSar: number;
  costVariancePercent: number;
  spi: number;
  cpi: number;
  peakCashDeficitSar: number;
  p80FinishDate: string;
  p80CostSar: number;
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
  id: string;
  subcontractId: string;
  boqItemId?: string;
  boqCode: string;
  description: string;
  unit: string;
  assignedQuantity: number;
  subcontractRateSar: number; // سعر شراء مقاول الباطن
  subcontractTotalSar: number;
  clientRateSar: number;      // سعر بيع المالك للمقاول الرئيسي
  clientTotalSar: number;
  expectedMarginSar: number;
  expectedMarginPercent: number;
  linkedActivityCode?: string;
  executedQuantity?: number;
  zoneOrScope?: string;       // نطاق العمل أو المنطقة الجغرافية (مثل: Zone A, مبنى 1, مرحلة التوريد)
  quotaPercent?: number;      // النسبة المئوية من إجمالي كمية البند الرئيسي (مثل: 60%, 40%)
}

export interface SubcontractPackage {
  id: string;
  subcontractNumber: string; // e.g. "SUB-CON-001"
  subcontractorName: string;
  contactPerson: string;
  phone: string;
  trade: string; // e.g. "أعمال الهيكل الإنشائي والخرسانات", "أعمال تمديدات التكييف والدكت"
  contractDate: string;
  scopeDescription: string;
  status: 'active' | 'completed' | 'suspended';
  totalSubcontractValueSar: number;
  totalClientEquivalentValueSar: number;
  totalExpectedProfitSar: number;
  profitMarginPercent: number;
  retentionPercent: number; // 5% or 10%
  items: SubcontractBoqItem[];
}

// -------------------------------------------------------------
// Financial & Cost Control Advanced Types (AACE / PMI Standard)
// -------------------------------------------------------------

export type CbsCategory = 'labor' | 'materials' | 'equipment' | 'subcontractors' | 'overheads';

export interface CbsCostCenter {
  id: string;
  category: CbsCategory;
  nameAr: string;
  nameEn: string;
  budgetAllocatedSar: number;
  committedCostSar: number;
  actualCostSar: number;
  varianceSar: number; // Budget - Actual
  variancePercent: number;
  description: string;
}

export interface MonthlyCashFlowBucket {
  periodMonth: string; // e.g. "2026-09", "2026-10"
  monthLabel: string;  // e.g. "سبتمبر 2026"
  plannedValueSar: number;
  cashInGrossSar: number;       // فواتير المالك
  cashInNetReceivedSar: number; // المحصل الفعلي بعد الخصومات
  cashOutCommittedSar: number;  // رواتب + مواد + معدات + باطن
  netMonthlyCashFlowSar: number;// In - Out
  cumulativeCashFlowSar: number;// الرصيد التراكمي
  isDeficit: boolean;
  fundingGapSar: number;
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

export interface MultiEacComparison {
  bac: number;
  ev: number;
  ac: number;
  cpi: number;
  spi: number;
  tcpiBac: number;
  tcpiEac: number;
  tcpiFeasibility: 'easy' | 'realistic' | 'hard' | 'unachievable';
  eac1Optimistic: number; // AC + BAC - EV
  vac1: number;
  eac2Realistic: number;  // BAC / CPI
  vac2: number;
  eac3Pessimistic: number;// AC + (BAC - EV) / (CPI * SPI)
  vac3: number;
  eac4BottomUp: number;   // AC + Bottom-up ETC
  vac4: number;
}

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




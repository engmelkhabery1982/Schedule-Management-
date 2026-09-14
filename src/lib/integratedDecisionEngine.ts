/**
 * F7 — Integrated Time-Cost Decision Support.
 *
 * A pure, deterministic orchestration layer over the F5 schedule-control report, the F6
 * cost-control report, and F4 scenario reruns. It introduces NO new CPM, EVM, or EAC
 * mathematics: every time number is quoted from F5, every cost number from F6, and every
 * scenario outcome from an actual rerun of the existing engines.
 *
 * Hard rules (locked by the F7 charter):
 * - One integrated issue per affected activity: schedule evidence + cost evidence, affected
 *   WBS/BOQ refs, time impact, cost impact, cause category, and gated confidence.
 * - Correlation is NEVER labeled causation. A cause is High only on direct recorded
 *   evidence (dates, driving logic, recorded growth), Medium on multiple consistent
 *   indicators across both engines, Low for co-occurrence, and Unproven when absent.
 *   Low/Unproven causes are explicitly marked "relationship only, not cause".
 * - Priority is a declared weighted score (constants below) multiplied by a declared
 *   confidence factor. No hidden scoring; ties break on issue id.
 * - Scenario presets are declared (duration/cost factors + rationale). Finish always comes
 *   from an `analyzeScheduleControl` rerun; cost always from a `simulateScenario` cost leg
 *   over the affected scope, and only when baseline rates cover that scope — otherwise N/A.
 *   Scenario EAC is composition (current EAC + scenario cost), never a new formula.
 * - Recovery is recommended ONLY for critical/near-critical work with resource/productivity
 *   evidence whose rerun provably improves project finish. Anything else is banned with a
 *   stated reason.
 * - Integrated confidence is capped by the weakest source (min of the two engines).
 * - Totals are quoted from F6 by reference; nothing is re-summed, so nothing double-counts.
 * - Missing inputs surface as N/A (null), never as fabricated defaults. No machine date.
 */

import { analyzeScheduleControl } from './scheduleControlEngine';
import type {
  ActivityVariance,
  ConfidenceLevel,
  ScheduleControlReport,
  StatusedActivity,
} from './scheduleControlEngine';
import { simulateScenario } from './scenarioEngine';
import type { CostControlReport } from './costControlEngine';
import { calendarDaysBetween, isIsoDate } from './chronologyGuard';
import type {
  Activity,
  ActivityLink,
  BaselineActivity,
  CalendarType,
  CostControlSnapshot,
  ProgressUpdate,
  ScheduleUpdateSnapshot,
} from '@/types';

// ---------------------------------------------------------------------------
// Declared decision constants (F7 req 4/6: no hidden scoring, no hidden factors)
// ---------------------------------------------------------------------------
/** Priority points per working day of finish variance (adverse side only). */
export const PRIORITY_FINISH_WEIGHT = 10;
/** Priority points when the issue activity is itself a slipped or at-risk milestone. */
export const PRIORITY_MILESTONE_WEIGHT = 50;
/** SAR of financial exposure (|CV| + adverse VAC) per priority point. */
export const PRIORITY_FINANCIAL_UNIT = 5000;
/** Priority points for critical work. */
export const PRIORITY_CRITICAL_POINTS = 30;
/** Priority points for near-critical work. */
export const PRIORITY_NEAR_CRITICAL_POINTS = 15;
/** Priority points when the activity trend is worsening (CPI decay or float erosion). */
export const PRIORITY_WORSENING_POINTS = 20;
/** Declared confidence multiplier applied to the raw priority score. */
export const PRIORITY_CONFIDENCE_FACTOR: Record<ConfidenceLevel, number> = {
  High: 1,
  Medium: 0.8,
  Low: 0.5,
};
/** Maximum management actions emitted (top issues by priority). */
export const MAX_DECISION_ACTIONS = 5;
/** Remaining-duration factor for the add-resources scenario (crash to 80%). */
export const SCENARIO_RESOURCE_DURATION_FACTOR = 0.8;
/** Cost premium for the add-resources scenario (+15% of remaining baseline cost). */
export const SCENARIO_RESOURCE_COST_FACTOR = 1.15;
/** Remaining-duration factor for the improve-production scenario (method gain to 90%). */
export const SCENARIO_PRODUCTION_DURATION_FACTOR = 0.9;
/** Cost factor for the improve-production scenario (method gain carries no premium). */
export const SCENARIO_PRODUCTION_COST_FACTOR = 1.0;

export type ScenarioPresetKey = 'add_resources' | 'improve_production' | 'resequence';

export interface ScenarioPreset {
  key: ScenarioPresetKey;
  label: string;
  /** Remaining-duration multiplier applied to targets, or null when the preset changes logic only. */
  durationFactor: number | null;
  /** Cost premium applied to remaining baseline cost, or null when the preset has no rate basis. */
  costFactor: number | null;
  resequencesLinks: boolean;
  rationale: string;
}

/** Declared scenario presets: every factor and its reason, in evaluation order. */
export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    key: 'add_resources',
    label: 'Add crew / resources',
    durationFactor: SCENARIO_RESOURCE_DURATION_FACTOR,
    costFactor: SCENARIO_RESOURCE_COST_FACTOR,
    resequencesLinks: false,
    rationale: 'Extra capacity compresses remaining work to 80% at a 15% cost premium (overtime/extra crew).',
  },
  {
    key: 'improve_production',
    label: 'Improve production rate',
    durationFactor: SCENARIO_PRODUCTION_DURATION_FACTOR,
    costFactor: SCENARIO_PRODUCTION_COST_FACTOR,
    resequencesLinks: false,
    rationale: 'Method/supervision gain compresses remaining work to 90% with no cost premium.',
  },
  {
    key: 'resequence',
    label: 'Resequence where allowed',
    durationFactor: null,
    costFactor: null,
    resequencesLinks: true,
    rationale: 'Drops only non-driving FS links into the target; a logic change has no authoritative rate, so cost is N/A.',
  },
];

export type CauseConfidence = 'High' | 'Medium' | 'Low' | 'Unproven';
export type IntegratedCause =
  | 'late_start'
  | 'predecessor_delay'
  | 'duration_growth'
  | 'resource_constraint'
  | 'low_production'
  | 'remaining_increase'
  | 'logic_change'
  | 'calendar_change'
  | 'correlative'
  | null;

/**
 * Declared cause precedence: recorded-fact causes outrank inferred ones, and the first
 * cause with sufficient evidence wins. Deterministic by construction.
 */
export const CAUSE_PRECEDENCE: Array<Exclude<IntegratedCause, null | 'correlative'>> = [
  'late_start',
  'predecessor_delay',
  'duration_growth',
  'resource_constraint',
  'low_production',
  'remaining_increase',
  'logic_change',
  'calendar_change',
];

/** Declared management playbook: cause/side -> recommended action text. */
export const ACTION_PLAYBOOK: Record<string, string> = {
  late_start: 'Recover the late start: crash the remaining work or re-sequence successors (see scenario).',
  predecessor_delay: 'Clear the driving predecessor first; accelerating this activity alone cannot recover.',
  duration_growth: 'Re-plan the grown scope: re-estimate remaining work and fund the gap from reserves.',
  resource_constraint: 'Add crew/equipment to the constrained work (see add-resources scenario).',
  low_production: 'Fix the production rate: supervision, method, or crew skill (see improve-production scenario).',
  remaining_increase: 'Reconcile the stated remaining with the plan-implied value, then re-forecast.',
  logic_change: 'Review the logic change with planning before accelerating.',
  calendar_change: 'Review the calendar change with planning before accelerating.',
  correlative: 'Investigate jointly: time and cost signals coincide without a proven cause.',
  unproven: 'Collect evidence: confirm progress, actuals, and constraints before acting.',
  cost_only: 'Contain spend and re-price the remaining work; no schedule action is warranted.',
  time_only: 'Use available float or monitor; no cost action is warranted.',
};

export type IssueSide = 'time' | 'cost' | 'time_cost';
export type Criticality = 'critical' | 'near_critical' | 'non_critical' | 'unknown';

export interface IntegratedIssue {
  id: string;
  activityId: string;
  code: string;
  name: string;
  title: string;
  wbsId: string | null;
  wbsCode: string | null;
  boqRefs: Array<{ boqId: string; boqCode: string }>;
  side: IssueSide;
  patterns: string[];
  scheduleEvidence: string[];
  costEvidence: string[];
  timeImpact: {
    /** Exact F5 finish variance (working days); null when the activity has no baseline. */
    finishVarianceWd: number | null;
    milestoneState: string | null;
    milestoneVarianceWd: number | null;
    criticality: Criticality;
  };
  costImpact: {
    /** Exact F6 activity values (null when F6 reports N/A). */
    cv: number | null;
    cpi: number | null;
    eac: number | null;
    vac: number | null;
    affectedBudget: number;
  };
  cause: {
    category: IntegratedCause;
    confidence: CauseConfidence;
    basis: string;
    relationshipOnly: boolean;
  };
  confidence: {
    schedule: ConfidenceLevel;
    cost: ConfidenceLevel;
    /** Weakest-source cap over the sides the issue actually has. */
    overall: ConfidenceLevel;
  };
  priority: {
    score: number;
    finishDays: number | null;
    milestone: boolean;
    financialExposure: number;
    criticalityPoints: number;
    worsening: boolean;
    confidenceFactor: number;
    rank: number;
  };
}

export interface DecisionScenario {
  preset: ScenarioPresetKey;
  label: string;
  applicable: boolean;
  reason: string;
  targetIds: string[];
  droppedLinkIds: string[];
  currentFinish: string | null;
  scenarioFinish: string | null;
  /** Calendar days earlier than current (positive = saved); null when either finish is N/A. */
  daysSaved: number | null;
  currentEac: number | null;
  /** Composition only: current EAC + scenario cost. Null when either leg is N/A. */
  scenarioEac: number | null;
  costImpact: number | null;
  costBasis: 'baseline_rates' | 'no_rate_basis';
  improvesFinish: boolean;
  engines: { finish: 'analyzeScheduleControl'; cost: 'simulateScenario' | 'none' };
}

export interface DecisionAction {
  rank: number;
  issueId: string;
  code: string;
  title: string;
  evidence: string[];
  timeImpact: IntegratedIssue['timeImpact'];
  costImpact: IntegratedIssue['costImpact'];
  rootCause: { category: string; confidence: CauseConfidence } | null;
  rootCauseNote: string;
  recommendedAction: string;
  expectedBenefit: { daysSaved: number; costDelta: number | null } | null;
  expectedBenefitNote: string;
  confidence: ConfidenceLevel;
}

export interface RecoveryAssessment {
  required: boolean;
  reason: string;
  candidates: Array<{
    issueId: string;
    code: string;
    eligible: boolean;
    hasEvidence: boolean;
    improvesFinish: boolean;
    recommended: boolean;
    scenario: ScenarioPresetKey | null;
    reason: string;
  }>;
}

export type MatrixClass = 'on_track' | 'time_risk' | 'cost_risk' | 'time_cost_risk' | 'data_insufficient';

export interface MatrixRow {
  scope: 'activity' | 'wbs';
  id: string;
  code: string;
  name: string;
  class: MatrixClass;
  timeRisk: boolean;
  costRisk: boolean;
  notes: string[];
}

export interface EarlyWarning {
  code: string;
  activityCode: string | null;
  message: string;
  evidence: string[];
  confidence: ConfidenceLevel;
}

export interface ManagementSummary {
  forecastFinish: string | null;
  delayVsBaselineWd: number | null;
  recommendedEac: number | null;
  vac: number | null;
  topRisk: string | null;
  topDecision: string | null;
  overallConfidence: ConfidenceLevel;
  scheduleSource: ConfidenceLevel;
  costSource: ConfidenceLevel;
  overallNotes: string[];
}

export interface IntegratedDecisionReport {
  dataDate: string;
  /** Quoted from F6 by reference — never re-summed, so nothing double-counts. */
  totals: {
    bac: number | null;
    pv: number | null;
    ev: number | null;
    ac: number;
    cv: number | null;
    eac: number | null;
    vac: number | null;
  };
  fidelity: { rerunFinish: string | null; matchesCurrent: boolean; note: string };
  issues: IntegratedIssue[];
  /** Scenarios run for the decision set only (top issues + critical-delayed screen). */
  scenarios: Record<string, DecisionScenario[]>;
  recovery: RecoveryAssessment;
  actions: DecisionAction[];
  matrix: MatrixRow[];
  warnings: EarlyWarning[];
  summary: ManagementSummary;
}

export interface IntegratedDecisionInput {
  scheduleReport: ScheduleControlReport;
  costReport: CostControlReport;
  activities: Activity[];
  links: ActivityLink[];
  baselines: BaselineActivity[];
  progressUpdates?: ProgressUpdate[];
  previousScheduleSnapshot?: ScheduleUpdateSnapshot | null;
  /** Latest cost snapshot strictly before the Data Date (per-activity movement source). */
  previousCostSnapshot?: CostControlSnapshot | null;
  dataDate: string;
  calendarType?: CalendarType;
  statusLogic?: 'retained_logic' | 'progress_override';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function byCode<T extends { code: string }>(a: T, b: T): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/** Weakest-source cap: the integrated level never exceeds the weaker input. */
export function gateConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  const rank: Record<ConfidenceLevel, number> = { High: 3, Medium: 2, Low: 1 };
  return rank[a] <= rank[b] ? a : b;
}

export function analyzeIntegratedDecisions(input: IntegratedDecisionInput): IntegratedDecisionReport {
  const {
    scheduleReport: f5,
    costReport: f6,
    activities,
    links,
    baselines,
    dataDate,
    calendarType = '6_days',
    statusLogic = 'retained_logic',
  } = input;
  const progressUpdates = input.progressUpdates || [];
  const prevSched = input.previousScheduleSnapshot ?? null;
  const prevCostDetail = input.previousCostSnapshot?.details?.version === 1
    ? input.previousCostSnapshot.details.activities
    : null;

  const statusById = new Map<string, StatusedActivity>(f5.statused.map((s) => [s.id, s]));
  const varById = new Map<string, ActivityVariance>(f5.variances.map((v) => [v.id, v]));
  const attrById = new Map(f5.attribution.map((a) => [a.activityId, a]));
  const costById = new Map(f6.activities.map((c) => [c.id, c]));
  const nearSet = new Map(f5.nearCritical.map((n) => [n.id, n]));
  const msById = new Map(f5.milestones.map((m) => [m.id, m]));
  const traceByAct = new Map(f6.boqTrace.map((t) => [t.activityId, t]));
  const baselineByAct = new Map(baselines.map((b) => [b.activity_id, b]));
  const actById = new Map(activities.map((a) => [a.id, a]));
  const wbsCodeById = new Map(f6.wbs.map((w) => [w.id, w.code]));
  const drivingSet = new Set(f5.drivingLinkIds);
  const sortedActs = [...activities].sort(byCode);

  const f5ErrorOn = (id: string, code: string): boolean => f5.integrity.some(
    (f) => f.severity === 'error' && (f.activityId === id || f.activityCode === code),
  );
  const f6ErrorOn = (id: string): boolean => f6.integrity.some(
    (f) => f.severity === 'error' && f.refKind === 'activity' && f.refId === id,
  );

  // --- Per-activity signals (quoted from F5/F6; movement from the previous cost detail). ---
  interface Signals {
    delay: number | null;
    hasDelay: boolean;
    cv: number | null;
    cpi: number | null;
    vac: number | null;
    etc: number | null;
    bac: number;
    ac: number;
    hasCostSignal: boolean;
    prevCpi: number | null;
    cpiWorsened: boolean;
    acRising: boolean;
    evStalled: boolean;
    criticality: Criticality;
    completed: boolean;
    milestoneBad: boolean;
  }
  const signalsOf = (a: Activity): Signals => {
    const v = varById.get(a.id);
    const c = costById.get(a.id);
    const st = statusById.get(a.id);
    const ms = msById.get(a.id);
    const delay = v?.finishVarianceWd ?? null;
    const cv = c?.cv ?? null;
    const cpi = c?.cpi ?? null;
    const vac = c?.vac ?? null;
    const hasCostSignal = (cv !== null && cv < 0) || (cpi !== null && cpi < 1) || (vac !== null && vac < 0);
    const prev = prevCostDetail ? prevCostDetail[a.id] : undefined;
    const prevCpi = prev && prev.ac > 0 ? round3(prev.ev / prev.ac) : null;
    const curEv = c?.ev ?? null;
    const curAc = c?.ac ?? 0;
    return {
      delay,
      hasDelay: delay !== null && delay > 0,
      cv,
      cpi,
      vac,
      etc: c?.etc ?? null,
      bac: c?.bac ?? 0,
      ac: curAc,
      hasCostSignal,
      prevCpi,
      cpiWorsened: cpi !== null && prevCpi !== null && cpi < prevCpi,
      acRising: prev !== undefined && curAc > prev.ac,
      evStalled: prev !== undefined && curEv !== null && curEv <= prev.ev,
      criticality: !st ? 'unknown' : st.critical ? 'critical' : nearSet.has(a.id) ? 'near_critical' : 'non_critical',
      completed: st ? st.completed : (c?.pct ?? 0) >= 100,
      milestoneBad: ms !== undefined && (ms.state === 'slipped' || ms.state === 'at_risk'),
    };
  };

  // --- Cause analysis (recorded facts first; inference needs cross-engine corroboration). ---
  interface CauseOut { category: IntegratedCause; confidence: CauseConfidence; basis: string }
  const causeOf = (a: Activity, sig: Signals): CauseOut => {
    const v = varById.get(a.id);
    const st = statusById.get(a.id);
    const attr = attrById.get(a.id);
    const f5causes = new Set((attr?.causes || []).map((x) => x.cause));
    const corroborated = (sig.cv !== null && sig.cv < 0) || (sig.cpi !== null && sig.cpi < 1)
      || sig.cpiWorsened || sig.acRising;
    // Recorded facts -> High.
    const started = st?.actualStart || a.actual_start;
    if (sig.hasDelay && isIsoDate(started) && isIsoDate(v?.baselineStart)
      && (started as string) > (v?.baselineStart as string)) {
      return {
        category: 'late_start', confidence: 'High',
        basis: `Recorded actual_start ${started} is after baseline start ${v?.baselineStart}.`,
      };
    }
    if (sig.hasDelay && st) {
      const driving = st.drivingPredecessors
        .map((pid) => ({ pid, fv: varById.get(pid)?.finishVarianceWd ?? null }))
        .filter((x): x is { pid: string; fv: number } => x.fv !== null && x.fv > 0)
        .sort((x, y) => y.fv - x.fv);
      if (driving.length > 0) {
        const names = driving.map((x) => `${actById.get(x.pid)?.code || x.pid} (+${x.fv}d)`).join(', ');
        return {
          category: 'predecessor_delay', confidence: 'High',
          basis: `Driving predecessor(s) delayed vs baseline: ${names}.`,
        };
      }
    }
    if ((sig.hasDelay || sig.hasCostSignal) && v?.durationVarianceWd !== null
      && v?.durationVarianceWd !== undefined && (v.durationVarianceWd as number) > 0) {
      return {
        category: 'duration_growth', confidence: 'High',
        basis: `Recorded duration grew +${v.durationVarianceWd}d vs baseline (baseline ${v.baselineDuration}d).`,
      };
    }
    // F5-inferred causes -> Medium only with an F6 corroborating indicator, else Low.
    for (const cause of CAUSE_PRECEDENCE.slice(3)) {
      if (!f5causes.has(cause as never)) continue;
      const ev = (attr?.causes || []).find((x) => x.cause === cause)?.evidence || [];
      if (corroborated) {
        return {
          category: cause, confidence: 'Medium',
          basis: `F5 attributes ${cause} (${ev[0] || 'see schedule control'}) and cost indicators agree (CV ${sig.cv}, CPI ${sig.cpi}).`,
        };
      }
      return {
        category: cause, confidence: 'Low',
        basis: `F5 attributes ${cause} but no cost indicator corroborates it: relationship only, not cause.`,
      };
    }
    if (sig.hasDelay && sig.hasCostSignal) {
      return {
        category: 'correlative', confidence: 'Low',
        basis: 'Time and cost signals coincide with no attributed cause: relationship only, not cause.',
      };
    }
    return { category: null, confidence: 'Unproven', basis: 'No cause evidence: relationship only, not cause.' };
  };

  // --- Integrated issues (one per activity carrying a time and/or cost signal). ---
  const issues: IntegratedIssue[] = [];
  for (const a of sortedActs) {
    const sig = signalsOf(a);
    const st = statusById.get(a.id);
    const v = varById.get(a.id);
    const c = costById.get(a.id);
    const ms = msById.get(a.id);
    const near = nearSet.get(a.id);
    const patterns: string[] = [];
    if (sig.hasDelay && sig.cv !== null && sig.cv < 0) patterns.push('delayed_overrun');
    if (sig.hasDelay && sig.acRising && sig.evStalled) patterns.push('delayed_ev_stalled');
    if (sig.hasDelay && sig.ac === 0) patterns.push('slippage_without_cost');
    if (sig.cv !== null && sig.cv < 0 && sig.criticality !== 'critical' && sig.criticality !== 'near_critical') {
      patterns.push('overrun_off_critical');
    }
    if (sig.criticality === 'near_critical' && sig.cpiWorsened) patterns.push('near_critical_cpi_decay');
    const pct = c?.pct ?? 0;
    if (pct >= 100 && ((sig.etc !== null && sig.etc > 0) || (sig.cv !== null && sig.cv < 0))) {
      patterns.push('complete_with_exposure');
    }
    const attr = attrById.get(a.id);
    if (attr?.causes.some((x) => x.cause === 'resource_constraint')
      && ((sig.cpi !== null && sig.cpi < 1) || sig.cpiWorsened)) {
      patterns.push('resource_joint');
    }
    if (sig.hasDelay && !sig.hasCostSignal) patterns.push('time_only');
    if (sig.hasCostSignal && !sig.hasDelay) patterns.push('cost_only');
    if (!sig.hasDelay && !sig.hasCostSignal && patterns.length === 0) continue;

    const side: IssueSide = sig.hasDelay && sig.hasCostSignal ? 'time_cost' : sig.hasDelay ? 'time' : 'cost';
    const scheduleEvidence: string[] = [];
    if (sig.delay !== null) scheduleEvidence.push(`finish variance ${sig.delay > 0 ? '+' : ''}${sig.delay}d vs baseline`);
    else scheduleEvidence.push('no baseline variance (N/A)');
    if (st) scheduleEvidence.push(`float TF ${st.totalFloat}d, ${sig.criticality}`);
    if (ms && sig.milestoneBad) scheduleEvidence.push(`milestone ${ms.state} (${ms.varianceWd}d)`);
    if (attr && attr.causes.length > 0) {
      scheduleEvidence.push(`F5 attribution: ${attr.causes.map((x) => x.cause).join(', ')} (primary ${attr.primary})`);
    }
    if (near?.erosion !== null && near?.erosion !== undefined && (near.erosion as number) > 0) {
      scheduleEvidence.push(`float erosion ${near.erosion}d since previous update`);
    }
    const costEvidence: string[] = [];
    if (sig.cv !== null) costEvidence.push(`CV ${sig.cv} (EV ${c?.ev} vs AC ${c?.ac})`);
    else costEvidence.push('CV N/A');
    if (sig.cpi !== null) costEvidence.push(`CPI ${sig.cpi}`);
    if (sig.prevCpi !== null && sig.cpi !== null) {
      costEvidence.push(`CPI ${sig.prevCpi} -> ${sig.cpi}${sig.cpiWorsened ? ' (worsening)' : ''}`);
    }
    if (c?.eac !== null && c?.eac !== undefined) costEvidence.push(`EAC ${c.eac} via ${c.eacMethod}`);
    if (sig.vac !== null) costEvidence.push(`VAC ${sig.vac}`);
    costEvidence.push(`budget ${sig.bac} (BAC)`);
    if (!sig.hasCostSignal) costEvidence.push('no adverse cost signal');

    const cause = causeOf(a, sig);
    const schedConf: ConfidenceLevel = sig.delay !== null
      ? (f5ErrorOn(a.id, a.code) ? 'Medium' : 'High') : 'Low';
    const costConf: ConfidenceLevel = sig.bac > 0
      ? (f6ErrorOn(a.id) ? 'Medium' : 'High') : sig.ac > 0 ? 'Medium' : 'Low';
    const overall = side === 'time' ? schedConf : side === 'cost' ? costConf : gateConfidence(schedConf, costConf);

    const milestone = sig.milestoneBad;
    const financialExposure = round2(Math.abs(sig.cv || 0) + Math.max(0, -(sig.vac || 0)));
    const criticalityPoints = sig.criticality === 'critical' ? PRIORITY_CRITICAL_POINTS
      : sig.criticality === 'near_critical' ? PRIORITY_NEAR_CRITICAL_POINTS : 0;
    const eroding = (near?.erosion ?? 0) > 0 || (v?.floatChange !== null && v?.floatChange !== undefined && v.floatChange < 0);
    const worsening = sig.cpiWorsened || eroding;
    const raw = PRIORITY_FINISH_WEIGHT * Math.max(0, sig.delay || 0)
      + (milestone ? PRIORITY_MILESTONE_WEIGHT : 0)
      + Math.floor(financialExposure / PRIORITY_FINANCIAL_UNIT)
      + criticalityPoints
      + (worsening ? PRIORITY_WORSENING_POINTS : 0);
    const score = round2(raw * PRIORITY_CONFIDENCE_FACTOR[overall]);
    const trace = traceByAct.get(a.id);

    const titleBits: string[] = [];
    if (sig.hasDelay) titleBits.push(`delayed +${sig.delay}d`);
    if (sig.cv !== null && sig.cv < 0) titleBits.push(`CV ${sig.cv}`);
    if (patterns.includes('slippage_without_cost')) titleBits.push('no cost evidence');
    if (patterns.includes('overrun_off_critical')) titleBits.push('off critical path');
    issues.push({
      id: `issue-${a.code}`,
      activityId: a.id,
      code: a.code,
      name: a.name,
      title: `${a.code} ${titleBits.join(' · ') || side}`,
      wbsId: a.wbs_node_id || null,
      wbsCode: (a.wbs_node_id && wbsCodeById.get(a.wbs_node_id)) || null,
      boqRefs: (trace?.items || []).map((t) => ({ boqId: t.boqId, boqCode: t.boqCode })),
      side,
      patterns,
      scheduleEvidence,
      costEvidence,
      timeImpact: {
        finishVarianceWd: sig.delay,
        milestoneState: ms?.state || null,
        milestoneVarianceWd: ms?.varianceWd ?? null,
        criticality: sig.criticality,
      },
      costImpact: {
        cv: sig.cv,
        cpi: sig.cpi,
        eac: c?.eac ?? null,
        vac: sig.vac,
        affectedBudget: sig.bac,
      },
      cause: {
        category: cause.category,
        confidence: cause.confidence,
        basis: cause.basis,
        relationshipOnly: cause.confidence === 'Low' || cause.confidence === 'Unproven',
      },
      confidence: { schedule: schedConf, cost: costConf, overall },
      priority: {
        score,
        finishDays: sig.delay,
        milestone,
        financialExposure,
        criticalityPoints,
        worsening,
        confidenceFactor: PRIORITY_CONFIDENCE_FACTOR[overall],
        rank: 0,
      },
    });
  }
  issues.sort((a, b) => b.priority.score - a.priority.score || (a.id < b.id ? -1 : 1));
  issues.forEach((it, i) => { it.priority.rank = i + 1; });

  // --- Fidelity anchor: the unmodified rerun must reproduce the current F5 finish exactly. ---
  const currentFinish = f5.project.forecastFinish;
  const currentEac = f6.project.eac;
  const rerunF5 = (acts: Activity[], lks: ActivityLink[]): ScheduleControlReport => analyzeScheduleControl({
    activities: acts,
    links: lks,
    baselines,
    progressUpdates,
    previousSnapshot: prevSched,
    dataDate,
    calendarType,
    statusLogic,
  });
  const fidelityRun = rerunF5(activities, links);
  const fidelity = {
    rerunFinish: fidelityRun.project.forecastFinish,
    matchesCurrent: fidelityRun.project.forecastFinish === currentFinish,
    note: 'keep-current rerun of analyzeScheduleControl with identical inputs (previous snapshot passed through).',
  };

  // --- Decision scenarios (actual reruns; decision set = top issues + critical-delayed screen). ---
  const scenarioSet = new Set<string>();
  for (const it of issues.slice(0, MAX_DECISION_ACTIONS)) scenarioSet.add(it.id);
  for (const it of issues) {
    const st = statusById.get(it.activityId);
    if ((it.timeImpact.criticality === 'critical' || it.timeImpact.criticality === 'near_critical')
      && (it.timeImpact.finishVarianceWd || 0) > 0 && st && !st.completed) {
      scenarioSet.add(it.id);
    }
  }
  const scenarios: Record<string, DecisionScenario[]> = {};
  const runIssueScenarios = (it: IntegratedIssue): DecisionScenario[] => {
    const out: DecisionScenario[] = [];
    const st = statusById.get(it.activityId);
    const act = actById.get(it.activityId);
    if (!act || !st || st.completed) {
      for (const preset of SCENARIO_PRESETS) {
        out.push({
          preset: preset.key, label: preset.label, applicable: false,
          reason: !act || !st ? 'Activity missing from statused schedule.' : 'Activity complete: nothing to accelerate.',
          targetIds: [], droppedLinkIds: [],
          currentFinish, scenarioFinish: null, daysSaved: null,
          currentEac, scenarioEac: null, costImpact: null, costBasis: 'no_rate_basis',
          improvesFinish: false, engines: { finish: 'analyzeScheduleControl', cost: 'none' },
        });
      }
      return out;
    }
    const remainingBase = st.remaining
      ?? Math.max(0, (Number(act.duration_days) || 0) * (1 - st.percentComplete / 100));
    const elapsed = Math.max(0, (Number(act.duration_days) || 0) - remainingBase);
    for (const preset of SCENARIO_PRESETS) {
      if (preset.resequencesLinks) {
        const dropped = links
          .filter((l) => l.successor_id === act.id && l.link_type === 'FS' && !drivingSet.has(l.id))
          .map((l) => l.id);
        if (dropped.length === 0) {
          out.push({
            preset: preset.key, label: preset.label, applicable: false,
            reason: 'No non-driving FS links into the target: nothing may be resequenced.',
            targetIds: [act.id], droppedLinkIds: [],
            currentFinish, scenarioFinish: null, daysSaved: null,
            currentEac, scenarioEac: null, costImpact: null, costBasis: 'no_rate_basis',
            improvesFinish: false, engines: { finish: 'analyzeScheduleControl', cost: 'none' },
          });
          continue;
        }
        const kept = links.filter((l) => !dropped.includes(l.id));
        const run = rerunF5(activities, kept);
        const scenarioFinish = run.project.forecastFinish;
        const daysSaved = scenarioFinish && currentFinish
          ? calendarDaysBetween(scenarioFinish, currentFinish) : null;
        out.push({
          preset: preset.key, label: preset.label, applicable: true,
          reason: `${preset.rationale} Dropped link(s): ${dropped.join(', ')}.`,
          targetIds: [act.id], droppedLinkIds: dropped,
          currentFinish, scenarioFinish, daysSaved,
          currentEac, scenarioEac: null, costImpact: null, costBasis: 'no_rate_basis',
          improvesFinish: daysSaved !== null && daysSaved > 0,
          engines: { finish: 'analyzeScheduleControl', cost: 'none' },
        });
        continue;
      }
      // Duration presets: compress the target's remaining work, then rerun the CPM.
      const factor = preset.durationFactor as number;
      const newRemaining = remainingBase * factor;
      const crashed: Activity = {
        ...act,
        duration_days: elapsed + newRemaining,
        remaining_duration_days: newRemaining,
      };
      const modActs = activities.map((x) => (x.id === act.id ? crashed : x));
      const run = rerunF5(modActs, links);
      const scenarioFinish = run.project.forecastFinish;
      const daysSaved = scenarioFinish && currentFinish
        ? calendarDaysBetween(scenarioFinish, currentFinish) : null;
      // Cost leg: authoritative only when the target carries a baseline rate.
      const rate = Number(baselineByAct.get(act.id)?.planned_cost) || 0;
      let costImpact: number | null = null;
      let costBasis: DecisionScenario['costBasis'] = 'no_rate_basis';
      let costNote = 'No baseline rate covers the target: cost impact is N/A.';
      if (rate > 0 && preset.costFactor !== null) {
        const costRun = simulateScenario(
          [crashed],
          baselines,
          { productivityFactor: 1, resourceCapacityFactor: 1, costFactor: preset.costFactor, delayDays: 0 },
          dataDate,
          null,
        );
        costImpact = round2(costRun.incrementalCost);
        costBasis = 'baseline_rates';
        costNote = `simulateScenario cost leg over the target scope at cost factor ${preset.costFactor}.`;
      }
      out.push({
        preset: preset.key, label: preset.label, applicable: true,
        reason: `${preset.rationale} Remaining ${round2(remainingBase)}d -> ${round2(newRemaining)}d. ${costNote}`,
        targetIds: [act.id], droppedLinkIds: [],
        currentFinish, scenarioFinish, daysSaved,
        currentEac,
        scenarioEac: currentEac !== null && costImpact !== null ? round2(currentEac + costImpact) : null,
        costImpact, costBasis,
        improvesFinish: daysSaved !== null && daysSaved > 0,
        engines: { finish: 'analyzeScheduleControl', cost: costBasis === 'baseline_rates' ? 'simulateScenario' : 'none' },
      });
    }
    return out;
  };
  for (const it of issues) {
    if (scenarioSet.has(it.id)) scenarios[it.id] = runIssueScenarios(it);
  }

  // --- Recovery decision support (banned unless proven to move project finish). ---
  const projectLate = (f5.project.totalDelayWd || 0) > 0;
  const recoveryCandidates: RecoveryAssessment['candidates'] = [];
  for (const it of issues) {
    const st = statusById.get(it.activityId);
    const criticalish = it.timeImpact.criticality === 'critical' || it.timeImpact.criticality === 'near_critical';
    const eligible = projectLate && criticalish && !!st && !st.completed;
    const attr = attrById.get(it.activityId);
    const hasEvidence = !!attr?.causes.some((x) => x.cause === 'resource_constraint' || x.cause === 'low_production');
    const set = scenarios[it.id] || [];
    const improving = set.filter((s) => s.applicable && s.improvesFinish);
    const best = [...improving].sort((a, b) => {
      const d = (b.daysSaved || 0) - (a.daysSaved || 0);
      if (d !== 0) return d;
      const ca = a.costImpact === null ? Number.POSITIVE_INFINITY : a.costImpact;
      const cb = b.costImpact === null ? Number.POSITIVE_INFINITY : b.costImpact;
      if (ca !== cb) return ca - cb;
      return SCENARIO_PRESETS.findIndex((p) => p.key === a.preset)
        - SCENARIO_PRESETS.findIndex((p) => p.key === b.preset);
    })[0];
    let recommended = false;
    let reason: string;
    if (!projectLate) {
      reason = 'Project forecast is not late: recovery is not required.';
    } else if (!criticalish) {
      reason = 'Banned: activity is not critical/near-critical, so accelerating it cannot be tied to project finish.';
    } else if (!st || st.completed) {
      reason = 'Banned: activity is complete or unscheduled.';
    } else if (!hasEvidence) {
      reason = 'Banned: no resource/productivity evidence (needs F5 resource_constraint or low_production).';
    } else if (!scenarioSet.has(it.id)) {
      reason = 'Outside the decision set: no rerun was executed, so no recommendation is proven.';
    } else if (!best) {
      reason = 'Banned: no scenario improves project finish after rerun.';
    } else {
      recommended = true;
      reason = `Recommended: ${best.label} saves ${best.daysSaved}d after rerun.`;
    }
    recoveryCandidates.push({
      issueId: it.id,
      code: it.code,
      eligible,
      hasEvidence,
      improvesFinish: improving.length > 0,
      recommended,
      scenario: recommended && best ? best.preset : null,
      reason,
    });
  }
  const recovery: RecoveryAssessment = {
    required: projectLate,
    reason: projectLate
      ? `Project forecast is +${f5.project.totalDelayWd}d vs baseline: recovery is required.`
      : 'Project forecast is on time vs baseline: recovery is not required.',
    candidates: recoveryCandidates,
  };

  // --- Top management actions (traceable to issues, evidence, and reruns). ---
  const actions: DecisionAction[] = [];
  for (const it of issues.slice(0, MAX_DECISION_ACTIONS)) {
    const proven = it.cause.confidence === 'High' || it.cause.confidence === 'Medium';
    const playKey = proven && it.cause.category
      ? it.cause.category
      : it.side === 'cost' ? 'cost_only' : it.side === 'time' ? 'time_only'
        : it.cause.category === 'correlative' ? 'correlative' : 'unproven';
    const cand = recoveryCandidates.find((x) => x.issueId === it.id);
    const set = scenarios[it.id] || [];
    const rec = cand?.recommended && cand.scenario
      ? set.find((s) => s.preset === cand.scenario) : undefined;
    actions.push({
      rank: actions.length + 1,
      issueId: it.id,
      code: it.code,
      title: it.title,
      evidence: [...it.scheduleEvidence, ...it.costEvidence],
      timeImpact: it.timeImpact,
      costImpact: it.costImpact,
      rootCause: proven && it.cause.category
        ? { category: it.cause.category, confidence: it.cause.confidence } : null,
      rootCauseNote: proven ? it.cause.basis : `${it.cause.basis} (no proven root cause claimed)`,
      recommendedAction: ACTION_PLAYBOOK[playKey] || ACTION_PLAYBOOK.unproven,
      expectedBenefit: rec && rec.daysSaved !== null
        ? { daysSaved: rec.daysSaved, costDelta: rec.costImpact } : null,
      expectedBenefitNote: rec && rec.daysSaved !== null
        ? `Measured by ${rec.label} rerun: finish ${rec.currentFinish} -> ${rec.scenarioFinish}.`
        : 'Not measurable: no recommended scenario improved finish after rerun.',
      confidence: it.confidence.overall,
    });
  }

  // --- Schedule-cost trend matrix (F5/F6 outputs only). ---
  const activityRisk = (a: Activity): { time: boolean; cost: boolean; notes: string[] } => {
    const notes: string[] = [];
    const sig = signalsOf(a);
    const ms = msById.get(a.id);
    const c = costById.get(a.id);
    const time = sig.hasDelay || sig.milestoneBad;
    if (sig.hasDelay) notes.push(`delay +${sig.delay}d`);
    if (sig.milestoneBad && ms) notes.push(`milestone ${ms.state}`);
    const exposed = (c?.pct ?? 0) >= 100 && sig.etc !== null && sig.etc > 0;
    const cost = sig.hasCostSignal || exposed;
    if (sig.cv !== null && sig.cv < 0) notes.push(`CV ${sig.cv}`);
    if (sig.vac !== null && sig.vac < 0) notes.push(`VAC ${sig.vac}`);
    if (exposed) notes.push(`complete with ETC ${sig.etc} exposure`);
    return { time, cost, notes };
  };
  const timeAssessable = (a: Activity): boolean => {
    const ms = msById.get(a.id);
    return (varById.get(a.id)?.finishVarianceWd ?? null) !== null
      || (ms !== undefined && ms.varianceWd !== null);
  };
  const costAssessable = (a: Activity): boolean => {
    const c = costById.get(a.id);
    return (c?.bac ?? 0) > 0 || (c?.ac ?? 0) > 0;
  };
  const matrix: MatrixRow[] = [];
  for (const a of sortedActs) {
    const r = activityRisk(a);
    const known = timeAssessable(a) || costAssessable(a);
    const cls: MatrixClass = !known ? 'data_insufficient'
      : r.time && r.cost ? 'time_cost_risk' : r.time ? 'time_risk' : r.cost ? 'cost_risk' : 'on_track';
    matrix.push({
      scope: 'activity', id: a.id, code: a.code, name: a.name, class: cls,
      timeRisk: r.time, costRisk: r.cost,
      notes: known ? r.notes : ['no baseline variance and no cost record: cannot assess'],
    });
  }
  // WBS rows: worst-of descendants for time; own F6 row plus descendants for cost.
  const actsByWbs = new Map<string, Activity[]>();
  const homeless: Activity[] = [];
  for (const a of sortedActs) {
    if (a.wbs_node_id) {
      const list = actsByWbs.get(a.wbs_node_id) || [];
      list.push(a);
      actsByWbs.set(a.wbs_node_id, list);
    } else {
      homeless.push(a);
    }
  }
  const wbsKids = new Map(f6.wbs.map((w) => [w.id, w.childIds]));
  const wbsDescendants = (id: string, seen: Set<string>): Activity[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const direct = actsByWbs.get(id) || [];
    const kids = (wbsKids.get(id) || []).flatMap((k) => wbsDescendants(k, seen));
    return [...direct, ...kids];
  };
  const wbsRow = (id: string, code: string, name: string, own: { bac: number; ac: number; cv: number | null; vac: number | null }, members: Activity[]): void => {
    const risks = members.map((m) => activityRisk(m));
    const time = risks.some((r) => r.time);
    const cost = (own.cv !== null && own.cv < 0) || (own.vac !== null && own.vac < 0)
      || risks.some((r) => r.cost);
    const known = members.some((m) => timeAssessable(m) || costAssessable(m)) || own.bac > 0 || own.ac > 0;
    const cls: MatrixClass = !known ? 'data_insufficient'
      : time && cost ? 'time_cost_risk' : time ? 'time_risk' : cost ? 'cost_risk' : 'on_track';
    matrix.push({
      scope: 'wbs', id, code, name, class: cls, timeRisk: time, costRisk: cost,
      notes: known
        ? [`${members.length} activit${members.length === 1 ? 'y' : 'ies'}`, `CV ${own.cv}`, `VAC ${own.vac}`]
        : ['no assessable members and no cost record: cannot assess'],
    });
  };
  for (const w of [...f6.wbs].sort(byCode)) {
    wbsRow(w.id, w.code, w.name, { bac: w.bac, ac: w.ac, cv: w.cv, vac: w.vac }, wbsDescendants(w.id, new Set()));
  }
  wbsRow(
    f6.unassigned.id, f6.unassigned.code, f6.unassigned.name,
    { bac: f6.unassigned.bac, ac: f6.unassigned.ac, cv: f6.unassigned.cv, vac: f6.unassigned.vac },
    homeless,
  );

  // --- Early warnings (emerging only; each rule names its own gate). ---
  const warnings: EarlyWarning[] = [];
  for (const a of sortedActs) {
    const sig = signalsOf(a);
    const st = statusById.get(a.id);
    const near = nearSet.get(a.id);
    const ms = msById.get(a.id);
    const attr = attrById.get(a.id);
    if (!st || st.completed) continue;
    const wConf = gateConfidence(
      sig.delay !== null ? 'High' : 'Low', sig.bac > 0 ? 'High' : sig.ac > 0 ? 'Medium' : 'Low',
    );
    // 1. Float erosion + CPI deterioration on near-critical work (not yet critical by construction).
    if (near && (near.erosion || 0) > 0 && sig.cpiWorsened) {
      warnings.push({
        code: 'erosion_with_cpi_decay',
        activityCode: a.code,
        message: `${a.code} is near-critical with ${near.erosion}d float erosion and CPI ${sig.prevCpi} -> ${sig.cpi}.`,
        evidence: [`erosion ${near.erosion}d`, `CPI ${sig.prevCpi} -> ${sig.cpi}`, `TF ${st.totalFloat}d`],
        confidence: wConf,
      });
    }
    // 2. Milestone at risk + growing ETC (at_risk, never slipped: still emerging).
    if (ms && ms.state === 'at_risk' && f6.drift.etcDrift !== null && f6.drift.etcDrift > 0) {
      warnings.push({
        code: 'milestone_etc_growth',
        activityCode: a.code,
        message: `${a.code} milestone is at risk (+${ms.varianceWd}d) while ETC grew +${f6.drift.etcDrift} since ${f6.drift.previousDataDate}.`,
        evidence: [`milestone variance +${ms.varianceWd}d`, `ETC drift +${f6.drift.etcDrift}`],
        confidence: wConf,
      });
    }
    // 3. EAC worsening + near-critical path.
    if (near && f6.drift.eacDrift !== null && f6.drift.eacDrift > 0) {
      warnings.push({
        code: 'eac_worsening_near_critical',
        activityCode: a.code,
        message: `${a.code} is near-critical while recommended EAC worsened +${f6.drift.eacDrift}.`,
        evidence: [`TF ${st.totalFloat}d`, `EAC drift +${f6.drift.eacDrift}`],
        confidence: wConf,
      });
    }
    // 4. Low production + increasing cost burn.
    const burnUp = (f6.burn.sufficient && (f6.burn.acBurnPerDay || 0) > (f6.burn.evRatePerDay || 0)) || sig.acRising;
    if (attr?.causes.some((x) => x.cause === 'low_production') && burnUp && !st.critical) {
      warnings.push({
        code: 'low_production_cost_burn',
        activityCode: a.code,
        message: `${a.code} shows low production with rising cost burn.`,
        evidence: [
          'F5 low_production attribution',
          sig.acRising ? `AC rising (${prevCostDetail?.[a.id]?.ac} -> ${sig.ac})` : `burn ${f6.burn.acBurnPerDay}/d vs earn ${f6.burn.evRatePerDay}/d`,
        ],
        confidence: wConf,
      });
    }
  }
  warnings.sort((a, b) => (a.code < b.code ? -1 : 1) || ((a.activityCode || '') < (b.activityCode || '') ? -1 : 1));

  // --- Management summary (weakest-source overall confidence). ---
  const schedSource = f5.confidence.forecastFinish.level;
  const costSource = f6.confidence.forecast.level;
  const summary: ManagementSummary = {
    forecastFinish: currentFinish,
    delayVsBaselineWd: f5.project.totalDelayWd,
    recommendedEac: currentEac,
    vac: f6.project.vac,
    topRisk: issues.length > 0 ? issues[0].title : null,
    topDecision: actions.length > 0 ? actions[0].recommendedAction : null,
    overallConfidence: gateConfidence(schedSource, costSource),
    scheduleSource: schedSource,
    costSource,
    overallNotes: [
      `schedule source (F5 forecast finish): ${schedSource}`,
      `cost source (F6 forecast): ${costSource}`,
      `overall capped at the weaker source: ${gateConfidence(schedSource, costSource)}`,
    ],
  };

  return {
    dataDate,
    totals: {
      bac: f6.project.bac,
      pv: f6.project.pv,
      ev: f6.project.ev,
      ac: f6.project.ac,
      cv: f6.project.cv,
      eac: f6.project.eac,
      vac: f6.project.vac,
    },
    fidelity,
    issues,
    scenarios,
    recovery,
    actions,
    matrix,
    warnings,
    summary,
  };
}

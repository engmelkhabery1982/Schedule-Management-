/**
 * F8 — Forecast Accuracy, Trends & Confidence.
 *
 * A pure, deterministic trust layer over the F5 schedule-control report, the F6 cost-control
 * report, the F7 integrated-decision report, and the persisted snapshot history. It introduces
 * NO new CPM, EVM, or EAC mathematics: every current value is quoted from F5/F6/F7 by
 * reference, every working-day distance reuses the F5 `workingDayDelta` helper, and every
 * confidence cap reuses the F7 `gateConfidence` weakest-source rule. F8 only adds:
 *
 *  1. Forecast accuracy — previous forecasts vs recorded outcomes (finish, milestone, EAC, ETC)
 *     plus an optimism/pessimism bias vote over the measurable signals.
 *  2. Trend quality — finish drift, float trend, CPI/SPI trend, EAC drift, VAC direction over
 *     the snapshot history (cost series quoted from the F6 trend by reference).
 *  3. Data-quality scores — per domain (schedule, progress, cost, baseline, forecast) with
 *     completeness / freshness / consistency / traceability sub-scores and a declared weighting.
 *  4. A confidence model — High/Medium/Low built ONLY on quoted evidence, with the weakest
 *     source capping every integrated forecast (data quality is itself a capping source).
 *  5. Stale-data detection with declared thresholds (progress, cost updates, snapshots, missing
 *     current update).
 *  6. Evidence-based integrity findings — F5/F6 findings quoted by reference plus the F8-only
 *     cross-checks (duplicate evidence, missing baseline, BOQ/activity trace gaps, future-dated
 *     snapshots, BOQ over-allocation).
 *  7. Forecast reliability classification — Reliable / Usable with caution / Weak /
 *     Not supportable, deterministic with explicit reasons.
 *  8. Decision confidence — F7 actions re-capped by the integrated forecast confidence; a Low
 *     effective confidence blocks strong recommendations and lists the evidence gaps.
 *  9. Historical calibration — optimistic / pessimistic / stable forecast behaviour, evaluated
 *     ONLY after enough snapshots; otherwise N/A.
 * 10. Accuracy KPIs — MAE of finish forecasts, milestone hit rate, EAC forecast error %,
 *     forecast drift per update; each published only when its sample floor is met.
 * 11. Executive trust summary — one quoted number per headline plus its confidence, the overall
 *     data quality, the top data risk, and the most/least reliable KPI.
 *
 * Hard rules (locked by the F8 charter):
 * - No false precision: any metric whose source evidence is missing or below its declared sample
 *   floor is N/A (null) with a stated reason. Nothing is ever defaulted or back-filled.
 * - Weakest-source cap: an integrated forecast never carries more confidence than the weakest
 *   source that feeds it (schedule confidence, cost confidence, overall data quality).
 * - Constants are declared and exported below; no hidden thresholds anywhere in this file.
 * - Deterministic: identical inputs always produce byte-identical outputs (fixed iteration
 *   order, declared tie-breaks, no clock, no randomness).
 */

import { getCalendar } from './calendarEngine';
import { calendarDaysBetween, isAfterDataDate, isIsoDate } from './chronologyGuard';
import type { CostControlReport } from './costControlEngine';
import { gateConfidence } from './integratedDecisionEngine';
import type { IntegratedDecisionReport } from './integratedDecisionEngine';
import type {
  ConfidenceLevel,
  ScheduleControlReport,
} from './scheduleControlEngine';
import {
  FORECAST_MATCH_TOLERANCE_WD,
  UPDATE_STALENESS_DAYS,
  workingDayDelta,
} from './scheduleControlEngine';
import type {
  Activity,
  ActivityBoqAllocation,
  ActivityLink,
  BaselineActivity,
  BoqItem,
  CalendarType,
  CostControlSnapshot,
  CostTransaction,
  ProgressUpdate,
  ScheduleUpdateSnapshot,
} from '@/types';

// ---------------------------------------------------------------------------
// Declared F8 constants (no hidden thresholds; every rule cites one of these)
// ---------------------------------------------------------------------------
/** F8: progress evidence reuses the F5 staleness window (`UPDATE_STALENESS_DAYS` = 7 days). */
export const PROGRESS_STALE_DAYS = UPDATE_STALENESS_DAYS;
/** F8: approved cost spend older than this (calendar days before the Data Date) is stale. */
export const COST_STALE_DAYS = 14;
/** F8: a persisted control snapshot older than this (calendar days) is stale. */
export const SNAPSHOT_STALE_DAYS = 14;
/** F8: minimum signed drift samples (update pairs) before calibration is published. */
export const MIN_CALIBRATION_DRIFTS = 3;
/** F8: share of same-signed drifts that classifies calibration as optimistic/pessimistic. */
export const CALIBRATION_MAJORITY_SHARE = 0.6;
/** F8: minimum outcome samples before an accuracy KPI (MAE, hit rate) is published. */
export const MIN_ACCURACY_SAMPLES = 3;
/** F8: minimum adjacent forecast pairs before drift-per-update is published. */
export const MIN_DRIFT_PAIRS = 2;
/** F8: mean total-float change inside ±1 working day reads as a stable float trend. */
export const FLOAT_TREND_BAND_WD = 1;
/** F8: CPI/SPI movement inside ±0.05 index points reads as a stable trend. */
export const INDEX_TREND_BAND = 0.05;
/** F8: VAC movement inside 1% of BAC reads as stable (0 when BAC is unavailable). */
export const VAC_STABLE_BAND_PCT_OF_BAC = 0.01;
/** F8: declared data-quality weighting of the four sub-scores (sums to 1). */
export const DQ_WEIGHTS = {
  completeness: 0.3,
  freshness: 0.25,
  consistency: 0.25,
  traceability: 0.2,
} as const;
/** F8: domain score at/above this reads High. */
export const DQ_HIGH_MIN = 80;
/** F8: domain score at/above this reads Medium; below reads Low. */
export const DQ_MEDIUM_MIN = 50;
/** F8: freshness decays linearly from 100 at the threshold to 0 at this multiple of it. */
export const DQ_FRESHNESS_ZERO_MULTIPLIER = 3;
/** F8: consistency deduction per integrity error in the domain's evidence set. */
export const DQ_ERROR_DEDUCTION = 10;
/** F8: consistency deduction per integrity warning in the domain's evidence set. */
export const DQ_WARNING_DEDUCTION = 2;
/** F8: numeric sub-score a quoted High/Medium/Low confidence maps to. */
export const LEVEL_SCORE: Record<ConfidenceLevel, number> = { High: 100, Medium: 60, Low: 20 };
/** F8: reliability ladder order (weakest first) used for the integrated cap. */
export const RELIABILITY_ORDER = ['not_supportable', 'weak', 'usable_with_caution', 'reliable'] as const;

export type ReliabilityClass = (typeof RELIABILITY_ORDER)[number];
export type BiasDirection = 'optimistic' | 'pessimistic' | 'neutral' | 'insufficient';
export type DataQualityDomainKey = 'schedule' | 'progress' | 'cost' | 'baseline' | 'forecast';
export type TrendDirection = 'improving' | 'worsening' | 'stable' | 'insufficient';

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface FinishForecastError {
  previousSnapshotDate: string | null;
  previousForecastFinish: string | null;
  /** Actual project finish — only when EVERY activity is complete; never a forecast. */
  outcomeFinish: string | null;
  /** Signed working days `outcome − forecast` (positive = the forecast was optimistic). */
  errorWd: number | null;
  reason: string;
  evidence: string[];
}

export interface MilestoneForecastSample {
  code: string;
  snapshotDate: string;
  forecastDate: string;
  actualDate: string | null;
  errorWd: number | null;
  /** True when the milestone landed within the F5 tolerance of its forecast date. */
  hit: boolean | null;
  outcome: 'achieved_on_time' | 'achieved_late' | 'still_missing' | 'pending';
}

export interface MilestoneForecastError {
  /** Samples measured against the most recent previous snapshot only (accuracy section). */
  samples: MilestoneForecastSample[];
  dueByDataDate: number;
  achievedOnTime: number;
  achievedLate: number;
  stillMissing: number;
  meanSignedWd: number | null;
  meanAbsWd: number | null;
  reason: string;
}

export interface EacForecastError {
  previousSnapshotDate: string | null;
  previousEac: number | null;
  /** Final actual cost — only when the project is complete and AC is transaction-backed. */
  outcomeEac: number | null;
  /** Signed SAR `outcome − forecast` (positive = the forecast was optimistic). */
  error: number | null;
  errorPct: number | null;
  /** Interim movement quoted from F6 (drift, not an outcome error) — labelled as such. */
  interimDriftFromF6: number | null;
  reason: string;
  evidence: string[];
}

export interface EtcForecastError {
  previousSnapshotDate: string | null;
  previousEtc: number | null;
  /** Approved spend strictly between the previous snapshot date and the Data Date. */
  spendSincePrevious: number | null;
  currentEtc: number | null;
  /** `spendSincePrevious + currentEtc` — what the previous ETC should have been, in hindsight. */
  revisedEtcFromPrevious: number | null;
  /** Signed SAR `revised − previous` (positive = the previous ETC was optimistic). */
  error: number | null;
  errorPct: number | null;
  reason: string;
  evidence: string[];
}

export interface ForecastAccuracySection {
  finish: FinishForecastError;
  milestone: MilestoneForecastError;
  eac: EacForecastError;
  etc: EtcForecastError;
  bias: {
    direction: BiasDirection;
    /** Every measurable signal with its signed contribution, for auditability. */
    signals: string[];
    reason: string;
  };
}

export interface FinishDriftTrend {
  evaluable: boolean;
  points: Array<{ dataDate: string; forecastFinish: string | null; driftWd: number | null }>;
  totalDriftWd: number | null;
  /** Latest-pair drift quoted from F5 (`delayVsPreviousWd`), never recomputed. */
  latestDriftFromF5: number | null;
  direction: 'slipping' | 'recovering' | 'holding' | 'insufficient';
  reason: string;
}

export interface FloatTrend {
  evaluable: boolean;
  pairs: number;
  commonActivities: number;
  /** Mean (next − previous) total float across pairs; negative = erosion. */
  meanDeltaTfWd: number | null;
  direction: 'eroding' | 'improving' | 'stable' | 'insufficient';
  criticalCountSeries: Array<{ dataDate: string; critical: number; nearCritical: number }>;
  reason: string;
}

export interface IndexTrend {
  index: 'cpi' | 'spi';
  evaluable: boolean;
  points: number;
  /** Latest − earliest over the F6 trend series (quoted points, no recomputation). */
  delta: number | null;
  direction: TrendDirection;
  reason: string;
}

export interface EacDriftTrend {
  evaluable: boolean;
  points: number;
  deltas: Array<{ from: string; to: string; delta: number | null }>;
  /** Latest-pair drift quoted from F6 (`drift.eacDrift`), never recomputed. */
  latestDriftFromF6: number | null;
  direction: 'worsening' | 'improving' | 'stable' | 'insufficient';
  reason: string;
}

export interface VacTrend {
  evaluable: boolean;
  points: number;
  change: number | null;
  bandSar: number | null;
  direction: 'improving' | 'deteriorating' | 'stable' | 'insufficient';
  reason: string;
}

export interface TrendQualitySection {
  finish: FinishDriftTrend;
  float: FloatTrend;
  cpi: IndexTrend;
  spi: IndexTrend;
  eac: EacDriftTrend;
  vac: VacTrend;
  evaluableCount: number;
  totalCount: number;
  note: string;
}

export interface DomainQuality {
  key: DataQualityDomainKey;
  completeness: number;
  freshness: number;
  consistency: number;
  traceability: number;
  score: number;
  level: ConfidenceLevel;
  notes: string[];
}

export interface DataQualitySection {
  domains: DomainQuality[];
  overallScore: number;
  overallLevel: ConfidenceLevel;
  weights: typeof DQ_WEIGHTS;
}

export interface ConfidenceEntry {
  level: ConfidenceLevel;
  /** Quoted source of the level (engine + field), never an F8 invention. */
  source: string;
  notes: string[];
}

export interface CappedConfidence extends ConfidenceEntry {
  /** The weakest source that set the cap (weakest-source rule, F8 req 4). */
  cappedBy: string;
}

export interface ConfidenceModel {
  schedule: ConfidenceEntry;
  cost: ConfidenceEntry;
  dataQuality: { level: ConfidenceLevel; score: number; source: string };
  finishForecast: CappedConfidence;
  eacForecast: CappedConfidence;
  integrated: CappedConfidence;
}

export interface StaleFinding {
  code:
    | 'no_progress_updates'
    | 'stale_progress'
    | 'no_cost_updates'
    | 'stale_cost_updates'
    | 'no_schedule_snapshot'
    | 'stale_schedule_snapshot'
    | 'no_cost_snapshot'
    | 'stale_cost_snapshot'
    | 'missing_current_update';
  severity: 'warning' | 'info';
  message: string;
  evidence: string[];
  ageDays: number | null;
  thresholdDays: number;
}

export interface TrustIntegrityFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  domain: DataQualityDomainKey;
  /** Which engine produced the finding — F5/F6 findings are quoted, never re-derived. */
  source: 'F5' | 'F6' | 'F8';
  message: string;
  evidence: string[];
  ref: string | null;
}

export interface ReliabilityAssessment {
  target: 'schedule_finish' | 'cost_eac' | 'integrated';
  class: ReliabilityClass;
  confidence: ConfidenceLevel;
  reasons: string[];
}

export interface CappedDecisionAction {
  rank: number;
  issueId: string;
  title: string;
  /** The F7-reported confidence, unchanged (F7 semantics are not modified). */
  reportedConfidence: ConfidenceLevel;
  /** gate(F7 confidence, integrated forecast confidence) — weakest-source cap. */
  effectiveConfidence: ConfidenceLevel;
  cappedBy: string;
  recommendationStrength: 'directive' | 'advisory' | 'investigate_only';
  strongRecommendationAllowed: boolean;
  evidenceGaps: string[];
}

export interface DecisionConfidenceSection {
  integratedConfidence: ConfidenceLevel;
  actions: CappedDecisionAction[];
  blockedStrongCount: number;
  note: string;
}

export interface CalibrationResult {
  evaluable: boolean;
  drifts: number[];
  samplesUsed: number;
  classification: 'optimistic' | 'pessimistic' | 'stable' | null;
  reason: string;
}

export interface CalibrationSection {
  finish: CalibrationResult;
  eac: CalibrationResult;
  overall: {
    classification: 'optimistic' | 'pessimistic' | 'stable' | 'mixed' | null;
    reason: string;
  };
}

export interface AccuracyKpi<T> {
  value: T | null;
  samples: number;
  reason: string;
}

export interface AccuracyKpis {
  maeFinishForecastWd: AccuracyKpi<number>;
  milestoneHitRatePct: AccuracyKpi<number> & { hits: number };
  eacForecastErrorPct: AccuracyKpi<number>;
  forecastDriftPerUpdateWd: AccuracyKpi<number> & { pairs: number };
}

export interface ExecutiveTrustSummary {
  forecastFinish: string | null;
  forecastConfidence: ConfidenceLevel;
  eac: number | null;
  costForecastConfidence: ConfidenceLevel;
  overallDataQuality: { score: number; level: ConfidenceLevel };
  topDataRisk: string | null;
  mostReliableKpi: { key: string; level: ConfidenceLevel } | null;
  leastReliableKpi: { key: string; level: ConfidenceLevel } | null;
}

export interface ForecastTrustReport {
  dataDate: string;
  history: {
    scheduleSnapshots: number;
    costSnapshots: number;
    oldestScheduleSnapshot: string | null;
    oldestCostSnapshot: string | null;
    latestScheduleSnapshot: string | null;
    latestCostSnapshot: string | null;
  };
  accuracy: ForecastAccuracySection;
  trends: TrendQualitySection;
  dataQuality: DataQualitySection;
  confidence: ConfidenceModel;
  stale: StaleFinding[];
  integrity: TrustIntegrityFinding[];
  reliability: ReliabilityAssessment[];
  decisionConfidence: DecisionConfidenceSection;
  calibration: CalibrationSection;
  accuracyKpis: AccuracyKpis;
  trust: ExecutiveTrustSummary;
}

export interface ForecastTrustInput {
  /** F5 report for the current Data Date (quoted, never recomputed). */
  scheduleReport: ScheduleControlReport;
  /** F6 report for the current Data Date (quoted, never recomputed). */
  costReport: CostControlReport;
  /** F7 report; optional so the trust layer still runs before decisions are built. */
  decisionReport?: IntegratedDecisionReport | null;
  activities: Activity[];
  links?: ActivityLink[];
  baselines: BaselineActivity[];
  progressUpdates?: ProgressUpdate[];
  costTransactions?: CostTransaction[];
  boqItems?: BoqItem[];
  allocations?: ActivityBoqAllocation[];
  /** Full persisted history (F5 snapshots); F8 sorts and filters it deterministically. */
  scheduleSnapshots?: ScheduleUpdateSnapshot[];
  /** Full persisted history (F6 snapshots). */
  costSnapshots?: CostControlSnapshot[];
  dataDate: string;
  calendarType?: CalendarType;
}

// ---------------------------------------------------------------------------
// Small pure helpers (local rounding matches the F5/F6/F7 engine pattern)
// ---------------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function levelOf(score: number): ConfidenceLevel {
  return score >= DQ_HIGH_MIN ? 'High' : score >= DQ_MEDIUM_MIN ? 'Medium' : 'Low';
}

const levelRank: Record<ConfidenceLevel, number> = { High: 3, Medium: 2, Low: 1 };

/** Declared freshness curve: 100 at/below the threshold, 0 at `DQ_FRESHNESS_ZERO_MULTIPLIER`× it, linear between. */
function freshScore(ageDays: number | null, thresholdDays: number): number {
  if (ageDays === null) return 0;
  if (ageDays <= thresholdDays) return 100;
  const zeroAt = thresholdDays * DQ_FRESHNESS_ZERO_MULTIPLIER;
  if (ageDays >= zeroAt) return 0;
  return round1((100 * (zeroAt - ageDays)) / (zeroAt - thresholdDays));
}

/** Declared consistency curve: 100 minus fixed deductions per error/warning, clamped. */
function consistencyScore(errors: number, warnings: number): number {
  return clampScore(100 - errors * DQ_ERROR_DEDUCTION - warnings * DQ_WARNING_DEDUCTION);
}

function byCode(a: { code: string }, b: { code: string }): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export function analyzeForecastTrust(input: ForecastTrustInput): ForecastTrustReport {
  const {
    scheduleReport: f5,
    costReport: f6,
    decisionReport = null,
    activities,
    baselines,
    dataDate,
  } = input;
  const links = input.links || [];
  const progressUpdates = input.progressUpdates || [];
  const costTransactions = input.costTransactions || [];
  const boqItems = input.boqItems || [];
  const allocations = input.allocations || [];
  const calendarType = input.calendarType || '6_days';
  const projectRuler = getCalendar(calendarType);

  // --- Deterministic snapshot handling (ascending, valid dates, ≤ Data Date). ---
  const schedSnaps = (input.scheduleSnapshots || [])
    .filter((s) => isIsoDate(s.data_date) && s.data_date <= dataDate)
    .sort((a, b) => (a.data_date < b.data_date ? -1 : a.data_date > b.data_date ? 1 : a.id < b.id ? -1 : 1));
  const costSnaps = (input.costSnapshots || [])
    .filter((s) => isIsoDate(s.data_date) && s.data_date <= dataDate)
    .sort((a, b) => (a.data_date < b.data_date ? -1 : a.data_date > b.data_date ? 1 : a.id < b.id ? -1 : 1));
  const futureSchedSnaps = (input.scheduleSnapshots || []).filter((s) => isAfterDataDate(s.data_date, dataDate));
  const futureCostSnaps = (input.costSnapshots || []).filter((s) => isAfterDataDate(s.data_date, dataDate));
  // Previous = the most recent snapshot STRICTLY before the Data Date (a snapshot persisted at
  // the Data Date is the current update, never the comparison basis).
  const prevSchedList = schedSnaps.filter((s) => s.data_date < dataDate);
  const prevSched = prevSchedList.length > 0 ? prevSchedList[prevSchedList.length - 1] : null;
  const prevCostList = costSnaps.filter((s) => s.data_date < dataDate);
  const prevCost = prevCostList.length > 0 ? prevCostList[prevCostList.length - 1] : null;
  const schedSnapAtDataDate = schedSnaps.some((s) => s.data_date === dataDate);
  const costSnapAtDataDate = costSnaps.some((s) => s.data_date === dataDate);

  const actById = new Map(activities.map((a) => [a.id, a]));
  const sortedActs = [...activities].sort(byCode);

  const projectComplete = sortedActs.length > 0 && sortedActs.every(
    (a) => (Number(a.percent_complete) || 0) >= 100 || !!a.actual_finish,
  );
  let actualProjectFinish: string | null = null;
  if (projectComplete) {
    for (const a of sortedActs) {
      if (isIsoDate(a.actual_finish) && (actualProjectFinish === null || (a.actual_finish as string) > actualProjectFinish)) {
        actualProjectFinish = a.actual_finish as string;
      }
    }
  }

  const history = {
    scheduleSnapshots: schedSnaps.length,
    costSnapshots: costSnaps.length,
    oldestScheduleSnapshot: schedSnaps.length > 0 ? schedSnaps[0].data_date : null,
    oldestCostSnapshot: costSnaps.length > 0 ? costSnaps[0].data_date : null,
    latestScheduleSnapshot: schedSnaps.length > 0 ? schedSnaps[schedSnaps.length - 1].data_date : null,
    latestCostSnapshot: costSnaps.length > 0 ? costSnaps[costSnaps.length - 1].data_date : null,
  };

  // =========================================================================
  // §1 Forecast accuracy — previous forecast vs recorded outcome
  // =========================================================================

  // --- 1a. Finish forecast error (outcome-based only; drift lives in §2). ---
  const finish: FinishForecastError = (() => {
    const prevDate = prevSched ? prevSched.data_date : null;
    const prevForecast = prevSched && isIsoDate(prevSched.forecast_finish) ? prevSched.forecast_finish : null;
    if (!prevSched) {
      return {
        previousSnapshotDate: null, previousForecastFinish: null, outcomeFinish: null, errorWd: null,
        reason: 'No previous schedule snapshot before the Data Date: nothing to compare (N/A, not estimated).',
        evidence: [],
      };
    }
    if (!prevForecast) {
      return {
        previousSnapshotDate: prevDate, previousForecastFinish: null, outcomeFinish: null, errorWd: null,
        reason: `Snapshot ${prevDate} stored no forecast finish: error is not measurable.`,
        evidence: [`schedule_update_snapshots.data_date = ${prevDate}`, 'forecast_finish = null'],
      };
    }
    if (!projectComplete || actualProjectFinish === null) {
      return {
        previousSnapshotDate: prevDate, previousForecastFinish: prevForecast, outcomeFinish: null, errorWd: null,
        reason: 'Project is not complete: no actual finish outcome exists yet. Interim movement is reported as finish drift (§2), never as an error.',
        evidence: [`previous forecast = ${prevForecast}`, `data_date = ${dataDate}`],
      };
    }
    const err = workingDayDelta(prevForecast, actualProjectFinish, projectRuler);
    return {
      previousSnapshotDate: prevDate, previousForecastFinish: prevForecast, outcomeFinish: actualProjectFinish,
      errorWd: err,
      reason: err === null ? 'Working-day distance is not computable on the stored dates.'
        : err > 0 ? `Actual finish landed ${err} working day(s) after the forecast: the forecast was optimistic.`
        : err < 0 ? `Actual finish landed ${-err} working day(s) before the forecast: the forecast was pessimistic.`
        : 'Actual finish matched the forecast exactly.',
      evidence: [
        `previous forecast (${prevDate}) = ${prevForecast}`,
        `actual finish = ${actualProjectFinish}`,
        'sign: positive = optimistic forecast',
      ],
    };
  })();

  // --- 1b. Milestone forecast error (samples across history; accuracy uses the latest pair). ---
  const milestoneIds = new Set(sortedActs.filter((a) => a.is_milestone).map((a) => a.id));
  const allMilestoneSamples: MilestoneForecastSample[] = [];
  for (const snap of schedSnaps) {
    const det = snap.details && snap.details.version === 1 ? snap.details.activities : null;
    if (!det) continue;
    for (const id of [...milestoneIds].sort()) {
      const row = det[id];
      if (!row || !isIsoDate(row.ef)) continue;
      const act = actById.get(id);
      if (!act) continue;
      const forecastDate = row.ef as string;
      if (isIsoDate(act.actual_finish)) {
        const actualDate = act.actual_finish as string;
        if (actualDate <= snap.data_date) continue; // already achieved when forecast: no exposure.
        const err = workingDayDelta(forecastDate, actualDate, getCalendar(act.calendar_type || calendarType));
        allMilestoneSamples.push({
          code: act.code, snapshotDate: snap.data_date, forecastDate, actualDate, errorWd: err,
          hit: err === null ? null : err <= FORECAST_MATCH_TOLERANCE_WD,
          outcome: err !== null && err <= FORECAST_MATCH_TOLERANCE_WD ? 'achieved_on_time' : 'achieved_late',
        });
      } else if (forecastDate <= dataDate) {
        // Forecast said it would be achieved by now and it still has no actual finish: a miss.
        allMilestoneSamples.push({
          code: act.code, snapshotDate: snap.data_date, forecastDate, actualDate: null, errorWd: null,
          hit: false, outcome: 'still_missing',
        });
      }
      // else: forecast date still in the future — outcome pending, never counted.
    }
  }
  allMilestoneSamples.sort((a, b) =>
    a.snapshotDate < b.snapshotDate ? -1 : a.snapshotDate > b.snapshotDate ? 1
    : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

  const milestone: MilestoneForecastError = (() => {
    const fromPrev = prevSched
      ? allMilestoneSamples.filter((s) => s.snapshotDate === prevSched.data_date)
      : [];
    if (!prevSched) {
      return {
        samples: [], dueByDataDate: 0, achievedOnTime: 0, achievedLate: 0, stillMissing: 0,
        meanSignedWd: null, meanAbsWd: null,
        reason: 'No previous schedule snapshot: milestone forecast error is N/A.',
      };
    }
    const det = prevSched.details && prevSched.details.version === 1 ? prevSched.details.activities : null;
    let dueByDataDate = 0;
    if (det) {
      for (const id of [...milestoneIds].sort()) {
        const row = det[id];
        if (row && isIsoDate(row.ef) && (row.ef as string) <= dataDate) dueByDataDate += 1;
      }
    }
    const onTime = fromPrev.filter((s) => s.outcome === 'achieved_on_time').length;
    const late = fromPrev.filter((s) => s.outcome === 'achieved_late').length;
    const missing = fromPrev.filter((s) => s.outcome === 'still_missing').length;
    const errs = fromPrev.map((s) => s.errorWd).filter((v): v is number => v !== null);
    return {
      samples: fromPrev,
      dueByDataDate,
      achievedOnTime: onTime,
      achievedLate: late,
      stillMissing: missing,
      meanSignedWd: errs.length > 0 ? round1(errs.reduce((t, e) => t + e, 0) / errs.length) : null,
      meanAbsWd: errs.length > 0 ? round1(errs.reduce((t, e) => t + Math.abs(e), 0) / errs.length) : null,
      reason: fromPrev.length === 0
        ? `Snapshot ${prevSched.data_date} forecast no milestone with a measurable outcome yet.`
        : `${fromPrev.length} milestone outcome(s) measured vs snapshot ${prevSched.data_date} (hit tolerance ±${FORECAST_MATCH_TOLERANCE_WD} wd, quoted from F5).`,
    };
  })();

  // --- 1c. EAC forecast error (outcome = final actual cost, only when complete). ---
  const eac: EacForecastError = (() => {
    const interim = f6.drift.eacDrift; // quoted from F6, labelled interim
    if (!prevCost) {
      return {
        previousSnapshotDate: null, previousEac: null, outcomeEac: null, error: null, errorPct: null,
        interimDriftFromF6: interim,
        reason: 'No previous cost snapshot before the Data Date: EAC forecast error is N/A.',
        evidence: [],
      };
    }
    const prevEac = Number.isFinite(Number(prevCost.eac)) ? Number(prevCost.eac) : null;
    if (prevEac === null) {
      return {
        previousSnapshotDate: prevCost.data_date, previousEac: null, outcomeEac: null, error: null, errorPct: null,
        interimDriftFromF6: interim,
        reason: `Cost snapshot ${prevCost.data_date} stored no EAC: error is not measurable.`,
        evidence: ['cost_control_snapshots.eac = null'],
      };
    }
    if (!projectComplete || f6.project.acSource !== 'approved_transactions') {
      return {
        previousSnapshotDate: prevCost.data_date, previousEac: prevEac, outcomeEac: null, error: null, errorPct: null,
        interimDriftFromF6: interim,
        reason: projectComplete
          ? 'Project is complete but AC is not transaction-backed: no auditable final-cost outcome.'
          : 'Project is not complete: no final-cost outcome exists yet. Interim EAC movement is quoted from F6 as drift, never as an outcome error.',
        evidence: [
          `previous EAC (${prevCost.data_date}) = ${prevEac}`,
          interim !== null ? `F6 interim EAC drift = ${interim}` : 'F6 interim EAC drift = N/A',
        ],
      };
    }
    const outcome = round2(f6.project.ac); // quoted from F6 (final AC at completion)
    const err = round2(outcome - prevEac);
    const pct = outcome !== 0 ? round2((err / outcome) * 100) : null;
    return {
      previousSnapshotDate: prevCost.data_date, previousEac: prevEac, outcomeEac: outcome, error: err, errorPct: pct,
      interimDriftFromF6: interim,
      reason: err > 0
        ? `Final cost exceeded the forecast EAC by ${err} SAR: the EAC was optimistic.`
        : err < 0 ? `Final cost came in ${-err} SAR below the forecast EAC: the EAC was pessimistic.`
        : 'Final cost matched the forecast EAC exactly.',
      evidence: [
        `previous EAC (${prevCost.data_date}) = ${prevEac}`,
        `final actual cost (F6 AC) = ${outcome}`,
        'sign: positive = optimistic forecast',
      ],
    };
  })();

  // --- 1d. ETC forecast error (measurable mid-project from approved in-window spend). ---
  const etc: EtcForecastError = (() => {
    if (!prevCost) {
      return {
        previousSnapshotDate: null, previousEtc: null, spendSincePrevious: null, currentEtc: null,
        revisedEtcFromPrevious: null, error: null, errorPct: null,
        reason: 'No previous cost snapshot before the Data Date: ETC forecast error is N/A.',
        evidence: [],
      };
    }
    const prevEtc = Number.isFinite(Number(prevCost.etc)) ? Number(prevCost.etc) : null;
    const currentEtc = f6.recommended ? round2(f6.recommended.etc) : null; // quoted from F6
    const inWindow = costTransactions.filter((tx) =>
      tx.status === 'approved' && isIsoDate(tx.transaction_date)
      && tx.transaction_date > prevCost.data_date && tx.transaction_date <= dataDate);
    const spend = round2(inWindow.reduce((s, tx) => s + (Number(tx.amount) || 0), 0));
    if (prevEtc === null || currentEtc === null) {
      return {
        previousSnapshotDate: prevCost.data_date, previousEtc: prevEtc, spendSincePrevious: spend,
        currentEtc, revisedEtcFromPrevious: null, error: null, errorPct: null,
        reason: prevEtc === null
          ? `Cost snapshot ${prevCost.data_date} stored no ETC: error is not measurable.`
          : 'F6 publishes no recommended ETC now: the hindsight ETC cannot be composed.',
        evidence: [
          prevEtc === null ? 'cost_control_snapshots.etc = null' : `previous ETC = ${prevEtc}`,
          currentEtc === null ? 'F6 recommended ETC = N/A' : `current F6 ETC = ${currentEtc}`,
        ],
      };
    }
    const revised = round2(spend + currentEtc);
    const err = round2(revised - prevEtc);
    const pct = prevEtc > 0 ? round2((err / prevEtc) * 100) : null;
    return {
      previousSnapshotDate: prevCost.data_date, previousEtc: prevEtc, spendSincePrevious: spend,
      currentEtc, revisedEtcFromPrevious: revised, error: err, errorPct: pct,
      reason: err > 0
        ? `Completing from ${prevCost.data_date} now takes ${err} SAR more than forecast: the ETC was optimistic.`
        : err < 0 ? `Completing from ${prevCost.data_date} takes ${-err} SAR less than forecast: the ETC was pessimistic.`
        : 'The hindsight ETC matches the previous forecast exactly.',
      evidence: [
        `previous ETC (${prevCost.data_date}) = ${prevEtc}`,
        `approved spend ${prevCost.data_date}..${dataDate} = ${spend} (${inWindow.length} transaction(s))`,
        `current F6 ETC = ${currentEtc}`,
        `revised ETC from ${prevCost.data_date} = ${spend} + ${currentEtc} = ${revised}`,
        'sign: positive = optimistic forecast',
      ],
    };
  })();

  // --- 1e. Optimism / pessimism bias (majority vote over measurable signals). ---
  const bias = (() => {
    const signals: string[] = [];
    let optimistic = 0;
    let pessimistic = 0;
    const vote = (label: string, signed: number | null, unit: string) => {
      if (signed === null || signed === 0) return;
      if (signed > 0) { optimistic += 1; signals.push(`${label} +${signed}${unit} → optimistic`); }
      else { pessimistic += 1; signals.push(`${label} ${signed}${unit} → pessimistic`); }
    };
    vote('finish forecast error', finish.errorWd, 'wd');
    vote('milestone mean signed error', milestone.meanSignedWd, 'wd');
    vote('EAC forecast error', eac.error, ' SAR');
    vote('ETC forecast error', etc.error, ' SAR');
    vote('F5 activity-level bias', f5.accuracy.bias === 'optimistic' ? 1 : f5.accuracy.bias === 'pessimistic' ? -1 : null, '');
    vote('latest finish drift (F5)', f5.project.delayVsPreviousWd, 'wd');
    const direction: BiasDirection = optimistic + pessimistic === 0 ? 'insufficient'
      : optimistic > pessimistic ? 'optimistic'
      : pessimistic > optimistic ? 'pessimistic' : 'neutral';
    return {
      direction,
      signals,
      reason: direction === 'insufficient'
        ? 'No measurable forecast-vs-outcome signal yet: bias is N/A (never assumed neutral).'
        : `${optimistic} optimistic vs ${pessimistic} pessimistic signal(s); majority decides, ties read neutral.`,
    };
  })();

  const accuracy: ForecastAccuracySection = { finish, milestone, eac, etc, bias };

  // =========================================================================
  // §2 Trend quality — across snapshots (cost series quoted from F6)
  // =========================================================================

  // --- 2a. Finish drift series (snapshots + current report, deduplicated). ---
  const finishSeries: Array<{ dataDate: string; forecastFinish: string | null }> = schedSnaps
    .map((s) => ({ dataDate: s.data_date, forecastFinish: isIsoDate(s.forecast_finish) ? s.forecast_finish : null }));
  if (!schedSnapAtDataDate && isIsoDate(f5.project.forecastFinish)) {
    finishSeries.push({ dataDate, forecastFinish: f5.project.forecastFinish });
  }
  const usableFinish = finishSeries.filter((p) => p.forecastFinish !== null);
  const finishPoints: FinishDriftTrend['points'] = usableFinish.map((p, i) => ({
    dataDate: p.dataDate,
    forecastFinish: p.forecastFinish,
    driftWd: i === 0 ? null : workingDayDelta(
      usableFinish[i - 1].forecastFinish as string, p.forecastFinish as string, projectRuler,
    ),
  }));
  const finishDrifts = finishPoints.map((p) => p.driftWd).filter((v): v is number => v !== null);
  const totalDriftWd = usableFinish.length >= 2
    ? workingDayDelta(usableFinish[0].forecastFinish as string, usableFinish[usableFinish.length - 1].forecastFinish as string, projectRuler)
    : null;
  const finishTrend: FinishDriftTrend = {
    evaluable: finishDrifts.length > 0,
    points: finishPoints,
    totalDriftWd,
    latestDriftFromF5: f5.project.delayVsPreviousWd, // quoted, never recomputed
    direction: totalDriftWd === null ? 'insufficient'
      : totalDriftWd > 0 ? 'slipping' : totalDriftWd < 0 ? 'recovering' : 'holding',
    reason: usableFinish.length < 2
      ? `Only ${usableFinish.length} forecast-finish point(s): a trend needs at least 2 (N/A).`
      : `${finishDrifts.length} drift pair(s); total ${totalDriftWd} wd since ${usableFinish[0].dataDate}.`,
  };

  // --- 2b. Float trend (per-activity TF from snapshot details + current statused). ---
  const floatTrend: FloatTrend = (() => {
    const tfPoints: Array<{ dataDate: string; tf: Map<string, number>; critical: number; nearCritical: number }> = [];
    for (const s of schedSnaps) {
      const det = s.details && s.details.version === 1 ? s.details.activities : null;
      if (!det) continue;
      const m = new Map<string, number>();
      for (const [id, row] of Object.entries(det)) {
        if (row && typeof row.tf === 'number' && Number.isFinite(row.tf)) m.set(id, row.tf);
      }
      tfPoints.push({ dataDate: s.data_date, tf: m, critical: s.critical_count, nearCritical: s.near_critical_count });
    }
    if (!schedSnapAtDataDate) {
      const m = new Map<string, number>();
      for (const st of f5.statused) {
        if (!st.completed && Number.isFinite(st.totalFloat)) m.set(st.id, st.totalFloat);
      }
      tfPoints.push({ dataDate, tf: m, critical: f5.project.criticalCount, nearCritical: f5.project.nearCriticalCount });
    }
    const criticalCountSeries = tfPoints.map((p) => ({ dataDate: p.dataDate, critical: p.critical, nearCritical: p.nearCritical }));
    const pairMeans: number[] = [];
    let commonTotal = 0;
    for (let i = 1; i < tfPoints.length; i += 1) {
      const prev = tfPoints[i - 1];
      const cur = tfPoints[i];
      const deltas: number[] = [];
      for (const [id, tf] of cur.tf) {
        const p = prev.tf.get(id);
        if (p !== undefined) deltas.push(tf - p);
      }
      commonTotal += deltas.length;
      if (deltas.length > 0) pairMeans.push(deltas.reduce((t, d) => t + d, 0) / deltas.length);
    }
    const meanDelta = pairMeans.length > 0
      ? round1(pairMeans.reduce((t, d) => t + d, 0) / pairMeans.length) : null;
    return {
      evaluable: meanDelta !== null,
      pairs: pairMeans.length,
      commonActivities: commonTotal,
      meanDeltaTfWd: meanDelta,
      direction: meanDelta === null ? 'insufficient'
        : meanDelta < -FLOAT_TREND_BAND_WD ? 'eroding'
        : meanDelta > FLOAT_TREND_BAND_WD ? 'improving' : 'stable',
      criticalCountSeries,
      reason: meanDelta === null
        ? `Only ${tfPoints.length} float-bearing point(s): no adjacent pair to compare (N/A).`
        : `Mean total-float change ${meanDelta} wd per update over ${pairMeans.length} pair(s); band ±${FLOAT_TREND_BAND_WD} wd.`,
    };
  })();

  // --- 2c/2d. CPI & SPI trends (series quoted from the F6 trend points). ---
  const indexTrend = (index: 'cpi' | 'spi'): IndexTrend => {
    const vals = f6.trend
      .map((p) => ({ dataDate: p.dataDate, v: index === 'cpi' ? p.cpi : p.spi }))
      .filter((p): p is { dataDate: string; v: number } => p.v !== null && Number.isFinite(p.v));
    if (vals.length < 2) {
      return {
        index, evaluable: false, points: vals.length, delta: null, direction: 'insufficient',
        reason: `Only ${vals.length} ${index.toUpperCase()} point(s) in the F6 trend: at least 2 required (N/A).`,
      };
    }
    const delta = round2(vals[vals.length - 1].v - vals[0].v);
    return {
      index, evaluable: true, points: vals.length, delta,
      direction: Math.abs(delta) <= INDEX_TREND_BAND ? 'stable' : delta > 0 ? 'improving' : 'worsening',
      reason: `${index.toUpperCase()} ${vals[0].v} → ${vals[vals.length - 1].v} (${vals[0].dataDate}..${vals[vals.length - 1].dataDate}); stability band ±${INDEX_TREND_BAND}.`,
    };
  };
  const cpiTrend = indexTrend('cpi');
  const spiTrend = indexTrend('spi');

  // --- 2e. EAC drift series (quoted from the F6 trend; latest pair quoted from F6 drift). ---
  const eacTrend: EacDriftTrend = (() => {
    const vals = f6.trend
      .map((p) => ({ dataDate: p.dataDate, v: p.eac }))
      .filter((p): p is { dataDate: string; v: number } => p.v !== null && Number.isFinite(p.v));
    const deltas: EacDriftTrend['deltas'] = [];
    for (let i = 1; i < vals.length; i += 1) {
      deltas.push({ from: vals[i - 1].dataDate, to: vals[i].dataDate, delta: round2(vals[i].v - vals[i - 1].v) });
    }
    const direction: EacDriftTrend['direction'] = deltas.length === 0 ? 'insufficient'
      : f6.drift.direction === 'worsening' ? 'worsening'
      : f6.drift.direction === 'improving' ? 'improving'
      : f6.drift.direction === 'stable' ? 'stable' : 'insufficient';
    return {
      evaluable: deltas.length > 0,
      points: vals.length,
      deltas,
      latestDriftFromF6: f6.drift.eacDrift, // quoted, never recomputed
      direction,
      reason: deltas.length === 0
        ? `Only ${vals.length} EAC point(s) in the F6 trend: at least 2 required (N/A).`
        : `Direction quoted from the F6 drift assessment (${f6.drift.direction}); ${deltas.length} pair(s).`,
    };
  })();

  // --- 2f. VAC deterioration / improvement (series quoted from the F6 trend). ---
  const vacTrend: VacTrend = (() => {
    const vals = f6.trend
      .map((p) => ({ dataDate: p.dataDate, v: p.vac }))
      .filter((p): p is { dataDate: string; v: number } => p.v !== null && Number.isFinite(p.v));
    if (vals.length < 2) {
      return {
        evaluable: false, points: vals.length, change: null, bandSar: null, direction: 'insufficient',
        reason: `Only ${vals.length} VAC point(s) in the F6 trend: at least 2 required (N/A).`,
      };
    }
    const change = round2(vals[vals.length - 1].v - vals[0].v);
    const bandSar = f6.project.bac !== null ? round2(Math.abs(f6.project.bac) * VAC_STABLE_BAND_PCT_OF_BAC) : 0;
    return {
      evaluable: true, points: vals.length, change, bandSar,
      direction: Math.abs(change) <= bandSar ? 'stable' : change > 0 ? 'improving' : 'deteriorating',
      reason: `VAC ${vals[0].v} → ${vals[vals.length - 1].v}; stable band ±${bandSar} SAR (${VAC_STABLE_BAND_PCT_OF_BAC * 100}% of BAC${f6.project.bac === null ? '; BAC unavailable — band collapses to 0' : ''}).`,
    };
  })();

  const evaluableCount = [finishTrend.evaluable, floatTrend.evaluable, cpiTrend.evaluable, spiTrend.evaluable, eacTrend.evaluable, vacTrend.evaluable]
    .filter(Boolean).length;
  const trends: TrendQualitySection = {
    finish: finishTrend, float: floatTrend, cpi: cpiTrend, spi: spiTrend, eac: eacTrend, vac: vacTrend,
    evaluableCount, totalCount: 6,
    note: evaluableCount === 0
      ? 'No trend is evaluable yet: save control snapshots on each update to build history.'
      : `${evaluableCount}/6 trend series are evaluable from the persisted history.`,
  };

  // =========================================================================
  // §3 Data quality scores (declared formulas; evidence-based sub-scores)
  // =========================================================================

  const approvedUpdates = progressUpdates.filter((u) =>
    u.status === 'approved' && isIsoDate(u.update_date) && !isAfterDataDate(u.update_date, dataDate));
  const approvedTxns = costTransactions.filter((tx) =>
    tx.status === 'approved' && isIsoDate(tx.transaction_date) && !isAfterDataDate(tx.transaction_date, dataDate));
  const latestDateOf = (dates: string[]): string | null =>
    dates.length === 0 ? null : dates.reduce((m, d) => (d > m ? d : m));
  const latestUpdateDate = latestDateOf(approvedUpdates.map((u) => u.update_date));
  const latestTxnDate = latestDateOf(approvedTxns.map((tx) => tx.transaction_date));
  const progressAge = latestUpdateDate === null ? null : calendarDaysBetween(latestUpdateDate, dataDate);
  const costAge = latestTxnDate === null ? null : calendarDaysBetween(latestTxnDate, dataDate);
  const schedSnapAge = history.latestScheduleSnapshot === null ? null
    : calendarDaysBetween(history.latestScheduleSnapshot, dataDate);
  const costSnapAge = history.latestCostSnapshot === null ? null
    : calendarDaysBetween(history.latestCostSnapshot, dataDate);

  const pct = (num: number, den: number): number => (den > 0 ? round1((100 * num) / den) : 0);

  // --- Schedule domain ---
  const linkedIds = new Set<string>();
  for (const l of links) { linkedIds.add(l.predecessor_id); linkedIds.add(l.successor_id); }
  const linkIdsResolve = links.length === 0 ? 0
    : links.filter((l) => actById.has(l.predecessor_id) && actById.has(l.successor_id)).length;
  const schedCompleteness = sortedActs.length === 0 ? 0 : round1((
    pct(sortedActs.filter((a) => a.is_milestone || Number(a.duration_days) > 0).length, sortedActs.length)
    + pct(sortedActs.filter((a) => isIsoDate(a.early_start) && isIsoDate(a.early_finish)).length, sortedActs.length)
    + pct(sortedActs.filter((a) => a.is_milestone || linkedIds.has(a.id)).length, sortedActs.length)
  ) / 3);
  // Declared: schedule consistency = mean of (CPM-resolved forecast finishes, link-endpoint
// resolution). With no links at all the second component is vacuously satisfied; the missing
// logic itself is penalized under completeness, never twice.
const cpmResolvedPct = pct(f5.statused.filter((s) => s.forecastFinish !== null).length, sortedActs.length);
const linkResolutionPct = links.length === 0 ? 100 : pct(linkIdsResolve, links.length);
const schedConsistency = sortedActs.length === 0 ? 0 : round1((cpmResolvedPct + linkResolutionPct) / 2);
  const baselineByAct = new Map(baselines.map((b) => [b.activity_id, b]));
  const schedTrace = pct(sortedActs.filter((a) => baselineByAct.has(a.id)).length, sortedActs.length);

  // --- Progress domain ---
  const pctValid = sortedActs.filter((a) => {
    const p = Number(a.percent_complete);
    return Number.isFinite(p) && p >= 0 && p <= 100;
  }).length;
  const shouldStart = sortedActs.filter((a) => {
    const b = baselineByAct.get(a.id);
    return b && isIsoDate(b.early_start) && b.early_start <= dataDate;
  });
  const startedEvidence = shouldStart.filter((a) => !!a.actual_start || (Number(a.percent_complete) || 0) > 0).length;
  const updatesByAct = new Set(approvedUpdates.map((u) => u.activity_id));
  const progressed = sortedActs.filter((a) => (Number(a.percent_complete) || 0) > 0);
  const progressBacked = progressed.filter((a) => updatesByAct.has(a.id) || !!a.actual_start).length;
  const f5Errors = f5.integrity.filter((x) => x.severity === 'error').length;
  const f5Warnings = f5.integrity.filter((x) => x.severity === 'warning').length;
  const progressCompleteness = sortedActs.length === 0 ? 0 : round1((
    pct(pctValid, sortedActs.length)
    + (shouldStart.length > 0 ? pct(startedEvidence, shouldStart.length) : 100)
  ) / 2);
  const progressTrace = pct(progressBacked, progressed.length);

  // --- Cost domain ---
  const f6Errors = f6.integrity.filter((x) => x.severity === 'error').length;
  const f6Warnings = f6.integrity.filter((x) => x.severity === 'warning').length;
  const costCompleteness = round1((
    (f6.project.bac !== null ? 50 : 0)
    + (f6.project.acCount > 0 ? 50 : 0)
  ));
  const traceableTxns = approvedTxns.filter((tx) =>
    !!tx.activity_id || !!tx.boq_item_id || !!tx.wbs_node_id || !!tx.budget_line_id).length;
  const costTrace = pct(traceableTxns, approvedTxns.length);

  // --- Baseline domain ---
  const baselineRows = baselines.filter((b) => actById.has(b.activity_id));
  const coveredActs = new Set(baselineRows.map((b) => b.activity_id));
  const baselineCompleteness = baselines.length === 0 ? 0 : round1(
    50 + pct(coveredActs.size, Math.max(sortedActs.length, 1)) / 2);
  const baselineDatesUsable = baselines.length > 0 && baselines.every((b) => isIsoDate(b.early_start) && isIsoDate(b.early_finish));
  const baselineFreshness = baselines.length === 0 ? 0 : baselineDatesUsable ? 100 : 50;
  const validRows = baselineRows.filter((b) =>
    isIsoDate(b.early_start) && isIsoDate(b.early_finish)
    && b.early_start <= b.early_finish
    && Number(b.duration_days) >= 0 && Number(b.planned_cost) >= 0).length;
  const baselineConsistency = pct(validRows, baselines.length);
  const baselineTrace = pct(baselineRows.length, baselines.length);

  // --- Forecast domain ---
  const forecastCompleteness = round1(
    (f5.project.forecastFinish !== null ? 50 : 0) + (f6.project.eac !== null ? 50 : 0));
  const forecastFreshness = schedSnapAtDataDate && costSnapAtDataDate ? 100
    : schedSnapAtDataDate || costSnapAtDataDate ? 50
    : freshScore(
      schedSnapAge !== null && costSnapAge !== null ? Math.min(schedSnapAge, costSnapAge)
      : schedSnapAge !== null ? schedSnapAge : costSnapAge,
      SNAPSHOT_STALE_DAYS,
    );
  const forecastConsistency = round1((LEVEL_SCORE[f5.confidence.forecastFinish.level]
    + LEVEL_SCORE[f6.confidence.forecast.level]) / 2);
  const forecastTrace = round1((f6.recommended ? 50 : 0)
    + (f5.project.progressSource !== 'unavailable' ? 50 : 0));

  const buildDomain = (
    key: DataQualityDomainKey,
    completeness: number, freshness: number, consistency: number, traceability: number,
    notes: string[],
  ): DomainQuality => {
    const score = round1(
      completeness * DQ_WEIGHTS.completeness
      + freshness * DQ_WEIGHTS.freshness
      + consistency * DQ_WEIGHTS.consistency
      + traceability * DQ_WEIGHTS.traceability);
    return { key, completeness, freshness, consistency, traceability, score, level: levelOf(score), notes };
  };

  const domains: DomainQuality[] = [
    buildDomain('schedule', schedCompleteness, freshScore(schedSnapAge, SNAPSHOT_STALE_DAYS),
      schedConsistency, schedTrace, [
      `latest schedule snapshot ${history.latestScheduleSnapshot || 'none'} (threshold ${SNAPSHOT_STALE_DAYS}d)`,
      `${sortedActs.filter((a) => baselineByAct.has(a.id)).length}/${sortedActs.length} activities baseline-traced`,
      `CPM resolved ${f5.statused.filter((s) => s.forecastFinish !== null).length}/${sortedActs.length} forecast finishes`,
    ]),
    buildDomain('progress', progressCompleteness, freshScore(progressAge, PROGRESS_STALE_DAYS),
      consistencyScore(f5Errors, f5Warnings), progressTrace, [
      `latest approved update ${latestUpdateDate || 'none'} (threshold ${PROGRESS_STALE_DAYS}d, quoted from F5)`,
      `F5 integrity: ${f5Errors} error(s), ${f5Warnings} warning(s)`,
      `${progressBacked}/${progressed.length} progressed activities carry an approved update or actual start`,
    ]),
    buildDomain('cost', costCompleteness, freshScore(costAge, COST_STALE_DAYS),
      consistencyScore(f6Errors, f6Warnings), costTrace, [
      `latest approved transaction ${latestTxnDate || 'none'} (threshold ${COST_STALE_DAYS}d)`,
      `F6 integrity: ${f6Errors} error(s), ${f6Warnings} warning(s)`,
      `BAC ${f6.project.bac !== null ? 'available' : 'unavailable'}; AC ${f6.project.acCount > 0 ? 'recorded' : 'not recorded'}`,
    ]),
    buildDomain('baseline', baselineCompleteness, baselineFreshness,
      baselineConsistency, baselineTrace, [
      baselines.length === 0 ? 'no baseline rows: variance and forecast-error measurement impossible'
        : `${coveredActs.size}/${sortedActs.length} activities covered by ${baselines.length} baseline row(s)`,
      'baseline rows carry no stored timestamp: freshness scores date usability only',
    ]),
    buildDomain('forecast', forecastCompleteness, forecastFreshness,
      forecastConsistency, forecastTrace, [
      `finish forecast ${f5.project.forecastFinish !== null ? 'available' : 'N/A'}; EAC ${f6.project.eac !== null ? 'available' : 'N/A'}`,
      schedSnapAtDataDate && costSnapAtDataDate ? 'both current snapshots persisted at the Data Date'
      : schedSnapAtDataDate || costSnapAtDataDate ? 'only one snapshot persisted at the Data Date'
      : 'no snapshot persisted at the current Data Date',
      `quoted engine confidence: F5 finish ${f5.confidence.forecastFinish.level}, F6 forecast ${f6.confidence.forecast.level}`,
    ]),
  ];
  const overallScore = round1(domains.reduce((t, d) => t + d.score, 0) / domains.length);
  const dataQuality: DataQualitySection = {
    domains, overallScore, overallLevel: levelOf(overallScore), weights: DQ_WEIGHTS,
  };

  // =========================================================================
  // §4 Confidence model (quoted levels + weakest-source caps)
  // =========================================================================

  const capOf = (entries: Array<{ name: string; level: ConfidenceLevel }>): CappedConfidence => {
    let weakest = entries[0];
    for (const e of entries) if (levelRank[e.level] < levelRank[weakest.level]) weakest = e;
    return {
      level: weakest.level,
      source: entries.map((e) => `${e.name}=${e.level}`).join(', '),
      cappedBy: weakest.name,
      notes: entries.length > 1
        ? [`weakest source ${weakest.name} (${weakest.level}) caps the result`, ...entries.map((e) => `${e.name}: ${e.level}`)]
        : [`single source ${weakest.name}: ${weakest.level}`],
    };
  };

  const dqLevel = dataQuality.overallLevel;
  const scheduleConf: ConfidenceEntry = {
    level: f5.confidence.forecastFinish.level,
    source: 'F5 confidence.forecastFinish (quoted)',
    notes: [...f5.confidence.forecastFinish.sources, ...f5.confidence.forecastFinish.notes],
  };
  const costConf: ConfidenceEntry = {
    level: f6.confidence.forecast.level,
    source: 'F6 confidence.forecast (quoted)',
    notes: [...f6.confidence.forecast.sources, ...f6.confidence.forecast.notes],
  };
  const finishForecastConf = capOf([
    { name: 'schedule (F5)', level: scheduleConf.level },
    { name: 'data quality (F8)', level: dqLevel },
  ]);
  const eacForecastConf = capOf([
    { name: 'cost (F6)', level: costConf.level },
    { name: 'data quality (F8)', level: dqLevel },
  ]);
  const integratedConf = capOf([
    { name: 'schedule (F5)', level: scheduleConf.level },
    { name: 'cost (F6)', level: costConf.level },
    { name: 'data quality (F8)', level: dqLevel },
  ]);
  const confidence: ConfidenceModel = {
    schedule: scheduleConf,
    cost: costConf,
    dataQuality: { level: dqLevel, score: overallScore, source: 'F8 §3 domain scores (declared formula)' },
    finishForecast: finishForecastConf,
    eacForecast: eacForecastConf,
    integrated: integratedConf,
  };

  // =========================================================================
  // §5 Stale data (declared thresholds; every finding names its own rule)
  // =========================================================================

  const stale: StaleFinding[] = [];
  const hasProgressSignal = sortedActs.some((a) => (Number(a.percent_complete) || 0) > 0 || !!a.actual_start);
  if (latestUpdateDate === null) {
    stale.push({
      code: 'no_progress_updates', severity: hasProgressSignal ? 'warning' : 'info',
      message: hasProgressSignal
        ? 'Activities show progress but no approved progress update exists on/before the Data Date: progress has no evidence trail.'
        : 'No approved progress update recorded yet.',
      evidence: hasProgressSignal ? [`${progressed.length} activity(ies) with percent_complete > 0`, 'approved progress_updates = 0'] : ['approved progress_updates = 0'],
      ageDays: null, thresholdDays: PROGRESS_STALE_DAYS,
    });
  } else if (progressAge !== null && progressAge > PROGRESS_STALE_DAYS) {
    stale.push({
      code: 'stale_progress', severity: 'warning',
      message: `Latest approved progress update is ${progressAge} day(s) old (threshold ${PROGRESS_STALE_DAYS}).`,
      evidence: [`latest update = ${latestUpdateDate}`, `data_date = ${dataDate}`],
      ageDays: progressAge, thresholdDays: PROGRESS_STALE_DAYS,
    });
  }
  if (latestTxnDate === null) {
    stale.push({
      code: 'no_cost_updates', severity: hasProgressSignal || f6.project.ac > 0 ? 'warning' : 'info',
      message: hasProgressSignal || f6.project.ev !== null
        ? 'Work shows progress/EV but no approved cost transaction exists on/before the Data Date: spend has no evidence trail.'
        : 'No approved cost transaction recorded yet.',
      evidence: [`approved cost_transactions = 0`, `EV = ${f6.project.ev}`],
      ageDays: null, thresholdDays: COST_STALE_DAYS,
    });
  } else if (costAge !== null && costAge > COST_STALE_DAYS) {
    stale.push({
      code: 'stale_cost_updates', severity: 'warning',
      message: `Latest approved cost transaction is ${costAge} day(s) old (threshold ${COST_STALE_DAYS}).`,
      evidence: [`latest transaction = ${latestTxnDate}`, `data_date = ${dataDate}`],
      ageDays: costAge, thresholdDays: COST_STALE_DAYS,
    });
  }
  if (history.latestScheduleSnapshot === null) {
    stale.push({
      code: 'no_schedule_snapshot', severity: 'info',
      message: 'No schedule update snapshot has ever been persisted: forecast history and trend analysis are impossible.',
      evidence: ['schedule_update_snapshots = 0'],
      ageDays: null, thresholdDays: SNAPSHOT_STALE_DAYS,
    });
  } else if (schedSnapAge !== null && schedSnapAge > SNAPSHOT_STALE_DAYS) {
    stale.push({
      code: 'stale_schedule_snapshot', severity: 'warning',
      message: `Latest schedule snapshot is ${schedSnapAge} day(s) old (threshold ${SNAPSHOT_STALE_DAYS}).`,
      evidence: [`latest snapshot = ${history.latestScheduleSnapshot}`, `data_date = ${dataDate}`],
      ageDays: schedSnapAge, thresholdDays: SNAPSHOT_STALE_DAYS,
    });
  }
  if (history.latestCostSnapshot === null) {
    stale.push({
      code: 'no_cost_snapshot', severity: 'info',
      message: 'No cost-control snapshot has ever been persisted: EAC/ETC error and cost calibration are impossible.',
      evidence: ['cost_control_snapshots = 0'],
      ageDays: null, thresholdDays: SNAPSHOT_STALE_DAYS,
    });
  } else if (costSnapAge !== null && costSnapAge > SNAPSHOT_STALE_DAYS) {
    stale.push({
      code: 'stale_cost_snapshot', severity: 'warning',
      message: `Latest cost snapshot is ${costSnapAge} day(s) old (threshold ${SNAPSHOT_STALE_DAYS}).`,
      evidence: [`latest snapshot = ${history.latestCostSnapshot}`, `data_date = ${dataDate}`],
      ageDays: costSnapAge, thresholdDays: SNAPSHOT_STALE_DAYS,
    });
  }
  if ((schedSnaps.length > 0 && !schedSnapAtDataDate) || (costSnaps.length > 0 && !costSnapAtDataDate)) {
    const missing = [
      !schedSnapAtDataDate && schedSnaps.length > 0 ? 'schedule' : null,
      !costSnapAtDataDate && costSnaps.length > 0 ? 'cost' : null,
    ].filter(Boolean);
    stale.push({
      code: 'missing_current_update', severity: 'info',
      message: `No ${missing.join(' and ')} snapshot persisted at the current Data Date: this update cycle is not yet archived.`,
      evidence: [`data_date = ${dataDate}`, `latest schedule snapshot = ${history.latestScheduleSnapshot || 'none'}`, `latest cost snapshot = ${history.latestCostSnapshot || 'none'}`],
      ageDays: null, thresholdDays: 0,
    });
  }

  // =========================================================================
  // §6 Data integrity findings (F5/F6 quoted by reference + F8-only checks)
  // =========================================================================

  const integrity: TrustIntegrityFinding[] = [];
  for (const x of f5.integrity) {
    integrity.push({
      code: x.code, severity: x.severity, domain: 'progress', source: 'F5',
      message: x.message, evidence: x.evidence, ref: x.activityCode,
    });
  }
  for (const x of f6.integrity) {
    integrity.push({
      code: x.code, severity: x.severity, domain: 'cost', source: 'F6',
      message: x.message, evidence: x.evidence, ref: x.refLabel,
    });
  }
  // F8-only: future-dated snapshots are illegal evidence.
  for (const s of futureSchedSnaps) {
    integrity.push({
      code: 'future_schedule_snapshot', severity: 'error', domain: 'schedule', source: 'F8',
      message: `Schedule snapshot dated ${s.data_date} is after the Data Date ${dataDate}: it cannot be evidence.`,
      evidence: [`snapshot data_date = ${s.data_date}`, `governed data_date = ${dataDate}`], ref: s.id,
    });
  }
  for (const s of futureCostSnaps) {
    integrity.push({
      code: 'future_cost_snapshot', severity: 'error', domain: 'cost', source: 'F8',
      message: `Cost snapshot dated ${s.data_date} is after the Data Date ${dataDate}: it cannot be evidence.`,
      evidence: [`snapshot data_date = ${s.data_date}`, `governed data_date = ${dataDate}`], ref: s.id,
    });
  }
  // F8-only: duplicate progress evidence (same activity, date, percent, approved twice).
  const dupGroups = new Map<string, ProgressUpdate[]>();
  for (const u of approvedUpdates) {
    const key = `${u.activity_id}|${u.update_date}|${Number(u.percent_complete)}`;
    const list = dupGroups.get(key) || [];
    list.push(u);
    dupGroups.set(key, list);
  }
  for (const [key, group] of [...dupGroups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (group.length < 2) continue;
    const act = actById.get(group[0].activity_id);
    integrity.push({
      code: 'duplicate_progress_update', severity: 'warning', domain: 'progress', source: 'F8',
      message: `${group.length} identical approved progress updates (${key.split('|')[1]}, ${key.split('|')[2]}%) for ${act ? act.code : group[0].activity_id}: evidence is duplicated.`,
      evidence: group.map((u) => `progress_updates.id = ${u.id}`),
      ref: act ? act.code : null,
    });
  }
  // F8-only: missing baseline (project level).
  if (sortedActs.length > 0 && baselines.length === 0) {
    integrity.push({
      code: 'missing_baseline', severity: 'error', domain: 'baseline', source: 'F8',
      message: 'No approved baseline rows exist: variance, forecast error, and recovery targets cannot be measured.',
      evidence: [`activities = ${sortedActs.length}`, 'baseline_activities = 0'], ref: null,
    });
  }
  // F8-only: cost-bearing activities with no BOQ/activity trace.
  const allocByAct = new Set(allocations.map((al) => al.activity_id));
  const untraced = f6.activities.filter((c) => c.bac > 0 && !allocByAct.has(c.id));
  if (untraced.length > 0) {
    integrity.push({
      code: 'missing_boq_activity_trace', severity: 'warning', domain: 'cost', source: 'F8',
      message: `${untraced.length} budgeted activity(ies) carry no BOQ allocation: their cost variances cannot be traced to BOQ items.`,
      evidence: [
        ...[...untraced].sort(byCode).slice(0, 3).map((c) => `activity ${c.code}: BAC ${c.bac}, allocations = 0`),
        ...(untraced.length > 3 ? [`…and ${untraced.length - 3} more`] : []),
      ],
      ref: null,
    });
  }
  // F8-only: quantity mismatch — allocation shares exceeding the BOQ item quantity.
  const boqById = new Map(boqItems.map((b) => [b.id, b]));
  const shareByBoq = new Map<string, number>();
  for (const al of allocations) {
    const q = Number(al.quantity_share);
    if (!Number.isFinite(q)) continue;
    shareByBoq.set(al.boq_item_id, (shareByBoq.get(al.boq_item_id) || 0) + q);
  }
  for (const [boqId, shared] of [...shareByBoq.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const boq = boqById.get(boqId) as BoqItem | undefined;
    if (!boq || !(Number(boq.quantity) > 0) || shared <= Number(boq.quantity)) continue;
    integrity.push({
      code: 'boq_over_allocation', severity: 'warning', domain: 'cost', source: 'F8',
      message: `BOQ item ${boq.code} is over-allocated: activity quantity shares sum to ${round2(shared)} vs item quantity ${boq.quantity}.`,
      evidence: [`boq_items.quantity = ${boq.quantity}`, `Σ activity_boq_allocations.quantity_share = ${round2(shared)}`],
      ref: boq.code,
    });
  }
  // Deterministic presentation order: severity, then domain, then code, then ref.
  const sevRank = { error: 3, warning: 2, info: 1 } as const;
  const domainRank: Record<DataQualityDomainKey, number> = { schedule: 1, progress: 2, cost: 3, baseline: 4, forecast: 5 };
  integrity.sort((a, b) =>
    sevRank[b.severity] - sevRank[a.severity]
    || domainRank[a.domain] - domainRank[b.domain]
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
    || ((a.ref || '') < (b.ref || '') ? -1 : (a.ref || '') > (b.ref || '') ? 1 : 0));

  // =========================================================================
  // §7 Forecast reliability classification (deterministic, reasons declared)
  // =========================================================================

  const staleCodesFor = (target: 'schedule_finish' | 'cost_eac'): string[] => {
    const schedCodes = ['no_progress_updates', 'stale_progress', 'no_schedule_snapshot', 'stale_schedule_snapshot', 'missing_current_update'];
    const costCodes = ['no_cost_updates', 'stale_cost_updates', 'no_cost_snapshot', 'stale_cost_snapshot', 'missing_current_update'];
    return target === 'schedule_finish' ? schedCodes : costCodes;
  };
  const classify = (
    target: 'schedule_finish' | 'cost_eac',
    valueKnown: boolean,
    level: ConfidenceLevel,
    domainsScreened: DataQualityDomainKey[],
  ): ReliabilityAssessment => {
    const reasons: string[] = [];
    const errors = integrity.filter((x) => x.severity === 'error' && domainsScreened.includes(x.domain));
    const warnings = integrity.filter((x) => x.severity === 'warning' && domainsScreened.includes(x.domain));
    const staleHits = stale.filter((x) => x.severity === 'warning' && staleCodesFor(target).includes(x.code));
    if (!valueKnown) {
      reasons.push('the forecast value itself is N/A — nothing to trust');
      return { target, class: 'not_supportable', confidence: level, reasons };
    }
    reasons.push(`${target === 'schedule_finish' ? 'finish-forecast' : 'cost-forecast'} confidence is ${level} (quoted engine level, weakest-source capped with data quality)`);
    reasons.push(errors.length > 0 ? `${errors.length} error-severity integrity finding(s) in ${domainsScreened.join('/')} domain(s)` : 'no error-severity integrity finding in the screened domains');
    reasons.push(warnings.length > 0 ? `${warnings.length} warning-severity integrity finding(s): ${[...new Set(warnings.map((w) => w.code))].sort().join(', ')}` : 'no warning-severity integrity finding in the screened domains');
    reasons.push(staleHits.length > 0 ? `${staleHits.length} stale-data warning(s): ${staleHits.map((s) => s.code).join(', ')}` : 'no stale-data warning in this forecast chain');
    const dirty = errors.length > 0 || staleHits.length > 0;
    const cautious = warnings.length > 0;
    const cls: ReliabilityClass = level === 'High' ? (dirty || cautious ? 'usable_with_caution' : 'reliable')
      : level === 'Medium' ? (errors.length > 0 ? 'weak' : 'usable_with_caution')
      : 'weak';
    return { target, class: cls, confidence: level, reasons };
  };
  const schedReliability = classify('schedule_finish', f5.project.forecastFinish !== null,
    finishForecastConf.level, ['schedule', 'progress', 'baseline']);
  const costReliability = classify('cost_eac', f6.project.eac !== null,
    eacForecastConf.level, ['cost', 'baseline']);
  const relRank = (c: ReliabilityClass): number => RELIABILITY_ORDER.indexOf(c);
  const integratedReliabilityClass = relRank(schedReliability.class) <= relRank(costReliability.class)
    ? schedReliability.class : costReliability.class;
  const integratedReliability: ReliabilityAssessment = {
    target: 'integrated',
    class: integratedReliabilityClass,
    confidence: integratedConf.level,
    reasons: [
      `weakest-side cap: schedule finish = ${schedReliability.class}, cost EAC = ${costReliability.class}`,
      ...schedReliability.reasons.map((r) => `schedule: ${r}`),
      ...costReliability.reasons.map((r) => `cost: ${r}`),
    ],
  };
  const reliability = [schedReliability, costReliability, integratedReliability];

  // =========================================================================
  // §8 Decision confidence (F7 actions re-capped; F7 output is never mutated)
  // =========================================================================

  const decisionConfidence: DecisionConfidenceSection = (() => {
    if (!decisionReport) {
      return {
        integratedConfidence: integratedConf.level, actions: [], blockedStrongCount: 0,
        note: 'F7 decision report not provided: no actions to cap.',
      };
    }
    const globalGaps = stale.filter((s) => s.severity === 'warning').map((s) => s.message);
    const actions: CappedDecisionAction[] = decisionReport.actions.map((a) => {
      const effective = gateConfidence(a.confidence, integratedConf.level);
      const cappedBy = levelRank[a.confidence] <= levelRank[integratedConf.level]
        ? 'F7 action evidence' : `integrated forecast confidence (${integratedConf.cappedBy})`;
      const gaps: string[] = [];
      if (a.timeImpact.finishVarianceWd === null) gaps.push('no baseline finish variance for the affected activity');
      if (a.costImpact.cv === null && a.costImpact.eac === null) gaps.push('no cost evidence for the affected activity');
      gaps.push(...globalGaps);
      const strength: CappedDecisionAction['recommendationStrength'] =
        effective === 'High' ? 'directive' : effective === 'Medium' ? 'advisory' : 'investigate_only';
      return {
        rank: a.rank, issueId: a.issueId, title: a.title,
        reportedConfidence: a.confidence,
        effectiveConfidence: effective,
        cappedBy,
        recommendationStrength: strength,
        strongRecommendationAllowed: effective !== 'Low',
        evidenceGaps: gaps.slice(0, 4),
      };
    });
    return {
      integratedConfidence: integratedConf.level,
      actions,
      blockedStrongCount: actions.filter((a) => !a.strongRecommendationAllowed).length,
      note: actions.length === 0 ? 'F7 emitted no actions this cycle.'
        : `Effective confidence = gate(F7 action confidence, integrated ${integratedConf.level}); Low blocks strong recommendations (investigate only).`,
    };
  })();

  // =========================================================================
  // §9 Historical calibration (only after enough snapshots; else N/A)
  // =========================================================================

  const calibrate = (drifts: number[], subject: string): CalibrationResult => {
    if (drifts.length < MIN_CALIBRATION_DRIFTS) {
      return {
        evaluable: false, drifts, samplesUsed: drifts.length, classification: null,
        reason: `${drifts.length}/${MIN_CALIBRATION_DRIFTS} ${subject} drift sample(s): calibration is N/A until enough updates accrue.`,
      };
    }
    const optimistic = drifts.filter((d) => d > 0).length;
    const pessimistic = drifts.filter((d) => d < 0).length;
    const share = Math.max(optimistic, pessimistic) / drifts.length;
    const classification = share >= CALIBRATION_MAJORITY_SHARE
      ? (optimistic > pessimistic ? 'optimistic' : 'pessimistic') : 'stable';
    return {
      evaluable: true, drifts, samplesUsed: drifts.length, classification,
      reason: `${optimistic} positive / ${pessimistic} negative / ${drifts.length - optimistic - pessimistic} flat ${subject} drift(s); majority share ${(share * 100).toFixed(0)}% vs declared ${CALIBRATION_MAJORITY_SHARE * 100}%.`,
    };
  };
  const finishCalibration = calibrate(finishDrifts, 'finish-forecast');
  const eacDeltas = eacTrend.deltas.map((d) => d.delta).filter((v): v is number => v !== null);
  const eacCalibration = calibrate(eacDeltas, 'EAC');
  const calibration: CalibrationSection = {
    finish: finishCalibration,
    eac: eacCalibration,
    overall: (() => {
      const fc = finishCalibration.classification;
      const ec = eacCalibration.classification;
      if (fc === null && ec === null) {
        return { classification: null, reason: 'Neither finish nor EAC history is deep enough: calibration is N/A (never assumed stable).' };
      }
      if (fc === null) return { classification: ec, reason: `Only the EAC history is calibratable: ${eacCalibration.reason}` };
      if (ec === null) return { classification: fc, reason: `Only the finish history is calibratable: ${finishCalibration.reason}` };
      if (fc === ec) return { classification: fc, reason: 'Finish and EAC histories agree.' };
      return { classification: 'mixed', reason: `Finish reads ${fc} while EAC reads ${ec}.` };
    })(),
  };

  // =========================================================================
  // §10 Accuracy KPIs (published only above the declared sample floors)
  // =========================================================================

  // MAE samples: every (snapshot, activity) pair whose actual finish postdates the snapshot.
  const maeSamples: number[] = [];
  for (const snap of schedSnaps) {
    const det = snap.details && snap.details.version === 1 ? snap.details.activities : null;
    if (!det) continue;
    for (const id of Object.keys(det).sort()) {
      const row = det[id];
      if (!row || !isIsoDate(row.ef)) continue;
      const act = actById.get(id);
      if (!act || !isIsoDate(act.actual_finish)) continue;
      if ((act.actual_finish as string) <= snap.data_date) continue; // completed before the forecast
      const err = workingDayDelta(row.ef as string, act.actual_finish as string, getCalendar(act.calendar_type || calendarType));
      if (err !== null) maeSamples.push(err);
    }
    if (actualProjectFinish !== null && isIsoDate(snap.forecast_finish) && snap.data_date < actualProjectFinish) {
      const perr = workingDayDelta(snap.forecast_finish as string, actualProjectFinish, projectRuler);
      if (perr !== null) maeSamples.push(perr);
    }
  }
  const maeFinishForecastWd: AccuracyKpi<number> = maeSamples.length >= MIN_ACCURACY_SAMPLES
    ? {
      value: round1(maeSamples.reduce((t, e) => t + Math.abs(e), 0) / maeSamples.length),
      samples: maeSamples.length,
      reason: `Mean |error| over ${maeSamples.length} forecast-vs-outcome working-day sample(s) across all snapshots.`,
    }
    : {
      value: null, samples: maeSamples.length,
      reason: `${maeSamples.length}/${MIN_ACCURACY_SAMPLES} outcome sample(s): MAE is N/A until enough forecasts resolve.`,
    };

  const hitSamples = allMilestoneSamples.filter((s) => s.hit !== null);
  const hits = hitSamples.filter((s) => s.hit === true).length;
  const milestoneHitRatePct: AccuracyKpis['milestoneHitRatePct'] = hitSamples.length >= MIN_ACCURACY_SAMPLES
    ? {
      value: round1((100 * hits) / hitSamples.length), samples: hitSamples.length, hits,
      reason: `${hits}/${hitSamples.length} milestone forecast(s) landed within ±${FORECAST_MATCH_TOLERANCE_WD} wd (F5 tolerance).`,
    }
    : {
      value: null, samples: hitSamples.length, hits,
      reason: `${hitSamples.length}/${MIN_ACCURACY_SAMPLES} milestone outcome(s): hit rate is N/A.`,
    };

  const eacForecastErrorPct: AccuracyKpi<number> = eac.errorPct !== null
    ? {
      value: eac.errorPct, samples: 1,
      reason: `Final cost vs previous forecast EAC (${eac.previousSnapshotDate}): outcome-based error.`,
    }
    : { value: null, samples: 0, reason: eac.reason };

  const driftPairs = finishDrifts.length;
  const forecastDriftPerUpdateWd: AccuracyKpis['forecastDriftPerUpdateWd'] = driftPairs >= MIN_DRIFT_PAIRS
    ? {
      value: round1(finishDrifts.reduce((t, d) => t + Math.abs(d), 0) / driftPairs),
      samples: driftPairs, pairs: driftPairs,
      reason: `Mean |finish drift| per update over ${driftPairs} adjacent forecast pair(s).`,
    }
    : {
      value: null, samples: driftPairs, pairs: driftPairs,
      reason: `${driftPairs}/${MIN_DRIFT_PAIRS} adjacent forecast pair(s): drift-per-update is N/A.`,
    };

  const accuracyKpis: AccuracyKpis = { maeFinishForecastWd, milestoneHitRatePct, eacForecastErrorPct, forecastDriftPerUpdateWd };

  // =========================================================================
  // §11 Executive trust summary (quoted numbers + capped confidences)
  // =========================================================================

  const kpiPool: Array<{ key: string; level: ConfidenceLevel }> = [
    { key: 'forecast_finish', level: f5.confidence.forecastFinish.level },
    { key: 'total_delay', level: f5.confidence.totalDelay.level },
    { key: 'critical_path', level: f5.confidence.criticalPath.level },
    { key: 'milestones', level: f5.confidence.milestones.level },
    { key: 'progress_pct', level: f5.confidence.progressPct.level },
    { key: 'bac', level: f6.confidence.bac.level },
    { key: 'pv', level: f6.confidence.pv.level },
    { key: 'ev', level: f6.confidence.ev.level },
    { key: 'ac', level: f6.confidence.ac.level },
    { key: 'eac', level: f6.confidence.eac.level },
    { key: 'cost_forecast', level: f6.confidence.forecast.level },
  ];
  const mostReliableKpi = [...kpiPool].sort((a, b) =>
    levelRank[b.level] - levelRank[a.level] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0] || null;
  // Declared rule: "least reliable" is only meaningful when the pool actually differs; when every
  // KPI carries the same level the answer is null (N/A), never an arbitrary alphabetical pick.
  const levelsDiffer = new Set(kpiPool.map((k) => k.level)).size > 1;
  const leastReliableKpi = levelsDiffer
    ? [...kpiPool].sort((a, b) =>
      levelRank[a.level] - levelRank[b.level] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0] || null
    : null;

  const riskPool: Array<{ rank: number; message: string }> = [
    ...integrity.filter((x) => x.severity === 'error').map((x) => ({ rank: 3, message: `${x.source}/${x.code}: ${x.message}` })),
    ...stale.filter((x) => x.severity === 'warning').map((x) => ({ rank: 2, message: `${x.code}: ${x.message}` })),
    ...integrity.filter((x) => x.severity === 'warning').map((x) => ({ rank: 1, message: `${x.source}/${x.code}: ${x.message}` })),
  ];
  const topDataRisk = riskPool.length > 0
    ? [...riskPool].sort((a, b) => b.rank - a.rank || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0))[0].message
    : null;

  const trust: ExecutiveTrustSummary = {
    forecastFinish: f5.project.forecastFinish, // quoted from F5
    forecastConfidence: finishForecastConf.level,
    eac: f6.project.eac, // quoted from F6
    costForecastConfidence: eacForecastConf.level,
    overallDataQuality: { score: overallScore, level: dqLevel },
    topDataRisk,
    mostReliableKpi,
    leastReliableKpi,
  };

  return {
    dataDate,
    history,
    accuracy,
    trends,
    dataQuality,
    confidence,
    stale,
    integrity,
    reliability,
    decisionConfidence,
    calibration,
    accuracyKpis,
    trust,
  };
}

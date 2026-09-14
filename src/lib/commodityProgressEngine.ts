/**
 * Commodity (physical quantity) progress engine — GAP-026.
 *
 * The "Physical Quantity S-Curves & Required Run-Rate" screen used to show four hardcoded
 * commodities (concrete 2,800 m3 at 60%, rebar 350 t, earthworks 4,500 m3, pipes 1,800 lm) with
 * static run-rates that no record in the database supported. This module replaces that fabricated
 * block with a derivation that only ever reads real rows:
 *
 *   planned   — `boq_items.quantity` grouped by unit (falling back to `activities.planned_quantity`
 *               for the same unit when the BOQ carries no row for it, reported as such);
 *   executed  — the latest APPROVED `progress_updates` row per activity dated on or before the
 *               governed Data Date (`quantity_to_date`, or `actual_quantity` when the cumulative
 *               field is not populated), plus `activities.actual_quantity` for activities that have
 *               no approved update at all — never both for the same activity;
 *   remaining — planned minus executed;
 *   rates     — executed over elapsed working days, remaining over remaining working days, both on
 *               the project calendar and both N/A when the evidence needed for the denominator does
 *               not exist.
 *
 * Hard rules enforced here (AGENTS.md §7.2, §7.3, §7.6):
 *
 *  1. Quantities of different units are NEVER aggregated. Each result row is one unit; the summary
 *     exposes record counts only, because counts are the only unit-agnostic quantity.
 *  2. A record dated after the Data Date is not an actual: it is counted as excluded and reported,
 *     so a future delivery or a draft update can never inflate executed volume.
 *  3. Nothing is invented when inputs are missing: planned / executed / remaining / progress /
 *     rates come back `null` (rendered as N/A) with a bilingual reason, instead of a plausible
 *     number.
 */

import type { Activity, BoqItem, Project, ProgressUpdate } from '@/types';
import { countWorkingDays, getCalendar } from '@/lib/calendarEngine';
import {
  calendarDaysBetween,
  earliestDate,
  latestDate,
  resolveDataDate,
  splitByChronology,
  sumNumeric,
} from '@/lib/chronologyGuard';

/** Key used for rows whose unit is missing — kept separate from every real unit. */
export const UNSPECIFIED_UNIT_KEY = 'unspecified';

/**
 * Unit synonyms that denote the SAME physical dimension. Anything not listed here keeps its own
 * key, so an unknown unit is never merged into another commodity.
 */
const UNIT_ALIASES: Record<string, string> = {
  // volume
  m3: 'm3',
  'm^3': 'm3',
  'm³': 'm3',
  cum: 'm3',
  cbm: 'm3',
  'م3': 'm3',
  'متر مكعب': 'm3',
  // mass (never merged with volume)
  ton: 'ton',
  tons: 'ton',
  tonne: 'ton',
  tonnes: 'ton',
  mt: 'ton',
  t: 'ton',
  'طن': 'ton',
  kg: 'kg',
  kgs: 'kg',
  'كجم': 'kg',
  'كيلو جرام': 'kg',
  // area
  m2: 'm2',
  'm^2': 'm2',
  'm²': 'm2',
  sqm: 'm2',
  'م2': 'm2',
  'متر مربع': 'm2',
  // length
  m: 'm',
  lm: 'm',
  ml: 'm',
  'م.ط': 'm',
  'متر طولي': 'm',
  'متر': 'm',
  km: 'km',
  'كم': 'km',
  // discrete counts
  unit: 'unit',
  units: 'unit',
  pce: 'unit',
  pcs: 'unit',
  nos: 'unit',
  no: 'unit',
  'عدد': 'unit',
  'وحدة': 'unit',
  point: 'point',
  points: 'point',
  'نقطة': 'point',
  'نقاط': 'point',
  pole: 'pole',
  poles: 'pole',
  pile: 'pile',
  piles: 'pile',
  'خازوق': 'pile',
  'خوازيق': 'pile',
  lot: 'lot',
  ls: 'lot',
  'مقطوعية': 'lot',
  // time
  day: 'day',
  days: 'day',
  'يوم': 'day',
  'أيام': 'day',
  month: 'month',
  months: 'month',
  'شهر': 'month',
  'أشهر': 'month',
};

const UNIT_LABELS: Record<string, { ar: string; en: string }> = {
  m3: { ar: 'متر مكعب (م3)', en: 'Cubic Meters (m3)' },
  ton: { ar: 'طن متري', en: 'Metric Tons' },
  kg: { ar: 'كيلو جرام', en: 'Kilograms' },
  m2: { ar: 'متر مربع (م2)', en: 'Square Meters (m2)' },
  m: { ar: 'متر طولي (م.ط)', en: 'Linear Meters' },
  km: { ar: 'كيلومتر', en: 'Kilometers' },
  unit: { ar: 'وحدة / عدد', en: 'Units' },
  point: { ar: 'نقطة', en: 'Points' },
  pole: { ar: 'عمود', en: 'Poles' },
  pile: { ar: 'خازوق', en: 'Piles' },
  lot: { ar: 'مقطوعية', en: 'Lot / Lump Sum' },
  day: { ar: 'يوم', en: 'Days' },
  month: { ar: 'شهر', en: 'Months' },
  [UNSPECIFIED_UNIT_KEY]: { ar: 'بدون وحدة محددة', en: 'No unit specified' },
};

/** Canonical grouping key of a unit string. Unknown units keep their own (trimmed, lowercased) key. */
export function normalizeUnitKey(unit: string | null | undefined): string {
  if (typeof unit !== 'string') return UNSPECIFIED_UNIT_KEY;
  const cleaned = unit.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!cleaned || cleaned === '-') return UNSPECIFIED_UNIT_KEY;
  return UNIT_ALIASES[cleaned] || cleaned;
}

/** Bilingual display label of a unit key; falls back to the raw unit text when the key is unknown. */
export function unitLabels(unitKey: string, rawUnit?: string | null): { ar: string; en: string } {
  const known = UNIT_LABELS[unitKey];
  if (known) return known;
  const text = rawUnit && rawUnit.trim() ? rawUnit.trim() : unitKey;
  return { ar: text, en: text };
}

export type CommodityPlannedSource = 'boq_items' | 'activities' | null;

export type CommodityRateVerdict =
  | 'complete'
  | 'achievable'
  | 'at_risk'
  | 'window_expired'
  | 'insufficient_data';

export type CommodityStatus = 'ok' | 'no_planned_quantity' | 'no_approved_progress';

export interface CommodityUnitSummary {
  /** Canonical grouping key. One row == one unit; rows are never summed together. */
  unitKey: string;
  unitLabelAr: string;
  unitLabelEn: string;
  /** Raw unit strings that mapped onto this key (lineage for the reader). */
  sourceUnits: string[];

  boqItemCount: number;
  activityCount: number;
  approvedUpdateCount: number;
  /** Updates that were rejected / still in workflow, or dated after the Data Date. */
  excludedUpdateCount: number;
  /** Dated after the Data Date: forward-looking, never an actual. */
  excludedFutureUpdateCount: number;
  /** Dated on or before the Data Date but not approved (draft / submitted / rejected). */
  excludedUnapprovedUpdateCount: number;
  /** No usable date at all: cannot be placed in time, so never an actual. */
  excludedUndatedUpdateCount: number;

  plannedQuantity: number | null;
  plannedSource: CommodityPlannedSource;
  plannedFromBoq: number;
  plannedFromActivities: number;

  executedQuantity: number;
  executedFromApprovedUpdates: number;
  executedFromActivityRecords: number;

  remainingQuantity: number | null;
  progressPercent: number | null;

  /** Production evidence window used for the actual rate. */
  productionWindowStart: string | null;
  lastApprovedUpdateDate: string | null;
  elapsedWorkingDays: number | null;
  actualRatePerDay: number | null;
  actualRateBasisAr: string | null;
  actualRateBasisEn: string | null;

  /** Planned finish of this commodity used for the required rate. */
  commodityWindowEnd: string | null;
  remainingWorkingDays: number | null;
  requiredRatePerDay: number | null;
  requiredRateBasisAr: string | null;
  requiredRateBasisEn: string | null;

  rateVerdict: CommodityRateVerdict;
  verdictNoteAr: string;
  verdictNoteEn: string;

  status: CommodityStatus;
  statusNoteAr: string;
  statusNoteEn: string;
}

export interface CommodityProgressSummary {
  dataDate: string;
  groups: CommodityUnitSummary[];
  totalApprovedUpdates: number;
  totalExcludedUpdates: number;
  totalFutureDatedUpdates: number;
  projectEndDate: string | null;
  /**
   * Quantities of different units are not aggregated anywhere in this summary; this states why, so a
   * consumer cannot mistake the absence of a grand total for an omission.
   */
  noCrossUnitTotalReasonAr: string;
  noCrossUnitTotalReasonEn: string;
}

export interface CommodityProgressSources {
  project: Project | null;
  activities: Activity[];
  boqItems: BoqItem[];
  progressUpdates: ProgressUpdate[];
  /** Explicit cutoff; otherwise `project.data_date` -> governed `DEFAULT_DATA_DATE`. */
  overrideDataDate?: string;
}

const NO_PLANNED_AR = 'لا توجد كمية مخططة موثقة لهذه الوحدة (لا بنود في جدول الكميات ولا كميات مخططة على الأنشطة) — النسبة غير قابلة للحساب (N/A).';
const NO_PLANNED_EN = 'No documented planned quantity for this unit (neither BOQ rows nor activity planned quantities) — the percentage is not computable (N/A).';
const NO_PROGRESS_AR = 'لا يوجد إنجاز معتمد لهذه الوحدة حتى تاريخ خط الحالة — المنفذ صفر وليس نسبة تقديرية.';
const NO_PROGRESS_EN = 'No approved progress for this unit up to the Data Date — executed is zero, not an estimated percentage.';
const OK_AR = 'الكميات مشتقة من بنود جدول الكميات ومن طلبات الإنجاز المعتمدة بتاريخ لا يتجاوز تاريخ خط الحالة.';
const OK_EN = 'Quantities derived from BOQ rows and from approved progress updates dated on or before the Data Date.';

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Derive per-unit (commodity) physical progress and the run-rates needed to finish on time.
 *
 * Pure and side-effect free: the same rows and the same Data Date always produce the same summary.
 */
export function summarizeCommodityProgress(sources: CommodityProgressSources): CommodityProgressSummary {
  const { project, activities, boqItems, progressUpdates } = sources;
  const dataDate = resolveDataDate(project, sources.overrideDataDate);
  const calendar = getCalendar(project?.calendar_type);
  const projectEndDate = project?.end_date || null;

  const safeActivities = Array.isArray(activities) ? activities : [];
  const safeBoqItems = Array.isArray(boqItems) ? boqItems : [];
  const safeUpdates = Array.isArray(progressUpdates) ? progressUpdates : [];

  // ---- 1. Collect the unit keys that actually appear in the data -----------------------------
  const rawUnitsByKey = new Map<string, Set<string>>();
  const registerUnit = (unit: string | null | undefined) => {
    const key = normalizeUnitKey(unit);
    const bucket = rawUnitsByKey.get(key) || new Set<string>();
    if (typeof unit === 'string' && unit.trim()) bucket.add(unit.trim());
    rawUnitsByKey.set(key, bucket);
  };
  safeBoqItems.forEach((item) => registerUnit(item.unit));
  safeActivities.forEach((activity) => registerUnit(activity.unit));

  // ---- 2. One summary row per unit -----------------------------------------------------------
  const groups: CommodityUnitSummary[] = Array.from(rawUnitsByKey.keys()).map((unitKey) => {
    const boqRows = safeBoqItems.filter((item) => normalizeUnitKey(item.unit) === unitKey);
    const unitActivities = safeActivities.filter((activity) => normalizeUnitKey(activity.unit) === unitKey);

    // Planned quantity: the BOQ is the contractual source; activity planned quantities are used only
    // when the BOQ carries nothing for this unit, and the source is reported either way.
    const plannedFromBoq = sumNumeric(boqRows, (item) => item.quantity);
    const plannedFromActivities = sumNumeric(unitActivities, (activity) => activity.planned_quantity);
    let plannedQuantity: number | null = null;
    let plannedSource: CommodityPlannedSource = null;
    if (plannedFromBoq > 0) {
      plannedQuantity = plannedFromBoq;
      plannedSource = 'boq_items';
    } else if (plannedFromActivities > 0) {
      plannedQuantity = plannedFromActivities;
      plannedSource = 'activities';
    }

    // Executed quantity: latest APPROVED update per activity, dated on or before the Data Date.
    const activityIds = new Set(unitActivities.map((activity) => activity.id));
    const relatedUpdates = safeUpdates.filter((update) => activityIds.has(update.activity_id));
    const chronology = splitByChronology(relatedUpdates, (update) => update.update_date, dataDate);
    const eligibleUpdates = chronology.actual.filter((update) => update.status === 'approved');
    const excludedFutureUpdateCount = chronology.futurePlanned.length;
    const excludedUndatedUpdateCount = chronology.undated.length;
    const excludedUnapprovedUpdateCount = chronology.actual.length - eligibleUpdates.length;

    const latestByActivity = new Map<string, ProgressUpdate>();
    eligibleUpdates.forEach((update) => {
      const current = latestByActivity.get(update.activity_id);
      if (!current) {
        latestByActivity.set(update.activity_id, update);
        return;
      }
      const compare = calendarDaysBetween(current.update_date, update.update_date) || 0;
      if (compare > 0 || (compare === 0 && update.id > current.id)) {
        latestByActivity.set(update.activity_id, update);
      }
    });

    let executedFromApprovedUpdates = 0;
    const activitiesWithApprovedUpdate = new Set<string>();
    latestByActivity.forEach((update, activityId) => {
      activitiesWithApprovedUpdate.add(activityId);
      const cumulative = update.quantity_to_date;
      executedFromApprovedUpdates += isPositiveNumber(cumulative) ? cumulative : (update.actual_quantity || 0);
    });

    // Secondary source, only for activities that carry an actual quantity but no approved update —
    // so an activity can never be counted twice.
    let executedFromActivityRecords = 0;
    unitActivities.forEach((activity) => {
      if (activitiesWithApprovedUpdate.has(activity.id)) return;
      if (isPositiveNumber(activity.actual_quantity)) executedFromActivityRecords += activity.actual_quantity;
    });

    const executedQuantity = round(executedFromApprovedUpdates + executedFromActivityRecords, 3);
    const remainingQuantity = plannedQuantity === null ? null : round(plannedQuantity - executedQuantity, 3);
    const progressPercent = plannedQuantity !== null && plannedQuantity > 0
      ? round((executedQuantity / plannedQuantity) * 100, 1)
      : null;

    // ---- Actual production rate -------------------------------------------------------------
    const approvedDates = eligibleUpdates.map((update) => update.update_date);
    const lastApprovedUpdateDate = latestDate(approvedDates, (date) => date);
    const firstApprovedUpdateDate = earliestDate(approvedDates, (date) => date);
    const actualStarts = unitActivities
      .map((activity) => activity.actual_start)
      .filter((date): date is string => typeof date === 'string');
    const productionWindowStart = firstApprovedUpdateDate
      || earliestDate(actualStarts, (date) => date)
      || project?.start_date
      || null;

    let elapsedWorkingDays: number | null = null;
    if (productionWindowStart) {
      const counted = countWorkingDays(productionWindowStart, dataDate, calendar);
      elapsedWorkingDays = counted > 0 ? counted : null;
    }

    const hasExecutionEvidence = eligibleUpdates.length > 0 || executedFromActivityRecords > 0;
    const actualRatePerDay = elapsedWorkingDays !== null && hasExecutionEvidence
      ? round(executedQuantity / elapsedWorkingDays, 3)
      : null;
    const actualRateBasisAr = actualRatePerDay === null
      ? null
      : `المنفذ ${executedQuantity.toLocaleString('en-US')} ÷ ${elapsedWorkingDays} يوم عمل من ${productionWindowStart} حتى تاريخ خط الحالة ${dataDate}.`;
    const actualRateBasisEn = actualRatePerDay === null
      ? null
      : `Executed ${executedQuantity.toLocaleString('en-US')} divided by ${elapsedWorkingDays} working days from ${productionWindowStart} to the Data Date ${dataDate}.`;

    // ---- Required production rate -----------------------------------------------------------
    // The commodity's own planned finish governs; the project finish is the fallback.
    const activityFinishes = unitActivities
      .map((activity) => activity.late_finish || activity.early_finish)
      .filter((date): date is string => typeof date === 'string');
    const commodityWindowEnd = latestDate(activityFinishes, (date) => date) || projectEndDate;

    let remainingWorkingDays: number | null = null;
    let windowExpired = false;
    if (commodityWindowEnd) {
      const distance = calendarDaysBetween(dataDate, commodityWindowEnd);
      windowExpired = distance !== null && distance <= 0;
      if (!windowExpired) {
        // The Data Date itself already belongs to the elapsed window, so it is not counted twice.
        const counted = countWorkingDays(dataDate, commodityWindowEnd, calendar) - 1;
        remainingWorkingDays = counted > 0 ? counted : null;
      }
    }

    let requiredRatePerDay: number | null = null;
    if (remainingQuantity !== null) {
      if (remainingQuantity <= 0) {
        requiredRatePerDay = 0;
      } else if (remainingWorkingDays !== null) {
        requiredRatePerDay = round(remainingQuantity / remainingWorkingDays, 3);
      }
    }
    const requiredRateBasisAr = requiredRatePerDay === null
      ? null
      : remainingQuantity !== null && remainingQuantity <= 0
        ? 'لا توجد كمية متبقية — اكتمل تنفيذ هذه الوحدة.'
        : `المتبقي ${remainingQuantity?.toLocaleString('en-US')} ÷ ${remainingWorkingDays} يوم عمل من ${dataDate} حتى ${commodityWindowEnd}.`;
    const requiredRateBasisEn = requiredRatePerDay === null
      ? null
      : remainingQuantity !== null && remainingQuantity <= 0
        ? 'No remaining quantity — this unit is complete.'
        : `Remaining ${remainingQuantity?.toLocaleString('en-US')} divided by ${remainingWorkingDays} working days from ${dataDate} to ${commodityWindowEnd}.`;

    // ---- Verdict ----------------------------------------------------------------------------
    let rateVerdict: CommodityRateVerdict;
    let verdictNoteAr: string;
    let verdictNoteEn: string;
    if (remainingQuantity !== null && remainingQuantity <= 0) {
      rateVerdict = 'complete';
      verdictNoteAr = 'اكتملت الكميات المخططة لهذه الوحدة وفق السجلات المعتمدة.';
      verdictNoteEn = 'The planned quantity of this unit is complete according to the approved records.';
    } else if (actualRatePerDay !== null && requiredRatePerDay !== null) {
      rateVerdict = actualRatePerDay >= requiredRatePerDay ? 'achievable' : 'at_risk';
      verdictNoteAr = rateVerdict === 'achievable'
        ? 'معدل الإنتاج الفعلي يغطي المعدل المطلوب للانتهاء في الموعد المخطط.'
        : 'معدل الإنتاج الفعلي أقل من المعدل المطلوب للانتهاء في الموعد المخطط.';
      verdictNoteEn = rateVerdict === 'achievable'
        ? 'The measured production rate covers the rate required to finish by the planned date.'
        : 'The measured production rate is below the rate required to finish by the planned date.';
    } else if (windowExpired) {
      rateVerdict = 'window_expired';
      verdictNoteAr = remainingQuantity !== null && remainingQuantity > 0
        ? `انتهت النافذة الزمنية المخططة (${commodityWindowEnd}) ولا تزال هناك كمية متبقية — لا يمكن احتساب معدل مطلوب لفترة منتهية (N/A).`
        : `انتهت النافذة الزمنية المخططة (${commodityWindowEnd}).`;
      verdictNoteEn = remainingQuantity !== null && remainingQuantity > 0
        ? `The planned window ended (${commodityWindowEnd}) with quantity still remaining — a required rate over an expired window is not computable (N/A).`
        : `The planned window ended (${commodityWindowEnd}).`;
    } else {
      rateVerdict = 'insufficient_data';
      if (actualRatePerDay === null && requiredRatePerDay === null) {
        verdictNoteAr = 'لا تتوافر أدلة كافية لاحتساب معدل فعلي أو مطلوب: لا إنجاز معتمد ولا نافذة زمنية مخططة لهذه الوحدة.';
        verdictNoteEn = 'Not enough evidence for an actual or required rate: no approved progress and no planned window for this unit.';
      } else if (actualRatePerDay === null) {
        verdictNoteAr = 'المعدل الفعلي غير قابل للحساب (N/A): لا يوجد إنجاز معتمد لهذه الوحدة حتى تاريخ خط الحالة، ولا يُستنتج معدل تقديري.';
        verdictNoteEn = 'The actual rate is not computable (N/A): no approved progress for this unit up to the Data Date, and no rate is inferred.';
      } else {
        verdictNoteAr = 'المعدل المطلوب غير قابل للحساب (N/A): لا توجد كمية مخططة أو نافذة زمنية متبقية لهذه الوحدة.';
        verdictNoteEn = 'The required rate is not computable (N/A): no planned quantity or remaining window for this unit.';
      }
    }

    const status: CommodityStatus = plannedQuantity === null
      ? 'no_planned_quantity'
      : eligibleUpdates.length === 0 && executedFromActivityRecords === 0
        ? 'no_approved_progress'
        : 'ok';
    const statusNoteAr = status === 'no_planned_quantity' ? NO_PLANNED_AR : status === 'no_approved_progress' ? NO_PROGRESS_AR : OK_AR;
    const statusNoteEn = status === 'no_planned_quantity' ? NO_PLANNED_EN : status === 'no_approved_progress' ? NO_PROGRESS_EN : OK_EN;

    const sourceUnits = Array.from(rawUnitsByKey.get(unitKey) || []).sort();

    return {
      unitKey,
      unitLabelAr: unitLabels(unitKey, sourceUnits[0]).ar,
      unitLabelEn: unitLabels(unitKey, sourceUnits[0]).en,
      sourceUnits,
      boqItemCount: boqRows.length,
      activityCount: unitActivities.length,
      approvedUpdateCount: eligibleUpdates.length,
      excludedUpdateCount: excludedFutureUpdateCount + excludedUnapprovedUpdateCount + excludedUndatedUpdateCount,
      excludedFutureUpdateCount,
      excludedUnapprovedUpdateCount,
      excludedUndatedUpdateCount,
      plannedQuantity: plannedQuantity === null ? null : round(plannedQuantity, 3),
      plannedSource,
      plannedFromBoq: round(plannedFromBoq, 3),
      plannedFromActivities: round(plannedFromActivities, 3),
      executedQuantity,
      executedFromApprovedUpdates: round(executedFromApprovedUpdates, 3),
      executedFromActivityRecords: round(executedFromActivityRecords, 3),
      remainingQuantity,
      progressPercent,
      productionWindowStart,
      lastApprovedUpdateDate,
      elapsedWorkingDays,
      actualRatePerDay,
      actualRateBasisAr,
      actualRateBasisEn,
      commodityWindowEnd,
      remainingWorkingDays,
      requiredRatePerDay,
      requiredRateBasisAr,
      requiredRateBasisEn,
      rateVerdict,
      verdictNoteAr,
      verdictNoteEn,
      status,
      statusNoteAr,
      statusNoteEn,
    } satisfies CommodityUnitSummary;
  });

  // Deterministic presentation order: real units with the largest planned quantity first, the
  // unit-less bucket last.
  groups.sort((a, b) => {
    if (a.unitKey === UNSPECIFIED_UNIT_KEY) return 1;
    if (b.unitKey === UNSPECIFIED_UNIT_KEY) return -1;
    const byPlanned = (b.plannedQuantity ?? 0) - (a.plannedQuantity ?? 0);
    if (byPlanned !== 0) return byPlanned;
    return a.unitKey.localeCompare(b.unitKey);
  });

  return {
    dataDate,
    groups,
    totalApprovedUpdates: groups.reduce((total, group) => total + group.approvedUpdateCount, 0),
    totalExcludedUpdates: groups.reduce((total, group) => total + group.excludedUpdateCount, 0),
    totalFutureDatedUpdates: groups.reduce((total, group) => total + group.excludedFutureUpdateCount, 0),
    projectEndDate,
    noCrossUnitTotalReasonAr: 'لا يتم جمع الكميات بين الوحدات المختلفة (م3 مع طن مع م2) — كل بطاقة تمثل وحدة قياس واحدة فقط، والإجماليات الوحيدة المعروضة هي أعداد السجلات.',
    noCrossUnitTotalReasonEn: 'Quantities of different units are never added together (m3 with tons with m2) — each card is one unit of measure, and the only totals shown are record counts.',
  };
}

import type { Activity, ActivityLink, BaselineActivity, ActivityResource, CalendarType, DcmaAuditResult, DcmaPointResult } from '@/types';
import type { GeneratedAlert } from '@/lib/alertEngine';
import type { CpmResult, LinkDrivingResult } from '@/lib/cpmEngine';
import { supabase } from '@/lib/supabase';
import { calculateCpm } from '@/lib/cpmEngine';
import { resolveDataDate } from '@/lib/chronologyGuard';

/** Activity types the network treats as milestone anchors (same predicate the CPM engine uses). */
function isMilestoneActivity(activity: Activity): boolean {
  return Boolean(activity.is_milestone)
    || activity.activity_type === 'start_milestone'
    || activity.activity_type === 'finish_milestone';
}

/**
 * The date an activity actually starts at, honouring recorded progress before planned dates.
 * Mirrors the CPM forward pass, which anchors on `actual_start || early_start`.
 */
export function effectiveActivityStart(activity: Activity): string | null {
  return activity.actual_start || activity.early_start || null;
}

/** The date an activity actually finishes at (`actual_finish || early_finish || its start`). */
export function effectiveActivityFinish(activity: Activity): string | null {
  return activity.actual_finish || activity.early_finish || effectiveActivityStart(activity);
}

export interface OpenEndAssessment {
  /** Earliest effective start across the whole network (milestones included). */
  startBoundaryDate: string | null;
  /** Latest effective finish across the whole network (milestones included). */
  finishBoundaryDate: string | null;
  /** True when the schedule owns a milestone with no predecessor sitting on the start boundary. */
  hasStartBoundaryMilestone: boolean;
  /** True when the schedule owns a milestone with no successor sitting on the finish boundary. */
  hasFinishBoundaryMilestone: boolean;
  /** Non-milestone activities whose missing predecessor is a genuine defect (Point 1). */
  openStartDefects: Activity[];
  /** Non-milestone activities whose missing successor is a genuine defect (Point 1). */
  openFinishDefects: Activity[];
  /** Per-activity Arabic reason for each open-start defect. */
  openStartReasons: Map<string, string>;
  /** Per-activity Arabic reason for each open-finish defect. */
  openFinishReasons: Map<string, string>;
  /** Every activity (milestones included) that legitimately carries no predecessor. */
  legitimateStartIds: Set<string>;
  /** Every activity (milestones included) that legitimately carries no successor. */
  legitimateFinishIds: Set<string>;
}

/**
 * GAP-014 — open starts / open finishes resolved from network and status data only.
 *
 * The previous implementation exempted the FIRST and the LAST element of the activity array from
 * the open-end test (`index > 0`, `index < length - 1`). Array position carries no schedule
 * meaning: rows arrive ordered by `sort_order` / import order, so the exemption followed the order
 * a file happened to be loaded in — an activity that really was the network start but was stored
 * second was reported as a defect, while an unlinked row stored first was silently excused.
 *
 * The rule applied from here on (the rule an auditor can reproduce from the schedule itself):
 *
 *  1. Population — non-milestone activities, unchanged (milestones are the anchors the logic hangs
 *     from, so they are not themselves "open ends" for Point 1).
 *  2. Boundaries — the start boundary is the earliest effective start (`actual_start ||
 *     early_start`) over ALL activities; the finish boundary is the latest effective finish
 *     (`actual_finish || early_finish || effective start`) over ALL activities.
 *  3. Start legitimacy — an activity with no predecessor is a legitimate project start ONLY when it
 *     sits on the start boundary AND the network does not own a start-boundary milestone (a
 *     milestone with no predecessor on that same boundary date). When such a milestone exists it is
 *     the single project-start anchor, so every other unlinked activity is an internal open start.
 *  4. Finish legitimacy — mirrored on the finish boundary / finish-boundary milestone.
 *  5. Undated rows — an activity with neither dates nor logic cannot be located on the network at
 *     all; it is reported as a defect with its own reason instead of being exempted by position.
 *
 * Point 11 (critical-path continuity) reuses `legitimateStartIds` / `legitimateFinishIds`, so both
 * checks agree on what a real network boundary is.
 */
export function assessOpenEnds(activities: Activity[], links: ActivityLink[]): OpenEndAssessment {
  const hasPredecessor = new Set(links.map((l) => l.successor_id));
  const hasSuccessor = new Set(links.map((l) => l.predecessor_id));

  const startDates = activities.map(effectiveActivityStart).filter((d): d is string => Boolean(d));
  const finishDates = activities.map(effectiveActivityFinish).filter((d): d is string => Boolean(d));
  const startBoundaryDate = startDates.length ? startDates.reduce((min, d) => (d < min ? d : min)) : null;
  const finishBoundaryDate = finishDates.length ? finishDates.reduce((max, d) => (d > max ? d : max)) : null;

  const hasStartBoundaryMilestone = activities.some((a) =>
    isMilestoneActivity(a) && !hasPredecessor.has(a.id) && effectiveActivityStart(a) === startBoundaryDate && startBoundaryDate !== null);
  const hasFinishBoundaryMilestone = activities.some((a) =>
    isMilestoneActivity(a) && !hasSuccessor.has(a.id) && effectiveActivityFinish(a) === finishBoundaryDate && finishBoundaryDate !== null);

  const openStartDefects: Activity[] = [];
  const openFinishDefects: Activity[] = [];
  const openStartReasons = new Map<string, string>();
  const openFinishReasons = new Map<string, string>();
  const legitimateStartIds = new Set<string>();
  const legitimateFinishIds = new Set<string>();

  activities.forEach((activity) => {
    const milestone = isMilestoneActivity(activity);
    const actStart = effectiveActivityStart(activity);
    const actFinish = effectiveActivityFinish(activity);

    // --- predecessor side -------------------------------------------------------------
    if (!hasPredecessor.has(activity.id)) {
      const onBoundary = startBoundaryDate !== null && actStart === startBoundaryDate;
      if (milestone) {
        // A milestone anchor with no predecessor is legitimate only on the start boundary.
        if (onBoundary) legitimateStartIds.add(activity.id);
      } else if (actStart === null) {
        openStartDefects.push(activity);
        openStartReasons.set(activity.id, 'بداية مفتوحة: لا توجد تواريخ ولا سوابق، وتعذّر إثبات موقع النشاط على الشبكة.');
      } else if (onBoundary && !hasStartBoundaryMilestone) {
        legitimateStartIds.add(activity.id);
      } else if (onBoundary) {
        openStartDefects.push(activity);
        openStartReasons.set(
          activity.id,
          `بداية مفتوحة داخلية: لا يوجد سابق رغم وجود معلم بدء المشروع على نفس حد البداية (${startBoundaryDate}).`,
        );
      } else {
        openStartDefects.push(activity);
        openStartReasons.set(
          activity.id,
          `بداية مفتوحة داخلية: لا يوجد سابق والنشاط ليس على حد بداية الشبكة (${startBoundaryDate}).`,
        );
      }
    }

    // --- successor side ---------------------------------------------------------------
    if (!hasSuccessor.has(activity.id)) {
      const onBoundary = finishBoundaryDate !== null && actFinish === finishBoundaryDate;
      if (milestone) {
        if (onBoundary) legitimateFinishIds.add(activity.id);
      } else if (actFinish === null) {
        openFinishDefects.push(activity);
        openFinishReasons.set(activity.id, 'نهاية مفتوحة: لا توجد تواريخ ولا لواحق، وتعذّر إثبات موقع النشاط على الشبكة.');
      } else if (onBoundary && !hasFinishBoundaryMilestone) {
        legitimateFinishIds.add(activity.id);
      } else if (onBoundary) {
        openFinishDefects.push(activity);
        openFinishReasons.set(
          activity.id,
          `نهاية مفتوحة داخلية: لا يوجد لاحق رغم وجود معلم الإنجاز على نفس حد النهاية (${finishBoundaryDate}).`,
        );
      } else {
        openFinishDefects.push(activity);
        openFinishReasons.set(
          activity.id,
          `نهاية مفتوحة داخلية: لا يوجد لاحق والنشاط ليس على حد نهاية الشبكة (${finishBoundaryDate}).`,
        );
      }
    }
  });

  return {
    startBoundaryDate,
    finishBoundaryDate,
    hasStartBoundaryMilestone,
    hasFinishBoundaryMilestone,
    openStartDefects,
    openFinishDefects,
    openStartReasons,
    openFinishReasons,
    legitimateStartIds,
    legitimateFinishIds,
  };
}

/**
 * The activity an open end is repaired to: the network's own boundary anchor (GAP-014).
 *
 * Preference order — the boundary milestone that owns the limit when the schedule has one, then the
 * earliest (start side) / latest (finish side) legitimate boundary activity, then the activity code
 * as a deterministic tie-break. Never an array position.
 */
export function resolveBoundaryAnchor(
  activities: Activity[],
  assessment: OpenEndAssessment,
  side: 'start' | 'finish',
): Activity | null {
  const ids = side === 'start' ? assessment.legitimateStartIds : assessment.legitimateFinishIds;
  const boundaryDate = side === 'start' ? assessment.startBoundaryDate : assessment.finishBoundaryDate;
  const dateOf = (a: Activity) =>
    (side === 'start' ? effectiveActivityStart(a) : effectiveActivityFinish(a)) || boundaryDate || '';
  const candidates = activities
    .filter((a) => ids.has(a.id))
    .sort((x, y) => {
      const xm = isMilestoneActivity(x) ? 0 : 1;
      const ym = isMilestoneActivity(y) ? 0 : 1;
      if (xm !== ym) return xm - ym;
      if (dateOf(x) !== dateOf(y)) return side === 'start' ? dateOf(x).localeCompare(dateOf(y)) : dateOf(y).localeCompare(dateOf(x));
      return String(x.code || '').localeCompare(String(y.code || ''));
    });
  return candidates[0] || null;
}

/**
 * True when adding a link `fromId -> toId` would close a loop in the existing network (or link an
 * activity to itself), so the autofix can never introduce a cycle while repairing open ends.
 */
function closesCycle(links: ActivityLink[], fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const successorsOf = new Map<string, string[]>();
  links.forEach((l) => {
    successorsOf.set(l.predecessor_id, [...(successorsOf.get(l.predecessor_id) || []), l.successor_id]);
  });
  const queue = [toId];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift() as string;
    if (current === fromId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    (successorsOf.get(current) || []).forEach((next) => queue.push(next));
  }
  return false;
}

/**
 * Project-level CPM context for the audit (GAP-015). Optional and backwards compatible: without it
 * the CPM engine falls back to its own governed defaults (`6_days`, `retained_logic`).
 */
export interface DcmaAuditOptions {
  calendarType?: CalendarType;
  statusLogic?: 'retained_logic' | 'progress_override';
}

// Phase A: `dataDate` is required — the audit never falls back to the machine clock. Every
// caller passes the governed date explicitly (`resolveDataDate(project)` or
// `project.data_date || DEFAULT_DATA_DATE`); DCMA rules below are untouched.
export function runDcma14PointAudit(
  activities: Activity[],
  links: ActivityLink[],
  baselineActivities: BaselineActivity[] = [],
  assignments: ActivityResource[] = [],
  dataDate: string,
  options: DcmaAuditOptions = {},
): DcmaAuditResult {
  if (!activities.length) {
    return {
      score: 100,
      status: 'excellent',
      points: [],
      totalPassed: 14,
      totalWarnings: 0,
      totalFailed: 0,
      summary: 'لا توجد أنشطة للفحص.',
      bei: 1.0,
      criticalPathLengthDays: 0,
    };
  }

  const nonMilestones = activities.filter((a) => !a.is_milestone);
  const totalActivitiesCount = activities.length;
  const nonMilestoneCount = Math.max(1, nonMilestones.length);
  const totalLinksCount = Math.max(1, links.length);

  const predecessorsMap = new Map<string, ActivityLink[]>();
  const successorsMap = new Map<string, ActivityLink[]>();
  links.forEach((l) => {
    predecessorsMap.set(l.successor_id, [...(predecessorsMap.get(l.successor_id) || []), l]);
    successorsMap.set(l.predecessor_id, [...(successorsMap.get(l.predecessor_id) || []), l]);
  });

  const points: DcmaPointResult[] = [];

  // Point 1: Logic (Missing Predecessors or Successors) — GAP-014
  // Open ends are resolved by `assessOpenEnds` from the network + recorded status only. No activity
  // is exempted because of where it happens to sit in the array, and a legitimate project start /
  // finish is proven by the network boundary (or by the start / finish milestone that owns it).
  const openEnds = assessOpenEnds(activities, links);
  const missingLogicActivities = new Set([
    ...openEnds.openStartDefects.map((a) => a.id),
    ...openEnds.openFinishDefects.map((a) => a.id),
  ]);
  const missingLogicPct = (missingLogicActivities.size / nonMilestoneCount) * 100;
  // Sorted by code so the note is identical no matter what order the rows arrived in (GAP-014:
  // nothing in this point may depend on array position, including its own report text).
  const legitimateBoundaryActs = activities
    .filter((a) => openEnds.legitimateStartIds.has(a.id) || openEnds.legitimateFinishIds.has(a.id))
    .slice()
    .sort((x, y) => String(x.code || '').localeCompare(String(y.code || '')));
  points.push({
    id: 1,
    name: 'Logic Links Integrity',
    nameAr: 'اكتمال الروابط المنطقية (Missing Predecessors/Successors)',
    description: 'يجب ألا تزيد نسبة الأنشطة غير المربوطة بسابق أو لاحق عن 5% (Open Starts & Finishes). يُستثنى فقط ما تثبت الشبكة أنه حد مشروع: نشاط بلا سابق يقع على حد بداية الشبكة (أقرب early/actual start) ولا يوجد معلم بدء يملك ذلك الحد، ونشاط بلا لاحق يقع على حد نهاية الشبكة (أبعد early/actual finish) ولا يوجد معلم إنجاز يملكه. لا علاقة لترتيب الصفوف في القائمة بهذا الحكم.',
    target: '≤ 5.0%',
    actualValue: `${missingLogicPct.toFixed(1)}% (${missingLogicActivities.size} نشاط مفتوح)`,
    passRatio: missingLogicPct <= 5 ? 1 : Math.max(0, 1 - (missingLogicPct - 5) / 20),
    status: missingLogicPct <= 5 ? 'pass' : missingLogicPct <= 10 ? 'warning' : 'fail',
    details: [
      ...openEnds.openStartDefects.map((a) => `النشاط [${a.code}] ${openEnds.openStartReasons.get(a.id) || 'ليس له سوابق (Open Start).'}`),
      ...openEnds.openFinishDefects.map((a) => `النشاط [${a.code}] ${openEnds.openFinishReasons.get(a.id) || 'ليس له لواحق (Open Finish).'}`),
      ...(legitimateBoundaryActs.length
        ? [`حدود الشبكة المعتمدة: البداية ${openEnds.startBoundaryDate || 'غير محددة'} · النهاية ${openEnds.finishBoundaryDate || 'غير محددة'} — أنشطة مشروعة بلا روابط لأنها تملك الحد: [${legitimateBoundaryActs.map((a) => a.code).join('، ')}].`]
        : []),
    ],
    recommendation: 'وفق معيار DCMA 14-Point، يجب ربط جميع الأنشطة المفتوحة بسابق أو لاحق منطقي (ربط البدايات بمعلم بدء المشروع، والنهايات المفتوحة بمعلم التسليم النهائي أو النشاط التالي في الحزمة).',
    autoFixType: 'fix_missing_logic',
    weight: 10,
  });

  // Point 2: Leads (Negative Lags)
  const leadLinks = links.filter((l) => Number(l.lag_days || 0) < 0);
  points.push({
    id: 2,
    name: 'Leads (Negative Lags)',
    nameAr: 'العلاقات ذات الروابط السالبة (Negative Lags / Leads)',
    description: 'يُحظر استخدام أي علاقات سالبة (Leads) لأنها تخالف المنطق الهندسي للتسلسل.',
    target: '0 علاقات',
    actualValue: `${leadLinks.length} علاقة سالبة`,
    passRatio: leadLinks.length === 0 ? 1 : 0,
    status: leadLinks.length === 0 ? 'pass' : 'fail',
    details: leadLinks.map((l) => `العلاقة بين [${l.predecessor_id}] و [${l.successor_id}] تحتوي على Lag سالب (${l.lag_days} يوم).`),
    recommendation: 'استبدال الفواصل السالبة (Leads) بعلاقات Start-to-Start (SS) مع Lag إيجابي أو تجزئة النشاط السابق لتمثيل التزامن بدقة.',
    autoFixType: 'fix_negative_lags',
    weight: 8,
  });

  // Point 3: Lags (Positive Lags)
  const positiveLagLinks = links.filter((l) => Number(l.lag_days || 0) > 0);
  const positiveLagPct = (positiveLagLinks.length / totalLinksCount) * 100;
  points.push({
    id: 3,
    name: 'Lags (Positive Lags)',
    nameAr: 'فترات التباطؤ الإيجابية (Lags > 0)',
    description: 'يجب ألا تتجاوز نسبة العلاقات ذات الـ Lag الإيجابي 5% ويُفضل استبدالها بأنشطة صريحة.',
    target: '≤ 5.0%',
    actualValue: `${positiveLagPct.toFixed(1)}% (${positiveLagLinks.length} علاقة)`,
    passRatio: positiveLagPct <= 5 ? 1 : Math.max(0, 1 - (positiveLagPct - 5) / 20),
    status: positiveLagPct <= 5 ? 'pass' : positiveLagPct <= 15 ? 'warning' : 'fail',
    details: positiveLagLinks.map((l) => `علاقة بـ Lag قدره (${l.lag_days} يوم) بين [${l.predecessor_id}] و [${l.successor_id}].`),
    recommendation: 'تحويل فترات التباطؤ الكبيرة (مثل فترات معالجة الخرسانة Curing أو استخراج التصاريح) إلى أنشطة صريحة مدرجة في الجدول بدلاً من إخفائها كـ Lag.',
    weight: 6,
  });

  // Point 4: Relationship Types (FS >= 90%, SF = 0%)
  const fsLinks = links.filter((l) => !l.link_type || l.link_type === 'FS');
  const sfLinks = links.filter((l) => l.link_type === 'SF');
  const fsPct = (fsLinks.length / totalLinksCount) * 100;
  const p4Pass = fsPct >= 90 && sfLinks.length === 0;
  points.push({
    id: 4,
    name: 'Relationship Types',
    nameAr: 'أنواع العلاقات (FS ≥ 90% و SF = 0%)',
    description: 'علاقات النهاية لبداية (FS) هي الأساس، ويجب منع علاقات البداية لنهاية (SF) نهائياً.',
    target: 'FS ≥ 90% & SF = 0',
    actualValue: `FS: ${fsPct.toFixed(1)}% | SF: ${sfLinks.length}`,
    passRatio: p4Pass ? 1 : fsPct >= 80 ? 0.7 : 0.3,
    status: p4Pass ? 'pass' : fsPct >= 75 ? 'warning' : 'fail',
    details: sfLinks.map((l) => `علاقة غير مقبولة (SF) تم اكتشافها.`),
    recommendation: 'تحويل علاقات SF الشاذة إلى علاقات FS قياسية لضمان التوافق مع بروتوكولات SCL و AACE.',
    autoFixType: 'fix_relationship_types',
    weight: 7,
  });

  // Point 5: Hard Constraints (MSO, MFO, MS, MF, SNLT, FNLT <= 5%)
  const hardConstraintTypes = ['MSO', 'MFO', 'MS', 'MF', 'SNLT', 'FNLT'];
  const hardConstrainedActs = activities.filter((a) => a.constraint_type && hardConstraintTypes.includes(a.constraint_type));
  const hardConstraintPct = (hardConstrainedActs.length / totalActivitiesCount) * 100;
  points.push({
    id: 5,
    name: 'Hard Constraints',
    nameAr: 'القيود الصارمة (Hard Constraints)',
    description: 'القيود الصارمة تشوه المسار الحرج وتخفي التأخيرات الحقيقية؛ يجب ألا تزيد عن 5%.',
    target: '≤ 5.0%',
    actualValue: `${hardConstraintPct.toFixed(1)}% (${hardConstrainedActs.length} نشاط)`,
    passRatio: hardConstraintPct <= 5 ? 1 : Math.max(0, 1 - (hardConstraintPct - 5) / 15),
    status: hardConstraintPct <= 5 ? 'pass' : hardConstraintPct <= 10 ? 'warning' : 'fail',
    details: hardConstrainedActs.map((a) => `النشاط [${a.code}] مقيد بقيد صارم (${a.constraint_type}).`),
    recommendation: 'إلغاء القيود الصارمة المانعة واستبدالها بنظام الجدولة المنطقية الخالصة (ASAP) أو قيود مرنة (SNET) للسماح بتدفق الهوامش والمسار الحرج بشكل واقعي.',
    autoFixType: 'fix_hard_constraints',
    weight: 8,
  });

  // Point 6: High Total Float (> 44 working days <= 5%)
  const highFloatActs = activities.filter((a) => !a.is_milestone && Number(a.total_float || 0) > 44);
  const highFloatPct = (highFloatActs.length / nonMilestoneCount) * 100;
  points.push({
    id: 6,
    name: 'High Total Float (> 44 Days)',
    nameAr: 'الأنشطة ذات الهامش المرتفع جداً (> 44 يوماً)',
    description: 'الهوامش الكبيرة جداً تدل على فجوات في منطق الشبكة وعدم ربط النشاط بمساره الواقعي.',
    target: '≤ 5.0%',
    actualValue: `${highFloatPct.toFixed(1)}% (${highFloatActs.length} نشاط)`,
    passRatio: highFloatPct <= 5 ? 1 : Math.max(0, 1 - (highFloatPct - 5) / 25),
    status: highFloatPct <= 5 ? 'pass' : highFloatPct <= 15 ? 'warning' : 'fail',
    details: highFloatActs.map((a) => `النشاط [${a.code}] هامشه الكلي مرتفع (${a.total_float} يوم).`),
    recommendation: 'مراجعة العلاقات اللاحقة للأنشطة ذات الهامش المرتفع وربطها بالمراحل الإنشائية المستهدفة لضبط الهامش الكلي.',
    autoFixType: 'fix_high_float',
    weight: 6,
  });

  // Point 7: Negative Total Float (0 allowed)
  const negativeFloatActs = activities.filter((a) => Number(a.total_float || 0) < 0);
  points.push({
    id: 7,
    name: 'Negative Total Float',
    nameAr: 'الأنشطة ذات الهامش السالب (Negative Float < 0)',
    description: 'وجود هوامش سالبة يعني تعطل المسار الحرج ومخالفة موعد التسليم التعاقدي.',
    target: '0 أنشطة',
    actualValue: `${negativeFloatActs.length} نشاط`,
    passRatio: negativeFloatActs.length === 0 ? 1 : 0,
    status: negativeFloatActs.length === 0 ? 'pass' : 'fail',
    details: negativeFloatActs.map((a) => `النشاط [${a.code}] لديه هامش سالب (${a.total_float} يوم).`),
    recommendation: 'تفعيل خطة التعجيل (Crashing & Fast-Tracking) أو معالجة القيود المتعارضة لإعادة الهامش إلى صفر أو قيمة موجبة.',
    autoFixType: 'fix_negative_float',
    weight: 10,
  });

  // Point 8: High Duration (> 44 working days <= 5%)
  const highDurationActs = nonMilestones.filter((a) => Number(a.duration_days || 0) > 44);
  const highDurationPct = (highDurationActs.length / nonMilestoneCount) * 100;
  points.push({
    id: 8,
    name: 'High Duration (> 44 Days)',
    nameAr: 'الأنشطة ذات المدد الطويلة جداً (> 44 يوماً)',
    description: 'الأنشطة الطويلة تصعب متابعتها ويجب تجزئتها إلى حزم عمل أصغر (WBS breakdown).',
    target: '≤ 5.0%',
    actualValue: `${highDurationPct.toFixed(1)}% (${highDurationActs.length} نشاط)`,
    passRatio: highDurationPct <= 5 ? 1 : Math.max(0, 1 - (highDurationPct - 5) / 20),
    status: highDurationPct <= 5 ? 'pass' : highDurationPct <= 12 ? 'warning' : 'fail',
    details: highDurationActs.map((a) => `النشاط [${a.code}] مدته (${a.duration_days} يوم).`),
    recommendation: 'تجزئة الأنشطة التي تتجاوز مدتها 44 يوماً عمل (أو دورتين تحديثيتين) إلى أنشطة فرعية أصغر قابلة للقياس.',
    weight: 6,
  });

  // Point 9: Invalid Dates
  const invalidDateActs = activities.filter((a) => {
    if (a.actual_start && a.actual_start > dataDate) return true;
    if (a.actual_finish && a.actual_finish > dataDate) return true;
    if (a.percent_complete < 100 && a.early_finish && a.early_finish < dataDate && !a.actual_finish) return true;
    return false;
  });
  points.push({
    id: 9,
    name: 'Invalid Dates Integrity',
    nameAr: 'صحة التواريخ بالنسبة لتاريخ المتابعة (Data Date)',
    description: 'لا يجوز وجود تواريخ فعلية في المستقبل بعد تاريخ المتابعة، أو أعمال متبقية في الماضي.',
    target: '0 أخطاء',
    actualValue: `${invalidDateActs.length} خطأ`,
    passRatio: invalidDateActs.length === 0 ? 1 : 0,
    status: invalidDateActs.length === 0 ? 'pass' : 'fail',
    details: invalidDateActs.map((a) => `النشاط [${a.code}] يحتوي على تعارض مع تاريخ المتابعة (${dataDate}).`),
    recommendation: 'إجراء تحديث للجدول انطلاقاً من خط الحالة Data Date وإعادة جدولة الأنشطة المتبقية إلى المستقبل.',
    autoFixType: 'fix_invalid_dates',
    weight: 8,
  });

  // Point 10: Resource & Cost Loading
  const assignedActivityIds = new Set(assignments.map((as) => as.activity_id));
  const unassignedActs = nonMilestones.filter((a) => !assignedActivityIds.has(a.id) && (a.planned_quantity || 0) <= 0);
  const resourceLoadingPct = ((nonMilestoneCount - unassignedActs.length) / nonMilestoneCount) * 100;
  points.push({
    id: 10,
    name: 'Resource & Cost Loading',
    nameAr: 'تحميل الموارد والكميات (Resource Loaded Schedule)',
    description: 'يجب تحميل جميع الأنشطة بالموارد البشرية أو المعدات أو الكميات التقديرية.',
    target: '100%',
    actualValue: `${resourceLoadingPct.toFixed(1)}% محملة`,
    passRatio: resourceLoadingPct / 100,
    status: resourceLoadingPct >= 90 ? 'pass' : resourceLoadingPct >= 70 ? 'warning' : 'fail',
    details: unassignedActs.map((a) => `النشاط [${a.code}] غير محمل بأي موارد أو كميات.`),
    recommendation: 'ربط أنشطة المشروع بجدول الكميات (BOQ) أو تخصيص فرق العمل والمعدات المعتمدة.',
    autoFixType: 'fix_resource_loading',
    weight: 7,
  });

  // Point 11: Critical Path Continuity — GAP-015
  //
  // The previous test counted a critical activity as "continuous" when it had ANY predecessor
  // (`predecessorsMap.has(a.id)`), which proves nothing: a predecessor whose dates do not determine
  // the successor's start leaves the critical path floating, and the stored `is_critical` flag can
  // be stale. Continuity is now evaluated on the CPM output of THIS network at THIS Data Date:
  //
  //   1. Critical population — `calculateCpm(...).results.filter(r => r.isCritical)` (total float
  //      <= 0 and not complete). When the engine reports a cycle it cannot produce results, so the
  //      point fails explicitly and names the cycle instead of falling back to a stored flag.
  //   2. Driving relationships — a link P -> S drives S when the engine's own event equation holds
  //      for its type and signed lag (FS/SS/FF/SF), i.e. `linkResults[].isDriving`. A driving
  //      successor of X is a link where X is the predecessor and `isDriving` is true.
  //   3. Test — every critical activity that is not a proven network start (see `assessOpenEnds`,
  //      the same legitimacy Point 1 uses) must have >= 1 driving predecessor, and that predecessor
  //      must itself be critical; every critical activity that is not a proven network finish must
  //      have >= 1 driving successor which is itself critical. Parallel critical paths pass as long
  //      as each activity sits on at least one fully driving route.
  //   4. Non-driving predecessors are NOT continuity: they are reported as a break with the reason
  //      (no predecessor at all / predecessors exist but none drives / the driving neighbour is off
  //      the critical path), plus a constraint note when a constraint date may have set the dates
  //      instead of the logic.
  const cpmAudit = calculateCpm(activities, links, {
    calendarType: options.calendarType,
    statusLogic: options.statusLogic,
    dataDate,
  });
  const cpmUsable = cpmAudit.cycle === null && cpmAudit.results.length > 0;
  const cpmById = new Map<string, CpmResult>(cpmAudit.results.map((r) => [r.activityId, r]));

  const drivingPredsByActivity = new Map<string, LinkDrivingResult[]>();
  const drivingSuccsByActivity = new Map<string, LinkDrivingResult[]>();
  cpmAudit.linkResults.forEach((lr) => {
    if (!lr.isDriving) return;
    drivingPredsByActivity.set(lr.successorId, [...(drivingPredsByActivity.get(lr.successorId) || []), lr]);
    drivingSuccsByActivity.set(lr.predecessorId, [...(drivingSuccsByActivity.get(lr.predecessorId) || []), lr]);
  });

  const criticalActs = cpmUsable
    ? activities.filter((a) => cpmById.get(a.id)?.isCritical)
    : activities.filter((a) => a.is_critical);

  const continuityBreaks: { activity: Activity; reasons: string[] }[] = [];
  const factualStartCriticals: Activity[] = [];
  if (cpmUsable) {
    criticalActs.forEach((activity) => {
      const reasons: string[] = [];
      // An activity that has already started owns a FACTUAL start (`actual_start`, or progress
      // recorded against it). The CPM forward pass anchors such an activity on that fact, so no
      // predecessor link can be "driving" by construction — demanding one would flag every honestly
      // updated schedule at every status update. Continuity for it is therefore evaluated from its
      // remaining work onwards: it still needs a driving critical successor, and the exemption is
      // reported instead of being silently applied.
      const startIsRecordedFact = Boolean(activity.actual_start) || Number(activity.percent_complete || 0) > 0;
      const isProvenNetworkStart = openEnds.legitimateStartIds.has(activity.id);
      const needsDrivingPred = !isProvenNetworkStart && !startIsRecordedFact;
      if (startIsRecordedFact && !isProvenNetworkStart) factualStartCriticals.push(activity);
      const needsDrivingSucc = !openEnds.legitimateFinishIds.has(activity.id);
      const drivingPreds = drivingPredsByActivity.get(activity.id) || [];
      const drivingSuccs = drivingSuccsByActivity.get(activity.id) || [];

      if (needsDrivingPred) {
        const preds = predecessorsMap.get(activity.id) || [];
        if (drivingPreds.length === 0) {
          reasons.push(preds.length === 0
            ? 'انقطاع: نشاط حرج بلا أي سابق منطقي.'
            : `انقطاع: له ${preds.length} سابق لكنها غير مُحَرِّكة (Non-Driving) — لا يوجد سابق يفرض تاريخ بدايته المبكرة وفق معادلة العلاقة ونوعها والـ Lag الموقع.`);
        } else if (!drivingPreds.some((lr) => cpmById.get(lr.predecessorId)?.isCritical)) {
          reasons.push('انقطاع: السابق المُحَرِّك ليس نشاطاً حرجاً (هامشه الكلي أكبر من صفر)، فالمسار الحرج يصل إليه من خارج المسار الحرج.');
        }
      }

      if (needsDrivingSucc) {
        const succs = successorsMap.get(activity.id) || [];
        if (drivingSuccs.length === 0) {
          reasons.push(succs.length === 0
            ? 'انقطاع: نشاط حرج بلا أي لاحق منطقي.'
            : `انقطاع: له ${succs.length} لاحق لكنها غير مُحَرِّكة (Non-Driving) — لا يوجد لاحق تفرض تواريخه استمرار المسار الحرج منه.`);
        } else if (!drivingSuccs.some((lr) => cpmById.get(lr.successorId)?.isCritical)) {
          reasons.push('انقطاع: اللاحق المُحَرِّك ليس نشاطاً حرجاً (هامشه الكلي أكبر من صفر)، فالمسار الحرج ينقطع بعد هذا النشاط.');
        }
      }

      if (reasons.length && activity.constraint_type && activity.constraint_date) {
        reasons.push(`ملاحظة: النشاط مقيّد بـ (${activity.constraint_type} @ ${activity.constraint_date})، وقد يكون القيد هو الذي حدد تاريخه بدل العلاقة المنطقية.`);
      }

      if (reasons.length) continuityBreaks.push({ activity, reasons });
    });
  }

  const criticalPathRatio = !cpmUsable
    ? 0
    : criticalActs.length === 0
      ? 1
      : (criticalActs.length - continuityBreaks.length) / criticalActs.length;
  const continuousCount = cpmUsable ? criticalActs.length - continuityBreaks.length : 0;
  points.push({
    id: 11,
    name: 'Critical Path Continuity',
    nameAr: 'استمرارية وترابط المسار الحرج (Critical Path Test)',
    description: 'يُقيَّم الترابط على العلاقات المُحَرِّكة (Driving) الناتجة من حساب CPM للشبكة عند تاريخ البيانات: كل نشاط حرج ليس بداية مشروعة للشبكة يجب أن يملك سابقاً مُحَرِّكاً حرجاً واحداً على الأقل، وكل نشاط حرج ليس نهاية مشروعة يجب أن يملك لاحقاً مُحَرِّكاً حرجاً واحداً على الأقل، مع احترام أنواع العلاقات (FS/SS/FF/SF) والـ Lag الموقع. وجود سابق غير مُحَرِّك لا يُعد دليلاً على الاتصال. يُستثنى من شرط السابق المُحَرِّك النشاط الحرج الذي بدأ فعلاً (actual_start أو نسبة إنجاز > 0) لأن بدايته فعل مسجّل لا نتيجة منطقية، وتُقاس استمراريته من عمله المتبقي (لاحق مُحَرِّك حرج)، ويُذكر هذا الاستثناء صراحة في التفاصيل.',
    target: '100% مسار متصل بعلاقات مُحَرِّكة',
    actualValue: cpmUsable
      ? `${(criticalPathRatio * 100).toFixed(0)}% مترابط (${continuousCount}/${criticalActs.length} نشاط حرج متصل بعلاقة مُحَرِّكة)`
      : '0% مترابط (تعذر حساب CPM)',
    passRatio: criticalPathRatio,
    status: criticalPathRatio >= 0.85 ? 'pass' : 'fail',
    details: !cpmUsable
      ? [`تعذر تقييم استمرارية المسار الحرج: ${cpmAudit.cycle ? `توجد حلقة علاقات دائرية بين ${cpmAudit.cycle.join(' ← ')}` : 'لا توجد نتائج CPM لهذه الشبكة'}.`]
      : criticalActs.length === 0
        ? ['لم يتم العثور على أنشطة حرجة.']
        : [
          ...continuityBreaks.map((b) => `النشاط الحرج [${b.activity.code}] ${b.reasons.join(' ')}`),
          ...(factualStartCriticals.length
            ? [`أنشطة حرجة قيد التنفيذ: بدايتها فعل مسجّل (actual start / نسبة إنجاز) وليست نتيجة علاقة منطقية، لذلك قِيّمت استمراريتها من العمل المتبقي: [${factualStartCriticals.slice().sort((x, y) => String(x.code || '').localeCompare(String(y.code || ''))).map((a) => a.code).join('، ')}].`]
            : []),
          ...(continuityBreaks.length === 0
            ? [`المسار الحرج متصل بالكامل عبر علاقات مُحَرِّكة: ${criticalActs.length} نشاط حرج من ${cpmAudit.projectEarlyStart} إلى ${cpmAudit.projectEarlyFinish}.`]
            : [`${continuityBreaks.length} انقطاع في المسار الحرج من أصل ${criticalActs.length} نشاط حرج.`]),
        ],
    recommendation: 'الحفاظ على تسلسل الأنشطة الحرجة دون انقطاع لتأكيد مسار الإنجاز الحرج للمشروع: ربط كل نشاط حرج بسابق ولاحق مُحَرِّكين (Driving) من داخل المسار الحرج نفسه، ومعالجة القيود الصارمة التي تقطع سلسلة التواريخ.',
    weight: 9,
  });

  // Point 12: Float Consistency
  const validFloats = activities.filter((a) => a.total_float !== undefined && a.total_float !== null);
  const p12Pass = validFloats.length === activities.length;
  points.push({
    id: 12,
    name: 'Critical Path Drag & Float Consistency',
    nameAr: 'اتساق حسابات الهوامش وكبح المسار الحرج (Drag)',
    description: 'التأكد من اكتمال حسابات الهوامش وقيم كبح المسار الحرج (Activity Drag) بدقة.',
    target: '100% منضبط',
    actualValue: p12Pass ? 'مكتمل ومنضبط' : 'غير مكتمل',
    passRatio: p12Pass ? 1 : 0.5,
    status: p12Pass ? 'pass' : 'warning',
    details: [],
    recommendation: 'إجراء تمرير أمامي وخلفي كامل لحساب Total Float و Free Float و Activity Drag.',
    weight: 5,
  });

  // Point 13: Baseline Execution Index (BEI)
  let baselineScheduledToFinish = 0;
  let actualFinishedOnTime = 0;

  if (baselineActivities.length > 0) {
    baselineActivities.forEach((base) => {
      if (base.early_finish <= dataDate) {
        baselineScheduledToFinish += 1;
        const currentAct = activities.find((a) => a.id === base.activity_id);
        if (currentAct && (currentAct.percent_complete === 100 || (currentAct.actual_finish && currentAct.actual_finish <= dataDate))) {
          actualFinishedOnTime += 1;
        }
      }
    });
  }

  const bei = baselineScheduledToFinish > 0 ? actualFinishedOnTime / baselineScheduledToFinish : 1.0;
  points.push({
    id: 13,
    name: 'Baseline Execution Index (BEI)',
    nameAr: 'مؤشر تنفيذ خط الأساس (BEI)',
    description: 'يقيس معدل إنجاز الأنشطة المخططة مقابل المنفذة فعلياً حتى تاريخ المتابعة.',
    target: 'BEI ≥ 0.95',
    actualValue: `${bei.toFixed(2)} (${actualFinishedOnTime} من أصل ${baselineScheduledToFinish})`,
    passRatio: Math.min(1, bei / 0.95),
    status: bei >= 0.95 ? 'pass' : bei >= 0.85 ? 'warning' : 'fail',
    details: [`تم إنجاز ${actualFinishedOnTime} نشاط من أصل ${baselineScheduledToFinish} مخطط إنجازها بحلول تاريخ المتابعة.`],
    recommendation: 'تكثيف وتيرة العمل على الأنشطة المتأخرة عن موعد خط الأساس لرفع مؤشر BEI.',
    autoFixType: 'fix_bei_execution',
    weight: 9,
  });

  // Point 14: Hit Ratio / Milestone Achievement (DCMA standard: checks milestones due on or before Data Date)
  const milestones = activities.filter((a) => a.is_milestone);
  const dueMilestones = milestones.filter((m) => m.early_finish && m.early_finish <= dataDate);
  const completedDueMilestones = dueMilestones.filter((m) => m.percent_complete === 100 || m.actual_finish);
  const milestoneRatio = dueMilestones.length > 0 ? (completedDueMilestones.length / dueMilestones.length) * 100 : 100;
  points.push({
    id: 14,
    name: 'Milestone Hit Ratio',
    nameAr: 'معدل تحقيق معالم المشروع (Milestone Hit Ratio)',
    description: 'نسبة معالم المشروع المستحقة حتى تاريخ المتابعة التي تم إنجازها في موعدها المحدد.',
    target: '≥ 90%',
    actualValue: dueMilestones.length > 0 ? `${milestoneRatio.toFixed(0)}% (${completedDueMilestones.length}/${dueMilestones.length})` : '100% (لا توجد معالم مستحقة متأخرة)',
    passRatio: milestoneRatio / 100,
    status: milestoneRatio >= 90 ? 'pass' : milestoneRatio >= 70 ? 'warning' : 'fail',
    details: milestones.map((m) => `المعلم [${m.name}]: ${m.percent_complete === 100 ? 'مكتمل' : 'قيد الانتظار لموعده التعاقدي'}`),
    recommendation: 'مراقبة المعالم الرئيسية وإصدار تنبيهات استباقية قبل حلول تواريخها.',
    autoFixType: 'fix_milestones',
    weight: 6,
  });

  // Overall Score Calculation (Weighted)
  const totalWeight = points.reduce((sum, p) => sum + p.weight, 0);
  const weightedScore = points.reduce((sum, p) => sum + p.passRatio * p.weight, 0);
  const score = Math.round((weightedScore / totalWeight) * 100);

  const totalPassed = points.filter((p) => p.status === 'pass').length;
  const totalWarnings = points.filter((p) => p.status === 'warning').length;
  const totalFailed = points.filter((p) => p.status === 'fail').length;

  const status: DcmaAuditResult['status'] =
    score >= 90 ? 'excellent' : score >= 75 ? 'acceptable' : score >= 60 ? 'poor' : 'critical';

  let summary = '';
  if (score >= 90) {
    summary = 'الجدول الزمني يتمتع بجودة ممتازة ومطابق بنسبة عالية لمعايير DCMA 14-Point العالمية.';
  } else if (score >= 75) {
    summary = 'الجدول الزمني مقبول ولكن تتوفر مقترحات تصحيح آلية لتحسين الروابط والقيود.';
  } else {
    summary = 'الجدول الزمني يحتوي على ملاحظات يوصى بتطبيق التصحيح الآلي الفوري لمعالجتها.';
  }

  return {
    score,
    status,
    points,
    totalPassed,
    totalWarnings,
    totalFailed,
    summary,
    bei,
    criticalPathLengthDays: criticalActs.reduce((sum, a) => sum + Number(a.duration_days || 0), 0),
  };
}

/**
 * Executes Automated DCMA Correction on Project Activities & Links.
 *
 * Phase B safety contract: this procedure repairs network records and recomputes CPM, but it
 * never invents evidence. It creates no fabricated Resource IDs, never rewrites Actual
 * Start/Finish, never invents completion, and never snaps planned dates onto the Data Date to
 * hide a delay. Anything that cannot be repaired safely is reported in `skipped` (with a
 * machine-readable reason) and left untouched instead of being "fixed" with invented values.
 */
export interface AutoFixSkip {
  fix: string;
  reason: 'missing_resource' | 'cannot_fix' | 'not_applicable';
  detail: string;
}
export async function autoFixDcmaIssues(
  projectId: string,
  fixType: 'all' | 'fix_missing_logic' | 'fix_hard_constraints' | 'fix_negative_lags' | 'fix_relationship_types' | 'fix_negative_float' | 'fix_high_float' | 'fix_invalid_dates' | 'fix_resource_loading' | 'fix_bei_execution' | 'fix_milestones',
  activities: Activity[],
  links: ActivityLink[],
  calendarType = '6_days'
): Promise<{ fixedCount: number; message: string; updatedActivities: Activity[]; updatedLinks: ActivityLink[]; updatedAssignments: ActivityResource[]; skipped: AutoFixSkip[] }> {
  let fixedCount = 0;
  const skipped: AutoFixSkip[] = [];
  let updatedActivities = activities.map((a) => ({ ...a }));
  let updatedLinks = links.map((l) => ({ ...l }));
  let updatedAssignments: ActivityResource[] = [];

  // Load project for data_date — resolved through the governed chronology helper
  // (`project.data_date || DEFAULT_DATA_DATE`) instead of a local literal, so the autofix clamps
  // actuals against the same Data Date every engine and screen uses (GAP-007 / Wave 11).
  const { data: projData } = await supabase.from('projects').select('*').eq('id', projectId).single();
  const dataDate = resolveDataDate(projData);

  // Load existing assignments
  const { data: currentAssignments } = await supabase.from('activity_resources').select('*').eq('project_id', projectId);
  updatedAssignments = (currentAssignments || []) as ActivityResource[];

  // 1. Fix Missing Logic (Open Start / Open Finish) — GAP-014 aligned
  //
  // Both the defect list and the anchor each defect is repaired to now come from the network, never
  // from array positions. The previous code walked the activity array and hung every unlinked row
  // off its array neighbour (`nonMilestones[i - 1]`, `nonMilestones[i + 1]`), exempting the first and
  // last rows, and then added two links between hardcoded demo identities (act-04 -> act-05 and
  // act-07 -> act-09) regardless of their dates. Array order is an artefact of import/`sort_order`,
  // so that remediation could invent relationships the schedule never implied.
  //
  // Now: Point 1's `assessOpenEnds` decides which activities are genuinely open, and each one is
  // hung FS off the network's own boundary anchor (its start-boundary milestone when the schedule
  // owns one, otherwise the activity that holds the start boundary) — exactly the remediation Point
  // 1 recommends. A link that would close a cycle is skipped rather than written.
  if (fixType === 'all' || fixType === 'fix_missing_logic' || fixType === 'fix_high_float') {
    const openEnds = assessOpenEnds(updatedActivities, updatedLinks);
    const startAnchor = resolveBoundaryAnchor(updatedActivities, openEnds, 'start');
    const finishAnchor = resolveBoundaryAnchor(updatedActivities, openEnds, 'finish');

    const repairOpenEnd = async (act: Activity, anchor: Activity | null, direction: 'predecessor' | 'successor') => {
      if (!anchor || anchor.id === act.id) return;
      const predecessorId = direction === 'predecessor' ? anchor.id : act.id;
      const successorId = direction === 'predecessor' ? act.id : anchor.id;
      const alreadyLinked = updatedLinks.some(
        (l) => l.predecessor_id === predecessorId && l.successor_id === successorId,
      );
      if (alreadyLinked || closesCycle(updatedLinks, predecessorId, successorId)) return;

      const newLink: ActivityLink = {
        id: `lnk-fix-${direction === 'predecessor' ? 'pred' : 'succ'}-${act.id.slice(0, 8)}`,
        project_id: projectId,
        predecessor_id: predecessorId,
        successor_id: successorId,
        link_type: 'FS',
        lag_days: 0,
        created_at: new Date().toISOString(),
      };
      await supabase.from('activity_links').upsert(newLink);
      updatedLinks.push(newLink);
      fixedCount++;
    };

    for (const act of openEnds.openStartDefects) {
      await repairOpenEnd(act, startAnchor, 'predecessor');
    }
    for (const act of openEnds.openFinishDefects) {
      await repairOpenEnd(act, finishAnchor, 'successor');
    }
  }

  // 2. Fix Hard Constraints (Convert to null / ASAP)
  if (fixType === 'all' || fixType === 'fix_hard_constraints') {
    const hardTypes = ['MSO', 'MFO', 'MS', 'MF', 'SNLT', 'FNLT'];
    for (const act of updatedActivities) {
      if (act.constraint_type && hardTypes.includes(act.constraint_type)) {
        await supabase.from('activities').update({
          constraint_type: null,
          constraint_date: null,
        }).eq('id', act.id);
        act.constraint_type = null;
        act.constraint_date = null;
        fixedCount++;
      }
    }
  }

  // 3. Fix Negative Lags & Positive Excessive Lags
  if (fixType === 'all' || fixType === 'fix_negative_lags') {
    for (const link of updatedLinks) {
      if (Number(link.lag_days || 0) < 0 || (fixType === 'all' && Number(link.lag_days || 0) > 0)) {
        await supabase.from('activity_links').update({
          lag_days: 0,
          link_type: 'FS',
        }).eq('id', link.id);
        link.lag_days = 0;
        link.link_type = 'FS';
        fixedCount++;
      }
    }
  }

  // 4. Fix SF Relationships
  if (fixType === 'all' || fixType === 'fix_relationship_types') {
    for (const link of updatedLinks) {
      if (link.link_type !== 'FS') {
        await supabase.from('activity_links').update({
          link_type: 'FS',
          lag_days: 0,
        }).eq('id', link.id);
        link.link_type = 'FS';
        link.lag_days = 0;
        fixedCount++;
      }
    }
  }

  // 5. Invalid Dates & Overdue Incomplete Work — DETECTION ONLY (no automatic repair).
  //
  // A previous revision "repaired" these conditions by rewriting Actual Start/Finish onto the
  // Data Date, inventing completion (percent_complete = 100 with derived actuals) for overdue
  // activities at/above 50%, and snapping early_start to the Data Date for the rest. Each of
  // those either fabricates progress evidence or erases a real delay, so Auto-Fix no longer
  // touches them: Actuals are recorded evidence and are never overwritten here, and overdue
  // work is left unresolved for an explicit planning decision (reschedule under the project's
  // own Retained Logic / Progress Override) instead of being quietly hidden. The DCMA Point
  // rules that FLAG these conditions are untouched — only the unsafe repair is removed, so
  // chronology and network logic are preserved exactly.
  if (fixType === 'all' || fixType === 'fix_invalid_dates' || fixType === 'fix_bei_execution') {
    const unfixable = updatedActivities.filter((act) => {
      if (act.actual_start && act.actual_start > dataDate) return true;
      if (act.actual_finish && act.actual_finish > dataDate) return true;
      if (act.percent_complete < 100 && act.early_finish && act.early_finish < dataDate && !act.actual_finish) return true;
      return false;
    });
    if (unfixable.length > 0) {
      skipped.push({
        fix: 'fix_invalid_dates',
        reason: 'cannot_fix',
        detail: `${unfixable.length} نشاط (تواريخ فعلية بعد خط الحالة / عمل متأخر غير مكتمل) تُرك دون تغيير: الـ Actuals سجل مثبت لا يُعاد كتابته، والتأخير الحقيقي لا يُخفى بتواريخ مختلقة — يلزم قرار تخطيط يدوي.`,
      });
    }
  }

  // 6. Fix Resource Loading (Ensure 100% of non-milestone activities have assigned resources/quantities)
  if (fixType === 'all' || fixType === 'fix_resource_loading') {
    const assignedIds = new Set(updatedAssignments.map((a) => a.activity_id));
    const { data: defaultResources } = await supabase.from('resources').select('*').eq('project_id', projectId);
    const unassignedWork = updatedActivities.filter((act) => !act.is_milestone && !assignedIds.has(act.id));
    // No valid Resource exists: record the gap and skip. A previous revision fabricated a
    // fallback assignment against a hardcoded 'res-01' ID that may not exist — inventing
    // resource assignments is forbidden, so nothing is created here.
    if (unassignedWork.length > 0 && (!defaultResources || defaultResources.length === 0)) {
      skipped.push({
        fix: 'fix_resource_loading',
        reason: 'missing_resource',
        detail: `${unassignedWork.length} نشاط بلا تخصيص موارد ولا يوجد أي Resource صالح في المشروع — لم يُنشأ أي تخصيص وهمي. عرّف الموارد أولاً ثم أعد التشغيل.`,
      });
    }
    const defaultRes = (defaultResources && defaultResources[0]) ? defaultResources[0] : null;

    for (const act of updatedActivities) {
      if (!act.is_milestone && !assignedIds.has(act.id) && defaultRes) {
        const newAssign: ActivityResource = {
          id: `ar-fix-${act.id.slice(0, 8)}`,
          project_id: projectId,
          activity_id: act.id,
          resource_id: defaultRes.id,
          planned_quantity: act.planned_quantity || 10,
          actual_quantity: act.actual_quantity || 0,
          created_at: new Date().toISOString(),
        };
        await supabase.from('activity_resources').upsert(newAssign);
        updatedAssignments.push(newAssign);
        assignedIds.add(act.id);
        fixedCount++;
      }
    }
  }

  // 7. Recalculate CPM network with the clean updated model.
  // The project's own scheduling convention (Retained Logic vs Progress Override) is honoured,
  // and CPM results are persisted verbatim: a previous revision snapped any overdue incomplete
  // activity's early_start/early_finish onto the Data Date, silently erasing real delay. That
  // snap is removed — planning truth is preserved even when it shows negative float.
  const cpm = calculateCpm(updatedActivities, updatedLinks, {
    calendarType: calendarType as any,
    dataDate: dataDate,
    statusLogic: (projData?.status_logic as 'retained_logic' | 'progress_override' | undefined) || 'retained_logic',
    calculateDrag: true,
  });

  for (const r of cpm.results) {
    // Persist the CPM engine's own floats verbatim (Final Cleanup, item 2). This used to clamp them:
    // `Math.min(totalFloat, 20)` — under a comment claiming a 44-day ceiling — rewrote genuine
    // schedule results (44, 60, 120 days of float) into a fabricated 20-day figure so the repaired
    // network would look tightly coupled. That is altering CPM output to satisfy an expectation
    // about the schedule rather than reporting the schedule. High float is a real characteristic of
    // the network: it is stored exactly as computed, and the DCMA audit is left to flag it. The
    // `Math.min(freeFloat, totalFloat)` clamp is gone with it — `calculateCpm` already derives free
    // float bounded by total float, so re-clamping could only distort a correct value.
    const actualTotalFloat = Number(r.totalFloat || 0);
    const actualFreeFloat = Number(r.freeFloat || 0);

    const actIndex = updatedActivities.findIndex((a) => a.id === r.activityId);
    // CPM early dates are persisted exactly as computed — never snapped to the Data Date.
    const finalEarlyStart = r.earlyStart;
    const finalEarlyFinish = r.earlyFinish;

    if (actIndex >= 0) {
      await supabase.from('activities').update({
        early_start: finalEarlyStart,
        early_finish: finalEarlyFinish,
        late_start: r.lateStart,
        late_finish: r.lateFinish,
        total_float: actualTotalFloat,
        free_float: actualFreeFloat,
        is_critical: r.isCritical,
        activity_drag: r.activityDrag,
      }).eq('id', r.activityId);

      updatedActivities[actIndex] = {
        ...updatedActivities[actIndex],
        early_start: finalEarlyStart,
        early_finish: finalEarlyFinish,
        late_start: r.lateStart,
        late_finish: r.lateFinish,
        total_float: actualTotalFloat,
        free_float: actualFreeFloat,
        is_critical: r.isCritical,
        activity_drag: r.activityDrag,
      };
    }
  }

  // Items left unrepaired are disclosed, never silently dropped or papered over with invented
  // values: each skipped entry carries a machine-readable reason (missing_resource / cannot_fix /
  // not_applicable) plus a human-readable detail, and the headline message names them.
  const skipNote = skipped.length > 0
    ? ` وتُرك (${skipped.length}) بند دون إصلاح تلقائي لأسباب موثقة (${skipped.map((x) => `${x.fix}: ${x.reason}`).join('، ')}) — راجع تفاصيل كل بند في نتيجة الإجراء بدل اختراع قيم بديلة.`
    : '';
  return {
    fixedCount,
    skipped,
    // The message states only what this procedure actually did (Final Cleanup, item 2). It used to
    // close with an unconditional "100% PASS", which asserted a DCMA audit result that this function
    // never runs: it repairs records and recomputes CPM, nothing more. The 14-Point assessment is
    // re-run by the audit screen on the returned model, and its real score — including any point
    // that still fails because of genuinely high float — is what gets reported there.
    message: `تم تطبيق (${fixedCount}) تصحيحاً على سجلات النموذج، ثم أعيد حساب شبكة المسار الحرج (CPM) وحُفظت نتائجه الفعلية كما هي (التواريخ والهوامش Total/Free Float بلا أي قصّ أو تعديل). لم يُشغَّل تقييم DCMA 14-Point ضمن هذا الإجراء، لذا لا تُعلَن هنا أي نتيجة اجتياز؛ النتيجة الفعلية تظهر في شاشة تدقيق DCMA بعد إعادة الحساب.${skipNote}`,
    updatedActivities,
    updatedLinks,
    updatedAssignments,
  };
}

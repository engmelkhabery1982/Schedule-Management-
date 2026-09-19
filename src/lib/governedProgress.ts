/**
 * H01 (P2A1-H01) — the governed AS-OF progress of an activity at a project Data Date.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `activities.percent_complete` (and `actual_start` / `actual_finish`) are a MATERIALISATION of the
 * approved progress history: `approve_progress_update` writes
 * `activity.percent_complete = update.percent_complete`, latest approved wins. F5 and F6 used to read
 * that materialisation directly, so any materialised value that the Data Date does not govern leaked
 * straight into the statused CPM, the earned value, and every index derived from them:
 *
 *   - an update APPROVED AFTER the Data Date still earned its value today;
 *   - a SUBMITTED / PENDING update that a view had already materialised (or that will be materialised
 *     on approval) still earned its value;
 *   - a future `actual_start` / `actual_finish` still reported the activity as started / finished.
 *
 * THE RULE ENFORCED HERE
 * ----------------------
 * The authoritative source of truth for "how far had this activity progressed as of the Data Date" is
 * the GOVERNED APPROVED PROGRESS HISTORY (`progress_updates`), not the materialised column:
 *
 *   1. Evidence = the latest `progress_updates` row for the activity with
 *      `status === 'approved'` AND a valid ISO `update_date` on or before the Data Date.
 *      Anything else is ignored: `draft` / `submitted` / `rejected` rows are unapproved, and an
 *      approved row dated after the Data Date describes a period that has not happened yet.
 *   2. When evidence exists it alone decides the as-of percent (and the as-of quantity). The
 *      materialised value is never allowed to contradict it, in either direction.
 *   3. When NO such evidence exists the activity is UNREACHED as of the Data Date: percent 0, no
 *      actual start, no actual finish. Absence of governed evidence is never converted into healthy
 *      performance, and a stored value that no approved, in-period update supports is not evidence.
 *   4. `actual_start` / `actual_finish` are chronology-guarded independently: a date that is missing,
 *      malformed, or after the Data Date is "unreached" (null), so a future actual can never make an
 *      activity report as started or finished as of today.
 *
 * ONE DEFINITION, MANY CONSUMERS
 * ------------------------------
 * `latestApprovedUpdateOnOrBefore` is the single implementation of rule 1. The historical phasing in
 * `src/lib/sCurveTimePhasing.ts` (F9.6 rule 2) delegates to it instead of running its own loop, so the
 * S-Curve's past buckets and the current Data Date read-out cannot drift apart. Nothing here reads a
 * clock: every answer is a pure function of (activity, progress history, Data Date).
 */

import { isAfterDataDate, isIsoDate } from '@/lib/chronologyGuard';
import type { Activity, ProgressUpdate } from '@/types';

/**
 * Where an activity's as-of progress came from.
 *
 * - `approved_update`       — governed evidence: an approved update inside the Data Date.
 * - `no_governed_evidence`  — NO approved update exists on or before the Data Date, whether because
 *                             the activity has no history at all or because nothing in its history
 *                             qualifies. The activity is UNREACHED as of the date: 0 %, no governed
 *                             quantity, no actual start, no actual finish.
 *
 * `no_governed_evidence` is the ONLY non-evidence state. An earlier revision carried a third value,
 * `recorded_no_governed_history`, which let a MATERIALISED column (`activities.percent_complete`,
 * `actual_quantity`, `actual_start`, `actual_finish`) stand as as-of progress whenever the activity
 * happened to have no `progress_updates` rows. That is the defect P2A1-H01 closes for good:
 * `percent_complete` is written by `approve_progress_update`, so reading it back as evidence creates
 * progress that no approved, in-period record supports — the very thing this module exists to
 * prevent. A materialised value may still be displayed for compatibility, but it is never governed
 * as-of evidence, and it never reaches F5 / F6 / EV again.
 */
export type GovernedProgressSource =
  | 'approved_update'
  | 'no_governed_evidence';

/** The governed as-of state of one activity at one Data Date. */
export interface GovernedActivityProgress {
  activityId: string;
  /** Percent complete as of the Data Date (0..100). */
  percentComplete: number;
  /** Recorded actual start, or null when it is missing, malformed, or after the Data Date. */
  actualStart: string | null;
  /** Recorded actual finish, or null when it is missing, malformed, or after the Data Date. */
  actualFinish: string | null;
  /** Quantity to date as of the Data Date. */
  actualQuantity: number;
  started: boolean;
  completed: boolean;
  source: GovernedProgressSource;
  /** The `progress_updates` row that governs this state, so a consumer can cite its evidence. */
  evidenceUpdateId: string | null;
  evidenceUpdateDate: string | null;
}

/** Progress updates grouped by activity. Every row is kept, whatever its status. */
export type ProgressHistoryIndex = Map<string, ProgressUpdate[]>;

/**
 * Index a progress history by activity id.
 *
 * Input order is preserved inside each bucket on purpose: "latest" is resolved by strict date
 * comparison (rule 1), so on an exact date tie the first row in the order the caller read it wins —
 * the same stable convention the historical phasing already used.
 */
export function indexProgressHistory(updates: readonly ProgressUpdate[]): ProgressHistoryIndex {
  const index: ProgressHistoryIndex = new Map();
  for (const u of updates) {
    if (!u || typeof u.activity_id !== 'string') continue;
    const list = index.get(u.activity_id);
    if (list) list.push(u);
    else index.set(u.activity_id, [u]);
  }
  return index;
}

/**
 * Rule 1: the governing `progress_updates` row for `activityId` at or before `cutoff`.
 *
 * Approved only, valid ISO date only, `update_date <= cutoff` only. Returns null when the history
 * holds nothing that qualifies — callers must treat that as "no evidence", never as "use today's
 * value", because doing so is exactly how a future or unapproved update used to reach F5/F6.
 */
export function latestApprovedUpdateOnOrBefore(
  index: ProgressHistoryIndex,
  activityId: string,
  cutoff: string,
): ProgressUpdate | null {
  const history = index.get(activityId);
  if (!history || history.length === 0) return null;
  let latest: ProgressUpdate | null = null;
  for (const u of history) {
    if (u.status !== 'approved') continue;
    if (!isIsoDate(u.update_date)) continue; // an undated record is not evidence
    if (isAfterDataDate(u.update_date, cutoff)) continue; // dated after the Data Date: not yet
    if (latest === null || u.update_date > (latest.update_date as string)) latest = u;
  }
  return latest;
}

function clampPct(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function numOr0(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A recorded actual date is evidence only when it is a usable ISO date inside the Data Date. */
function asOfActualDate(value: string | null | undefined, dataDate: string): string | null {
  if (!isIsoDate(value)) return null;
  return isAfterDataDate(value, dataDate) ? null : value;
}

/**
 * The governed as-of state of one activity at `dataDate`.
 *
 * Pure and clock-free. See the module header for rules 1–4.
 */
export function resolveGovernedProgress(
  activity: Activity,
  index: ProgressHistoryIndex,
  dataDate: string,
): GovernedActivityProgress {
  const activityId = activity.id;
  const evidence = latestApprovedUpdateOnOrBefore(index, activityId, dataDate);

  let percentComplete: number;
  let actualQuantity: number;
  let source: GovernedProgressSource;
  let evidenceUpdateId: string | null = null;
  let evidenceUpdateDate: string | null = null;

  if (evidence) {
    percentComplete = clampPct(evidence.percent_complete);
    // `quantity_to_date` is the cumulative figure the update records; `actual_quantity` is the
    // legacy column. Both are seeded identically, and the cumulative one is the governed reading.
    const qtd = numOr0(evidence.quantity_to_date);
    actualQuantity = qtd !== 0 ? qtd : numOr0(evidence.actual_quantity);
    source = 'approved_update';
    evidenceUpdateId = evidence.id;
    evidenceUpdateDate = evidence.update_date;
  } else {
    // NO HISTORY MEANS UNREACHED (P2A1-H01).
    //
    // No approved update exists on or before the Data Date — either the activity has no history at
    // all, or nothing in its history qualifies (unapproved, undated, or after the Data Date). In
    // every one of those cases there is no governed evidence of progress, so as of this Data Date
    // the activity is unreached: 0 %, no governed quantity, no actual start, no actual finish.
    //
    // The materialised columns are deliberately NOT consulted here. `activities.percent_complete`
    // and `activities.actual_quantity` are a materialisation of the SAME history (written by
    // `approve_progress_update`), so a value with no qualifying row behind it is unsupported
    // progress: it can be displayed, but it cannot be governed evidence and it must never reach F5,
    // F6 or earned value. Absence of evidence stays absence — it is never laundered into
    // performance, and an activity with no approved as-of record is not "partly done", it is
    // unreached.
    percentComplete = 0;
    actualQuantity = 0;
    source = 'no_governed_evidence';
  }

  // Rule 4: actuals are chronology-guarded on every path, and an unreached activity carries none.
  const unreached = source === 'no_governed_evidence';
  const actualStart = unreached ? null : asOfActualDate(activity.actual_start, dataDate);
  const actualFinish = unreached ? null : asOfActualDate(activity.actual_finish, dataDate);

  return {
    activityId,
    percentComplete,
    actualStart,
    actualFinish,
    actualQuantity,
    started: !!actualStart || percentComplete > 0,
    completed: percentComplete >= 100 || !!actualFinish,
    source,
    evidenceUpdateId,
    evidenceUpdateDate,
  };
}

/**
 * Activity clones carrying their governed as-of state.
 *
 * Only the four statused fields are rewritten (`percent_complete`, `actual_start`, `actual_finish`,
 * `actual_quantity`); every plan field — duration, dates, calendar, WBS, quantities — is inherited
 * untouched. An activity whose governed state equals its recorded state is returned by reference, so
 * the governed project is structurally identical to the recorded one whenever the record is already
 * governed (the shipped seed case), and downstream JSON snapshots cannot churn.
 *
 * Integrity auditing stays on the RECORDED rows on purpose (`checkProgressIntegrity`,
 * `checkCostIntegrity`): those findings describe what is stored, including violations such as a
 * future actual date, and must not be silenced by the governance that now keeps that date out of the
 * numbers.
 */
export function applyGovernedProgress(
  activities: readonly Activity[],
  updates: readonly ProgressUpdate[],
  dataDate: string,
): Activity[] {
  if (activities.length === 0) return [];
  const index = indexProgressHistory(updates);
  return activities.map((a) => {
    const g = resolveGovernedProgress(a, index, dataDate);
    const samePercent = g.percentComplete === (Number(a.percent_complete) || 0);
    const sameStart = g.actualStart === (a.actual_start || null);
    const sameFinish = g.actualFinish === (a.actual_finish || null);
    const sameQty = g.actualQuantity === (Number(a.actual_quantity) || 0);
    if (samePercent && sameStart && sameFinish && sameQty) return a;
    return {
      ...a,
      percent_complete: g.percentComplete,
      actual_start: g.actualStart,
      actual_finish: g.actualFinish,
      actual_quantity: g.actualQuantity,
    };
  });
}

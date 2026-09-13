/**
 * Commercial controls engine — IPC reconciliation (GAP-018), subcontract retention/cost (GAP-020)
 * and commercial chronology (GAP-021).
 *
 * Why this module exists
 * ----------------------
 * The commercial screens each carried their own arithmetic: an IPC header total that was typed in
 * independently of its itemised lines, a retention deduction hardcoded at 10% of subcontractor
 * cost, a subcontract unit rate fabricated as 70% of the client rate whenever no package matched,
 * and totals that happily counted certificates and packages dated after the governed Data Date as
 * though they had already happened. None of that is a canonical EVM/CPM/S-Curve/Earned Schedule
 * concern, so nothing here touches those engines: this module only makes the commercial layer
 * reconcile to its own itemised sources and to the governed Data Date.
 *
 * The three rules it enforces
 * ---------------------------
 * 1. A header total is either derived from its lines or explicitly flagged as a mismatch. Both
 *    numbers are never presented as if they agreed (GAP-018). A certificate with no lines is
 *    `not_itemized` — unverifiable, which is different from balanced.
 * 2. Money comes from contractual terms: retention from the package's own `retentionPercent`
 *    (never a default 10%), subcontract cost from `subcontract rate x approved executed quantity`
 *    (never 70% of the client rate). A missing rate is `unpriced` and yields N/A — no fabricated
 *    cost, no fabricated margin (GAP-020).
 * 3. A commercial record only counts as an actual when its status says it happened AND its date is
 *    on or before the Data Date. A future-dated record carrying an "approved/paid" status is
 *    reported as a contradiction and excluded, never silently counted and never silently
 *    re-dated (GAP-021).
 *
 * Rounding policy (unchanged from the existing commercial code): money to whole SAR with
 * Math.round, percentages to one decimal. Quantities are not rounded.
 */
import type { BoqItem, PaymentCertificate, SubcontractBoqItem, SubcontractPackage } from '@/types';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';

/** Half a riyal: line sums and headers are both whole-SAR rounded, so this is exact equality. */
export const MONEY_TOLERANCE = 0.5;

// ---------------------------------------------------------------------------
// GAP-021 — commercial chronology
// ---------------------------------------------------------------------------

/**
 * How a commercial record relates to the governed Data Date.
 * - `actual`                status says it happened, dated on/before the Data Date -> counts
 * - `pending`               submitted/draft/negotiated -> a claim, never an actual
 * - `planned`               forecast/planned -> never an actual
 * - `rejected`              refused -> never an actual
 * - `future_dated_actual`   status says it happened but the date is AFTER the Data Date. This is a
 *                           data contradiction: it is excluded from actual/certified totals and
 *                           surfaced, because either the date or the status is wrong.
 * - `undated_actual`        an actual status with no date at all -> cannot be placed in time, so it
 *                           is excluded and reported rather than assumed to be current.
 */
export type CommercialRecordClass =
  | 'actual'
  | 'pending'
  | 'planned'
  | 'rejected'
  | 'future_dated_actual'
  | 'undated_actual';

/** Statuses meaning "this money/quantity has happened" across the commercial record types. */
const ACTUAL_STATUSES = new Set([
  'paid',
  'approved',
  'approved_by_client',
  'certified_by_consultant',
  'certified',
]);
/** Statuses meaning "claimed, not yet accepted". */
const PENDING_STATUSES = new Set([
  'draft',
  'submitted',
  'submitted_by_contractor',
  'pending_review',
  'negotiation',
  'under_review',
]);
/** Statuses meaning "planned/forecast only". */
const PLANNED_STATUSES = new Set(['planned', 'forecast', 'upcoming']);
const REJECTED_STATUSES = new Set(['rejected', 'cancelled', 'terminated']);

export interface ChronologyAssessment {
  dataDate: string;
  recordDate: string | null;
  status: string | null;
  recordClass: CommercialRecordClass;
  isAfterDataDate: boolean;
  /** True only for `actual`: this record may enter actual / certified totals. */
  countsAsActual: boolean;
  /** Human-readable reason, in Arabic and English, for anything that is not a clean actual. */
  noteAr: string | null;
  noteEn: string | null;
}

function compareIsoDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Classify one commercial record against the governed Data Date.
 *
 * `recordDate` is whatever date makes the record an actual for its type: a certificate date, a VO
 * approval date, a subcontract item execution date or a package contract date. ISO `YYYY-MM-DD`
 * strings are compared directly, so no timezone can move a record across the cutoff.
 */
export function assessCommercialChronology(input: {
  recordDate?: string | null;
  status?: string | null;
  dataDate?: string | null;
}): ChronologyAssessment {
  const dataDate = input.dataDate || DEFAULT_DATA_DATE;
  const status = (input.status || '').trim();
  const recordDate = input.recordDate && input.recordDate.length >= 10 ? input.recordDate.slice(0, 10) : null;
  const isAfterDataDate = recordDate !== null && compareIsoDate(recordDate, dataDate) > 0;

  let recordClass: CommercialRecordClass;
  if (REJECTED_STATUSES.has(status)) recordClass = 'rejected';
  else if (PLANNED_STATUSES.has(status)) recordClass = 'planned';
  else if (PENDING_STATUSES.has(status)) recordClass = 'pending';
  else if (ACTUAL_STATUSES.has(status)) {
    if (recordDate === null) recordClass = 'undated_actual';
    else recordClass = isAfterDataDate ? 'future_dated_actual' : 'actual';
  } else {
    // Unknown status vocabulary: never treated as an actual. A future date makes it planned,
    // otherwise it stays pending — the conservative reading in both cases.
    recordClass = recordDate === null ? 'pending' : isAfterDataDate ? 'planned' : 'pending';
  }

  const notes: Record<CommercialRecordClass, [string, string] | null> = {
    actual: null,
    pending: [
      'سجل مقدم/مسودة لم يُعتمد بعد — لا يدخل في إجمالي الفعلي أو المعتمد.',
      'Submitted/draft record, not yet accepted — excluded from actual and certified totals.',
    ],
    planned: [
      'سجل مخطط/متوقع — لا يدخل في إجمالي الفعلي أو المعتمد.',
      'Planned/forecast record — excluded from actual and certified totals.',
    ],
    rejected: [
      'سجل مرفوض — لا يدخل في أي إجمالي.',
      'Rejected record — excluded from every total.',
    ],
    future_dated_actual: [
      `حالته اعتماد/صرف لكن تاريخه ${recordDate} بعد تاريخ البيانات ${dataDate} — تعارض زمني: مستبعد من الإجماليات الفعلية ويحتاج تصحيح التاريخ أو الحالة.`,
      `Status is approved/paid but the date ${recordDate} is after the Data Date ${dataDate} — chronology contradiction: excluded from actual totals until the date or the status is corrected.`,
    ],
    undated_actual: [
      'حالته اعتماد/صرف لكن بلا تاريخ — لا يمكن التحقق من وقوعه قبل تاريخ البيانات، لذلك هو مستبعد ومُبلَّغ عنه.',
      'Status is approved/paid but the record carries no date — it cannot be placed against the Data Date, so it is excluded and reported.',
    ],
  };
  const note = notes[recordClass];

  return {
    dataDate,
    recordDate,
    status: status || null,
    recordClass,
    isAfterDataDate,
    countsAsActual: recordClass === 'actual',
    noteAr: note ? note[0] : null,
    noteEn: note ? note[1] : null,
  };
}

// ---------------------------------------------------------------------------
// GAP-018 — certificate header vs itemised lines
// ---------------------------------------------------------------------------

export type ReconciliationStatus = 'balanced' | 'mismatch' | 'not_itemized';

export interface CertificateReconciliation {
  id: string;
  label: string;
  tolerance: number;

  /** Itemised lines. */
  lineCount: number;
  lineCurrentSum: number;
  lineCumulativeSum: number;

  /** Header as stored/typed. */
  headerCurrent: number;
  headerCumulative: number;
  headerPrevious: number | null;
  /** Previous implied by the lines: cumulative - current. */
  derivedPrevious: number | null;

  currentDelta: number | null;
  /** Null when the certificate's lines do not carry cumulative amounts (not itemized cumulatively). */
  cumulativeDelta: number | null;
  previousDelta: number | null;

  currentStatus: ReconciliationStatus;
  cumulativeStatus: ReconciliationStatus;
  previousStatus: ReconciliationStatus;
  /** Overall: mismatch if any part mismatches, not_itemized if there are no lines at all. */
  status: ReconciliationStatus;
  isBalanced: boolean;

  /** The value the lines support — what the screen should present when the header disagrees. */
  reconciledCurrent: number;
  reconciledCumulative: number;

  /** Deductions and net, reconciled the same way: gross before deductions, net after. */
  deductions: { retention: number; advance: number; penalty: number; other: number; total: number };
  /** Amounts added before the net (VAT on main-contract certificates). */
  additions: { vat: number; other: number; total: number };
  netHeader: number | null;
  netDerived: number | null;
  netDelta: number | null;
  netStatus: ReconciliationStatus;

  /** Retention the header actually applied, when both gross and retention are known. */
  appliedRetentionPercent: number | null;

  chronology: ChronologyAssessment;
  /** Every disagreement, spelled out. A mismatch is never hidden. */
  mismatchesAr: string[];
  mismatchesEn: string[];
}

function statusFor(delta: number | null, lineCount: number, tolerance: number): ReconciliationStatus {
  if (lineCount <= 0) return 'not_itemized';
  if (delta === null) return 'not_itemized';
  return Math.abs(delta) <= tolerance ? 'balanced' : 'mismatch';
}

/**
 * Reconcile a certificate header against its itemised lines.
 *
 * Generic on purpose: the main-contractor IPC and the subcontractor IPC carry the same commercial
 * idea with different field names, and both used to keep header totals that no line supported.
 * Invariants enforced:
 *   sum(current line amounts)    == current certificate amount
 *   sum(cumulative line amounts) == cumulative certificate amount
 *   cumulative - current         == previous certified
 *   net                          == gross - deductions
 */
export function reconcileCertificateLines(input: {
  id: string;
  label: string;
  lineCount: number;
  lineCurrentSum: number;
  lineCumulativeSum: number;
  headerCurrent: number;
  headerCumulative: number;
  headerPrevious?: number | null;
  deductions?: { retention?: number; advance?: number; penalty?: number; other?: number };
  /**
   * Amounts ADDED to the gross before the net (VAT is the modelled one on main-contract
   * certificates). Without them every VAT-bearing certificate would show a false net mismatch.
   */
  additions?: { vat?: number; other?: number };
  /**
   * False when the lines carry current-period amounts only (subcontractor certificates in this
   * model): the cumulative side is then reported as not itemized and the header stands alone for it,
   * instead of being compared against a line sum the lines do not contain.
   */
  cumulativeItemized?: boolean;
  netHeader?: number | null;
  recordDate?: string | null;
  status?: string | null;
  dataDate?: string | null;
  tolerance?: number;
}): CertificateReconciliation {
  const tolerance = input.tolerance ?? MONEY_TOLERANCE;
  const lineCount = Math.max(0, Math.round(input.lineCount || 0));
  const lineCurrentSum = Math.round(input.lineCurrentSum || 0);
  const lineCumulativeSum = Math.round(input.lineCumulativeSum || 0);
  const headerCurrent = Math.round(input.headerCurrent || 0);
  const headerCumulative = Math.round(input.headerCumulative || 0);
  const headerPrevious = input.headerPrevious === null || input.headerPrevious === undefined ? null : Math.round(input.headerPrevious);

  const cumulativeItemized = input.cumulativeItemized !== false;
  const currentDelta = lineCount > 0 ? headerCurrent - lineCurrentSum : null;
  const cumulativeDelta = lineCount > 0 && cumulativeItemized ? headerCumulative - lineCumulativeSum : null;
  const derivedPrevious = lineCount > 0 && cumulativeItemized ? lineCumulativeSum - lineCurrentSum : null;
  const previousDelta = headerPrevious !== null && derivedPrevious !== null ? headerPrevious - derivedPrevious : null;

  const currentStatus = statusFor(currentDelta, lineCount, tolerance);
  const cumulativeStatus: ReconciliationStatus =
    lineCount <= 0 || !cumulativeItemized ? 'not_itemized' : statusFor(cumulativeDelta, lineCount, tolerance);
  const previousStatus: ReconciliationStatus =
    lineCount <= 0 || !cumulativeItemized || headerPrevious === null
      ? 'not_itemized'
      : previousDelta !== null && Math.abs(previousDelta) <= tolerance
        ? 'balanced'
        : 'mismatch';

  const deductions = {
    retention: Math.round(input.deductions?.retention || 0),
    advance: Math.round(input.deductions?.advance || 0),
    penalty: Math.round(input.deductions?.penalty || 0),
    other: Math.round(input.deductions?.other || 0),
    total: 0,
  };
  deductions.total = deductions.retention + deductions.advance + deductions.penalty + deductions.other;

  const additions = {
    vat: Math.round(input.additions?.vat || 0),
    other: Math.round(input.additions?.other || 0),
    total: 0,
  };
  additions.total = additions.vat + additions.other;

  // Gross reconciles before deductions, net after them (and after the modelled additions, e.g. VAT).
  const reconciledCurrent = lineCount > 0 ? lineCurrentSum : headerCurrent;
  // When the cumulative side is not itemized the header is the only cumulative figure available, so
  // it is carried forward (and reported as not line-supported) rather than being replaced by zero.
  const reconciledCumulative = lineCount > 0 && cumulativeItemized ? lineCumulativeSum : headerCumulative;
  const netHeader = input.netHeader === null || input.netHeader === undefined ? null : Math.round(input.netHeader);
  const netDerived = netHeader !== null ? reconciledCurrent - deductions.total + additions.total : null;
  const netDelta = netHeader !== null && netDerived !== null ? netHeader - netDerived : null;
  const netStatus: ReconciliationStatus =
    netHeader === null || lineCount <= 0
      ? 'not_itemized'
      : netDelta !== null && Math.abs(netDelta) <= tolerance
        ? 'balanced'
        : 'mismatch';

  const appliedRetentionPercent =
    reconciledCurrent > 0 && deductions.retention !== 0
      ? Number(((deductions.retention / reconciledCurrent) * 100).toFixed(2))
      : reconciledCurrent > 0
        ? 0
        : null;

  const status: ReconciliationStatus =
    currentStatus === 'mismatch' || cumulativeStatus === 'mismatch' || previousStatus === 'mismatch' || netStatus === 'mismatch'
      ? 'mismatch'
      : lineCount <= 0
        ? 'not_itemized'
        : 'balanced';

  const mismatchesAr: string[] = [];
  const mismatchesEn: string[] = [];
  if (lineCount <= 0) {
    mismatchesAr.push('لا توجد بنود مفصّلة في هذه الشهادة، لذلك لا يمكن مطابقة الإجمالي مع البنود.');
    mismatchesEn.push('This certificate has no itemised lines, so the header cannot be reconciled against lines.');
  }
  if (currentStatus === 'mismatch') {
    mismatchesAr.push(`إجمالي الفترة الحالي في الترويسة ${headerCurrent} لا يساوي مجموع البنود ${lineCurrentSum} (فرق ${currentDelta}).`);
    mismatchesEn.push(`Header current amount ${headerCurrent} does not equal the sum of current line amounts ${lineCurrentSum} (delta ${currentDelta}).`);
  }
  if (cumulativeStatus === 'mismatch') {
    mismatchesAr.push(`الإجمالي التراكمي في الترويسة ${headerCumulative} لا يساوي مجموع البنود التراكمي ${lineCumulativeSum} (فرق ${cumulativeDelta}).`);
    mismatchesEn.push(`Header gross-to-date ${headerCumulative} does not equal the cumulative line sum ${lineCumulativeSum} (delta ${cumulativeDelta}).`);
  }
  if (previousStatus === 'mismatch') {
    mismatchesAr.push(`المعتمد سابقاً في الترويسة ${headerPrevious} لا يساوي التراكمي ناقص الحالي ${derivedPrevious} (فرق ${previousDelta}).`);
    mismatchesEn.push(`Header previous certified ${headerPrevious} does not equal cumulative minus current ${derivedPrevious} (delta ${previousDelta}).`);
  }
  if (netStatus === 'mismatch') {
    mismatchesAr.push(
      `صافي المستحق في الترويسة ${netHeader} لا يساوي الإجمالي المطابَق ${reconciledCurrent} ناقص المستقطعات ${deductions.total} زائد الإضافات ${additions.total} = ${netDerived} (فرق ${netDelta}).`,
    );
    mismatchesEn.push(
      `Header net payable ${netHeader} does not equal reconciled gross ${reconciledCurrent} minus deductions ${deductions.total} plus additions ${additions.total} = ${netDerived} (delta ${netDelta}).`,
    );
  }

  const chronology = assessCommercialChronology({
    recordDate: input.recordDate,
    status: input.status,
    dataDate: input.dataDate,
  });
  if (chronology.noteAr) mismatchesAr.push(chronology.noteAr);
  if (chronology.noteEn) mismatchesEn.push(chronology.noteEn);

  return {
    id: input.id,
    label: input.label,
    tolerance,
    lineCount,
    lineCurrentSum,
    lineCumulativeSum,
    headerCurrent,
    headerCumulative,
    headerPrevious,
    derivedPrevious,
    currentDelta,
    cumulativeDelta,
    previousDelta,
    currentStatus,
    cumulativeStatus,
    previousStatus,
    status,
    isBalanced: status === 'balanced',
    reconciledCurrent,
    reconciledCumulative,
    deductions,
    additions,
    netHeader,
    netDerived,
    netDelta,
    netStatus,
    appliedRetentionPercent,
    chronology,
    mismatchesAr,
    mismatchesEn,
  };
}

/** Reconcile a main-contractor IPC (PaymentCertificate) against its own items. */
export function reconcilePaymentCertificate(
  cert: PaymentCertificate,
  dataDate?: string | null,
): CertificateReconciliation {
  const items = Array.isArray(cert.items) ? cert.items : [];
  return reconcileCertificateLines({
    id: cert.id,
    label: cert.ipcNumber || cert.id,
    lineCount: items.length,
    lineCurrentSum: items.reduce((sum, item) => sum + Number(item.currentAmountSar || 0), 0),
    lineCumulativeSum: items.reduce((sum, item) => sum + Number(item.cumulativeAmountSar || 0), 0),
    headerCurrent: cert.currentGrossAmount,
    headerCumulative: cert.grossAmountToDate,
    headerPrevious: cert.previousGrossAmount,
    deductions: {
      retention: cert.retentionMoneyDeduction,
      advance: cert.advancePaymentDeduction,
      penalty: cert.penaltyDeduction,
      other: 0,
    },
    // VAT is a modelled addition on main-contract certificates, so the net reconciles with it.
    additions: { vat: cert.vatAmount, other: 0 },
    netHeader: cert.netPayableAmount,
    recordDate: cert.certificateDate,
    status: cert.status,
    dataDate,
  });
}

/**
 * Structural input for a subcontractor certificate. The shape lives here (not in a view) so the
 * engine never imports from the UI layer; PaymentCertificatesView's `SubcontractorIpc` satisfies it.
 */
export interface SubcontractorCertificateInput {
  id: string;
  ipcNumber?: string;
  subcontractorName?: string;
  certificateDate?: string | null;
  status?: string | null;
  grossAmountToDate?: number;
  currentGrossAmount?: number;
  retentionDeduction?: number;
  materialDeductions?: number;
  netPayableToSubcontractor?: number;
  items?: { subcontractorAmount?: number; quantity?: number; subcontractorRate?: number }[];
}

/**
 * Reconcile a subcontractor IPC against its lines, and check the retention it applied against the
 * contractual retention of the package it belongs to (GAP-020). `contractRetentionPercent` is the
 * package term; when it is null the retention is unspecified and the applied percentage is reported
 * without being judged.
 */
export function reconcileSubcontractorCertificate(
  ipc: SubcontractorCertificateInput,
  dataDate?: string | null,
  contractRetentionPercent?: number | null,
): CertificateReconciliation & { retentionMatchesContract: boolean | null; contractRetentionPercent: number | null } {
  const items = Array.isArray(ipc.items) ? ipc.items : [];
  // A subcontractor certificate's lines carry the current-period amount; the cumulative line sum is
  // not itemised in this model, so the cumulative side is reported as not itemized rather than
  // being compared against a number the lines do not contain.
  const lineCurrentSum = items.reduce((sum, item) => sum + Number(item.subcontractorAmount || 0), 0);
  const base = reconcileCertificateLines({
    id: ipc.id,
    label: ipc.ipcNumber || ipc.id,
    lineCount: items.length,
    lineCurrentSum,
    lineCumulativeSum: 0,
    // These lines carry current-period amounts only, so the cumulative side is reported as not
    // itemized and the header gross-to-date stands alone for it (never compared against zero).
    cumulativeItemized: false,
    headerCurrent: ipc.currentGrossAmount || 0,
    headerCumulative: ipc.grossAmountToDate || 0,
    headerPrevious: null,
    deductions: {
      retention: ipc.retentionDeduction,
      advance: 0,
      penalty: 0,
      other: ipc.materialDeductions,
    },
    netHeader: ipc.netPayableToSubcontractor,
    recordDate: ipc.certificateDate,
    status: ipc.status,
    dataDate,
  });

  const status: ReconciliationStatus =
    base.currentStatus === 'mismatch' || base.netStatus === 'mismatch'
      ? 'mismatch'
      : base.lineCount <= 0
        ? 'not_itemized'
        : 'balanced';
  const mismatchesAr = [...base.mismatchesAr];
  const mismatchesEn = [...base.mismatchesEn];
  const resolvedRetentionPercent =
    contractRetentionPercent === null || contractRetentionPercent === undefined || !Number.isFinite(contractRetentionPercent)
      ? null
      : Number(contractRetentionPercent);
  const retentionMatchesContract =
    resolvedRetentionPercent === null || base.appliedRetentionPercent === null
      ? null
      : Math.abs(base.appliedRetentionPercent - resolvedRetentionPercent) <= 0.05;
  if (retentionMatchesContract === false && resolvedRetentionPercent !== null) {
    mismatchesAr.push(
      `نسبة الاستقطاع المطبقة ${base.appliedRetentionPercent}% لا تطابق نسبة الضمان التعاقدية للباقة ${resolvedRetentionPercent}%.`,
    );
    mismatchesEn.push(
      `Applied retention ${base.appliedRetentionPercent}% does not match the package contractual retention ${resolvedRetentionPercent}%.`,
    );
  }

  return {
    ...base,
    status,
    isBalanced: status === 'balanced',
    mismatchesAr,
    mismatchesEn,
    retentionMatchesContract,
    contractRetentionPercent: resolvedRetentionPercent,
  };
}

/** Totals over a set of reconciled certificates, respecting the Data Date (GAP-021). */
export interface CertificatePortfolioSummary {
  dataDate: string;
  certifiedCount: number;
  excludedCount: number;
  /** Highest reconciled gross-to-date among records that count as actual. */
  certifiedGrossToDate: number;
  /** Sum of reconciled current amounts among records that count as actual. */
  certifiedCurrentTotal: number;
  /** Sum of reconciled current amounts among pending/planned records (forecast, not actual). */
  forecastCurrentTotal: number;
  mismatchedCount: number;
  notItemizedCount: number;
  contradictionsCount: number;
}

export function summarizeCertificates(
  reconciliations: CertificateReconciliation[],
  dataDate?: string | null,
): CertificatePortfolioSummary {
  const resolvedDataDate = dataDate || DEFAULT_DATA_DATE;
  let certifiedGrossToDate = 0;
  let certifiedCurrentTotal = 0;
  let forecastCurrentTotal = 0;
  let certifiedCount = 0;
  let excludedCount = 0;
  let mismatchedCount = 0;
  let notItemizedCount = 0;
  let contradictionsCount = 0;

  reconciliations.forEach((rec) => {
    if (rec.status === 'mismatch') mismatchedCount += 1;
    if (rec.status === 'not_itemized') notItemizedCount += 1;
    if (rec.chronology.recordClass === 'future_dated_actual' || rec.chronology.recordClass === 'undated_actual') {
      contradictionsCount += 1;
    }
    if (rec.chronology.countsAsActual) {
      certifiedCount += 1;
      certifiedGrossToDate = Math.max(certifiedGrossToDate, rec.reconciledCumulative);
      certifiedCurrentTotal += rec.reconciledCurrent;
    } else {
      excludedCount += 1;
      forecastCurrentTotal += rec.reconciledCurrent;
    }
  });

  return {
    dataDate: resolvedDataDate,
    certifiedCount,
    excludedCount,
    certifiedGrossToDate,
    certifiedCurrentTotal,
    forecastCurrentTotal,
    mismatchedCount,
    notItemizedCount,
    contradictionsCount,
  };
}

// ---------------------------------------------------------------------------
// GAP-020 — retention, cost and margin from contractual terms
// ---------------------------------------------------------------------------

export type RateStatus = 'priced' | 'unpriced';
export type MarginStatus = 'valid' | 'unpriced_subcontract' | 'unpriced_client' | 'no_actual_quantity';

/**
 * Contractual retention of a package. `null` means the contract does not specify one — which is
 * NOT 10% and NOT 0%: the deduction is unknown and must be reported as N/A (GAP-020).
 */
export function getContractRetentionPercent(pkg: Pick<SubcontractPackage, 'retentionPercent'> | null | undefined): number | null {
  if (pkg === null || pkg === undefined) return null;
  const raw = pkg.retentionPercent as number | string | null | undefined;
  // A contract that states no retention yields null: it is reported as unspecified, never coerced to
  // 0% (Number(null) === 0) and never defaulted to 10% (GAP-020).
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return value;
}

/** Retention amount from contractual terms, or null when the terms are unknown or gross is unknown. */
export function calculateRetentionAmount(gross: number | null, retentionPercent: number | null): number | null {
  if (gross === null || retentionPercent === null || !Number.isFinite(gross)) return null;
  return Math.round(gross * (retentionPercent / 100));
}

/** A subcontract rate is usable only when it is a finite number > 0. Zero is not a price. */
export function resolveRate(rate: number | null | undefined): { value: number | null; status: RateStatus } {
  const value = Number(rate);
  if (rate === null || rate === undefined || !Number.isFinite(value) || value <= 0) {
    return { value: null, status: 'unpriced' };
  }
  return { value, status: 'priced' };
}

export interface SubcontractItemCommercial {
  itemId: string;
  code: string | null;
  boqCode: string | null;
  boqItemId: string | null;
  description: string;
  unit: string;
  zoneOrScope: string | null;
  linkedActivityCode: string | null;
  /** Contractual share of the BOQ quantity assigned to this package; null when it is not recorded. */
  quotaPercent: number | null;

  assignedQuantity: number;
  executedQuantity: number;
  /** Executed quantity that counts as an actual at the Data Date (0 for planned/pending/future). */
  approvedExecutedQuantity: number;

  executionStatus: string;
  executionDate: string | null;
  chronology: ChronologyAssessment;

  subcontractRate: number | null;
  subcontractRateStatus: RateStatus;
  /** Contract amount of the assigned quantity: assigned x subcontract rate. */
  contractAmount: number | null;
  /** Executed (certifiable) amount: approved executed quantity x subcontract rate. */
  subcontractCost: number | null;

  clientRate: number | null;
  clientRateStatus: RateStatus;
  clientRateSource: 'boq' | 'package_item' | 'none';
  clientContractAmount: number | null;
  clientEarnedValue: number | null;

  margin: number | null;
  marginStatus: MarginStatus;
  progressPercent: number;
}

export type PackageValueStatus = 'balanced' | 'mismatch' | 'lump_sum' | 'not_priced';

export interface SubcontractPackageCommercials {
  packageId: string;
  code: string;
  subcontractorName: string;
  trade: string;
  status: string;
  contractDate: string | null;
  chronology: ChronologyAssessment;

  retentionPercent: number | null;
  retentionSource: 'contract' | 'not_specified';
  /** Gross certified/executed at the Data Date: sum of priced items' executed amounts. */
  grossCertified: number;
  retentionAmount: number | null;
  otherDeductions: number;
  /** gross - retention - other deductions; null while the retention terms are unknown. */
  netPayable: number | null;

  /** Header contract value as stored on the package. */
  contractValue: number | null;
  /** Sum of item contract amounts (priced items only). */
  itemizedContractSum: number | null;
  valueBasis: 'itemized' | 'lump_sum';
  valueStatus: PackageValueStatus;
  valueDelta: number | null;

  clientEquivalentValue: number | null;
  /** Client earned value of the executed quantities that count as actual at the Data Date. */
  clientEarnedValueToDate: number;
  marginToDate: number | null;
  marginPercent: number | null;
  marginStatus: MarginStatus;

  physicalProgressPercent: number;
  itemsCount: number;
  unpricedItemCount: number;
  /** Executed quantity that carries no contractual subcontract rate (reported, never priced at 70%). */
  unpricedExecutedQuantity: number;
  plannedItemCount: number;
  futureDatedItemCount: number;

  items: SubcontractItemCommercial[];
  flagsAr: string[];
  flagsEn: string[];
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute one package's commercial position from its own items and contractual terms.
 *
 * - Contract/package amount = sum of item contract amounts, unless the package is documented as a
 *   lump sum (`valueBasis: 'lump_sum'`), in which case the header stands and the item sum is shown
 *   alongside it.
 * - Executed amount = sum over items of approved executed quantity x subcontract rate.
 * - Retention = the package's contractual retention percent. Never a default.
 * - Margin = client earned value - subcontract cost, and only when both are valid.
 */
export function calculatePackageCommercials(
  pkg: SubcontractPackage,
  options: { dataDate?: string | null; boqItems?: BoqItem[]; otherDeductions?: number } = {},
): SubcontractPackageCommercials {
  const dataDate = options.dataDate || DEFAULT_DATA_DATE;
  const boqItems = Array.isArray(options.boqItems) ? options.boqItems : [];
  const items = Array.isArray(pkg.items) ? pkg.items : [];
  const flagsAr: string[] = [];
  const flagsEn: string[] = [];

  const itemCommercials: SubcontractItemCommercial[] = items.map((item: SubcontractBoqItem) => {
    const linkedBoq = item.boqItemId
      ? boqItems.find((b) => b.id === item.boqItemId)
      : boqItems.find((b) => b.code && b.code === item.boqCode);
    const subRate = resolveRate(item.subcontractRateSar);
    // The contract BOQ rate is authoritative for the client side when the item is linked to a real
    // BOQ row; otherwise the rate recorded on the subcontract item is used.
    const clientRateRaw = linkedBoq && toNumber(linkedBoq.unit_price) > 0 ? linkedBoq.unit_price : item.clientRateSar;
    const clientRate = resolveRate(clientRateRaw);
    const clientRateSource: SubcontractItemCommercial['clientRateSource'] =
      linkedBoq && toNumber(linkedBoq.unit_price) > 0 ? 'boq' : clientRate.status === 'priced' ? 'package_item' : 'none';

    const assignedQuantity = toNumber(item.assignedQuantity);
    const executedQuantity = toNumber(item.executedQuantity);
    const executionStatus = item.executionStatus || (executedQuantity > 0 ? 'approved' : 'planned');
    const chronology = assessCommercialChronology({
      recordDate: item.executionDate || null,
      status: executionStatus,
      dataDate,
    });
    const approvedExecutedQuantity = chronology.countsAsActual ? executedQuantity : 0;

    const contractAmount = subRate.status === 'priced' ? Math.round(assignedQuantity * (subRate.value as number)) : null;
    const subcontractCost =
      subRate.status === 'priced' ? Math.round(approvedExecutedQuantity * (subRate.value as number)) : null;
    const clientContractAmount =
      clientRate.status === 'priced' ? Math.round(assignedQuantity * (clientRate.value as number)) : null;
    const clientEarnedValue =
      clientRate.status === 'priced' ? Math.round(approvedExecutedQuantity * (clientRate.value as number)) : null;

    let margin: number | null = null;
    let marginStatus: MarginStatus = 'valid';
    if (approvedExecutedQuantity <= 0) marginStatus = 'no_actual_quantity';
    else if (subcontractCost === null) marginStatus = 'unpriced_subcontract';
    else if (clientEarnedValue === null) marginStatus = 'unpriced_client';
    if (marginStatus === 'valid' && subcontractCost !== null && clientEarnedValue !== null) {
      margin = clientEarnedValue - subcontractCost;
    }

    return {
      itemId: item.id,
      code: item.code || null,
      boqCode: item.boqCode || null,
      boqItemId: item.boqItemId || (linkedBoq ? linkedBoq.id : null),
      description: item.description,
      unit: item.unit,
      zoneOrScope: item.zoneOrScope || null,
      linkedActivityCode: item.linkedActivityCode || null,
      quotaPercent:
        item.quotaPercent === undefined || item.quotaPercent === null || !Number.isFinite(Number(item.quotaPercent))
          ? null
          : Number(item.quotaPercent),
      assignedQuantity,
      executedQuantity,
      approvedExecutedQuantity,
      executionStatus,
      executionDate: item.executionDate || null,
      chronology,
      subcontractRate: subRate.value,
      subcontractRateStatus: subRate.status,
      contractAmount,
      subcontractCost,
      clientRate: clientRate.value,
      clientRateStatus: clientRate.status,
      clientRateSource,
      clientContractAmount,
      clientEarnedValue,
      margin,
      marginStatus,
      progressPercent: assignedQuantity > 0 ? Number(((approvedExecutedQuantity / assignedQuantity) * 100).toFixed(1)) : 0,
    };
  });

  const grossCertified = itemCommercials.reduce((sum, item) => sum + (item.subcontractCost || 0), 0);
  const clientEarnedValueToDate = itemCommercials.reduce((sum, item) => sum + (item.clientEarnedValue || 0), 0);
  const pricedContractItems = itemCommercials.filter((item) => item.contractAmount !== null);
  const itemizedContractSum = pricedContractItems.length > 0
    ? pricedContractItems.reduce((sum, item) => sum + (item.contractAmount as number), 0)
    : null;
  const pricedClientContractItems = itemCommercials.filter((item) => item.clientContractAmount !== null);
  const clientEquivalentFromItems = pricedClientContractItems.length > 0
    ? pricedClientContractItems.reduce((sum, item) => sum + (item.clientContractAmount as number), 0)
    : null;

  const contractValueRaw = Number(pkg.totalSubcontractValueSar);
  const contractValue = Number.isFinite(contractValueRaw) && contractValueRaw > 0 ? Math.round(contractValueRaw) : null;
  const valueBasis: 'itemized' | 'lump_sum' = pkg.valueBasis === 'lump_sum' ? 'lump_sum' : 'itemized';

  let valueStatus: PackageValueStatus;
  let valueDelta: number | null = null;
  if (contractValue === null || itemizedContractSum === null) {
    valueStatus = 'not_priced';
  } else if (valueBasis === 'lump_sum') {
    valueStatus = 'lump_sum';
    valueDelta = contractValue - itemizedContractSum;
  } else {
    valueDelta = contractValue - itemizedContractSum;
    valueStatus = Math.abs(valueDelta) <= MONEY_TOLERANCE ? 'balanced' : 'mismatch';
    if (valueStatus === 'mismatch') {
      flagsAr.push(
        `قيمة الباقة ${contractValue.toLocaleString()} ر.س لا تساوي مجموع بنودها ${itemizedContractSum.toLocaleString()} ر.س (فرق ${valueDelta.toLocaleString()}).`,
      );
      flagsEn.push(
        `Package value ${contractValue} does not equal the sum of its items ${itemizedContractSum} (delta ${valueDelta}).`,
      );
    }
  }

  const retentionPercent = getContractRetentionPercent(pkg);
  const retentionAmount = calculateRetentionAmount(grossCertified, retentionPercent);
  const otherDeductions = Math.round(toNumber(options.otherDeductions));
  const netPayable = retentionAmount === null ? null : grossCertified - retentionAmount - otherDeductions;
  if (retentionPercent === null) {
    flagsAr.push('نسبة ضمان الأعمال غير محددة في عقد الباقة — المستقطع وصافي المستحق غير قابلين للحساب (N/A)، ولا تُحتسب 10% افتراضياً.');
    flagsEn.push('The package contract does not specify a retention percent — retention and net payable are N/A; no 10% default is applied.');
  }

  const marginToDate =
    grossCertified > 0 && clientEarnedValueToDate > 0 ? clientEarnedValueToDate - grossCertified : null;
  const marginStatus: MarginStatus =
    grossCertified <= 0 && clientEarnedValueToDate <= 0
      ? 'no_actual_quantity'
      : itemCommercials.some((item) => item.approvedExecutedQuantity > 0 && item.subcontractCost === null)
        ? 'unpriced_subcontract'
        : itemCommercials.some((item) => item.approvedExecutedQuantity > 0 && item.clientEarnedValue === null)
          ? 'unpriced_client'
          : marginToDate !== null
            ? 'valid'
            : 'no_actual_quantity';
  const marginPercent =
    marginToDate !== null && clientEarnedValueToDate > 0
      ? Number(((marginToDate / clientEarnedValueToDate) * 100).toFixed(1))
      : null;

  const unpricedItems = itemCommercials.filter((item) => item.subcontractRateStatus === 'unpriced');
  const unpricedExecutedQuantity = unpricedItems.reduce((sum, item) => sum + item.approvedExecutedQuantity, 0);
  if (unpricedExecutedQuantity > 0) {
    flagsAr.push(
      `يوجد ${unpricedItems.length} بند بلا سعر باطن تعاقدي بكمية منفذة معتمدة ${unpricedExecutedQuantity} — التكلفة غير مسعّرة (N/A) ولا يُستخدم تقدير 70% من سعر المالك.`,
    );
    flagsEn.push(
      `${unpricedItems.length} item(s) have no contractual subcontract rate with ${unpricedExecutedQuantity} approved executed quantity — cost is unpriced (N/A); no 70%-of-client-rate estimate is used.`,
    );
  }

  const futureDatedItems = itemCommercials.filter(
    (item) => item.chronology.recordClass === 'future_dated_actual' || item.chronology.recordClass === 'undated_actual',
  );
  futureDatedItems.forEach((item) => {
    if (item.chronology.noteAr) flagsAr.push(`${item.boqCode || item.itemId}: ${item.chronology.noteAr}`);
    if (item.chronology.noteEn) flagsEn.push(`${item.boqCode || item.itemId}: ${item.chronology.noteEn}`);
  });

  const packageChronology = assessCommercialChronology({
    recordDate: pkg.contractDate || null,
    // A package is a contract, not a payment record: 'active'/'completed' mean it is in force, so
    // the chronology check here is about the contract date versus the Data Date only.
    status: pkg.status === 'planned' ? 'planned' : pkg.status === 'terminated' ? 'terminated' : 'approved',
    dataDate,
  });
  if (packageChronology.recordClass === 'future_dated_actual') {
    flagsAr.push(
      `عقد الباقة مؤرخ ${packageChronology.recordDate} بعد تاريخ البيانات ${dataDate} بينما تحمل كميات منفذة — تعارض زمني (GAP-021).`,
    );
    flagsEn.push(
      `The package contract is dated ${packageChronology.recordDate}, after the Data Date ${dataDate}, while carrying executed quantities — chronology contradiction (GAP-021).`,
    );
  }

  const executedContractWeight = itemCommercials.reduce((sum, item) => sum + (item.contractAmount || 0), 0);
  const executedCostWeight = itemCommercials.reduce((sum, item) => sum + (item.subcontractCost || 0), 0);
  const physicalProgressPercent =
    executedContractWeight > 0 ? Number(((executedCostWeight / executedContractWeight) * 100).toFixed(1)) : 0;

  return {
    packageId: pkg.id,
    code: pkg.code || pkg.id,
    subcontractorName: pkg.subcontractorName,
    trade: pkg.trade,
    status: pkg.status,
    contractDate: pkg.contractDate || null,
    chronology: packageChronology,
    retentionPercent,
    retentionSource: retentionPercent === null ? 'not_specified' : 'contract',
    grossCertified,
    retentionAmount,
    otherDeductions,
    netPayable,
    contractValue,
    itemizedContractSum,
    valueBasis,
    valueStatus,
    valueDelta,
    clientEquivalentValue:
      Number.isFinite(Number(pkg.totalClientEquivalentValueSar)) && Number(pkg.totalClientEquivalentValueSar) > 0
        ? Math.round(Number(pkg.totalClientEquivalentValueSar))
        : clientEquivalentFromItems,
    clientEarnedValueToDate,
    marginToDate,
    marginPercent,
    marginStatus,
    physicalProgressPercent,
    itemsCount: itemCommercials.length,
    unpricedItemCount: unpricedItems.length,
    unpricedExecutedQuantity,
    plannedItemCount: itemCommercials.filter((item) => item.chronology.recordClass === 'planned' || item.chronology.recordClass === 'pending').length,
    futureDatedItemCount: futureDatedItems.length,
    items: itemCommercials,
    flagsAr,
    flagsEn,
  };
}

/** Portfolio roll-up of package commercials, with the unpriced/unknown-retention counts exposed. */
export interface SubcontractPortfolioCommercials {
  dataDate: string;
  packages: SubcontractPackageCommercials[];
  totals: {
    contractCommitment: number;
    itemizedContractSum: number;
    clientEquivalent: number;
    grossCertified: number;
    clientEarnedValue: number;
    margin: number | null;
    marginPercent: number | null;
    retentionWithheld: number | null;
    netPayable: number | null;
  };
  packagesWithUnknownRetention: number;
  packagesWithValueMismatch: number;
  unpricedItemCount: number;
  futureDatedItemCount: number;
}

export function summarizeSubcontractPortfolio(
  packages: SubcontractPackage[],
  options: { dataDate?: string | null; boqItems?: BoqItem[] } = {},
): SubcontractPortfolioCommercials {
  const dataDate = options.dataDate || DEFAULT_DATA_DATE;
  const computed = (Array.isArray(packages) ? packages : []).map((pkg) =>
    calculatePackageCommercials(pkg, { dataDate, boqItems: options.boqItems }),
  );

  const contractCommitment = computed.reduce((sum, p) => sum + (p.contractValue || 0), 0);
  const itemizedContractSum = computed.reduce((sum, p) => sum + (p.itemizedContractSum || 0), 0);
  const clientEquivalent = computed.reduce((sum, p) => sum + (p.clientEquivalentValue || 0), 0);
  const grossCertified = computed.reduce((sum, p) => sum + p.grossCertified, 0);
  const clientEarnedValue = computed.reduce((sum, p) => sum + p.clientEarnedValueToDate, 0);

  const unknownRetention = computed.filter((p) => p.retentionPercent === null);
  const retentionWithheld =
    unknownRetention.length > 0 ? null : computed.reduce((sum, p) => sum + (p.retentionAmount || 0), 0);
  const netPayable =
    unknownRetention.length > 0 ? null : computed.reduce((sum, p) => sum + (p.netPayable || 0), 0);
  const margin = grossCertified > 0 && clientEarnedValue > 0 ? clientEarnedValue - grossCertified : null;

  return {
    dataDate,
    packages: computed,
    totals: {
      contractCommitment,
      itemizedContractSum,
      clientEquivalent,
      grossCertified,
      clientEarnedValue,
      margin,
      marginPercent: margin !== null && clientEarnedValue > 0 ? Number(((margin / clientEarnedValue) * 100).toFixed(1)) : null,
      retentionWithheld,
      netPayable,
    },
    packagesWithUnknownRetention: unknownRetention.length,
    packagesWithValueMismatch: computed.filter((p) => p.valueStatus === 'mismatch').length,
    unpricedItemCount: computed.reduce((sum, p) => sum + p.unpricedItemCount, 0),
    futureDatedItemCount: computed.reduce((sum, p) => sum + p.futureDatedItemCount, 0),
  };
}

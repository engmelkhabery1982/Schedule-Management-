/**
 * F9.5 (Pilot Closure defect 1) — the governance audit's EVM pillar, as a PURE renderer.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The Controlled Pilot re-run found a screen still publishing EVM under the canonical labels
 * BAC / PV / EV / AC / SPI / CPI / EAC / TCPI / VAC that disagreed with canonical F6 by a factor of
 * three (EV 276,918 vs 755,708; CPI 0.400 vs 1.095; EAC 5,862,875 vs 2,141,689.5). The rows were
 * labelled `EVM-01/02/03`.
 *
 * They were NOT produced by `forecastTrustEngine`. F8's `analyzeForecastTrust()` already receives the
 * F6 cost strip and quotes it. The rows came from `dataGovernanceEngine`'s `GOV-EVM-01` check, which
 * called `planningEngine.calculateProjectEvmAtDataDate` directly — the secondary derivation F9.4
 * retired as a DISPLAY source but could not delete, because S6 locks its BAC precedence and other
 * callers still use it. That derivation weights each activity by the FIRST budget line matching its
 * WBS node, handed in full to every activity in that node, then re-scales to BAC and time-prorates
 * planned value. F6 earns `activityBac x percent_complete` against the approved baseline. Same BAC,
 * same AC, materially different PV/EV — and therefore different SPI/CPI/EAC/VAC.
 *
 * The pillar was migrated in place, but it could not be tested: `dataGovernanceEngine` imports
 * `@/lib/supabase`, whose real Supabase client cannot be bundled for node ESM
 * (`Dynamic require of "stream" is not supported`), so the regression harness cannot import it. The
 * row-building logic therefore lives HERE — no supabase import, no I/O, no clock — and
 * `dataGovernanceEngine` delegates to it. S18 exercises this exact function, so the test drives the
 * same code path that produces the visible EVM-01/02/03 row rather than a copy of it.
 *
 * THE RULE THIS MODULE ENFORCES
 * -----------------------------
 * Every user-facing "current value" is quoted from `CanonicalEvm` — F6's own numbers, verbatim, at
 * the governed Data Date. Nothing here recomputes an index. A secondary/legacy derivation MAY be
 * supplied, but only as `diagnostic`: it is rendered in a separately labelled comparison segment of
 * `variance`, never in `actualValue`, and never under a canonical label without its diagnostic
 * marker. That is the distinction the pilot could not see — two sets of numbers, both labelled
 * "EVM", with nothing to say which one was current.
 *
 * Monetary values are rendered at the precision F6 publishes (up to 2 decimals) rather than rounded
 * to whole riyals, so a consumer can read PV 781,871.43 back off the row and reconcile it exactly
 * against F6 instead of against a rounded approximation of it.
 */
import type { GovernanceCheckItem } from '@/lib/dataGovernanceEngine';
import type { CanonicalEvm } from '@/lib/canonicalEvm';
import type { ComprehensiveProjectEvm, EvmAcSource, EvmBacSource, EvmRatioStatus, TcpiStatus } from '@/lib/planningEngine';

/**
 * Bilingual labels for the canonical EVM data-quality metadata, so the pillar can say *where* a
 * number came from — or say that it could not be derived at all. F6 owns the values; these maps only
 * render them. (Moved here from `dataGovernanceEngine` with the pillar they belong to.)
 */
export const BAC_SOURCE_LABEL_AR: Record<EvmBacSource, string> = {
  contract_value: 'القيمة التعاقدية',
  approved_baseline: 'خط الأساس المعتمد (PMB)',
  budget_lines: 'خطوط ميزانية CBS',
  boq_items: 'جدول الكميات BOQ',
  caller_supplied: 'قيمة مُدخلة من المستدعي',
  unavailable: 'غير متاح — لا مصدر معتمد',
};
export const BAC_SOURCE_LABEL_EN: Record<EvmBacSource, string> = {
  contract_value: 'contract value',
  approved_baseline: 'approved baseline (PMB)',
  budget_lines: 'CBS budget lines',
  boq_items: 'BOQ items',
  caller_supplied: 'caller-supplied scalar',
  unavailable: 'unavailable — no authoritative source',
};
export const AC_SOURCE_LABEL_AR: Record<EvmAcSource, string> = {
  approved_cost_transactions: 'معاملات التكلفة المعتمدة',
  budget_line_actuals: 'التكاليف الفعلية المسجلة في خطوط الميزانية',
  caller_supplied: 'قيمة مُدخلة من المستدعي',
  unavailable: 'غير متاح — لا دليل تكلفة فعلية',
};
export const AC_SOURCE_LABEL_EN: Record<EvmAcSource, string> = {
  approved_cost_transactions: 'approved cost transactions',
  budget_line_actuals: 'stored budget-line actuals',
  caller_supplied: 'caller-supplied scalar',
  unavailable: 'unavailable — no actual-cost evidence',
};
export const RATIO_STATUS_LABEL_AR: Record<EvmRatioStatus, string> = {
  valid: 'قيمة مقاسة',
  empty_no_data: 'لا بيانات',
  anomalous_zero_denominator: 'مقام صفري — حالة شاذة',
};
export const TCPI_STATUS_LABEL_AR: Record<TcpiStatus, string> = {
  valid: 'قيمة مقاسة',
  undefined_zero_denominator: 'غير معرّف — لا ميزانية متبقية',
  overrun_budget_exhausted: 'غير قابل للتحقيق — استُنفدت الميزانية',
};

/** Marker that identifies the visible row as canonical F6, so no reader can mistake it for a draft. */
export const CANONICAL_EVM_ROW_MARKER = 'CANONICAL-F6';
/** Marker that identifies a segment as a secondary comparison, not the current value. */
export const DIAGNOSTIC_ROW_MARKER = 'DIAGNOSTIC-COMPARISON';

/**
 * Monetary rendering at the precision F6 publishes.
 *
 * `en-US` is pinned deliberately: the previous bare `toLocaleString()` depended on the host ICU
 * locale, so the same fact could render with different grouping in different environments and a
 * consumer could not reliably read a number back off the row. Deterministic output is a project
 * invariant, and it is what makes the visible row reconcilable against F6 to the riyal.
 */
export function formatGovernedSar(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;
}

/** A ratio is rendered only when it was actually measured; its status decides the rest. */
export function formatGovernedRatio(value: number | null, status: EvmRatioStatus): string {
  return status === 'valid' && value !== null && Number.isFinite(value)
    ? value.toFixed(3)
    : `N/A (${RATIO_STATUS_LABEL_AR[status]})`;
}

export function formatGovernedTcpi(value: number, status: TcpiStatus): string {
  return status === 'valid' && Number.isFinite(value)
    ? value.toFixed(3)
    : `N/A (${TCPI_STATUS_LABEL_AR[status]})`;
}

export interface GovernanceEvmPillarInput {
  /**
   * The canonical F6 facts at the governed Data Date — the ONLY source of user-facing current
   * values. Produced by `selectCanonicalEvm(analyzeCostControl(...))`.
   */
  canonical: CanonicalEvm;
  /**
   * Optional secondary derivation, rendered ONLY as a labelled diagnostic comparison. Supplying it
   * never changes a current value; it exists so the pillar can surface — and thereby detect —
   * exactly the divergence the pilot found.
   */
  diagnostic?: ComprehensiveProjectEvm | null;
  /** Human-readable name of the diagnostic derivation, shown next to its marker. */
  diagnosticLabel?: string;
}

/**
 * Builds the `GOV-EVM-01` (code `EVM-01/02/03`) check row.
 *
 * `actualValue` carries the canonical current values and nothing else. `variance` carries the
 * canonical SV/CV/VAC identities and, when a diagnostic was supplied and disagrees, a clearly
 * separated and clearly labelled comparison segment.
 */
export function buildGovernanceEvmCheck(input: GovernanceEvmPillarInput): GovernanceCheckItem {
  const { canonical, diagnostic = null, diagnosticLabel = 'secondary derivation' } = input;

  const bacAvailable = canonical.bacSource !== 'unavailable';
  const acAvailable = canonical.acSource !== 'unavailable';
  const evmFullyMeasured =
    bacAvailable &&
    acAvailable &&
    canonical.spiStatus === 'valid' &&
    canonical.cpiStatus === 'valid' &&
    canonical.tcpiStatus === 'valid';

  const unavailableAr = !bacAvailable
    ? 'N/A — لا يوجد مصدر معتمد لـ BAC (لا خط أساس معتمد ولا ميزانية CBS ولا جدول كميات)، لذا يتعذر اشتقاق PV/EV وأي مؤشر أداء'
    : !acAvailable
      ? 'N/A — لا يوجد دليل تكلفة فعلية (لا معاملات معتمدة ولا تكاليف فعلية مسجلة)، لذا CPI غير قابل للقياس'
      : '';
  const unavailableEn = !bacAvailable
    ? 'N/A — no authoritative BAC source (no approved baseline, CBS budget or BOQ), so PV/EV and every index are unavailable'
    : !acAvailable
      ? 'N/A — no actual-cost evidence (no approved transactions, no stored budget actuals), so CPI is not measurable'
      : '';

  // The visible current-value row. Every figure is a verbatim quote of canonical F6.
  const canonicalRow = `عند ${canonical.dataDate}: BAC ${formatGovernedSar(canonical.bac)} (${BAC_SOURCE_LABEL_AR[canonical.bacSource]})`
    + ` | PV ${formatGovernedSar(canonical.pv)}`
    + ` | EV ${formatGovernedSar(canonical.ev)}`
    + ` | AC ${formatGovernedSar(canonical.ac)} (${AC_SOURCE_LABEL_AR[canonical.acSource]})`
    + ` | SPI ${formatGovernedRatio(canonical.spi, canonical.spiStatus)}`
    + ` | CPI ${formatGovernedRatio(canonical.cpi, canonical.cpiStatus)}`
    + ` | ETC ${formatGovernedSar(canonical.etc)}`
    + ` | EAC ${formatGovernedSar(canonical.eac)}`
    + ` | VAC ${formatGovernedSar(canonical.vac)}`
    + ` | TCPI ${formatGovernedTcpi(canonical.tcpi, canonical.tcpiStatus)}`;

  const canonicalVariance = bacAvailable
    ? `SV = EV - PV = ${formatGovernedSar(canonical.sv)} · CV = EV - AC = ${acAvailable ? formatGovernedSar(canonical.cv) : 'N/A'} · VAC = BAC - EAC = ${acAvailable ? formatGovernedSar(canonical.vac) : 'N/A'}`
    : 'N/A (لا توجد قيم مالية قابلة للمقارنة)';

  // A diagnostic comparison is rendered ONLY when it actually disagrees with canonical F6. When the
  // two agree there is nothing to reconcile and no second set of numbers to confuse the reader with.
  const diagnosticDiffers = diagnostic !== null && (
    diagnostic.ev !== canonical.ev
    || diagnostic.pv !== canonical.pv
    || diagnostic.bac !== canonical.bac
    || diagnostic.ac !== canonical.ac
    || diagnostic.cpi !== canonical.cpi
    || diagnostic.spi !== canonical.spi
    || diagnostic.eac !== canonical.eac
    || diagnostic.vac !== canonical.vac
  );
  const diagnosticSegment = diagnosticDiffers && diagnostic
    ? ` || ${DIAGNOSTIC_ROW_MARKER} — مقارنة تشخيصية بـ ${diagnosticLabel} (ليست القيمة الحالية / NOT the current value):`
      + ` BAC ${formatGovernedSar(diagnostic.bac)}`
      + ` | PV ${formatGovernedSar(diagnostic.pv)}`
      + ` | EV ${formatGovernedSar(diagnostic.ev)}`
      + ` | AC ${formatGovernedSar(diagnostic.ac)}`
      + ` | SPI ${formatGovernedRatio(diagnostic.spi, diagnostic.spiStatus)}`
      + ` | CPI ${formatGovernedRatio(diagnostic.cpi, diagnostic.cpiStatus)}`
      + ` | EAC ${formatGovernedSar(diagnostic.eac)}`
      + ` | VAC ${formatGovernedSar(diagnostic.vac)}`
      + ' — الفرق يُظهر أن الاشتقاق الثانوي لا يوافق F6 القانوني، والقيمة الحالية أعلاه هي المعتمدة.'
    : '';

  return {
    id: 'GOV-EVM-01',
    pillar: 'evm_math',
    pillarNameAr: 'الدقة الرياضية للقيمة المكتسبة (EVM Mathematics)',
    pillarNameEn: 'Earned Value Mathematical Rigor & Law of Conservation',
    code: 'EVM-01/02/03',
    titleAr: 'انضباط معادلات EVM المشتقة من المحرك القانوني F6 (EV, PV, AC, SPI, CPI, ETC, EAC, TCPI)',
    titleEn: 'Strict PMI EVM Compliance Quoted from Canonical F6, with Honest N/A',
    descriptionAr: 'التحقق من أن مؤشرات الأداء (SPI/CPI) وتوقعات الإنجاز (ETC/EAC/VAC/TCPI) مقتبسة من تقرير F6 القانوني عند تاريخ البيانات المعتمد — لا مُعاد اشتقاقها — وأن كل مدخل غير متاح يُعلن صراحة (N/A) بدل اختلاقه.',
    descriptionEn: 'Validates that performance indices (SPI/CPI) and forecasts (ETC/EAC/VAC/TCPI) are QUOTED from the canonical F6 cost-control report at the governed Data Date — never re-derived — and that every unavailable input is declared N/A instead of being invented.',
    severity: 'critical',
    // Status semantics are unchanged from the pre-F9.5 pillar: it reports whether the canonical
    // facts were measurable. A diagnostic disagreement is surfaced in `variance`, not scored here,
    // so this fix cannot move the audit's overall score for an unrelated reason.
    status: evmFullyMeasured ? 'passed' : 'warning',
    expectedValue: `SPI = EV/PV · CPI = EV/AC · EAC = BAC/CPI · TCPI = (BAC-EV)/(BAC-AC)، مع BAC من مصدر معتمد (${BAC_SOURCE_LABEL_EN[canonical.bacSource]}) وAC من دليل تكلفة مسجل (${AC_SOURCE_LABEL_EN[canonical.acSource]}) — all quoted from canonical F6 (${canonical.source})`,
    actualValue: evmFullyMeasured || bacAvailable
      ? `${CANONICAL_EVM_ROW_MARKER} ${canonicalRow}`
      : `${CANONICAL_EVM_ROW_MARKER} ${unavailableAr} (${unavailableEn})`,
    variance: `${canonicalVariance}${diagnosticSegment}`,
    impactAr: 'تقديم تقارير أداء ومؤشرات دقيقة لا تقبل التشكيك أمام مجلس الإدارة والممولين، من مصدر قانوني واحد (F6).',
    impactEn: 'Delivers unassailable financial performance reports to Executive Board and stakeholders, quoted from a single canonical source (F6).',
  };
}

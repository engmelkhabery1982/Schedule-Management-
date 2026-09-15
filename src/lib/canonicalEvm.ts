/**
 * F9.4 (Controlled Pilot defect 1) — the canonical EVM read-out.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The Controlled Pilot showed the SAME project at the SAME governed Data Date reporting two
 * materially different sets of financial facts:
 *
 *   F6 Cost Control        EV 755,708   CPI 1.095   EAC 2,141,689.5
 *   F8 / Executive Report  EV 276,918   CPI 0.400   EAC 5,862,875
 *
 * The cause was not a display bug and not a rounding difference: two independent EVM derivations
 * were live at once.
 *
 *   1. `costControlEngine.analyzeCostControl` (F6) — the canonical cost-control layer. It allocates
 *      each activity's budget from the APPROVED BASELINE (`baseline_activities.planned_cost`, i.e.
 *      the PMB), falling back to activity-direct budget lines; it prorates PV over working days of
 *      the baseline window; and it earns EV from the recorded/approved physical percent.
 *   2. `planningEngine.calculateProjectEvmAtDataDate` — a second, competing derivation. It resolves
 *      an activity's cost with `budgetLines.find(b => b.wbs_node_id === act.wbs_node_id)`, i.e. the
 *      FIRST budget line of the WBS node, handed IN FULL to EVERY activity in that node (so a node
 *      with two lines and four activities is weighted by one line, four times over), then rescales
 *      the lot to BAC. It additionally multiplies the recorded percent by an elapsed-time ratio for
 *      activities that have not passed their planned finish.
 *
 * On the pilot dataset every BAC source coincided (2,345,150), so BAC and AC agreed, but the cost
 * WEIGHTING did not: the completed excavation/concrete activity carrying 323,150 of baseline budget
 * was weighted at 42,000, while two not-started activities absorbed 1,152,800 each. Earned value
 * therefore collapsed from 752,900 to 275,358, CPI from 1.091 to 0.40, and EAC from 2,149,542 to
 * 5,862,875 — the exact pair of numbers the pilot reported.
 *
 * THE RULE ENFORCED HERE
 * ----------------------
 * F6 is canonical for the cost-control layer, so F6's published project EVM block IS the single
 * source of truth for BAC / PV / EV / AC / CPI / SPI / ETC / EAC / VAC at a governed Data Date.
 * Every reporting surface QUOTES it through this module:
 *
 *   - F8 forecast trust already quotes `f6.project.*` and never recomputes (unchanged).
 *   - Executive Report, Dashboard, BudgetView, ProgressView and PortfolioView now quote through
 *     `selectCanonicalEvm` instead of running the competing derivation.
 *
 * `selectCanonicalEvm` performs NO arithmetic of its own on the money facts: it copies F6's values
 * verbatim, including F6's own rounding (CPI/SPI at 3 decimals, EAC from the recommended method of
 * F6's EAC ledger). Re-deriving them here — even with the shared `assessEvmRatios` formula set —
 * would reintroduce exactly the drift this module exists to prevent, because `assessEvmRatios`
 * rounds CPI to 2 decimals and computes EAC as `BAC / CPI`, whereas F6's EAC is the value of the
 * RECOMMENDED method in its ledger. The only fields derived locally are ones F6 does not publish at
 * project level (TCPI and the two progress percentages), and TCPI comes from `assessEvmRatios` so
 * the single formula set remains its only producer.
 *
 * Nulls are preserved. F6 reports `null` where a figure is not measurable (no authorized BAC, no
 * measured index, no applicable EAC method); that is the governed N/A state and it must survive to
 * the UI rather than being laundered into a plausible-looking 0.
 */
import type { CostControlReport } from '@/lib/costControlEngine';
import {
  assessEvmRatios,
  RATIO_ANOMALY_VALUE,
  RATIO_EMPTY_STATE_VALUE,
  TCPI_UNACHIEVABLE_SENTINEL,
  type ComprehensiveProjectEvm,
  type EvmAcSource,
  type EvmBacSource,
  type EvmRatioStatus,
  type TcpiStatus,
} from '@/lib/planningEngine';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';

/**
 * Provenance marker for a canonical EVM read-out. Any screen that shows BAC/PV/EV/AC/CPI/SPI/ETC/
 * EAC/VAC under those names must be able to state that it quoted F6; a value carrying a different
 * provenance is by definition a different metric and must be labelled as such.
 */
export const CANONICAL_EVM_SOURCE = 'f6_cost_control' as const;
export type CanonicalEvmSource = typeof CANONICAL_EVM_SOURCE;

/**
 * Canonical EVM facts at a governed Data Date — a verbatim quote of the F6 cost-control report.
 *
 * Every money/index field is nullable exactly where F6 is nullable, so "not measurable" is
 * distinguishable from "measured zero".
 */
export interface CanonicalEvm {
  /** Always `CANONICAL_EVM_SOURCE`: these facts were quoted from F6, never recomputed. */
  source: CanonicalEvmSource;
  dataDate: string;
  bac: number | null;
  bacSource: EvmBacSource;
  /** F6's own note explaining the BAC basis — surfaced so a report can state its budget authority. */
  bacNote: string | null;
  pv: number | null;
  ev: number | null;
  ac: number;
  acSource: EvmAcSource;
  acCount: number;
  cv: number | null;
  sv: number | null;
  cpi: number | null;
  cpiStatus: EvmRatioStatus;
  spi: number | null;
  spiStatus: EvmRatioStatus;
  etc: number | null;
  eac: number | null;
  vac: number | null;
  tcpi: number;
  tcpiStatus: TcpiStatus;
  /** EV / BAC * 100 — null when BAC or EV is not measurable. */
  earnedProgressPercent: number | null;
  /** PV / BAC * 100 — null when BAC or PV is not measurable. */
  plannedProgressPercent: number | null;
  /** Which EAC method F6 recommended, so a report can name the forecast basis it is quoting. */
  eacMethod: string | null;
}

/** F6 BAC basis -> the canonical source vocabulary shared with the EVM engine's metadata. */
function mapBacSource(report: CostControlReport): EvmBacSource {
  switch (report.bac.source) {
    case 'baseline':
      return 'approved_baseline';
    case 'budget_lines':
      return 'budget_lines';
    case 'contract_value_explicit':
      return 'contract_value';
    default:
      return 'unavailable';
  }
}

/** F6 AC basis -> the canonical source vocabulary. */
function mapAcSource(report: CostControlReport): EvmAcSource {
  return report.project.acSource === 'approved_transactions'
    ? 'approved_cost_transactions'
    : 'unavailable';
}

/**
 * The documented zero-denominator policy of the canonical formula set, applied to a QUOTED ratio.
 *
 * F6 publishes `null` when an index is not measurable. The status says why, so the UI can render
 * N/A with a reason instead of a healthy-looking 1.0 — the same distinction `assessEvmRatios`
 * draws, evaluated against the same numerator/denominator evidence.
 */
function ratioStatus(numerator: number | null, denominator: number | null): EvmRatioStatus {
  if (denominator !== null && denominator > 0) return 'valid';
  return numerator !== null && numerator > 0 ? 'anomalous_zero_denominator' : 'empty_no_data';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Quote the canonical EVM facts from an F6 cost-control report.
 *
 * `null` in, empty canonical out: a screen with no project (and therefore no F6 report) gets the
 * explicit all-N/A state rather than a fabricated budget or a synthetic index. Nothing here reads a
 * clock, so the result is a pure function of the report it is given.
 */
export function selectCanonicalEvm(report: CostControlReport | null): CanonicalEvm {
  if (!report) return EMPTY_CANONICAL_EVM;

  const { bac, pv, ev, ac, cv, sv, cpi, spi, etc, eac, vac } = report.project;
  const bacValue = bac;

  // TCPI is the one index F6 does not publish at project level. It is taken from the single shared
  // formula set rather than re-implemented here; only `tcpi`/`tcpiStatus` are read off it.
  const ratios = assessEvmRatios(bacValue ?? 0, pv ?? 0, ev ?? 0, ac);

  return {
    source: CANONICAL_EVM_SOURCE,
    dataDate: report.dataDate,
    bac: bacValue,
    bacSource: mapBacSource(report),
    bacNote: report.bac.note,
    pv,
    ev,
    ac,
    acSource: mapAcSource(report),
    acCount: report.project.acCount,
    cv,
    sv,
    cpi,
    cpiStatus: ratioStatus(ev, ac),
    spi,
    spiStatus: ratioStatus(ev, pv),
    etc,
    eac,
    vac,
    tcpi: ratios.tcpi,
    tcpiStatus: ratios.tcpiStatus,
    earnedProgressPercent:
      bacValue !== null && bacValue > 0 && ev !== null ? round1((ev / bacValue) * 100) : null,
    plannedProgressPercent:
      bacValue !== null && bacValue > 0 && pv !== null ? round1((pv / bacValue) * 100) : null,
    eacMethod: report.recommended ? report.recommended.method : null,
  };
}

/**
 * The explicit all-N/A canonical state: no project, no F6 report, no measurable anything.
 *
 * Deliberately carries no zeros that could read as measured performance — `ac` is 0 because F6's
 * own contract types AC as a non-nullable number (0 recorded spend), and every ratio is flagged
 * `empty_no_data` so consumers render N/A.
 */
export const EMPTY_CANONICAL_EVM: CanonicalEvm = {
  source: CANONICAL_EVM_SOURCE,
  dataDate: DEFAULT_DATA_DATE,
  bac: null,
  bacSource: 'unavailable',
  bacNote: null,
  pv: null,
  ev: null,
  ac: 0,
  acSource: 'unavailable',
  acCount: 0,
  cv: null,
  sv: null,
  cpi: null,
  cpiStatus: 'empty_no_data',
  spi: null,
  spiStatus: 'empty_no_data',
  etc: null,
  eac: null,
  vac: null,
  // Matches `assessEvmRatios(0, 0, 0, 0)` exactly: with no remaining budget the required efficiency
  // is undefined, so the documented sentinel is reported alongside the explicit status rather than a
  // healthy-looking 1.0.
  tcpi: TCPI_UNACHIEVABLE_SENTINEL,
  tcpiStatus: 'undefined_zero_denominator',
  earnedProgressPercent: null,
  plannedProgressPercent: null,
  eacMethod: null,
};

/**
 * Adapter for engines that require the non-nullable `ComprehensiveProjectEvm` shape (S-curve,
 * earned schedule, control health, alerts, recovery, budget forecast).
 *
 * This is a SHAPE adapter, not a second derivation: every value is the canonical one quoted from
 * F6. Where F6 says "not measurable" (`null`) the adapter substitutes the same documented
 * compatibility values `assessEvmRatios` uses for undefined cases and keeps the status field
 * authoritative, so a consumer that checks `cpiStatus`/`spiStatus`/`tcpiStatus` still renders N/A
 * instead of presenting the substitute as performance.
 *
 * New code should prefer `selectCanonicalEvm` directly, which preserves the nulls.
 */
export function canonicalEvmToComprehensive(canonical: CanonicalEvm): ComprehensiveProjectEvm {
  const bac = canonical.bac ?? 0;
  const pv = canonical.pv ?? 0;
  const ev = canonical.ev ?? 0;
  const ac = canonical.ac;

  const cpi =
    canonical.cpi !== null
      ? canonical.cpi
      : canonical.cpiStatus === 'empty_no_data'
        ? RATIO_EMPTY_STATE_VALUE
        : RATIO_ANOMALY_VALUE;
  const spi =
    canonical.spi !== null
      ? canonical.spi
      : canonical.spiStatus === 'empty_no_data'
        ? RATIO_EMPTY_STATE_VALUE
        : RATIO_ANOMALY_VALUE;

  return {
    bac,
    bacSource: canonical.bacSource,
    acSource: canonical.acSource,
    dataDate: canonical.dataDate,
    earnedProgressPercent: canonical.earnedProgressPercent ?? 0,
    plannedProgressPercent: canonical.plannedProgressPercent ?? 0,
    pv,
    ev,
    ac,
    sv: canonical.sv ?? ev - pv,
    cv: canonical.cv ?? ev - ac,
    spi,
    spiStatus: canonical.spiStatus,
    cpi,
    cpiStatus: canonical.cpiStatus,
    // F6 reports N/A when no EAC method applies; the compatibility fallback is BAC, matching the
    // canonical formula set's own "CPI not measured" behaviour. `eacMethod === null` tells a
    // consumer the figure is a fallback rather than a recommended forecast.
    eac: canonical.eac ?? bac,
    etc: canonical.etc ?? Math.max(0, (canonical.eac ?? bac) - ac),
    vac: canonical.vac ?? bac - (canonical.eac ?? bac),
    tcpi: canonical.tcpi,
    tcpiStatus: canonical.tcpiStatus,
  };
}

/**
 * Convenience for a reporting surface that already holds an F6 report and needs the legacy
 * non-nullable shape: quote the canonical facts, then adapt. One call, one source, no arithmetic.
 */
export function quoteCanonicalEvm(report: CostControlReport | null): ComprehensiveProjectEvm {
  return canonicalEvmToComprehensive(selectCanonicalEvm(report));
}

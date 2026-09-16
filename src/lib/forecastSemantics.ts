/**
 * F9.6 (Cross-Surface Control Reconciliation) — governed SEMANTICS for forecast presentation.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Several legitimate models answer the same question in different ways, and the screens showed them
 * with labels that made them look like one canonical fact:
 *
 *   - Two EACs: canonical F6 `Recommended EAC` (method `eac_cpi`) and a statistical risk-adjusted EAC
 *     (SPI/CPI trend + open-risk exposure). Both are valid forecasts; presenting either as simply "EAC"
 *     inside a block whose other cards are canonical makes them look like competing definitions.
 *   - Two finish dates: the canonical F5 statused-CPM forecast finish (the management date) and an
 *     SPI-trend + risk-adjusted statistical finish. Valid, different models — but a card reading
 *     "Forecast Completion" next to canonical PV/EV/SPI cards reads as *the* delivery date.
 *   - Two ratios in one card: "SPI / CPI" rendered as two bare numbers under one slash label. The
 *     values were not actually transposed in code, but nothing in the markup bound each number to its
 *     own label, so a reader could not tell which was which — and a future edit could swap them
 *     silently.
 *
 * THE RULE ENFORCED HERE
 * ----------------------
 *  1. An UNQUALIFIED label ("EAC", "Forecast Finish", "management finish") always denotes the
 *     CANONICAL value: F6 for cost, F5 for schedule.
 *  2. A scenario / statistical / risk value always carries an explicit non-canonical qualifier AND its
 *     authority, and always reports its delta or variance against the canonical value.
 *  3. The canonical value is never overwritten by the scenario value, and the two are never presented
 *     as equally authoritative: `authority` is part of the data, not a styling choice.
 *  4. A label and its value travel together in ONE object. Reordering a rendered list therefore cannot
 *     mislabel a number — there is no positional coupling left to get wrong.
 *
 * This module contains no forecast maths of its own and reads no clock. It names, pairs and differences
 * values that F5 / F6 / the statistical model already produced. Boundary: `@/lib/forecastReconciliation`
 * (GAP-041) reconciles a DIFFERENT pair — CPM deterministic early finish vs the Earned Schedule IEAC(t)
 * trend — for the Executive Report; nothing here duplicates or replaces it.
 */

/** Authority tags. Part of the data model so a surface cannot present a scenario value as canonical. */
export const CANONICAL_COST_AUTHORITY = 'canonical_f6_cost_control';
export const SCENARIO_COST_AUTHORITY = 'scenario_risk_adjusted';
export const CANONICAL_SCHEDULE_AUTHORITY = 'canonical_f5_schedule_control';
export const STATISTICAL_SCHEDULE_AUTHORITY = 'statistical_spi_trend_plus_risk';

/**
 * The unqualified cost label. Anywhere a screen says only this, the value MUST be canonical F6 EAC.
 * Regression S19-K pins the mapping; the scenario label below must never equal it.
 */
export const UNQUALIFIED_EAC_LABEL_EN = 'EAC';
export const UNQUALIFIED_EAC_LABEL_AR = 'التكلفة المتوقعة عند الإنجاز (EAC)';

/** The unqualified management finish label — always the canonical F5 forecast finish (S19-N). */
export const UNQUALIFIED_FINISH_LABEL_EN = 'Forecast Finish';
export const UNQUALIFIED_FINISH_LABEL_AR = 'النهاية المتوقعة';

/** Structural view of the canonical F6 quote (`CanonicalEvm` satisfies this; kept decoupled on purpose). */
export interface CanonicalEvmQuote {
  bac: number | null;
  pv: number | null;
  ev: number | null;
  ac: number;
  cpi: number | null;
  cpiStatus?: string;
  spi: number | null;
  spiStatus?: string;
  etc: number | null;
  eac: number | null;
  vac: number | null;
  dataDate?: string;
}

/** One ratio, with its own label, formula and authority. Swapping array order cannot mislabel it. */
export interface LabelledRatio {
  key: 'spi' | 'cpi';
  labelAr: string;
  labelEn: string;
  /** The definition, so the reader can check the value against the inputs rather than trust the order. */
  formulaAr: string;
  formulaEn: string;
  value: number | null;
  /** F6's own availability status; a null value is an honest N/A, never a fabricated 0 or 1. */
  status: string;
  authority: typeof CANONICAL_COST_AUTHORITY;
}

export interface EacEntry {
  authority: string;
  value: number | null;
  labelAr: string;
  labelEn: string;
  /** Explicit method, e.g. `eac_cpi`. A forecast without a stated method is not governable. */
  method: string | null;
  basisAr: string;
  basisEn: string;
}

export interface EacPresentation {
  /** The EAC that canonical control cards, VAC and executive reconciliation must use. */
  canonical: EacEntry;
  /** Scenario / risk-adjusted EAC, or null when the scenario layer produced nothing. Never replaces canonical. */
  scenario: (EacEntry & {
    /** `scenario - canonical`; null unless both exist. Shown so the gap is explicit, not implied. */
    deltaVsCanonical: number | null;
    deltaLabelAr: string;
    deltaLabelEn: string;
  }) | null;
  /** VAC identity check against the CANONICAL EAC: `VAC = BAC - EAC` (S19-M). */
  vacIdentity: {
    bac: number | null;
    eac: number | null;
    vac: number | null;
    /** True when all three exist and VAC equals BAC - EAC to the cent. */
    satisfies: boolean;
    /** The recomputed BAC - EAC, so a failure can be read directly. */
    expectedVac: number | null;
  };
}

export interface FinishEntry {
  authority: string;
  finish: string | null;
  labelAr: string;
  labelEn: string;
  basisAr: string;
  basisEn: string;
}

export interface FinishPresentation {
  /** The management schedule finish: F5 / statused CPM at the governed Data Date. */
  canonical: FinishEntry & {
    baselineFinish: string | null;
    /** F5's own delay in WORKING DAYS against the baseline finish. Null when either date is missing. */
    delayWorkingDays: number | null;
    delayLabelAr: string;
    delayLabelEn: string;
  };
  /** SPI-trend + risk statistical finish, or null when the statistical model produced nothing. */
  statistical: (FinishEntry & {
    /** `statistical - canonical` in CALENDAR days; may be negative. Null unless both dates exist. */
    varianceDaysVsCanonical: number | null;
    varianceLabelAr: string;
    varianceLabelEn: string;
    /** Risk days the statistical model added, when the caller knows them. Display only. */
    riskDaysAdded: number | null;
  }) | null;
}

const DAY_MS = 86_400_000;

function finiteOrNull(n: unknown): number | null {
  // `Number(null)` is 0 and `Number('')` is 0, so an absent value must be rejected BEFORE coercion:
  // turning a missing EAC into 0 would publish a plausible number where the honest answer is N/A.
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Calendar days from `fromIso` to `toIso`, UTC-midnight parsed so it is timezone independent. */
function daysBetweenIso(fromIso: string, toIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso) || !/^\d{4}-\d{2}-\d{2}$/.test(toIso)) return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/**
 * SPI and CPI as separately labelled entries from ONE canonical F6 object.
 *
 * The order returned is SPI then CPI, but nothing depends on that order: each entry carries its own
 * `key`, label and formula, so a renderer may map over the list in any order — or reverse it — without
 * a number ever appearing next to the wrong label (S19-J). Values are F6's published ratios, quoted
 * verbatim; they are not recomputed here even though EV/PV and EV/AC are available.
 */
export function buildRatioPresentation(canonical: CanonicalEvmQuote | null | undefined): LabelledRatio[] {
  const spi = finiteOrNull(canonical?.spi);
  const cpi = finiteOrNull(canonical?.cpi);
  return [
    {
      key: 'spi',
      labelAr: 'مؤشر أداء الجدول (SPI)',
      labelEn: 'SPI',
      formulaAr: 'SPI = EV / PV',
      formulaEn: 'SPI = EV / PV',
      value: spi,
      status: canonical?.spiStatus ?? (spi === null ? 'empty_no_data' : 'valid'),
      authority: CANONICAL_COST_AUTHORITY,
    },
    {
      key: 'cpi',
      labelAr: 'مؤشر أداء التكلفة (CPI)',
      labelEn: 'CPI',
      formulaAr: 'CPI = EV / AC',
      formulaEn: 'CPI = EV / AC',
      value: cpi,
      status: canonical?.cpiStatus ?? (cpi === null ? 'empty_no_data' : 'valid'),
      authority: CANONICAL_COST_AUTHORITY,
    },
  ];
}

export interface EacPresentationInput {
  /** Canonical F6 EAC (`report.project.eac`) — the value an unqualified "EAC" must show. */
  canonicalEac: number | null;
  /** F6's recommended method key, e.g. `eac_cpi`. Shown so the forecast states its basis. */
  canonicalMethod?: string | null;
  canonicalBac?: number | null;
  canonicalVac?: number | null;
  /** Statistical / scenario EAC (SPI-CPI trend + risk exposure), or null when unavailable. */
  scenarioEac?: number | null;
  /** Optional method description for the scenario value, e.g. 'spi_cpi_trend_plus_risk'. */
  scenarioMethod?: string | null;
}

/**
 * Name both EACs, state each one's authority and method, and report the scenario delta against the
 * canonical value. The canonical EAC keeps the unqualified label; the scenario EAC never does.
 */
export function buildEacPresentation(input: EacPresentationInput): EacPresentation {
  const canonicalEac = finiteOrNull(input.canonicalEac);
  const scenarioEac = finiteOrNull(input.scenarioEac);
  const bac = finiteOrNull(input.canonicalBac);
  const vac = finiteOrNull(input.canonicalVac);
  const expectedVac = bac !== null && canonicalEac !== null ? round2(bac - canonicalEac) : null;

  return {
    canonical: {
      authority: CANONICAL_COST_AUTHORITY,
      value: canonicalEac,
      labelAr: UNQUALIFIED_EAC_LABEL_AR,
      labelEn: UNQUALIFIED_EAC_LABEL_EN,
      method: input.canonicalMethod ?? null,
      basisAr: 'التكلفة المتوقعة القانونية عند الإنجاز من المحرك F6 — هي المرجع لبطاقات الضبط و VAC والتقارير التنفيذية.',
      basisEn:
        'Canonical control Estimate at Completion from F6 — the EAC used by canonical control cards, VAC and executive reconciliation.',
    },
    scenario:
      scenarioEac === null
        ? null
        : {
          authority: SCENARIO_COST_AUTHORITY,
          value: scenarioEac,
          labelAr: 'EAC المعدّل بالمخاطر (سيناريو — ليس القانوني)',
          labelEn: 'Risk-Adjusted EAC (scenario, not canonical)',
          method: input.scenarioMethod ?? 'spi_cpi_trend_plus_open_risk_exposure',
          basisAr:
            'تنبؤ سيناريو إحصائي من اتجاه SPI/CPI مضافاً إليه تعرّض المخاطر المفتوحة. لا يحل محل EAC القانوني، ويُعرض الفرق بينهما صراحة.',
          basisEn:
            'Scenario forecast from the SPI/CPI trend plus open-risk exposure. It never replaces canonical EAC; the delta is stated explicitly.',
          deltaVsCanonical:
            scenarioEac !== null && canonicalEac !== null ? round2(scenarioEac - canonicalEac) : null,
          deltaLabelAr: 'الفرق مقابل EAC القانوني',
          deltaLabelEn: 'Delta vs canonical EAC',
        },
    vacIdentity: {
      bac,
      eac: canonicalEac,
      vac,
      satisfies: vac !== null && expectedVac !== null && round2(vac) === expectedVac,
      expectedVac,
    },
  };
}

export interface FinishPresentationInput {
  /** Canonical F5 forecast finish (`control.project.forecastFinish`). */
  canonicalFinish: string | null;
  /** F5 baseline finish, for the delay statement. */
  baselineFinish?: string | null;
  /** F5's own delay in working days (`control.project.totalDelayWd`). */
  canonicalDelayWorkingDays?: number | null;
  /** Statistical SPI-trend finish, before risk days are added. */
  statisticalFinish?: string | null;
  /** Risk days added on top of the statistical trend, when the caller knows them. */
  riskDaysAdded?: number | null;
}

/**
 * Name both finish forecasts, keep the canonical F5 date as the management finish, and report the
 * statistical date's variance against it in calendar days (negative when the statistical model is
 * earlier). Neither is hidden and neither silently replaces the other.
 */
export function buildFinishPresentation(input: FinishPresentationInput): FinishPresentation {
  const canonicalFinish = /^\d{4}-\d{2}-\d{2}$/.test(input.canonicalFinish || '') ? input.canonicalFinish : null;
  const baselineFinish = /^\d{4}-\d{2}-\d{2}$/.test(input.baselineFinish || '') ? (input.baselineFinish as string) : null;
  const rawStatistical = input.statisticalFinish;
  const statisticalFinish =
    typeof rawStatistical === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawStatistical) ? rawStatistical : null;
  const delayWorkingDays = finiteOrNull(input.canonicalDelayWorkingDays);

  return {
    canonical: {
      authority: CANONICAL_SCHEDULE_AUTHORITY,
      finish: canonicalFinish,
      labelAr: UNQUALIFIED_FINISH_LABEL_AR,
      labelEn: UNQUALIFIED_FINISH_LABEL_EN,
      basisAr:
        'نهاية الجدول الإدارية القانونية من F5 (CPM مع منطق الحالة عند تاريخ البيانات المعتمد). أي تاريخ إنهاء غير مؤهل يعني هذا التاريخ.',
      basisEn:
        'Canonical management schedule finish from F5 (statused CPM at the governed Data Date). Any unqualified finish date means this one.',
      baselineFinish,
      delayWorkingDays,
      delayLabelAr: 'التأخير مقابل خط الأساس (أيام عمل)',
      delayLabelEn: 'Delay vs baseline (working days)',
    },
    statistical:
      statisticalFinish === null
        ? null
        : {
          authority: STATISTICAL_SCHEDULE_AUTHORITY,
          finish: statisticalFinish,
          labelAr: 'تنبؤ إحصائي بالإنهاء (اتجاه SPI + المخاطر) — ليس التاريخ الإداري',
          labelEn: 'Statistical Finish Forecast (SPI trend + risk, not the management date)',
          basisAr:
            'نموذج إحصائي قائم على أداء SPI مع أيام المخاطر. يُعرض بجانب التاريخ القانوني مع الفرق بينهما، ولا يحل محله.',
          basisEn:
            'Statistical model driven by SPI performance plus risk days. Shown alongside the canonical date with its variance; it never replaces it.',
          varianceDaysVsCanonical:
            canonicalFinish !== null ? daysBetweenIso(canonicalFinish, statisticalFinish) : null,
          varianceLabelAr: 'الفرق مقابل التنبؤ القانوني (أيام)',
          varianceLabelEn: 'Variance vs canonical forecast (days)',
          riskDaysAdded: finiteOrNull(input.riskDaysAdded),
        },
  };
}

/** One surface's quoted canonical EVM facts, for cross-surface reconciliation (S19-P). */
export interface SurfaceEvmQuote {
  /** Surface identity, e.g. 'dashboard', 's_curve_data_date_point', 'f6_cost_control'. */
  surface: string;
  /**
   * Every fact is OPTIONAL, and the two absent states mean different things:
   *   - key omitted / `undefined` — this surface does not publish that fact at all, so there is nothing
   *     to reconcile and it is skipped (F8, for instance, publishes only EAC and the finish).
   *   - explicit `null` — the surface DOES publish it, as N/A. Compared against the reference, so a
   *     surface reporting N/A where canonical F6 has a number is a genuine divergence, not an omission.
   */
  bac?: number | null;
  pv?: number | null;
  ev?: number | null;
  ac?: number | null;
  cpi?: number | null;
  spi?: number | null;
  etc?: number | null;
  eac?: number | null;
  vac?: number | null;
}

export interface CrossSurfaceReconciliation {
  /** True only when every surface agrees with the reference on every compared fact. */
  reconciled: boolean;
  referenceSurface: string;
  surfaces: string[];
  comparedFacts: Array<keyof SurfaceEvmQuote>;
  /** One entry per disagreement, naming the surface, the fact and both values. */
  divergences: Array<{ surface: string; fact: string; expected: number | null; actual: number | null }>;
  /**
   * Facts for which at least one pairwise comparison ACTUALLY happened. Reported so a caller (or a
   * regression test) can tell a real reconciliation from a vacuous green: if every surface omits the
   * same fact, `reconciled` is trivially true for it and this list shows that.
   */
  factsActuallyCompared: string[];
}

const COMPARED_FACTS: Array<keyof SurfaceEvmQuote> = ['bac', 'pv', 'ev', 'ac', 'cpi', 'spi', 'etc', 'eac', 'vac'];

/**
 * Prove that a set of surfaces quote the SAME canonical current EVM facts at the SAME governed Data
 * Date. Exact equality, because every value originates from one F6 evaluation — the only legitimate
 * difference is display rounding, which happens in the renderer and not in these numbers. A surface
 * that omits a fact (`undefined`) is skipped for that fact rather than treated as a divergence, so a
 * screen that legitimately does not publish ETC is not reported as broken; an explicit `null` where the
 * reference has a number IS a divergence.
 */
export function reconcileEvmSurfaces(
  quotes: SurfaceEvmQuote[],
  referenceSurface = 'f6_cost_control',
): CrossSurfaceReconciliation {
  const reference = quotes.find((q) => q.surface === referenceSurface) ?? quotes[0];
  const divergences: CrossSurfaceReconciliation['divergences'] = [];
  const compared = new Set<string>();
  if (reference) {
    for (const quote of quotes) {
      if (quote.surface === reference.surface) continue;
      for (const fact of COMPARED_FACTS) {
        const expected = reference[fact];
        const actual = quote[fact];
        if (typeof expected === 'undefined' || typeof actual === 'undefined') continue;
        compared.add(fact);
        if (expected === null && actual === null) continue;
        if (expected === null || actual === null || Number(expected) !== Number(actual)) {
          divergences.push({ surface: quote.surface, fact, expected: expected as number | null, actual: actual as number | null });
        }
      }
    }
  }
  return {
    reconciled: divergences.length === 0 && quotes.length > 0 && !!reference,
    referenceSurface: reference ? reference.surface : referenceSurface,
    surfaces: quotes.map((q) => q.surface),
    comparedFacts: COMPARED_FACTS,
    factsActuallyCompared: COMPARED_FACTS.filter((f) => compared.has(f)),
    divergences,
  };
}

/**
 * Budget & Forecast Control Engine — Wave 6 SSOT for GAP-009, GAP-040, GAP-042, GAP-043,
 * GAP-047, UG-050 and UG-051.
 *
 * Boundary: the canonical EVM (BAC, PV, EV, AC, SPI, CPI, EAC, ETC, VAC, TCPI and their statuses)
 * stays in `@/lib/planningEngine` and is NOT re-implemented here. This module owns the two things
 * that used to be duplicated inside view components and the scenario simulator:
 *
 *   1. the multi-EAC forecast family (optimistic / realistic / pessimistic-composite / bottom-up)
 *      and the two TCPI readings that are presented next to it;
 *   2. the budget-structure roll-ups a view must not invent: CBS cost-center attribution,
 *      committed-cost provenance and the contract-baseline precedence.
 *
 * ============================================================================
 * RECONCILIATION OF THE FORMULAS THAT EXISTED BEFORE CONSOLIDATION
 * ============================================================================
 * Two independent implementations were found. They agreed on the first two models and diverged on
 * the last two and on every undefined boundary:
 *
 *   model             BudgetView (view component)         complexScenarioSimulator (engine)
 *   ----------------  ----------------------------------  ---------------------------------------
 *   optimistic        AC + (BAC - EV)                     AC' + (BAC' - EV')
 *   realistic         CPI > 0 ? round(BAC / CPI) : BAC    round(BAC' / max(0.1, CPI'))
 *   pessimistic       AC + (BAC-EV) / max(0.1, CPI*SPI)   AC' + (BAC'-EV') / max(0.1, CPI'*SPI')
 *   bottom-up         AC + round((BAC - EV) * 1.02)       simulated total cost (a different thing)
 *   AC / EV used      canonical EVM (measured)            round(BAC' * 0.35) and that x SPI' —
 *                                                         fabricated, no record behind it
 *   TCPI(BAC)         (BAC-EV)/(BAC-AC), else 1.0         not produced
 *   TCPI(EAC)         (BAC-EV)/(EACreal-AC), else 1.0     not produced
 *
 * Divergences resolved here, with the business formula preserved and only the undefined-boundary
 * behaviour corrected:
 *
 *   - `max(0.1, CPI * SPI)` silently invented a 10x cost multiplier whenever the composite
 *     denominator collapsed (CPI or SPI not measured). A non-measurable denominator is now reported
 *     as `denominator_not_positive` with `isComputable: false`; the finite placeholder follows the
 *     canonical convention already used by `assessEvmRatios` for a non-measured CPI (EAC = BAC),
 *     so no consumer can read it as a forecast.
 *   - `round(BAC / max(0.1, CPI))` in the simulator is replaced by the canonical realistic form
 *     `CPI > 0 ? round(BAC / CPI) : BAC`, which is byte-for-byte the formula `assessEvmRatios`
 *     uses, so `realistic.eac === evm.eac` for every input (asserted by the Wave-6 probe).
 *   - The simulator's `eacBottomUp` was its simulated cost outcome, not a bottom-up estimate at
 *     all. The bottom-up model is now `AC + bottom-up ETC` everywhere, and the simulated outcome is
 *     reported separately as `simulatedCostOutcomeSar`.
 *   - TCPI falling back to `1.0` made an exhausted budget render as "easy / TCPI <= 1.0". The
 *     canonical `TcpiStatus` vocabulary is used instead and `1.0` is never substituted.
 *
 * Rounding policy is the canonical engine's existing one and is unchanged: EAC / ETC / VAC to whole
 * currency units, TCPI to 2 decimals, percentages to 1 decimal.
 *
 * Nothing in this module returns NaN or Infinity: non-finite inputs are normalised to 0 on entry and
 * every division is guarded by an explicit status.
 */
import type {
  BoqItem,
  BudgetLine,
  CbsCategory,
  CbsCostCenter,
  CommittedCostStatus,
  ContractBaselineSource,
  CostTransaction,
  ForecastModelStatus,
  TcpiFeasibility,
} from '@/types';
import { TCPI_UNACHIEVABLE_SENTINEL, type TcpiStatus } from '@/lib/planningEngine';

/**
 * Contingency factor of the remaining-performance bottom-up estimate. This is the pre-existing
 * business assumption that was hardcoded as `(BAC - EV) * 1.02` inside BudgetView; it is named here
 * so its provenance is explicit. It is a modelling factor, NOT measured data: a caller that has a
 * real bottom-up estimate of the remaining work should pass `bottomUpEtc` instead, and the result
 * then reports `status: 'valid'` rather than `'valid_estimated_etc'`.
 */
export const BOTTOM_UP_ETC_CONTINGENCY_FACTOR = 1.02;

/** TCPI feasibility bands, preserved from the existing BudgetView presentation. */
export const TCPI_FEASIBILITY_BANDS = { easy: 1.0, realistic: 1.1, hard: 1.25 } as const;

/** Normalise a scalar so a non-finite value can never reach a UI-facing number. */
function safeNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ----------------------------------------------------------------------------
// 1. Multi-EAC forecast family (GAP-009, GAP-040, GAP-047) + TCPI (GAP-042)
// ----------------------------------------------------------------------------

/** Governed inputs of the forecast family. Every value must come from the canonical EVM. */
export interface MultiEacInputs {
  /** Budget at Completion — canonical `evm.bac`. */
  bac: number;
  /** Earned Value at the Data Date — canonical `evm.ev`. */
  ev: number;
  /** Actual Cost at the Data Date — canonical `evm.ac`. */
  ac: number;
  /** Cost Performance Index — canonical `evm.cpi` (may be a canonical sentinel). */
  cpi: number;
  /** Schedule Performance Index — canonical `evm.spi` (may be a canonical sentinel). */
  spi: number;
  /**
   * Canonical TCPI(BAC) from `assessEvmRatios` — passed through so the canonical engine stays the
   * single producer of that reading (GAP-042). May be `TCPI_UNACHIEVABLE_SENTINEL`; `tcpiStatus`
   * is what decides whether it may be shown.
   */
  tcpi: number;
  /** Canonical boundary status of `tcpi`. */
  tcpiStatus: TcpiStatus;
  /**
   * Real bottom-up estimate of the cost to complete (currency units). When omitted or negative the
   * remaining-performance model `(BAC - EV) * BOTTOM_UP_ETC_CONTINGENCY_FACTOR` is used and flagged.
   */
  bottomUpEtc?: number | null;
}

export type EacModelKey = 'optimistic' | 'realistic' | 'pessimistic' | 'bottom_up';

/** One EAC model with its validity metadata. `eac` is always finite. */
export interface EacModelResult {
  key: EacModelKey;
  /** The formula as it is applied, for display next to the number. */
  formula: string;
  /** Estimate at Completion, whole currency units. Finite even when not computable. */
  eac: number;
  /** Estimate to Complete: `max(0, EAC - AC)`, the canonical convention. */
  etc: number;
  /** Variance at Completion: `BAC - EAC`. */
  vac: number;
  status: ForecastModelStatus;
  /** False when the number is a documented placeholder and must be rendered as N/A. */
  isComputable: boolean;
}

/** How a TCPI reading must be presented. The sentinel is never shown as an index. */
export type TcpiDisplay = 'value' | 'not_available' | 'overrun';

export interface TcpiReading {
  /**
   * Raw engine value: a measured index when `status === 'valid'`, otherwise
   * `TCPI_UNACHIEVABLE_SENTINEL`. Read `display` before rendering this number.
   */
  value: number;
  status: TcpiStatus;
  display: TcpiDisplay;
  isComputable: boolean;
  /** Work still to earn: `BAC - EV`. */
  workRemaining: number;
  /** Funds still available: the denominator of this reading. */
  fundsRemaining: number;
}

export interface MultiEacForecast {
  /** The inputs the family was computed from, echoed for reconciliation displays. */
  inputs: { bac: number; ev: number; ac: number; cpi: number; spi: number };
  optimistic: EacModelResult;
  realistic: EacModelResult;
  pessimistic: EacModelResult;
  bottomUp: EacModelResult;
  /** The four models in presentation order. */
  models: EacModelResult[];
  /** Canonical TCPI(BAC) = (BAC - EV) / (BAC - AC), passed through with its status. */
  tcpiToBudget: TcpiReading;
  /** TCPI(EAC) = (BAC - EV) / (EAC_realistic - AC), same status vocabulary. */
  tcpiToEac: TcpiReading;
  feasibility: TcpiFeasibility;
}

/**
 * The single TCPI status rule (GAP-042), shared by both readings.
 *
 * `fundsRemaining > 0` -> a measured index. `=== 0` -> mathematically undefined. `< 0` -> the
 * budget is already exhausted and the remaining-work target is unachievable. Neither boundary is
 * reported as `1.0`, which would falsely say that normal planned efficiency is still enough.
 */
export function evaluateTcpi(workRemaining: number, fundsRemaining: number): TcpiReading {
  const work = safeNumber(workRemaining);
  const funds = safeNumber(fundsRemaining);
  const status: TcpiStatus =
    funds > 0 ? 'valid' : funds === 0 ? 'undefined_zero_denominator' : 'overrun_budget_exhausted';
  return {
    value: status === 'valid' ? Number((work / funds).toFixed(2)) : TCPI_UNACHIEVABLE_SENTINEL,
    status,
    display: status === 'valid' ? 'value' : status === 'undefined_zero_denominator' ? 'not_available' : 'overrun',
    isComputable: status === 'valid',
    workRemaining: work,
    fundsRemaining: funds,
  };
}

/** Feasibility band of a TCPI reading; not assessable when the index itself is not computable. */
export function assessTcpiFeasibility(reading: TcpiReading): TcpiFeasibility {
  if (!reading.isComputable) return 'not_assessable';
  if (reading.value <= TCPI_FEASIBILITY_BANDS.easy) return 'easy';
  if (reading.value <= TCPI_FEASIBILITY_BANDS.realistic) return 'realistic';
  if (reading.value <= TCPI_FEASIBILITY_BANDS.hard) return 'hard';
  return 'unachievable';
}

/**
 * The one multi-EAC implementation. BudgetView and the scenario simulator both call this, so the
 * four models cannot drift between consumers again (GAP-009 / GAP-047): identical inputs produce
 * identical numbers, which is what the Wave-6 probe asserts for CASE A and CASE B.
 */
export function calculateMultiEacForecast(inputs: MultiEacInputs): MultiEacForecast {
  const bac = safeNumber(inputs.bac);
  const ev = safeNumber(inputs.ev);
  const ac = safeNumber(inputs.ac);
  const cpi = safeNumber(inputs.cpi);
  const spi = safeNumber(inputs.spi);

  const isEmpty = bac === 0 && ev === 0 && ac === 0;
  const workRemaining = bac - ev;

  const finish = (
    key: EacModelKey,
    formula: string,
    eac: number,
    status: ForecastModelStatus,
  ): EacModelResult => ({
    key,
    formula,
    eac: Math.round(eac),
    etc: Math.max(0, Math.round(eac) - Math.round(ac)),
    vac: Math.round(bac - eac),
    status,
    isComputable: status === 'valid' || status === 'valid_estimated_etc',
  });

  const emptyStatus: ForecastModelStatus = 'empty_no_data';

  // 1. Optimistic — the remaining work is performed at exactly the planned rate.
  const optimistic = isEmpty
    ? finish('optimistic', 'EAC = AC + (BAC - EV)', 0, emptyStatus)
    : finish('optimistic', 'EAC = AC + (BAC - EV)', ac + workRemaining, 'valid');

  // 2. Realistic — the measured cost efficiency persists. This is the canonical `assessEvmRatios`
  //    EAC formula, so `realistic.eac === evm.eac` for every input.
  const realistic = isEmpty
    ? finish('realistic', 'EAC = BAC / CPI', 0, emptyStatus)
    : cpi > 0
      ? finish('realistic', 'EAC = BAC / CPI', bac / cpi, 'valid')
      : finish('realistic', 'EAC = BAC / CPI', bac, 'index_not_measured');

  // 3. Pessimistic / composite — cost and schedule efficiency both persist. No silent clamp: a
  //    non-positive CPI x SPI is reported, and the finite placeholder is BAC (the same convention
  //    the canonical engine uses when CPI is not measured).
  const compositeDenominator = cpi * spi;
  const pessimistic = isEmpty
    ? finish('pessimistic', 'EAC = AC + (BAC - EV) / (CPI x SPI)', 0, emptyStatus)
    : compositeDenominator > 0
      ? finish(
          'pessimistic',
          'EAC = AC + (BAC - EV) / (CPI x SPI)',
          ac + workRemaining / compositeDenominator,
          'valid',
        )
      : finish('pessimistic', 'EAC = AC + (BAC - EV) / (CPI x SPI)', bac, 'denominator_not_positive');

  // 4. Bottom-up — AC plus an estimate to complete. A real estimate wins; otherwise the documented
  //    remaining-performance factor is used and flagged as an estimate rather than measured data.
  const suppliedEtc = inputs.bottomUpEtc;
  const hasSuppliedEtc =
    typeof suppliedEtc === 'number' && Number.isFinite(suppliedEtc) && suppliedEtc >= 0;
  const bottomUpEtc = hasSuppliedEtc
    ? Math.round(suppliedEtc as number)
    : Math.round(workRemaining * BOTTOM_UP_ETC_CONTINGENCY_FACTOR);
  const bottomUp = isEmpty
    ? finish('bottom_up', 'EAC = AC + bottom-up ETC', 0, emptyStatus)
    : finish(
        'bottom_up',
        hasSuppliedEtc
          ? 'EAC = AC + bottom-up ETC (supplied estimate)'
          : `EAC = AC + (BAC - EV) x ${BOTTOM_UP_ETC_CONTINGENCY_FACTOR}`,
        ac + bottomUpEtc,
        hasSuppliedEtc ? 'valid' : 'valid_estimated_etc',
      );

  const tcpiToBudget: TcpiReading = {
    value: safeNumber(inputs.tcpi),
    status: inputs.tcpiStatus,
    display:
      inputs.tcpiStatus === 'valid'
        ? 'value'
        : inputs.tcpiStatus === 'undefined_zero_denominator'
          ? 'not_available'
          : 'overrun',
    isComputable: inputs.tcpiStatus === 'valid',
    workRemaining,
    fundsRemaining: bac - ac,
  };

  // In the empty state `realistic.eac - ac` is 0, so this reading resolves to
  // `undefined_zero_denominator` / `not_available` on its own — no special case is needed.
  const tcpiToEac = evaluateTcpi(workRemaining, realistic.eac - ac);

  return {
    inputs: { bac, ev, ac, cpi, spi },
    optimistic,
    realistic,
    pessimistic,
    bottomUp,
    models: [optimistic, realistic, pessimistic, bottomUp],
    tcpiToBudget,
    tcpiToEac,
    feasibility: assessTcpiFeasibility(tcpiToBudget),
  };
}

// ----------------------------------------------------------------------------
// 2. Committed cost provenance (UG-051)
// ----------------------------------------------------------------------------

export interface CommittedCostSummary {
  /** Sum of the real `committed_cost` values. Never synthesised from `planned`. */
  total: number;
  status: CommittedCostStatus;
  /** Budget lines that exist for the project. */
  linesTotal: number;
  /** Budget lines carrying a committed_cost value (null/undefined does not count). */
  linesWithCommitment: number;
}

/**
 * Committed cost from real `budget_lines.committed_cost` only (UG-051).
 *
 * The previous consumer wrote `sum(committed_cost) || round(planned * 0.75)`, which fabricated a
 * commitment of 75% of the budget whenever the real total was 0 or absent. There is no such factor
 * here: the answer is the stored total, and `status` says whether that total is a measurement or
 * the absence of data, so a consumer can tell "no commitments recorded" from "committed = 0".
 */
export function summarizeCommittedCost(budgetLines: BudgetLine[]): CommittedCostSummary {
  const lines = Array.isArray(budgetLines) ? budgetLines : [];
  const withCommitment = lines.filter(
    (l) => typeof l.committed_cost === 'number' && Number.isFinite(l.committed_cost),
  );
  const total = withCommitment.reduce((sum, l) => sum + safeNumber(l.committed_cost), 0);
  const status: CommittedCostStatus =
    withCommitment.length === 0 ? 'no_commitment_data' : total === 0 ? 'zero_recorded' : 'recorded';
  return { total: Math.round(total), status, linesTotal: lines.length, linesWithCommitment: withCommitment.length };
}

// ----------------------------------------------------------------------------
// 3. CBS cost centers from real records (UG-050)
// ----------------------------------------------------------------------------

/** Presentation order: the five named cost natures, then the explicit Unclassified bucket. */
export const CBS_CATEGORY_ORDER: CbsCategory[] = [
  'labor',
  'materials',
  'equipment',
  'subcontractors',
  'overheads',
  'unclassified',
];

/**
 * The only mapping this engine performs: a record is attributed to a cost nature when its OWN
 * category text names that cost nature. Tokens are matched case-insensitively as substrings, in
 * both languages, and the vocabulary is exported so a consumer (or an audit) can see exactly what
 * is recognised. Anything else is unmapped and lands in `unclassified` — no trade name such as
 * `Earthworks` or `Concrete Works` is silently reinterpreted as a cost nature, because the schema
 * has no cost-nature column to justify it.
 */
export const CBS_CATEGORY_TOKENS: Record<CbsCategory, string[]> = {
  labor: ['labor', 'labour', 'payroll', 'manpower', 'wage', 'crew', 'عمالة', 'رواتب', 'أجور'],
  materials: ['material', 'supply', 'supplies', 'مواد', 'توريد'],
  equipment: ['equipment', 'plant', 'machinery', 'machine', 'rental', 'معدات', 'آليات'],
  subcontractors: ['subcontract', 'sub-contract', 'sub contractor', 'باطن', 'مقاول باطن'],
  overheads: ['overhead', 'indirect', 'prelim', 'administration', 'غير مباشرة', 'مصاريف غير مباشرة'],
  unclassified: [],
};

/** Classify a record from its own category text; `null` means unmapped. */
export function classifyCbsCategory(...texts: (string | null | undefined)[]): CbsCategory | null {
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const haystack = text.trim().toLowerCase();
    if (!haystack) continue;
    for (const category of CBS_CATEGORY_ORDER) {
      if (category === 'unclassified') continue;
      if (CBS_CATEGORY_TOKENS[category].some((token) => haystack.includes(token))) return category;
    }
  }
  return null;
}

export interface CbsAggregationInputs {
  budgetLines: BudgetLine[];
  costTransactions: CostTransaction[];
  /** Used only to read `boq_items.category` for a budget line's `boq_item_id`. */
  boqItems?: BoqItem[];
  /** Canonical BAC. The planned column reconciles to this, not to a percentage split of it. */
  totalPlanned: number;
  /** Canonical AC. The actual column reconciles to this. */
  totalActual: number;
  /** Governed Data Date: only approved transactions dated on or before it are actual cost. */
  dataDate: string;
}

export interface CbsReconciliation {
  plannedByCategory: number;
  unclassifiedPlanned: number;
  totalPlanned: number;
  /** True when the planned column sums exactly to the canonical total. */
  plannedBalanced: boolean;
  plannedDelta: number;
  actualByCategory: number;
  unclassifiedActual: number;
  totalActual: number;
  actualBalanced: boolean;
  actualDelta: number;
  committedTotal: number;
  committedStatus: CommittedCostStatus;
  /**
   * Planned amount that is in the canonical BAC but not carried by any budget line (for example a
   * contract value above the sum of its budget lines). Reported inside `unclassified`, never spread.
   */
  unallocatedPlanned: number;
  /**
   * Actual amount in the canonical AC that no approved transaction record explains (the canonical
   * zero-transaction policy). Reported inside `unclassified` so the fallback stays in plain view.
   */
  unrecordedActual: number;
}

export interface CbsClassificationAudit {
  mappedBudgetLines: number;
  unmappedBudgetLines: number;
  mappedTransactions: number;
  unmappedTransactions: number;
  /** The recognised vocabulary, so the mapping is inspectable rather than implicit. */
  vocabulary: Record<CbsCategory, string[]>;
}

export interface CbsAggregation {
  /** Always all six centers, in `CBS_CATEGORY_ORDER`, so the table shape never depends on data. */
  centers: CbsCostCenter[];
  reconciliation: CbsReconciliation;
  classification: CbsClassificationAudit;
}

const CBS_CENTER_LABELS: Record<CbsCategory, { id: string; nameAr: string; nameEn: string; description: string }> = {
  labor: {
    id: 'CBS-01',
    nameAr: 'العمالة الذاتية المباشرة (Direct Labor & Payroll)',
    nameEn: 'Direct Labor & Site Supervision',
    description: 'رواتب المهندسين والمشرفين والعمالة الحرفية المباشرة والتأمينات.',
  },
  materials: {
    id: 'CBS-02',
    nameAr: 'المواد والتوريدات الدائمة (Permanent Materials)',
    nameEn: 'Permanent Construction Materials',
    description: 'حديد التسليح، الخرسانة الجاهزة، البلك، المواد الكيميائية والعوازل.',
  },
  equipment: {
    id: 'CBS-03',
    nameAr: 'المعدات والآليات (Equipment & Heavy Plant)',
    nameEn: 'Equipment Rental & Plant Operations',
    description: 'الرافعات البرجية، الحفارات، مضخات الخرسانة، والمولدات والديزل.',
  },
  subcontractors: {
    id: 'CBS-04',
    nameAr: 'عقود مقاولي الباطن (Subcontractors Packages)',
    nameEn: 'Specialized Subcontractors',
    description: 'مقاول مصنعيات الخرسانة، مقاول أعمال الدكت والتكييف، ومقاول الواجهات.',
  },
  overheads: {
    id: 'CBS-05',
    nameAr: 'المصاريف غير المباشرة للموقع (Site Overheads & Indirects)',
    nameEn: 'Site Overheads & Administration',
    description: 'إيجار المكاتب المؤقتة، سيارات الموقع، التأمينات، والمختبرات وضبط الجودة.',
  },
  unclassified: {
    id: 'CBS-00',
    nameAr: 'غير مصنّف / أخرى (Unclassified & Other)',
    nameEn: 'Unclassified / Other',
    description:
      'مبالغ حقيقية لا تحمل أي بيان تصنيف تكلفة في السجلات المالية (بنود الميزانية لا تحتوي عمود تصنيف، وتصنيفات BOQ هي أنواع أعمال وليست طبيعة تكلفة). تُعرض هنا كما هي بدلاً من توزيعها بنسب ثابتة.',
  },
};

/**
 * CBS cost centers built from real records only (UG-050).
 *
 * Data reality this respects: `budget_lines` has NO category column at all, `cost_transactions`
 * has a free-text `category` (and `cost_type`), and `boq_items.category` holds BOQ trade names
 * (`Earthworks`, `Concrete Works`, `Piling`, ...). A trade name is not a cost nature, so it is not
 * reinterpreted. Planned / committed come from `budget_lines` (a line is classified through its
 * `boq_item_id -> boq_items.category` link when that text names a cost nature); actual comes from
 * approved `cost_transactions` dated on or before the Data Date, classified by the transaction's
 * own `category` / `cost_type`.
 *
 * Reconciliation is exact by construction: whatever the canonical totals contain beyond the mapped
 * and unmapped records is added to the Unclassified center, so
 * `sum(planned centers) === totalPlanned` and `sum(actual centers) === totalActual`.
 */
export function aggregateCbsCostCenters(inputs: CbsAggregationInputs): CbsAggregation {
  const budgetLines = Array.isArray(inputs.budgetLines) ? inputs.budgetLines : [];
  const costTransactions = Array.isArray(inputs.costTransactions) ? inputs.costTransactions : [];
  const boqItems = Array.isArray(inputs.boqItems) ? inputs.boqItems : [];
  const totalPlanned = Math.round(safeNumber(inputs.totalPlanned));
  const totalActual = Math.round(safeNumber(inputs.totalActual));
  const dataDate = typeof inputs.dataDate === 'string' && inputs.dataDate ? inputs.dataDate : '';

  const boqCategoryById = new Map<string, string | null>();
  boqItems.forEach((item) => boqCategoryById.set(item.id, item.category ?? null));

  const planned: Record<CbsCategory, number> = {
    labor: 0, materials: 0, equipment: 0, subcontractors: 0, overheads: 0, unclassified: 0,
  };
  const committed: Record<CbsCategory, number> = { ...planned };
  const actual: Record<CbsCategory, number> = { ...planned };
  const counts: Record<CbsCategory, number> = { ...planned };

  let mappedBudgetLines = 0;
  let budgetPlannedTotal = 0;

  budgetLines.forEach((line) => {
    const category = classifyCbsCategory(boqCategoryById.get(line.boq_item_id ?? '') ?? null);
    const bucket: CbsCategory = category ?? 'unclassified';
    if (category) mappedBudgetLines++;
    const linePlanned = safeNumber(line.planned_cost);
    const lineCommitted =
      typeof line.committed_cost === 'number' && Number.isFinite(line.committed_cost)
        ? line.committed_cost
        : 0;
    planned[bucket] += linePlanned;
    committed[bucket] += lineCommitted;
    budgetPlannedTotal += linePlanned;
    counts[bucket] += 1;
  });

  let mappedTransactions = 0;
  let transactionActualTotal = 0;

  costTransactions.forEach((tx) => {
    // Wave-2 / Wave-5 discipline: only approved cost dated on or before the Data Date is actual.
    if (tx.status !== 'approved') return;
    if (dataDate && typeof tx.transaction_date === 'string' && tx.transaction_date > dataDate) return;
    const category = classifyCbsCategory(
      tx.category,
      tx.cost_type,
      boqCategoryById.get(tx.boq_item_id ?? '') ?? null,
    );
    const bucket: CbsCategory = category ?? 'unclassified';
    if (category) mappedTransactions++;
    const amount = safeNumber(tx.amount);
    actual[bucket] += amount;
    transactionActualTotal += amount;
    counts[bucket] += 1;
  });

  const committedSummary = summarizeCommittedCost(budgetLines);
  const approvedTransactions = costTransactions.filter(
    (tx) => tx.status === 'approved' && !(dataDate && tx.transaction_date > dataDate),
  );

  // Residuals the canonical totals contain beyond the records: reported inside Unclassified.
  const unallocatedPlanned = totalPlanned - Math.round(budgetPlannedTotal);
  const unrecordedActual = totalActual - Math.round(transactionActualTotal);

  const centers: CbsCostCenter[] = CBS_CATEGORY_ORDER.map((category) => {
    const label = CBS_CENTER_LABELS[category];
    let plannedSar = Math.round(planned[category]);
    let actualSar = Math.round(actual[category]);
    if (category === 'unclassified') {
      // Absorb the residual so the columns reconcile exactly to the canonical totals.
      plannedSar += unallocatedPlanned;
      actualSar += unrecordedActual;
    }
    const committedSar = Math.round(committed[category]);
    const varianceSar = plannedSar - actualSar;
    const categoryCommittedStatus: CommittedCostStatus =
      counts[category] === 0
        ? 'no_commitment_data'
        : committedSar > 0
          ? 'recorded'
          : committedSummary.status === 'no_commitment_data'
            ? 'no_commitment_data'
            : 'zero_recorded';
    return {
      id: label.id,
      category,
      nameAr: label.nameAr,
      nameEn: label.nameEn,
      budgetAllocatedSar: plannedSar,
      committedCostSar: committedSar,
      actualCostSar: actualSar,
      remainingCostSar: plannedSar - actualSar,
      varianceSar,
      // Guarded: a center with no planned amount has no meaningful percentage (never NaN/Infinity).
      variancePercent: plannedSar !== 0 ? Number(((varianceSar / plannedSar) * 100).toFixed(1)) : 0,
      committedCostStatus: categoryCommittedStatus,
      mappedRecordCount: counts[category],
      isUnclassified: category === 'unclassified',
      description: label.description,
    };
  });

  const plannedByCategory = centers
    .filter((c) => !c.isUnclassified)
    .reduce((sum, c) => sum + c.budgetAllocatedSar, 0);
  const actualByCategory = centers
    .filter((c) => !c.isUnclassified)
    .reduce((sum, c) => sum + c.actualCostSar, 0);
  const unclassifiedCenter = centers.find((c) => c.isUnclassified);
  const sumPlanned = centers.reduce((sum, c) => sum + c.budgetAllocatedSar, 0);
  const sumActual = centers.reduce((sum, c) => sum + c.actualCostSar, 0);

  return {
    centers,
    reconciliation: {
      plannedByCategory,
      unclassifiedPlanned: unclassifiedCenter?.budgetAllocatedSar ?? 0,
      totalPlanned,
      plannedBalanced: sumPlanned === totalPlanned,
      plannedDelta: sumPlanned - totalPlanned,
      actualByCategory,
      unclassifiedActual: unclassifiedCenter?.actualCostSar ?? 0,
      totalActual,
      actualBalanced: sumActual === totalActual,
      actualDelta: sumActual - totalActual,
      committedTotal: committedSummary.total,
      committedStatus: committedSummary.status,
      unallocatedPlanned,
      unrecordedActual,
    },
    classification: {
      mappedBudgetLines,
      unmappedBudgetLines: budgetLines.length - mappedBudgetLines,
      mappedTransactions,
      unmappedTransactions: approvedTransactions.length - mappedTransactions,
      vocabulary: CBS_CATEGORY_TOKENS,
    },
  };
}

// ----------------------------------------------------------------------------
// 4. Contract baseline precedence (GAP-043)
// ----------------------------------------------------------------------------

export interface ContractBaselineInputs {
  project?: { contract_value?: number | null } | null;
  /** Optional: only used when the consumer has already loaded real budget lines. */
  budgetLines?: BudgetLine[];
  /** Optional: only used when the consumer has already loaded real BOQ items. */
  boqItems?: BoqItem[];
}

export interface ContractBaseline {
  /** The resolved figure. `0` when no legitimate source exists. */
  value: number;
  source: ContractBaselineSource;
  /** False when nothing legitimate was available — the consumer must then show N/A. */
  isAvailable: boolean;
}

/**
 * Contract baseline with an explicit precedence and NO arbitrary numeric fallback (GAP-043):
 *
 *   1. `project.contract_value`            (the contract itself)
 *   2. sum of `budget_lines.planned_cost`  (the approved budget, when already loaded)
 *   3. sum of `boq_items.total_price`      (the priced BOQ, when already loaded)
 *   4. `0` with `isAvailable: false`       -> render N/A
 *
 * A missing contract value used to resolve to a hardcoded 4,500,000 SAR, which then fed revised
 * contract value and certification percentages. This deliberately does NOT reuse the canonical EVM
 * BAC either: `assessEvmRatios`' BAC ends in a `1e6` synthetic tail, and a contract baseline that
 * invents a figure is the defect being removed here.
 */
export function resolveContractBaseline(inputs: ContractBaselineInputs): ContractBaseline {
  const contractValue = safeNumber(inputs.project?.contract_value);
  if (contractValue > 0) return { value: Math.round(contractValue), source: 'contract_value', isAvailable: true };

  const budgetTotal = (Array.isArray(inputs.budgetLines) ? inputs.budgetLines : []).reduce(
    (sum, line) => sum + safeNumber(line.planned_cost),
    0,
  );
  if (budgetTotal > 0) return { value: Math.round(budgetTotal), source: 'budget_lines_total', isAvailable: true };

  const boqTotal = (Array.isArray(inputs.boqItems) ? inputs.boqItems : []).reduce(
    (sum, item) => sum + safeNumber(item.total_price),
    0,
  );
  if (boqTotal > 0) return { value: Math.round(boqTotal), source: 'boq_total', isAvailable: true };

  return { value: 0, source: 'none', isAvailable: false };
}

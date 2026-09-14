// =====================================================================================
// Phase F2 · BOQ planning engine (pure, deterministic).
//
// generateBoqPlan(rows, profile, overrides) turns BOQ rows into a complete Draft plan:
// classification -> work fronts -> multi-level WBS -> template-decomposed activities
// (durations + costs + crew-only resources) -> semantic logic + milestones -> canonical
// CPM (the ONLY date math) -> validation -> reconciliation.
//
// Determinism: stable content-derived IDs (no UUIDs/random here — those are minted at
// save time by boqPlanService), sorted iteration everywhere, integer-cent cost math.
// =====================================================================================

import type { ParsedBoqRow } from "@/types";
import type { Activity, ActivityLink, CalendarType } from "../types";
import { calculateCpm } from "./cpmEngine";
import {
  WORK_TYPE_BINDING,
  classifyBoqRow,
  extraLocationHints,
  type BoqClassification,
  type BoqFamily,
  type BoqWorkType,
} from "./boqClassifier";
import {
  CROSS_FRONT_RULES,
  PLANNING_TEMPLATES,
  templateStepKeys,
  type PlanningTemplateKey,
  type TemplateLinkType,
} from "./planningTemplates";
import {
  buildPoolDemands,
  classifyPools,
  detectPoolConflicts,
  levelBoqResources,
  resolveCapacities,
  snapshotState,
  workingDayDelta,
  type CapacityRecommendation,
  type LevelAttribution,
  type LevelingOptions,
  type PoolConflict,
  type ResourceLevelingReport,
} from "./boqResourceLeveling";

// -------------------------------------------------------------------------------------
// Input
// -------------------------------------------------------------------------------------

export interface BoqPlanProfile {
  projectName: string;
  /** ISO start date (yyyy-mm-dd). Seeds CPM; output finish comes from CPM. */
  startDate: string;
  calendarType: CalendarType;
}

export interface BoqUserLink {
  fromActivityId: string;
  toActivityId: string;
  type: TemplateLinkType;
  lagDays: number;
}

export interface BoqPlanOverrides {
  workType: Record<string, BoqWorkType>;
  confirmed: Record<string, true>;
  excludedFamilies: BoqFamily[];
  location: Record<string, string>;
  duration: Record<string, number>;
  rate: Record<string, number>;
  crews: Record<string, number>;
  wbs: Record<string, string>;
  removeLinks: string[];
  addLinks: BoqUserLink[];
  /** F3: per-BOQ-row front sequence number (orders crew-flow lanes; lower first). */
  sequence: Record<string, number>;
  /** F3: per-BOQ-row quantity distribution "Label=qty; Label=qty" across fronts. */
  distribution: Record<string, string>;
  /** F4: resource-leveling policy, pool capacities (gangs), target finish, waivers. */
  leveling: LevelingOptions;
}

export const EMPTY_BOQ_OVERRIDES: BoqPlanOverrides = {
  workType: {},
  confirmed: {},
  excludedFamilies: [],
  location: {},
  duration: {},
  rate: {},
  crews: {},
  wbs: {},
  removeLinks: [],
  addLinks: [],
  sequence: {},
  distribution: {},
  leveling: { policy: "respect-resources", capacities: {}, targetFinish: null, waivedPools: [] },
};

// -------------------------------------------------------------------------------------
// Output
// -------------------------------------------------------------------------------------

export type DurationBasis = "user" | "library_rate" | "template_default" | "review";
export type PlanSeverity = "critical" | "warning" | "info";

export interface PlannedWbs {
  stableId: string;
  code: string;
  name: string;
  level: number;
  parentStableId: string | null;
  sortOrder: number;
}

export interface PlannedActivity {
  stableId: string;
  code: string;
  name: string;
  wbsStableId: string;
  sortOrder: number;
  isMilestone: boolean;
  milestoneKind: "start" | "finish" | "package" | "testing" | null;
  frontId: string | null;
  templateKey: PlanningTemplateKey | null;
  stepKey: string | null;
  quantity: number | null;
  quantityUnit: string | null;
  durationDays: number;
  durationBasis: DurationBasis;
  /** Human provenance line, e.g. "12,000 m3 @ 1,200/d x 1 crew". */
  durationNote: string;
  plannedCost: number;
  crewCount: number;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalFloat: number | null;
  isCritical: boolean;
}

export interface PlannedLink {
  stableId: string;
  fromActivityId: string;
  toActivityId: string;
  type: TemplateLinkType;
  lagDays: number;
  rule: string;
  origin: "template" | "sequence" | "crewflow" | "milestone" | "user" | "resource_leveling";
  /** F4: governing pool for leveling links; null for engineering/user logic. */
  resourceKey: string | null;
  /** F3: stable rule code (e.g. PIPE_FLOW_EXCV_TO_BEDDING, CREW_CONTINUITY_EXCV). */
  ruleCode: string;
}

export interface PlannedBudgetLine {
  stableId: string;
  activityStableId: string;
  wbsStableId: string;
  description: string;
  plannedCost: number;
}

export interface PlannedResource {
  stableId: string;
  code: string;
  name: string;
  type: string;
  unit: string;
}

export interface PlannedAssignment {
  stableId: string;
  activityStableId: string;
  resourceStableId: string;
  plannedQuantity: number;
  crewCount: number;
}

export interface PlannedAllocation {
  stableId: string;
  activityStableId: string;
  rowKey: string;
  quantityShare: number | null;
  costShare: number;
  allocationBasis: "single_step_full" | "template_weight_split" | "zero_intrinsic";
}

export interface PlanFinding {
  severity: PlanSeverity;
  code: string;
  message: string;
  refStableId: string | null;
}

export interface MaterialBalanceEntry {
  frontId: string;
  label: string;
  cutQty: number;
  fillQty: number;
  unbalancedQty: number;
  haulStatus: "hauled-per-boq" | "export-undefined" | "import-undefined" | "balanced";
}

export interface BoqPlanRecon {
  boqTotal: number;
  allocatedTotal: number;
  unallocatedTotal: number;
  usableItemCount: number;
  reviewItemCount: number;
  activityCount: number;
  milestoneCount: number;
  linkCount: number;
  wbsCount: number;
  budgetLineCount: number;
  resourceCount: number;
  allocationCount: number;
  criticalCount: number;
  criticalPct: number;
  projectStart: string | null;
  projectFinish: string | null;
  spanDays: number;
  /** F3: cut/fill balance per mass-grading front (empty when no grading fronts). */
  materialBalance: MaterialBalanceEntry[];
}

export interface BoqPlan {
  profile: BoqPlanProfile;
  classifications: BoqClassification[];
  wbs: PlannedWbs[];
  activities: PlannedActivity[];
  links: PlannedLink[];
  budgetLines: PlannedBudgetLine[];
  resources: PlannedResource[];
  assignments: PlannedAssignment[];
  allocations: PlannedAllocation[];
  findings: PlanFinding[];
  recon: BoqPlanRecon;
  leveling: ResourceLevelingReport;
  canSave: boolean;
  saveBlockReason: string | null;
  canApproveBaseline: boolean;
}

// -------------------------------------------------------------------------------------
// Stable ordering tables
// -------------------------------------------------------------------------------------

const FAMILY_ORDER: BoqFamily[] = ["earthworks", "building", "bridges", "network", "road", "unassigned"];

export const FAMILY_LABELS: Record<BoqFamily, { en: string; ar: string }> = {
  earthworks: { en: "Earthworks", ar: "أعمال ترابية" },
  building: { en: "Buildings", ar: "مباني" },
  bridges: { en: "Bridges / Structures", ar: "جسور / منشآت" },
  network: { en: "Networks", ar: "شبكات" },
  road: { en: "Roads", ar: "طرق" },
  unassigned: { en: "Unassigned", ar: "غير مصنف" },
};

const PACKAGE_ORDER: Record<string, number> = {
  mass_grading: 10,
  substructure: 20, superstructure: 30, architectural: 40,
  bridge_rc: 50,
  water: 60, sewer: 70, storm: 80, network_general: 90,
  earthworks: 100, drainage: 110, pavement: 120, kerbs: 130, furniture: 140,
};

export const PACKAGE_LABELS: Record<string, { en: string; ar: string }> = {
  mass_grading: { en: "Mass grading", ar: "تسوية عامة" },
  substructure: { en: "Substructure", ar: "أساسات" },
  superstructure: { en: "Superstructure", ar: "هيكل علوي" },
  architectural: { en: "Architectural", ar: "معماري" },
  bridge_rc: { en: "RC works", ar: "أعمال خرسانية" },
  water: { en: "Water network", ar: "شبكة مياه" },
  sewer: { en: "Sewer network", ar: "شبكة صرف" },
  storm: { en: "Storm network", ar: "شبكة أمطار" },
  network_general: { en: "General network", ar: "شبكة عامة" },
  earthworks: { en: "Earthworks", ar: "أعمال ترابية" },
  drainage: { en: "Drainage", ar: "تصريف" },
  pavement: { en: "Pavement", ar: "رصف" },
  kerbs: { en: "Kerbs", ar: "بردورات" },
  furniture: { en: "Road furniture", ar: "تجهيزات الطريق" },
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

// -------------------------------------------------------------------------------------
// Money: integer cents + largest remainder (exact totals, deterministic)
// -------------------------------------------------------------------------------------

function toCents(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
}

/** Split `total` by weights so the parts sum EXACTLY to total (largest remainder, index-tiebreak). */
function splitExact(total: number, weights: number[]): number[] {
  const totalCents = toCents(total);
  if (weights.length === 0) return [];
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (!(wSum > 0)) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / wSum);
  const base = raw.map((r) => Math.floor(r + 1e-9));
  let rest = totalCents - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    base[o.i] += 1;
    rest -= 1;
  }
  return base.map((c) => c / 100);
}

// -------------------------------------------------------------------------------------
// Internal: fronts (many BOQ rows -> one front -> N template activities)
// -------------------------------------------------------------------------------------

interface FrontRow {
  index: number;
  classification: BoqClassification;
  /** F3 distribution piece: quantity in the ROW's unit + cost share. Undefined = whole row. */
  pieceQty?: number;
  pieceCost?: number;
}

interface Front {
  id: string;
  family: BoqFamily;
  packageKey: string;
  templateKey: PlanningTemplateKey;
  locationKey: string | null;
  locationLabel: string | null;
  rows: FrontRow[];
  /** F3: min member sequence override (null = unordered, sorts by location key). */
  orderSeq: number | null;
}

// F3: semantic step names for CREW_CONTINUITY rule codes.
const STEP_SEMANTIC: Record<string, Record<string, string>> = {
  RC_SUBSTRUCTURE_V1: { E: "EXCV", B: "BLIND", W: "WATERPROOF", R: "REBAR", F: "FORM", C: "CONC", U: "CURE" },
  RC_VERTICAL_V1: { R: "REBAR", F: "FORM", C: "CONC", U: "CURE" },
  RC_HORIZONTAL_V1: { F: "FORM", R: "REBAR", C: "CONC", U: "CURE" },
  MASONRY_V1: { K: "BLOCKWORK" },
  MASS_GRADING_V1: { S: "SURVEY", L: "CLEAR", E: "EXCV", H: "HAUL", P: "FILL", O: "COMPACT", G: "GRADE" },
  PIPE_NETWORK_V1: { S: "SURVEY", E: "EXCV", D: "BEDDING", I: "PIPE", J: "JOINT", T: "TEST", B: "BACKFILL", N: "REINSTATE" },
  ROAD_PAVEMENT_V1: { G: "SUBGRADE", S: "SUBBASE", B: "BASE", P: "PRIME", N: "BINDER", W: "WEAR" },
  ROAD_KERB_V1: { K: "KERB" },
};

export interface DistributionPiece { locationKey: string; locationLabel: string; qty: number; }

/**
 * F3: parse a user quantity distribution ("Zone A=3000; Zone B=2000").
 * Deterministic; invalid text or non-positive quantities are reported, never guessed.
 */
export function parseDistribution(raw: string): { pieces: DistributionPiece[]; error: string | null } {
  const pieces: DistributionPiece[] = [];
  for (const part of raw.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) return { pieces: [], error: `unparseable entry "${t}" (want Label=qty)` };
    const label = t.slice(0, eq).trim();
    const qty = Number(t.slice(eq + 1).trim());
    if (!label) return { pieces: [], error: `empty label in "${t}"` };
    if (!Number.isFinite(qty) || qty < 0) return { pieces: [], error: `invalid quantity in "${t}"` };
    pieces.push({ locationKey: `user:${slug(label)}`, locationLabel: label, qty });
  }
  if (pieces.length === 0) return { pieces: [], error: "empty distribution" };
  return { pieces, error: null };
}

export interface DistributionFlag { rowKey: string; kind: "mismatch" | "unparseable"; message: string; }

function buildFronts(
  rows: ParsedBoqRow[],
  classifications: BoqClassification[],
  overrides: BoqPlanOverrides
): { fronts: Front[]; usable: BoqClassification[]; review: BoqClassification[]; distFlags: DistributionFlag[] } {
  const usable: BoqClassification[] = [];
  const review: BoqClassification[] = [];
  for (const c of classifications) {
    const wt = overrides.workType[c.rowKey] || c.workType;
    if (wt === "review_required") { review.push(c); continue; }
    if (!WORK_TYPE_BINDING[wt]) { review.push(c); continue; }
    const fam: BoqFamily = c.family === "unassigned" ? "unassigned" : c.family;
    if (overrides.excludedFamilies.includes(fam) || fam === "unassigned") { review.push(c); continue; }
    usable.push(c);
  }
  const distFlags: DistributionFlag[] = [];
  const groups = new Map<string, Front>();
  const place = (c: BoqClassification, index: number, locationKey: string | null, locationLabel: string | null, pieceQty?: number, pieceCost?: number) => {
    const wt = overrides.workType[c.rowKey] || c.workType;
    const binding = WORK_TYPE_BINDING[wt as Exclude<BoqWorkType, "review_required">];
    const key = `${c.family}|${c.packageKey}|${binding.template}|${locationKey || "main"}`;
    let front = groups.get(key);
    if (!front) {
      front = {
        id: `front-${slug(c.family)}-${slug(c.packageKey)}-${slug(binding.template)}-${slug(locationKey || "main")}`,
        family: c.family, packageKey: c.packageKey,
        templateKey: binding.template as PlanningTemplateKey,
        locationKey, locationLabel, rows: [], orderSeq: null,
      };
      groups.set(key, front);
    }
    front.rows.push({ index, classification: c, pieceQty, pieceCost });
    const seq = overrides.sequence[c.rowKey];
    if (typeof seq === "number" && Number.isFinite(seq)) {
      front.orderSeq = front.orderSeq === null ? seq : Math.min(front.orderSeq, seq);
    }
  };
  usable.forEach((c) => {
    const index = Number(c.rowKey.slice(4)) - 1;
    const row = rows[index];
    const locOverride = overrides.location[c.rowKey];
    const baseKey = locOverride ? `user:${slug(locOverride)}` : (c.locationHint ? c.locationHint.key : null);
    const baseLabel = locOverride || (c.locationHint ? c.locationHint.label : null);
    const rawDist = (overrides.distribution[c.rowKey] || "").trim();
    if (!rawDist) {
      place(c, index, baseKey, baseLabel);
      return;
    }
    // F3: user-declared split across fronts (cost follows quantity pro-rata, exact cents).
    // Anything invalid keeps the item unsplit — never an arbitrary equal split.
    const parsed = parseDistribution(rawDist);
    if (parsed.error) {
      distFlags.push({ rowKey: c.rowKey, kind: "unparseable", message: `distribution ignored: ${parsed.error}` });
      place(c, index, baseKey, baseLabel);
      return;
    }
    const sum = parsed.pieces.reduce((a, p) => a + p.qty, 0);
    const tol = Math.max(0.01, Math.abs(row.quantity) * 1e-6);
    if (Math.abs(sum - row.quantity) > tol) {
      distFlags.push({ rowKey: c.rowKey, kind: "mismatch", message: `distribution sums to ${sum} but row quantity is ${row.quantity} — kept unsplit` });
      place(c, index, baseKey, baseLabel);
      return;
    }
    const costs = splitExact(row.total_price, parsed.pieces.map((p) => p.qty));
    parsed.pieces.forEach((p, i) => place(c, index, p.locationKey, p.locationLabel, p.qty, costs[i]));
  });
  const fronts = [...groups.values()].sort((a, b) =>
    FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)
    || (PACKAGE_ORDER[a.packageKey] || 999) - (PACKAGE_ORDER[b.packageKey] || 999)
    || PLANNING_TEMPLATES[a.templateKey].order - PLANNING_TEMPLATES[b.templateKey].order
    || (a.locationKey || "").localeCompare(b.locationKey || "")
  );
  for (const f of fronts) f.rows.sort((x, y) => x.index - y.index);
  return { fronts, usable, review, distFlags };
}

// WBS: L1 project root / L2 package / L3 location (only from source) / L4 front
// -------------------------------------------------------------------------------------

function buildWbs(projectName: string, fronts: Front[]): PlannedWbs[] {
  const wbs: PlannedWbs[] = [];
  let sort = 0;
  const rootId = "wbs-root";
  wbs.push({ stableId: rootId, code: "1", name: projectName || "Project", level: 1, parentStableId: null, sortOrder: sort++ });
  const pkgGroups = new Map<string, Front[]>();
  for (const f of fronts) {
    const key = `${f.family}|${f.packageKey}`;
    if (!pkgGroups.has(key)) pkgGroups.set(key, []);
    pkgGroups.get(key)!.push(f);
  }
  const pkgs = [...pkgGroups.entries()].sort((a, b) => {
    const fa = a[1][0]; const fb = b[1][0];
    return FAMILY_ORDER.indexOf(fa.family) - FAMILY_ORDER.indexOf(fb.family)
      || (PACKAGE_ORDER[fa.packageKey] || 999) - (PACKAGE_ORDER[fb.packageKey] || 999);
  });
  let p2 = 0;
  for (const [, members] of pkgs) {
    p2++;
    const fam = members[0].family; const pkg = members[0].packageKey;
    const pkgId = `wbs-pkg-${slug(fam)}-${slug(pkg)}`;
    const pkgLabel = PACKAGE_LABELS[pkg]?.en || pkg;
    wbs.push({
      stableId: pkgId, code: `1.${p2}`,
      name: `${FAMILY_LABELS[fam]?.en || fam} — ${pkgLabel}`,
      level: 2, parentStableId: rootId, sortOrder: sort++,
    });
    const locGroups = new Map<string, Front[]>();
    for (const f of members) {
      const key = f.locationKey || "main";
      if (!locGroups.has(key)) locGroups.set(key, []);
      locGroups.get(key)!.push(f);
    }
    let p3 = 0;
    for (const [locKey, locMembers] of [...locGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const hasLocation = locKey !== "main";
      let parentForFronts = pkgId;
      if (hasLocation) {
        p3++;
        const locId = `wbs-loc-${slug(fam)}-${slug(pkg)}-${slug(locKey)}`;
        wbs.push({
          stableId: locId, code: `1.${p2}.${p3}`,
          name: locMembers[0].locationLabel || locKey,
          level: 3, parentStableId: pkgId, sortOrder: sort++,
        });
        parentForFronts = locId;
      }
      let p4 = 0;
      for (const f of locMembers.sort((a, b) => PLANNING_TEMPLATES[a.templateKey].order - PLANNING_TEMPLATES[b.templateKey].order)) {
        p4++;
        wbs.push({
          stableId: `wbs-${f.id}`, code: hasLocation ? `1.${p2}.${p3}.${p4}` : `1.${p2}.${p4}`,
          name: PLANNING_TEMPLATES[f.templateKey].name,
          level: hasLocation ? 4 : 3, parentStableId: parentForFronts, sortOrder: sort++,
        });
      }
    }
  }
  return wbs;
}
// -------------------------------------------------------------------------------------
// Durations: user rule > library rate x crews > template default > review stub (5d)
// -------------------------------------------------------------------------------------

interface StepWork {
  stepKey: string;
  rows: Array<{ index: number; classification: BoqClassification; row: ParsedBoqRow; pieceQtyConverted: number | null; pieceCost: number | null }>;
  qty: number;
  unit: string | null;
}

function collectStepWork(front: Front, rows: ParsedBoqRow[], overrides: BoqPlanOverrides): Map<string, StepWork> {
  const template = PLANNING_TEMPLATES[front.templateKey];
  const work = new Map<string, StepWork>();
  for (const step of template.steps) {
    work.set(step.key, { stepKey: step.key, rows: [], qty: 0, unit: step.unit });
  }
  for (const fr of front.rows) {
    const wt = overrides.workType[fr.classification.rowKey] || fr.classification.workType;
    const binding = WORK_TYPE_BINDING[wt as Exclude<BoqWorkType, "review_required">];
    if (!binding) continue;
    const row = rows[fr.index];
    const factor = row.quantity !== 0 ? fr.classification.quantityConverted / row.quantity : 0;
    const pieceQtyConverted = fr.pieceQty !== undefined ? fr.pieceQty * factor : null;
    const pieceCost = fr.pieceCost !== undefined ? fr.pieceCost : null;
    for (const sk of binding.steps) {
      const w = work.get(sk);
      if (!w) continue;
      w.rows.push({ index: fr.index, classification: fr.classification, row, pieceQtyConverted, pieceCost });
      const step = template.steps.find((s) => s.key === sk)!;
      if (step.unit && fr.classification.unit === step.unit) {
        w.qty += pieceQtyConverted !== null ? pieceQtyConverted : fr.classification.quantityConverted;
      }
    }
  }
  return work;
}

interface StepDuration { days: number; basis: DurationBasis; note: string; crews: number; }

function computeStepDuration(
  activityId: string, stepKey: string, w: StepWork,
  dailyOutput: number | null, defaultDays: number | null, defaultCrews: number,
  overrides: BoqPlanOverrides
): StepDuration {
  const crews = overrides.crews[activityId] && overrides.crews[activityId] > 0
    ? Math.round(overrides.crews[activityId]) : defaultCrews;
  const userDays = overrides.duration[activityId];
  if (userDays && userDays > 0) {
    return { days: Math.round(userDays), basis: "user", note: `User-set ${Math.round(userDays)}d`, crews };
  }
  const userRate = overrides.rate[activityId] && overrides.rate[activityId] > 0 ? overrides.rate[activityId] : null;
  const rate = userRate !== null ? userRate : dailyOutput;
  if (rate && rate > 0 && w.qty > 0 && w.unit) {
    const days = Math.max(1, Math.ceil(w.qty / (rate * crews)));
    const q = w.qty.toLocaleString("en-US", { maximumFractionDigits: 2 });
    const prov = userRate !== null ? "(user project-specific rate)" : "; Library planning rate \u2014 review recommended";
    return { days, basis: "library_rate", note: `${q} ${w.unit} @ ${rate}/d x ${crews} crew(s) ${prov}`, crews };
  }
  if (defaultDays && defaultDays > 0) {
    return { days: defaultDays, basis: "template_default", note: `Template default ${defaultDays}d (no BOQ quantity)`, crews };
  }
  return { days: 5, basis: "review", note: "REVIEW: no usable quantity — set duration", crews };
}

// -------------------------------------------------------------------------------------
// Costs: single-step items 100%; composite items split by documented template weights
// (renormalized over instantiated steps, largest-remainder cents — exact totals)
// -------------------------------------------------------------------------------------

interface StepCost { cost: number; allocs: Array<{ rowKey: string; index: number; cost: number; qtyShare: number | null; basis: PlannedAllocation["allocationBasis"] }>; }

function computeFrontCosts(
  front: Front, rows: ParsedBoqRow[], work: Map<string, StepWork>, instantiated: string[],
  overrides: BoqPlanOverrides
): Map<string, StepCost> {
  const template = PLANNING_TEMPLATES[front.templateKey];
  const costs = new Map<string, StepCost>();
  for (const sk of instantiated) costs.set(sk, { cost: 0, allocs: [] });
  for (const fr of front.rows) {
    const wt = overrides.workType[fr.classification.rowKey] || fr.classification.workType;
    const binding = WORK_TYPE_BINDING[wt as Exclude<BoqWorkType, "review_required">];
    if (!binding) continue;
    const row = rows[fr.index];
    const targets = binding.steps.filter((sk) => costs.has(sk));
    if (targets.length === 0) continue;
    const fund = fr.pieceCost !== undefined ? fr.pieceCost : row.total_price;
    const factor = row.quantity !== 0 ? fr.classification.quantityConverted / row.quantity : 0;
    const pieceQ = fr.pieceQty !== undefined ? fr.pieceQty * factor : fr.classification.quantityConverted;
    if (targets.length === 1) {
      const c = costs.get(targets[0])!;
      c.cost += fund;
      const step = template.steps.find((s) => s.key === targets[0])!;
      const qtyShare = step.unit && fr.classification.unit === step.unit ? pieceQ : null;
      c.allocs.push({ rowKey: fr.classification.rowKey, index: fr.index, cost: fund, qtyShare, basis: "single_step_full" });
    } else {
      const weights = targets.map((sk) => template.steps.find((s) => s.key === sk)!.costWeight);
      const parts = splitExact(fund, weights);
      targets.forEach((sk, i) => {
        const c = costs.get(sk)!;
        c.cost += parts[i];
        c.allocs.push({ rowKey: fr.classification.rowKey, index: fr.index, cost: parts[i], qtyShare: null, basis: "template_weight_split" });
      });
    }
  }
  return costs;
}
// -------------------------------------------------------------------------------------
// Activities: one per instantiated (front, step); intrinsic steps always instantiated
// -------------------------------------------------------------------------------------

interface BuiltSets {
  activities: PlannedActivity[];
  budgetLines: PlannedBudgetLine[];
  resources: PlannedResource[];
  assignments: PlannedAssignment[];
  allocations: PlannedAllocation[];
}

function buildActivities(
  fronts: Front[], rows: ParsedBoqRow[], wbs: PlannedWbs[], overrides: BoqPlanOverrides
): BuiltSets {
  const activities: PlannedActivity[] = [];
  const budgetLines: PlannedBudgetLine[] = [];
  const resources: PlannedResource[] = [];
  const assignments: PlannedAssignment[] = [];
  const allocations: PlannedAllocation[] = [];
  const resByCode = new Map<string, PlannedResource>();
  const wbsByFront = new Map<string, string>();
  for (const w of wbs) if (w.stableId.startsWith("wbs-front-")) wbsByFront.set(w.stableId.slice(4), w.stableId);

  let actSort = 0;
  let allocN = 0;
  for (const front of fronts) {
    const template = PLANNING_TEMPLATES[front.templateKey];
    const work = collectStepWork(front, rows, overrides);
    const instantiated = template.steps
      .filter((s) => s.kind === "intrinsic" || (work.get(s.key)?.rows.length || 0) > 0)
      .map((s) => s.key);
    const costs = computeFrontCosts(front, rows, work, instantiated, overrides);
    const wbsId = wbsByFront.get(front.id) || "wbs-root";
    const locSuffix = front.locationLabel ? ` — ${front.locationLabel}` : "";

    for (const step of template.steps) {
      if (!instantiated.includes(step.key)) continue;
      const stableId = `act-${front.id.slice(6)}-${step.key}`;
      const w = work.get(step.key)!;
      const dur = computeStepDuration(stableId, step.key, w, step.dailyOutput, step.defaultDays, step.defaultCrews, overrides);
      const cost = costs.get(step.key)!;
      const wbsFinal = overrides.wbs[stableId] && wbs.some((x) => x.stableId === overrides.wbs[stableId])
        ? overrides.wbs[stableId] : wbsId;
      actSort++;
      const qty = w.unit && w.qty > 0 ? Math.round(w.qty * 1000) / 1000 : null;
      activities.push({
        stableId, code: `A-${String(actSort).padStart(3, "0")}`,
        name: `${step.name}${locSuffix}`, wbsStableId: wbsFinal, sortOrder: actSort,
        isMilestone: false, milestoneKind: null, frontId: front.id,
        templateKey: front.templateKey, stepKey: step.key,
        quantity: qty, quantityUnit: qty !== null ? w.unit : null,
        durationDays: dur.days, durationBasis: dur.basis, durationNote: dur.note,
        plannedCost: Math.round(cost.cost * 100) / 100, crewCount: dur.crews,
        earlyStart: null, earlyFinish: null, lateStart: null, lateFinish: null,
        totalFloat: null, isCritical: false,
      });
      budgetLines.push({
        stableId: `bl-${stableId.slice(4)}`, activityStableId: stableId, wbsStableId: wbsFinal,
        description: `${step.name}${locSuffix}`, plannedCost: Math.round(cost.cost * 100) / 100,
      });
      for (const al of cost.allocs) {
        allocN++;
        allocations.push({
          stableId: `al-${String(allocN).padStart(4, "0")}`,
          activityStableId: stableId, rowKey: al.rowKey,
          quantityShare: al.qtyShare, costShare: Math.round(al.cost * 100) / 100,
          allocationBasis: al.basis,
        });
      }
      for (const line of step.crew) {
        let res = resByCode.get(line.code);
        if (!res) {
          res = { stableId: `res-${line.code}`, code: line.code, name: line.name, type: line.type, unit: line.unit };
          resByCode.set(line.code, res);
          resources.push(res);
        }
        assignments.push({
          stableId: `as-${stableId.slice(4)}-${line.code}`,
          activityStableId: stableId, resourceStableId: res.stableId,
          plannedQuantity: line.count * dur.crews, crewCount: dur.crews,
        });
      }
    }
  }
  resources.sort((a, b) => a.code.localeCompare(b.code));
  return { activities, budgetLines, resources, assignments, allocations };
}
// -------------------------------------------------------------------------------------
// Logic: template edges -> package sequence -> crew flow -> milestones -> user edits
// -------------------------------------------------------------------------------------

function actId(front: Front, stepKey: string): string {
  return `act-${front.id.slice(6)}-${stepKey}`;
}

function buildLogic(fronts: Front[], sets: BuiltSets, overrides: BoqPlanOverrides): PlannedLink[] {
  const links: PlannedLink[] = [];
  const actSet = new Set(sets.activities.map((a) => a.stableId));
  const exists = (id: string) => actSet.has(id);
  let n = 0;
  const add = (from: string, to: string, type: TemplateLinkType, lagDays: number, rule: string, origin: PlannedLink["origin"], ruleCode: string) => {
    if (!exists(from) || !exists(to) || from === to) return;
    if (links.some((l) => l.fromActivityId === from && l.toActivityId === to && l.type === type)) return;
    n++;
    links.push({ stableId: `lnk-${String(n).padStart(4, "0")}`, fromActivityId: from, toActivityId: to, type, lagDays, rule, origin, ruleCode, resourceKey: null });
  };

  // 1. Template edges (endpoints missing when a conditional step had no BOQ item).
  for (const front of fronts) {
    const template = PLANNING_TEMPLATES[front.templateKey];
    for (const e of template.links) {
      add(actId(front, e.from), actId(front, e.to), e.type, e.lagDays, `${template.key}: ${e.rule}`, "template", e.code);
    }
  }

  // 2. Package sequence per CROSS_FRONT_RULES (per-location chaining preferred).
  const byFamPkg = new Map<string, Front[]>();
  for (const f of fronts) {
    const k = `${f.family}|${f.packageKey}`;
    if (!byFamPkg.has(k)) byFamPkg.set(k, []);
    byFamPkg.get(k)!.push(f);
  }
  const lastOf = (f: Front): string | null => {
    const order = templateStepKeys(f.templateKey);
    const mine = sets.activities.filter((a) => a.frontId === f.id && a.stepKey);
    mine.sort((a, b) => order.indexOf(b.stepKey!) - order.indexOf(a.stepKey!));
    return mine[0]?.stableId || null;
  };
  const firstOf = (f: Front): string | null => {
    const order = templateStepKeys(f.templateKey);
    const mine = sets.activities.filter((a) => a.frontId === f.id && a.stepKey);
    mine.sort((a, b) => order.indexOf(a.stepKey!) - order.indexOf(b.stepKey!));
    return mine[0]?.stableId || null;
  };
  for (const rule of CROSS_FRONT_RULES) {
    const nonEmpty = rule.packageOrder.filter((p) => (byFamPkg.get(`${rule.family}|${p}`) || []).length > 0);
    for (let i = 0; i + 1 < nonEmpty.length; i++) {
      const prev = byFamPkg.get(`${rule.family}|${nonEmpty[i]}`) || [];
      const next = byFamPkg.get(`${rule.family}|${nonEmpty[i + 1]}`) || [];
      for (const nf of next) {
        const match = rule.perLocation ? prev.find((pf) => (pf.locationKey || "main") === (nf.locationKey || "main")) : undefined;
        const pf = match || prev[prev.length - 1];
        const from = lastOf(pf); const to = firstOf(nf);
        if (from && to) add(from, to, "FS", 0, `Sequence: ${pf.packageKey} -> ${nf.packageKey}${match ? " (same location)" : " (package fan)"}`, "sequence", match ? "ZONE_PROGRESSION" : "PACKAGE_PROGRESSION");
      }
    }
  }

  // 2b. Bridge RC fronts chain in template order (substructure -> vertical -> horizontal).
  const bridgeFronts = fronts.filter((f) => f.family === "bridges")
    .sort((a, b) => PLANNING_TEMPLATES[a.templateKey].order - PLANNING_TEMPLATES[b.templateKey].order);
  for (let i = 0; i + 1 < bridgeFronts.length; i++) {
    const from = lastOf(bridgeFronts[i]); const to = firstOf(bridgeFronts[i + 1]);
    if (from && to) add(from, to, "FS", 0, "Sequence: bridge RC template order", "sequence", "BRIDGE_TEMPLATE_ORDER");
  }

  // 2c. Kerb interleave: FS from pavement base, FF to wearing (same location preferred).
  const kerbFronts = fronts.filter((f) => f.templateKey === "ROAD_KERB_V1");
  const paveFronts = fronts.filter((f) => f.templateKey === "ROAD_PAVEMENT_V1");
  for (const kf of kerbFronts) {
    const pf = paveFronts.find((p) => (p.locationKey || "main") === (kf.locationKey || "main")) || paveFronts[0];
    if (!pf) continue;
    const kAct = actId(kf, "K");
    const baseActs = sets.activities.filter((a) => a.frontId === pf.id && a.stepKey === "B");
    const wearActs = sets.activities.filter((a) => a.frontId === pf.id && a.stepKey === "W");
    if (baseActs[0]) add(baseActs[0].stableId, kAct, "FS", 0, "Kerb starts after pavement base (same front chain)", "sequence", "KERB_FROM_BASE");
    if (wearActs[0]) add(kAct, wearActs[0].stableId, "FF", 0, "Kerbs finish with the wearing course", "sequence", "KERB_FINISH_WITH_WEARING");
    else if (baseActs[0]) {
      const last = lastOf(pf);
      if (last && last !== baseActs[0].stableId) add(kAct, last, "FF", 0, "Kerbs finish with pavement completion", "sequence", "KERB_FINISH_WITH_PAVEMENT");
    }
  }

  // 2d. F3 floor/zone progression inside superstructure: vertical(N) -> slab(N) ->
  // vertical(N+1). Same-location V->H first, then consecutive locations chain H->V.
  const superFronts = fronts.filter((f) => f.family === "building" && f.packageKey === "superstructure");
  const superByLoc = new Map<string, Front[]>();
  for (const f of superFronts) {
    const k = f.locationKey || "main";
    if (!superByLoc.has(k)) superByLoc.set(k, []);
    superByLoc.get(k)!.push(f);
  }
  const locOrder = (f: Front): [number, string] => [f.orderSeq === null ? 1 : 0, f.locationKey || "main"];
  const locs = [...superByLoc.keys()].sort((a, b) => {
    const fa = superByLoc.get(a)![0]; const fb = superByLoc.get(b)![0];
    const oa = locOrder(fa); const ob = locOrder(fb);
    const sa = fa.orderSeq === null ? Number.MAX_SAFE_INTEGER : fa.orderSeq;
    const sb = fb.orderSeq === null ? Number.MAX_SAFE_INTEGER : fb.orderSeq;
    return oa[0] - ob[0] || sa - sb || oa[1].localeCompare(ob[1]);
  });
  for (const loc of locs) {
    const members = superByLoc.get(loc)!;
    const vert = members.find((f) => f.templateKey === "RC_VERTICAL_V1");
    const horz = members.find((f) => f.templateKey === "RC_HORIZONTAL_V1");
    if (vert && horz) {
      const from = lastOf(vert); const to = firstOf(horz);
      if (from && to) add(from, to, "FS", 0, `Structural: columns/walls complete before slab (${loc})`, "sequence", "FLOOR_VERTICAL_TO_SLAB");
    }
  }
  for (let i = 0; i + 1 < locs.length; i++) {
    const horzPrev = superByLoc.get(locs[i])!.find((f) => f.templateKey === "RC_HORIZONTAL_V1");
    const vertNext = superByLoc.get(locs[i + 1])!.find((f) => f.templateKey === "RC_VERTICAL_V1");
    if (horzPrev && vertNext) {
      const from = lastOf(horzPrev); const to = firstOf(vertNext);
      if (from && to) add(from, to, "FS", 0, `Structural: slab ${locs[i]} complete before vertical ${locs[i + 1]}`, "sequence", "SLAB_TO_NEXT_VERTICAL");
    }
  }

  // 3. F3 crew continuity: the same crew cannot work two fronts at once. With k crews
  // the ordered fronts split into k contiguous lanes; chaining happens within a lane
  // only, so crew count changes the network itself (k=1 reproduces the F2 chain).
  const stepGroups = new Map<string, PlannedActivity[]>();
  for (const a of sets.activities) {
    if (a.isMilestone || !a.frontId || !a.stepKey) continue;
    const f = fronts.find((x) => x.id === a.frontId)!;
    const k = `${f.family}|${f.packageKey}|${f.templateKey}|${a.stepKey}`;
    if (!stepGroups.has(k)) stepGroups.set(k, []);
    stepGroups.get(k)!.push(a);
  }
  for (const [, group] of stepGroups) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => {
      const fa = fronts.find((x) => x.id === a.frontId)!;
      const fb = fronts.find((x) => x.id === b.frontId)!;
      const sa = fa.orderSeq === null ? Number.MAX_SAFE_INTEGER : fa.orderSeq;
      const sb = fb.orderSeq === null ? Number.MAX_SAFE_INTEGER : fb.orderSeq;
      return sa - sb || (fa.locationKey || "").localeCompare(fb.locationKey || "");
    });
    const k = Math.max(1, Math.min(...ordered.map((a) => a.crewCount)));
    if (k >= ordered.length) continue;
    const laneSize = Math.ceil(ordered.length / k);
    const f0 = fronts.find((x) => x.id === ordered[0].frontId)!;
    const sem = (STEP_SEMANTIC[f0.templateKey] || {})[ordered[0].stepKey || ""] || ordered[0].stepKey || "?";
    const crewName = PLANNING_TEMPLATES[f0.templateKey].steps.find((st) => st.key === ordered[0].stepKey)?.crew[0]?.name || "crew";
    for (let lane = 0; lane < k; lane++) {
      const members = ordered.slice(lane * laneSize, (lane + 1) * laneSize);
      for (let i = 0; i + 1 < members.length; i++) {
        add(members[i].stableId, members[i + 1].stableId, "FS", 0,
          `Crew continuity (${crewName}): lane ${lane + 1}/${k} across ${ordered.length} fronts with ${k} crew(s)`, "crewflow", `CREW_CONTINUITY_${sem}`);
      }
    }
  }
  // 4. Milestones: START/FINISH fan + package completion + testing-complete.
  const pkgOf = new Map<string, string>();
  for (const a of sets.activities) {
    if (!a.frontId) continue;
    const f = fronts.find((x) => x.id === a.frontId)!;
    pkgOf.set(a.stableId, `${f.family}|${f.packageKey}`);
  }
  let msSort = sets.activities.length;
  const addMs = (stableId: string, name: string, kind: "start" | "finish" | "package" | "testing", wbsId: string): string => {
    msSort++;
    sets.activities.push({
      stableId, code: `M-${String(msSort).padStart(3, "0")}`, name, wbsStableId: wbsId,
      sortOrder: msSort, isMilestone: true, milestoneKind: kind, frontId: null,
      templateKey: null, stepKey: null, quantity: null, quantityUnit: null,
      durationDays: 0, durationBasis: "template_default", durationNote: "Milestone (0d)",
      plannedCost: 0, crewCount: 0,
      earlyStart: null, earlyFinish: null, lateStart: null, lateFinish: null,
      totalFloat: null, isCritical: false,
    });
    actSet.add(stableId);
    return stableId;
  };
  const startMs = addMs("ms-start", "Start", "start", "wbs-root");
  const finishMs = addMs("ms-finish", "Finish", "finish", "wbs-root");

  // Package completion milestones (+ testing-complete where testing steps exist).
  const pkgs = new Map<string, PlannedActivity[]>();
  for (const a of sets.activities) {
    if (a.isMilestone || !pkgOf.has(a.stableId)) continue;
    const k = pkgOf.get(a.stableId)!;
    if (!pkgs.has(k)) pkgs.set(k, []);
    pkgs.get(k)!.push(a);
  }
  const pkgMsByPkg = new Map<string, string>();
  for (const [pkgKey, members] of [...pkgs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [fam, pkg] = pkgKey.split("|");
    const wbsId = `wbs-pkg-${slug(fam)}-${slug(pkg)}`;
    const label = PACKAGE_LABELS[pkg]?.en || pkg;
    const pkgMs = addMs(`ms-pkg-${slug(fam)}-${slug(pkg)}`, `${label} complete`, "package", wbsId);
    pkgMsByPkg.set(pkgKey, pkgMs);
    const hasSucc = new Set(links.map((l) => l.fromActivityId));
    for (const m of members) {
      if (!hasSucc.has(m.stableId)) add(m.stableId, pkgMs, "FS", 0, "Package completion fan-in", "milestone", "MILESTONE_PACKAGE_FANIN");
    }
    const tests = members.filter((m) => m.stepKey === "T");
    if (tests.length > 0) {
      const tMs = addMs(`ms-test-${slug(fam)}-${slug(pkg)}`, `${label} testing complete`, "testing", wbsId);
      for (const t of tests) add(t.stableId, tMs, "FS", 0, "Testing completion fan-in", "milestone", "MILESTONE_TEST_FANIN");
      add(tMs, pkgMs, "FS", 0, "Testing gates package completion", "milestone", "MILESTONE_TEST_GATE");
    }
    add(pkgMs, finishMs, "FS", 0, "Package completion to project finish", "milestone", "MILESTONE_TO_FINISH");
  }

  // START fan-out / FINISH fan-in AFTER all other logic (no unintended open ends).
  const hasPred = new Set(links.map((l) => l.toActivityId));
  const hasSucc = new Set(links.map((l) => l.fromActivityId));
  for (const a of [...sets.activities].sort((x, y) => x.sortOrder - y.sortOrder)) {
    if (a.stableId === startMs || a.stableId === finishMs) continue;
    if (a.isMilestone) continue;
    if (!hasPred.has(a.stableId)) add(startMs, a.stableId, "FS", 0, "Project start fan-out", "milestone", "MILESTONE_START_FANOUT");
    if (!hasSucc.has(a.stableId)) add(a.stableId, finishMs, "FS", 0, "Project finish fan-in", "milestone", "MILESTONE_FINISH_FANIN");
  }

  // 5. User link edits: removals first, then additions.
  const removed = new Set(overrides.removeLinks);
  const kept = links.filter((l) => !removed.has(l.stableId));
  links.length = 0;
  links.push(...kept);
  overrides.addLinks.forEach((u, i) => {
    if (!exists(u.fromActivityId) || !exists(u.toActivityId) || u.fromActivityId === u.toActivityId) return;
    links.push({
      stableId: `user-link-${i}`, fromActivityId: u.fromActivityId, toActivityId: u.toActivityId,
      type: u.type, lagDays: Math.max(0, Math.round(u.lagDays || 0)),
      rule: "User-added logic", origin: "user", ruleCode: "USER_LOGIC", resourceKey: null,
    });
  });
  return links;
}
// -------------------------------------------------------------------------------------
// CPM: the ONLY date math. Activities seed early_start = project start (deterministic
// defaultStart); every date the plan reports comes back from calculateCpm.
// -------------------------------------------------------------------------------------

function findCycleLocal(ids: string[], links: PlannedLink[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const l of links) {
    if (!graph.has(l.fromActivityId)) graph.set(l.fromActivityId, []);
    graph.get(l.fromActivityId)!.push(l.toActivityId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const next of graph.get(id) || []) {
      const c = visit(next);
      if (c) return c;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of ids) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

interface CpmAttachment {
  projectStart: string | null;
  projectFinish: string | null;
  cycle: string[] | null;
  failed: string | null;
}

export function runBoqCpm(
  activities: PlannedActivity[], links: PlannedLink[], profile: BoqPlanProfile
): CpmAttachment {
  const ids = activities.map((a) => a.stableId);
  const localCycle = findCycleLocal(ids, links);
  if (localCycle) return { projectStart: null, projectFinish: null, cycle: localCycle, failed: null };
  const cpmActs = activities.map((a) => ({
    id: a.stableId,
    project_id: "plan",
    wbs_node_id: null,
    code: a.code,
    name: a.name,
    duration_days: a.durationDays,
    percent_complete: 0,
    early_start: profile.startDate,
    early_finish: null,
    activity_type: a.isMilestone
      ? (a.milestoneKind === "start" ? "start_milestone" : "finish_milestone")
      : "task_dependent",
    is_milestone: a.isMilestone,
  } as unknown as Activity));
  const cpmLinks = links.map((l) => ({
    id: l.stableId,
    project_id: "plan",
    predecessor_id: l.fromActivityId,
    successor_id: l.toActivityId,
    link_type: l.type,
    lag_days: l.lagDays,
  } as unknown as ActivityLink));
  try {
    const calc = calculateCpm(cpmActs, cpmLinks, {
      calendarType: profile.calendarType,
      dataDate: profile.startDate,
      statusLogic: "retained_logic",
    });
    if (calc.cycle) return { projectStart: null, projectFinish: null, cycle: calc.cycle, failed: null };
    const byId = new Map(calc.results.map((r) => [r.activityId, r]));
    for (const a of activities) {
      const r = byId.get(a.stableId);
      if (!r) continue;
      a.earlyStart = r.earlyStart;
      a.earlyFinish = r.earlyFinish;
      a.lateStart = r.lateStart;
      a.lateFinish = r.lateFinish;
      a.totalFloat = r.totalFloat;
      a.isCritical = r.isCritical && !a.isMilestone;
    }
    return {
      projectStart: calc.projectEarlyStart ? calc.projectEarlyStart.slice(0, 10) : null,
      projectFinish: calc.projectEarlyFinish ? calc.projectEarlyFinish.slice(0, 10) : null,
      cycle: null, failed: null,
    };
  } catch (e) {
    return { projectStart: null, projectFinish: null, cycle: null, failed: (e as Error).message };
  }
}

function runCpm(
  sets: BuiltSets, links: PlannedLink[], profile: BoqPlanProfile
): CpmAttachment {
  return runBoqCpm(sets.activities, links, profile);
}
// -------------------------------------------------------------------------------------
// Validation: critical findings block Approved Baseline (never the save itself,
// except an empty or cyclic plan which cannot be scheduled at all)
// -------------------------------------------------------------------------------------

// -------------------------------------------------------------------------------------
// F3: cut/fill balance per mass-grading front. Cut and fill are independent BOQ
// quantities — never assumed equal; a haul balance is never invented.
// -------------------------------------------------------------------------------------

function buildMaterialBalance(fronts: Front[], rows: ParsedBoqRow[], overrides: BoqPlanOverrides): MaterialBalanceEntry[] {
  const out: MaterialBalanceEntry[] = [];
  for (const front of fronts) {
    if (front.templateKey !== "MASS_GRADING_V1") continue;
    const work = collectStepWork(front, rows, overrides);
    const cutQty = Math.round((work.get("E")?.qty || 0) * 1000) / 1000;
    const fillQty = Math.round((work.get("P")?.qty || 0) * 1000) / 1000;
    const unbalancedQty = Math.round((cutQty - fillQty) * 1000) / 1000;
    const haulRows = work.get("H")?.rows.length || 0;
    const haulStatus = haulRows > 0 ? "hauled-per-boq"
      : unbalancedQty > 0.001 ? "export-undefined"
      : unbalancedQty < -0.001 ? "import-undefined" : "balanced";
    out.push({
      frontId: front.id,
      label: front.locationLabel || "package level",
      cutQty, fillQty, unbalancedQty,
      haulStatus: haulStatus as MaterialBalanceEntry["haulStatus"],
    });
  }
  return out.sort((a, b) => a.frontId.localeCompare(b.frontId));
}

// F3: lightweight resource-feasibility sweep (validation only — no leveling engine).
function checkResourceFeasibility(sets: BuiltSets): PlanFinding[] {
  const F: PlanFinding[] = [];
  const resByStable = new Map(sets.resources.map((r) => [r.stableId, r]));
  const actsByRes = new Map<string, PlannedActivity[]>();
  for (const asn of sets.assignments) {
    const a = sets.activities.find((x) => x.stableId === asn.activityStableId);
    if (!a || a.isMilestone || !a.earlyStart || !a.earlyFinish) continue;
    if (!actsByRes.has(asn.resourceStableId)) actsByRes.set(asn.resourceStableId, []);
    actsByRes.get(asn.resourceStableId)!.push(a);
  }
  for (const [resStable, acts] of actsByRes) {
    const uniq = [...new Map(acts.map((a) => [a.stableId, a])).values()]
      .sort((x, y) => (x.earlyStart || "").localeCompare(y.earlyStart || ""));
    const capacity = Math.max(1, Math.min(...uniq.map((a) => a.crewCount)));
    let worst = 1;
    let worstDay = "";
    for (const a of uniq) {
      const day = a.earlyStart || "";
      const concurrent = uniq.filter((b) => (b.earlyStart || "") <= day && day <= (b.earlyFinish || "")).length;
      if (concurrent > worst) { worst = concurrent; worstDay = day; }
    }
    if (worst > capacity) {
      const code = resByStable.get(resStable)?.code || resStable;
      F.push({ severity: "warning", code: "resource_overallocation",
        message: `Crew ${code}: ${worst} overlapping activities on ${worstDay} exceed ${capacity} crew(s) — add crews or resequence`, refStableId: null });
    }
  }
  return F;
}

// F3: reachability over the non-milestone subgraph (milestone fan excluded).
function coreReachability(sets: BuiltSets, links: PlannedLink[]): Map<string, Set<string>> {
  const core = new Set(sets.activities.filter((a) => !a.isMilestone).map((a) => a.stableId));
  const succ = new Map<string, string[]>();
  for (const l of links) {
    if (!core.has(l.fromActivityId) || !core.has(l.toActivityId)) continue;
    if (!succ.has(l.fromActivityId)) succ.set(l.fromActivityId, []);
    succ.get(l.fromActivityId)!.push(l.toActivityId);
  }
  const reach = new Map<string, Set<string>>();
  for (const id of core) {
    const seen = new Set<string>();
    const stack = [...(succ.get(id) || [])];
    while (stack.length > 0) {
      const nx = stack.pop()!;
      if (seen.has(nx)) continue;
      seen.add(nx);
      stack.push(...(succ.get(nx) || []));
    }
    reach.set(id, seen);
  }
  return reach;
}

function validatePlan(
  rows: ParsedBoqRow[], classifications: BoqClassification[],
  fronts: Front[], sets: BuiltSets, links: PlannedLink[],
  usable: BoqClassification[], review: BoqClassification[],
  cpm: CpmAttachment, overrides: BoqPlanOverrides,
  distFlags: DistributionFlag[], materialBalance: MaterialBalanceEntry[]
): PlanFinding[] {
  const F: PlanFinding[] = [];
  const crit = (code: string, message: string, ref: string | null = null) => F.push({ severity: "critical", code, message, refStableId: ref });
  const warn = (code: string, message: string, ref: string | null = null) => F.push({ severity: "warning", code, message, refStableId: ref });
  const info = (code: string, message: string, ref: string | null = null) => F.push({ severity: "info", code, message, refStableId: ref });

  if (cpm.cycle) crit("cycle", `Logic cycle detected: ${cpm.cycle.join(" -> ")}`);
  if (cpm.failed) crit("cpm_failed", `CPM calculation failed: ${cpm.failed}`);

  // Cost completeness: every usable riyal allocated exactly once.
  const allocByRow = new Map<string, number>();
  for (const al of sets.allocations) {
    allocByRow.set(al.rowKey, (allocByRow.get(al.rowKey) || 0) + al.costShare);
  }
  for (const c of usable) {
    const idx = Number(c.rowKey.slice(4)) - 1;
    const total = rows[idx]?.total_price || 0;
    const alloc = allocByRow.get(c.rowKey) || 0;
    if (Math.abs(total - alloc) > 0.005) {
      crit("unallocated_cost", `BOQ ${rows[idx]?.code}: total ${total.toLocaleString()} vs allocated ${alloc.toLocaleString()}`, c.rowKey);
    }
  }
  // Duplicate-allocation tripwire (same pair twice).
  const seenPairs = new Set<string>();
  for (const al of sets.allocations) {
    const k = `${al.activityStableId}|${al.rowKey}`;
    if (seenPairs.has(k)) crit("duplicated_cost", `Duplicate allocation ${k}`, al.activityStableId);
    seenPairs.add(k);
  }

  // Every usable row feeds >= 1 activity; every non-milestone activity has a basis.
  const rowsFed = new Set(sets.allocations.map((a) => a.rowKey));
  for (const c of usable) {
    if (!rowsFed.has(c.rowKey)) crit("boq_without_activity", `BOQ ${c.rowKey} classified usable but feeds no activity`, c.rowKey);
  }
  const actsFed = new Set(sets.allocations.map((a) => a.activityStableId));
  for (const a of sets.activities) {
    if (a.isMilestone) continue;
    const isIntrinsic = a.stepKey && PLANNING_TEMPLATES[a.templateKey!].steps.find((s) => s.key === a.stepKey)?.kind === "intrinsic";
    if (!actsFed.has(a.stableId) && !isIntrinsic) {
      crit("activity_without_provenance", `${a.code} ${a.name}: no BOQ allocation and not an intrinsic step`, a.stableId);
    }
    if (a.durationBasis === "review") {
      crit("placeholder_duration", `${a.code} ${a.name}: duration needs review (${a.durationNote})`, a.stableId);
    }
    if (!a.earlyStart || !a.earlyFinish) {
      crit("invalid_dates", `${a.code} ${a.name}: missing CPM dates`, a.stableId);
    }
    if (a.durationDays > 60) warn("excessive_duration", `${a.code} ${a.name}: ${a.durationDays}d exceeds 60d — verify`, a.stableId);
  }

  // Unconfirmed medium classifications block approval (the review workflow gate).
  for (const c of usable) {
    if (c.confidence === "medium" && !overrides.confirmed[c.rowKey]) {
      const wt = overrides.workType[c.rowKey];
      if (!wt) crit("classification_unconfirmed", `BOQ ${c.rowKey}: medium-confidence "${c.workType}" needs confirmation`, c.rowKey);
    }
  }

  // Open ends (non-milestone): impossible by construction — tripwire stays.
  const hasPred = new Set(links.map((l) => l.toActivityId));
  const hasSucc = new Set(links.map((l) => l.fromActivityId));
  for (const a of sets.activities) {
    if (a.isMilestone) continue;
    if (!hasPred.has(a.stableId)) warn("open_start", `${a.code} ${a.name}: no predecessor`, a.stableId);
    if (!hasSucc.has(a.stableId)) warn("open_finish", `${a.code} ${a.name}: no successor`, a.stableId);
  }

  // F3: distribution flags (mismatch blocks approval — the split did not apply).
  for (const d of distFlags) {
    if (d.kind === "mismatch") crit("distribution_mismatch", `BOQ ${d.rowKey}: ${d.message}`, d.rowKey);
    else warn("distribution_unparseable", `BOQ ${d.rowKey}: ${d.message}`, d.rowKey);
  }

  // F3: multi-location rows keep their first hint; the rest need explicit distribution.
  for (const c of usable) {
    const idx = Number(c.rowKey.slice(4)) - 1;
    const extra = extraLocationHints(rows[idx]?.description || "", rows[idx]?.section || "");
    if (extra.length > 0) {
      info("multi_location_row", `BOQ ${c.rowKey}: additional location hints ignored (${extra.join(", ")}) — distribute quantity explicitly to use them`, c.rowKey);
    }
  }

  // F3: material balance exposure (cut/fill independent; haul never invented).
  for (const mb of materialBalance) {
    info("material_balance", `Grading ${mb.label}: cut ${mb.cutQty} m3, fill ${mb.fillQty} m3, unbalanced ${mb.unbalancedQty} m3 (${mb.haulStatus})`, null);
    if (mb.haulStatus === "export-undefined" || mb.haulStatus === "import-undefined") {
      warn("haul_balance_review", `Grading ${mb.label}: ${Math.abs(mb.unbalancedQty).toLocaleString()} m3 ${mb.haulStatus === "export-undefined" ? "surplus with no export/destination in source" : "shortfall with no import/borrow in source"} — Review Required`, null);
    }
  }

  // F3: resource feasibility (lightweight — no leveling engine).
  for (const a of sets.activities) {
    if (a.isMilestone || a.durationBasis !== "library_rate") continue;
    if (!sets.assignments.some((x) => x.activityStableId === a.stableId)) {
      crit("missing_crew", `${a.code} ${a.name}: production-based activity has no crew assignment`, a.stableId);
    }
  }
  for (const [actId, rate] of Object.entries(overrides.rate)) {
    if (!(rate > 0)) warn("impossible_rate", `Activity ${actId}: user rate ${rate} is not positive — library rate used instead`, actId);
  }
  F.push(...checkResourceFeasibility(sets));

  // F3: crew count allows parallelism but the network serialized the fronts anyway.
  {
    const reach = coreReachability(sets, links);
    const laneGroups = new Map<string, PlannedActivity[]>();
    for (const a of sets.activities) {
      if (a.isMilestone || !a.frontId || !a.stepKey) continue;
      const f = fronts.find((x) => x.id === a.frontId)!;
      const k = `${f.family}|${f.packageKey}|${f.templateKey}|${a.stepKey}`;
      if (!laneGroups.has(k)) laneGroups.set(k, []);
      laneGroups.get(k)!.push(a);
    }
    for (const [, group] of laneGroups) {
      if (group.length < 2) continue;
      const k = Math.max(1, Math.min(...group.map((a) => a.crewCount)));
      if (k < 2) continue;
      let serialized = true;
      for (let i = 0; i < group.length && serialized; i++) {
        for (let j = 0; j < group.length && serialized; j++) {
          if (i === j) continue;
          const ri = reach.get(group[i].stableId)!;
          const rj = reach.get(group[j].stableId)!;
          if (!ri.has(group[j].stableId) && !rj.has(group[i].stableId)) serialized = false;
        }
      }
      if (serialized) warn("crew_parallelism_unused", `Step ${group[0].stepKey}: ${k} crews available but all ${group.length} fronts serialized — verify logic`, null);
    }
  }

  const sysGroups = new Map<string, Set<string>>();
  for (const f of fronts) {
    const k = `${f.family}|${f.templateKey}|${f.locationKey || "main"}`;
    if (!sysGroups.has(k)) sysGroups.set(k, new Set());
    sysGroups.get(k)!.add(f.packageKey);
  }
  for (const [k, pkgs] of sysGroups) {
    if (pkgs.size > 1) {
      warn("split_system_chain", `System ${k} spans packages (${[...pkgs].join(", ")}) — template chain split across fronts; verify sections`, null);
    }
  }

  // One-chain anomaly: non-milestone subgraph is a single path (milestone fan excluded).
  const core = sets.activities.filter((a) => !a.isMilestone);
  const coreLinks = links.filter((l) => {
    const f = sets.activities.find((a) => a.stableId === l.fromActivityId);
    const t = sets.activities.find((a) => a.stableId === l.toActivityId);
    return f && t && !f.isMilestone && !t.isMilestone;
  });
  if (core.length >= 3) {
    const indeg = new Map<string, number>();
    const outdeg = new Map<string, number>();
    for (const l of coreLinks) {
      indeg.set(l.toActivityId, (indeg.get(l.toActivityId) || 0) + 1);
      outdeg.set(l.fromActivityId, (outdeg.get(l.fromActivityId) || 0) + 1);
    }
    const starts = core.filter((a) => (indeg.get(a.stableId) || 0) === 0);
    const ends = core.filter((a) => (outdeg.get(a.stableId) || 0) === 0);
    const singlePath = starts.length === 1 && ends.length === 1
      && coreLinks.length === core.length - 1
      && core.every((a) => (indeg.get(a.stableId) || 0) <= 1 && (outdeg.get(a.stableId) || 0) <= 1);
    if (singlePath) warn("one_fs_chain", "Network is a single chain — verify no missing parallelism", null);
  }

  // Critical-path plausibility + misc warnings.
  const critN = core.filter((a) => a.isCritical).length;
  if (core.length > 0 && critN / core.length > 0.9) {
    warn("all_critical", `${Math.round((critN / core.length) * 100)}% of activities critical — verify logic`, null);
  }
  for (const l of links) {
    if (l.lagDays > 5) warn("excessive_lag", `Link ${l.stableId}: lag ${l.lagDays}d exceeds 5d`, l.stableId);
  }

  // Informational provenance notes.
  for (const a of sets.activities) {
    if (a.isMilestone) continue;
    if (a.plannedCost === 0) info("intrinsic_zero_cost", `${a.code} ${a.name}: zero cost (${a.durationNote})`, a.stableId);
    if (a.durationBasis === "template_default") info("template_default_duration", `${a.code} ${a.name}: ${a.durationNote}`, a.stableId);
  }
  const noLocFronts = fronts.filter((f) => !f.locationKey);
  if (noLocFronts.length > 0) {
    info("location_unavailable", `${noLocFronts.length} front(s) at package level — no location hints in source`, null);
  }
  for (const c of review) {
    info("review_item_skipped", `BOQ ${c.rowKey}: review-required, excluded from plan (${c.reason})`, c.rowKey);
  }
  return F;
}
// -------------------------------------------------------------------------------------
// Reconciliation + public entry point
// -------------------------------------------------------------------------------------

function buildRecon(
  rows: ParsedBoqRow[], sets: BuiltSets, links: PlannedLink[], wbs: PlannedWbs[],
  usable: BoqClassification[], review: BoqClassification[], cpm: CpmAttachment,
  materialBalance: MaterialBalanceEntry[]
): BoqPlanRecon {
  const boqTotal = rows.reduce((a, r) => a + (Number.isFinite(r.total_price) ? r.total_price : 0), 0);
  const allocatedTotal = sets.allocations.reduce((a, x) => a + x.costShare, 0);
  const core = sets.activities.filter((a) => !a.isMilestone);
  const criticalCount = core.filter((a) => a.isCritical).length;
  let spanDays = 0;
  if (cpm.projectStart && cpm.projectFinish) {
    spanDays = Math.round((new Date(cpm.projectFinish).getTime() - new Date(cpm.projectStart).getTime()) / 86400000) + 1;
  }
  return {
    boqTotal: Math.round(boqTotal * 100) / 100,
    allocatedTotal: Math.round(allocatedTotal * 100) / 100,
    unallocatedTotal: Math.round((boqTotal - allocatedTotal) * 100) / 100,
    usableItemCount: usable.length,
    reviewItemCount: review.length,
    activityCount: core.length,
    milestoneCount: sets.activities.length - core.length,
    linkCount: links.length,
    wbsCount: wbs.length,
    budgetLineCount: sets.budgetLines.length,
    resourceCount: sets.resources.length,
    allocationCount: sets.allocations.length,
    criticalCount,
    criticalPct: core.length > 0 ? Math.round((criticalCount / core.length) * 1000) / 10 : 0,
    projectStart: cpm.projectStart,
    projectFinish: cpm.projectFinish,
    spanDays,
    materialBalance,
  };
}

export function generateBoqPlan(
  rows: ParsedBoqRow[],
  profile: BoqPlanProfile,
  overrides: BoqPlanOverrides = EMPTY_BOQ_OVERRIDES
): BoqPlan {
  const classifications = rows.map((row, i) => classifyBoqRow(row, `boq-${String(i + 1).padStart(4, "0")}`));
  const { fronts, usable, review, distFlags } = buildFronts(rows, classifications, overrides);
  const wbs = buildWbs(profile.projectName, fronts);
  const sets = buildActivities(fronts, rows, wbs, overrides);
  const links = buildLogic(fronts, sets, overrides);
  // Milestone WBS ids follow the buildWbs naming convention; remap any miss to root.
  const wbsIds = new Set(wbs.map((w) => w.stableId));
  for (const a of sets.activities) {
    if (!wbsIds.has(a.wbsStableId)) a.wbsStableId = "wbs-root";
  }
  const cpm = sets.activities.length > 0
    ? runCpm(sets, links, profile)
    : { projectStart: null, projectFinish: null, cycle: null, failed: null };
  const materialBalance = buildMaterialBalance(fronts, rows, overrides);

  // ---- F4: resource-constrained scheduling ----
  // Unconstrained CPM above is the engineering baseline. When the policy is
  // "respect-resources", the leveler adds FS-0 resource links (only) and reruns
  // the SAME canonical CPM; the plan below then carries the feasible schedule
  // while `leveling.unconstrained` preserves the baseline for comparison.
  const levelingOpts: LevelingOptions = overrides.leveling || { policy: "logic-only", capacities: {}, targetFinish: null, waivedPools: [] };
  const frontOrder = new Map(fronts.map((f) => [f.id, f.orderSeq]));
  const rerun = (acts: PlannedActivity[], lks: PlannedLink[]) => {
    const att = runBoqCpm(acts, lks, profile);
    if (att.cycle || att.failed) return null;
    return { projectFinish: att.projectFinish };
  };
  const canLevel = !cpm.cycle && !cpm.failed && sets.activities.some((a) => !a.isMilestone);
  const { demands, pools } = canLevel
    ? buildPoolDemands(sets.activities, sets.assignments, sets.resources)
    : { demands: [], pools: [] as string[] };
  const resolved = resolveCapacities(demands, pools, levelingOpts.capacities || {});
  const uncConflicts: PoolConflict[] = canLevel ? detectPoolConflicts(sets.activities, demands, resolved.capacities) : [];
  const uncSnap = snapshotState(sets.activities, uncConflicts);

  let finalActs = sets.activities;
  let finalLinks = links;
  let attributions: LevelAttribution[] = [];
  let conConflicts: PoolConflict[] = uncConflicts;
  const infeasible: ResourceLevelingReport["infeasible"] = [];
  if (canLevel && levelingOpts.policy === "respect-resources") {
    const out = levelBoqResources({
      activities: sets.activities, links,
      assignments: sets.assignments, resources: sets.resources,
      frontOrder, capacities: levelingOpts.capacities || {},
      calendarType: profile.calendarType, rerun,
    });
    const uncES = new Map(sets.activities.map((a) => [a.stableId, a.earlyStart]));
    const conById = new Map(out.activities.map((a) => [a.stableId, a]));
    for (const at of out.attributions) {
      const shift = workingDayDelta(uncES.get(at.toActivityId) || null, conById.get(at.toActivityId)?.earlyStart || null, profile.calendarType) || 0;
      at.delayDays = Math.max(0, shift);
    }
    finalActs = out.activities;
    finalLinks = out.links;
    attributions = out.attributions;
    conConflicts = out.conflictsAfter;
    infeasible.push(...out.infeasible);
  }
  const conStarts = finalActs.map((a) => a.earlyStart).filter((x): x is string => !!x).sort();
  const conSnap = snapshotState(finalActs, conConflicts);
  const finalCpm: CpmAttachment = canLevel
    ? { projectStart: conStarts[0] || null, projectFinish: conSnap.projectFinish, cycle: null, failed: null }
    : cpm;
  const poolStats = classifyPools(pools, sets.resources, uncConflicts, attributions, resolved.capacities, resolved.provenance, finalActs);
  const resourceDelayDays = Math.max(0, workingDayDelta(uncSnap.projectFinish, conSnap.projectFinish, profile.calendarType) || 0);
  const criticalChanged = JSON.stringify(uncSnap.criticalStableIds) !== JSON.stringify(conSnap.criticalStableIds);

  const targetRaw = (levelingOpts.targetFinish || "").trim();
  const targetValid = /^\d{4}-\d{2}-\d{2}$/.test(targetRaw) && !Number.isNaN(new Date(`${targetRaw}T00:00:00Z`).getTime());
  const targetFinish = targetValid ? targetRaw : null;
  const feasibleFinish = conSnap.projectFinish;
  const targetVarianceDays = targetFinish && feasibleFinish
    ? workingDayDelta(targetFinish, feasibleFinish, profile.calendarType) : null;
  const targetMet = targetVarianceDays === null ? null : targetVarianceDays <= 0;

  // F4: capacity scenarios from ACTUAL reruns (never estimates), only when an
  // applied feasible plan misses its target. Never auto-applied. Top 5.
  let recommendations: CapacityRecommendation[] = [];
  if (canLevel && levelingOpts.policy === "respect-resources" && targetFinish && feasibleFinish && feasibleFinish > targetFinish) {
    const afterKeys = new Set(conConflicts.map((c) => c.poolKey));
    const cands = poolStats.filter((pl) =>
      pl.peakDemand > pl.capacity && (pl.criticalAffected + pl.nearCriticalAffected > 0 || afterKeys.has(pl.poolKey)));
    const scored: CapacityRecommendation[] = [];
    for (const cand of [...cands].sort((a, b) => a.poolKey.localeCompare(b.poolKey))) {
      const caps2 = { ...(levelingOpts.capacities || {}), [cand.poolKey]: cand.capacity + 1 };
      const trial = levelBoqResources({
        activities: sets.activities, links,
        assignments: sets.assignments, resources: sets.resources,
        frontOrder, capacities: caps2,
        calendarType: profile.calendarType, rerun,
      });
      const trialSnap = snapshotState(trial.activities, trial.conflictsAfter);
      const saved = Math.max(0, workingDayDelta(trialSnap.projectFinish, feasibleFinish, profile.calendarType) || 0);
      scored.push({
        poolKey: cand.poolKey, currentCapacity: cand.capacity, candidateCapacity: cand.capacity + 1,
        newFinish: trialSnap.projectFinish, daysSaved: saved,
        remainingConflicts: trial.conflictsAfter.length,
        costImpact: "N/A — no authoritative rate", basis: "actual-rerun",
      });
    }
    recommendations = scored
      .filter((x) => x.daysSaved > 0 || x.remainingConflicts < conConflicts.length)
      .sort((a, b) => b.daysSaved - a.daysSaved || a.remainingConflicts - b.remainingConflicts || a.poolKey.localeCompare(b.poolKey))
      .slice(0, 5);
  }

  const leveling: ResourceLevelingReport = {
    applied: canLevel && levelingOpts.policy === "respect-resources",
    policy: levelingOpts.policy,
    unconstrained: uncSnap,
    constrained: conSnap,
    resourceDelayDays, criticalChanged, attributions, pools: poolStats,
    targetFinish, targetVarianceDays, targetMet, recommendations,
    infeasible, invalidCapacities: resolved.invalid,
  };

  const finalSets: BuiltSets = { ...sets, activities: finalActs };
  const findings = validatePlan(rows, classifications, fronts, finalSets, finalLinks, usable, review, finalCpm, overrides, distFlags, materialBalance);

  // F4 leveling findings (appended after engineering validation, deterministic order).
  const waived = new Set(levelingOpts.waivedPools || []);
  for (const ic of resolved.invalid) {
    findings.push({ severity: "warning", code: "invalid_capacity_override",
      message: `Resource ${ic.poolKey}: capacity override ${ic.value} ignored (want an integer >= 1) — default used`, refStableId: null });
  }
  for (const c of [...conConflicts].sort((a, b) => a.poolKey.localeCompare(b.poolKey))) {
    if (waived.has(c.poolKey)) {
      findings.push({ severity: "info", code: "resource_waiver_applied",
        message: `Resource ${c.poolKey}: remaining over-allocation explicitly waived (peak ${c.peakDemand} vs capacity ${c.capacity})`, refStableId: null });
    } else {
      findings.push({ severity: "critical", code: "unresolved_resource_overallocation",
        message: `Resource ${c.poolKey}: peak demand ${c.peakDemand} exceeds capacity ${c.capacity}${c.peakDay ? ` on ${c.peakDay}` : ""} (${c.activityStableIds.length} activit${c.activityStableIds.length === 1 ? "y" : "ies"}) — increase capacity, accept leveling, or resequence`, refStableId: null });
    }
  }
  const finById = new Map(finalActs.map((a) => [a.stableId, a]));
  for (const inf of infeasible) {
    if (inf.aStableId === inf.bStableId) continue; // single-activity deficit: covered by the unresolved critical above
    const A = finById.get(inf.aStableId);
    const B = finById.get(inf.bStableId);
    const overlap = A && B && A.earlyStart && A.earlyFinish && B.earlyStart && B.earlyFinish
      && A.earlyStart <= B.earlyFinish && B.earlyStart <= A.earlyFinish;
    if (overlap) {
      findings.push({ severity: "warning", code: "resource_leveling_infeasible",
        message: `Resource ${inf.poolKey}: ${A!.code} <-> ${B!.code} cannot be sequenced — ${inf.reason}`, refStableId: null });
    }
  }
  if (leveling.applied && attributions.length > 0) {
    findings.push({ severity: "info", code: "resource_leveling_applied",
      message: `Resource leveling added ${attributions.length} constraint link(s); feasible finish +${resourceDelayDays} working day(s) vs unconstrained`, refStableId: null });
  }
  if (targetRaw && !targetValid) {
    findings.push({ severity: "warning", code: "invalid_target_finish",
      message: `Target finish "${targetRaw}" ignored (want yyyy-mm-dd)`, refStableId: null });
  }
  if (targetFinish && targetVarianceDays !== null) {
    findings.push({ severity: "info", code: "target_variance",
      message: `Feasible finish ${feasibleFinish} vs target ${targetFinish}: ${targetVarianceDays > 0 ? "+" : ""}${targetVarianceDays} working days${targetMet ? " (target met)" : " (target missed — see capacity recommendations)"}`, refStableId: null });
  }

  const recon = buildRecon(rows, finalSets, finalLinks, wbs, usable, review, finalCpm, materialBalance);

  const hasCycle = finalCpm.cycle !== null;
  const isEmpty = finalActs.filter((a) => !a.isMilestone).length === 0;
  const canSave = !hasCycle && !isEmpty;
  const saveBlockReason = hasCycle
    ? `Logic cycle: ${finalCpm.cycle!.join(" -> ")}`
    : isEmpty ? "Plan is empty: no usable BOQ item produced an activity" : null;
  const canApproveBaseline = canSave && !findings.some((f) => f.severity === "critical");

  return {
    profile, classifications, wbs,
    activities: [...finalActs].sort((a, b) => a.sortOrder - b.sortOrder),
    links: finalLinks, budgetLines: sets.budgetLines, resources: sets.resources,
    assignments: sets.assignments, allocations: sets.allocations,
    findings, recon, canSave, saveBlockReason, canApproveBaseline, leveling,
  };
}

export function emptyBoqOverrides(): BoqPlanOverrides {
  return {
    workType: {}, confirmed: {}, excludedFamilies: [], location: {},
    duration: {}, rate: {}, crews: {}, wbs: {}, removeLinks: [], addLinks: [],
    sequence: {}, distribution: {},
    leveling: { policy: "respect-resources", capacities: {}, targetFinish: null, waivedPools: [] },
  };
}
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
  origin: "template" | "sequence" | "crewflow" | "milestone" | "user";
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

interface FrontRow { index: number; classification: BoqClassification; }

interface Front {
  id: string;
  family: BoqFamily;
  packageKey: string;
  templateKey: PlanningTemplateKey;
  locationKey: string | null;
  locationLabel: string | null;
  rows: FrontRow[];
}

function buildFronts(
  rows: ParsedBoqRow[],
  classifications: BoqClassification[],
  overrides: BoqPlanOverrides
): { fronts: Front[]; usable: BoqClassification[]; review: BoqClassification[] } {
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
  const groups = new Map<string, Front>();
  usable.forEach((c) => {
    const wt = overrides.workType[c.rowKey] || c.workType;
    const binding = WORK_TYPE_BINDING[wt as Exclude<BoqWorkType, "review_required">];
    const index = Number(c.rowKey.slice(4)) - 1;
    const locOverride = overrides.location[c.rowKey];
    const locationKey = locOverride ? `user:${slug(locOverride)}` : (c.locationHint ? c.locationHint.key : null);
    const locationLabel = locOverride || (c.locationHint ? c.locationHint.label : null);
    const key = `${c.family}|${c.packageKey}|${binding.template}|${locationKey || "main"}`;
    let front = groups.get(key);
    if (!front) {
      front = {
        id: `front-${slug(c.family)}-${slug(c.packageKey)}-${slug(binding.template)}-${slug(locationKey || "main")}`,
        family: c.family, packageKey: c.packageKey,
        templateKey: binding.template as PlanningTemplateKey,
        locationKey, locationLabel, rows: [],
      };
      groups.set(key, front);
    }
    front.rows.push({ index, classification: c });
  });
  const fronts = [...groups.values()].sort((a, b) =>
    FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)
    || (PACKAGE_ORDER[a.packageKey] || 999) - (PACKAGE_ORDER[b.packageKey] || 999)
    || PLANNING_TEMPLATES[a.templateKey].order - PLANNING_TEMPLATES[b.templateKey].order
    || (a.locationKey || "").localeCompare(b.locationKey || "")
  );
  for (const f of fronts) f.rows.sort((x, y) => x.index - y.index);
  return { fronts, usable, review };
}

// -------------------------------------------------------------------------------------
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
  rows: Array<{ index: number; classification: BoqClassification; row: ParsedBoqRow }>;
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
    for (const sk of binding.steps) {
      const w = work.get(sk);
      if (!w) continue;
      w.rows.push({ index: fr.index, classification: fr.classification, row });
      const step = template.steps.find((s) => s.key === sk)!;
      if (step.unit && fr.classification.unit === step.unit) w.qty += fr.classification.quantityConverted;
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
  const rate = (overrides.rate[activityId] && overrides.rate[activityId] > 0)
    ? overrides.rate[activityId] : dailyOutput;
  if (rate && rate > 0 && w.qty > 0 && w.unit) {
    const days = Math.max(1, Math.ceil(w.qty / (rate * crews)));
    const q = w.qty.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return { days, basis: "library_rate", note: `${q} ${w.unit} @ ${rate}/d x ${crews} crew(s)`, crews };
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
    if (targets.length === 1) {
      const c = costs.get(targets[0])!;
      c.cost += row.total_price;
      const step = template.steps.find((s) => s.key === targets[0])!;
      const qtyShare = step.unit && fr.classification.unit === step.unit ? fr.classification.quantityConverted : null;
      c.allocs.push({ rowKey: fr.classification.rowKey, index: fr.index, cost: row.total_price, qtyShare, basis: "single_step_full" });
    } else {
      const weights = targets.map((sk) => template.steps.find((s) => s.key === sk)!.costWeight);
      const parts = splitExact(row.total_price, weights);
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
  const add = (from: string, to: string, type: TemplateLinkType, lagDays: number, rule: string, origin: PlannedLink["origin"]) => {
    if (!exists(from) || !exists(to) || from === to) return;
    if (links.some((l) => l.fromActivityId === from && l.toActivityId === to && l.type === type)) return;
    n++;
    links.push({ stableId: `lnk-${String(n).padStart(4, "0")}`, fromActivityId: from, toActivityId: to, type, lagDays, rule, origin });
  };

  // 1. Template edges (endpoints missing when a conditional step had no BOQ item).
  for (const front of fronts) {
    const template = PLANNING_TEMPLATES[front.templateKey];
    for (const e of template.links) {
      add(actId(front, e.from), actId(front, e.to), e.type, e.lagDays, `${template.key}: ${e.rule}`, "template");
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
        if (from && to) add(from, to, "FS", 0, `Sequence: ${pf.packageKey} -> ${nf.packageKey}${match ? " (same location)" : " (package fan)"}`, "sequence");
      }
    }
  }

  // 2b. Bridge RC fronts chain in template order (substructure -> vertical -> horizontal).
  const bridgeFronts = fronts.filter((f) => f.family === "bridges")
    .sort((a, b) => PLANNING_TEMPLATES[a.templateKey].order - PLANNING_TEMPLATES[b.templateKey].order);
  for (let i = 0; i + 1 < bridgeFronts.length; i++) {
    const from = lastOf(bridgeFronts[i]); const to = firstOf(bridgeFronts[i + 1]);
    if (from && to) add(from, to, "FS", 0, "Sequence: bridge RC template order", "sequence");
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
    if (baseActs[0]) add(baseActs[0].stableId, kAct, "FS", 0, "Kerb starts after pavement base (same front chain)", "sequence");
    if (wearActs[0]) add(kAct, wearActs[0].stableId, "FF", 0, "Kerbs finish with the wearing course", "sequence");
    else if (baseActs[0]) {
      const last = lastOf(pf);
      if (last && last !== baseActs[0].stableId) add(kAct, last, "FF", 0, "Kerbs finish with pavement completion", "sequence");
    }
  }

  // 3. Crew flow: same (family, package, template, step) across locations chains FS
  // when every instantiation runs a single crew.
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
    if (!group.every((a) => a.crewCount === 1)) continue;
    const ordered = [...group].sort((a, b) => {
      const fa = fronts.find((x) => x.id === a.frontId)!;
      const fb = fronts.find((x) => x.id === b.frontId)!;
      return (fa.locationKey || "").localeCompare(fb.locationKey || "");
    });
    for (let i = 0; i + 1 < ordered.length; i++) {
      add(ordered[i].stableId, ordered[i + 1].stableId, "FS", 0,
        `Crew flow: single crew moves ${ordered[i].stepKey} across locations`, "crewflow");
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
      if (!hasSucc.has(m.stableId)) add(m.stableId, pkgMs, "FS", 0, "Package completion fan-in", "milestone");
    }
    const tests = members.filter((m) => m.stepKey === "T");
    if (tests.length > 0) {
      const tMs = addMs(`ms-test-${slug(fam)}-${slug(pkg)}`, `${label} testing complete`, "testing", wbsId);
      for (const t of tests) add(t.stableId, tMs, "FS", 0, "Testing completion fan-in", "milestone");
      add(tMs, pkgMs, "FS", 0, "Testing gates package completion", "milestone");
    }
    add(pkgMs, finishMs, "FS", 0, "Package completion to project finish", "milestone");
  }

  // START fan-out / FINISH fan-in AFTER all other logic (no unintended open ends).
  const hasPred = new Set(links.map((l) => l.toActivityId));
  const hasSucc = new Set(links.map((l) => l.fromActivityId));
  for (const a of [...sets.activities].sort((x, y) => x.sortOrder - y.sortOrder)) {
    if (a.stableId === startMs || a.stableId === finishMs) continue;
    if (a.isMilestone) continue;
    if (!hasPred.has(a.stableId)) add(startMs, a.stableId, "FS", 0, "Project start fan-out", "milestone");
    if (!hasSucc.has(a.stableId)) add(a.stableId, finishMs, "FS", 0, "Project finish fan-in", "milestone");
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
      rule: "User-added logic", origin: "user",
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

function runCpm(
  sets: BuiltSets, links: PlannedLink[], profile: BoqPlanProfile
): CpmAttachment {
  const ids = sets.activities.map((a) => a.stableId);
  const localCycle = findCycleLocal(ids, links);
  if (localCycle) return { projectStart: null, projectFinish: null, cycle: localCycle, failed: null };
  const cpmActs = sets.activities.map((a) => ({
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
    for (const a of sets.activities) {
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
// -------------------------------------------------------------------------------------
// Validation: critical findings block Approved Baseline (never the save itself,
// except an empty or cyclic plan which cannot be scheduled at all)
// -------------------------------------------------------------------------------------

function validatePlan(
  rows: ParsedBoqRow[], classifications: BoqClassification[],
  fronts: Front[], sets: BuiltSets, links: PlannedLink[],
  usable: BoqClassification[], review: BoqClassification[],
  cpm: CpmAttachment, overrides: BoqPlanOverrides
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
  usable: BoqClassification[], review: BoqClassification[], cpm: CpmAttachment
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
  };
}

export function generateBoqPlan(
  rows: ParsedBoqRow[],
  profile: BoqPlanProfile,
  overrides: BoqPlanOverrides = EMPTY_BOQ_OVERRIDES
): BoqPlan {
  const classifications = rows.map((row, i) => classifyBoqRow(row, `boq-${String(i + 1).padStart(4, "0")}`));
  const { fronts, usable, review } = buildFronts(rows, classifications, overrides);
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
  const findings = validatePlan(rows, classifications, fronts, sets, links, usable, review, cpm, overrides);
  const recon = buildRecon(rows, sets, links, wbs, usable, review, cpm);

  const hasCycle = cpm.cycle !== null;
  const isEmpty = sets.activities.filter((a) => !a.isMilestone).length === 0;
  const canSave = !hasCycle && !isEmpty;
  const saveBlockReason = hasCycle
    ? `Logic cycle: ${cpm.cycle!.join(" -> ")}`
    : isEmpty ? "Plan is empty: no usable BOQ item produced an activity" : null;
  const canApproveBaseline = canSave && !findings.some((f) => f.severity === "critical");

  return {
    profile, classifications, wbs,
    activities: [...sets.activities].sort((a, b) => a.sortOrder - b.sortOrder),
    links, budgetLines: sets.budgetLines, resources: sets.resources,
    assignments: sets.assignments, allocations: sets.allocations,
    findings, recon, canSave, saveBlockReason, canApproveBaseline,
  };
}

export function emptyBoqOverrides(): BoqPlanOverrides {
  return {
    workType: {}, confirmed: {}, excludedFamilies: [], location: {},
    duration: {}, rate: {}, crews: {}, wbs: {}, removeLinks: [], addLinks: [],
  };
}
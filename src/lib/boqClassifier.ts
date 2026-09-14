// =====================================================================================
// Phase F2 · BOQ classifier (AR/EN, deterministic, no silent fallbacks).
//
// Maps each ParsedBoqRow to a planning work type. Every decision carries a numeric
// score, a confidence level, and a human-readable reason so the review UI can show
// WHY the engine thinks what it thinks. Items the engine cannot classify with
// confidence become `review_required` — never a silent "General".
//
// Scoring (deterministic, first-wins on ties is FORBIDDEN — ties across templates
// resolve to review_required):
//   strong item keyword match ............ +3
//   medium item keyword match ............ +2
//   weak item keyword match .............. +1
// (highest matching tier only — no double counting within a rule)
//   section/header context match ......... +2
//   unit compatible with candidate ....... +1
// Confidence: score >= 5 high · 3-4 medium · < 3 review_required.
// =====================================================================================

import type { ParsedBoqRow } from "@/types";

// -------------------------------------------------------------------------------------
// Stable vocabularies
// -------------------------------------------------------------------------------------

/** Planning work type: a concrete (template, step-set) choice. `review_required` is the honest fallback. */
export type BoqWorkType =
  | "sub_excv" | "sub_blind" | "sub_waterproof" | "sub_rebar" | "sub_form" | "sub_conc" | "sub_composite"
  | "vert_rebar" | "vert_form" | "vert_conc" | "vert_composite"
  | "horz_form" | "horz_rebar" | "horz_conc" | "horz_composite"
  | "masonry"
  | "grade_survey" | "grade_clear" | "grade_excv" | "grade_haul" | "grade_fill" | "grade_compact" | "grade_final"
  | "pipe_survey" | "pipe_excv" | "pipe_bedding" | "pipe_install" | "pipe_joint" | "pipe_test" | "pipe_backfill" | "pipe_reinstate"
  | "road_subgrade" | "road_subbase" | "road_base" | "road_prime" | "road_binder" | "road_wearing" | "road_asphalt_composite"
  | "kerb"
  | "review_required";

export type BoqFamily = "building" | "road" | "network" | "earthworks" | "bridges" | "unassigned";
export type BoqConfidence = "high" | "medium" | "review";

export interface BoqLocationHint {
  /** Stable key used for grouping, e.g. "zone:A", "floor:2", "chainage:1+200", "structure:tank". */
  key: string;
  /** Human label, e.g. "Zone A". */
  label: string;
  /** Which locator produced the hint (for the review UI). */
  kind: "zone" | "floor" | "building" | "chainage" | "sector" | "segment" | "street" | "structure" | "manhole";
}

export interface BoqClassification {
  rowKey: string;
  workType: BoqWorkType;
  family: BoqFamily;
  /** Package key within the family (e.g. "substructure", "pavement", "sewer"). Empty for review rows. */
  packageKey: string;
  confidence: BoqConfidence;
  /** Numeric evidence score (see header). */
  score: number;
  reason: string;
  locationHint: BoqLocationHint | null;
  /** Normalized unit (m3/m2/m/ton/each/lump/…) or "unknown". */
  unit: string;
  /** Quantity converted to the normalized unit where a deterministic factor exists. */
  quantityConverted: number;
}

// -------------------------------------------------------------------------------------
// Unit normalization (deterministic table, AR + EN)
// -------------------------------------------------------------------------------------

interface UnitRule { unit: string; factor: number; tokens: string[]; }

const UNIT_RULES: UnitRule[] = [
  { unit: "m3", factor: 1, tokens: ["m3", "m³", "m^3", "cubic meter", "cubic metre", "cum", "cu.m", "م3", "م³", "متر مكعب"] },
  { unit: "m2", factor: 1, tokens: ["m2", "m²", "sqm", "sq.m", "square meter", "square metre", "م2", "م²", "متر مسطح", "متر مربع"] },
  { unit: "m", factor: 1, tokens: ["m", "meter", "metre", "rm", "lm", "lin.m", "م", "متر", "متر طولي"] },
  { unit: "m", factor: 1000, tokens: ["km", "kilometer", "kilometre", "كم"] },
  { unit: "ton", factor: 1, tokens: ["ton", "tons", "tonne", "tonnes", "t", "طن"] },
  { unit: "ton", factor: 0.001, tokens: ["kg", "kgs", "kilogram", "كيلو", "كيلوجرام", "كيلو جرام"] },
  { unit: "each", factor: 1, tokens: ["no", "nos", "no.", "number", "nr", "pc", "pcs", "piece", "pieces", "ea", "each", "set", "sets", "job", "عدد", "قطعة"] },
  { unit: "lump", factor: 1, tokens: ["lot", "lump", "l.s", "ls", "lumpsum", "lump sum", "ps", "sum", "مقطوع", "مقطوعية"] },
  { unit: "day", factor: 1, tokens: ["day", "days", "يوم", "يومية"] },
  { unit: "hour", factor: 1, tokens: ["hr", "hrs", "hour", "hours", "ساعة"] },
];

export function normalizeUnit(raw: string): { unit: string; factor: number } {
  const s = (raw || "").trim().toLowerCase().replace(/[.\s]+$/g, "");
  if (!s) return { unit: "unknown", factor: 1 };
  for (const rule of UNIT_RULES) {
    if (rule.tokens.includes(s)) return { unit: rule.unit, factor: rule.factor };
  }
  return { unit: "unknown", factor: 1 };
}

// -------------------------------------------------------------------------------------
// Text helpers (Arabic-aware, deterministic)
// -------------------------------------------------------------------------------------

/** Normalize Arabic alef/hamza/ta-marbuta variants + lowercase latin, collapse spaces. */
export function normalizeText(raw: string): string {
  return (raw || "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF+./\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function has(text: string, ...needles: string[]): boolean {
  return needles.some((n) => text.includes(normalizeText(n)));
}

// -------------------------------------------------------------------------------------
// Location hint extraction (source text only — never invented)
// -------------------------------------------------------------------------------------

interface Locator { kind: BoqLocationHint["kind"]; re: RegExp; label: (m: RegExpMatchArray) => string; key: (m: RegExpMatchArray) => string; }

const LOCATORS: Locator[] = [
  { kind: "zone", re: /zone\s*([a-z0-9]+)/i, label: (m) => `Zone ${m[1].toUpperCase()}`, key: (m) => `zone:${m[1].toLowerCase()}` },
  { kind: "zone", re: /المنطقه\s*([a-z0-9\u0600-\u06FF]+)/i, label: (m) => `Zone ${m[1]}`, key: (m) => `zone:${m[1]}` },
  { kind: "floor", re: /floor\s*(\d+)/i, label: (m) => `Floor ${m[1]}`, key: (m) => `floor:${m[1]}` },
  { kind: "floor", re: /(?:الدور|الطابق)\s*([a-z0-9\u0600-\u06FF]+)/i, label: (m) => `Floor ${m[1]}`, key: (m) => `floor:${m[1]}` },
  { kind: "building", re: /building\s*(?:no\.?\s*)?([a-z0-9]+)/i, label: (m) => `Building ${m[1].toUpperCase()}`, key: (m) => `building:${m[1].toLowerCase()}` },
  { kind: "building", re: /(?:مبني|مبنى|عماره|عمارة)\s*([a-z0-9\u0600-\u06FF]+)/i, label: (m) => `Building ${m[1]}`, key: (m) => `building:${m[1]}` },
  { kind: "chainage", re: /ch\.?\s*(\d+\s*\+\s*\d+)/i, label: (m) => `Ch ${m[1].replace(/\s+/g, "")}`, key: (m) => `chainage:${m[1].replace(/\s+/g, "")}` },
  { kind: "sector", re: /sector\s*(\d+)/i, label: (m) => `Sector ${m[1]}`, key: (m) => `sector:${m[1]}` },
  { kind: "sector", re: /قطاع\s*([a-z0-9\u0600-\u06FF]+)/i, label: (m) => `Sector ${m[1]}`, key: (m) => `sector:${m[1]}` },
  { kind: "segment", re: /segment\s*([a-z0-9]+)/i, label: (m) => `Segment ${m[1].toUpperCase()}`, key: (m) => `segment:${m[1].toLowerCase()}` },
  { kind: "street", re: /street\s+(.+?)(?:\s{2,}|$)/i, label: (m) => `St ${m[1].trim()}`, key: (m) => `street:${m[1].trim().toLowerCase()}` },
  { kind: "street", re: /شارع\s*([a-z0-9\u0600-\u06FF ]+)/i, label: (m) => `St ${m[1].trim()}`, key: (m) => `street:${m[1].trim()}` },
  { kind: "manhole", re: /\bmh\s*(\d+)\b/i, label: (m) => `MH${m[1]}`, key: (m) => `manhole:${m[1]}` },
];

const STRUCTURE_HINTS: Array<{ key: string; label: string; tokens: string[] }> = [
  { key: "structure:tank", label: "Tank", tokens: ["tank", "reservoir", "خزان"] },
  { key: "structure:pump-station", label: "Pump station", tokens: ["pump station", "pumping station", "محطه ضخ", "محطة ضخ"] },
  { key: "structure:bridge", label: "Bridge", tokens: ["bridge", "جسر", "كوبري", "كوبرى"] },
  { key: "structure:culvert", label: "Culvert", tokens: ["culvert", "عباره", "عبارة"] },
  { key: "structure:mosque", label: "Mosque", tokens: ["mosque", "مسجد"] },
  { key: "structure:gate", label: "Gate house", tokens: ["gate house", "gatehouse", "غرفه حارس", "بوابه"] },
];

export function extractLocationHint(description: string, section: string): BoqLocationHint | null {
  const hay = `${description} ${section}`;
  for (const loc of LOCATORS) {
    const m = hay.match(loc.re);
    if (m) return { key: loc.key(m), label: loc.label(m), kind: loc.kind };
  }
  const n = normalizeText(hay);
  for (const s of STRUCTURE_HINTS) {
    if (has(n, ...s.tokens)) return { key: s.key, label: s.label, kind: "structure" };
  }
  return null;
}

// -------------------------------------------------------------------------------------
// Candidate rules: workType -> evidence
// -------------------------------------------------------------------------------------

interface CandidateRule {
  workType: BoqWorkType;
  strong: string[];
  medium: string[];
  weak: string[];
  sections: string[];
  units: string[];
  /** Element/context tokens that disqualify sibling templates (e.g. trench keeps pipe, drops building). */
  family: BoqFamily;
  packageKey: string;
}

const RULES: CandidateRule[] = [
  // ---- RC substructure ----
  { workType: "sub_excv", family: "building", packageKey: "substructure", strong: ["foundation excavation", "excavation for footing", "حفر اساسات", "حفر قواعد"], medium: ["footing excavation", "raft excavation", "حفر"], weak: ["excavation", "earthwork"], sections: ["substructure", "foundation", "foundations", "اعمال خرسانيه", "اساسات", "القواعد"], units: ["m3"] },
  { workType: "sub_blind", family: "building", packageKey: "substructure", strong: ["blinding", "lean concrete", "خرسانه عاديه", "خرسانة عادية", "نظافه", "نظافة"], medium: ["plain concrete"], weak: [], sections: ["substructure", "foundation", "اساسات"], units: ["m3", "m2"] },
  { workType: "sub_waterproof", family: "building", packageKey: "substructure", strong: ["waterproofing", "membrane", "bitumen sheet", "عزل", "عازل", "ممبران"], medium: ["damp proof", "protection board"], weak: [], sections: ["substructure", "waterproofing", "عزل"], units: ["m2"] },
  { workType: "sub_rebar", family: "building", packageKey: "substructure", strong: ["footing reinforcement", "raft reinforcement", "حديد قواعد", "تسليح قواعد"], medium: ["reinforcement steel", "rebar", "steel bars", "حديد تسليح", "تسليح"], weak: ["steel"], sections: ["substructure", "foundation", "reinforcement", "اساسات", "تسليح"], units: ["ton"] },
  { workType: "sub_form", family: "building", packageKey: "substructure", strong: ["footing formwork", "raft formwork", "شدات قواعد"], medium: ["formwork", "shuttering", "shutter", "شدات خشبيه", "نجاره مسلحه"], weak: [], sections: ["substructure", "foundation", "formwork", "اساسات"], units: ["m2"] },
  { workType: "sub_conc", family: "building", packageKey: "substructure", strong: ["footing concrete", "raft concrete", "خرسانه قواعد", "خرسانه مسلحه للقواعد"], medium: ["reinforced concrete", "ready mix", "خرسانه مسلحه", "خرسانة مسلحة"], weak: ["concrete", "خرسانه"], sections: ["substructure", "foundation", "concrete", "اساسات"], units: ["m3"] },
  { workType: "sub_composite", family: "building", packageKey: "substructure", strong: ["reinforced concrete for footing", "reinforced concrete for raft", "r.c. footing complete", "خرسانه مسلحه كامله للقواعد"], medium: [], weak: [], sections: ["substructure", "foundation", "اساسات"], units: ["m3"] },
  // ---- RC vertical ----
  { workType: "vert_rebar", family: "building", packageKey: "superstructure", strong: ["column reinforcement", "wall reinforcement", "shear wall reinforcement", "حديد اعمده", "تسليح اعمده", "تسليح حوائط"], medium: ["reinforcement steel", "rebar", "حديد تسليح"], weak: ["steel"], sections: ["column", "columns", "wall", "walls", "superstructure", "اعمده", "حوائط"], units: ["ton"] },
  { workType: "vert_form", family: "building", packageKey: "superstructure", strong: ["column formwork", "wall formwork", "شدات اعمده", "نجاره اعمده"], medium: ["formwork", "shuttering", "شدات خشبيه"], weak: [], sections: ["column", "columns", "wall", "superstructure", "اعمده"], units: ["m2"] },
  { workType: "vert_conc", family: "building", packageKey: "superstructure", strong: ["column concrete", "wall concrete", "خرسانه اعمده", "خرسانه حوائط"], medium: ["reinforced concrete", "خرسانه مسلحه"], weak: ["concrete", "خرسانه"], sections: ["column", "columns", "wall", "superstructure", "اعمده"], units: ["m3"] },
  { workType: "vert_composite", family: "building", packageKey: "superstructure", strong: ["reinforced concrete for column", "reinforced concrete column complete", "r.c. columns complete"], medium: [], weak: [], sections: ["column", "columns", "superstructure"], units: ["m3"] },
  // ---- RC horizontal ----
  { workType: "horz_form", family: "building", packageKey: "superstructure", strong: ["slab formwork", "beam formwork", "soffit formwork", "شدات اسقف", "نجاره اسقف"], medium: ["formwork", "shuttering"], weak: [], sections: ["slab", "beam", "roof", "superstructure", "اسقف", "بلاطات", "كمرات"], units: ["m2"] },
  { workType: "horz_rebar", family: "building", packageKey: "superstructure", strong: ["slab reinforcement", "beam reinforcement", "حديد اسقف", "تسليح بلاطات", "تسليح كمرات"], medium: ["reinforcement steel", "rebar"], weak: ["steel"], sections: ["slab", "beam", "superstructure", "اسقف"], units: ["ton"] },
  { workType: "horz_conc", family: "building", packageKey: "superstructure", strong: ["slab concrete", "beam concrete", "screed", "خرسانه اسقف", "خرسانه بلاطات"], medium: ["reinforced concrete", "خرسانه مسلحه"], weak: ["concrete"], sections: ["slab", "beam", "superstructure", "اسقف"], units: ["m3"] },
  { workType: "horz_composite", family: "building", packageKey: "superstructure", strong: ["reinforced concrete for slab", "r.c. slab complete", "slab complete with reinforcement"], medium: [], weak: [], sections: ["slab", "superstructure"], units: ["m3"] },
  // ---- masonry ----
  { workType: "masonry", family: "building", packageKey: "architectural", strong: ["blockwork", "block work", "masonry", "brickwork", "مباني", "بلوك", "طوب"], medium: ["partition wall", "حوائط مباني"], weak: ["block", "brick"], sections: ["masonry", "blockwork", "architectural", "مباني", "تشطيبات"], units: ["m2"] },
  // ---- mass grading ----
  { workType: "grade_survey", family: "earthworks", packageKey: "mass_grading", strong: ["setting out", "survey works", "topographic survey", "اعمال مساحه", "توقيع"], medium: ["survey"], weak: [], sections: ["earthwork", "grading", "اعمال ترابيه", "تسويه"], units: ["lump", "m2"] },
  { workType: "grade_clear", family: "earthworks", packageKey: "mass_grading", strong: ["clearing and grubbing", "site clearance", "ازاله نباتات", "تنظيف الموقع", "ازالة"], medium: ["clearing", "grubbing"], weak: [], sections: ["earthwork", "grading", "اعمال ترابيه"], units: ["m2"] },
  { workType: "grade_excv", family: "earthworks", packageKey: "mass_grading", strong: ["mass excavation", "cut to fill", "cutting", "حفر كميات", "قطع"], medium: ["general excavation", "bulk excavation", "حفر"], weak: ["excavation"], sections: ["earthwork", "grading", "mass", "اعمال ترابيه", "تسويه"], units: ["m3"] },
  { workType: "grade_haul", family: "earthworks", packageKey: "mass_grading", strong: ["haul", "transport surplus", "cart away", "نقل ناتج الحفر", "ترحيل"], medium: ["disposal of surplus", "dumping"], weak: ["transport"], sections: ["earthwork", "grading", "اعمال ترابيه"], units: ["m3"] },
  { workType: "grade_fill", family: "earthworks", packageKey: "mass_grading", strong: ["embankment", "structural fill", "backfilling", "ردم", "ردم هندسي", "احلال"], medium: ["fill", "filling"], weak: [], sections: ["earthwork", "grading", "اعمال ترابيه"], units: ["m3"] },
  { workType: "grade_compact", family: "earthworks", packageKey: "mass_grading", strong: ["compaction", "compacting", "دمك", "رص"], medium: ["density test"], weak: ["compact"], sections: ["earthwork", "grading", "اعمال ترابيه"], units: ["m2"] },
  { workType: "grade_final", family: "earthworks", packageKey: "mass_grading", strong: ["final grading", "trimming slopes", "تشطيب التسويه", "تسويه نهائيه"], medium: ["grading", "trimming", "تسويه"], weak: ["grade"], sections: ["earthwork", "grading", "تسويه"], units: ["m2"] },
  // ---- pipe networks ----
  { workType: "pipe_survey", family: "network", packageKey: "network_general", strong: ["setting out", "survey works", "اعمال مساحه", "توقيع"], medium: ["survey"], weak: [], sections: ["water", "sewer", "storm", "drainage", "pipe", "شبكات", "مياه", "صرف"], units: ["lump", "m"] },
  { workType: "pipe_excv", family: "network", packageKey: "network_general", strong: ["trench excavation", "trenching", "حفر خنادق", "حفر للمواسير"], medium: ["trench", "خندق"], weak: ["excavation", "حفر"], sections: ["water", "sewer", "storm", "drainage", "pipe", "شبكات"], units: ["m3"] },
  { workType: "pipe_bedding", family: "network", packageKey: "network_general", strong: ["bedding", "sand bedding", "فرشه", "فرشة رمل"], medium: ["bedding layer"], weak: [], sections: ["water", "sewer", "storm", "pipe", "شبكات"], units: ["m"] },
  { workType: "pipe_install", family: "network", packageKey: "network_general", strong: ["pipe laying", "laying pipes", "pipe installation", "تركيب مواسير", "تمديد مواسير", "توريد وتركيب مواسير"], medium: ["pipes", "pipeline", "مواسير"], weak: ["pipe"], sections: ["water", "sewer", "storm", "drainage", "pipe", "شبكات"], units: ["m"] },
  { workType: "pipe_joint", family: "network", packageKey: "network_general", strong: ["fittings", "valves", "jointing", "محابس", "وصلات", "قطع"], medium: ["valve", "fitting", "joint"], weak: [], sections: ["water", "sewer", "storm", "pipe", "شبكات"], units: ["each"] },
  { workType: "pipe_test", family: "network", packageKey: "network_general", strong: ["pressure test", "hydrotest", "leakage test", "اختبار ضغط", "اختبار"], medium: ["testing", "commissioning"], weak: ["test"], sections: ["water", "sewer", "storm", "pipe", "شبكات"], units: ["lump"] },
  { workType: "pipe_backfill", family: "network", packageKey: "network_general", strong: ["trench backfill", "backfilling", "ردم خنادق", "ردم حول المواسير"], medium: ["ردم"], weak: ["backfill", "fill"], sections: ["water", "sewer", "storm", "pipe", "شبكات"], units: ["m3"] },
  { workType: "pipe_reinstate", family: "network", packageKey: "network_general", strong: ["reinstatement", "asphalt reinstatement", "اعاده رصف", "اعادة الوضع"], medium: ["reinstate", "restoration"], weak: [], sections: ["water", "sewer", "storm", "pipe", "شبكات"], units: ["m2"] },
  // ---- road pavement ----
  { workType: "road_subgrade", family: "road", packageKey: "pavement", strong: ["subgrade", "formation level", "تربه تاسيس", "طبقه التاسيس"], medium: ["formation", "roadway excavation"], weak: [], sections: ["road", "roads", "pavement", "asphalt", "طرق", "رصف", "اسفلت"], units: ["m2"] },
  { workType: "road_subbase", family: "road", packageKey: "pavement", strong: ["subbase", "sub-base", "اساس مساعد", "طبقه اساس مساعد"], medium: ["granular subbase"], weak: [], sections: ["road", "pavement", "طرق", "رصف"], units: ["m3"] },
  { workType: "road_base", family: "road", packageKey: "pavement", strong: ["base course", "crushed stone base", "طبقه اساس", "اساس حصوي"], medium: ["road base"], weak: ["base"], sections: ["road", "pavement", "طرق", "رصف"], units: ["m3"] },
  { workType: "road_prime", family: "road", packageKey: "pavement", strong: ["prime coat", "tack coat", "رش تشريبي", "طبقه لاصقه", "MC"], medium: ["priming"], weak: ["prime", "tack"], sections: ["road", "pavement", "اسفلت", "رصف"], units: ["m2"] },
  { workType: "road_binder", family: "road", packageKey: "pavement", strong: ["binder course", "asphalt binder", "اسفلت رابط", "طبقه رابطه"], medium: ["binder"], weak: [], sections: ["road", "pavement", "اسفلت", "رصف"], units: ["ton", "m2"] },
  { workType: "road_wearing", family: "road", packageKey: "pavement", strong: ["wearing course", "surface course", "asphalt wearing", "اسفلت سطحي", "طبقه سطحيه"], medium: ["wearing", "surface"], weak: [], sections: ["road", "pavement", "اسفلت", "رصف"], units: ["ton", "m2"] },
  { workType: "road_asphalt_composite", family: "road", packageKey: "pavement", strong: ["asphalt works complete", "asphalt pavement complete", "اعمال اسفلت كامله"], medium: ["asphalt", "اسفلت"], weak: [], sections: ["road", "pavement", "اسفلت", "رصف"], units: ["ton", "m2"] },
  // ---- kerbs ----
  { workType: "kerb", family: "road", packageKey: "kerbs", strong: ["kerb", "curb", "بردوره", "بردورات", "كربستون"], medium: ["edging"], weak: [], sections: ["road", "kerb", "طرق", "بردورات"], units: ["m"] },
];
// -------------------------------------------------------------------------------------
// Scoring
// -------------------------------------------------------------------------------------

interface Scored extends CandidateRule { score: number; hits: string[]; }

function scoreRule(rule: CandidateRule, desc: string, section: string, unit: string): Scored {
  let score = 0;
  const hits: string[] = [];
  // Highest matching tier only: the same description words must not score twice
  // (e.g. "wearing courses" matching both strong "wearing course" and medium "wearing").
  const strongHit = rule.strong.find((t) => has(desc, t));
  const mediumHit = strongHit ? undefined : rule.medium.find((t) => has(desc, t));
  const weakHit = strongHit || mediumHit ? undefined : rule.weak.find((t) => has(desc, t));
  if (strongHit) { score += 3; hits.push(`strong:${strongHit}`); }
  else if (mediumHit) { score += 2; hits.push(`medium:${mediumHit}`); }
  else if (weakHit) { score += 1; hits.push(`weak:${weakHit}`); }
  for (const t of rule.sections) if (has(section, t)) { score += 2; hits.push(`section:${t}`); break; }
  if (rule.units.includes(unit)) { score += 1; hits.push(`unit:${unit}`); }
  return { ...rule, score, hits };
}

/** Refine network package (water/sewer/storm) from section + description signals. */
function refinePackage(family: BoqFamily, packageKey: string, desc: string, section: string): string {
  if (family === "network") {
    const both = `${desc} ${section}`;
    if (has(both, "sewer", "sewage", "wastewater", "صرف صحي", "مجاري")) return "sewer";
    if (has(both, "storm", "rainwater", "امطار", "أمطار", "سيول")) return "storm";
    if (has(both, "water", "potable", "مياه", "شرب")) return "water";
    if (has(both, "drainage", "تصريف")) return packageKey;
  }
  if (family === "bridges") return "bridge_rc";
  return packageKey;
}

export function classifyBoqRow(row: ParsedBoqRow, rowKey: string): BoqClassification {
  const desc = normalizeText(row.description);
  const section = normalizeText(row.section || row.category || "");
  const { unit, factor } = normalizeUnit(row.unit);
  const quantityConverted = row.quantity * factor;
  const locationHint = extractLocationHint(row.description, row.section || "");

  const scored = RULES.map((r) => scoreRule(r, desc, section, unit))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.workType.localeCompare(b.workType));

  if (scored.length === 0 || scored[0].score < 3) {
    return {
      rowKey, workType: "review_required", family: "unassigned", packageKey: "",
      confidence: "review", score: scored[0]?.score || 0,
      reason: scored.length === 0
        ? "No keyword/section/unit evidence matched any work type."
        : `Best evidence "${scored[0].workType}" scored ${scored[0].score} (< 3): insufficient.`,
      locationHint, unit, quantityConverted,
    };
  }
  // Tie across different work types at the top => honest review (no silent pick).
  if (scored.length > 1 && scored[1].score === scored[0].score && scored[1].workType !== scored[0].workType) {
    return {
      rowKey, workType: "review_required", family: "unassigned", packageKey: "",
      confidence: "review", score: scored[0].score,
      reason: `Ambiguous: "${scored[0].workType}" and "${scored[1].workType}" tie at ${scored[0].score}.`,
      locationHint, unit, quantityConverted,
    };
  }
  const top = scored[0];
  return {
    rowKey, workType: top.workType, family: top.family,
    packageKey: refinePackage(top.family, top.packageKey, desc, section),
    confidence: top.score >= 5 ? "high" : "medium", score: top.score,
    reason: `Matched ${top.hits.join(", ")} (score ${top.score}).`,
    locationHint, unit, quantityConverted,
  };
}

/** Work type -> (template, contributing steps). Single source for grouping + costing. */
export const WORK_TYPE_BINDING: Record<Exclude<BoqWorkType, "review_required">, { template: string; steps: string[] }> = {
  sub_excv: { template: "RC_SUBSTRUCTURE_V1", steps: ["E"] },
  sub_blind: { template: "RC_SUBSTRUCTURE_V1", steps: ["B"] },
  sub_waterproof: { template: "RC_SUBSTRUCTURE_V1", steps: ["W"] },
  sub_rebar: { template: "RC_SUBSTRUCTURE_V1", steps: ["R"] },
  sub_form: { template: "RC_SUBSTRUCTURE_V1", steps: ["F"] },
  sub_conc: { template: "RC_SUBSTRUCTURE_V1", steps: ["C"] },
  sub_composite: { template: "RC_SUBSTRUCTURE_V1", steps: ["R", "F", "C"] },
  vert_rebar: { template: "RC_VERTICAL_V1", steps: ["R"] },
  vert_form: { template: "RC_VERTICAL_V1", steps: ["F"] },
  vert_conc: { template: "RC_VERTICAL_V1", steps: ["C"] },
  vert_composite: { template: "RC_VERTICAL_V1", steps: ["R", "F", "C"] },
  horz_form: { template: "RC_HORIZONTAL_V1", steps: ["F"] },
  horz_rebar: { template: "RC_HORIZONTAL_V1", steps: ["R"] },
  horz_conc: { template: "RC_HORIZONTAL_V1", steps: ["C"] },
  horz_composite: { template: "RC_HORIZONTAL_V1", steps: ["F", "R", "C"] },
  masonry: { template: "MASONRY_V1", steps: ["K"] },
  grade_survey: { template: "MASS_GRADING_V1", steps: ["S"] },
  grade_clear: { template: "MASS_GRADING_V1", steps: ["L"] },
  grade_excv: { template: "MASS_GRADING_V1", steps: ["E"] },
  grade_haul: { template: "MASS_GRADING_V1", steps: ["H"] },
  grade_fill: { template: "MASS_GRADING_V1", steps: ["P"] },
  grade_compact: { template: "MASS_GRADING_V1", steps: ["O"] },
  grade_final: { template: "MASS_GRADING_V1", steps: ["G"] },
  pipe_survey: { template: "PIPE_NETWORK_V1", steps: ["S"] },
  pipe_excv: { template: "PIPE_NETWORK_V1", steps: ["E"] },
  pipe_bedding: { template: "PIPE_NETWORK_V1", steps: ["D"] },
  pipe_install: { template: "PIPE_NETWORK_V1", steps: ["I"] },
  pipe_joint: { template: "PIPE_NETWORK_V1", steps: ["J"] },
  pipe_test: { template: "PIPE_NETWORK_V1", steps: ["T"] },
  pipe_backfill: { template: "PIPE_NETWORK_V1", steps: ["B"] },
  pipe_reinstate: { template: "PIPE_NETWORK_V1", steps: ["N"] },
  road_subgrade: { template: "ROAD_PAVEMENT_V1", steps: ["G"] },
  road_subbase: { template: "ROAD_PAVEMENT_V1", steps: ["S"] },
  road_base: { template: "ROAD_PAVEMENT_V1", steps: ["B"] },
  road_prime: { template: "ROAD_PAVEMENT_V1", steps: ["P"] },
  road_binder: { template: "ROAD_PAVEMENT_V1", steps: ["N"] },
  road_wearing: { template: "ROAD_PAVEMENT_V1", steps: ["W"] },
  road_asphalt_composite: { template: "ROAD_PAVEMENT_V1", steps: ["N", "W"] },
  kerb: { template: "ROAD_KERB_V1", steps: ["K"] },
};
// =====================================================================================
// Phase F2 · Planning template library (documented, editable, no invented consumption).
//
// Template = the documented sequence of steps that builds one work front for one deep
// work family (RC substructure / RC vertical / RC horizontal / masonry / mass
// grading / pipe networks / road pavement / kerbs). Each step declares:
//   - kind: 'mapped' (instantiated only when a BOQ item maps to it),
//           'conditional' (instantiated only when a BOQ item maps to it AND the item
//             carries the step's trigger keyword — same as mapped in practice, kept as
//             a distinct kind so the review UI can say "step skipped: no item"),
//           'intrinsic' (always instantiated for the front — survey/testing/curing —
//             with zero cost unless a BOQ item explicitly maps to it).
//   - costWeight: share of a COMPOSITE item's amount consumed by this step. Weights
//     apply ONLY to documented composite mappings and are renormalized over the
//     actually-instantiated steps (largest-remainder cents math in the engine).
//   - duration: quantity-driven (unit + dailyOutput per crew) or template-default
//     days (disclosed in the review UI, editable before confirm).
//   - crew: composition used for TIME math and for generated resource rows. Crew rows
//     never carry rates (unit_rate NULL), so template crews can never fabricate cost.
//
// Cross-front sequencing rules live in CROSS_FRONT_RULES. All of this is data: adding
// a work family means adding a template here, not touching the engine.
// =====================================================================================

export type PlanningTemplateKey =
  | "RC_SUBSTRUCTURE_V1" | "RC_VERTICAL_V1" | "RC_HORIZONTAL_V1" | "MASONRY_V1"
  | "MASS_GRADING_V1" | "PIPE_NETWORK_V1" | "ROAD_PAVEMENT_V1" | "ROAD_KERB_V1";

export type TemplateStepKind = "mapped" | "conditional" | "intrinsic";

export interface TemplateCrewLine {
  /** Stable slug, e.g. "crew-excavation". */
  code: string;
  name: string;
  /** 'labor' | 'equipment'. */
  type: string;
  unit: string;
  /** Headcount / equipment count per crew. */
  count: number;
}

export interface TemplateStep {
  key: string;
  name: string;
  kind: TemplateStepKind;
  /** Share of composite-item cost (weights sum to 1 per template — asserted by the F2 harness). */
  costWeight: number;
  /** Quantity unit the productivity rate consumes, or null for template-default-day steps. */
  unit: string | null;
  /** Daily output per crew in `unit` (null when defaultDays is used). */
  dailyOutput: number | null;
  /** Template default duration in days (survey/testing/curing) — disclosed, editable. */
  defaultDays: number | null;
  defaultCrews: number;
  crew: TemplateCrewLine[];
}

export type TemplateLinkType = "FS" | "SS" | "FF";

export interface TemplateLink {
  from: string;
  to: string;
  type: TemplateLinkType;
  /** Documented lag in working days (0 unless stated). */
  lagDays: number;
  rule: string;
  /** F3: stable rule code carried onto every generated link (logic provenance). */
  code: string;
}

export interface PlanningTemplate {
  key: PlanningTemplateKey;
  name: string;
  /** Default package key when the section gives no better signal. */
  defaultPackage: string;
  order: number;
  steps: TemplateStep[];
  links: TemplateLink[];
  /** Human logic narrative shown in the review UI. */
  logicNotes: string;
  /** F3: provenance of the template production rates (assumption library, not history). */
  rateProvenance: { sourceLabel: string; applicability: string; confidence: string };
}

// -------------------------------------------------------------------------------------
// Templates
// -------------------------------------------------------------------------------------

export const PLANNING_TEMPLATES: Record<PlanningTemplateKey, PlanningTemplate> = {
  RC_SUBSTRUCTURE_V1: {
    key: "RC_SUBSTRUCTURE_V1",
    name: "RC substructure (footings / raft)",
    defaultPackage: "substructure",
    order: 10,
    logicNotes: "Excavation -> blinding -> waterproofing (when specified) -> rebar+formwork in PARALLEL (SS) -> concrete (FS after both) -> curing.",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Footing/raft production steps; assumes open-cut excavation and ready-mix supply",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "E", name: "Foundation excavation", kind: "mapped", costWeight: 0.12, unit: "m3", dailyOutput: 400, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-excavator", name: "Excavator", type: "equipment", unit: "day", count: 1 },
        { code: "eq-tip-truck", name: "Tip truck", type: "equipment", unit: "day", count: 2 },
        { code: "crew-excavation", name: "Excavation crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "B", name: "Blinding concrete", kind: "mapped", costWeight: 0.04, unit: "m2", dailyOutput: 150, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-concrete", name: "Concreting crew", type: "labor", unit: "day", count: 6 },
      ]},
      { key: "W", name: "Waterproofing", kind: "conditional", costWeight: 0.06, unit: "m2", dailyOutput: 120, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-waterproofing", name: "Waterproofing crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "R", name: "Footing rebar", kind: "mapped", costWeight: 0.30, unit: "ton", dailyOutput: 1.2, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-steelfixer", name: "Steel fixer crew", type: "labor", unit: "day", count: 6 },
      ]},
      { key: "F", name: "Footing formwork", kind: "mapped", costWeight: 0.20, unit: "m2", dailyOutput: 40, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-carpenter", name: "Carpenter crew", type: "labor", unit: "day", count: 6 },
      ]},
      { key: "C", name: "Footing concrete", kind: "mapped", costWeight: 0.24, unit: "m3", dailyOutput: 60, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-concrete", name: "Concreting crew", type: "labor", unit: "day", count: 8 },
        { code: "eq-concrete-pump", name: "Concrete pump", type: "equipment", unit: "day", count: 1 },
      ]},
      { key: "U", name: "Curing", kind: "intrinsic", costWeight: 0.04, unit: null, dailyOutput: null, defaultDays: 7, defaultCrews: 1, crew: [
        { code: "crew-curing", name: "Curing gang", type: "labor", unit: "day", count: 2 },
      ]},
    ],
    links: [
      { from: "E", to: "B", type: "FS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_EXCV_TO_BLIND", rule: "Blinding follows completed excavation." },
      { from: "B", to: "W", type: "FS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_BLIND_TO_WATERPROOF", rule: "Waterproofing on cured blinding (skipped with step W when not specified)." },
      { from: "B", to: "R", type: "FS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_BLIND_TO_REBAR", rule: "Rebar starts on prepared base (via W when waterproofing exists)." },
      { from: "W", to: "R", type: "FS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_WATERPROOF_TO_REBAR", rule: "Rebar after waterproofing protection." },
      { from: "B", to: "F", type: "SS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_BLIND_WITH_FORM", rule: "Formwork starts with rebar preparation (parallel trades)." },
      { from: "W", to: "F", type: "SS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_WATERPROOF_WITH_FORM", rule: "Formwork with waterproofed base ready (parallel)." },
      { from: "R", to: "F", type: "SS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_REBAR_WITH_FORM", rule: "Rebar and formwork proceed in parallel." },
      { from: "R", to: "C", type: "FS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_REBAR_TO_CONC", rule: "Concrete only after rebar complete." },
      { from: "F", to: "C", type: "FS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_FORM_TO_CONC", rule: "Concrete only after formwork complete (closed forms)." },
      { from: "C", to: "U", type: "FS", lagDays: 0, code: "SUBSTRUCTURE_FLOW_CONC_TO_CURE", rule: "Curing follows pour." },
    ],
  },

  RC_VERTICAL_V1: {
    key: "RC_VERTICAL_V1",
    name: "RC vertical (columns / walls)",
    defaultPackage: "superstructure",
    order: 20,
    logicNotes: "Rebar and formwork in PARALLEL (SS) -> concrete FS after both -> curing.",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Column/wall production steps; assumes conventional formwork and pumped concrete",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "R", name: "Column/wall rebar", kind: "mapped", costWeight: 0.34, unit: "ton", dailyOutput: 1.0, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-steelfixer", name: "Steel fixer crew", type: "labor", unit: "day", count: 6 },
      ]},
      { key: "F", name: "Column/wall formwork", kind: "mapped", costWeight: 0.30, unit: "m2", dailyOutput: 35, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-carpenter", name: "Carpenter crew", type: "labor", unit: "day", count: 6 },
      ]},
      { key: "C", name: "Column/wall concrete", kind: "mapped", costWeight: 0.32, unit: "m3", dailyOutput: 50, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-concrete", name: "Concreting crew", type: "labor", unit: "day", count: 8 },
        { code: "eq-concrete-pump", name: "Concrete pump", type: "equipment", unit: "day", count: 1 },
      ]},
      { key: "U", name: "Curing", kind: "intrinsic", costWeight: 0.04, unit: null, dailyOutput: null, defaultDays: 7, defaultCrews: 1, crew: [
        { code: "crew-curing", name: "Curing gang", type: "labor", unit: "day", count: 2 },
      ]},
    ],
    links: [
      { from: "R", to: "F", type: "SS", lagDays: 0, code: "VERTICAL_FLOW_REBAR_WITH_FORM", rule: "Rebar and formwork proceed in parallel." },
      { from: "R", to: "C", type: "FS", lagDays: 0, code: "VERTICAL_FLOW_REBAR_TO_CONC", rule: "Concrete only after rebar complete." },
      { from: "F", to: "C", type: "FS", lagDays: 0, code: "VERTICAL_FLOW_FORM_TO_CONC", rule: "Concrete only after formwork complete." },
      { from: "C", to: "U", type: "FS", lagDays: 0, code: "VERTICAL_FLOW_CONC_TO_CURE", rule: "Curing follows pour." },
    ],
  },

  RC_HORIZONTAL_V1: {
    key: "RC_HORIZONTAL_V1",
    name: "RC horizontal (slabs / beams)",
    defaultPackage: "superstructure",
    order: 30,
    logicNotes: "Formwork soffits first (FS) -> rebar on formed soffits -> concrete FS after both -> curing.",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Slab/beam production steps; assumes soffit formwork and pumped concrete",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "F", name: "Slab/beam formwork", kind: "mapped", costWeight: 0.30, unit: "m2", dailyOutput: 45, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-carpenter", name: "Carpenter crew", type: "labor", unit: "day", count: 8 },
      ]},
      { key: "R", name: "Slab/beam rebar", kind: "mapped", costWeight: 0.32, unit: "ton", dailyOutput: 1.2, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-steelfixer", name: "Steel fixer crew", type: "labor", unit: "day", count: 6 },
      ]},
      { key: "C", name: "Slab/beam concrete", kind: "mapped", costWeight: 0.34, unit: "m3", dailyOutput: 80, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-concrete", name: "Concreting crew", type: "labor", unit: "day", count: 10 },
        { code: "eq-concrete-pump", name: "Concrete pump", type: "equipment", unit: "day", count: 1 },
      ]},
      { key: "U", name: "Curing", kind: "intrinsic", costWeight: 0.04, unit: null, dailyOutput: null, defaultDays: 7, defaultCrews: 1, crew: [
        { code: "crew-curing", name: "Curing gang", type: "labor", unit: "day", count: 2 },
      ]},
    ],
    links: [
      { from: "F", to: "R", type: "FS", lagDays: 0, code: "HORIZONTAL_FLOW_FORM_TO_REBAR", rule: "Rebar follows formed soffits." },
      { from: "R", to: "C", type: "FS", lagDays: 0, code: "HORIZONTAL_FLOW_REBAR_TO_CONC", rule: "Concrete only after rebar complete." },
      { from: "F", to: "C", type: "FS", lagDays: 0, code: "HORIZONTAL_FLOW_FORM_TO_CONC", rule: "Concrete only after formwork complete." },
      { from: "C", to: "U", type: "FS", lagDays: 0, code: "HORIZONTAL_FLOW_CONC_TO_CURE", rule: "Curing follows pour." },
    ],
  },
  MASONRY_V1: {
    key: "MASONRY_V1",
    name: "Masonry blockwork",
    defaultPackage: "architectural",
    order: 40,
    logicNotes: "Single production step (blockwork). No invented sub-steps.",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Blockwork production; assumes 200mm units and ground-level handling",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "K", name: "Blockwork", kind: "mapped", costWeight: 1.0, unit: "m2", dailyOutput: 25, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-mason", name: "Mason crew", type: "labor", unit: "day", count: 6 },
      ]},
    ],
    links: [],
  },

  MASS_GRADING_V1: {
    key: "MASS_GRADING_V1",
    name: "Mass grading / earthworks",
    defaultPackage: "mass_grading",
    order: 50,
    logicNotes: "Survey -> clearing (when specified) -> excavation -> haul (SS with excavation) -> fill -> compaction -> final grade.",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Bulk earthworks; assumes dozer/excavator spreads on accessible ground",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "S", name: "Setting out / survey", kind: "intrinsic", costWeight: 0.03, unit: null, dailyOutput: null, defaultDays: 3, defaultCrews: 1, crew: [
        { code: "crew-surveyor", name: "Survey crew", type: "labor", unit: "day", count: 3 },
      ]},
      { key: "L", name: "Clearing and grubbing", kind: "conditional", costWeight: 0.05, unit: "m2", dailyOutput: 3000, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-dozer", name: "Bulldozer", type: "equipment", unit: "day", count: 1 },
        { code: "crew-clearing", name: "Clearing crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "E", name: "Bulk excavation", kind: "mapped", costWeight: 0.22, unit: "m3", dailyOutput: 1200, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-excavator", name: "Excavator", type: "equipment", unit: "day", count: 2 },
        { code: "eq-tip-truck", name: "Tip truck", type: "equipment", unit: "day", count: 4 },
        { code: "crew-excavation", name: "Excavation crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "H", name: "Haul surplus", kind: "conditional", costWeight: 0.18, unit: "m3", dailyOutput: 1000, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-tip-truck", name: "Tip truck", type: "equipment", unit: "day", count: 4 },
      ]},
      { key: "P", name: "Structural fill", kind: "mapped", costWeight: 0.22, unit: "m3", dailyOutput: 1000, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-dozer", name: "Bulldozer", type: "equipment", unit: "day", count: 1 },
        { code: "eq-grader", name: "Grader", type: "equipment", unit: "day", count: 1 },
        { code: "crew-fill", name: "Fill crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "O", name: "Compaction", kind: "mapped", costWeight: 0.15, unit: "m2", dailyOutput: 4000, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-roller", name: "Vibratory roller", type: "equipment", unit: "day", count: 1 },
      ]},
      { key: "G", name: "Final grade", kind: "mapped", costWeight: 0.15, unit: "m2", dailyOutput: 5000, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-grader", name: "Grader", type: "equipment", unit: "day", count: 1 },
      ]},
    ],
    links: [
      { from: "S", to: "L", type: "FS", lagDays: 0, code: "GRADING_FLOW_SURVEY_TO_CLEAR", rule: "Clearing after setting out." },
      { from: "S", to: "E", type: "FS", lagDays: 0, code: "GRADING_FLOW_SURVEY_TO_EXCV", rule: "Excavation after setting out (via clearing when specified)." },
      { from: "L", to: "E", type: "FS", lagDays: 0, code: "GRADING_FLOW_CLEAR_TO_EXCV", rule: "Excavation on cleared ground." },
      { from: "E", to: "H", type: "SS", lagDays: 0, code: "GRADING_FLOW_EXCV_WITH_HAUL", rule: "Hauling proceeds with excavation." },
      { from: "E", to: "P", type: "FS", lagDays: 0, code: "GRADING_FLOW_EXCV_TO_FILL", rule: "Fill after cut complete in the front." },
      { from: "P", to: "O", type: "FS", lagDays: 0, code: "GRADING_FLOW_FILL_TO_COMPACT", rule: "Compaction after fill placement." },
      { from: "O", to: "G", type: "FS", lagDays: 0, code: "GRADING_FLOW_COMPACT_TO_GRADE", rule: "Final grade on compacted surface." },
    ],
  },
  PIPE_NETWORK_V1: {
    key: "PIPE_NETWORK_V1",
    name: "Pipe network (water / sewer / storm / drainage)",
    defaultPackage: "network_general",
    order: 60,
    logicNotes: "Survey -> trench excavation -> bedding -> installation -> jointing (SS) -> testing -> backfill -> reinstatement.",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Trench pipe networks; assumes open-cut trench in normal soil",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "S", name: "Setting out / survey", kind: "intrinsic", costWeight: 0.02, unit: null, dailyOutput: null, defaultDays: 2, defaultCrews: 1, crew: [
        { code: "crew-surveyor", name: "Survey crew", type: "labor", unit: "day", count: 3 },
      ]},
      { key: "E", name: "Trench excavation", kind: "mapped", costWeight: 0.20, unit: "m3", dailyOutput: 150, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-excavator", name: "Excavator", type: "equipment", unit: "day", count: 1 },
        { code: "crew-trench", name: "Trench crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "D", name: "Bedding", kind: "mapped", costWeight: 0.08, unit: "m", dailyOutput: 120, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-bedding", name: "Bedding crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "I", name: "Pipe installation", kind: "mapped", costWeight: 0.30, unit: "m", dailyOutput: 80, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-pipelayer", name: "Pipe layer crew", type: "labor", unit: "day", count: 6 },
        { code: "eq-crane", name: "Mobile crane", type: "equipment", unit: "day", count: 1 },
      ]},
      { key: "J", name: "Jointing / fittings", kind: "conditional", costWeight: 0.06, unit: "each", dailyOutput: 20, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-fitter", name: "Fitter crew", type: "labor", unit: "day", count: 3 },
      ]},
      { key: "T", name: "Pressure testing", kind: "intrinsic", costWeight: 0.04, unit: null, dailyOutput: null, defaultDays: 3, defaultCrews: 1, crew: [
        { code: "crew-test", name: "Testing crew", type: "labor", unit: "day", count: 3 },
      ]},
      { key: "B", name: "Trench backfill", kind: "mapped", costWeight: 0.18, unit: "m3", dailyOutput: 200, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-roller", name: "Vibratory roller", type: "equipment", unit: "day", count: 1 },
        { code: "crew-backfill", name: "Backfill crew", type: "labor", unit: "day", count: 4 },
      ]},
      { key: "N", name: "Reinstatement", kind: "conditional", costWeight: 0.12, unit: "m2", dailyOutput: 150, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-reinstate", name: "Reinstatement crew", type: "labor", unit: "day", count: 4 },
      ]},
    ],
    links: [
      { from: "S", to: "E", type: "FS", lagDays: 0, code: "PIPE_FLOW_SURVEY_TO_EXCV", rule: "Trenching after setting out." },
      { from: "E", to: "D", type: "FS", lagDays: 0, code: "PIPE_FLOW_EXCV_TO_BEDDING", rule: "Bedding on excavated trench." },
      { from: "D", to: "I", type: "FS", lagDays: 0, code: "PIPE_FLOW_BEDDING_TO_PIPE", rule: "Pipes on prepared bedding." },
      { from: "I", to: "J", type: "SS", lagDays: 0, code: "PIPE_FLOW_PIPE_WITH_JOINT", rule: "Jointing proceeds with laying." },
      { from: "I", to: "T", type: "FS", lagDays: 0, code: "PIPE_FLOW_PIPE_TO_TEST", rule: "Testing after installation complete." },
      { from: "J", to: "T", type: "FS", lagDays: 0, code: "PIPE_FLOW_JOINT_TO_TEST", rule: "Testing after jointing complete." },
      { from: "T", to: "B", type: "FS", lagDays: 0, code: "PIPE_FLOW_TEST_TO_BACKFILL", rule: "Backfill only after passed test." },
      { from: "B", to: "N", type: "FS", lagDays: 0, code: "PIPE_FLOW_BACKFILL_TO_REINSTATE", rule: "Reinstatement on backfilled trench." },
    ],
  },
  ROAD_PAVEMENT_V1: {
    key: "ROAD_PAVEMENT_V1",
    name: "Road pavement layers",
    defaultPackage: "pavement",
    order: 70,
    logicNotes: "Subgrade -> subbase -> base -> prime -> binder -> wearing (strict layer sequence).",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Pavement layers; assumes a mechanical paving spread",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "G", name: "Subgrade preparation", kind: "mapped", costWeight: 0.10, unit: "m2", dailyOutput: 2500, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-grader", name: "Grader", type: "equipment", unit: "day", count: 1 },
        { code: "eq-roller", name: "Vibratory roller", type: "equipment", unit: "day", count: 1 },
      ]},
      { key: "S", name: "Subbase", kind: "mapped", costWeight: 0.16, unit: "m3", dailyOutput: 600, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-grader", name: "Grader", type: "equipment", unit: "day", count: 1 },
        { code: "crew-paving", name: "Paving crew", type: "labor", unit: "day", count: 5 },
      ]},
      { key: "B", name: "Base course", kind: "mapped", costWeight: 0.20, unit: "m3", dailyOutput: 500, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-grader", name: "Grader", type: "equipment", unit: "day", count: 1 },
        { code: "crew-paving", name: "Paving crew", type: "labor", unit: "day", count: 5 },
      ]},
      { key: "P", name: "Prime / tack coat", kind: "conditional", costWeight: 0.04, unit: "m2", dailyOutput: 4000, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-prime", name: "Spray crew", type: "labor", unit: "day", count: 3 },
      ]},
      { key: "N", name: "Binder course", kind: "mapped", costWeight: 0.24, unit: "ton", dailyOutput: 400, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-paver", name: "Asphalt paver", type: "equipment", unit: "day", count: 1 },
        { code: "eq-roller", name: "Vibratory roller", type: "equipment", unit: "day", count: 1 },
        { code: "crew-asphalt", name: "Asphalt crew", type: "labor", unit: "day", count: 8 },
      ]},
      { key: "W", name: "Wearing course", kind: "mapped", costWeight: 0.26, unit: "ton", dailyOutput: 350, defaultDays: null, defaultCrews: 1, crew: [
        { code: "eq-paver", name: "Asphalt paver", type: "equipment", unit: "day", count: 1 },
        { code: "eq-roller", name: "Vibratory roller", type: "equipment", unit: "day", count: 1 },
        { code: "crew-asphalt", name: "Asphalt crew", type: "labor", unit: "day", count: 8 },
      ]},
    ],
    links: [
      { from: "G", to: "S", type: "FS", lagDays: 0, code: "ROAD_FLOW_SUBGRADE_TO_SUBBASE", rule: "Subbase on prepared subgrade." },
      { from: "S", to: "B", type: "FS", lagDays: 0, code: "ROAD_FLOW_SUBBASE_TO_BASE", rule: "Base on subbase." },
      { from: "B", to: "P", type: "FS", lagDays: 0, code: "ROAD_FLOW_BASE_TO_PRIME", rule: "Prime on finished base." },
      { from: "B", to: "N", type: "FS", lagDays: 0, code: "ROAD_FLOW_BASE_TO_BINDER", rule: "Binder on primed base (direct when prime not specified)." },
      { from: "P", to: "N", type: "FS", lagDays: 0, code: "ROAD_FLOW_PRIME_TO_BINDER", rule: "Binder after prime coat." },
      { from: "N", to: "W", type: "FS", lagDays: 0, code: "ROAD_FLOW_BINDER_TO_WEARING", rule: "Wearing on binder course." },
    ],
  },

  ROAD_KERB_V1: {
    key: "ROAD_KERB_V1",
    name: "Kerbs",
    defaultPackage: "kerbs",
    order: 80,
    logicNotes: "Single production step. Sequenced from the pavement base (FS) and finished with the wearing course (FF).",
    rateProvenance: {
      sourceLabel: "F3 planning-rate library v1 (assumption — not a historical record)",
      applicability: "Kerb laying; assumes precast units on a prepared bed",
      confidence: "planning-assumption",
    },
    steps: [
      { key: "K", name: "Kerb laying", kind: "mapped", costWeight: 1.0, unit: "m", dailyOutput: 100, defaultDays: null, defaultCrews: 1, crew: [
        { code: "crew-kerb", name: "Kerb laying crew", type: "labor", unit: "day", count: 5 },
      ]},
    ],
    links: [],
  },
};

// -------------------------------------------------------------------------------------
// Cross-front sequencing rules (documented, applied between fronts — never inside BOQ)
// -------------------------------------------------------------------------------------

export interface CrossFrontRule {
  family: string;
  /** Ordered package keys: each package's fronts finish before the next package starts. */
  packageOrder: string[];
  /** Per-location chaining preferred over package fan when locations match. */
  perLocation: boolean;
  note: string;
}

export const CROSS_FRONT_RULES: CrossFrontRule[] = [
  {
    family: "building",
    packageOrder: ["substructure", "superstructure", "architectural"],
    perLocation: true,
    note: "Substructure -> superstructure -> architectural; same-location fronts chain directly.",
  },
  {
    family: "road",
    packageOrder: ["earthworks", "drainage", "pavement"],
    perLocation: true,
    note: "Earthworks -> drainage -> pavement; kerbs run FS-from-base with FF-to-wearing.",
  },
  {
    family: "bridges",
    packageOrder: ["bridge_rc"],
    perLocation: true,
    note: "Bridge RC fronts reuse the RC templates in template order (substructure, vertical, horizontal).",
  },
  {
    family: "network",
    packageOrder: [],
    perLocation: true,
    note: "Network systems run in parallel; repeated segments chain per-step (crew flow) when crews == 1.",
  },
  {
    family: "earthworks",
    packageOrder: ["mass_grading"],
    perLocation: true,
    note: "Grading zones run in parallel unless a single crew forces per-step crew-flow chaining.",
  },
];

export function getTemplate(key: string): PlanningTemplate {
  const t = (PLANNING_TEMPLATES as Record<string, PlanningTemplate>)[key];
  if (!t) throw new Error(`Unknown planning template: ${key}`);
  return t;
}

export function templateStepKeys(key: string): string[] {
  return getTemplate(key).steps.map((s) => s.key);
}
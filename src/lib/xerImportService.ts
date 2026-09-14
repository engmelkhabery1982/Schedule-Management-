import type { ParsedXerResult } from './xerImporter';

/**
 * XER import planning + persistence (Phase F1).
 *
 * `buildXerImportPlan` is pure: parsed XER + user options -> rows + reconciliation report.
 * `persistXerImportPlan` writes the plan through a minimal injected DB client, all-or-clean
 * (reverse-order cleanup on any step failure, honestly reported when cleanup itself fails).
 *
 * Cost routing note: imported assignment/expense costs land in `budget_lines` with
 * `activity_id = NULL` and `budget_basis = 'xer_import'`. The resource-budget recompute
 * trigger only rewrites lines with a non-null activity_id, so P6 figures survive; the EVM
 * engine sums planned_cost regardless, so BAC/AC stay honest. No canonical engine changes.
 */

// --------------------------------------------------------------------------- DB client

export interface XerDbQueryResult {
  data: unknown;
  error: { message: string } | null;
}

export interface XerDbDeleteResult {
  error: { message: string } | null;
}

export interface XerDbClient {
  from(table: string): {
    insert(rows: Record<string, unknown> | Record<string, unknown>[]): {
      select(): Promise<XerDbQueryResult>;
    };
    delete(): { eq(column: string, value: string): Promise<XerDbDeleteResult> };
  };
}

// --------------------------------------------------------------------------- plan input

export interface XerImportOptions {
  projectName: string;
  client: string | null;
  location: string | null;
  /** User-supplied contract value; null/0 means "not provided" (stored as the 0 default). */
  contractValue: number | null;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  /** File Data Date or explicit user override; null when neither exists. */
  dataDate: string | null;
  description: string | null;
  /** Explicit opt-in only; ignored (with a note) when a real P6 baseline is imported. */
  createInitialBaseline: boolean;
}

// --------------------------------------------------------------------------- reconciliation

export interface ReconItem {
  entity: string;
  code: string;
  reason: string;
}

export interface ReconSection {
  entity: string;
  source: number;
  imported: number;
  dropped: number;
  unsupported: number;
  notes: string[];
}

export interface ReconReport {
  projectName: string;
  sections: ReconSection[];
  provenance: {
    dataDate: string | null;
    dataDateSource: string;
    currency: string;
    currencySource: string;
    statusLogic: string;
    statusLogicSource: string;
    defaultCalendar: string;
    baseline: string;
  };
  /** True when anything was dropped or left unsupported: the UI must not claim plain success. */
  hasLoss: boolean;
  droppedItems: ReconItem[];
  droppedTotal: number;
  unsupportedItems: ReconItem[];
  unsupportedTotal: number;
}

export interface XerImportPlan {
  projectId: string;
  projectRow: Record<string, unknown>;
  calendarRows: Record<string, unknown>[];
  wbsRows: Record<string, unknown>[];
  resourceRows: Record<string, unknown>[];
  activityRows: Record<string, unknown>[];
  linkRows: Record<string, unknown>[];
  assignmentRows: Record<string, unknown>[];
  budgetLineRows: Record<string, unknown>[];
  baselineRow: Record<string, unknown> | null;
  baselineActivityRows: Record<string, unknown>[];
  recon: ReconReport;
}

export interface PersistResult {
  ok: boolean;
  projectId: string | null;
  failedStep: string | null;
  error: string | null;
  persisted: Record<string, number>;
  cleanedUp: boolean;
  cleanupErrors: string[];
}

const CAP = 40;

function cap<T>(items: T[]): { shown: T[]; total: number } {
  return { shown: items.slice(0, CAP), total: items.length };
}

// --------------------------------------------------------------------------- plan

export function buildXerImportPlan(parsed: ParsedXerResult, opts: XerImportOptions): XerImportPlan {
  if (!parsed.project) throw new Error('لم يتم العثور على مشروع في ملف XER');
  if (parsed.activities.length === 0) throw new Error('لم يتم العثور على أنشطة في ملف XER');

  const dropped: ReconItem[] = [];
  const unsupported: ReconItem[] = [];
  const drop = (entity: string, code: string, reason: string): void => {
    dropped.push({ entity, code, reason });
  };
  const unsup = (entity: string, code: string, reason: string): void => {
    unsupported.push({ entity, code, reason });
  };
  for (const w of parsed.warnings) {
    if (/dropped|unavailable|not imported|cannot resolve/i.test(w.reason)) drop(w.entity, w.code, w.reason);
    else unsup(w.entity, w.code, w.reason);
  }
  for (const f of parsed.unsupportedFields) {
    unsup(f.table, f.field, f.reason);
  }

  const projectId = crypto.randomUUID();
  const project = parsed.project;

  const projectRow: Record<string, unknown> = {
    id: projectId,
    name: opts.projectName || project.shortName,
    client: opts.client,
    location: opts.location,
    contract_value: opts.contractValue && opts.contractValue > 0 ? opts.contractValue : 0,
    currency: opts.currency || 'SAR',
    start_date: opts.startDate,
    end_date: opts.endDate,
    data_date: opts.dataDate,
    status_logic: project.statusLogic || 'retained_logic',
    status: 'active',
    description: opts.description,
  };

  // Calendars ---------------------------------------------------------------
  const calIdByXer = new Map<string, string>();
  const calendarRows = parsed.calendars.map((c) => {
    const id = crypto.randomUUID();
    calIdByXer.set(c.xerId, id);
    const dayHours: Record<string, number> = {};
    if (c.workweek) {
      for (const [day, info] of Object.entries(c.workweek)) dayHours[day] = info.hours;
    }
    return {
      id,
      project_id: projectId,
      p6_clndr_id: c.xerId,
      name: c.name,
      clndr_type: c.clndrType,
      is_default: c.isDefault,
      hours_per_day: c.hoursPerDay,
      hours_per_week: c.hoursPerWeek,
      base_p6_clndr_id: c.baseXerId,
      workweek_json: c.workweek
        ? { day_hours: dayHours, working_days: c.workingDaysPerWeek, day_index_base: 'P6 DaysOfWeek 1..7 (Sunday-first convention)' }
        : null,
      exceptions_json: c.exceptions,
    } satisfies Record<string, unknown>;
  });
  const calsUnsupported = parsed.calendars.filter((c) => c.patternStatus === 'unparseable' || c.patternStatus === 'exceptions_unsupported').length;

  // WBS (parents first: level, then seq_num, then file order) ----------------
  const wbsIdByXer = new Map<string, string>();
  const orderedWbs = [...parsed.wbs].sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    return (a.seqNum ?? Number.MAX_SAFE_INTEGER) - (b.seqNum ?? Number.MAX_SAFE_INTEGER);
  });
  const wbsRows = orderedWbs.map((w, idx) => {
    const id = crypto.randomUUID();
    wbsIdByXer.set(w.xerId, id);
    let parentId: string | null = null;
    if (w.parentXerId) {
      parentId = wbsIdByXer.get(w.parentXerId) || null;
      if (!parentId) drop('wbs', w.code, `parent WBS ${w.parentXerId} missing from file — node kept at root`);
    }
    return {
      id,
      project_id: projectId,
      parent_id: parentId,
      code: w.code,
      name: w.name,
      level: w.level,
      sort_order: w.seqNum ?? idx + 1,
    } satisfies Record<string, unknown>;
  });

  // Resources (only those assigned in this project) --------------------------
  const referencedRsrc = new Set(parsed.assignments.map((a) => a.rsrcXerId));
  const usedResources = parsed.resources.filter((r) => referencedRsrc.has(r.xerId));
  const skippedResources = parsed.resources.filter((r) => !referencedRsrc.has(r.xerId));
  const rsrcIdByXer = new Map<string, string>();
  const resourceRows = usedResources.map((r, idx) => {
    const id = crypto.randomUUID();
    rsrcIdByXer.set(r.xerId, id);
    return {
      id,
      project_id: projectId,
      name: r.code && r.code !== r.name ? `${r.code} — ${r.name}` : r.name,
      type: r.type,
      // Explicit nulls: the columns default to 'day'/0, which would claim facts the file
      // does not carry. Null is the honest "unavailable" the UI renders as N/A.
      unit: r.unit,
      unit_rate: r.rate,
      availability: null,
      sort_order: idx,
    } satisfies Record<string, unknown>;
  });
  void skippedResources;

  // Activities ----------------------------------------------------------------
  const actIdByXer = new Map<string, string>();
  const actCodeByXer = new Map<string, string>();
  const wbsOfAct = new Map<string, string | null>();
  const activityRows = parsed.activities.map((a, idx) => {
    const id = crypto.randomUUID();
    actIdByXer.set(a.xerId, id);
    actCodeByXer.set(a.xerId, a.code);
    let wbsId: string | null = null;
    if (a.wbsXerId) {
      wbsId = wbsIdByXer.get(a.wbsXerId) || null;
      if (!wbsId) drop('activity', a.code, `WBS ${a.wbsXerId} missing from file — activity kept without WBS`);
    } else {
      drop('activity', a.code, 'no wbs_id on TASK row — activity kept without WBS');
    }
    wbsOfAct.set(a.xerId, wbsId);
    let calendarId: string | null = null;
    if (a.clndrXerId) {
      calendarId = calIdByXer.get(a.clndrXerId) || null;
      if (!calendarId) drop('activity', a.code, `calendar ${a.clndrXerId} not in file — assignment unavailable`);
    }
    if (a.durationTypeRaw) unsup('activity', a.code, `duration_type ${a.durationTypeRaw} — no destination column`);
    if (a.percentTypeRaw) unsup('activity', a.code, `complete_pct_type ${a.percentTypeRaw} used for % derivation — type itself not stored`);
    if (a.milestoneKind) unsup('activity', a.code, `milestone kind ${a.milestoneKind} — no destination column`);
    if (a.targetStart || a.targetEnd) unsup('activity', a.code, 'target (planned) dates present — no destination column apart from early dates');
    return {
      id,
      project_id: projectId,
      wbs_node_id: wbsId,
      calendar_id: calendarId,
      code: a.code,
      name: a.name,
      activity_type: a.activityType,
      early_start: a.earlyStart,
      early_finish: a.earlyFinish,
      late_start: a.lateStart,
      late_finish: a.lateFinish,
      actual_start: a.actualStart,
      actual_finish: a.actualFinish,
      expected_finish_date: a.expectedFinish,
      duration_days: a.durationDays,
      remaining_duration_days: a.remainingDays,
      percent_complete: a.percentComplete,
      total_float: a.totalFloatDays ?? 0,
      free_float: a.freeFloatDays ?? 0,
      is_critical: a.isCritical,
      is_milestone: a.isMilestone,
      constraint_type: a.constraintType,
      constraint_date: a.constraintDate,
      sort_order: idx + 1,
    } satisfies Record<string, unknown>;
  });

  // Links ---------------------------------------------------------------------
  const linkRows: Record<string, unknown>[] = [];
  for (const l of parsed.links) {
    const predId = actIdByXer.get(l.predXerId);
    const succId = actIdByXer.get(l.succXerId);
    const label = `${actCodeByXer.get(l.predXerId) || l.predXerId} -> ${actCodeByXer.get(l.succXerId) || l.succXerId}`;
    if (l.crossProject) {
      drop('link', label, `cross-project predecessor (pred_proj_id=${l.predProjId}) — F1 imports one project`);
      continue;
    }
    if (!l.linkType) {
      drop('link', label, `unknown pred_type ${l.linkTypeRaw} — dropped, never defaulted`);
      continue;
    }
    if (!predId || !succId) {
      drop('link', label, 'predecessor or successor task missing from file — dropped');
      continue;
    }
    linkRows.push({
      project_id: projectId,
      predecessor_id: predId,
      successor_id: succId,
      link_type: l.linkType,
      lag_days: l.lagDays,
    });
  }

  // Assignments ----------------------------------------------------------------
  const assignmentRows: Record<string, unknown>[] = [];
  const budgetLineRows: Record<string, unknown>[] = [];
  let costlessCount = 0;
  const rsrcCodeByXer = new Map(parsed.resources.map((r) => [r.xerId, r.code]));
  for (const a of parsed.assignments) {
    const activityId = actIdByXer.get(a.taskXerId);
    const resourceId = rsrcIdByXer.get(a.rsrcXerId);
    const label = `${actCodeByXer.get(a.taskXerId) || a.taskXerId} / ${rsrcCodeByXer.get(a.rsrcXerId) || a.rsrcXerId}`;
    if (!activityId || !resourceId) {
      drop('assignment', label, 'activity or resource missing from file — dropped');
      continue;
    }
    assignmentRows.push({
      project_id: projectId,
      activity_id: activityId,
      resource_id: resourceId,
      planned_quantity: a.plannedQty,
      actual_quantity: a.actualQty,
      remaining_quantity: a.remainQty,
    });
    if (a.targetCost !== null || a.actualCost !== null || a.remainCost !== null) {
      budgetLineRows.push({
        project_id: projectId,
        wbs_node_id: wbsOfAct.get(a.taskXerId) || null,
        activity_id: null,
        description: `${actCodeByXer.get(a.taskXerId)} · ${rsrcCodeByXer.get(a.rsrcXerId)}`,
        planned_cost: a.targetCost,
        actual_cost: a.actualCost,
        remaining_cost: a.remainCost,
        budget_basis: 'xer_import',
      });
    } else {
      costlessCount += 1;
      unsup('assignment', label, 'no target/actual/remain cost on TASKRSRC row — units imported, no budget line');
    }
  }
  for (const e of parsed.expenses) {
    const activityId = actIdByXer.get(e.taskXerId);
    if (!activityId) {
      drop('expense', e.name, 'activity missing from file — dropped');
      continue;
    }
    if (e.targetCost === null && e.actualCost === null && e.remainCost === null) {
      costlessCount += 1;
      unsup('expense', `${actCodeByXer.get(e.taskXerId)} · ${e.name}`, 'PROJCOST row without costs — nothing to import');
      continue;
    }
    budgetLineRows.push({
      project_id: projectId,
      wbs_node_id: wbsOfAct.get(e.taskXerId) || null,
      activity_id: null,
      description: `${actCodeByXer.get(e.taskXerId)} · ${e.name}`,
      planned_cost: e.targetCost,
      actual_cost: e.actualCost,
      remaining_cost: e.remainCost,
      budget_basis: 'xer_import',
    });
  }

  // Baseline -------------------------------------------------------------------
  let baselineRow: Record<string, unknown> | null = null;
  const baselineActivityRows: Record<string, unknown>[] = [];
  let baselineNote: string;
  const actIdByCode = new Map<string, string>();
  for (const [xerId, id] of actIdByXer) {
    const code = actCodeByXer.get(xerId);
    if (code && !actIdByCode.has(code)) actIdByCode.set(code, id);
  }
  if (parsed.baseline.status === 'available') {
    const baselineId = crypto.randomUUID();
    baselineRow = {
      id: baselineId,
      project_id: projectId,
      version: 1,
      name: `P6 Baseline (${parsed.baseline.baseShortName})`,
      status: 'draft',
      is_active: true,
    };
    for (const t of parsed.baseline.tasks) {
      const activityId = actIdByCode.get(t.code);
      if (!activityId) {
        drop('baseline', t.code, 'baseline task has no live activity with the same code — row skipped');
        continue;
      }
      const start = t.earlyStart || t.targetStart;
      const finish = t.earlyFinish || t.targetEnd;
      if (!start || !finish) {
        drop('baseline', t.code, 'baseline task has no early/target dates — row skipped (dates are NOT NULL)');
        continue;
      }
      baselineActivityRows.push({
        baseline_id: baselineId,
        activity_id: activityId,
        early_start: start,
        early_finish: finish,
        duration_days: t.durationDays ?? 0,
        planned_cost: t.plannedCost ?? 0,
      });
    }
    baselineNote = `P6 baseline "${parsed.baseline.baseShortName}" imported (${baselineActivityRows.length}/${parsed.baseline.tasks.length} tasks mapped by code)`;
    if (opts.createInitialBaseline) {
      unsup('baseline', 'opt-in', 'initial-baseline opt-in ignored: a real P6 baseline was imported instead');
    }
  } else if (opts.createInitialBaseline) {
    const baselineId = crypto.randomUUID();
    baselineRow = {
      id: baselineId,
      project_id: projectId,
      version: 1,
      name: 'Initial Baseline (user-confirmed from import)',
      status: 'approved',
      approved_at: new Date().toISOString(),
      is_active: true,
    };
    parsed.activities.forEach((a) => {
      const activityId = actIdByXer.get(a.xerId);
      if (!activityId || !a.earlyStart || !a.earlyFinish) {
        drop('baseline', a.code, 'activity lacks early dates — excluded from the initial baseline');
        return;
      }
      baselineActivityRows.push({
        baseline_id: baselineId,
        activity_id: activityId,
        early_start: a.earlyStart,
        early_finish: a.earlyFinish,
        duration_days: a.durationDays ?? 0,
        planned_cost: 0,
      });
    });
    baselineNote = `No P6 baseline in file — user-confirmed initial baseline created from the imported plan (${baselineActivityRows.length} activities; planned_cost 0 = no activity cost evidence, not a measured zero)`;
  } else {
    baselineNote = parsed.baseline.status === 'referenced_but_missing'
      ? `No Baseline Imported — ${parsed.baseline.note}`
      : 'No Baseline Imported — file carries no baseline project (imported plan is current, not approved)';
  }

  // Reconciliation ----------------------------------------------------------------
  const section = (
    entity: string, source: number, imported: number, droppedN: number, unsupportedN: number, notes: string[] = [],
  ): ReconSection => ({ entity, source, imported, dropped: droppedN, unsupported: unsupportedN, notes });
  const actualsPreserved = parsed.activities.filter((a) => a.actualStart || a.actualFinish).length;
  const constraintsImported = parsed.activities.filter((a) => a.constraintType).length;
  const constraintsSource = parsed.activities.filter((a) => a.constraintRaw).length;
  const sections: ReconSection[] = [
    section('Project', 1, 1, 0, 0, skippedProjectsNote()),
    section('WBS', parsed.wbs.length, wbsRows.length, countDrops('wbs'), 0),
    section('Activities', parsed.activities.length, activityRows.length, countDrops('activity'), 0),
    section('Relationships', parsed.links.length, linkRows.length, parsed.links.length - linkRows.length, 0),
    section('Calendars', parsed.calendars.length, calendarRows.length, 0, calsUnsupported),
    section('Resources', parsed.resources.length, resourceRows.length, 0, 0,
      skippedResources.length > 0 ? [`${skippedResources.length} resource(s) not assigned in this project — skipped`] : []),
    section('Assignments', parsed.assignments.length, assignmentRows.length, parsed.assignments.length - assignmentRows.length, 0,
      parsed.outOfScopeAssignments > 0 ? [`${parsed.outOfScopeAssignments} assignment(s) belong to other projects' tasks — out of scope`] : []),
    section('Constraints', constraintsSource, constraintsImported, constraintsSource - constraintsImported, 0),
    section('Actual dates', actualsPreserved, actualsPreserved, 0, 0,
      [`${actualsPreserved}/${parsed.activities.length} activities carry actual start/finish — all preserved`]),
    section('Budget lines (costs)', parsed.assignments.length + parsed.expenses.length, budgetLineRows.length, dropped.filter((d) => d.entity === 'expense').length, costlessCount,
      ['one line per assignment/expense with cost evidence; activity_id=NULL keeps P6 figures trigger-safe']),
    section('Baseline', parsed.baseline.tasks.length, baselineActivityRows.length, parsed.baseline.tasks.length - baselineActivityRows.length, 0, [baselineNote]),
  ];

  function skippedProjectsNote(): string[] {
    if (parsed.skippedProjects.length === 0) return [];
    return parsed.skippedProjects.map((s) => `project ${s.shortName}: ${s.reason}`);
  }
  function countDrops(entity: string): number {
    return dropped.filter((d) => d.entity === entity).length;
  }

  const cappedDrops = cap(dropped);
  const cappedUnsup = cap(unsupported);
  const hasLoss = dropped.length > 0 || unsupported.length > 0 || calsUnsupported > 0;

  const defaultCalName = parsed.calendars.find((c) => c.isDefault)?.name || 'none declared in file';
  const recon: ReconReport = {
    projectName: String(projectRow['name'] || project.shortName),
    sections,
    provenance: {
      dataDate: opts.dataDate,
      dataDateSource: project.dataDate
        ? 'PROJECT.data_date from file'
        : opts.dataDate
          ? 'user override (file carries no PROJECT.data_date)'
          : 'unavailable — file carries no PROJECT.data_date and no override given',
      currency: String(projectRow['currency'] || 'SAR'),
      currencySource: parsed.header.currency
        ? `ERMHDR declares ${parsed.header.currency}`
        : 'current setting (file declares no currency)',
      statusLogic: project.statusLogic || 'retained_logic',
      statusLogicSource: project.statusLogicSource || 'default (no SCHEDOPTIONS evidence in file)',
      defaultCalendar: project.defaultClndrId
        ? `${defaultCalName} (PROJECT.clndr_id=${project.defaultClndrId})`
        : 'none declared — conversions fall back per activity (see basis notes)',
      baseline: baselineNote,
    },
    hasLoss,
    droppedItems: cappedDrops.shown,
    droppedTotal: cappedDrops.total,
    unsupportedItems: cappedUnsup.shown,
    unsupportedTotal: cappedUnsup.total,
  };

  return {
    projectId,
    projectRow,
    calendarRows,
    wbsRows,
    resourceRows,
    activityRows,
    linkRows,
    assignmentRows,
    budgetLineRows,
    baselineRow,
    baselineActivityRows,
    recon,
  };
}

// --------------------------------------------------------------------------- persist

// Every table here carries project_id; child rows without it (baseline_activities) disappear
// through ON DELETE CASCADE when their parent goes.
const CLEANUP_TABLES = [
  'activity_links',
  'activity_resources',
  'activities',
  'resources',
  'calendars',
  'wbs_nodes',
  'budget_lines',
  'project_baselines',
];

export async function persistXerImportPlan(client: XerDbClient, plan: XerImportPlan): Promise<PersistResult> {
  const persisted: Record<string, number> = {};
  const mark = (table: string, rows: unknown[] | Record<string, unknown> | null): void => {
    persisted[table] = rows === null ? 0 : Array.isArray(rows) ? rows.length : 1;
  };
  const insertStep = async (step: string, table: string, rows: Record<string, unknown> | Record<string, unknown>[]): Promise<void> => {
    const list = Array.isArray(rows) ? rows : [rows];
    if (list.length === 0) {
      mark(table, []);
      return;
    }
    let result: XerDbQueryResult;
    try {
      result = await client.from(table).insert(list.length === 1 && !Array.isArray(rows) ? rows : list).select();
    } catch (err) {
      throw new Error(`${step}: ${(err as Error).message || 'insert failed'}`);
    }
    if (result.error) throw new Error(`${step}: ${result.error.message}`);
    mark(table, list);
  };

  try {
    await insertStep('create project', 'projects', plan.projectRow);
    await insertStep('save calendars', 'calendars', plan.calendarRows);
    await insertStep('save WBS', 'wbs_nodes', plan.wbsRows);
    await insertStep('save resources', 'resources', plan.resourceRows);
    await insertStep('save activities', 'activities', plan.activityRows);
    await insertStep('save relationships', 'activity_links', plan.linkRows);
    await insertStep('save assignments', 'activity_resources', plan.assignmentRows);
    await insertStep('save cost lines', 'budget_lines', plan.budgetLineRows);
    if (plan.baselineRow) {
      await insertStep('save baseline header', 'project_baselines', plan.baselineRow);
      await insertStep('save baseline activities', 'baseline_activities', plan.baselineActivityRows);
    } else {
      mark('project_baselines', []);
      mark('baseline_activities', []);
    }
    return { ok: true, projectId: plan.projectId, failedStep: null, error: null, persisted, cleanedUp: true, cleanupErrors: [] };
  } catch (err) {
    const message = (err as Error).message || 'persist failed';
    const failedStep = message.split(':')[0] || 'persist';
    // All-or-clean: best-effort reverse-order cleanup, then report honestly.
    const cleanupErrors: string[] = [];
    for (const table of CLEANUP_TABLES) {
      try {
        const res = await client.from(table).delete().eq('project_id', plan.projectId);
        if (res.error) cleanupErrors.push(`${table}: ${res.error.message}`);
      } catch (e) {
        cleanupErrors.push(`${table}: ${(e as Error).message || 'delete failed'}`);
      }
    }
    try {
      const res = await client.from('projects').delete().eq('id', plan.projectId);
      if (res.error) cleanupErrors.push(`projects: ${res.error.message}`);
    } catch (e) {
      cleanupErrors.push(`projects: ${(e as Error).message || 'delete failed'}`);
    }
    return {
      ok: false,
      projectId: null,
      failedStep,
      error: message,
      persisted,
      cleanedUp: cleanupErrors.length === 0,
      cleanupErrors,
    };
  }
}

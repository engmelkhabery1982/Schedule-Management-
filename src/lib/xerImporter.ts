import type { ActivityConstraintType, ActivityType } from '@/types';

/**
 * High-fidelity Primavera P6 XER parser (Phase F1).
 *
 * Field names below are the real P6 XER names, verified against Oracle's "Tables and Fields
 * Exported to XER when Exporting Projects" documentation and a real P6 8.1 export. Nothing here
 * is guessed: any %F field the parser does not explicitly handle is reported in
 * `unsupportedFields`, so a newer P6 version can never silently lose data through this importer.
 *
 * Provenance rules (no invention):
 * - Hours convert to days on the governing calendar's day_hr_cnt, never a flat 8h assumption
 *   unless the file carries no calendar hours (reported per activity/link in that case).
 * - Lags convert on the PREDECESSOR calendar's hours/day (P6 display-conversion rule).
 * - P6's null date (1899-12-30) and empty values become null, never the machine date.
 * - Criticality follows PROJECT.critical_drtn_hr_cnt ("float <= threshold"), P6's own rule.
 * - Data Date is read only from an explicit PROJECT.data_date value; P6 exports do not
 *   reliably carry one, so absence is reported, not backfilled from plan_start or the clock.
 */

// --------------------------------------------------------------------------- table scan

export interface XerFileHeader {
  version: string | null;
  exportDate: string | null;
  /** Currency code declared by the ERMHDR line (e.g. USD), when parseable. */
  currency: string | null;
  raw: string | null;
}

interface XerTable {
  fields: string[];
  rows: Record<string, string>[];
}

function scanXerTables(xerText: string): { header: XerFileHeader; tables: Record<string, XerTable> } {
  const header: XerFileHeader = { version: null, exportDate: null, currency: null, raw: null };
  const tables: Record<string, XerTable> = {};
  let current: XerTable | null = null;

  for (const rawLine of xerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('ERMHDR')) {
      const parts = line.split('\t').map((p) => p.trim());
      header.raw = line;
      header.version = parts[1] || null;
      header.exportDate = parts[2] ? parts[2].slice(0, 10) : null;
      const tail = [...parts].reverse().find((p) => /^[A-Z]{3}$/.test(p));
      header.currency = tail || null;
      continue;
    }
    if (line === '%E') break;
    if (line.startsWith('%T')) {
      const name = (line.split('\t')[1] || '').trim();
      if (!name) {
        current = null;
        continue;
      }
      current = { fields: [], rows: [] };
      tables[name] = current;
      continue;
    }
    if (line.startsWith('%F')) {
      if (current) current.fields = line.split('\t').slice(1).map((f) => f.trim().toLowerCase());
      continue;
    }
    if (line.startsWith('%R')) {
      if (!current || current.fields.length === 0) continue;
      const values = line.substring(2).split('\t');
      const tokens = values[0] === '' ? values.slice(1) : values;
      const row: Record<string, string> = {};
      current.fields.forEach((field, i) => {
        row[field] = (tokens[i] || '').trim();
      });
      current.rows.push(row);
    }
    // Any other %-line is ignored: unknown markers must not break the parse.
  }
  return { header, tables };
}

// --------------------------------------------------------------------------- value helpers

/** P6 null-date sentinel: 1899-12-30 (any time component) means "no date". */
const P6_NULL_DATE = '1899-12-30';

/** 'YYYY-MM-DD HH:MM' | 'YYYY-MM-DD' -> 'YYYY-MM-DD'; null-date/empty/invalid -> null. */
export function parseXerDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const day = cleaned.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day === P6_NULL_DATE) return null;
  const month = Number(day.slice(5, 7));
  const dom = Number(day.slice(8, 10));
  if (month < 1 || month > 12 || dom < 1 || dom > 31) return null;
  return day;
}

export function parseXerNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** OLE automation serial (days since 1899-12-30) -> ISO date; out-of-range -> null. */
function oleSerialToIso(serial: number): string | null {
  if (!Number.isInteger(serial)) return null;
  const millis = Date.UTC(1899, 11, 30) + serial * 86400000;
  const d = new Date(millis);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  // Sanity window: P6 exceptions outside 1990..2100 are treated as corrupt, not stored.
  if (iso < '1990-01-01' || iso > '2100-12-31') return null;
  return iso;
}

export interface XerWorkweekDay {
  working: boolean;
  periods: Array<{ start: string; finish: string }>;
  hours: number;
}

export interface ParsedClndrData {
  workweek: Record<string, XerWorkweekDay>;
  workingDays: number;
  /** Non-working exception dates (ISO). Null when the block is absent or has working overrides. */
  exceptions: string[] | null;
  exceptionsUnsupported: boolean;
}

/**
 * Decode CALENDAR.clndr_data: `(0||DaysOfWeek()( (0||1()()) (0||2()( (0||0(s|08:00|f|12:00)()) ...
 * Day indices are P6 DaysOfWeek 1..7 (Sunday-first convention: a standard US 5-day week carries
 * working days 2..6). Returns null when the blob is absent or structurally unrecognised — the
 * caller then reports the pattern as unsupported instead of guessing it.
 */
export function parseClndrData(blob: string | undefined | null): ParsedClndrData | null {
  if (!blob || !blob.includes('DaysOfWeek')) return null;
  const weekStart = blob.indexOf('DaysOfWeek');
  const viewAt = blob.indexOf('(0||VIEW', weekStart);
  const excAt = blob.indexOf('(0||Exceptions(', weekStart);
  // Day markers look like `(0||N()..`; period markers look like `(0||P(s|..`. The char after
  // the marker's open paren disambiguates, so a many-period day can never truncate a section.
  const dayMarkerAt = (day: number, from: number): number => {
    const marker = `(0||${day}(`;
    let at = blob.indexOf(marker, from);
    while (at >= 0) {
      const next = blob[at + marker.length];
      if (next === '(' || next === ')') return at;
      at = blob.indexOf(marker, at + marker.length);
    }
    return -1;
  };
  const workweek: Record<string, XerWorkweekDay> = {};
  for (let day = 1; day <= 7; day += 1) {
    const at = dayMarkerAt(day, weekStart);
    if (at < 0) return null;
    const nextDay = day < 7 ? dayMarkerAt(day + 1, at + 1) : -1;
    const ends = [nextDay, viewAt, excAt, blob.length].filter((v) => v > at);
    const section = blob.slice(at, Math.min(...ends));
    const periods: Array<{ start: string; finish: string }> = [];
    const re = /\(s\|(\d{2}:\d{2})\|f\|(\d{2}:\d{2})\)/g;
    let m: RegExpExecArray | null;
    let valid = true;
    while ((m = re.exec(section)) !== null) {
      const [sH, sM] = m[1].split(':').map(Number);
      const [fH, fM] = m[2].split(':').map(Number);
      const sMin = sH * 60 + sM;
      const fMin = fH * 60 + fM;
      if (sH > 23 || fH > 23 || sM > 59 || fM > 59 || fMin <= sMin) {
        valid = false;
        break;
      }
      periods.push({ start: m[1], finish: m[2] });
    }
    if (!valid) return null;
    const hours = periods.reduce((sum, p) => {
      const [sH, sM] = p.start.split(':').map(Number);
      const [fH, fM] = p.finish.split(':').map(Number);
      return sum + (fH * 60 + fM - (sH * 60 + sM)) / 60;
    }, 0);
    workweek[String(day)] = { working: periods.length > 0, periods, hours: Number(hours.toFixed(2)) };
  }
  const workingDays = Object.values(workweek).filter((d) => d.working).length;

  let exceptions: string[] | null = null;
  let exceptionsUnsupported = false;
  if (excAt >= 0) {
    const excSection = blob.slice(excAt);
    const tokens = excSection.split(/\(d\|\d+\)/);
    // A (d|N) block carrying (s|..) segments is a working-time override, which this parser
    // cannot model: report the whole exception set as unsupported rather than misstore it.
    if (tokens.some((seg) => seg.includes('(s|'))) {
      exceptionsUnsupported = true;
    } else {
      const serials = [...excSection.matchAll(/\(d\|(\d+)\)/g)]
        .map((hit) => oleSerialToIso(Number(hit[1])))
        .filter((iso): iso is string => iso !== null);
      const distinct = [...new Set(serials)].sort();
      exceptions = distinct;
      if (distinct.length === 0) exceptions = [];
    }
  }
  return { workweek, workingDays, exceptions, exceptionsUnsupported };
}

// --------------------------------------------------------------------------- source model

export interface XerWarning {
  entity: string;
  code: string;
  reason: string;
}

export interface XerUnsupportedField {
  table: string;
  field: string;
  reason: string;
}

export interface XerProjectSource {
  projId: string;
  shortName: string;
  planStart: string | null;
  planEnd: string | null;
  scheduleFinish: string | null;
  forecastStart: string | null;
  dataDate: string | null;
  referenceDates: Array<{ label: string; field: string; value: string }>;
  defaultClndrId: string | null;
  criticalDrtnHours: number;
  criticalPathType: string | null;
  sumBaseProjId: string | null;
  defDurationType: string | null;
  defCompletePctType: string | null;
  defTaskType: string | null;
  lastRecalcDate: string | null;
  statusLogic: 'retained_logic' | 'progress_override' | null;
  statusLogicSource: string | null;
}

export interface XerWbsSource {
  xerId: string;
  parentXerId: string | null;
  code: string;
  name: string;
  seqNum: number | null;
  level: number;
}

export interface XerCalendarSource {
  xerId: string;
  name: string;
  clndrType: string | null;
  isDefault: boolean;
  defaultFlag: string | null;
  hoursPerDay: number | null;
  hoursPerWeek: number | null;
  baseXerId: string | null;
  workweek: Record<string, XerWorkweekDay> | null;
  workingDaysPerWeek: number | null;
  exceptions: string[] | null;
  patternStatus: 'parsed' | 'no_data' | 'unparseable' | 'exceptions_unsupported';
  isGlobal: boolean;
}

export interface XerActivitySource {
  xerId: string;
  wbsXerId: string | null;
  clndrXerId: string | null;
  code: string;
  name: string;
  taskTypeRaw: string | null;
  activityType: ActivityType;
  taskTypeKnown: boolean;
  statusCode: string | null;
  durationDays: number | null;
  durationHours: number | null;
  durationBasis: string;
  durationRounded: boolean;
  remainingDays: number | null;
  remainingHours: number | null;
  remainingBasis: string | null;
  percentComplete: number;
  percentSource: string;
  percentTypeRaw: string | null;
  durationTypeRaw: string | null;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  expectedFinish: string | null;
  targetStart: string | null;
  targetEnd: string | null;
  totalFloatDays: number | null;
  freeFloatDays: number | null;
  floatBasis: string | null;
  isCritical: boolean;
  criticalBasis: string;
  isMilestone: boolean;
  milestoneKind: 'start' | 'finish' | null;
  constraintType: ActivityConstraintType | null;
  constraintDate: string | null;
  constraintRaw: string | null;
  sortHint: number;
}

export interface XerLinkSource {
  predXerId: string;
  succXerId: string;
  predProjId: string | null;
  linkType: 'FS' | 'SS' | 'FF' | 'SF' | null;
  linkTypeRaw: string | null;
  lagDays: number;
  lagHours: number | null;
  lagBasis: string;
  lagRounded: boolean;
  crossProject: boolean;
}

export interface XerResourceSource {
  xerId: string;
  code: string;
  name: string;
  type: 'labor' | 'equipment' | 'material';
  typeRaw: string | null;
  clndrXerId: string | null;
  unit: string | null;
  unitSource: string;
  rate: number | null;
  rateSource: string;
  otFactor: number | null;
  maxUnitsPerHour: number | null;
}

export interface XerAssignmentSource {
  xerId: string;
  taskXerId: string;
  rsrcXerId: string;
  plannedQty: number | null;
  actualQty: number | null;
  remainQty: number | null;
  targetCost: number | null;
  actualCost: number | null;
  remainCost: number | null;
  costPerQty: number | null;
  qtyPerHour: number | null;
}

export interface XerExpenseSource {
  xerId: string;
  taskXerId: string;
  name: string;
  targetCost: number | null;
  actualCost: number | null;
  remainCost: number | null;
  targetQty: number | null;
  unitName: string | null;
}

export interface XerBaselineTask {
  code: string;
  earlyStart: string | null;
  earlyFinish: string | null;
  targetStart: string | null;
  targetEnd: string | null;
  durationDays: number | null;
  plannedCost: number | null;
}

export interface XerBaselineSource {
  status: 'available' | 'referenced_but_missing' | 'unavailable';
  baseProjId: string | null;
  baseShortName: string | null;
  tasks: XerBaselineTask[];
  note: string | null;
}

export interface ParsedXerResult {
  header: XerFileHeader;
  project: XerProjectSource | null;
  skippedProjects: Array<{ projId: string; shortName: string; reason: string }>;
  wbs: XerWbsSource[];
  calendars: XerCalendarSource[];
  activities: XerActivitySource[];
  links: XerLinkSource[];
  resources: XerResourceSource[];
  assignments: XerAssignmentSource[];
  outOfScopeAssignments: number;
  expenses: XerExpenseSource[];
  baseline: XerBaselineSource;
  sourceCounts: Record<string, number>;
  warnings: XerWarning[];
  unsupportedFields: XerUnsupportedField[];
}

// Fields the parser deliberately consumes per table. Any other %F field present in the file is
// auto-reported as unsupported (never silently dropped), except pure bookkeeping in IGNORED.
const HANDLED: Record<string, Set<string>> = {
  PROJECT: new Set([
    'proj_id', 'proj_short_name', 'plan_start_date', 'plan_end_date', 'scd_end_date',
    'fcst_start_date', 'data_date', 'next_data_date', 'apply_actuals_date', 'last_recalc_date',
    'clndr_id', 'critical_drtn_hr_cnt', 'critical_path_type', 'sum_base_proj_id',
    'def_duration_type', 'def_complete_pct_type', 'def_task_type',
  ]),
  PROJWBS: new Set(['wbs_id', 'parent_wbs_id', 'wbs_short_name', 'wbs_name', 'seq_num', 'proj_id']),
  WBSS: new Set(['wbs_id', 'parent_wbs_id', 'wbs_short_name', 'wbs_name', 'seq_num', 'proj_id']),
  CALENDAR: new Set([
    'clndr_id', 'clndr_name', 'clndr_type', 'default_flag', 'day_hr_cnt', 'week_hr_cnt',
    'base_clndr_id', 'clndr_data', 'proj_id',
  ]),
  TASK: new Set([
    'task_id', 'proj_id', 'wbs_id', 'clndr_id', 'task_code', 'task_name', 'task_type',
    'status_code', 'complete_pct_type', 'duration_type', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt',
    'phys_complete_pct', 'act_work_qty', 'remain_work_qty', 'early_start_date', 'early_end_date',
    'late_start_date', 'late_end_date', 'act_start_date', 'act_end_date', 'expect_end_date',
    'target_start_date', 'target_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt',
    'cstr_type', 'cstr_date', 'cstr_type2', 'cstr_date2',
  ]),
  TASKPRED: new Set(['task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_proj_id', 'pred_type', 'lag_hr_cnt']),
  RSRC: new Set(['rsrc_id', 'rsrc_short_name', 'rsrc_name', 'rsrc_type', 'clndr_id', 'curr_id', 'unit_id', 'ot_factor', 'unit_of_measure']),
  RSRCRATE: new Set(['rsrc_rate_id', 'rsrc_id', 'start_date', 'cost_per_qty', 'max_qty_per_hr', 'shift_period_id']),
  TASKRSRC: new Set([
    'taskrsrc_id', 'task_id', 'proj_id', 'rsrc_id', 'target_qty', 'act_reg_qty', 'act_ot_qty',
    'remain_qty', 'target_cost', 'act_reg_cost', 'act_ot_cost', 'remain_cost', 'cost_per_qty',
    'target_qty_per_hr', 'remain_qty_per_hr', 'rate_type',
  ]),
  PROJCOST: new Set(['cost_item_id', 'task_id', 'proj_id', 'cost_name', 'target_cost', 'act_cost', 'remain_cost', 'target_qty', 'qty_name']),
  UMEASURE: new Set(['unit_id', 'unit_abbrev', 'unit_name', 'seq_num']),
  SCHEDOPTIONS: new Set(['schedoptions_id', 'proj_id', 'sched_retained_logic', 'sched_progress_override']),
  CURRTYPE: new Set(['curr_id', 'curr_short_name', 'curr_symbol']),
};

const IGNORED: Set<string> = new Set([
  // Row identity / file bookkeeping / audit columns: read past, never content.
  'guid', 'tmpl_guid', 'rev_num', 'last_checksum', 'seq_num', 'create_date', 'create_user',
  'update_date', 'update_user', 'add_by_name', 'add_date', 'orig_proj_id', 'source_proj_id',
]);

function collectUnsupportedFields(
  tables: Record<string, XerTable>,
  out: XerUnsupportedField[],
): void {
  for (const [name, table] of Object.entries(tables)) {
    const handled = HANDLED[name];
    if (!handled) {
      // Whole table outside the F1 schedule scope (codes, risks, thresholds, ...).
      if (table.fields.length > 0) {
        out.push({ table: name, field: '*', reason: `table outside the F1 Time/Cost scope (${table.rows.length} row(s) not imported)` });
      }
      continue;
    }
    for (const field of table.fields) {
      if (!handled.has(field) && !IGNORED.has(field)) {
        out.push({ table: name, field, reason: 'present in file, no destination column in F1 — value not imported' });
      }
    }
  }
}

const TASK_TYPE_MAP: Record<string, ActivityType> = {
  TT_Task: 'task_dependent',
  TT_Rsrc: 'resource_dependent',
  TT_LOE: 'level_of_effort',
  TT_Mile: 'start_milestone',
  TT_FinMile: 'finish_milestone',
  TT_WBS: 'wbs_summary',
};

const CONSTRAINT_MAP: Record<string, ActivityConstraintType> = {
  CS_ALAP: 'ALAP',
  ALAP: 'ALAP',
  CS_MSO: 'MSO',
  MSO: 'MSO',
  CS_MFO: 'MFO',
  MFO: 'MFO',
  CS_SNET: 'SNET',
  SNET: 'SNET',
  CS_SNLT: 'SNLT',
  SNLT: 'SNLT',
  CS_FNET: 'FNET',
  FNET: 'FNET',
  CS_FNLT: 'FNLT',
  FNLT: 'FNLT',
  CS_MANDSTART: 'MS',
  MS: 'MS',
  CS_MANDFIN: 'MF',
  MF: 'MF',
};

/** Constraints that are meaningless without a date (ALAP needs none). */
const DATELESS_OK: Set<ActivityConstraintType> = new Set(['ALAP', 'ASAP']);

function hoursToDays(hours: number | null, hoursPerDay: number): { days: number | null; rounded: boolean } {
  if (hours === null) return { days: null, rounded: false };
  const exact = hours / hoursPerDay;
  const days = Math.round(exact);
  return { days, rounded: Math.abs(exact - days) > 1e-9 };
}

export function parseXerContent(xerText: string): ParsedXerResult {
  const { header, tables } = scanXerTables(xerText);
  const warnings: XerWarning[] = [];
  const unsupportedFields: XerUnsupportedField[] = [];
  collectUnsupportedFields(tables, unsupportedFields);

  const rowsOf = (name: string): Record<string, string>[] => tables[name]?.rows || [];
  const warn = (entity: string, code: string, reason: string): void => {
    warnings.push({ entity, code, reason });
  };

  // ---------------------------------------------------------------- project selection
  const projectRows = rowsOf('PROJECT');
  const taskProjCounts = new Map<string, number>();
  for (const row of rowsOf('TASK')) {
    const pid = (row['proj_id'] || '').trim();
    if (pid) taskProjCounts.set(pid, (taskProjCounts.get(pid) || 0) + 1);
  }
  const baselineRefIds = new Set(
    projectRows.map((r) => (r['sum_base_proj_id'] || '').trim()).filter(Boolean),
  );
  const candidates = projectRows.filter((r) => {
    const pid = (r['proj_id'] || '').trim();
    return pid && !baselineRefIds.has(pid) && (taskProjCounts.get(pid) || 0) > 0;
  });
  const chosenRow = candidates[0] || projectRows.find((r) => (r['proj_id'] || '').trim()) || null;
  const projId = chosenRow ? (chosenRow['proj_id'] || '').trim() : '';
  const skippedProjects = projectRows
    .filter((r) => r !== chosenRow)
    .map((r) => {
      const pid = (r['proj_id'] || '').trim() || '?';
      const shortName = r['proj_short_name'] || pid;
      const reason = baselineRefIds.has(pid)
        ? 'baseline project referenced by sum_base_proj_id — read as baseline source, not as live plan'
        : (taskProjCounts.get(pid) || 0) === 0
          ? 'no TASK rows for this project in the file'
          : 'multi-project file — F1 imports the first project with activities';
      return { projId: pid, shortName, reason };
    });

  const inScope = (row: Record<string, string>): boolean => {
    const pid = (row['proj_id'] || '').trim();
    return pid === '' || pid === projId;
  };

  // ---------------------------------------------------------------- project + options
  let project: XerProjectSource | null = null;
  if (chosenRow && projId) {
    const schedRow = rowsOf('SCHEDOPTIONS').find((r) => (r['proj_id'] || '').trim() === projId) || null;
    const retained = (schedRow?.['sched_retained_logic'] || '').trim().toUpperCase();
    const override = (schedRow?.['sched_progress_override'] || '').trim().toUpperCase();
    const statusLogic = retained === 'Y' ? 'retained_logic' : override === 'Y' ? 'progress_override' : null;
    const referenceDates: Array<{ label: string; field: string; value: string }> = [];
    const ref = (label: string, field: string): void => {
      const value = parseXerDate(chosenRow[field]);
      if (value) referenceDates.push({ label, field, value });
    };
    ref('Last scheduled', 'last_recalc_date');
    ref('Next data date (apply-actuals workflow)', 'next_data_date');
    ref('Apply actuals date', 'apply_actuals_date');
    ref('Forecast start', 'fcst_start_date');
    project = {
      projId,
      shortName: chosenRow['proj_short_name'] || projId,
      planStart: parseXerDate(chosenRow['plan_start_date']),
      planEnd: parseXerDate(chosenRow['plan_end_date']),
      scheduleFinish: parseXerDate(chosenRow['scd_end_date']),
      forecastStart: parseXerDate(chosenRow['fcst_start_date']),
      dataDate: parseXerDate(chosenRow['data_date']),
      referenceDates,
      defaultClndrId: (chosenRow['clndr_id'] || '').trim() || null,
      criticalDrtnHours: parseXerNumber(chosenRow['critical_drtn_hr_cnt']) ?? 0,
      criticalPathType: (chosenRow['critical_path_type'] || '').trim() || null,
      sumBaseProjId: (chosenRow['sum_base_proj_id'] || '').trim() || null,
      defDurationType: (chosenRow['def_duration_type'] || '').trim() || null,
      defCompletePctType: (chosenRow['def_complete_pct_type'] || '').trim() || null,
      defTaskType: (chosenRow['def_task_type'] || '').trim() || null,
      lastRecalcDate: parseXerDate(chosenRow['last_recalc_date']),
      statusLogic,
      statusLogicSource: statusLogic
        ? `SCHEDOPTIONS.${statusLogic === 'retained_logic' ? 'sched_retained_logic' : 'sched_progress_override'}=Y`
        : null,
    };
  }

  // ---------------------------------------------------------------- calendars
  const calendars: XerCalendarSource[] = [];
  for (const row of rowsOf('CALENDAR')) {
    const calProj = (row['proj_id'] || '').trim();
    if (calProj !== '' && calProj !== projId) continue;
    const xerId = (row['clndr_id'] || '').trim();
    if (!xerId) {
      warn('calendar', '?', 'CALENDAR row without clndr_id — dropped, unreferenceable');
      continue;
    }
    const hpd = parseXerNumber(row['day_hr_cnt']);
    const hpw = parseXerNumber(row['week_hr_cnt']);
    const parsed = parseClndrData(row['clndr_data']);
    const hasBlob = Boolean((row['clndr_data'] || '').trim());
    calendars.push({
      xerId,
      name: row['clndr_name'] || `Calendar ${xerId}`,
      clndrType: (row['clndr_type'] || '').trim() || null,
      isDefault: project !== null && project.defaultClndrId === xerId,
      defaultFlag: (row['default_flag'] || '').trim() || null,
      hoursPerDay: hpd !== null && hpd > 0 ? hpd : null,
      hoursPerWeek: hpw !== null && hpw > 0 ? hpw : null,
      baseXerId: (row['base_clndr_id'] || '').trim() || null,
      workweek: parsed?.workweek || null,
      workingDaysPerWeek: parsed ? parsed.workingDays : null,
      exceptions: parsed && !parsed.exceptionsUnsupported ? parsed.exceptions : null,
      patternStatus: parsed
        ? parsed.exceptionsUnsupported ? 'exceptions_unsupported' : 'parsed'
        : hasBlob ? 'unparseable' : 'no_data',
      isGlobal: calProj === '',
    });
    const cal = calendars[calendars.length - 1];
    if (hpd !== null && hpd <= 0) warn('calendar', cal.name, `day_hr_cnt=${row['day_hr_cnt']} is not positive — hours basis unavailable`);
    if (hasBlob && !parsed) warn('calendar', cal.name, 'clndr_data present but structurally unrecognised — work pattern unsupported');
    if (parsed?.exceptionsUnsupported) {
      warn('calendar', cal.name, 'exception block carries working-time overrides — exceptions unsupported, none stored');
    }
  }
  const calById = new Map(calendars.map((c) => [c.xerId, c]));
  const defaultCal = calendars.find((c) => c.isDefault) || null;

  /** Hours/day basis for a task's own calendar, with an explicit provenance label. */
  const taskHoursBasis = (clndrXerId: string | null): { hpd: number; basis: string } => {
    const own = clndrXerId ? calById.get(clndrXerId) : undefined;
    if (own?.hoursPerDay) return { hpd: own.hoursPerDay, basis: `calendar ${own.name} (${own.hoursPerDay}h/day)` };
    if (own && !own.hoursPerDay) {
      if (defaultCal?.hoursPerDay) {
        return { hpd: defaultCal.hoursPerDay, basis: `calendar ${own.name} has no day_hr_cnt — project default ${defaultCal.name} (${defaultCal.hoursPerDay}h/day)` };
      }
      return { hpd: 8, basis: `calendar ${own.name} has no day_hr_cnt and no default available — assumed 8h/day` };
    }
    if (clndrXerId && !own) {
      if (defaultCal?.hoursPerDay) {
        return { hpd: defaultCal.hoursPerDay, basis: `calendar ${clndrXerId} not in file — project default ${defaultCal.name} (${defaultCal.hoursPerDay}h/day)` };
      }
      return { hpd: 8, basis: `calendar ${clndrXerId} not in file — assumed 8h/day` };
    }
    if (defaultCal?.hoursPerDay) return { hpd: defaultCal.hoursPerDay, basis: `no task calendar — project default ${defaultCal.name} (${defaultCal.hoursPerDay}h/day)` };
    return { hpd: 8, basis: 'no calendar hours in file — assumed 8h/day' };
  };

  // ---------------------------------------------------------------- WBS
  const wbsRows = rowsOf('PROJWBS').length > 0 ? rowsOf('PROJWBS') : rowsOf('WBSS');
  const wbs: XerWbsSource[] = [];
  wbsRows.forEach((row, idx) => {
    if (!inScope(row)) return;
    const xerId = (row['wbs_id'] || '').trim() || `wbs-row-${idx + 1}`;
    if (!row['wbs_id']) warn('wbs', xerId, 'PROJWBS row without wbs_id — kept under a generated key, links to it cannot resolve');
    const parentRaw = (row['parent_wbs_id'] || '').trim();
    wbs.push({
      xerId,
      parentXerId: parentRaw && parentRaw !== '0' ? parentRaw : null,
      code: row['wbs_short_name'] || `WBS-${xerId}`,
      name: row['wbs_name'] || row['wbs_short_name'] || `WBS-${xerId}`,
      seqNum: parseXerNumber(row['seq_num']),
      level: 1,
    });
    if (!row['wbs_short_name']) warn('wbs', xerId, 'missing wbs_short_name — code synthesised from the id for display');
  });
  // Levels by parent walk (cycle-guarded); ordering later follows seq_num then file order.
  const wbsById = new Map(wbs.map((w) => [w.xerId, w]));
  for (const node of wbs) {
    let depth = 1;
    let cursor: XerWbsSource | undefined = node;
    const seen = new Set<string>([node.xerId]);
    while (cursor?.parentXerId) {
      const parent = wbsById.get(cursor.parentXerId);
      if (!parent || seen.has(parent.xerId)) {
        if (parent) warn('wbs', node.code, 'parent chain contains a cycle — level computed up to the break');
        break;
      }
      seen.add(parent.xerId);
      depth += 1;
      cursor = parent;
    }
    node.level = depth;
  }

  // ---------------------------------------------------------------- activities
  const activities: XerActivitySource[] = [];
  const taskIdSet = new Set<string>();
  rowsOf('TASK').forEach((row, idx) => {
    if (!inScope(row)) return;
    const xerId = (row['task_id'] || '').trim() || `task-row-${idx + 1}`;
    if (!row['task_id']) warn('activity', xerId, 'TASK row without task_id — kept, but links to it cannot resolve');
    const code = row['task_code'] || `P6-${xerId}`;
    if (!row['task_code']) warn('activity', xerId, 'missing task_code — code synthesised from the id for display');
    const name = row['task_name'] || code;
    const rawType = (row['task_type'] || '').trim() || project?.defTaskType || null;
    const activityType: ActivityType = (rawType && TASK_TYPE_MAP[rawType]) || 'task_dependent';
    const taskTypeKnown = Boolean(rawType && TASK_TYPE_MAP[rawType]);
    if (rawType && !TASK_TYPE_MAP[rawType]) {
      warn('activity', code, `unknown task_type ${rawType} — treated as task_dependent`);
    }
    const clndrXerId = (row['clndr_id'] || '').trim() || null;
    const { hpd, basis: hpdBasis } = taskHoursBasis(clndrXerId);

    const targetH = parseXerNumber(row['target_drtn_hr_cnt']);
    const remainH = parseXerNumber(row['remain_drtn_hr_cnt']);
    if (targetH !== null && targetH < 0) warn('activity', code, `target_drtn_hr_cnt=${targetH} is negative — duration unavailable`);
    if (remainH !== null && remainH < 0) warn('activity', code, `remain_drtn_hr_cnt=${remainH} is negative — remaining unavailable`);
    const dur = hoursToDays(targetH !== null && targetH >= 0 ? targetH : null, hpd);
    const rem = hoursToDays(remainH !== null && remainH >= 0 ? remainH : null, hpd);

    // Percent complete: type-appropriate source first, then physical, then status semantics.
    const pctType = (row['complete_pct_type'] || '').trim() || project?.defCompletePctType || null;
    const phys = parseXerNumber(row['phys_complete_pct']);
    const actWork = parseXerNumber(row['act_work_qty']);
    const remainWork = parseXerNumber(row['remain_work_qty']);
    const statusCode = (row['status_code'] || '').trim() || null;
    let percentComplete = 0;
    let percentSource = '';
    if (pctType === 'CP_Drtn' && targetH !== null && targetH > 0 && remainH !== null && remainH >= 0) {
      percentComplete = ((targetH - remainH) / targetH) * 100;
      percentSource = 'duration % = (target_drtn - remain_drtn) / target_drtn (complete_pct_type=CP_Drtn)';
    } else if (pctType === 'CP_Units' && (actWork || 0) + (remainWork || 0) > 0 && actWork !== null && remainWork !== null) {
      percentComplete = (actWork / (actWork + remainWork)) * 100;
      percentSource = 'units % = act_work_qty / (act + remain) (complete_pct_type=CP_Units)';
    } else if (phys !== null) {
      percentComplete = phys;
      percentSource = 'phys_complete_pct';
    } else if (statusCode === 'TK_Complete') {
      percentComplete = 100;
      percentSource = 'status TK_Complete implies 100% (no % field in file)';
    } else if (statusCode === 'TK_NotStart') {
      percentComplete = 0;
      percentSource = 'status TK_NotStart implies 0% (no % field in file)';
    } else {
      percentComplete = 0;
      percentSource = 'no % evidence in file — 0 recorded, see reconciliation';
      warn('activity', code, 'no percent evidence (no phys/duration/units % and no decisive status) — 0 recorded');
    }
    if (percentComplete < 0 || percentComplete > 100) {
      warn('activity', code, `computed percent ${percentComplete.toFixed(1)} clamped to 0..100`);
      percentComplete = Math.min(100, Math.max(0, percentComplete));
    }
    percentComplete = Number(percentComplete.toFixed(2));

    // Float (kept fractional — numeric(15,2) — never clamped; negatives are real evidence).
    const tfH = parseXerNumber(row['total_float_hr_cnt']);
    const ffH = parseXerNumber(row['free_float_hr_cnt']);
    const totalFloatDays = tfH !== null ? Number((tfH / hpd).toFixed(2)) : null;
    const freeFloatDays = ffH !== null ? Number((ffH / hpd).toFixed(2)) : null;
    const threshold = project?.criticalDrtnHours ?? 0;
    const isCritical = tfH !== null && tfH <= threshold;
    const criticalBasis = tfH !== null
      ? `total_float_hr_cnt=${tfH} ${tfH <= threshold ? '<=' : '>'} critical_drtn_hr_cnt=${threshold}`
      : 'no total_float_hr_cnt in file — not marked critical';

    // Constraints: primary persisted, secondary reported (no second-constraint destination).
    const rawCstr = (row['cstr_type'] || '').trim() || null;
    const mappedCstr = rawCstr ? CONSTRAINT_MAP[rawCstr.toUpperCase()] || null : null;
    if (rawCstr && !mappedCstr) warn('activity', code, `unknown cstr_type ${rawCstr} — constraint dropped`);
    const cstrDate = parseXerDate(row['cstr_date']);
    let constraintType: ActivityConstraintType | null = mappedCstr;
    if (mappedCstr && !DATELESS_OK.has(mappedCstr) && !cstrDate) {
      warn('activity', code, `constraint ${rawCstr} has no cstr_date — dropped as meaningless`);
      constraintType = null;
    }
    if ((row['cstr_type2'] || '').trim()) {
      warn('activity', code, `secondary constraint ${row['cstr_type2']} present — no destination column, not imported`);
    }

    const isMilestone = activityType === 'start_milestone' || activityType === 'finish_milestone';
    activities.push({
      xerId,
      wbsXerId: (row['wbs_id'] || '').trim() || null,
      clndrXerId,
      code,
      name,
      taskTypeRaw: rawType,
      activityType,
      taskTypeKnown,
      statusCode,
      durationDays: dur.days,
      durationHours: targetH !== null && targetH >= 0 ? targetH : null,
      durationBasis: targetH === null
        ? 'no target_drtn_hr_cnt in file — duration unavailable'
        : `target_drtn_hr_cnt=${targetH}h / ${hpdBasis}${dur.rounded ? ` — rounded ${(
          (targetH as number) / hpd
        ).toFixed(2)} to ${dur.days}d` : ''}`,
      durationRounded: dur.rounded,
      remainingDays: rem.days,
      remainingHours: remainH !== null && remainH >= 0 ? remainH : null,
      remainingBasis: remainH === null
        ? null
        : `remain_drtn_hr_cnt=${remainH}h / ${hpdBasis}${rem.rounded ? ' (rounded)' : ''}`,
      percentComplete,
      percentSource,
      percentTypeRaw: pctType,
      durationTypeRaw: (row['duration_type'] || '').trim() || null,
      earlyStart: parseXerDate(row['early_start_date']),
      earlyFinish: parseXerDate(row['early_end_date']),
      lateStart: parseXerDate(row['late_start_date']),
      lateFinish: parseXerDate(row['late_end_date']),
      actualStart: parseXerDate(row['act_start_date']),
      actualFinish: parseXerDate(row['act_end_date']),
      expectedFinish: parseXerDate(row['expect_end_date']),
      targetStart: parseXerDate(row['target_start_date']),
      targetEnd: parseXerDate(row['target_end_date']),
      totalFloatDays,
      freeFloatDays,
      floatBasis: tfH === null && ffH === null ? null : `float hours / ${hpdBasis}`,
      isCritical,
      criticalBasis,
      isMilestone,
      milestoneKind: activityType === 'start_milestone' ? 'start' : activityType === 'finish_milestone' ? 'finish' : null,
      constraintType,
      constraintDate: constraintType ? cstrDate : null,
      constraintRaw: rawCstr,
      sortHint: idx,
    });
    taskIdSet.add(xerId);
  });

  // ---------------------------------------------------------------- links
  const links: XerLinkSource[] = [];
  for (const row of rowsOf('TASKPRED')) {
    if (!inScope(row)) continue;
    const rawType = ((row['pred_type'] || '').trim().toUpperCase().startsWith('PR_')
      ? (row['pred_type'] || '').trim().slice(3)
      : (row['pred_type'] || '').trim()
    ).toUpperCase();
    const linkType = rawType === 'SS' || rawType === 'FF' || rawType === 'SF' || rawType === 'FS' || rawType === ''
      ? ((rawType || 'FS') as 'FS' | 'SS' | 'FF' | 'SF')
      : null;
    if (!linkType) warn('link', `${row['pred_task_id']}->${row['task_id']}`, `unknown pred_type ${row['pred_type']} — dropped`);
    const predXerId = (row['pred_task_id'] || '').trim();
    const succXerId = (row['task_id'] || '').trim();
    const predProjId = (row['pred_proj_id'] || '').trim() || null;
    const crossProject = Boolean(predProjId && predProjId !== projId);
    // P6 display rule: lag hours convert on the PREDECESSOR calendar's hours/day.
    const predTaskCal = activities.find((a) => a.xerId === predXerId)?.clndrXerId || null;
    const { hpd, basis } = taskHoursBasis(predTaskCal);
    const lagH = parseXerNumber(row['lag_hr_cnt']) ?? 0;
    const lag = hoursToDays(lagH, hpd);
    links.push({
      predXerId,
      succXerId,
      predProjId,
      linkType,
      linkTypeRaw: (row['pred_type'] || '').trim() || null,
      lagDays: lag.days ?? 0,
      lagHours: lagH,
      lagBasis: `lag_hr_cnt=${lagH}h / predecessor ${basis}${lag.rounded ? ' (rounded)' : ''}`,
      lagRounded: lag.rounded,
      crossProject,
    });
  }

  // ---------------------------------------------------------------- resources + rates + units
  const umeasure = new Map<string, string>();
  for (const row of rowsOf('UMEASURE')) {
    const id = (row['unit_id'] || '').trim();
    if (id) umeasure.set(id, row['unit_abbrev'] || row['unit_name'] || '');
  }
  const ratesByRsrc = new Map<string, Array<{ date: string | null; rate: number | null; maxQty: number | null }>>();
  for (const row of rowsOf('RSRCRATE')) {
    const rsrcId = (row['rsrc_id'] || '').trim();
    if (!rsrcId) continue;
    const list = ratesByRsrc.get(rsrcId) || [];
    list.push({
      date: parseXerDate(row['start_date']),
      rate: parseXerNumber(row['cost_per_qty']),
      maxQty: parseXerNumber(row['max_qty_per_hr']),
    });
    ratesByRsrc.set(rsrcId, list);
  }
  const resources: XerResourceSource[] = [];
  for (const row of rowsOf('RSRC')) {
    const xerId = (row['rsrc_id'] || '').trim();
    if (!xerId) {
      warn('resource', '?', 'RSRC row without rsrc_id — dropped, unreferenceable');
      continue;
    }
    const rawType = (row['rsrc_type'] || '').trim().toUpperCase();
    const type = rawType.includes('EQUIP') || rawType === 'RT_EQUIP'
      ? 'equipment'
      : rawType.includes('MAT') ? 'material' : 'labor';
    if (rawType && !rawType.includes('LABOR') && !rawType.includes('EQUIP') && !rawType.includes('MAT')) {
      warn('resource', row['rsrc_short_name'] || xerId, `unknown rsrc_type ${row['rsrc_type']} — treated as labor`);
    }
    const unitId = (row['unit_id'] || '').trim();
    const explicitUnit = (row['unit_of_measure'] || '').trim();
    const unit = explicitUnit || (unitId ? umeasure.get(unitId) || null : null);
    const rates = (ratesByRsrc.get(xerId) || [])
      .filter((r) => r.rate !== null)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const best = rates[0] || null;
    resources.push({
      xerId,
      code: row['rsrc_short_name'] || `R-${xerId}`,
      name: row['rsrc_name'] || row['rsrc_short_name'] || `R-${xerId}`,
      type,
      typeRaw: (row['rsrc_type'] || '').trim() || null,
      clndrXerId: (row['clndr_id'] || '').trim() || null,
      unit: unit || null,
      unitSource: explicitUnit
        ? 'RSRC.unit_of_measure'
        : unitId && unit ? `UMEASURE[${unitId}]` : 'unavailable (UMEASURE not exported or unit_id empty)',
      rate: best?.rate ?? null,
      rateSource: best
        ? `RSRCRATE.cost_per_qty effective ${best.date || 'undated'}`
        : 'unavailable (no RSRCRATE row with a price)',
      otFactor: parseXerNumber(row['ot_factor']),
      maxUnitsPerHour: best?.maxQty ?? null,
    });
  }

  // ---------------------------------------------------------------- assignments
  const assignments: XerAssignmentSource[] = [];
  let outOfScopeAssignments = 0;
  for (const row of rowsOf('TASKRSRC')) {
    const taskXerId = (row['task_id'] || '').trim();
    if (!taskIdSet.has(taskXerId)) {
      outOfScopeAssignments += 1;
      continue;
    }
    const regQty = parseXerNumber(row['act_reg_qty']);
    const otQty = parseXerNumber(row['act_ot_qty']);
    const regCost = parseXerNumber(row['act_reg_cost']);
    const otCost = parseXerNumber(row['act_ot_cost']);
    assignments.push({
      xerId: (row['taskrsrc_id'] || '').trim() || `asg-${assignments.length + 1}`,
      taskXerId,
      rsrcXerId: (row['rsrc_id'] || '').trim(),
      plannedQty: parseXerNumber(row['target_qty']),
      actualQty: regQty === null && otQty === null ? null : (regQty || 0) + (otQty || 0),
      remainQty: parseXerNumber(row['remain_qty']),
      targetCost: parseXerNumber(row['target_cost']),
      actualCost: regCost === null && otCost === null ? null : (regCost || 0) + (otCost || 0),
      remainCost: parseXerNumber(row['remain_cost']),
      costPerQty: parseXerNumber(row['cost_per_qty']),
      qtyPerHour: parseXerNumber(row['target_qty_per_hr']) ?? parseXerNumber(row['remain_qty_per_hr']),
    });
  }

  // ---------------------------------------------------------------- expenses
  const expenses: XerExpenseSource[] = [];
  for (const row of rowsOf('PROJCOST')) {
    const taskXerId = (row['task_id'] || '').trim();
    if (!taskXerId || !taskIdSet.has(taskXerId)) continue;
    expenses.push({
      xerId: (row['cost_item_id'] || '').trim() || `exp-${expenses.length + 1}`,
      taskXerId,
      name: row['cost_name'] || row['cost_descr'] || 'Expense',
      targetCost: parseXerNumber(row['target_cost']),
      actualCost: parseXerNumber(row['act_cost']),
      remainCost: parseXerNumber(row['remain_cost']),
      targetQty: parseXerNumber(row['target_qty']),
      unitName: (row['qty_name'] || '').trim() || null,
    });
  }

  // ---------------------------------------------------------------- baseline
  let baseline: XerBaselineSource = { status: 'unavailable', baseProjId: null, baseShortName: null, tasks: [], note: null };
  const baseId = project?.sumBaseProjId || null;
  if (baseId) {
    const baseRow = projectRows.find((r) => (r['proj_id'] || '').trim() === baseId) || null;
    const baseTasks = rowsOf('TASK').filter((r) => (r['proj_id'] || '').trim() === baseId);
    const baseCosts = new Map<string, number>();
    for (const row of rowsOf('TASKRSRC')) {
      if ((row['proj_id'] || '').trim() !== baseId) continue;
      const tid = (row['task_id'] || '').trim();
      const cost = parseXerNumber(row['target_cost']);
      if (tid && cost !== null) baseCosts.set(tid, (baseCosts.get(tid) || 0) + cost);
    }
    if (baseTasks.length > 0) {
      baseline = {
        status: 'available',
        baseProjId: baseId,
        baseShortName: baseRow?.['proj_short_name'] || baseId,
        tasks: baseTasks.map((row) => {
          const tid = (row['task_id'] || '').trim();
          const cal = row['clndr_id'] ? calById.get((row['clndr_id'] || '').trim()) : undefined;
          const hpd = cal?.hoursPerDay || defaultCal?.hoursPerDay || 8;
          const targetH = parseXerNumber(row['target_drtn_hr_cnt']);
          return {
            code: row['task_code'] || `P6-${tid}`,
            earlyStart: parseXerDate(row['early_start_date']),
            earlyFinish: parseXerDate(row['early_end_date']),
            targetStart: parseXerDate(row['target_start_date']),
            targetEnd: parseXerDate(row['target_end_date']),
            durationDays: targetH !== null && targetH >= 0 ? Math.round(targetH / hpd) : null,
            plannedCost: baseCosts.get(tid) ?? null,
          };
        }),
        note: `baseline project ${baseRow?.['proj_short_name'] || baseId} with ${baseTasks.length} activit(y/ies) found in file`,
      };
    } else {
      baseline = {
        status: 'referenced_but_missing',
        baseProjId: baseId,
        baseShortName: baseRow?.['proj_short_name'] || null,
        tasks: [],
        note: 'sum_base_proj_id is set but no TASK rows for that project are in the file — no baseline imported',
      };
    }
  }

  const sourceCounts: Record<string, number> = {
    projects: projectRows.length,
    wbs: wbsRows.filter((r) => inScope(r)).length,
    calendars: calendars.length,
    calendarRowsSkipped: rowsOf('CALENDAR').length - calendars.length,
    tasks: activities.length,
    taskRowsSkipped: rowsOf('TASK').length - activities.length,
    preds: links.length,
    predRowsSkipped: rowsOf('TASKPRED').length - links.length,
    resources: resources.length,
    rates: rowsOf('RSRCRATE').length,
    assignments: assignments.length,
    outOfScopeAssignments,
    expenses: expenses.length,
    umeasure: rowsOf('UMEASURE').length,
  };

  return {
    header,
    project,
    skippedProjects,
    wbs,
    calendars,
    activities,
    links,
    resources,
    assignments,
    outOfScopeAssignments,
    expenses,
    baseline,
    sourceCounts,
    warnings,
    unsupportedFields,
  };
}

import * as XLSX from 'xlsx';

export interface ImportedScheduleActivity {
  code: string;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  duration_days: number;
  percent_complete: number;
  actual_start: string | null;
  actual_finish: string | null;
  is_milestone: boolean;
  predecessor_codes: string[];
}

export function validateImportedSchedule(activities: ImportedScheduleActivity[]): string[] {
  const errors: string[] = [];
  const codes = new Set<string>();
  const graph = new Map<string, string[]>();
  activities.forEach((activity) => {
    if (codes.has(activity.code)) errors.push(`كود النشاط مكرر: ${activity.code}`);
    codes.add(activity.code);
    graph.set(activity.code, []);
    if (!activity.name) errors.push(`النشاط ${activity.code} بلا اسم`);
    if (activity.early_start && activity.early_finish && activity.early_finish < activity.early_start) {
      errors.push(`تواريخ النشاط غير منطقية: ${activity.code}`);
    }
    if (activity.duration_days < 0 || activity.percent_complete < 0 || activity.percent_complete > 100) {
      errors.push(`قيم المدة أو الإنجاز غير صالحة: ${activity.code}`);
    }
  });
  activities.forEach((activity) => {
    activity.predecessor_codes.forEach((predecessor) => {
      if (predecessor === activity.code) errors.push(`النشاط لا يمكن أن يكون سابقاً لنفسه: ${activity.code}`);
      if (!codes.has(predecessor)) errors.push(`النشاط ${activity.code} يشير إلى سابق غير موجود: ${predecessor}`);
      else graph.set(predecessor, [...(graph.get(predecessor) || []), activity.code]);
    });
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(code: string): void {
    if (visiting.has(code)) {
      errors.push(`علاقة دائرية في الجدول تبدأ من: ${code}`);
      return;
    }
    if (visited.has(code)) return;
    visiting.add(code);
    (graph.get(code) || []).forEach(visit);
    visiting.delete(code);
    visited.add(code);
  }
  codes.forEach(visit);
  return [...new Set(errors)];
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_.-]+/g, '');
}

function dateValue(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'number' && value > 0) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    excelEpoch.setUTCDate(excelEpoch.getUTCDate() + value);
    return excelEpoch.toISOString().split('T')[0];
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationDays(value: string): number {
  if (!value) return 0;
  const iso = value.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/i);
  if (iso) return Math.max(0, Math.round((Number(iso[1] || 0) + Number(iso[2] || 0) / 60) / 8));
  return numberValue(value);
}

function column(row: Record<string, unknown>, names: string[]): unknown {
  const match = Object.entries(row).find(([key]) => names.includes(normalize(key)));
  return match?.[1];
}

function toActivity(row: Record<string, unknown>, index: number): ImportedScheduleActivity | null {
  const code = String(column(row, ['code', 'activityid', 'taskid', 'wbs', 'uid']) ?? `ACT-${index + 1}`).trim();
  const name = String(column(row, ['name', 'activityname', 'taskname', 'description', 'task']) ?? '').trim();
  if (!name) return null;
  const start = dateValue(column(row, ['earlystart', 'start', 'plannedstart', 'startdate']));
  const finish = dateValue(column(row, ['earlyfinish', 'finish', 'plannedfinish', 'finishdate']));
  const duration = numberValue(column(row, ['duration', 'durationdays', 'durationday']));
  const percent = Math.min(100, Math.max(0, numberValue(column(row, ['percentcomplete', 'complete', 'progress']))));
  return {
    code,
    name,
    early_start: start,
    early_finish: finish,
    duration_days: duration || (start && finish ? Math.max(0, Math.round((new Date(finish).getTime() - new Date(start).getTime()) / 86400000)) : 0),
    percent_complete: percent,
    actual_start: dateValue(column(row, ['actualstart'])),
    actual_finish: dateValue(column(row, ['actualfinish'])),
    is_milestone: String(column(row, ['milestone', 'ismilestone']) ?? '').toLowerCase() === 'yes' || duration === 0,
    predecessor_codes: String(column(row, ['predecessors', 'predecessor', 'predecessorcode']) ?? '')
      .split(/[;,|]/).map((item) => item.trim()).filter(Boolean),
  };
}

function parseSpreadsheet(buffer: ArrayBuffer): ImportedScheduleActivity[] {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
    .map(toActivity)
    .filter((activity): activity is ImportedScheduleActivity => activity !== null);
}

function localName(element: Element): string {
  return element.localName || element.tagName.split(':').pop() || element.tagName;
}

function childValue(element: Element, name: string): string {
  const child = Array.from(element.children).find((item) => localName(item) === name);
  return child?.textContent?.trim() || '';
}

function parseMsProjectXml(text: string): ImportedScheduleActivity[] {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('ملف Microsoft Project XML غير صالح');
  const tasks = Array.from(document.getElementsByTagName('*')).filter((element) => localName(element) === 'Task');
  const codeByUid = new Map<string, string>();
  const rows = tasks.map((task, index) => {
    const uid = childValue(task, 'UID') || String(index + 1);
    const code = childValue(task, 'WBS') || `MSP-${childValue(task, 'ID') || index + 1}`;
    codeByUid.set(uid, code);
    return { task, uid, code };
  });
  return rows.map(({ task, code }) => {
    const activity = toActivity({
      Code: code,
      Name: childValue(task, 'Name'),
      Start: childValue(task, 'Start'),
      Finish: childValue(task, 'Finish'),
      Duration: durationDays(childValue(task, 'Duration')),
      PercentComplete: childValue(task, 'PercentComplete'),
      ActualStart: childValue(task, 'ActualStart'),
      ActualFinish: childValue(task, 'ActualFinish'),
      Milestone: childValue(task, 'Milestone') === '1' ? 'yes' : '',
    }, Number(childValue(task, 'ID') || 0));
    if (!activity) return null;
    activity.predecessor_codes = Array.from(task.children)
      .filter((element) => localName(element) === 'PredecessorLink')
      .map((link) => codeByUid.get(childValue(link, 'PredecessorUID')) || '')
      .filter(Boolean);
    return activity;
  }).filter((activity): activity is ImportedScheduleActivity => activity !== null);
}

function parseXer(text: string): ImportedScheduleActivity[] {
  const lines = text.split(/\r?\n/);
  const tables = new Map<string, { fields: string[]; rows: string[][] }>();
  let current: { name: string; fields: string[]; rows: string[][] } | null = null;
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts[0] === '%T') {
      current = { name: parts[1], fields: [], rows: [] };
      tables.set(parts[1], current);
    } else if (current && parts[0] === '%F') {
      current.fields = parts.slice(1);
    } else if (current && parts[0] === '%R') {
      current.rows.push(parts.slice(1));
    }
  }
  const task = tables.get('TASK');
  if (!task?.fields.length) throw new Error('لم يتم العثور على جدول TASK في ملف XER');
  const tasks = task.rows.map((values) => Object.fromEntries(task.fields.map((field, index) => [field, values[index] || ''])));
  const byId = new Map(tasks.map((row) => [row.task_id, String(row.task_code || row.task_id)]));
  const predecessors = new Map<string, string[]>();
  const links = tables.get('TASKPRED');
  links?.rows.forEach((values) => {
    const row = Object.fromEntries(links.fields.map((field, index) => [field, values[index] || '']));
    const list = predecessors.get(row.succ_task_id) || [];
    const code = byId.get(row.pred_task_id);
    if (code) list.push(code);
    predecessors.set(row.succ_task_id, list);
  });
  return tasks.map((row, index) => {
    const activity = toActivity({
      Code: row.task_code,
      Name: row.task_name,
      EarlyStart: row.early_start_date,
      EarlyFinish: row.early_end_date,
      Duration: numberValue(row.target_drtn_hr_cnt) / 8,
      PercentComplete: row.complete_pct,
      Milestone: row.milestone_flag === 'Y' ? 'yes' : '',
    }, index);
    if (activity) activity.predecessor_codes = predecessors.get(row.task_id) || [];
    return activity;
  }).filter((activity): activity is ImportedScheduleActivity => activity !== null);
}

export async function parseScheduleFile(file: File): Promise<ImportedScheduleActivity[]> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'xml') return parseMsProjectXml(await file.text());
  if (extension === 'xer') return parseXer(await file.text());
  if (extension === 'xlsx' || extension === 'xls' || extension === 'csv' || extension === 'txt') {
    return parseSpreadsheet(await file.arrayBuffer());
  }
  throw new Error('الصيغة غير مدعومة. استخدم Excel أو CSV أو XER أو Microsoft Project XML');
}

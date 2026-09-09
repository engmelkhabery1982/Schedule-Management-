import type { Activity, ActivityLink, WbsNode, Resource, ActivityResource } from '@/types';

export interface ParsedXerResult {
  projectName: string;
  startDate: string | null;
  endDate: string | null;
  wbsNodes: Array<{
    xerId: string;
    parentXerId: string | null;
    code: string;
    name: string;
    level: number;
  }>;
  activities: Array<{
    xerId: string;
    wbsXerId: string | null;
    code: string;
    name: string;
    early_start: string | null;
    early_finish: string | null;
    late_start: string | null;
    late_finish: string | null;
    duration_days: number;
    percent_complete: number;
    is_critical: boolean;
    is_milestone: boolean;
    total_float?: number;
    free_float?: number;
  }>;
  links: Array<{
    predXerId: string;
    succXerId: string;
    linkType: 'FS' | 'SS' | 'FF' | 'SF';
    lagDays: number;
  }>;
  resources: Array<{
    xerId: string;
    name: string;
    type: 'labor' | 'equipment' | 'material';
    unit: string;
    unit_rate: number;
  }>;
}

function parseXerDate(raw?: string): string | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = raw.trim();
  // Standard XER date: 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD' or 'DD-MMM-YY'
  if (cleaned.includes('-')) {
    const parts = cleaned.split(' ')[0];
    if (parts.length === 10) return parts;
  }
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }
  return null;
}

export function parseXerContent(xerText: string): ParsedXerResult {
  const lines = xerText.split(/\r?\n/);

  let currentTable = '';
  let currentFields: string[] = [];
  const tables: Record<string, Array<Record<string, string>>> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('%T')) {
      const parts = line.split('\t');
      currentTable = (parts[1] || '').trim();
      currentFields = [];
      if (!tables[currentTable]) {
        tables[currentTable] = [];
      }
      continue;
    }

    if (line.startsWith('%F')) {
      const parts = line.split('\t').slice(1);
      currentFields = parts.map((f) => f.trim().toLowerCase());
      continue;
    }

    if (line.startsWith('%R') || (!line.startsWith('%') && currentTable && currentFields.length > 0)) {
      const dataStr = line.startsWith('%R') ? line.substring(2) : line;
      // Tab separated tokens
      const values = dataStr.split('\t');
      // If first token is empty due to leading tab, trim or adjust
      const tokens = values[0] === '' ? values.slice(1) : values;

      const row: Record<string, string> = {};
      currentFields.forEach((field, fIdx) => {
        row[field] = (tokens[fIdx] || '').trim();
      });

      if (currentTable) {
        tables[currentTable].push(row);
      }
    }
  }

  // 1. Extract Project Info
  const projectRows = tables['PROJECT'] || [];
  const projRow = projectRows[0] || {};
  const projectName = projRow['proj_short_name'] || projRow['proj_name'] || 'مشروع Primavera P6 المستورد';
  const startDate = parseXerDate(projRow['plan_start_date'] || projRow['proj_start_date']);
  const endDate = parseXerDate(projRow['plan_end_date'] || projRow['proj_end_date']);

  // 2. Extract WBS
  const wbsRows = tables['WBSS'] || tables['PROJWBS'] || [];
  const wbsNodes = wbsRows.map((row, idx) => {
    return {
      xerId: row['wbs_id'] || String(idx + 1),
      parentXerId: row['parent_wbs_id'] && row['parent_wbs_id'] !== '0' ? row['parent_wbs_id'] : null,
      code: row['wbs_short_name'] || row['wbs_code'] || `WBS-${idx + 1}`,
      name: row['wbs_name'] || `مرحلة ${idx + 1}`,
      level: row['parent_wbs_id'] ? 2 : 1,
    };
  });

  // 3. Extract Activities (TASK)
  const taskRows = tables['TASK'] || [];
  const activities = taskRows.map((row, idx) => {
    const durationHours = parseFloat(row['target_drtn_hr_cnt'] || row['remain_drtn_hr_cnt'] || '64') || 64;
    const durationDays = Math.max(0, Math.round(durationHours / 8));
    const isMile = row['task_type']?.includes('Mile') || row['milestone_flag'] === 'Y' || durationDays === 0;
    const pct = parseFloat(row['phys_complete_pct'] || row['complete_pct'] || '0') || 0;
    const tfHours = parseFloat(row['total_float_hr_cnt'] || '0') || 0;
    const ffHours = parseFloat(row['free_float_hr_cnt'] || '0') || 0;

    return {
      xerId: row['task_id'] || String(idx + 1),
      wbsXerId: row['wbs_id'] || null,
      code: row['task_code'] || `A${String(idx + 10).padStart(4, '0')}`,
      name: row['task_name'] || `نشاط ${idx + 1}`,
      early_start: parseXerDate(row['early_start_date'] || row['target_start_date'] || row['act_start_date']),
      early_finish: parseXerDate(row['early_end_date'] || row['target_end_date'] || row['act_end_date']),
      late_start: parseXerDate(row['late_start_date']),
      late_finish: parseXerDate(row['late_end_date']),
      duration_days: durationDays,
      percent_complete: Math.min(100, Math.max(0, pct)),
      is_critical: row['critical_flag'] === 'Y' || tfHours <= 0,
      is_milestone: isMile,
      total_float: Math.round(tfHours / 8),
      free_float: Math.round(ffHours / 8),
    };
  });

  // 4. Extract Relationships (TASKPRED)
  const predRows = tables['TASKPRED'] || [];
  const links = predRows.map((row) => {
    let rawType = (row['pred_type'] || 'FS').toUpperCase();
    if (rawType.startsWith('PR_')) rawType = rawType.substring(3);
    const linkType: 'FS' | 'SS' | 'FF' | 'SF' =
      rawType === 'SS' ? 'SS' : rawType === 'FF' ? 'FF' : rawType === 'SF' ? 'SF' : 'FS';
    const lagHours = parseFloat(row['lag_hr_cnt'] || '0') || 0;

    return {
      predXerId: row['pred_task_id'],
      succXerId: row['succ_task_id'],
      linkType,
      lagDays: Math.round(lagHours / 8),
    };
  });

  // 5. Extract Resources (RSRC)
  const rsrcRows = tables['RSRC'] || [];
  const resources = rsrcRows.map((row, idx) => {
    const rawType = (row['rsrc_type'] || '').toUpperCase();
    const type: 'labor' | 'equipment' | 'material' = rawType.includes('EQUIP') || rawType.includes('EQ')
      ? 'equipment'
      : rawType.includes('MAT') || rawType.includes('MT')
      ? 'material'
      : 'labor';

    return {
      xerId: row['rsrc_id'] || String(idx + 1),
      name: row['rsrc_name'] || row['rsrc_short_name'] || `مورد ${idx + 1}`,
      type,
      unit: row['unit_of_measure'] || 'يوم',
      unit_rate: 100,
    };
  });

  return {
    projectName,
    startDate,
    endDate,
    wbsNodes,
    activities,
    links,
    resources,
  };
}

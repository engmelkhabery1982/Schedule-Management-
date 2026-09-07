import type { Activity, ActivityLink, WbsNode, Resource, ActivityResource } from '@/types';

// XER is a tab-separated text file with a specific Primavera format.
// This generates a simplified but valid XER structure that Primavera P6 can import.

interface XerExportData {
  project: { id: string; name: string; start_date: string; end_date: string };
  wbsNodes: WbsNode[];
  activities: Activity[];
  links: ActivityLink[];
  resources: Resource[];
  activityResources: ActivityResource[];
}

function xerDate(dateStr: string | null): string {
  if (!dateStr) return '';
  // XER format: YYYY-MM-DD HH:MM:SS
  return `${dateStr} 08:00:00`;
}

export function generateXer(data: XerExportData): string {
  const lines: string[] = [];

  // XER header
  lines.push('ERMHDR');
  lines.push('');

  // PROJECT table
  lines.push('%T\tPROJECT');
  lines.push('%F\tproj_id\tproj_name\tproj_start_date\tproj_end_date');
  lines.push('%R');
  lines.push(`\t${data.project.name}\t${xerDate(data.project.start_date)}\t${xerDate(data.project.end_date)}`);
  lines.push('');

  // WBS table
  lines.push('%T\tWBSS');
  lines.push('%F\twbs_id\tproj_id\tparent_wbs_id\twbs_code\twbs_name');
  lines.push('%R');
  const wbsIdMap: Record<string, number> = {};
  let wbsIdCounter = 1;
  for (const wbs of data.wbsNodes) {
    wbsIdMap[wbs.id] = wbsIdCounter;
    const parentId = wbs.parent_id ? (wbsIdMap[wbs.parent_id] || '') : '';
    lines.push(`${wbsIdCounter}\t1\t${parentId}\t${wbs.code}\t${wbs.name}`);
    wbsIdCounter++;
  }
  lines.push('');

  // TASK table (activities)
  lines.push('%T\tTASK');
  lines.push('%F\ttask_id\tproj_id\twbs_id\ttask_code\ttask_name\tearly_start_date\tearly_end_date\ttarget_drtn_hr_cnt\tact_work_qty\tcomplete_pct\tcritical_flag\tmilestone_flag');
  lines.push('%R');
  const taskIdMap: Record<string, number> = {};
  let taskIdCounter = 1;
  for (const act of data.activities) {
    taskIdMap[act.id] = taskIdCounter;
    const wbsId = act.wbs_node_id ? (wbsIdMap[act.wbs_node_id] || 1) : 1;
    const durationHours = act.duration_days * 8;
    lines.push(
      `${taskIdCounter}\t1\t${wbsId}\t${act.code}\t${act.name}\t${xerDate(act.early_start)}\t${xerDate(act.early_finish)}\t${durationHours}\t0\t${act.percent_complete}\t${act.is_critical ? 'Y' : 'N'}\t${act.is_milestone ? 'Y' : 'N'}`
    );
    taskIdCounter++;
  }
  lines.push('');

  // TASKPRED table (relationships/links)
  lines.push('%T\tTASKPRED');
  lines.push('%F\ttask_pred_id\tproj_id\tpred_task_id\tsucc_task_id\tpred_type\tlag_hr_cnt');
  lines.push('%R');
  let linkIdCounter = 1;
  for (const link of data.links) {
    const predId = taskIdMap[link.predecessor_id] || 1;
    const succId = taskIdMap[link.successor_id] || 1;
    const predType = link.link_type === 'FS' ? 'FS' : link.link_type === 'SS' ? 'SS' : link.link_type === 'FF' ? 'FF' : 'SF';
    const lagHours = link.lag_days * 8;
    lines.push(`${linkIdCounter}\t1\t${predId}\t${succId}\t${predType}\t${lagHours}`);
    linkIdCounter++;
  }
  lines.push('');

  // RESOURCES table
  lines.push('%T\tRSRC');
  lines.push('%F\trsrc_id\trsrc_name\trsrc_type\trsrc_short_name\tunit_of_measure');
  lines.push('%R');
  const rsrcIdMap: Record<string, number> = {};
  let rsrcIdCounter = 1;
  for (const res of data.resources) {
    rsrcIdMap[res.id] = rsrcIdCounter;
    const shortName = res.name.substring(0, 12).toUpperCase();
    lines.push(`${rsrcIdCounter}\t${res.name}\t${res.type === 'labor' ? 'LT_Labor' : res.type === 'equipment' ? 'EQ_Equip' : 'MT_Material'}\t${shortName}\t${res.unit}`);
    rsrcIdCounter++;
  }
  lines.push('');

  // TASKRSRC table (resource assignments)
  lines.push('%T\tTASKRSRC');
  lines.push('%F\ttask_rsrc_id\tproj_id\ttask_id\trsrc_id\ttarget_qty\tact_qty\tcost_per_qty');
  lines.push('%R');
  let trIdCounter = 1;
  for (const ar of data.activityResources) {
    const taskId = taskIdMap[ar.activity_id] || 1;
    const rsrcId = rsrcIdMap[ar.resource_id] || 1;
    const rate = ar.resource?.unit_rate || 0;
    lines.push(`${trIdCounter}\t1\t${taskId}\t${rsrcId}\t${ar.planned_quantity}\t${ar.actual_quantity}\t${rate}`);
    trIdCounter++;
  }
  lines.push('');

  return lines.join('\n');
}

export function downloadXer(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/tab-separated-values;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function activitiesToCsv(activities: Activity[]): string {
  const headers = ['Code', 'Name', 'WBS', 'Early Start', 'Early Finish', 'Duration (days)', '% Complete', 'Critical', 'Milestone', 'Actual Start', 'Actual Finish'];
  const rows = activities.map(a => [
    a.code,
    `"${a.name.replace(/"/g, '""')}"`,
    a.wbs_node?.code || '',
    a.early_start || '',
    a.early_finish || '',
    a.duration_days,
    a.percent_complete,
    a.is_critical ? 'Yes' : 'No',
    a.is_milestone ? 'Yes' : 'No',
    a.actual_start || '',
    a.actual_finish || '',
  ].join(','));
  return [headers.join(','), ...rows].join('\n');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function activitiesToMsProjectXml(activities: Activity[], projectName: string): string {
  const tasks = activities.map((activity, index) => `
    <Task>
      <UID>${index + 1}</UID>
      <ID>${index + 1}</ID>
      <Name>${xmlEscape(activity.name)}</Name>
      <WBS>${xmlEscape(activity.code)}</WBS>
      <Start>${activity.early_start || ''}T08:00:00</Start>
      <Finish>${activity.early_finish || ''}T17:00:00</Finish>
      <Duration>PT${Math.max(0, activity.duration_days) * 8}H0M0S</Duration>
      <PercentComplete>${Math.round(activity.percent_complete || 0)}</PercentComplete>
      <Milestone>${activity.is_milestone ? 1 : 0}</Milestone>
    </Task>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>${xmlEscape(projectName)}</Name>
  <Tasks>${tasks}
  </Tasks>
</Project>`;
}

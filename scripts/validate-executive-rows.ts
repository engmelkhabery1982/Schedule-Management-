import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import { executiveScheduleRows } from '../src/lib/executiveScheduleRows';
import { analyzeScheduleControl, type ScheduleControlInput } from '../src/lib/scheduleControlEngine';
import type { Activity, ProgressUpdate } from '../src/types';
const activity: Activity = {
  id:'a', project_id:'qa', wbs_node_id:null, code:'A', name:'Synthetic activity',
  early_start:'2026-09-01', early_finish:'2026-09-02', late_start:null, late_finish:null,
  actual_start:null, actual_finish:null, duration_days:2, planned_quantity:10,
  actual_quantity:0, unit:'m3', percent_complete:0, is_critical:false, is_milestone:false,
  sort_order:0, created_at:'2026-09-01T00:00:00Z',
};
const update=(date:string,pct:number,status='approved') => ({id:date, project_id:'qa', activity_id:'a', update_date:date,
  percent_complete:pct, actual_quantity:0, quantity_to_date:0, status,
  approved_at:date+'T08:00:00Z', created_at:date+'T08:00:00Z', notes:null, rejected_reason:null}) as ProgressUpdate;
let checks=0;
for(const [name,changes,updates] of [
  ['unstarted',{},[]],
  ['in progress',{actual_start:'2026-09-09',percent_complete:20},[update('2026-09-09',20)]],
  ['finished',{actual_start:'2026-09-09',actual_finish:'2026-09-10',percent_complete:100},[update('2026-09-10',100)]],
  ['future update is not current progress',{percent_complete:100},[update('2026-09-14',100)]],
  ['unapproved update is not current progress',{percent_complete:100},[update('2026-09-10',100,'submitted')]],
] as const){
  const input:ScheduleControlInput={activities:[{...activity,...changes}],links:[],baselines:[],progressUpdates:[...updates],dataDate:'2026-09-13',calendarType:'6_days',statusLogic:'retained_logic'};
  const bytes=JSON.stringify(input),result=executiveScheduleRows(input),f5=analyzeScheduleControl(input),row=result.rows[0],source=f5.statused[0];
  assert.equal(row.early_start,source.actualStart||source.earlyStart,name);
  assert.equal(row.early_finish,source.actualFinish||source.earlyFinish,name);
  assert.equal(row.percent_complete,source.percentComplete,name);
  assert.equal(row.total_float,source.totalFloat,name);
  assert.equal(row.is_critical,source.critical,name);
  assert.equal(row.completed,source.completed,name);
  assert.equal(result.forecastFinish,f5.project.forecastFinish,name);
  assert.equal(JSON.stringify(input),bytes,'read-only projection');checks+=8;
  if(name==='unstarted')assert.notEqual(row.early_finish,activity.early_finish,'stale saved finish must not masquerade as current');
  if(name==='future update is not current progress'||name==='unapproved update is not current progress')assert.equal(row.percent_complete,0,name);
}
assert.deepEqual(executiveScheduleRows({activities:[],links:[],baselines:[],dataDate:'2026-09-13'}),{rows:[],forecastFinish:null});
const view=readFileSync('src/components/views/ExecutiveReportView.tsx','utf8');
assert(view.includes("act.activity_drag ?? 'N/A'"),'A recorded zero drag must remain zero; absence is not the duration');
assert(view.includes('كبح المسار المحفوظ (Drag)'),'Stored drag must not be presented as a fresh CPM calculation');
const baseline='5cdf8bf7d46383c7702d6b6b409bbc558e97e7e9';
const allowed=new Set(['src/components/views/ExecutiveReportView.tsx','src/lib/executiveScheduleRows.ts','scripts/validate-executive-rows.ts','docs/EXECUTIVE_CURRENT_ROWS_ACCEPTANCE_2026-11-06.md']);
const changed=[...new Set([
  ...execFileSync('git',['diff','--name-only',baseline],{encoding:'utf8'}).trim().split(/\r?\n/),
  ...execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/),
].filter(Boolean))];
assert(changed.every(file=>allowed.has(file)),`Current increment escaped its four-path scope: ${changed}`);
execFileSync('git',['diff','--exit-code',baseline,'--','src/lib/cpmEngine.ts','src/lib/calendarEngine.ts','src/lib/scheduleControlEngine.ts','src/lib/costControlEngine.ts','src/lib/governedProgress.ts','src/lib/forecastReconciliation.ts']);
console.log(`Executive current-row contracts: ${checks+6} assertions passed; no scheduling formula changed.`);
console.log('Current four-path diff guard and protected engine equality: PASS');

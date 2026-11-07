import './node-loader.mjs';
import assert from 'node:assert/strict';
import { fixture, read, memoryStorage, STAMP, DATE, saveVo, transitionVo } from './fixture.mjs';
import { buildBackup, serializeBackup, validateBackup, restoreWorkspace, readAuxiliaryStores, canonicalJson, commitWorkspace, PERSISTED_TABLE_NAMES } from '../../src/lib/localWorkspace.ts';
import { MockQueryBuilder } from '../../src/lib/localQueryBuilder.ts';
import { analyzeScheduleControl, buildUpdateSnapshot } from '../../src/lib/scheduleControlEngine.ts';
import { analyzeCostControl, buildCostSnapshot } from '../../src/lib/costControlEngine.ts';
import { analyzeIntegratedDecisions } from '../../src/lib/integratedDecisionEngine.ts';
import { analyzeForecastTrust } from '../../src/lib/forecastTrustEngine.ts';
import { executiveScheduleRows } from '../../src/lib/executiveScheduleRows.ts';
import { quoteCanonicalEvm } from '../../src/lib/canonicalEvm.ts';
import { buildVoImpactEvidence, calculateScopeSummary } from '../../src/lib/scopeChangeEngine.ts';
let checks = 0;
const eq = (a,b) => { assert.deepEqual(a,b); checks++; };
const storage = fixture(['alpha']);
function reports(state) {
 const project = state.projects[0];
 const input = { project, activities:state.activities, links:state.activity_links, baselines:state.baseline_activities, progressUpdates:state.progress_updates, dataDate:DATE, calendarType:'7_days' };
 const f5 = analyzeScheduleControl(input);
 const f6 = analyzeCostControl({ ...input, budgetLines:state.budget_lines, costTransactions:state.cost_transactions, wbsNodes:state.wbs_nodes, boqItems:state.boq_items, allocations:state.activity_boq_allocations, scheduleReport:f5 });
 const f7 = analyzeIntegratedDecisions({ ...input, scheduleReport:f5, costReport:f6 });
 const f8 = analyzeForecastTrust({ ...input, scheduleReport:f5, costReport:f6, decisionReport:f7, costTransactions:state.cost_transactions, boqItems:state.boq_items, allocations:state.activity_boq_allocations, scheduleSnapshots:state.schedule_update_snapshots, costSnapshots:state.cost_control_snapshots });
 const executive = executiveScheduleRows(input);
 eq(f7.totals.ac,f6.project.ac); eq(f7.totals.ev,f6.project.ev); eq(f7.totals.eac,f6.project.eac);
 eq(f8.trust.eac,f6.project.eac); eq(f8.trust.forecastFinish,f5.project.forecastFinish); eq(executive.forecastFinish,f5.project.forecastFinish);
 eq(quoteCanonicalEvm(f6).ac,100); eq(f6.project.bac,1000); eq(f6.project.ev,200);
 return { f5,f6,f7,f8,executive };
}
const before = reports(read(storage));
const preSnapshotBackup = buildBackup(read(storage),STAMP);
const port = {
 read: () => ({ state:read(storage), error:null }),
 commit: mutate => { const r=commitWorkspace(storage,mutate); return r.ok ? {data:r.data,error:null} : {data:null,error:r.error}; },
};
// EXACT builders, table names and upsert conflict key used by ScheduleView/BudgetView save handlers.
for (const [table,payload] of [
 ['schedule_update_snapshots',buildUpdateSnapshot('alpha',before.f5,read(storage).activities,read(storage).activity_links)],
 ['cost_control_snapshots',buildCostSnapshot('alpha',before.f6)],
]) {
 const r = await new MockQueryBuilder(table,port).upsert(payload,{onConflict:'project_id,data_date'}); eq(r.error,null);
 const repeated = await new MockQueryBuilder(table,port).upsert(payload,{onConflict:'project_id,data_date'}); eq(repeated.error,null);
 eq(read(storage)[table].length,1);
}
const rejected = saveVo(storage,'alpha','VO-REJECTED','missing'); transitionVo(storage,rejected,'submitted'); transitionVo(storage,rejected,'rejected');
const withdrawn = saveVo(storage,'alpha','VO-WITHDRAWN','alpha-claim free text'); transitionVo(storage,withdrawn,'withdrawn');
const state = read(storage);
eq(state.cost_transactions[0].approval_level,2); eq(state.approval_events.length,2);
const summary = calculateScopeSummary(state.baseline_boq_items,state.variation_orders,state.variation_order_boq_impacts);
eq(summary,{originalContractValue:1000,approvedChangesValue:200,revisedApprovedScopeValue:1200,pendingExposureValue:200});
for (const order of state.variation_orders) {
 const e=buildVoImpactEvidence({projectId:'alpha',order,impacts:state.variation_order_boq_impacts,activityLinks:state.variation_order_activity_links,wbsLinks:state.variation_order_wbs_links,transactions:state.cost_transactions,claims:state.delay_claims});
 eq(e.measuredScheduleDays,null); eq(e.approvedScheduleDays,null); eq(e.scheduleAggregation,'unavailable-potential-overlap');
}
storage.setItem('schedule_diff_revisions_alpha',JSON.stringify([{id:'qa-cutoff',dataDate:DATE,activitiesSnapshot:state.activities}]));
const backup = buildBackup(state,STAMP,readAuxiliaryStores(storage));
// Complete means approval audit rows as well as the final transaction status; no silent omission.
eq(backup.tables.approval_events,state.approval_events);
const validated = validateBackup(serializeBackup(backup)); assert.ok(validated.ok,JSON.stringify(validated.errors)); checks++;
const reopened = memoryStorage(); const restored=restoreWorkspace(reopened,validated); assert.ok(restored.ok,restored.error); checks++;
const afterBackup=buildBackup(read(reopened),STAMP,readAuxiliaryStores(reopened));
eq(canonicalJson(afterBackup.tables),canonicalJson(backup.tables)); eq(afterBackup.auxiliary,backup.auxiliary); eq(afterBackup.checksum,backup.checksum);
eq(read(reopened).variation_order_events,state.variation_order_events); eq(read(reopened).approval_events,state.approval_events);
eq(reports(read(reopened)),reports(state));
const legacy=structuredClone(backup); delete legacy.tables.approval_events; delete legacy.counts.approval_events;
const {backupChecksum}=await import('../../src/lib/localWorkspace.ts'); legacy.checksum=backupChecksum(legacy.tables,legacy.auxiliary);
const old=validateBackup(legacy); assert.ok(old.ok,JSON.stringify(old.errors)); checks++; eq(old.state.approval_events,[]);
const foreignAudit=structuredClone(backup);
foreignAudit.tables.approval_events[0].entity_id='missing-transaction';
foreignAudit.checksum=backupChecksum(foreignAudit.tables,foreignAudit.auxiliary);
eq(validateBackup(foreignAudit).ok,false);
const unknownEvidence=structuredClone(backup);
unknownEvidence.tables.variation_orders[0].future_review_evidence={ reference:'QA-UNKNOWN', value:0 };
unknownEvidence.checksum=backupChecksum(unknownEvidence.tables,unknownEvidence.auxiliary);
const unknownValidation=validateBackup(unknownEvidence); assert.ok(unknownValidation.ok); checks++;
eq(unknownValidation.state.variation_orders[0].future_review_evidence,{reference:'QA-UNKNOWN',value:0});
const legacy32=structuredClone(legacy); delete legacy32.tables.payment_certificates; delete legacy32.tables.subcontractor_payment_certificates;
legacy32.checksum=backupChecksum(legacy32.tables,legacy32.auxiliary);assert.ok(validateBackup(legacy32).ok);checks++;
if(process.env.SCH_QA_ARTIFACT_DIR) {
 const {resolve,relative,isAbsolute,join}=await import('node:path');
 const {mkdirSync,writeFileSync}=await import('node:fs');
 const {createHash}=await import('node:crypto');
 const dir=resolve(process.env.SCH_QA_ARTIFACT_DIR), rel=relative(process.cwd(),dir);
 assert.ok(rel.startsWith('..')||isAbsolute(rel),'Artifacts must stay OUTSIDE repository');
 mkdirSync(dir,{recursive:true,mode:0o700});
 const manifest={kind:'original synthetic adapter proof, NOT host UI/live DB',dataDate:DATE,checks,tableCount:PERSISTED_TABLE_NAMES.length,files:{}};
 for(const [name,value] of [['before-snapshots.json',preSnapshotBackup],['after-snapshots.json',backup],['restored-reexport.json',afterBackup]]) {
  const bytes=serializeBackup(value);writeFileSync(join(dir,name),bytes,{mode:0o600});manifest.files[name]=createHash('sha256').update(bytes).digest('hex');
 }
 writeFileSync(join(dir,'proof.json'),JSON.stringify(manifest,null,2),{mode:0o600});console.log('Synthetic proof artifacts outside Git:',dir);
}
console.log(`Persistence integration: ${checks}/${checks} passed; ${PERSISTED_TABLE_NAMES.length} tables; snapshots 1+1; original synthetic adapter, NOT host UI/live DB.`);
console.log(JSON.stringify({dataDate:DATE,scope:summary,cost:quoteCanonicalEvm(before.f6),forecastFinish:before.f5.project.forecastFinish,checksum:backup.checksum}));

// Original minimal synthetic data only. Shared by real-component QA and persistence integration.
import { createEmptyWorkspace, commitWorkspace, readWorkspace, WORKSPACE_STORAGE_KEY } from '../../src/lib/localWorkspace.ts';
import { applyApproveProjectScopeBaseline, applySaveVariationOrderDraft, applyTransitionVariationOrder } from '../../src/lib/scopeChangeDbContracts.ts';
import { applyReviewCostTransaction } from '../../src/lib/demoDbContracts.ts';
export const DATE = '2026-09-13';
export const STAMP = DATE + 'T09:00:00Z';
export function memoryStorage() {
 const map = new Map();
 return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,String(v)), removeItem: k => map.delete(k), key: i => [...map.keys()][i] ?? null, get length() { return map.size; } };
}
export function rpcCommit(storage, fn, params) {
 const outcome = commitWorkspace(storage, draft => {
  const r = fn(draft, params, STAMP);
  return r.error ? { ok: false, error: { kind: 'validation', message: r.error.message } } : { ok: true, data: r.data };
 });
 if (!outcome.ok) throw new Error(outcome.error.message);
 return outcome.data;
}
export const read = storage => readWorkspace(storage).state;
export function saveVo(storage, id, number, reference = null, amount = 200) {
 return rpcCommit(storage, applySaveVariationOrderDraft, {
  p_project_id: id, p_actor: 'Synthetic QA author',
  p_header: { vo_number: number, title: number, cause: 'client_request', source: 'Synthetic QA', requested_by: 'Synthetic QA', requested_date: DATE,
   schedule_impact_days: 12, schedule_impact_reference: reference },
  p_boq_impacts: [{ boq_item_id: id+'-boq', quantity_impact: 2, value_impact: amount }], p_wbs_ids: [id+'-wbs'], p_activity_ids: [id+'-a'],
 });
}
export function transitionVo(storage, voId, next) {
 const current = read(storage).variation_orders.find(v => v.id === voId);
 return rpcCommit(storage, applyTransitionVariationOrder, {
  p_variation_order_id: voId, p_expected_status: current.status, p_next_status: next, p_actor: 'Synthetic QA reviewer',
  p_effective_date: DATE, p_reference: 'QA-REF', p_evidence_reference: 'QA-EVIDENCE', p_notes: 'Synthetic lifecycle test only',
 });
}
export function fixture(ids = ['alpha', 'beta']) {
 const storage = memoryStorage(), state = createEmptyWorkspace('user', STAMP);
 for (const id of ids) {
  state.projects.push({ id, name: 'Synthetic '+id, client: 'Synthetic QA', contract_value: 1000, data_date: DATE, start_date: '2026-09-01', end_date: '2026-09-30', currency: 'SAR', calendar_type: '7_days', created_at: STAMP });
  state.wbs_nodes.push({ id: id+'-wbs', project_id:id, code:'W1', name:'Synthetic WBS', parent_id:null, level:1, sort_order:0, boq_item_id:id+'-boq', created_at:STAMP });
  state.boq_items.push({ id:id+'-boq', project_id:id, code:'B1', description:'Synthetic scope', quantity:10, unit:'unit', unit_price:100, total_price:1000, sort_order:0, created_at:STAMP });
  state.activities.push({ id:id+'-a', project_id:id, code:'A1', name:'Synthetic activity '+id, wbs_node_id:id+'-wbs', duration_days:5,
   early_start:'2026-09-01', early_finish:'2026-09-05', late_start:null, late_finish:null, actual_start:'2026-09-09', actual_finish:null,
   planned_quantity:10, actual_quantity:2, percent_complete:20, is_critical:false, is_milestone:false, sort_order:0, calendar_type:'7_days', created_at:STAMP });
  state.activity_boq_allocations.push({ id:id+'-alloc', project_id:id, activity_id:id+'-a', boq_item_id:id+'-boq', quantity_share:10, cost_share:1000, allocation_basis:'plan' });
  state.progress_updates.push({ id:id+'-progress', project_id:id, activity_id:id+'-a', update_date:'2026-09-09', percent_complete:20, actual_quantity:2, quantity_to_date:2, status:'approved', approved_at:STAMP, created_at:STAMP });
  state.cost_transactions.push({ id:id+'-cost', project_id:id, activity_id:id+'-a', boq_item_id:id+'-boq', amount:100, transaction_date:'2026-09-10', description:'Synthetic cost', cost_type:'direct', source:'QA invoice', status:'submitted', approval_level:0, approved_at:null, created_at:STAMP });
  state.delay_claims.push({ id:id+'-claim', project_id:id, claim_number:'QA-HIST', title:'Historical synthetic claim', description:'No source revision/Data Date exists', event_type:'variation_order', responsibility:'excusable_compensable', start_date:'2026-09-09', end_date:'2026-09-10', affected_activity_id:id+'-a', delay_duration_days:12, fragnets:[], pre_impact_project_finish:'2026-09-14', post_impact_project_finish:'2026-09-17', critical_delay_days:3, eot_days_claimed:null, daily_indirect_cost_rate:null, compensation_claimed_sar:null, status:'draft', contractual_reference:'QA only', created_at:STAMP, analysis_method:'statused-cpm-single-fragnet-v1' });
 }
 storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
 for (const id of ids) {
  rpcCommit(storage, applyApproveProjectScopeBaseline, { p_project_id:id, p_approved_by:'Synthetic baseline reviewer', p_approved_at:STAMP, p_approval_reference:'QA-BASE', p_activity_rows:[{ activity_id:id+'-a', early_start:'2026-09-01', early_finish:'2026-09-05', duration_days:5, planned_cost:1000, total_float:0 }] });
  for (const approver of ['Synthetic level1','Synthetic level2']) rpcCommit(storage, applyReviewCostTransaction, { transaction_uuid:id+'-cost', decision:'approve', approver });
  saveVo(storage,id,'VO-PENDING',id+'-claim');
  const approved = saveVo(storage,id,'VO-APPROVED',id+'-claim'); transitionVo(storage,approved,'submitted'); transitionVo(storage,approved,'approved');
 }
 return storage;
}

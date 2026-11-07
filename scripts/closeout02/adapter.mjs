// QA-only module substituted by the dedicated Vite config, NEVER by product config.
import { fixture, read, rpcCommit } from './fixture.mjs';
import { commitWorkspace } from '../../src/lib/localWorkspace.ts';
import { MockQueryBuilder } from '../../src/lib/localQueryBuilder.ts';
import { applySaveVariationOrderDraft, applyTransitionVariationOrder, applyApproveProjectScopeBaseline } from '../../src/lib/scopeChangeDbContracts.ts';
const deferred = () => { let release; const promise=new Promise(resolve => {release=resolve;}); return {promise,release}; };
export const qa = {
 storage:fixture(), faults:new Map(), holds:new Map(), writeHold:null, writeFault:null, requests:[],
 hold(project, table) { const key=table?project+'/'+table:project; const d=deferred(); this.holds.set(key,d); return () => {this.holds.delete(key);d.release();}; },
 holdWrite() { const d=deferred();this.writeHold=d;return () => {this.writeHold=null;d.release();}; },
 reset() { this.storage=fixture();this.faults.clear();this.holds.clear();this.writeHold=null;this.writeFault=null;this.requests=[]; },
};
const port={
 read:()=>({state:read(qa.storage),error:null}),
 commit:fn=>{const r=commitWorkspace(qa.storage,fn);return r.ok?{data:r.data,error:null}:{data:null,error:r.error};},
};
export const supabase={
 from(table) {
  let builder=new MockQueryBuilder(table,port),project;
  const wrapper={};
  for(const method of ['select','eq','order','maybeSingle']) wrapper[method]=(...args)=>{
   if(method==='eq' && args[0]==='project_id') project=args[1];
   builder=builder[method](...args);return wrapper;
  };
  wrapper.then=(resolve,reject)=>{
   qa.requests.push({table,project});
   const fault=qa.faults.get(table), hold=qa.holds.get(project+'/'+table) ?? qa.holds.get(project);
   return (async()=>{
    if(hold) await hold.promise;
    if(fault==='reject')throw new Error('QA rejected '+table);
    if(fault==='reject-null')throw null;
    if(fault==='error')return {data:null,error:{message:'QA denied '+table}};
    if(fault==='null-response')return null;
    if(fault==='null-data')return {data:null,error:null};
    if(fault==='invalid')return {data:{},error:null};
    const r=await builder;
    if(fault==='foreign' && Array.isArray(r.data))return {...r,data:r.data.map(row=>({...row,project_id:'foreign'}))};
    if(fault==='stale' && Array.isArray(r.data))return {...r,data:r.data.map(row=>({...row,baseline_id:'old'}))};
    return r;
   })().then(resolve,reject);
  };
  return wrapper;
 },
 async rpc(name,params){
  const hold=qa.writeHold, fault=qa.writeFault;
  if(hold) await hold.promise;
  if(fault==='reject')throw new Error('QA rejected write');
  if(fault)return {data:null,error:{message:'QA denied write'}};
  try {
   const fn={save_variation_order_draft:applySaveVariationOrderDraft,transition_variation_order:applyTransitionVariationOrder,approve_project_scope_baseline:applyApproveProjectScopeBaseline}[name];
   if(!fn)throw new Error('Unsupported QA RPC '+name);
   return {data:rpcCommit(qa.storage,fn,params),error:null};
  } catch(error){return {data:null,error:{message:String(error)}};}
 },
};

// Runs REAL React and REAL production component. No copied component/hook implementation.
import React from 'react';
import { createRoot } from 'react-dom/client';
import ScopeChangeRegister from '../../src/components/views/ScopeChangeRegister.tsx';
import { qa } from './adapter.mjs';
import { read, saveVo } from './fixture.mjs';
import { buildBackup, validateBackup } from '../../src/lib/localWorkspace.ts';
localStorage.setItem('app_lang','en'); // Dedicated QA origin only; product storage is never read.
const app=document.querySelector('#app'), output=document.querySelector('#results');
const root=createRoot(app), results=[];
let crash=null, checks=0;
class Boundary extends React.Component {
 state={error:null};
 static getDerivedStateFromError(error){return {error};}
 componentDidCatch(error){crash=error;}
 render(){return this.state.error?React.createElement('pre',null,String(this.state.error)):this.props.children;}
}
const delay=()=>new Promise(resolve=>setTimeout(resolve,15));
const visible=e=>!e.closest('[hidden]') && e.getClientRects().length>0;
const buttons=(text,scope=app)=>[...scope.querySelectorAll('button')].filter(e=>visible(e)&&e.textContent.trim()===text);
const button=(text,scope=app)=>buttons(text,scope)[0];
const text=()=>app.innerText;
function check(value,label){if(!value)throw new Error(label);checks++;}
async function until(fn,label){for(let i=0;i<200;i++){if(crash)throw crash;if(fn())return;await delay();}throw new Error('Timeout: '+label);}
async function click(label,scope=app){const b=button(label,scope);check(b&&!b.disabled,'Enabled '+label);b.click();await delay();}
function field(label){const l=[...app.querySelectorAll('label')].find(e=>visible(e)&&e.querySelector('span')?.textContent===label);const input=l?.querySelector('input,textarea,select');if(!input)throw new Error('Missing field '+label);return input;}
async function fill(label,value){const input=field(label);const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await delay();}
async function mount(id,remount=false){root.render(React.createElement(Boundary,{key:remount?Date.now()+Math.random():'boundary'},React.createElement(ScopeChangeRegister,{project:read(qa.storage).projects.find(p=>p.id===id)})));await delay();}
async function ready(){await until(()=>button('New VO')&&!button('New VO').disabled,'complete scope read');}
const row=number=>[...app.querySelectorAll('tbody tr')].find(e=>visible(e)&&e.cells[0]?.textContent.includes(number));
async function newDraft(title){await click('New VO');await fill('Title',title);await fill('Source / origin (required)','Synthetic UI');await fill('Requested by','Synthetic UI author');await fill('Requested date','2026-09-13');}
async function test(name,fn){await fn();results.push('PASS '+name);output.textContent=results.join('\n');}
async function run(){
 await test('Alpha late success/error/finally cannot replace Beta',async()=>{
  for(const fault of [null,'error','reject']){
   qa.reset();if(fault)qa.faults.set('cost_transactions',fault);
   const release=qa.hold('alpha');await mount('alpha',true);
   await until(()=>qa.requests.some(r=>r.project==='alpha'),'held Alpha request');qa.faults.clear();
   await mount('beta');await ready();check(text().includes('beta-claim')&&!text().includes('alpha-claim'),'Beta complete first');
   release();for(let i=0;i<5;i++)await delay();
   check(!button('New VO').disabled&&!text().includes('QA denied')&&!text().includes('alpha-claim'),'Alpha completion isolated');
  }
 });
 await test('Every required read: failure/invalid/null/rejection blocks, Retry recovers',async()=>{
  const tables=['project_baselines','boq_items','wbs_nodes','activities','activity_boq_allocations','variation_orders','variation_order_boq_impacts','variation_order_wbs_links','variation_order_activity_links','variation_order_events','cost_transactions','delay_claims','baseline_boq_items','baseline_wbs_nodes'];
  for(const table of tables)for(const fault of ['error','null-data','null-response','invalid','reject','reject-null','foreign']){
   qa.reset();qa.faults.set(table,fault);await mount('beta',true);
   await until(()=>text().includes('Scope data unavailable.')&&button('Retry')&&!button('Retry').disabled,table+' '+fault);
   check(button('New VO').disabled,'No action on incomplete '+table);
   check(![...app.querySelectorAll('tbody tr')].some(e=>visible(e)),'No partial rows '+table);
   qa.faults.clear();await click('Retry');await ready();check(!!row('VO-APPROVED'),'Retry recovered '+table);
  }
  for(const fault of ['null-response','error','invalid','reject']){
   qa.reset();qa.faults.set('project_scope_baseline_current',fault);await mount('beta',true);
   await until(()=>button('Retry')&&!button('Retry').disabled,'pointer failure');check(button('New VO').disabled,'Pointer gate');
   qa.faults.clear();await click('Retry');await ready();
  }
  qa.reset();qa.faults.set('baseline_boq_items','stale');await mount('beta',true);await until(()=>button('Retry')&&!button('Retry').disabled,'stale baseline');check(button('New VO').disabled,'Stale baseline refused');
  qa.faults.clear();await click('Retry');await ready();
 });
 await test('Held Alpha baseline second-phase cannot affect Beta',async()=>{
  for(const fault of [null,'error','reject']) {
   qa.reset();if(fault)qa.faults.set('baseline_boq_items',fault);
   const release=qa.hold('alpha','baseline_boq_items');await mount('alpha',true);
   await until(()=>qa.requests.some(r=>r.project==='alpha'&&r.table==='baseline_boq_items'),'Alpha baseline phase held');
   qa.faults.clear();await mount('beta');await ready();release();for(let i=0;i<5;i++)await delay();
   check(!button('New VO').disabled&&!text().includes('alpha-claim')&&!text().includes('QA denied'),'Baseline generation isolated '+fault);
  }
 });
 await test('Rejected save retains draft; rejected transition retains modal/stored state',async()=>{
  qa.reset();await mount('beta',true);await ready();const before=JSON.stringify(read(qa.storage));
  await newDraft('Keep this draft');qa.writeFault='reject';await click('Save as draft');
  await until(()=>text().includes('QA rejected write'),'write rejection');check(field('Title').value==='Keep this draft','Draft retained');check(JSON.stringify(read(qa.storage))===before,'No write on rejected save');
  qa.writeFault=null;await click('Close');await click('Submit',row('VO-PENDING'));await fill('Accountable actor','Keep actor');
  qa.writeFault='error';await click('Record transition');await until(()=>text().includes('QA denied write'),'transition rejection');
  check(field('Accountable actor').value==='Keep actor','Transition modal retained');check(read(qa.storage).variation_orders.find(v=>v.vo_number==='VO-PENDING'&&v.project_id==='beta').status==='draft','Stored status retained');
  qa.writeFault=null;await click('Record transition');await until(()=>!button('Record transition'),'successful retry');await ready();
 });
 await test('Old Alpha write completion never clears Beta draft',async()=>{
  for(const operation of ['draft','transition'])for(const fault of [null,'reject']){
   qa.reset();await mount('alpha',true);await ready();
   if(operation==='draft')await newDraft('Alpha held draft');
   else {await click('Submit',row('VO-PENDING'));await fill('Accountable actor','Alpha held actor');}
   qa.writeFault=fault;const release=qa.holdWrite();await click(operation==='draft'?'Save as draft':'Record transition');
   await mount('beta');await ready();await newDraft('Beta stays');release();for(let i=0;i<5;i++)await delay();
   check(field('Title').value==='Beta stays'&&!!button('Save as draft'),'Beta modal preserved on old Alpha '+operation+' '+fault);
   check(!text().includes('QA rejected write'),'Old Alpha error not published into Beta');
  }
 });
 await test('Historical/foreign/missing/free text, overlapping VOs; real reject/withdraw lifecycle',async()=>{
  qa.reset();
  saveVo(qa.storage,'beta','VO-FOREIGN','alpha-claim');saveVo(qa.storage,'beta','VO-MISSING','missing');saveVo(qa.storage,'beta','VO-TEXT','beta-claim 3 days');
  await mount('beta',true);await ready();
  const historical=row('VO-APPROVED').innerText;check(historical.includes('Historical recorded measurement (not current): 3'),'Historical3 quoted');
  check(historical.includes('Current measured / approved delay: N/A')&&historical.includes('freshness unverified'),'Not current or approved delay');
  for(const number of ['VO-FOREIGN','VO-MISSING','VO-TEXT'])check(!row(number).textContent.includes('Historical recorded measurement'),'No claim inferred '+number);
  check(row('VO-PENDING').innerText.includes('Potential overlap — aggregation unavailable'),'Shared activity no sum');
  await click('Submit',row('VO-PENDING'));await fill('Accountable actor','Synthetic UI');await click('Record transition');await ready();await until(()=>button('Reject',row('VO-PENDING')),'submitted actions');
  await click('Reject',row('VO-PENDING'));await fill('Accountable actor','Synthetic UI');await fill('Effective date','2026-09-13');await fill('Rejection reason (required)','QA rejection');await click('Record transition');await ready();
  await until(()=>row('VO-PENDING')?.innerText.includes('Rejected'),'rejected status');check(!button('Submit',row('VO-PENDING')),'Rejected terminal');
  await click('Withdraw',row('VO-TEXT'));await fill('Accountable actor','Synthetic UI');await fill('Effective date','2026-09-13');await fill('Withdrawal reason (required)','QA withdrawal');await click('Record transition');await ready();await until(()=>row('VO-TEXT')?.innerText.includes('Withdrawn'),'withdrawn');
  const validation=validateBackup(buildBackup(read(qa.storage)));check(validation.ok,'Production backup validator accepts all component scenarios');
  check(validation.state.variation_order_events.some(e=>e.to_status==='rejected')&&validation.state.variation_order_events.some(e=>e.to_status==='withdrawn'),'Lifecycle events retained');
 });
 output.textContent=results.join('\n')+`\nCOMPONENT PASS: ${results.length} groups, ${checks} assertions. Synthetic adapter, NOT live DB.`;
 window.__closeout02={ok:true,groups:results.length,checks,results};
}
run().catch(error=>{output.textContent=results.join('\n')+'\nFAIL '+(error.stack||error);window.__closeout02={ok:false,error:String(error),results,checks};});

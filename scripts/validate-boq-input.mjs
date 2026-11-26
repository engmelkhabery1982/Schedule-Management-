import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';

// Exercise the production parser in memory; no workspace or dependency-cache writes.
const compiled = await build({
  stdin: { contents: "export { parseBoqFile } from './src/lib/boqParser.ts'; export { generateBoqPlan, EMPTY_BOQ_OVERRIDES } from './src/lib/boqPlanningEngine.ts'; export { buildBoqPersistPlan } from './src/lib/boqPlanService.ts';", resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
});
const { parseBoqFile, generateBoqPlan, EMPTY_BOQ_OVERRIDES, buildBoqPersistPlan } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const csv = 'Code,Description,Unit,Quantity,Rate,Section\nQA-B1,Mass excavation,m3,300,10,Earthworks\nQA-B2,Structural fill,m3,200,15,Earthworks\nQA-B3,Compaction,m2,200,5,Earthworks\n';
const parse = (text) => parseBoqFile(new File([text], 'input.csv'));
const rows = await parse(csv);
assert.deepEqual(rows.map((r) => [r.code, r.quantity, r.unit_price, r.total_price]), [['QA-B1',300,10,3000],['QA-B2',200,15,3000],['QA-B3',200,5,1000]]);
assert.equal(rows.reduce((sum, r) => sum + r.total_price, 0), 7000);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ['Code','Description','Unit','Quantity','Rate','Section'],
  ['QA-B1','Mass excavation','m3',300,10,'Earthworks'],
  ['QA-B2','Structural fill','m3',200,15,'Earthworks'],
  ['QA-B3','Compaction','m2',200,5,'Earthworks'],
]), 'BOQ');
assert.deepEqual(await parseBoqFile(new File([XLSX.write(workbook,{bookType:'xlsx',type:'buffer'})], 'input.xlsx')), rows);
assert.equal((await parse(csv.replace('300,10', '0,10')))[0].quantity, 0);
await assert.rejects(parse(csv.replace('300,10', 'not-a-number,10')), /Invalid numeric/);
await assert.rejects(parse(csv.replace('300,10', '300,1.2.3')), /Invalid numeric/);
await assert.rejects(parse(csv.replace('300,10', 'Infinity,10')), /Invalid numeric/);
assert.equal((await parse(csv.replace('300,10', '1e3,10')))[0].quantity, 1000);
assert.equal((await parse(csv.replace('QA-B1,', '001,')))[0].code, '001');
assert.equal((await parse(csv.replace('300,10', '300,SAR 10')))[0].unit_price, 10);
const sourceRows = rows.map((r,i)=>({...r,rowKey:`boq-${String(i+1).padStart(4,'0')}`,category:'Earthworks'}));
const plan=generateBoqPlan(sourceRows,{projectName:'QA BOQ input',startDate:'2026-09-13',calendarType:'6_days'},EMPTY_BOQ_OVERRIDES);
const persisted=buildBoqPersistPlan(plan,{name:'QA BOQ input',start_date:'2026-09-13',end_date:'2026-09-23'},sourceRows);
assert.deepEqual(persisted.boqItems.map(r=>r.category),['Earthworks','Earthworks','Earthworks']);
assert.equal(persisted.budgetLines.reduce((sum,r)=>sum+Number(r.planned_cost),0),7000);
assert(persisted.activities.every(a=>a.percent_complete===0&&a.actual_quantity===0&&a.actual_start===null&&a.actual_finish===null));
assert.equal(persisted.project.data_date,'2026-09-13');
console.log('BOQ INPUT VALIDATION PASSED: 14/14');

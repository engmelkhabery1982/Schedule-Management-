// Existing HOST tools only. Never downloads/provisions a browser or changes launch security.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const executablePath=process.env.SCH_QA_BROWSER;
if(!executablePath||!existsSync(executablePath))throw new Error('Set SCH_QA_BROWSER to an EXISTING installed browser executable. No provisioning is allowed.');
const {default:puppeteer}=await import('puppeteer');
const artifact=mkdtempSync(join(tmpdir(),'sch-closeout02-component-'));
const browser=await puppeteer.launch({executablePath,userDataDir:join(artifact,'isolated-profile'),headless:true});
try {
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:3137/scripts/closeout02/component.html',{waitUntil:'networkidle0'});
 await page.waitForFunction(()=>window.__closeout02!==undefined,{timeout:180000});
 const result=await page.evaluate(()=>window.__closeout02);
 writeFileSync(join(artifact,'component-result.json'),JSON.stringify({result,errors},null,2));
 console.log(JSON.stringify({artifact,result,errors},null,2));
 if(!result.ok||errors.length)process.exitCode=1;
} finally {await browser.close();}

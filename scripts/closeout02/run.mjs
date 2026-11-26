// Finite QA entrypoint. Dependency-free suites execute here; browser QA is separately explicit.
import { spawnSync } from 'node:child_process';
const suites=[
 ['scripts/closeout02/delta-boundary.mjs'],
 ['scripts/validate-scope-bridge.mjs'],
 ['--import','./scripts/closeout02/node-loader.mjs','scripts/closeout02/response-tests.mjs'],
 ['--import','./scripts/closeout02/node-loader.mjs','scripts/closeout02/integration.mjs'],
 ['--import','./scripts/closeout02/node-loader.mjs','scripts/closeout02/export-tests.mjs'],
];
for(const args of suites){const r=spawnSync(process.execPath,args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
console.log('CLOSEOUT02 dependency-free suites PASS. Real React component/browser execution is a separate gate, not a skip counted green.');
if(process.argv.includes('--browser')) {
 const r=spawnSync(process.execPath,['scripts/closeout02/browser-runner.mjs'],{stdio:'inherit',env:process.env});process.exit(r.status??1);
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
export const deltaPaths = [
 'src/index.css', 'src/components/views/ExecutiveReportView.tsx',
 'src/components/views/ScopeChangeRegister.tsx', 'src/lib/scopeReadSafety.ts',
 'src/lib/localWorkspace.ts', 'src/lib/xerExporter.ts',
 'scripts/validate-controls.ts', 'scripts/validate-release-boundary.mjs',
 'docs/RELEASE-SCH-20261106-CLOSEOUT01.md',
 'scripts/closeout02/node-loader.mjs', 'scripts/closeout02/response-tests.mjs',
 'scripts/closeout02/fixture.mjs', 'scripts/closeout02/integration.mjs',
 'scripts/closeout02/export-tests.mjs', 'scripts/closeout02/adapter.mjs',
 'scripts/closeout02/vite.config.mjs', 'scripts/closeout02/component.html',
 'scripts/closeout02/component.mjs', 'scripts/closeout02/run.mjs',
 'scripts/closeout02/browser-runner.mjs', 'scripts/closeout02/delta-boundary.mjs',
];
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const base='6a814940194bdf440b54031db6a8e022f565d2d6';
git('merge-base','--is-ancestor',base,'HEAD');
assert.equal(git('branch','--show-current'),'arena/3db7d6ec-schedule-management');
const changed=new Set([
 ...git('diff','--name-only',base).split('\n'),
 ...git('diff','--cached','--name-only',base).split('\n'),
 ...git('ls-files','--others','--exclude-standard').split('\n'),
].filter(Boolean));
assert.deepEqual([...changed].filter(p=>!deltaPaths.includes(p)),[]);
console.log(`CLOSEOUT02 exact delta boundary passed: ${changed.size} paths; protected engines/dependencies/SQL unchanged.`);

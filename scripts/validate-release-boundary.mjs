import assert from 'node:assert/strict';
import { deltaPaths } from './closeout02/delta-boundary.mjs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = 'a494d39b3b3b5d5d3ccb73fb4892ed2d4a367da9';
git('merge-base', '--is-ancestor', base, 'HEAD');
assert.equal(git('branch', '--show-current'), 'arena/3db7d6ec-schedule-management');
const allowed = new Set([
  ...deltaPaths,
  'src/lib/scopeChangeEngine.ts', 'src/components/views/ScopeChangeRegister.tsx',
  'scripts/validate-controls.ts', 'scripts/validate-scope-bridge.mjs',
  'scripts/validate-release-boundary.mjs', 'docs/RELEASE-SCH-20261106-CLOSEOUT01.md',
]);
const paths = new Set([
  ...git('diff', '--name-only', base).split('\n'),
  ...git('diff', '--cached', '--name-only', base).split('\n'),
  ...git('ls-files', '--others', '--exclude-standard').split('\n'),
].filter(Boolean));
assert.deepEqual([...paths].filter(p => !allowed.has(p)), []);
// Original six paths plus enumerated CLOSEOUT02 delta; no directory-wide exemption.
console.log(`Release boundary passed: ${paths.size} paths; protected engines/dependencies/SQL unchanged; storage delta explicitly enumerated.`);

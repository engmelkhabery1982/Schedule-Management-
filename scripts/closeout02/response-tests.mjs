import './node-loader.mjs';
import assert from 'node:assert/strict';
import { requireScopeRows, requireScopePointer } from '../../src/lib/scopeReadSafety.ts';
let checks = 0;
for (const value of [null, undefined, {}, { data: null }, { data: {} }, { data: 'x' }, { data: [null] }, { data: [{ project_id: 'foreign' }] }, { data: [], error: { message: 'denied' } }]) {
 assert.throws(() => requireScopeRows(value, 'p', 'test')); checks++;
}
assert.deepEqual(requireScopeRows({ data: [], error: null }, 'p', 'empty'), []); checks++;
assert.deepEqual(requireScopeRows({ data: [{ project_id: 'p' }], error: null }, 'p', 'valid'), [{ project_id: 'p' }]); checks++;
assert.equal(requireScopePointer({ data: null, error: null }, 'p'), null); checks++;
for (const value of [null, {}, { data: [] }, { data: { project_id: 'p' } }, { data: { project_id: 'foreign', baseline_id: 'b' } }]) {
 assert.throws(() => requireScopePointer(value, 'p')); checks++;
}
assert.throws(() => requireScopeRows({ data: [{ project_id: 'p', baseline_id: 'old' }] }, 'p', 'baseline', 'current')); checks++;
console.log(`Scope response integrity: ${checks}/${checks} passed`);

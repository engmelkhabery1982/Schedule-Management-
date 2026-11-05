import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/lib/reportReadSafety.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { requireReportReads, runReportRead } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const valid = () => Array.from({ length: 8 }, () => ({ data: [], error: null }));
requireReportReads(valid());
for (let i = 0; i < 8; i++) {
  const reads = valid(); reads[i] = { data: [], error: { message: 'read denied' } };
  assert.throws(() => requireReportReads(reads), /Incomplete/);
}
assert.throws(() => requireReportReads([{ data: null }]), /Incomplete/);
let currentA = true, currentB = true, finishCount = 0, shown;
let resolveA, rejectOld;
const old = runReportRead(() => new Promise((resolve) => { resolveA = resolve; }), () => currentA,
  (value) => { shown = value; }, () => { shown = 'error A'; }, () => { finishCount++; });
currentA = false;
await runReportRead(async () => 'B', () => currentB, (value) => { shown = value; }, assert.fail, () => { finishCount++; });
resolveA('A'); await old;
assert.equal(shown, 'B'); assert.equal(finishCount, 1);
const staleFailure = runReportRead(() => new Promise((_, reject) => { rejectOld = reject; }), () => currentA,
  assert.fail, assert.fail, assert.fail);
rejectOld(new Error('late A')); await staleFailure;
let failures = 0;
await runReportRead(async () => { throw Error('storage failure'); }, () => true, assert.fail,
  () => { failures++; }, () => { finishCount++; });
assert.equal(failures, 1); assert.equal(finishCount, 2);
await runReportRead(async () => [], () => true, (value) => { shown = value; }, assert.fail, () => { finishCount++; });
assert.deepEqual(shown, []); assert.equal(finishCount, 3);
console.log('REPORT READ VALIDATION PASSED: eight partial failures, malformed data, out-of-order success/error, retry and valid empty reads');

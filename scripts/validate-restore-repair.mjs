// Synthetic storage only. Run: node --experimental-strip-types scripts/validate-restore-repair.mjs
import assert from 'node:assert/strict';
import { readAuxiliaryStores, restoreWorkspace, buildBackup, serializeBackup, validateBackup, createEmptyWorkspace, writeAuxiliaryStores, WORKSPACE_STORAGE_KEY as MAIN } from '../src/lib/localWorkspace.ts';
const A = 'schedule_diff_revisions_p1', B = 'construction_subcontracts_data_p1', STALE = 'schedule_diff_revisions_stale';
const old = JSON.stringify(createEmptyWorkspace());
const aux = (key, raw) => ({ key, raw, projectId: 'p1' });
const validation = validateBackup(serializeBackup(buildBackup(createEmptyWorkspace(), undefined, [aux(A, '[{"new":1}]'), aux(B, '[]')])));
function store() {
  const map = new Map([[MAIN, old], [A, '[{"old":1}]'], [B, '[]'], [STALE, '[]'], ['credentials', 'secret']]);
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) };
}
const owned = s => [...s.map].filter(([k]) => k === MAIN || k === A || k === B || k === STALE).sort();
let failed = 0;
function test(name, fn) { try { fn(); console.log('PASS', name); } catch(e) { failed++; console.log('FAIL', name, e.message); } }
for (const mode of ['second write throws', 'second write drops', 'stale deletion throws']) test(mode, () => {
  const s = store(), before = owned(s), set = s.setItem, del = s.removeItem;
  let once = true;
  s.setItem = (k,v) => { if (k === B && once && mode !== 'stale deletion throws') { once = false; if (mode === 'second write throws') throw Error('denied'); return; } set(k,v); };
  // Ensure a dropped write differs from existing bytes.
  if (mode === 'second write drops') s.map.set(B, '[{"old":2}]');
  const expected = mode === 'second write drops' ? owned(s) : before;
  s.removeItem = k => { if (k === STALE && once && mode === 'stale deletion throws') { once = false; throw Error('denied'); } del(k); };
  const result = restoreWorkspace(s, validation);
  assert.equal(result.ok, false); assert.deepEqual(owned(s), expected); assert.equal(s.getItem('credentials'), 'secret');
});
for (const mode of ['aux read', 'main read', 'enumeration']) test(mode + ' fails closed', () => {
  const s = store(), before = [...s.map], get = s.getItem;
  if (mode === 'enumeration') s.key = () => { throw Error('enumeration denied'); };
  else s.getItem = k => { if (k === (mode === 'aux read' ? A : MAIN)) throw Error('read denied'); return get(k); };
  assert.equal(restoreWorkspace(s, validation).ok, false); assert.deepEqual([...s.map], before);
});
test('backup auxiliary read does not silently omit bytes', () => {
  const s = store(); s.getItem = () => { throw Error('denied'); };
  assert.throws(() => readAuxiliaryStores(s));
});
test('rollback failure reports recovery evidence', () => {
  const s = store(), set = s.setItem;
  s.setItem = (k,v) => { if (k === B || (k === A && v.includes('old'))) throw Error('denied'); set(k,v); };
  const r = restoreWorkspace(s, validation);
  assert.equal(r.ok, false); assert.match(r.error, /rollback failed/i);
  assert.equal(r.preRestoreBytes, old); assert.equal(r.preRestoreAuxiliary.find(e => e.key === A).raw, '[{"old":1}]');
  assert.ok([...s.map].some(([k,v]) => k.includes('__auxiliary') && v.includes('auxiliary')));
});
test('successful replacement removes stale keys and preserves unrelated bytes', () => {
  const s = store(), r = restoreWorkspace(s, validation);
  assert.equal(r.ok, true); assert.equal(s.getItem(STALE), null); assert.equal(s.getItem('credentials'), 'secret');
});
test('new auxiliary keys are removed on rollback', () => {
  const s = store(), set = s.setItem; s.map.delete(A);
  s.setItem = (k,v) => { if (k === B) throw Error('denied'); set(k,v); };
  assert.equal(restoreWorkspace(s, validation).ok, false); assert.equal(s.getItem(A), null);
});
test('silently dropped stale deletion fails and rolls back', () => {
  const s = store(), before = owned(s); s.removeItem = () => {};
  assert.equal(restoreWorkspace(s, validation).ok, false); assert.deepEqual(owned(s), before);
});
test('dropped recovery archive prevents workspace mutation', () => {
  const s = store(), before = [...s.map], set = s.setItem;
  s.setItem = (k,v) => { if (!k.includes('__pre_restore__')) set(k,v); };
  assert.equal(restoreWorkspace(s, validation).ok, false); assert.deepEqual([...s.map], before);
});
test('missing enumeration cannot produce a complete backup', () => {
  const s = store(); delete s.key;
  assert.throws(() => readAuxiliaryStores(s)); assert.equal(restoreWorkspace(s, validation).ok, false);
});
test('checked monthly revision persistence refuses dropped writes', () => {
  const s = store(); s.setItem = () => {};
  assert.equal(writeAuxiliaryStores(s, [aux(A, '[{"new":1}]')]).ok, false);
});
process.exitCode = failed ? 1 : 0;

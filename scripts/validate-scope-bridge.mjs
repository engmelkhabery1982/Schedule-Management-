// Dependency-free regression runner: execute the production model with Node's TS stripping.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(readFileSync('src/lib/scopeChangeEngine.ts', 'utf8'));
const { buildVoImpactEvidence, calculateScopeSummary } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const order = { id: 'vo', project_id: 'p', status: 'approved', schedule_impact_days: 12, schedule_impact_reference: 'claim', updated_at: 'r1' };
const impact = { id: 'i', project_id: 'p', variation_order_id: 'vo', boq_item_id: 'b', quantity_impact: 2, value_impact: 0 };
const claim = { id: 'claim', project_id: 'p', analysis_method: 'canonical_single_fragnet_cpm', critical_delay_days: 3 };
const input = { projectId: 'p', order, impacts: [impact], activityLinks: [], wbsLinks: [], transactions: [], claims: [claim] };
let checks = 0;
function eq(actual, expected) { assert.deepEqual(actual, expected); checks++; }
const result = buildVoImpactEvidence(input);
eq(result.directValue, 0);
eq(result.quantityRows[0].quantity_impact, 2);
eq(result.enteredScheduleDays, 12);
eq(result.measuredScheduleDays, null);
eq(result.approvedScheduleDays, null);
eq(result.analysis.id, 'claim');
eq(result.analysisFreshness, 'unverified');
eq(buildVoImpactEvidence({ ...input, order: { ...order, schedule_impact_reference: 'claim: 3 days' } }).analysis, null);
eq(buildVoImpactEvidence({ ...input, claims: [{ ...claim, project_id: 'foreign' }] }).analysis, null);
eq(buildVoImpactEvidence({ ...input, impacts: [{ ...impact, project_id: 'foreign' }] }).directValue, null);
eq(buildVoImpactEvidence({ ...input, impacts: [{ ...impact, value_impact: null }] }).directValue, null);
assert.throws(() => buildVoImpactEvidence({ ...input, projectId: 'foreign' })); checks++;
for (const status of ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn']) {
 const summary = calculateScopeSummary([{ original_value: 100 }], [{ ...order, status }], [{ ...impact, value_impact: 20 }]);
 eq(summary.approvedChangesValue, status === 'approved' ? 20 : 0);
 eq(summary.pendingExposureValue, ['draft', 'submitted', 'under_review'].includes(status) ? 20 : 0);
}
const transaction = { id: 't', project_id: 'p', boq_item_id: 'b', amount: 45, status: 'approved', approval_level: 2 };
const snapshot = JSON.stringify(input);
eq(buildVoImpactEvidence({ ...input, transactions: [transaction, { ...transaction, id: 'foreign', project_id: 'other' }] }).costContext.map(t => t.id), ['t']);
eq(buildVoImpactEvidence({ ...input, transactions: [transaction] }).directValue, 0);
eq(JSON.stringify(input), snapshot);
console.log(`Scope bridge: ${checks}/${checks} passed; model-only, not UI/backend acceptance.`);

import type { DemoDb, DemoRpcResult } from './demoDbContracts';

export interface ScopeBaselineRpcParams extends Record<string, unknown> {
  p_project_id?: unknown;
  p_name?: unknown;
  p_approval_reference?: unknown;
  p_approved_by?: unknown;
  p_approved_at?: unknown;
  p_activity_rows?: unknown;
}

export interface SaveVariationOrderDraftRpcParams extends Record<string, unknown> {
  p_project_id?: unknown;
  p_variation_order_id?: unknown;
  p_header?: unknown;
  p_boq_impacts?: unknown;
  p_wbs_ids?: unknown;
  p_activity_ids?: unknown;
  p_actor?: unknown;
}

export interface TransitionVariationOrderRpcParams extends Record<string, unknown> {
  p_variation_order_id?: unknown;
  p_expected_status?: unknown;
  p_next_status?: unknown;
  p_actor?: unknown;
  p_effective_date?: unknown;
  p_reference?: unknown;
  p_evidence_reference?: unknown;
  p_notes?: unknown;
}

const fail = (message: string, hint: string): DemoRpcResult => ({
  data: null,
  error: { message, details: 'No scope-governance write was committed.', hint },
});

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `scope-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isApprovalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && isDate(value.slice(0, 10))
    && Number.isFinite(Date.parse(value));
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function snapshotNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidSourceNumber(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed);
}

function nextId(): string {
  return id();
}

/**
 * Atomic demo mirror for `approve_project_scope_baseline`. The first approval snapshots BOQ/WBS;
 * later revisions retain the original BOQ basis and snapshot the approved WBS revision. This contract
 * never mutates the original BOQ rows.
 */
export function applyApproveProjectScopeBaseline(
  db: DemoDb,
  params: ScopeBaselineRpcParams,
  now = new Date().toISOString(),
): DemoRpcResult {
  const projectId = text(params.p_project_id);
  const name = text(params.p_name) || 'Approved Scope Baseline';
  const approvalReference = text(params.p_approval_reference);
  const approvedBy = text(params.p_approved_by);
  const approvedAt = text(params.p_approved_at);
  const activityRows = params.p_activity_rows === undefined || params.p_activity_rows === null
    ? []
    : params.p_activity_rows;
  if (!projectId) return fail('A project id is required', 'rpc:scope_baseline:project_id');
  if (!(db.projects || []).some((row) => String(row.id) === projectId)) {
    return fail('The scope baseline project does not exist', 'rpc:scope_baseline:project_missing');
  }
  if (!approvalReference || !approvedBy || !isApprovalTimestamp(approvedAt)) {
    return fail('Scope baseline approval requires an approver, date and evidence reference', 'rpc:scope_baseline:approval_evidence');
  }
  if (!Array.isArray(activityRows)) return fail('Baseline activity rows must be an array', 'rpc:scope_baseline:activities');

  const baselines = db.project_baselines || [];
  const projectBaselines = baselines.filter((row) => String(row.project_id) === projectId);
  const version = projectBaselines.reduce((max, row) => Math.max(max, Number(row.version) || 0), 0) + 1;
  const expectedVersion = params.p_expected_version === null || params.p_expected_version === undefined
    ? null
    : Number(params.p_expected_version);
  if (expectedVersion !== null && expectedVersion !== version) {
    return fail('Baseline version changed; refresh scope history and retry', 'rpc:scope_baseline:version_conflict');
  }
  const createsScheduleBaseline = activityRows.length > 0;
  if (createsScheduleBaseline && projectBaselines.some((row) => row.is_active === true)) {
    return fail('An active schedule baseline already exists; scope-only revisions must not replace it', 'rpc:scope_baseline:active_schedule_exists');
  }

  const activities = db.activities || [];
  const baselineActivityRows: Record<string, unknown>[] = [];
  const activityIds = new Set<string>();
  for (const raw of activityRows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('A baseline activity row is invalid', 'rpc:scope_baseline:activity_shape');
    }
    const row = raw as Record<string, unknown>;
    const activityId = text(row.activity_id);
    const activity = activities.find((item) => String(item.id) === activityId && String(item.project_id) === projectId);
    const duration = nullableNumber(row.duration_days);
    const cost = nullableNumber(row.planned_cost);
    const float = nullableNumber(row.total_float);
    if (!activityId || !activity || activityIds.has(activityId)) {
      return fail('Baseline activities must be unique and belong to the project', 'rpc:scope_baseline:activity_boundary');
    }
    if (!isDate(row.early_start) || !isDate(row.early_finish) || duration === undefined || duration === null || cost === undefined || cost === null) {
      return fail('Baseline activity dates, duration and planned cost must be present and valid', 'rpc:scope_baseline:activity_values');
    }
    if (float === undefined) return fail('Baseline total float must be finite or null', 'rpc:scope_baseline:activity_float');
    activityIds.add(activityId);
    baselineActivityRows.push({
      id: nextId(),
      baseline_id: '',
      activity_id: activityId,
      early_start: row.early_start,
      early_finish: row.early_finish,
      duration_days: duration,
      planned_cost: cost,
      total_float: float,
    });
  }

  const baselineId = nextId();
  const header = {
    id: baselineId,
    project_id: projectId,
    version,
    name,
    status: 'approved',
    approved_at: approvedAt,
    approved_by: approvedBy,
    approval_reference: approvalReference,
    baseline_kind: createsScheduleBaseline ? 'integrated' : 'scope',
    // `is_active` remains the schedule-baseline selector. A scope-only revision uses the separate
    // current-scope pointer and cannot displace an F5/F6 schedule baseline.
    is_active: createsScheduleBaseline,
    created_at: now,
  };
  for (const row of baselineActivityRows) row.baseline_id = baselineId;

  const boqRows = (db.boq_items || []).filter((row) => String(row.project_id) === projectId);
  const boqById = new Map(boqRows.map((row) => [String(row.id), row]));
  const currentScopePointer = (db.project_scope_baseline_current || []).find((row) => String(row.project_id) === projectId);
  const priorScopeItems = currentScopePointer
    ? (db.baseline_boq_items || []).filter((row) => String(row.baseline_id) === String(currentScopePointer.baseline_id))
    : [];
  const invalidOriginalBasis = currentScopePointer
    ? priorScopeItems.some((row) => !['original_quantity', 'original_unit_price', 'original_value'].every((field) => isValidSourceNumber(row[field])))
    : boqRows.some((row) => !['quantity', 'unit_price', 'total_price'].every((field) => isValidSourceNumber(row[field])));
  if (invalidOriginalBasis) return fail('Original BOQ baseline basis contains a non-finite number', 'rpc:scope_baseline:invalid_boq_basis');
  // A later scope/WBS revision retains the first approved contractual BOQ basis. New BOQ rows or
  // post-award edits cannot silently become the original contract; they require governed VO impacts.
  const boqSnapshots = currentScopePointer
    ? priorScopeItems.map((row) => ({
      id: nextId(),
      project_id: projectId,
      baseline_id: baselineId,
      source_boq_item_id: row.source_boq_item_id ?? null,
      item_code: row.item_code ?? '',
      description: row.description ?? '',
      unit: row.unit ?? null,
      original_quantity: snapshotNumber(row.original_quantity),
      original_unit_price: snapshotNumber(row.original_unit_price),
      original_value: snapshotNumber(row.original_value),
      category: row.category ?? null,
      section: row.section ?? null,
      sort_order: Number(row.sort_order) || 0,
    }))
    : boqRows.map((row) => ({
      id: nextId(),
      project_id: projectId,
      baseline_id: baselineId,
      source_boq_item_id: row.id ?? null,
      item_code: row.code ?? '',
      description: row.description ?? '',
      unit: row.unit ?? null,
      original_quantity: snapshotNumber(row.quantity),
      original_unit_price: snapshotNumber(row.unit_price),
      original_value: snapshotNumber(row.total_price),
      category: row.category ?? null,
      section: row.section ?? null,
      sort_order: Number(row.sort_order) || 0,
    }));
  const wbsRows = (db.wbs_nodes || []).filter((row) => String(row.project_id) === projectId);
  const wbsById = new Map(wbsRows.map((row) => [String(row.id), row]));
  if (wbsRows.some((row) => (row.parent_id && !wbsById.has(String(row.parent_id)))
      || (row.boq_item_id && !boqById.has(String(row.boq_item_id))))) {
    return fail('WBS snapshot contains a cross-project or unresolved parent/BOQ reference', 'rpc:scope_baseline:wbs_boundary');
  }
  const wbsSnapshots = wbsRows.map((row) => {
    const parent = row.parent_id ? wbsById.get(String(row.parent_id)) : undefined;
    const linkedBoq = row.boq_item_id ? boqById.get(String(row.boq_item_id)) : undefined;
    return {
      id: nextId(),
      project_id: projectId,
      baseline_id: baselineId,
      source_wbs_node_id: row.id ?? null,
      source_parent_id: row.parent_id ?? null,
      parent_code: parent?.code ?? null,
      node_code: row.code ?? '',
      node_name: row.name ?? '',
      level: Number(row.level) || 0,
      sort_order: Number(row.sort_order) || 0,
      boq_item_id: row.boq_item_id ?? null,
      boq_code: linkedBoq?.code ?? null,
    };
  });

  const currentRows = [...(db.project_scope_baseline_current || [])];
  const currentPointer = {
    project_id: projectId,
    baseline_id: baselineId,
    updated_at: now,
  };
  const existingPointerIndex = currentRows.findIndex((row) => String(row.project_id) === projectId);
  if (existingPointerIndex >= 0) currentRows[existingPointerIndex] = currentPointer;
  else currentRows.push(currentPointer);

  // Commit only after every project boundary, approval datum and activity row has validated.
  db.project_baselines = [...baselines, header];
  db.baseline_activities = [...(db.baseline_activities || []), ...baselineActivityRows];
  db.baseline_boq_items = [...(db.baseline_boq_items || []), ...boqSnapshots];
  db.baseline_wbs_nodes = [...(db.baseline_wbs_nodes || []), ...wbsSnapshots];
  db.project_scope_baseline_current = currentRows;
  return {
    data: { baseline_id: baselineId, version, activity_count: baselineActivityRows.length },
    error: null,
  };
}

const VO_STATUSES = new Set(['draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn']);
const VO_CAUSES = new Set(['client_request', 'design_change', 'site_condition', 'authority_requirement', 'other']);

/** Atomic draft create/update contract for the VO header and all three reference sets. */
export function applySaveVariationOrderDraft(
  db: DemoDb,
  params: SaveVariationOrderDraftRpcParams,
  now = new Date().toISOString(),
): DemoRpcResult {
  const projectId = text(params.p_project_id);
  const actor = text(params.p_actor);
  const header = params.p_header;
  const impacts = params.p_boq_impacts;
  const wbsIds = params.p_wbs_ids;
  const activityIds = params.p_activity_ids;
  if (!projectId || !(db.projects || []).some((row) => String(row.id) === projectId)) {
    return fail('A valid project id is required', 'rpc:variation_order:project');
  }
  if (!actor || !header || typeof header !== 'object' || Array.isArray(header)) {
    return fail('Draft save requires an actor and header', 'rpc:variation_order:header');
  }
  if (!Array.isArray(impacts) || !Array.isArray(wbsIds) || !Array.isArray(activityIds)) {
    return fail('Draft reference payloads must be arrays', 'rpc:variation_order:references');
  }
  const values = header as Record<string, unknown>;
  const voNumber = text(values.vo_number);
  const title = text(values.title);
  const requestedBy = text(values.requested_by);
  const requestedDate = values.requested_date;
  const cause = text(values.cause);
  const source = text(values.source);
  if (!voNumber || !title || !source || !requestedBy || !isDate(requestedDate) || !VO_CAUSES.has(cause)) {
    return fail('Draft requires a unique number, title, valid cause/source, requester and requested date', 'rpc:variation_order:required_fields');
  }
  const existingId = text(params.p_variation_order_id);
  const voRows = [...(db.variation_orders || [])];
  const existing = existingId ? voRows.find((row) => String(row.id) === existingId) : undefined;
  if (existingId && (!existing || String(existing.project_id) !== projectId || existing.status !== 'draft')) {
    return fail('Only a draft VO in this project can be edited', 'rpc:variation_order:draft_only');
  }
  const duplicateNumber = voRows.some((row) => String(row.project_id) === projectId
    && String(row.vo_number).trim().toLowerCase() === voNumber.toLowerCase()
    && String(row.id) !== existingId);
  if (duplicateNumber) return fail('VO number is already used in this project', 'rpc:variation_order:duplicate_number');

  const revisionOfId = text(values.revision_of_id) || null;
  if (revisionOfId) {
    const revision = voRows.find((row) => String(row.id) === revisionOfId && String(row.project_id) === projectId);
    if (!revision || !['approved', 'rejected', 'withdrawn'].includes(String(revision.status))) {
      return fail('A correction must reference a terminal VO in the same project', 'rpc:variation_order:revision');
    }
  }
  const scheduleImpact = nullableNumber(values.schedule_impact_days);
  if (scheduleImpact === undefined) return fail('Schedule impact must be finite or left N/A', 'rpc:variation_order:schedule_impact');

  const boqItems = (db.boq_items || []).filter((row) => String(row.project_id) === projectId);
  const boqIds = new Set<string>();
  for (const raw of impacts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('A BOQ impact row is invalid', 'rpc:variation_order:boq_shape');
    const impact = raw as Record<string, unknown>;
    const boqId = text(impact.boq_item_id);
    const quantity = nullableNumber(impact.quantity_impact);
    const value = nullableNumber(impact.value_impact);
    if (!boqId || boqIds.has(boqId) || !boqItems.some((row) => String(row.id) === boqId)) {
      return fail('BOQ impact references must be unique and belong to the project', 'rpc:variation_order:boq_boundary');
    }
    if (quantity === undefined || value === undefined) return fail('BOQ quantity/value impacts must be finite numbers or N/A', 'rpc:variation_order:boq_values');
    boqIds.add(boqId);
  }

  const wbsRows = (db.wbs_nodes || []).filter((row) => String(row.project_id) === projectId);
  const wbsSet = new Set<string>();
  for (const value of wbsIds) {
    const wbsId = text(value);
    if (!wbsId || wbsSet.has(wbsId) || !wbsRows.some((row) => String(row.id) === wbsId)) {
      return fail('WBS references must be unique and belong to the project', 'rpc:variation_order:wbs_boundary');
    }
    wbsSet.add(wbsId);
  }
  const projectActivities = (db.activities || []).filter((row) => String(row.project_id) === projectId);
  const activitySet = new Set<string>();
  for (const value of activityIds) {
    const activityId = text(value);
    if (!activityId || activitySet.has(activityId) || !projectActivities.some((row) => String(row.id) === activityId)) {
      return fail('Activity references must be unique and belong to the project', 'rpc:variation_order:activity_boundary');
    }
    activitySet.add(activityId);
  }

  const voId = existingId || nextId();
  const record: Record<string, unknown> = {
    ...(existing || {}),
    id: voId,
    project_id: projectId,
    vo_number: voNumber,
    title,
    description: text(values.description),
    cause,
    source: text(values.source),
    source_reference: text(values.source_reference) || null,
    status: 'draft',
    requested_date: requestedDate,
    requested_by: requestedBy,
    schedule_impact_days: scheduleImpact,
    schedule_impact_reference: text(values.schedule_impact_reference) || null,
    notes: text(values.notes) || null,
    revision_of_id: revisionOfId,
    submitted_at: existing?.submitted_at ?? null,
    approval_date: existing?.approval_date ?? null,
    approved_by: existing?.approved_by ?? null,
    approval_reference: existing?.approval_reference ?? null,
    approval_evidence_reference: existing?.approval_evidence_reference ?? null,
    rejection_date: existing?.rejection_date ?? null,
    rejected_by: existing?.rejected_by ?? null,
    rejection_reference: existing?.rejection_reference ?? null,
    rejection_reason: existing?.rejection_reason ?? null,
    withdrawn_date: existing?.withdrawn_date ?? null,
    withdrawn_by: existing?.withdrawn_by ?? null,
    withdrawal_reason: existing?.withdrawal_reason ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const nextVoRows = existing
    ? voRows.map((row) => String(row.id) === existingId ? record : row)
    : [...voRows, record];
  const nextBoqImpacts = [
    ...(db.variation_order_boq_impacts || []).filter((row) => String(row.variation_order_id) !== voId),
    ...impacts.map((raw) => {
      const impact = raw as Record<string, unknown>;
      return {
        id: nextId(),
        project_id: projectId,
        variation_order_id: voId,
        boq_item_id: text(impact.boq_item_id),
        quantity_impact: nullableNumber(impact.quantity_impact) ?? null,
        value_impact: nullableNumber(impact.value_impact) ?? null,
        notes: text(impact.notes) || null,
      };
    }),
  ];
  const nextWbsLinks = [
    ...(db.variation_order_wbs_links || []).filter((row) => String(row.variation_order_id) !== voId),
    ...wbsIds.map((wbsId) => ({ id: nextId(), project_id: projectId, variation_order_id: voId, wbs_node_id: text(wbsId) })),
  ];
  const nextActivityLinks = [
    ...(db.variation_order_activity_links || []).filter((row) => String(row.variation_order_id) !== voId),
    ...activityIds.map((activityId) => ({ id: nextId(), project_id: projectId, variation_order_id: voId, activity_id: text(activityId) })),
  ];
  const event = {
    id: nextId(),
    project_id: projectId,
    variation_order_id: voId,
    event_type: existing ? 'draft_updated' : (revisionOfId ? 'revision_created' : 'created'),
    from_status: existing ? 'draft' : null,
    to_status: 'draft',
    actor,
    changed_at: now,
    reference: revisionOfId ? String(revisionOfId) : voNumber,
    evidence_reference: null,
    notes: existing ? 'Draft and reference set updated' : null,
    details: {
      before_header: existing || null,
      after_header: record,
      before_boq_impacts: (db.variation_order_boq_impacts || []).filter((row) => String(row.variation_order_id) === voId),
      after_boq_impacts: nextBoqImpacts.filter((row) => String(row.variation_order_id) === voId),
      before_wbs_links: (db.variation_order_wbs_links || []).filter((row) => String(row.variation_order_id) === voId),
      after_wbs_links: nextWbsLinks.filter((row) => String(row.variation_order_id) === voId),
      before_activity_links: (db.variation_order_activity_links || []).filter((row) => String(row.variation_order_id) === voId),
      after_activity_links: nextActivityLinks.filter((row) => String(row.variation_order_id) === voId),
    },
  };
  db.variation_orders = nextVoRows;
  db.variation_order_boq_impacts = nextBoqImpacts;
  db.variation_order_wbs_links = nextWbsLinks;
  db.variation_order_activity_links = nextActivityLinks;
  db.variation_order_events = [...(db.variation_order_events || []), event];
  return { data: voId, error: null };
}

/** Explicit lifecycle transitions. Approval always needs dated, attributable evidence. */
export function applyTransitionVariationOrder(
  db: DemoDb,
  params: TransitionVariationOrderRpcParams,
  now = new Date().toISOString(),
): DemoRpcResult {
  const voId = text(params.p_variation_order_id);
  const expected = text(params.p_expected_status);
  const next = text(params.p_next_status);
  const actor = text(params.p_actor);
  const effectiveDate = params.p_effective_date;
  const reference = text(params.p_reference);
  const evidence = text(params.p_evidence_reference);
  const notes = text(params.p_notes);
  const allowed: Record<string, string[]> = {
    draft: ['submitted', 'withdrawn'],
    submitted: ['under_review', 'approved', 'rejected', 'withdrawn'],
    under_review: ['approved', 'rejected', 'withdrawn'],
  };
  const rows = [...(db.variation_orders || [])];
  const index = rows.findIndex((row) => String(row.id) === voId);
  if (!voId || index < 0) return fail('Variation order does not exist', 'rpc:variation_order:missing');
  const current = rows[index];
  if (current.status !== expected || !VO_STATUSES.has(next) || !allowed[String(current.status)]?.includes(next)) {
    return fail('Variation order status transition is not allowed from its current state', 'rpc:variation_order:transition');
  }
  if (!actor) return fail('Lifecycle transition requires an accountable actor', 'rpc:variation_order:actor');

  if (next === 'submitted') {
    const hasBoq = (db.variation_order_boq_impacts || []).some((row) => String(row.variation_order_id) === voId);
    const hasWbs = (db.variation_order_wbs_links || []).some((row) => String(row.variation_order_id) === voId);
    const hasActivity = (db.variation_order_activity_links || []).some((row) => String(row.variation_order_id) === voId);
    if (!hasBoq && !hasWbs && !hasActivity) return fail('A VO needs at least one BOQ, WBS or activity reference before submission', 'rpc:variation_order:traceability');
  }
  if (['approved', 'rejected', 'withdrawn'].includes(next) && !isDate(effectiveDate)) {
    return fail('Terminal lifecycle transitions require an explicit effective date', 'rpc:variation_order:effective_date');
  }
  if (next === 'approved' && (!reference || !evidence)) {
    return fail('Approval requires both an approval reference and evidence reference', 'rpc:variation_order:approval_evidence');
  }
  if (next === 'rejected' && !notes) return fail('Rejection requires a recorded reason', 'rpc:variation_order:rejection_reason');
  if (next === 'withdrawn' && !notes) return fail('Withdrawal requires a recorded reason', 'rpc:variation_order:withdrawal_reason');

  const updated: Record<string, unknown> = { ...current, status: next, updated_at: now };
  if (next === 'submitted') updated.submitted_at = now;
  if (next === 'approved') {
    updated.approval_date = effectiveDate;
    updated.approved_by = actor;
    updated.approval_reference = reference;
    updated.approval_evidence_reference = evidence;
  }
  if (next === 'rejected') {
    updated.rejection_date = effectiveDate;
    updated.rejected_by = actor;
    updated.rejection_reference = reference || null;
    updated.rejection_reason = notes;
  }
  if (next === 'withdrawn') {
    updated.withdrawn_date = effectiveDate;
    updated.withdrawn_by = actor;
    updated.withdrawal_reason = notes;
  }
  rows[index] = updated;
  const event = {
    id: nextId(),
    project_id: current.project_id,
    variation_order_id: voId,
    event_type: next,
    from_status: current.status,
    to_status: next,
    actor,
    changed_at: now,
    reference: reference || null,
    evidence_reference: evidence || null,
    notes: notes || null,
    details: {
      effective_date: effectiveDate || null,
      reference: reference || null,
      evidence_reference: evidence || null,
      notes: notes || null,
    },
  };
  db.variation_orders = rows;
  db.variation_order_events = [...(db.variation_order_events || []), event];
  return { data: true, error: null };
}

/** True only for finite inputs; handy for explicit-zero/null regressions. */
export function isFiniteImpact(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

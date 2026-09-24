import type {
  BaselineBoqItem,
  VariationOrder,
  VariationOrderBoqImpact,
  VariationOrderStatus,
} from '@/types';

export interface ScopeItemMetrics {
  approvedQuantityImpact: number | null;
  revisedQuantity: number | null;
  approvedValueImpact: number | null;
  revisedValue: number | null;
  pendingQuantityExposure: number | null;
  pendingValueExposure: number | null;
}

export interface ScopeSummary {
  originalContractValue: number | null;
  approvedChangesValue: number | null;
  revisedApprovedScopeValue: number | null;
  pendingExposureValue: number | null;
}

const PENDING_STATUSES = new Set<VariationOrderStatus>(['draft', 'submitted', 'under_review']);

/**
 * Sum known values without conflating a missing impact with zero. An empty impact set is a true
 * zero-delta; a row whose impact is null makes the sum unavailable until it is quantified.
 */
export function sumKnownImpacts(values: readonly (number | null | undefined)[]): number | null {
  if (values.length === 0) return 0;
  if (values.some((value) => value === null || value === undefined || !Number.isFinite(value))) return null;
  return values.reduce<number>((sum, value) => sum + (value as number), 0);
}

export function applyKnownImpact(original: number | null | undefined, impacts: readonly (number | null | undefined)[]): number | null {
  if (original === null || original === undefined || !Number.isFinite(original)) return null;
  const delta = sumKnownImpacts(impacts);
  return delta === null ? null : original + delta;
}

/** Sum a baseline's stored original BOQ values; do not recompute value from quantity × rate. */
export function sumOriginalScopeValue(items: readonly BaselineBoqItem[]): number | null {
  if (items.length === 0) return null;
  const values = items.map((item) => item.original_value);
  if (values.some((value) => value === null || value === undefined || !Number.isFinite(value))) return null;
  return values.reduce<number>((sum, value) => sum + (value as number), 0);
}

/**
 * Aggregate item-level values for a VO cohort. An eligible VO without a BOQ impact row, or with any
 * unquantified value, makes the total N/A rather than silently disappearing or becoming zero.
 */
export function sumVariationOrderValue(
  orders: readonly VariationOrder[],
  impacts: readonly VariationOrderBoqImpact[],
  statuses: ReadonlySet<VariationOrderStatus>,
): number | null {
  const cohort = orders.filter((order) => statuses.has(order.status));
  if (cohort.length === 0) return 0;

  let total = 0;
  for (const order of cohort) {
    const rows = impacts.filter((impact) => impact.variation_order_id === order.id);
    if (rows.length === 0) return null;
    const value = sumKnownImpacts(rows.map((row) => row.value_impact));
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function getScopeItemMetrics(
  item: BaselineBoqItem,
  orders: readonly VariationOrder[],
  impacts: readonly VariationOrderBoqImpact[],
): ScopeItemMetrics {
  const statusByOrder = new Map(orders.map((order) => [order.id, order.status]));
  const itemImpacts = impacts.filter((impact) => impact.boq_item_id === item.source_boq_item_id);
  const approved = itemImpacts.filter((impact) => statusByOrder.get(impact.variation_order_id) === 'approved');
  const pending = itemImpacts.filter((impact) => {
    const status = statusByOrder.get(impact.variation_order_id);
    return status !== undefined && PENDING_STATUSES.has(status);
  });
  const hasUnquantifiedApprovedOrder = orders.some((order) => order.status === 'approved'
    && !impacts.some((impact) => impact.variation_order_id === order.id));
  const hasUnquantifiedPendingOrder = orders.some((order) => PENDING_STATUSES.has(order.status)
    && !impacts.some((impact) => impact.variation_order_id === order.id));

  const approvedQuantityImpact = hasUnquantifiedApprovedOrder
    ? null
    : sumKnownImpacts(approved.map((impact) => impact.quantity_impact));
  const approvedValueImpact = hasUnquantifiedApprovedOrder
    ? null
    : sumKnownImpacts(approved.map((impact) => impact.value_impact));
  return {
    approvedQuantityImpact,
    revisedQuantity: hasUnquantifiedApprovedOrder
      ? null
      : applyKnownImpact(item.original_quantity, approved.map((impact) => impact.quantity_impact)),
    approvedValueImpact,
    revisedValue: hasUnquantifiedApprovedOrder
      ? null
      : applyKnownImpact(item.original_value, approved.map((impact) => impact.value_impact)),
    pendingQuantityExposure: hasUnquantifiedPendingOrder
      ? null
      : sumKnownImpacts(pending.map((impact) => impact.quantity_impact)),
    pendingValueExposure: hasUnquantifiedPendingOrder
      ? null
      : sumKnownImpacts(pending.map((impact) => impact.value_impact)),
  };
}

export function calculateScopeSummary(
  baselineItems: readonly BaselineBoqItem[],
  orders: readonly VariationOrder[],
  impacts: readonly VariationOrderBoqImpact[],
): ScopeSummary {
  const originalContractValue = sumOriginalScopeValue(baselineItems);
  const approvedChangesValue = sumVariationOrderValue(orders, impacts, new Set(['approved']));
  const pendingExposureValue = sumVariationOrderValue(orders, impacts, PENDING_STATUSES);
  return {
    originalContractValue,
    approvedChangesValue,
    revisedApprovedScopeValue:
      originalContractValue === null || approvedChangesValue === null
        ? null
        : originalContractValue + approvedChangesValue,
    pendingExposureValue,
  };
}

export function isPendingVariationOrderStatus(status: VariationOrderStatus): boolean {
  return PENDING_STATUSES.has(status);
}

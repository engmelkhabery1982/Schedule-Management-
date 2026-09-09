import type { Activity, ActivityResource, Resource } from '@/types';
import type { GeneratedAlert } from '@/lib/alertEngine';

function overlaps(activity: Activity, from: string, to: string): boolean {
  return Boolean(activity.early_start && activity.early_finish && activity.early_start <= to && activity.early_finish >= from);
}

export function generateResourceConflictAlerts(
  activities: Activity[],
  assignments: ActivityResource[],
  resources: Resource[],
): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  const byResource = new Map<string, ActivityResource[]>();
  assignments.forEach((assignment) => {
    byResource.set(assignment.resource_id, [...(byResource.get(assignment.resource_id) || []), assignment]);
  });

  for (const resource of resources) {
    const resourceAssignments = byResource.get(resource.id) || [];
    const resourceActivities = resourceAssignments
      .map((assignment) => ({ assignment, activity: activities.find((item) => item.id === assignment.activity_id) }))
      .filter((item): item is { assignment: ActivityResource; activity: Activity } => Boolean(item.activity));
    for (const item of resourceActivities) {
      if (!item.activity.early_start || !item.activity.early_finish || item.activity.duration_days <= 0) continue;
      const demand = Number(item.assignment.planned_quantity || 0) / item.activity.duration_days;
      if (demand > Number(resource.availability || 0)) {
        alerts.push({
          fingerprint: `resource-capacity-${resource.id}-${item.activity.id}`,
          alert_type: 'resource',
          severity: 'critical',
          title: `طاقة مورد غير كافية: ${resource.name}`,
          message: `النشاط ${item.activity.code} يحتاج ${demand.toFixed(2)} ${resource.unit}/يوم مقابل توفر ${Number(resource.availability).toFixed(2)}.`,
          activity_id: item.activity.id,
        });
      }
    }
    for (let i = 0; i < resourceActivities.length; i += 1) {
      for (let j = i + 1; j < resourceActivities.length; j += 1) {
        const first = resourceActivities[i];
        const second = resourceActivities[j];
        if (!first.activity.early_start || !first.activity.early_finish || !second.activity.early_start || !second.activity.early_finish) continue;
        if (!overlaps(first.activity, second.activity.early_start, second.activity.early_finish)) continue;
        const combined = Number(first.assignment.planned_quantity || 0) / Math.max(1, first.activity.duration_days)
          + Number(second.assignment.planned_quantity || 0) / Math.max(1, second.activity.duration_days);
        if (combined > Number(resource.availability || 0)) {
          alerts.push({
            fingerprint: `resource-overlap-${resource.id}-${first.activity.id}-${second.activity.id}`,
            alert_type: 'resource',
            severity: 'warning',
            title: `تعارض تحميل المورد: ${resource.name}`,
            message: `النشاطان ${first.activity.code} و${second.activity.code} متداخلان ويتجاوزان التوفر اليومي (${combined.toFixed(2)} من ${Number(resource.availability).toFixed(2)}).`,
            activity_id: first.activity.id,
          });
        }
      }
    }
  }
  return alerts;
}

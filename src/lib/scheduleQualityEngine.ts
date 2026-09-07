import type { Activity, ActivityLink } from '@/types';
import type { GeneratedAlert } from '@/lib/alertEngine';

export function generateScheduleQualityAlerts(
  activities: Activity[],
  links: ActivityLink[],
): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  const predecessors = new Set(links.map((link) => link.successor_id));
  const successors = new Set(links.map((link) => link.predecessor_id));

  for (const activity of activities) {
    const hasDates = Boolean(activity.early_start && activity.early_finish);
    if (!hasDates) continue;
    const start = new Date(`${activity.early_start}T00:00:00Z`);
    const finish = new Date(`${activity.early_finish}T00:00:00Z`);
    if (finish < start || activity.duration_days < 0) {
      alerts.push({
        fingerprint: `quality-invalid-dates-${activity.id}`,
        alert_type: 'data_quality',
        severity: 'critical',
        title: `تواريخ غير منطقية: ${activity.code}`,
        message: 'تاريخ النهاية أسبق من البداية أو مدة النشاط سالبة.',
        activity_id: activity.id,
      });
    }
    if (Number(activity.total_float || 0) < 0) {
      alerts.push({
        fingerprint: `quality-negative-float-${activity.id}`,
        alert_type: 'schedule',
        severity: 'critical',
        title: `هامش سالب: ${activity.code}`,
        message: `النشاط لديه هامش سالب قدره ${Number(activity.total_float).toFixed(1)} يوم، ما يعني وجود تأخير مؤثر على شبكة الجدول.`,
        activity_id: activity.id,
      });
    }
    if (!activity.is_milestone && !predecessors.has(activity.id) && activities.length > 1) {
      alerts.push({
        fingerprint: `quality-open-start-${activity.id}`,
        alert_type: 'data_quality',
        severity: 'warning',
        title: `نشاط بلا سابق: ${activity.code}`,
        message: 'النشاط غير مرتبط بسابق وقد يبدأ دون منطق شبكة واضح.',
        activity_id: activity.id,
      });
    }
    if (!activity.is_milestone && !successors.has(activity.id) && activities.length > 1) {
      alerts.push({
        fingerprint: `quality-open-finish-${activity.id}`,
        alert_type: 'data_quality',
        severity: 'warning',
        title: `نشاط بلا لاحق: ${activity.code}`,
        message: 'النشاط غير مرتبط بلاحق وقد لا يؤثر في تاريخ الإكمال النهائي.',
        activity_id: activity.id,
      });
    }
    if (activity.is_milestone && (activity.duration_days !== 0 || activity.planned_quantity > 0)) {
      alerts.push({
        fingerprint: `quality-milestone-duration-${activity.id}`,
        alert_type: 'data_quality',
        severity: 'warning',
        title: `معلم غير منضبط: ${activity.code}`,
        message: 'المعلم يجب أن تكون مدته وكميته المخططة صفراً.',
        activity_id: activity.id,
      });
    }
  }

  const duplicateCodes = new Set(
    activities
      .map((activity) => activity.code)
      .filter((code, index, codes) => codes.indexOf(code) !== index),
  );
  duplicateCodes.forEach((code) => {
    alerts.push({
      fingerprint: `quality-duplicate-code-${code}`,
      alert_type: 'data_quality',
      severity: 'critical',
      title: `كود نشاط مكرر: ${code}`,
      message: 'الأكواد المكررة تمنع المطابقة الآمنة عند الاستيراد والتحديث.',
      activity_id: activities.find((activity) => activity.code === code)?.id || null,
    });
  });
  return alerts;
}

import type { Activity, EvmMetrics } from '@/types';

export interface GeneratedAlert {
  fingerprint: string;
  alert_type: 'schedule' | 'cost' | 'data_quality' | 'resource';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  activity_id: string | null;
}

export function generateScheduleAlerts(
  activities: Activity[],
  evm: EvmMetrics,
  today = new Date(),
): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  if (evm.spi < 0.9) {
    alerts.push({
      fingerprint: 'evm-spi-below-090',
      alert_type: 'schedule',
      severity: evm.spi < 0.75 ? 'critical' : 'warning',
      title: 'تأخر عام في الجدول',
      message: `SPI الحالي ${evm.spi.toFixed(2)} أقل من الحد المقبول، ويحتاج المشروع إلى خطة تصحيح.`,
      activity_id: null,
    });
  }
  if (evm.cpi < 0.9) {
    alerts.push({
      fingerprint: 'evm-cpi-below-090',
      alert_type: 'cost',
      severity: evm.cpi < 0.75 ? 'critical' : 'warning',
      title: 'ضغط على التكلفة',
      message: `CPI الحالي ${evm.cpi.toFixed(2)} والتكلفة المتوقعة ${evm.eac.toLocaleString()} ريال.`,
      activity_id: null,
    });
  }
  for (const activity of activities) {
    const due = activity.early_finish ? new Date(`${activity.early_finish}T23:59:59`) : null;
    if (due && due < today && activity.percent_complete < 100) {
      alerts.push({
        fingerprint: `activity-overdue-${activity.id}`,
        alert_type: 'schedule',
        severity: activity.is_critical ? 'critical' : 'warning',
        title: `نشاط متأخر: ${activity.code}`,
        message: `${activity.name} تجاوز تاريخ النهاية المخطط وما زال عند ${activity.percent_complete}%.`,
        activity_id: activity.id,
      });
    }
    if (!activity.early_start || !activity.early_finish) {
      alerts.push({
        fingerprint: `activity-missing-dates-${activity.id}`,
        alert_type: 'data_quality',
        severity: 'warning',
        title: `تواريخ ناقصة: ${activity.code}`,
        message: 'النشاط لا يحتوي على بداية ونهاية مخططتين، لذلك لا يمكن قياس انحرافه بدقة.',
        activity_id: activity.id,
      });
    }
    if (!activity.is_critical && Number(activity.total_float || 0) <= 5 && activity.percent_complete < 100) {
      alerts.push({
        fingerprint: `activity-near-critical-${activity.id}`,
        alert_type: 'schedule',
        severity: 'warning',
        title: `نشاط قريب من المسار الحرج: ${activity.code}`,
        message: `الهامش المتبقي ${Number(activity.total_float || 0)} يوم فقط.`,
        activity_id: activity.id,
      });
    }
  }
  return alerts;
}

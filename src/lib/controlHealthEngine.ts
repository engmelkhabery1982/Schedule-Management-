import type { EvmMetrics, ProjectAlert } from '@/types';

export interface ControlRecommendation {
  priority: 'high' | 'medium' | 'low';
  title: string;
  action: string;
}

export interface ControlHealth {
  score: number;
  label: 'healthy' | 'watch' | 'at_risk' | 'critical';
  recommendations: ControlRecommendation[];
}

export function calculateControlHealth(
  evm: EvmMetrics,
  alerts: ProjectAlert[],
  behindBaselineCount: number,
  resourceConflicts: number,
): ControlHealth {
  const critical = alerts.filter((alert) => alert.severity === 'critical').length;
  const warnings = alerts.filter((alert) => alert.severity === 'warning').length;
  const score = Math.max(0, Math.min(100, Math.round(
    100
      - critical * 12
      - warnings * 4
      - Math.max(0, 1 - evm.spi) * 25
      - Math.max(0, 1 - evm.cpi) * 20
      - behindBaselineCount * 2
      - resourceConflicts * 5,
  )));
  const recommendations: ControlRecommendation[] = [];
  if (evm.spi < 0.9) recommendations.push({ priority: 'high', title: 'استعادة الجدول', action: 'حلل الأنشطة الحرجة وحدد إجراءً تصحيحيًا بموعد ومسؤول قبل التحديث القادم.' });
  if (evm.cpi < 0.9) recommendations.push({ priority: 'high', title: 'احتواء التكلفة', action: 'راجع الالتزامات والتكاليف المعتمدة وافصل أسباب الانحراف عن تغير نطاق العمل.' });
  if (resourceConflicts > 0) recommendations.push({ priority: 'high', title: 'فض تعارض الموارد', action: 'أعد تسوية الأنشطة المتداخلة أو زد التوفر المعتمد قبل اعتماد الخطة التالية.' });
  if (behindBaselineCount > 0) recommendations.push({ priority: 'medium', title: 'حماية خط الأساس', action: 'وثق سبب الانحراف وقرار المعالجة قبل تعديل التواريخ الحالية.' });
  if (recommendations.length === 0) recommendations.push({ priority: 'low', title: 'استمرار المراقبة', action: 'استمر في تحديث التقدم والتكلفة المعتمدين للحفاظ على موثوقية التوقع.' });
  return {
    score,
    label: score >= 80 ? 'healthy' : score >= 60 ? 'watch' : score >= 40 ? 'at_risk' : 'critical',
    recommendations,
  };
}

export type Language = 'ar' | 'en';

export interface TranslationDictionary {
  // Common & Navigation
  portfolio: string;
  dashboard: string;
  scenario_simulation: string;
  data_governance: string;
  schedule: string;
  bim_4d: string;
  linear_schedule: string;
  payment_certificates: string;
  financial_controls: string;
  schedule_diff: string;
  time_impact_analysis: string;
  schedule_recovery: string;
  dcma_audit: string;
  resources: string;
  procurement: string;
  boq: string;
  progress: string;
  budget: string;
  risks: string;
  executive_report: string;
  import: string;
  export: string;
  active_project: string;
  enterprise_platform: string;
  fullscreen: string;
  exit_fullscreen: string;
  language: string;
  switch_lang_btn: string;
  project_label: string;
  demo_project: string;
  recalculate_cpm: string;
  save_snapshot: string;
  auto_fix_all: string;
  auto_fix_point: string;
  recheck: string;
  recommendation_title: string;
  status_pass: string;
  status_warning: string;
  status_fail: string;
  
  // Dashboard
  total_progress: string;
  completed_activities: string;
  in_progress: string;
  not_started: string;
  consumed_budget: string;
  critical_activities: string;
  open_risks: string;
  high_risks: string;
  open_issues: string;
  control_health: string;
  construction_status: string;
  budget_summary: string;
  approved_budget: string;
  committed_cost: string;
  actual_cost: string;
  remaining_budget: string;
  evm_title: string;
  planned_pv: string;
  earned_ev: string;
  spi_cpi: string;
  forecast_eac: string;
  forecast_finish: string;
  recent_updates: string;
  top_risks: string;
  engineering_proposals_title: string;
  engineering_proposals_subtitle: string;
  
  // Schedule View
  gantt_title: string;
  gantt_subtitle: string;
  zoom_scale: string;
  zoom_days: string;
  zoom_weeks: string;
  zoom_months: string;
  show_links: string;
  show_baseline: string;
  filter_critical: string;
  filter_milestones: string;
  activity_code: string;
  activity_name: string;
  early_start: string;
  early_finish: string;
  duration_days: string;
  percent_complete: string;
  total_float: string;
  free_float: string;
  activity_drag: string;
  baseline_var: string;
  critical: string;
  actions: string;
  
  // Schedule Diff
  diff_title: string;
  diff_subtitle: string;
  rev_a_label: string;
  rev_b_label: string;
  project_slip_var: string;
  modified_activities: string;
  critical_shifts: string;
  added_activities: string;
  filter_all: string;
  filter_modified: string;
  filter_slippage: string;
}

export const translations: Record<Language, TranslationDictionary> = {
  ar: {
    portfolio: 'محفظة المشاريع PMO',
    dashboard: 'لوحة التحكم والمؤشرات',
    scenario_simulation: 'محاكاة السيناريوهات المعقدة Sim',
    data_governance: 'حوكمة وجودة البيانات SSOT',
    schedule: 'الجدول الزمني CPM',
    bim_4d: 'النمذجة 4D BIM',
    linear_schedule: 'المخطط الخطي Linear',
    payment_certificates: 'المستخلصات والأوامر IPC',
    financial_controls: 'الرقابة المالية FIDIC',
    schedule_diff: 'مقارن الجداول Diff',
    time_impact_analysis: 'تحليل الأثر ومطالبات EOT',
    schedule_recovery: 'خطط الاستدراك والتعجيل',
    dcma_audit: 'فحص الجودة DCMA',
    resources: 'الموارد والتسوية',
    procurement: 'المشتريات والاعتمادات',
    boq: 'جدول الكميات BOQ',
    progress: 'تتبع الإنجاز والمطابقات',
    budget: 'الميزانية والتكاليف',
    risks: 'المخاطر ومونت كارلو',
    executive_report: 'التقرير التنفيذي PDF',
    import: 'استيراد مشروع BOQ/P6',
    export: 'تصدير P6 / MS Project',
    active_project: 'المشروع النشط',
    enterprise_platform: 'منصة إدارة وجدولة المشاريع الاحترافية',
    fullscreen: 'عرض بشاشة كاملة',
    exit_fullscreen: 'إنهاء الشاشة الكاملة',
    language: 'اللغة',
    switch_lang_btn: 'English (EN)',
    project_label: 'المشروع:',
    demo_project: 'مشروع إنشاء وتطوير متكامل',
    recalculate_cpm: 'إعادة حساب CPM',
    save_snapshot: 'حفظ لقطة إصدار حالي',
    auto_fix_all: 'تصحيح وتعديل آلي شامل للأخطاء',
    auto_fix_point: 'تطبيق التصحيح الآلي لهذا المعيار',
    recheck: 'إعادة الفحص',
    recommendation_title: 'التوصية الهندسية المعتمدة (Engineering Recommendation):',
    status_pass: 'مطابق',
    status_warning: 'تنبيه',
    status_fail: 'مخالف',
    
    total_progress: 'نسبة الإنجاز الكلية',
    completed_activities: 'الأنشطة المكتملة',
    in_progress: 'قيد التنفيذ',
    not_started: 'لم تبدأ',
    consumed_budget: 'الميزانية المستهلكة',
    critical_activities: 'الأنشطة الحرجة',
    open_risks: 'المخاطر المفتوحة',
    high_risks: 'مخاطر عالية',
    open_issues: 'المشاكل المفتوحة',
    control_health: 'صحة التحكم في المشروع',
    construction_status: 'حالة الأنشطة الإنشائية',
    budget_summary: 'ملخص الميزانية (ريال)',
    approved_budget: 'الميزانية المعتمدة (BAC)',
    committed_cost: 'المبالغ الملتزم بها',
    actual_cost: 'التكلفة الفعلية (AC)',
    remaining_budget: 'المتبقي بالميزانية',
    evm_title: 'مؤشرات القيمة المكتسبة (Earned Value Management - EVM)',
    planned_pv: 'PV مخطط',
    earned_ev: 'EV مكتسب',
    spi_cpi: 'SPI / CPI',
    forecast_eac: 'EAC متوقع بالمخاطر',
    forecast_finish: 'التسليم المتوقع',
    recent_updates: 'آخر تحديثات التقدم المعتمدة',
    top_risks: 'أهم المخاطر المسجلة',
    engineering_proposals_title: 'مصفوفة مقترحات وتدابير التصحيح الهندسي (PMI / AACE / FIDIC / DCMA)',
    engineering_proposals_subtitle: 'تدابير هندسية معتمدة قابلة للتنفيذ الفوري لمعالجة الانحرافات والمخاطر الحرجة في المشروع.',

    gantt_title: 'الجدول الزمني التفاعلي والمسار الحرج (Interactive CPM Gantt Canvas)',
    gantt_subtitle: 'تحكم حركي بالسحب لتعديل التواريخ والمدد، رسم الروابط، وتغيير مقياس العرض (أيام/أسابيع/أشهر)',
    zoom_scale: 'مقياس العرض:',
    zoom_days: 'أيام (Days)',
    zoom_weeks: 'أسابيع (Weeks)',
    zoom_months: 'أشهر (Months)',
    show_links: 'أسهم العلاقات (Links)',
    show_baseline: 'مقارنة خط الأساس',
    filter_critical: 'المسار الحرج',
    filter_milestones: 'المعالم',
    activity_code: 'الكود',
    activity_name: 'اسم النشاط',
    early_start: 'البداية المبكرة (ES)',
    early_finish: 'النهاية المبكرة (EF)',
    duration_days: 'المدة (أيام)',
    percent_complete: 'الإنجاز %',
    total_float: 'الهامش الكلي (TF)',
    free_float: 'الهامش الحر (FF)',
    activity_drag: 'كبح المسار (Drag)',
    baseline_var: 'انحراف الأساس',
    critical: 'حرج',
    actions: 'إجراءات',

    diff_title: 'مقارن الجداول ومطابقة النسخ (Schedule Diff & Baseline Variance)',
    diff_subtitle: 'قارن بين أي نسختين أو خط أساس لرصد الانحرافات في التواريخ، المدد، الهوامش وتحولات المسار الحرج.',
    rev_a_label: 'النسخة المرجعية الأساسية (Revision A - Reference):',
    rev_b_label: 'نسخة المقارنة المستهدفة (Revision B - Target):',
    project_slip_var: 'انحراف تسليم المشروع الكلي',
    modified_activities: 'الأنشطة التي طرأ عليها تعديل',
    critical_shifts: 'تحولات المسار الحرج',
    added_activities: 'الأنشطة المستحدثة المضافة',
    filter_all: 'الكل',
    filter_modified: 'المعدلة فقط',
    filter_slippage: 'المتأخرة (Slippages)',
  },
  en: {
    portfolio: 'Portfolio PMO Executive Hub',
    dashboard: 'Dashboard & Control KPIs',
    scenario_simulation: 'Complex Multi-Scenario Simulator',
    data_governance: 'Data Governance & SSOT Parity',
    schedule: 'Interactive CPM Schedule',
    bim_4d: '4D BIM Simulation & VR',
    linear_schedule: 'Linear Scheduling (Time-Location)',
    payment_certificates: 'Payment Certificates & VOs',
    financial_controls: 'FIDIC Financial & Contract Controls',
    schedule_diff: 'Schedule Diff & Variances',
    time_impact_analysis: 'Time Impact Analysis (TIA)',
    schedule_recovery: 'Schedule Recovery & Crashing',
    dcma_audit: 'DCMA 14-Point Quality Audit',
    resources: 'Resource Leveling & Histogram',
    procurement: 'Procurement & Submittals',
    boq: 'Bill of Quantities (BOQ)',
    progress: 'Daily Progress & Cumulative Log',
    budget: 'Budget & Cost Management',
    risks: 'Risk Register & Monte Carlo',
    executive_report: 'Executive PDF Report',
    import: 'Import (BOQ / P6 XML)',
    export: 'Export (P6 XML / MS Project)',
    active_project: 'Active Project',
    enterprise_platform: 'Enterprise Scheduling & Project Controls',
    fullscreen: 'Fullscreen Workstation',
    exit_fullscreen: 'Exit Fullscreen',
    language: 'Language',
    switch_lang_btn: 'العربية (AR)',
    project_label: 'Project:',
    demo_project: 'Integrated Construction Project',
    recalculate_cpm: 'Recalculate CPM',
    save_snapshot: 'Save Schedule Snapshot',
    auto_fix_all: 'Auto-Fix All Schedule Issues',
    auto_fix_point: 'Auto-Fix This Point Now',
    recheck: 'Re-audit Schedule',
    recommendation_title: 'Standard Engineering Recommendation (DCMA / AACE):',
    status_pass: 'Pass',
    status_warning: 'Warning',
    status_fail: 'Violation',

    total_progress: 'Overall Progress',
    completed_activities: 'Completed Activities',
    in_progress: 'In Progress',
    not_started: 'Not Started',
    consumed_budget: 'Budget Utilization',
    critical_activities: 'Critical Activities',
    open_risks: 'Open Risks',
    high_risks: 'High Risks',
    open_issues: 'Open Issues',
    control_health: 'Project Control Health',
    construction_status: 'Construction Activities Status',
    budget_summary: 'Budget Summary (SAR)',
    approved_budget: 'Approved Budget (BAC)',
    committed_cost: 'Committed Cost',
    actual_cost: 'Actual Cost (AC)',
    remaining_budget: 'Remaining Budget',
    evm_title: 'Earned Value Management (EVM) Metrics',
    planned_pv: 'Planned Value (PV)',
    earned_ev: 'Earned Value (EV)',
    spi_cpi: 'SPI / CPI Indices',
    forecast_eac: 'Risk-Adjusted EAC',
    forecast_finish: 'Forecast Completion',
    recent_updates: 'Recent Approved Progress Updates',
    top_risks: 'Top Registered Threats',
    engineering_proposals_title: 'Engineering Corrective Proposals & Action Matrix (PMI / AACE / FIDIC / DCMA)',
    engineering_proposals_subtitle: 'Actionable engineering mitigation and recovery measures to resolve project variance and critical risks.',

    gantt_title: 'Interactive CPM Schedule & Gantt Canvas',
    gantt_subtitle: 'Direct manipulation to drag/move dates, resize durations, draw logic links, and change zoom levels (Days/Weeks/Months)',
    zoom_scale: 'Zoom Scale:',
    zoom_days: 'Days',
    zoom_weeks: 'Weeks',
    zoom_months: 'Months',
    show_links: 'Relationship Links',
    show_baseline: 'Show Baseline',
    filter_critical: 'Critical Path',
    filter_milestones: 'Milestones',
    activity_code: 'Code',
    activity_name: 'Activity Name',
    early_start: 'Early Start (ES)',
    early_finish: 'Early Finish (EF)',
    duration_days: 'Duration (Days)',
    percent_complete: 'Progress %',
    total_float: 'Total Float (TF)',
    free_float: 'Free Float (FF)',
    activity_drag: 'Activity Drag',
    baseline_var: 'Baseline Var',
    critical: 'Critical',
    actions: 'Actions',

    diff_title: 'Schedule Diff & Multi-Revision Variance Matrix',
    diff_subtitle: 'Compare any two revisions or baselines to track date variances, duration shifts, float changes, and critical switches.',
    rev_a_label: 'Reference Version (Revision A):',
    rev_b_label: 'Target Version (Revision B):',
    project_slip_var: 'Project Completion Variance',
    modified_activities: 'Modified Activities',
    critical_shifts: 'Critical Path Shifts',
    added_activities: 'Added Activities',
    filter_all: 'All',
    filter_modified: 'Modified Only',
    filter_slippage: 'Slippages Only',
  },
};

export function getLanguage(): Language {
  const lang = (localStorage.getItem('app_lang') as Language) || 'ar';
  if (typeof document !== 'undefined') {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }
  return lang;
}

export function setLanguage(lang: Language) {
  localStorage.setItem('app_lang', lang);
  if (typeof document !== 'undefined') {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
    window.dispatchEvent(new CustomEvent('app-language-changed', { detail: { lang } }));
  }
}

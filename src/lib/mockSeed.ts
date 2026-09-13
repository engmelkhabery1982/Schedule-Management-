import type {
  Project,
  BoqItem,
  WbsNode,
  Activity,
  ActivityLink,
  Resource,
  ActivityResource,
  BudgetLine,
  Risk,
  Issue,
  ProgressUpdate,
  CostTransaction,
  ProcurementSubmittal,
  ProjectBaseline,
  BaselineActivity,
} from '@/types';

export function getInitialSeedData(): Record<string, any[]> {
  const now = '2026-09-13T08:00:00Z';
  const defaultDataDate = '2026-09-13';

  // =========================================================================
  // 1. PROJECTS DEFINITIONS (4 Diverse Enterprise Projects)
  // =========================================================================
  const p1Id = 'proj-seed-001';
  const p2Id = 'proj-seed-002';
  const p3Id = 'proj-seed-003';
  const p4Id = 'proj-seed-004';

  const project1: Project = {
    id: p1Id,
    name: 'مشروع إنشاء مبنى مكاتب تجاري (4 أدوار) - الرياض',
    client: 'شركة الأفق للاستثمار العقاري',
    location: 'الرياض - حي الياسمين',
    contract_value: 2345150,
    currency: 'SAR',
    start_date: '2026-07-01',
    end_date: '2027-02-28',
    data_date: defaultDataDate,
    status_logic: 'retained_logic',
    duration_days: 195,
    status: 'active',
    calendar_type: '6_days',
    sector: 'commercial_building',
    description: 'مشروع إنشاء وتشطيب مبنى مكتبي متكامل يشمل الأعمال الإنشائية والمعمارية والكهروميكانيكية.',
    created_at: now,
  };

  const project2: Project = {
    id: p2Id,
    name: 'مشروع إنشاء طريق سريع وشبكات تصريف (15 كم) - الشرقية',
    client: 'وزارة النقل والخدمات اللوجستية',
    location: 'المنطقة الشرقية - طريق الدمام الجبيل',
    contract_value: 48000000,
    currency: 'SAR',
    start_date: '2026-06-01',
    end_date: '2027-10-30',
    data_date: defaultDataDate,
    status_logic: 'retained_logic',
    duration_days: 455,
    status: 'active',
    calendar_type: '6_days',
    sector: 'infrastructure_highway',
    description: 'إنشاء طريق سريع مزدوج بطول 15 كم مع جسور تقاطعات، عبارات تصريف سيول صندوقية، وأعمال إنارة ذكية وحواجز نيوجيرسي.',
    created_at: now,
  };

  const project3: Project = {
    id: p3Id,
    name: 'مشروع مستشفى تخصصي (200 سرير) - جدة',
    client: 'الشؤون الصحية والخدمات الطبية',
    location: 'جدة - حي الشاطئ',
    contract_value: 125000000,
    currency: 'SAR',
    start_date: '2026-05-01',
    end_date: '2028-02-28',
    data_date: defaultDataDate,
    status_logic: 'retained_logic',
    duration_days: 620,
    status: 'active',
    calendar_type: '6_days',
    sector: 'healthcare_hospital',
    description: 'مشروع إنشاء وتجهيز مستشفى تخصصي متكامل يشمل غرف العمليات المعقمة والعناية المركزة وأنظمة الغازات الطبية وفلاتر HEPA والعزل الإشعاعي.',
    created_at: now,
  };

  const project4: Project = {
    id: p4Id,
    name: 'مشروع مجمع فلل سكنية راقية (50 فيلا) - الرياض',
    client: 'صندوق التطوير العقاري السكني',
    location: 'الرياض - حي النرجس',
    contract_value: 32500000,
    currency: 'SAR',
    start_date: '2026-06-15',
    end_date: '2027-08-30',
    data_date: defaultDataDate,
    status_logic: 'retained_logic',
    duration_days: 410,
    status: 'active',
    calendar_type: '6_days',
    sector: 'residential_complex',
    description: 'إنشاء 50 فيلا سكنية فاخرة مع أعمال البنية التحتية والحدائق وشبكات الصرف والري والتشطيبات الفاخرة.',
    created_at: now,
  };

  // =========================================================================
  // 2. WBS NODES FOR ALL 4 PROJECTS
  // =========================================================================
  const wbsNodes: WbsNode[] = [
    // Project 1 WBS (Commercial)
    { id: 'wbs-p1-01', project_id: p1Id, parent_id: null, code: '1.0', name: 'أعمال الموقع والأساسات', level: 1, sort_order: 1, boq_item_id: null, created_at: now },
    { id: 'wbs-p1-02', project_id: p1Id, parent_id: null, code: '2.0', name: 'الهيكل الخرساني الرئيسي', level: 1, sort_order: 2, boq_item_id: null, created_at: now },
    { id: 'wbs-p1-03', project_id: p1Id, parent_id: null, code: '3.0', name: 'الأعمال المعمارية والتشطيبات', level: 1, sort_order: 3, boq_item_id: null, created_at: now },
    { id: 'wbs-p1-04', project_id: p1Id, parent_id: null, code: '4.0', name: 'الأعمال الكهروميكانيكية (MEP)', level: 1, sort_order: 4, boq_item_id: null, created_at: now },

    // Project 2 WBS (Highway)
    { id: 'wbs-p2-01', project_id: p2Id, parent_id: null, code: '1.0', name: 'أعمال القطع والردم والتسوية (Subgrade)', level: 1, sort_order: 1, boq_item_id: null, created_at: now },
    { id: 'wbs-p2-02', project_id: p2Id, parent_id: null, code: '2.0', name: 'عبارات السيول وقنوات التصريف (Hydraulics)', level: 1, sort_order: 2, boq_item_id: null, created_at: now },
    { id: 'wbs-p2-03', project_id: p2Id, parent_id: null, code: '3.0', name: 'طبقات الأساس ورصف الإسفلت (Asphalt Paving)', level: 1, sort_order: 3, boq_item_id: null, created_at: now },
    { id: 'wbs-p2-04', project_id: p2Id, parent_id: null, code: '4.0', name: 'السلامة المرورية والإنارة الذكية (Traffic & Lighting)', level: 1, sort_order: 4, boq_item_id: null, created_at: now },

    // Project 3 WBS (Hospital)
    { id: 'wbs-p3-01', project_id: p3Id, parent_id: null, code: '1.0', name: 'الخوازيق والأساسات العميقة والعزل (Piling & Substructure)', level: 1, sort_order: 1, boq_item_id: null, created_at: now },
    { id: 'wbs-p3-02', project_id: p3Id, parent_id: null, code: '2.0', name: 'الهيكل الخرساني ومقاومة الزلازل (Superstructure)', level: 1, sort_order: 2, boq_item_id: null, created_at: now },
    { id: 'wbs-p3-03', project_id: p3Id, parent_id: null, code: '3.0', name: 'غرف العمليات والعزل الإشعاعي والتشطيبات الطبية (Cleanrooms)', level: 1, sort_order: 3, boq_item_id: null, created_at: now },
    { id: 'wbs-p3-04', project_id: p3Id, parent_id: null, code: '4.0', name: 'الغازات الطبية والتكييف HEPA والتحكم الذكي (Medical MEP)', level: 1, sort_order: 4, boq_item_id: null, created_at: now },

    // Project 4 WBS (Villas)
    { id: 'wbs-p4-01', project_id: p4Id, parent_id: null, code: '1.0', name: 'أعمال الموقع والبنية التحتية للمجمع', level: 1, sort_order: 1, boq_item_id: null, created_at: now },
    { id: 'wbs-p4-02', project_id: p4Id, parent_id: null, code: '2.0', name: 'الهياكل الإنشائية للفلل (50 وحدة)', level: 1, sort_order: 2, boq_item_id: null, created_at: now },
    { id: 'wbs-p4-03', project_id: p4Id, parent_id: null, code: '3.0', name: 'التشطيبات المعمارية والواجهات', level: 1, sort_order: 3, boq_item_id: null, created_at: now },
    { id: 'wbs-p4-04', project_id: p4Id, parent_id: null, code: '4.0', name: 'التمديدات الكهروميكانيكية والحدائق والري', level: 1, sort_order: 4, boq_item_id: null, created_at: now },
  ];

  // =========================================================================
  // 3. BOQ ITEMS FOR ALL 4 PROJECTS (Strictly Summing to Contract Values)
  // =========================================================================
  const boqItems: BoqItem[] = [
    // Project 1 BOQ (Sum = 2,345,150 SAR)
    { id: 'boq-01', project_id: p1Id, code: 'EW-001', description: 'حفريات الموقع العام ونقل المخلفات', unit: 'm3', quantity: 1200, unit_price: 35, total_price: 42000, category: 'Earthworks', section: '01 أعمال الموقع', sort_order: 1, created_at: now },
    { id: 'boq-02', project_id: p1Id, code: 'EW-002', description: 'أعمال الردم بطبقات ورش المياه والدمك', unit: 'm3', quantity: 450, unit_price: 45, total_price: 20250, category: 'Earthworks', section: '01 أعمال الموقع', sort_order: 2, created_at: now },
    { id: 'boq-03', project_id: p1Id, code: 'CW-001', description: 'خرسانة نظافة عادية أسفل القواعد', unit: 'm3', quantity: 95, unit_price: 420, total_price: 39900, category: 'Concrete Works', section: '02 الخرسانات', sort_order: 3, created_at: now },
    { id: 'boq-04', project_id: p1Id, code: 'CW-002', description: 'خرسانة مسلحة للقواعد والميد الأرضية', unit: 'm3', quantity: 280, unit_price: 680, total_price: 190400, category: 'Foundations', section: '02 الخرسانات', sort_order: 4, created_at: now },
    { id: 'boq-05', project_id: p1Id, code: 'RS-001', description: 'حديد تسليح للقواعد والأعمدة', unit: 'ton', quantity: 45, unit_price: 2950, total_price: 132750, category: 'Reinforcement Steel', section: '02 الخرسانات', sort_order: 5, created_at: now },
    { id: 'boq-06', project_id: p1Id, code: 'CW-003', description: 'خرسانة مسلحة للأعمدة والأسقف لجميع الأدوار', unit: 'm3', quantity: 650, unit_price: 720, total_price: 468000, category: 'Concrete Works', section: '02 الخرسانات', sort_order: 6, created_at: now },
    { id: 'boq-07', project_id: p1Id, code: 'MS-001', description: 'مباني بلك إسمنتي معزول وخفيف للجدران', unit: 'm2', quantity: 3200, unit_price: 95, total_price: 304000, category: 'Masonry', section: '03 المعماري', sort_order: 7, created_at: now },
    { id: 'boq-08', project_id: p1Id, code: 'RF-001', description: 'أعمال العزل المائي والحراري للأسطح', unit: 'm2', quantity: 850, unit_price: 160, total_price: 136000, category: 'Roofing & Insulation', section: '03 المعماري', sort_order: 8, created_at: now },
    { id: 'boq-09', project_id: p1Id, code: 'PL-001', description: 'أعمال اللياسة الداخلية والخارجية', unit: 'm2', quantity: 6400, unit_price: 42, total_price: 268800, category: 'Plastering', section: '03 المعماري', sort_order: 9, created_at: now },
    { id: 'boq-10', project_id: p1Id, code: 'TL-001', description: 'توريد وتركيب بورسلان وسيراميك للأرضيات', unit: 'm2', quantity: 2400, unit_price: 185, total_price: 444000, category: 'Tiling & Flooring', section: '03 المعماري', sort_order: 10, created_at: now },
    { id: 'boq-11', project_id: p1Id, code: 'EL-001', description: 'أعمال التمديدات الكهربائية واللوحات والإنارة', unit: 'point', quantity: 820, unit_price: 185, total_price: 151700, category: 'Electrical', section: '04 الكهروميكانيك', sort_order: 11, created_at: now },
    { id: 'boq-12', project_id: p1Id, code: 'HV-001', description: 'توريد وتركيب وحدات التكييف المركزي VRF', unit: 'unit', quantity: 50, unit_price: 2947, total_price: 147350, category: 'HVAC', section: '04 الكهروميكانيك', sort_order: 12, created_at: now },

    // Project 2 BOQ (Sum = 48,000,000 SAR)
    { id: 'boq-p2-01', project_id: p2Id, code: 'HWY-EW-01', description: 'حفريات صخرية وترابية ونقل المخلفات', unit: 'm3', quantity: 180000, unit_price: 25, total_price: 4500000, category: 'Earthworks', section: '01 تسوية الطريق', sort_order: 1, created_at: now },
    { id: 'boq-p2-02', project_id: p2Id, code: 'HWY-EW-02', description: 'ردم وتسوية طبقات Subgrade ورش المياه والدمك 98%', unit: 'm3', quantity: 120000, unit_price: 30, total_price: 3600000, category: 'Earthworks', section: '01 تسوية الطريق', sort_order: 2, created_at: now },
    { id: 'boq-p2-03', project_id: p2Id, code: 'HWY-CL-01', description: 'عبارات صندوقية خرسانية مسبقة الصنع ومصبوبة بالموقع', unit: 'unit', quantity: 42, unit_price: 120000, total_price: 5040000, category: 'Drainage', section: '02 شبكات السيول', sort_order: 3, created_at: now },
    { id: 'boq-p2-04', project_id: p2Id, code: 'HWY-CL-02', description: 'قنوات تصريف المياه الجانبية المبطنة بالخرسانة', unit: 'lm', quantity: 15000, unit_price: 260, total_price: 3900000, category: 'Drainage', section: '02 شبكات السيول', sort_order: 4, created_at: now },
    { id: 'boq-p2-05', project_id: p2Id, code: 'HWY-PV-01', description: 'طبقة أساس حصوي مكسر Aggregate Base Course (سمك 20 سم)', unit: 'm3', quantity: 95000, unit_price: 80, total_price: 7600000, category: 'Paving', section: '03 الرصف الإسفلتي', sort_order: 5, created_at: now },
    { id: 'boq-p2-06', project_id: p2Id, code: 'HWY-PV-02', description: 'طبقة أساس إسفلتي رابطة Bituminous Base Course (سمك 10 سم)', unit: 'ton', quantity: 65000, unit_price: 160, total_price: 10400000, category: 'Paving', section: '03 الرصف الإسفلتي', sort_order: 6, created_at: now },
    { id: 'boq-p2-07', project_id: p2Id, code: 'HWY-PV-03', description: 'طبقة سطحية إسفلتية متميزة Wearing Course (سمك 5 سم)', unit: 'ton', quantity: 42000, unit_price: 190, total_price: 7980000, category: 'Paving', section: '03 الرصف الإسفلتي', sort_order: 7, created_at: now },
    { id: 'boq-p2-08', project_id: p2Id, code: 'HWY-SF-01', description: 'حواجز خرسانية نيوجيرسي وحواجز أمان معدنية وحماية جسور', unit: 'lm', quantity: 15000, unit_price: 160, total_price: 2400000, category: 'Safety', section: '04 السلامة والإنارة', sort_order: 8, created_at: now },
    { id: 'boq-p2-09', project_id: p2Id, code: 'HWY-LT-01', description: 'أعمدة إنارة ذكية وشبكة التغذية الكهربائية والمحولات', unit: 'pole', quantity: 350, unit_price: 4200, total_price: 1470000, category: 'Lighting', section: '04 السلامة والإنارة', sort_order: 9, created_at: now },
    { id: 'boq-p2-10', project_id: p2Id, code: 'HWY-SG-01', description: 'دهانات الطرق الحرارية واللوحات الإرشادية العلوية المتطورة', unit: 'lot', quantity: 1, unit_price: 1110000, total_price: 1110000, category: 'Signage', section: '04 السلامة والإنارة', sort_order: 10, created_at: now },

    // Project 3 BOQ (Sum = 125,000,000 SAR)
    { id: 'boq-p3-01', project_id: p3Id, code: 'HSP-PL-01', description: 'خوازيق حفر مستمر عميقة CFA Piles قطر 80 سم وعمق 24 م', unit: 'pile', quantity: 650, unit_price: 18000, total_price: 11700000, category: 'Piling', section: '01 الأساسات العميقة', sort_order: 1, created_at: now },
    { id: 'boq-p3-02', project_id: p3Id, code: 'HSP-FD-01', description: 'لبشة خرسانية مسلحة عازلة للمياه سمك 150 سم', unit: 'm3', quantity: 12000, unit_price: 850, total_price: 10200000, category: 'Foundations', section: '01 الأساسات العميقة', sort_order: 2, created_at: now },
    { id: 'boq-p3-03', project_id: p3Id, code: 'HSP-ST-01', description: 'هيكل خرساني مسلح للأدوار المتكررة ومقاومة الزلازل', unit: 'm3', quantity: 28000, unit_price: 920, total_price: 25760000, category: 'Structure', section: '02 الهيكل الخرساني', sort_order: 3, created_at: now },
    { id: 'boq-p3-04', project_id: p3Id, code: 'HSP-RD-01', description: 'جدران وأبواب عزل إشعاعي لغرف الأشعة والطب النووي', unit: 'm2', quantity: 1800, unit_price: 2500, total_price: 4500000, category: 'Radiation Shielding', section: '03 التشطيبات الطبية', sort_order: 4, created_at: now },
    { id: 'boq-p3-05', project_id: p3Id, code: 'HSP-OR-01', description: 'غرف عمليات جراحية معقمة نموذجية بنظام الضغط الموجب Modular ORs', unit: 'room', quantity: 8, unit_price: 2850000, total_price: 22800000, category: 'Cleanrooms', section: '03 التشطيبات الطبية', sort_order: 5, created_at: now },
    { id: 'boq-p3-06', project_id: p3Id, code: 'HSP-FL-01', description: 'أرضيات فينيل موصلة ومضادة للبكتيريا والكهرباء الاستاتيكية', unit: 'm2', quantity: 18000, unit_price: 320, total_price: 5760000, category: 'Flooring', section: '03 التشطيبات الطبية', sort_order: 6, created_at: now },
    { id: 'boq-p3-07', project_id: p3Id, code: 'HSP-MG-01', description: 'شبكة ومحطة توريد وتوزيع الغازات الطبية المركزية', unit: 'system', quantity: 1, unit_price: 14800000, total_price: 14800000, category: 'Medical Gases', section: '04 الكهروميكانيك الطبي', sort_order: 7, created_at: now },
    { id: 'boq-p3-08', project_id: p3Id, code: 'HSP-HV-01', description: 'وحدات مناولة هواء طبية مع فلاتر HEPA والتبريد المركزي', unit: 'lot', quantity: 1, unit_price: 16500000, total_price: 16500000, category: 'HVAC', section: '04 الكهروميكانيك الطبي', sort_order: 8, created_at: now },
    { id: 'boq-p3-09', project_id: p3Id, code: 'HSP-BM-01', description: 'نظام إدارة وتحكم المبنى الذكي BMS وأنظمة الأمان الطبي', unit: 'lot', quantity: 1, unit_price: 7200000, total_price: 7200000, category: 'BMS', section: '04 الكهروميكانيك الطبي', sort_order: 9, created_at: now },
    { id: 'boq-p3-10', project_id: p3Id, code: 'HSP-EL-01', description: 'محطات التحويل والمولدات الاحتياطية وأنظمة UPS وتأريض غرف العمليات', unit: 'lot', quantity: 1, unit_price: 5780000, total_price: 5780000, category: 'Electrical', section: '04 الكهروميكانيك الطبي', sort_order: 10, created_at: now },

    // Project 4 BOQ (Sum = 32,500,000 SAR)
    { id: 'boq-p4-01', project_id: p4Id, code: 'VIL-EW-01', description: 'حفريات وتسوية الموقع العام وشبكات البنية التحتية للمجمع', unit: 'm3', quantity: 45000, unit_price: 40, total_price: 1800000, category: 'Earthworks', section: '01 الموقع والبنية التحتية', sort_order: 1, created_at: now },
    { id: 'boq-p4-02', project_id: p4Id, code: 'VIL-CW-01', description: 'خرسانات مسلحة للقواعد والميد الأرضية للفلل (50 فيلا)', unit: 'm3', quantity: 7500, unit_price: 750, total_price: 5625000, category: 'Foundations', section: '02 الهياكل الخرسانية', sort_order: 2, created_at: now },
    { id: 'boq-p4-03', project_id: p4Id, code: 'VIL-CW-02', description: 'خرسانات مسلحة للأعمدة والأسقف والواجهات للفلل', unit: 'm3', quantity: 12500, unit_price: 820, total_price: 10250000, category: 'Structure', section: '02 الهياكل الخرسانية', sort_order: 3, created_at: now },
    { id: 'boq-p4-04', project_id: p4Id, code: 'VIL-MS-01', description: 'مباني بلك وعوازل حرارية ومائية متقدمة للأسطح والجدران', unit: 'm2', quantity: 38000, unit_price: 110, total_price: 4180000, category: 'Masonry', section: '03 المعماري والواجهات', sort_order: 4, created_at: now },
    { id: 'boq-p4-05', project_id: p4Id, code: 'VIL-FN-01', description: 'أعمال التشطيبات الداخلية والرخام والأبواب والنوافذ الزجاجية', unit: 'villa', quantity: 50, unit_price: 98000, total_price: 4900000, category: 'Finishes', section: '03 المعماري والواجهات', sort_order: 5, created_at: now },
    { id: 'boq-p4-06', project_id: p4Id, code: 'VIL-ME-01', description: 'التمديدات الكهربائية والصحية وشبكات المياه والصرف لكل فيلا', unit: 'villa', quantity: 50, unit_price: 45000, total_price: 2250000, category: 'MEP', section: '04 الكهروميكانيك والموقع', sort_order: 6, created_at: now },
    { id: 'boq-p4-07', project_id: p4Id, code: 'VIL-HV-01', description: 'توريد وتركيب أنظمة التكييف المخفي وتوزيع الدكت', unit: 'villa', quantity: 50, unit_price: 42000, total_price: 2100000, category: 'HVAC', section: '04 الكهروميكانيك والموقع', sort_order: 7, created_at: now },
    { id: 'boq-p4-08', project_id: p4Id, code: 'VIL-LS-01', description: 'أعمال الحدائق والممرات وشبكات الري الأوتوماتيكية والإنارة التجميلية', unit: 'lot', quantity: 1, unit_price: 1395000, total_price: 1395000, category: 'Landscape', section: '04 الكهروميكانيك والموقع', sort_order: 8, created_at: now },
  ];

  // =========================================================================
  // 4. CPM ACTIVITIES FOR ALL 4 PROJECTS (Disciplined & Chronologically Valid)
  // =========================================================================
  const activities: Activity[] = [
    // Project 1 Activities (Commercial Building: Start 2026-07-01 -> End 2027-02-28 | Data Date 2026-09-13)
    { id: 'act-01', project_id: p1Id, code: 'ACT-001', name: 'أعمال الحفر وتسوية منسوب التأسيس', duration_days: 12, early_start: '2026-07-01', early_finish: '2026-07-13', late_start: '2026-07-01', late_finish: '2026-07-13', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 1, wbs_node_id: 'wbs-p1-01', planned_quantity: 1200, actual_quantity: 1200, unit: 'm3', actual_start: '2026-07-01', actual_finish: '2026-07-13', calendar_id: 'cal-01', created_at: now },
    { id: 'act-02', project_id: p1Id, code: 'ACT-002', name: 'صب خرسانة النظافة أسفل القواعد', duration_days: 8, early_start: '2026-07-14', early_finish: '2026-07-22', late_start: '2026-07-14', late_finish: '2026-07-22', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 2, wbs_node_id: 'wbs-p1-01', planned_quantity: 95, actual_quantity: 95, unit: 'm3', actual_start: '2026-07-14', actual_finish: '2026-07-22', calendar_id: 'cal-01', created_at: now },
    { id: 'act-03', project_id: p1Id, code: 'ACT-003', name: 'حدادة ونجارة وصب القواعد المسلحة والميد', duration_days: 20, early_start: '2026-07-23', early_finish: '2026-08-14', late_start: '2026-07-23', late_finish: '2026-08-14', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 3, wbs_node_id: 'wbs-p1-01', planned_quantity: 280, actual_quantity: 280, unit: 'm3', actual_start: '2026-07-23', actual_finish: '2026-08-14', calendar_id: 'cal-01', created_at: now },
    { id: 'act-04', project_id: p1Id, code: 'ACT-004', name: 'عزل القواعد والردم الهندسي حول الأساسات', duration_days: 10, early_start: '2026-08-15', early_finish: '2026-08-25', late_start: '2026-08-20', late_finish: '2026-08-30', total_float: 5, free_float: 5, percent_complete: 100, is_critical: false, is_milestone: false, sort_order: 4, wbs_node_id: 'wbs-p1-01', planned_quantity: 450, actual_quantity: 450, unit: 'm3', actual_start: '2026-08-15', actual_finish: '2026-08-25', calendar_id: 'cal-01', created_at: now },
    { id: 'act-05', project_id: p1Id, code: 'ACT-005', name: 'أعمدة وسقف الدور الأرضي', duration_days: 22, early_start: '2026-08-26', early_finish: '2026-09-19', late_start: '2026-08-26', late_finish: '2026-09-19', total_float: 0, free_float: 0, percent_complete: 70, is_critical: true, is_milestone: false, sort_order: 5, wbs_node_id: 'wbs-p1-02', planned_quantity: 160, actual_quantity: 112, unit: 'm3', actual_start: '2026-08-26', actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-06', project_id: p1Id, code: 'ACT-006', name: 'أعمدة وأسقف الأدوار المتكررة (1-4)', duration_days: 45, early_start: '2026-09-20', early_finish: '2026-11-08', late_start: '2026-09-20', late_finish: '2026-11-08', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 6, wbs_node_id: 'wbs-p1-02', planned_quantity: 490, actual_quantity: 0, unit: 'm3', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-07', project_id: p1Id, code: 'ACT-007', name: 'أعمال المباني والعوازل الخارجية', duration_days: 30, early_start: '2026-10-01', early_finish: '2026-11-04', late_start: '2026-10-06', late_finish: '2026-11-09', total_float: 5, free_float: 0, percent_complete: 0, is_critical: false, is_milestone: false, sort_order: 7, wbs_node_id: 'wbs-p1-03', planned_quantity: 3200, actual_quantity: 0, unit: 'm2', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-08', project_id: p1Id, code: 'ACT-008', name: 'تمديدات الكهرباء والتكييف الأولية (Rough-in)', duration_days: 30, early_start: '2026-11-09', early_finish: '2026-12-12', late_start: '2026-11-09', late_finish: '2026-12-12', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 8, wbs_node_id: 'wbs-p1-04', planned_quantity: 820, actual_quantity: 0, unit: 'point', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-09', project_id: p1Id, code: 'ACT-009', name: 'أعمال اللياسة الداخلية وتركيب البورسلان', duration_days: 40, early_start: '2026-12-13', early_finish: '2027-01-27', late_start: '2026-12-13', late_finish: '2027-01-27', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 9, wbs_node_id: 'wbs-p1-03', planned_quantity: 2400, actual_quantity: 0, unit: 'm2', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-10', project_id: p1Id, code: 'ACT-010', name: 'تركيب وحدات التكييف والإنارة والاختبارات', duration_days: 25, early_start: '2027-01-28', early_finish: '2027-02-25', late_start: '2027-01-28', late_finish: '2027-02-25', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 10, wbs_node_id: 'wbs-p1-04', planned_quantity: 50, actual_quantity: 0, unit: 'unit', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-11', project_id: p1Id, code: 'ACT-011', name: 'التسليم الابتدائي للمشروع (Handover)', duration_days: 0, early_start: '2027-02-28', early_finish: '2027-02-28', late_start: '2027-02-28', late_finish: '2027-02-28', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: true, sort_order: 11, wbs_node_id: null, planned_quantity: 0, actual_quantity: 0, unit: '', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },

    // Project 2 Activities (Highway & Drainage: Start 2026-06-01 -> End 2027-10-30 | Data Date 2026-09-13)
    { id: 'act-p2-01', project_id: p2Id, code: 'HWY-01', name: 'المسح الطبوغرافي ونقل الخدمات المعترضة', duration_days: 30, early_start: '2026-06-01', early_finish: '2026-07-04', late_start: '2026-06-01', late_finish: '2026-07-04', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 1, wbs_node_id: 'wbs-p2-01', planned_quantity: 15, actual_quantity: 15, unit: 'km', actual_start: '2026-06-01', actual_finish: '2026-07-04', calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-02', project_id: p2Id, code: 'HWY-02', name: 'أعمال القطع الصخري والترابي ونقل المخلفات', duration_days: 45, early_start: '2026-07-05', early_finish: '2026-08-23', late_start: '2026-07-05', late_finish: '2026-08-23', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 2, wbs_node_id: 'wbs-p2-01', planned_quantity: 180000, actual_quantity: 180000, unit: 'm3', actual_start: '2026-07-05', actual_finish: '2026-08-23', calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-03', project_id: p2Id, code: 'HWY-03', name: 'تنفيذ العبارات الخرسانية الصندوقية لتصريف السيول', duration_days: 40, early_start: '2026-08-10', early_finish: '2026-09-24', late_start: '2026-08-15', late_finish: '2026-09-29', total_float: 5, free_float: 0, percent_complete: 65, is_critical: false, is_milestone: false, sort_order: 3, wbs_node_id: 'wbs-p2-02', planned_quantity: 42, actual_quantity: 27, unit: 'unit', actual_start: '2026-08-10', actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-04', project_id: p2Id, code: 'HWY-04', name: 'ردم وتسوية طبقات Subgrade والدمك 98%', duration_days: 45, early_start: '2026-09-25', early_finish: '2026-11-14', late_start: '2026-09-25', late_finish: '2026-11-14', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 4, wbs_node_id: 'wbs-p2-01', planned_quantity: 120000, actual_quantity: 0, unit: 'm3', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-05', project_id: p2Id, code: 'HWY-05', name: 'فرش ودمك طبقة الأساس الحصوي المكسر (Aggregate Base)', duration_days: 55, early_start: '2026-11-15', early_finish: '2027-01-16', late_start: '2026-11-15', late_finish: '2027-01-16', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 5, wbs_node_id: 'wbs-p2-03', planned_quantity: 95000, actual_quantity: 0, unit: 'm3', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-06', project_id: p2Id, code: 'HWY-06', name: 'رصف طبقة الإسفلت الرابطة والسطحية (Asphalt Paving)', duration_days: 75, early_start: '2027-01-17', early_finish: '2027-04-12', late_start: '2027-01-17', late_finish: '2027-04-12', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 6, wbs_node_id: 'wbs-p2-03', planned_quantity: 107000, actual_quantity: 0, unit: 'ton', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-07', project_id: p2Id, code: 'HWY-07', name: 'تركيب الحواجز الخرسانية نيوجيرسي وحواجز الأمان', duration_days: 45, early_start: '2027-04-13', early_finish: '2027-06-02', late_start: '2027-04-20', late_finish: '2027-06-09', total_float: 7, free_float: 0, percent_complete: 0, is_critical: false, is_milestone: false, sort_order: 7, wbs_node_id: 'wbs-p2-04', planned_quantity: 15000, actual_quantity: 0, unit: 'lm', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-08', project_id: p2Id, code: 'HWY-08', name: 'أعمال شبكة الإنارة الذكية والمحولات واللوحات الإرشادية', duration_days: 60, early_start: '2027-06-03', early_finish: '2027-08-10', late_start: '2027-06-03', late_finish: '2027-08-10', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 8, wbs_node_id: 'wbs-p2-04', planned_quantity: 350, actual_quantity: 0, unit: 'pole', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-09', project_id: p2Id, code: 'HWY-09', name: 'تخطيط ودهانات المسارات والعواكس والاختبارات النهائية', duration_days: 40, early_start: '2027-08-11', early_finish: '2027-09-26', late_start: '2027-08-11', late_finish: '2027-09-26', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 9, wbs_node_id: 'wbs-p2-04', planned_quantity: 1, actual_quantity: 0, unit: 'lot', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p2-10', project_id: p2Id, code: 'HWY-10', name: 'افتتاح وتدشين الطريق السريع (Highway Commissioning)', duration_days: 0, early_start: '2027-10-30', early_finish: '2027-10-30', late_start: '2027-10-30', late_finish: '2027-10-30', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: true, sort_order: 10, wbs_node_id: null, planned_quantity: 0, actual_quantity: 0, unit: '', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },

    // Project 3 Activities (Hospital 200 Beds: Start 2026-05-01 -> End 2028-02-28 | Data Date 2026-09-13)
    { id: 'act-p3-01', project_id: p3Id, code: 'HSP-01', name: 'أعمال الحفر العميق ونزح المياه الجوفية', duration_days: 45, early_start: '2026-05-01', early_finish: '2026-06-20', late_start: '2026-05-01', late_finish: '2026-06-20', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 1, wbs_node_id: 'wbs-p3-01', planned_quantity: 65000, actual_quantity: 65000, unit: 'm3', actual_start: '2026-05-01', actual_finish: '2026-06-20', calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-02', project_id: p3Id, code: 'HSP-02', name: 'حفر وتثبيت الخوازيق العميقة CFA Piles (650 خازوق)', duration_days: 55, early_start: '2026-06-21', early_finish: '2026-08-22', late_start: '2026-06-21', late_finish: '2026-08-22', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 2, wbs_node_id: 'wbs-p3-01', planned_quantity: 650, actual_quantity: 650, unit: 'pile', actual_start: '2026-06-21', actual_finish: '2026-08-22', calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-03', project_id: p3Id, code: 'HSP-03', name: 'صب اللبشة الخرسانية المسلحة والعزل المائي المحكم', duration_days: 35, early_start: '2026-08-23', early_finish: '2026-10-02', late_start: '2026-08-23', late_finish: '2026-10-02', total_float: 0, free_float: 0, percent_complete: 60, is_critical: true, is_milestone: false, sort_order: 3, wbs_node_id: 'wbs-p3-01', planned_quantity: 12000, actual_quantity: 7200, unit: 'm3', actual_start: '2026-08-23', actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-04', project_id: p3Id, code: 'HSP-04', name: 'الهيكل الخرساني للأدوار المتكررة وقبو الأشعة (8 طوابق)', duration_days: 140, early_start: '2026-10-03', early_finish: '2027-03-15', late_start: '2026-10-03', late_finish: '2027-03-15', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 4, wbs_node_id: 'wbs-p3-02', planned_quantity: 28000, actual_quantity: 0, unit: 'm3', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-05', project_id: p3Id, code: 'HSP-05', name: 'عزل غرف الأشعة والطب النووي بالرصاص والأبواب المصفحة', duration_days: 50, early_start: '2027-02-15', early_finish: '2027-04-15', late_start: '2027-02-25', late_finish: '2027-04-25', total_float: 8, free_float: 0, percent_complete: 0, is_critical: false, is_milestone: false, sort_order: 5, wbs_node_id: 'wbs-p3-03', planned_quantity: 1800, actual_quantity: 0, unit: 'm2', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-06', project_id: p3Id, code: 'HSP-06', name: 'شبكات الغازات الطبية المركزية وغرف الطوارئ', duration_days: 70, early_start: '2027-04-16', early_finish: '2027-07-05', late_start: '2027-04-16', late_finish: '2027-07-05', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 6, wbs_node_id: 'wbs-p3-04', planned_quantity: 1, actual_quantity: 0, unit: 'system', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-07', project_id: p3Id, code: 'HSP-07', name: 'تنفيذ وتجهيز 8 غرف عمليات جراحية معقمة Modular ORs', duration_days: 90, early_start: '2027-07-06', early_finish: '2027-10-20', late_start: '2027-07-06', late_finish: '2027-10-20', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 7, wbs_node_id: 'wbs-p3-03', planned_quantity: 8, actual_quantity: 0, unit: 'room', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-08', project_id: p3Id, code: 'HSP-08', name: 'أنظمة التكييف الطبي وفلاتر HEPA والتحكم بالضغط BMS', duration_days: 80, early_start: '2027-09-01', early_finish: '2027-12-05', late_start: '2027-09-01', late_finish: '2027-12-05', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 8, wbs_node_id: 'wbs-p3-04', planned_quantity: 1, actual_quantity: 0, unit: 'lot', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-09', project_id: p3Id, code: 'HSP-09', name: 'التشطيبات الطبية والتعقيم واختبارات الجودة CBAHI', duration_days: 60, early_start: '2027-12-06', early_finish: '2028-02-15', late_start: '2027-12-06', late_finish: '2028-02-15', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 9, wbs_node_id: 'wbs-p3-03', planned_quantity: 18000, actual_quantity: 0, unit: 'm2', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p3-10', project_id: p3Id, code: 'HSP-10', name: 'الاستلام والاعتماد الطبي النهائي للمستشفى', duration_days: 0, early_start: '2028-02-28', early_finish: '2028-02-28', late_start: '2028-02-28', late_finish: '2028-02-28', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: true, sort_order: 10, wbs_node_id: null, planned_quantity: 0, actual_quantity: 0, unit: '', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },

    // Project 4 Activities (Residential Villas 50 Units: Start 2026-06-15 -> End 2027-08-30 | Data Date 2026-09-13)
    { id: 'act-p4-01', project_id: p4Id, code: 'VIL-01', name: 'أعمال الموقع العام والتسوية وشبكات البنية التحتية', duration_days: 45, early_start: '2026-06-15', early_finish: '2026-08-04', late_start: '2026-06-15', late_finish: '2026-08-04', total_float: 0, free_float: 0, percent_complete: 100, is_critical: true, is_milestone: false, sort_order: 1, wbs_node_id: 'wbs-p4-01', planned_quantity: 45000, actual_quantity: 45000, unit: 'm3', actual_start: '2026-06-15', actual_finish: '2026-08-04', calendar_id: 'cal-01', created_at: now },
    { id: 'act-p4-02', project_id: p4Id, code: 'VIL-02', name: 'صب القواعد الخرسانية والميد والرقاب لـ 50 فيلا', duration_days: 45, early_start: '2026-08-05', early_finish: '2026-09-24', late_start: '2026-08-05', late_finish: '2026-09-24', total_float: 0, free_float: 0, percent_complete: 75, is_critical: true, is_milestone: false, sort_order: 2, wbs_node_id: 'wbs-p4-02', planned_quantity: 7500, actual_quantity: 5625, unit: 'm3', actual_start: '2026-08-05', actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p4-03', project_id: p4Id, code: 'VIL-03', name: 'الهياكل الإنشائية وأعمدة وأسقف الطوابق (50 فيلا)', duration_days: 90, early_start: '2026-09-25', early_finish: '2027-01-08', late_start: '2026-09-25', late_finish: '2027-01-08', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 3, wbs_node_id: 'wbs-p4-02', planned_quantity: 12500, actual_quantity: 0, unit: 'm3', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p4-04', project_id: p4Id, code: 'VIL-04', name: 'أعمال البلوك والعزل الحراري المزدوج للواجهات', duration_days: 50, early_start: '2027-01-09', early_finish: '2027-03-08', late_start: '2027-01-15', late_finish: '2027-03-14', total_float: 5, free_float: 0, percent_complete: 0, is_critical: false, is_milestone: false, sort_order: 4, wbs_node_id: 'wbs-p4-03', planned_quantity: 38000, actual_quantity: 0, unit: 'm2', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p4-05', project_id: p4Id, code: 'VIL-05', name: 'التمديدات الكهربائية والصحية وشبكات التكييف المخفي', duration_days: 60, early_start: '2027-03-09', early_finish: '2027-05-18', late_start: '2027-03-09', late_finish: '2027-05-18', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 5, wbs_node_id: 'wbs-p4-04', planned_quantity: 50, actual_quantity: 0, unit: 'villa', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p4-06', project_id: p4Id, code: 'VIL-06', name: 'التشطيبات الفاخرة والرخام والدهانات والواجهات', duration_days: 75, early_start: '2027-05-19', early_finish: '2027-08-10', late_start: '2027-05-19', late_finish: '2027-08-10', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: false, sort_order: 6, wbs_node_id: 'wbs-p4-03', planned_quantity: 50, actual_quantity: 0, unit: 'villa', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p4-07', project_id: p4Id, code: 'VIL-07', name: 'تنسيق الحدائق والممرات وشبكات الري والإنارة التجميلية', duration_days: 35, early_start: '2027-07-15', early_finish: '2027-08-25', late_start: '2027-07-20', late_finish: '2027-08-30', total_float: 4, free_float: 0, percent_complete: 0, is_critical: false, is_milestone: false, sort_order: 7, wbs_node_id: 'wbs-p4-04', planned_quantity: 1, actual_quantity: 0, unit: 'lot', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
    { id: 'act-p4-08', project_id: p4Id, code: 'VIL-08', name: 'تسليم الفلل السكنية للمطور العقاري', duration_days: 0, early_start: '2027-08-30', early_finish: '2027-08-30', late_start: '2027-08-30', late_finish: '2027-08-30', total_float: 0, free_float: 0, percent_complete: 0, is_critical: true, is_milestone: true, sort_order: 8, wbs_node_id: null, planned_quantity: 0, actual_quantity: 0, unit: '', actual_start: null, actual_finish: null, calendar_id: 'cal-01', created_at: now },
  ];

  // =========================================================================
  // 5. ACTIVITY LOGIC LINKS (DCMA 14-Point Compliant)
  // =========================================================================
  const activityLinks: ActivityLink[] = [
    // Project 1 Links
    { id: 'lnk-01', project_id: p1Id, predecessor_id: 'act-01', successor_id: 'act-02', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-02', project_id: p1Id, predecessor_id: 'act-02', successor_id: 'act-03', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-03', project_id: p1Id, predecessor_id: 'act-03', successor_id: 'act-04', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-04', project_id: p1Id, predecessor_id: 'act-03', successor_id: 'act-05', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-05', project_id: p1Id, predecessor_id: 'act-05', successor_id: 'act-06', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-06', project_id: p1Id, predecessor_id: 'act-05', successor_id: 'act-07', link_type: 'SS', lag_days: 10 },
    { id: 'lnk-07', project_id: p1Id, predecessor_id: 'act-06', successor_id: 'act-08', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-08', project_id: p1Id, predecessor_id: 'act-08', successor_id: 'act-09', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-09', project_id: p1Id, predecessor_id: 'act-09', successor_id: 'act-10', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-10', project_id: p1Id, predecessor_id: 'act-10', successor_id: 'act-11', link_type: 'FS', lag_days: 0 },

    // Project 2 Links (Highway)
    { id: 'lnk-p2-01', project_id: p2Id, predecessor_id: 'act-p2-01', successor_id: 'act-p2-02', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p2-02', project_id: p2Id, predecessor_id: 'act-p2-02', successor_id: 'act-p2-03', link_type: 'SS', lag_days: 15 },
    { id: 'lnk-p2-03', project_id: p2Id, predecessor_id: 'act-p2-02', successor_id: 'act-p2-04', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p2-04', project_id: p2Id, predecessor_id: 'act-p2-04', successor_id: 'act-p2-05', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p2-05', project_id: p2Id, predecessor_id: 'act-p2-05', successor_id: 'act-p2-06', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p2-06', project_id: p2Id, predecessor_id: 'act-p2-06', successor_id: 'act-p2-07', link_type: 'SS', lag_days: 20 },
    { id: 'lnk-p2-07', project_id: p2Id, predecessor_id: 'act-p2-06', successor_id: 'act-p2-08', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p2-08', project_id: p2Id, predecessor_id: 'act-p2-08', successor_id: 'act-p2-09', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p2-09', project_id: p2Id, predecessor_id: 'act-p2-09', successor_id: 'act-p2-10', link_type: 'FS', lag_days: 0 },

    // Project 3 Links (Hospital)
    { id: 'lnk-p3-01', project_id: p3Id, predecessor_id: 'act-p3-01', successor_id: 'act-p3-02', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p3-02', project_id: p3Id, predecessor_id: 'act-p3-02', successor_id: 'act-p3-03', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p3-03', project_id: p3Id, predecessor_id: 'act-p3-03', successor_id: 'act-p3-04', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p3-04', project_id: p3Id, predecessor_id: 'act-p3-04', successor_id: 'act-p3-05', link_type: 'SS', lag_days: 30 },
    { id: 'lnk-p3-05', project_id: p3Id, predecessor_id: 'act-p3-04', successor_id: 'act-p3-06', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p3-06', project_id: p3Id, predecessor_id: 'act-p3-06', successor_id: 'act-p3-07', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p3-07', project_id: p3Id, predecessor_id: 'act-p3-07', successor_id: 'act-p3-08', link_type: 'SS', lag_days: 10 },
    { id: 'lnk-p3-08', project_id: p3Id, predecessor_id: 'act-p3-08', successor_id: 'act-p3-09', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p3-09', project_id: p3Id, predecessor_id: 'act-p3-09', successor_id: 'act-p3-10', link_type: 'FS', lag_days: 0 },

    // Project 4 Links (Villas)
    { id: 'lnk-p4-01', project_id: p4Id, predecessor_id: 'act-p4-01', successor_id: 'act-p4-02', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p4-02', project_id: p4Id, predecessor_id: 'act-p4-02', successor_id: 'act-p4-03', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p4-03', project_id: p4Id, predecessor_id: 'act-p4-03', successor_id: 'act-p4-04', link_type: 'SS', lag_days: 20 },
    { id: 'lnk-p4-04', project_id: p4Id, predecessor_id: 'act-p4-03', successor_id: 'act-p4-05', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p4-05', project_id: p4Id, predecessor_id: 'act-p4-05', successor_id: 'act-p4-06', link_type: 'FS', lag_days: 0 },
    { id: 'lnk-p4-06', project_id: p4Id, predecessor_id: 'act-p4-06', successor_id: 'act-p4-07', link_type: 'SS', lag_days: 15 },
    { id: 'lnk-p4-07', project_id: p4Id, predecessor_id: 'act-p4-06', successor_id: 'act-p4-08', link_type: 'FS', lag_days: 0 },
  ];

  // =========================================================================
  // 6. RESOURCES & ALLOCATIONS
  // =========================================================================
  const resources: Resource[] = [
    { id: 'res-01', project_id: p1Id, name: 'فريق الحفر والآليات الثقيلة', type: 'equipment', unit: 'يومية', unit_rate: 3500, availability: 2, ownership: 'rental', created_at: now },
    { id: 'res-02', project_id: p1Id, name: 'طاقم نجارة وحدادة مسلحة', type: 'labor', unit: 'طاقم/يوم', unit_rate: 2200, availability: 4, ownership: 'company', created_at: now },
    { id: 'res-03', project_id: p1Id, name: 'مضخة خرسانة وخلاطات', type: 'equipment', unit: 'm3', unit_rate: 45, availability: 1, ownership: 'subcontractor', created_at: now },
    { id: 'res-04', project_id: p1Id, name: 'طاقم مباني ولياسة معمارية', type: 'labor', unit: 'طاقم/يوم', unit_rate: 1800, availability: 3, ownership: 'company', created_at: now },
    { id: 'res-05', project_id: p1Id, name: 'فنيو كهروميكانيك وتكييف', type: 'labor', unit: 'يومية', unit_rate: 650, availability: 6, ownership: 'company', created_at: now },
  ];

  const activityResources: ActivityResource[] = [
    { id: 'ar-01', project_id: p1Id, activity_id: 'act-01', resource_id: 'res-01', planned_quantity: 12, actual_quantity: 12, created_at: now },
    { id: 'ar-02', project_id: p1Id, activity_id: 'act-02', resource_id: 'res-02', planned_quantity: 8, actual_quantity: 8, created_at: now },
    { id: 'ar-03', project_id: p1Id, activity_id: 'act-03', resource_id: 'res-02', planned_quantity: 20, actual_quantity: 20, created_at: now },
    { id: 'ar-04', project_id: p1Id, activity_id: 'act-05', resource_id: 'res-02', planned_quantity: 22, actual_quantity: 15, created_at: now },
    { id: 'ar-05', project_id: p1Id, activity_id: 'act-07', resource_id: 'res-04', planned_quantity: 30, actual_quantity: 0, created_at: now },
    { id: 'ar-06', project_id: p1Id, activity_id: 'act-08', resource_id: 'res-05', planned_quantity: 30, actual_quantity: 0, created_at: now },
  ];

  // =========================================================================
  // 7. CBS BUDGET LINES (Matching Project BAC 100%)
  // =========================================================================
  const budgetLines: BudgetLine[] = [
    // Project 1 Budget Lines (Total = 2,345,150 SAR)
    { id: 'bgt-p1-01', project_id: p1Id, wbs_node_id: 'wbs-p1-01', boq_item_id: 'boq-01', description: 'أعمال الحفريات ونقل المخلفات', planned_cost: 42000, committed_cost: 42000, actual_cost: 40500, remaining_cost: 1500, created_at: now },
    { id: 'bgt-p1-02', project_id: p1Id, wbs_node_id: 'wbs-p1-01', boq_item_id: 'boq-03', description: 'خرسانات النظافة والقواعد والميد والردم', planned_cost: 383300, committed_cost: 383300, actual_cost: 369400, remaining_cost: 13900, created_at: now },
    { id: 'bgt-p1-03', project_id: p1Id, wbs_node_id: 'wbs-p1-02', boq_item_id: 'boq-06', description: 'الهيكل الخرساني والحديد للأدوار المتكررة', planned_cost: 468000, committed_cost: 400000, actual_cost: 280000, remaining_cost: 188000, created_at: now },
    { id: 'bgt-p1-04', project_id: p1Id, wbs_node_id: 'wbs-p1-03', boq_item_id: 'boq-07', description: 'المباني واللياسة والعزل والتشطيبات', planned_cost: 1152800, committed_cost: 500000, actual_cost: 0, remaining_cost: 1152800, created_at: now },
    { id: 'bgt-p1-05', project_id: p1Id, wbs_node_id: 'wbs-p1-04', boq_item_id: 'boq-11', description: 'أنظمة الكهروميكانيك والتكييف والإنارة', planned_cost: 299050, committed_cost: 150000, actual_cost: 0, remaining_cost: 299050, created_at: now },

    // Project 2 Budget Lines (Total = 48,000,000 SAR)
    { id: 'bgt-p2-01', project_id: p2Id, wbs_node_id: 'wbs-p2-01', boq_item_id: 'boq-p2-01', description: 'أعمال القطع والردم والتسوية', planned_cost: 8100000, committed_cost: 8100000, actual_cost: 7200000, remaining_cost: 900000, created_at: now },
    { id: 'bgt-p2-02', project_id: p2Id, wbs_node_id: 'wbs-p2-02', boq_item_id: 'boq-p2-03', description: 'عبارات السيول وقنوات التصريف', planned_cost: 8940000, committed_cost: 8500000, actual_cost: 6000000, remaining_cost: 2940000, created_at: now },
    { id: 'bgt-p2-03', project_id: p2Id, wbs_node_id: 'wbs-p2-03', boq_item_id: 'boq-p2-05', description: 'طبقات الأساس الحصوي ورصف الإسفلت', planned_cost: 25980000, committed_cost: 20000000, actual_cost: 0, remaining_cost: 25980000, created_at: now },
    { id: 'bgt-p2-04', project_id: p2Id, wbs_node_id: 'wbs-p2-04', boq_item_id: 'boq-p2-08', description: 'السلامة المرورية والإنارة واللوحات', planned_cost: 4980000, committed_cost: 2500000, actual_cost: 0, remaining_cost: 4980000, created_at: now },

    // Project 3 Budget Lines (Total = 125,000,000 SAR)
    { id: 'bgt-p3-01', project_id: p3Id, wbs_node_id: 'wbs-p3-01', boq_item_id: 'boq-p3-01', description: 'الأساسات العميقة والخوازيق واللبشة المسلحة', planned_cost: 21900000, committed_cost: 21900000, actual_cost: 24320000, remaining_cost: 0, created_at: now },
    { id: 'bgt-p3-02', project_id: p3Id, wbs_node_id: 'wbs-p3-02', boq_item_id: 'boq-p3-03', description: 'الهيكل الخرساني ومقاومة الزلازل', planned_cost: 25760000, committed_cost: 25000000, actual_cost: 0, remaining_cost: 25760000, created_at: now },
    { id: 'bgt-p3-03', project_id: p3Id, wbs_node_id: 'wbs-p3-03', boq_item_id: 'boq-p3-05', description: 'غرف العمليات المعقمة والتشطيبات الطبية', planned_cost: 33060000, committed_cost: 15000000, actual_cost: 0, remaining_cost: 33060000, created_at: now },
    { id: 'bgt-p3-04', project_id: p3Id, wbs_node_id: 'wbs-p3-04', boq_item_id: 'boq-p3-07', description: 'الغازات الطبية والتكييف HEPA و BMS', planned_cost: 44280000, committed_cost: 20000000, actual_cost: 0, remaining_cost: 44280000, created_at: now },

    // Project 4 Budget Lines (Total = 32,500,000 SAR)
    { id: 'bgt-p4-01', project_id: p4Id, wbs_node_id: 'wbs-p4-01', boq_item_id: 'boq-p4-01', description: 'أعمال الموقع والبنية التحتية', planned_cost: 1800000, committed_cost: 1800000, actual_cost: 1750000, remaining_cost: 50000, created_at: now },
    { id: 'bgt-p4-02', project_id: p4Id, wbs_node_id: 'wbs-p4-02', boq_item_id: 'boq-p4-02', description: 'الهياكل الخرسانية لـ 50 فيلا', planned_cost: 15875000, committed_cost: 14000000, actual_cost: 4200000, remaining_cost: 11675000, created_at: now },
    { id: 'bgt-p4-03', project_id: p4Id, wbs_node_id: 'wbs-p4-03', boq_item_id: 'boq-p4-04', description: 'المباني والتشطيبات الفاخرة والواجهات', planned_cost: 9080000, committed_cost: 4000000, actual_cost: 0, remaining_cost: 9080000, created_at: now },
    { id: 'bgt-p4-04', project_id: p4Id, wbs_node_id: 'wbs-p4-04', boq_item_id: 'boq-p4-06', description: 'الكهروميكانيك والتكييف والحدائق والري', planned_cost: 5745000, committed_cost: 2500000, actual_cost: 0, remaining_cost: 5745000, created_at: now },
  ];

  // =========================================================================
  // 8. PROGRESS UPDATES & COST TRANSACTIONS (All Strictly <= 2026-09-13)
  // =========================================================================
  const progressUpdates: ProgressUpdate[] = [
    // Project 1 Progress (Data Date: 2026-09-13)
    { id: 'prg-01', project_id: p1Id, activity_id: 'act-01', update_date: '2026-07-13', percent_complete: 100, actual_quantity: 1200, quantity_to_date: 1200, status: 'approved', approved_at: '2026-07-13T16:00:00Z', rejected_reason: null, notes: 'تم اكتمال أعمال الحفر واستلام المنسوب بنجاح.', created_at: now },
    { id: 'prg-02', project_id: p1Id, activity_id: 'act-02', update_date: '2026-07-22', percent_complete: 100, actual_quantity: 95, quantity_to_date: 95, status: 'approved', approved_at: '2026-07-22T17:00:00Z', rejected_reason: null, notes: 'صب خرسانة النظافة بنجاح واستلام المناسيب.', created_at: now },
    { id: 'prg-03', project_id: p1Id, activity_id: 'act-03', update_date: '2026-08-14', percent_complete: 100, actual_quantity: 280, quantity_to_date: 280, status: 'approved', approved_at: '2026-08-14T18:00:00Z', rejected_reason: null, notes: 'تم صب القواعد المسلحة والميد واعتماد نتائج كسر المكعبات.', created_at: now },
    { id: 'prg-04', project_id: p1Id, activity_id: 'act-04', update_date: '2026-08-25', percent_complete: 100, actual_quantity: 450, quantity_to_date: 450, status: 'approved', approved_at: '2026-08-25T15:00:00Z', rejected_reason: null, notes: 'اكتمال العزل البيتوميني والردم الهندسي واختبارات الدمك.', created_at: now },
    { id: 'prg-05', project_id: p1Id, activity_id: 'act-05', update_date: '2026-09-12', percent_complete: 70, actual_quantity: 112, quantity_to_date: 112, status: 'approved', approved_at: '2026-09-12T17:00:00Z', rejected_reason: null, notes: 'انتهاء نجارة وحدادة سقف الدور الأرضي وجاري التجهيز للصب.', created_at: now },

    // Project 2 Progress (Data Date: 2026-09-13)
    { id: 'prg-p2-01', project_id: p2Id, activity_id: 'act-p2-01', update_date: '2026-07-04', percent_complete: 100, actual_quantity: 15, quantity_to_date: 15, status: 'approved', approved_at: '2026-07-04T16:00:00Z', rejected_reason: null, notes: 'اكتمال المسح الطبوغرافي ونقل خطوط المياه المعترضة.', created_at: now },
    { id: 'prg-p2-02', project_id: p2Id, activity_id: 'act-p2-02', update_date: '2026-08-23', percent_complete: 100, actual_quantity: 180000, quantity_to_date: 180000, status: 'approved', approved_at: '2026-08-23T17:00:00Z', rejected_reason: null, notes: 'إنجاز أعمال القطع الصخري والتسوية الميدانية كاملة.', created_at: now },
    { id: 'prg-p2-03', project_id: p2Id, activity_id: 'act-p2-03', update_date: '2026-09-10', percent_complete: 65, actual_quantity: 27, quantity_to_date: 27, status: 'approved', approved_at: '2026-09-10T18:00:00Z', rejected_reason: null, notes: 'اكتمال صب 27 عبارة صندوقية من أصل 42 عبارة.', created_at: now },

    // Project 3 Progress (Data Date: 2026-09-13)
    { id: 'prg-p3-01', project_id: p3Id, activity_id: 'act-p3-01', update_date: '2026-06-20', percent_complete: 100, actual_quantity: 65000, quantity_to_date: 65000, status: 'approved', approved_at: '2026-06-20T16:00:00Z', rejected_reason: null, notes: 'اكتمال الحفر العميق ونزح المياه الجوفية.', created_at: now },
    { id: 'prg-p3-02', project_id: p3Id, activity_id: 'act-p3-02', update_date: '2026-08-22', percent_complete: 100, actual_quantity: 650, quantity_to_date: 650, status: 'approved', approved_at: '2026-08-22T17:00:00Z', rejected_reason: null, notes: 'انتهاء تنفيذ واختبار 650 خازوق CFA pile بنجاح.', created_at: now },
    { id: 'prg-p3-03', project_id: p3Id, activity_id: 'act-p3-03', update_date: '2026-09-12', percent_complete: 60, actual_quantity: 7200, quantity_to_date: 7200, status: 'approved', approved_at: '2026-09-12T18:00:00Z', rejected_reason: null, notes: 'صب 7200 م3 من اللبشة المسلحة مع العزل المائي المستمر.', created_at: now },

    // Project 4 Progress (Data Date: 2026-09-13)
    { id: 'prg-p4-01', project_id: p4Id, activity_id: 'act-p4-01', update_date: '2026-08-04', percent_complete: 100, actual_quantity: 45000, quantity_to_date: 45000, status: 'approved', approved_at: '2026-08-04T16:00:00Z', rejected_reason: null, notes: 'اكتمال تسوية الموقع العام وشبكات الموقع للمجمع السكني.', created_at: now },
    { id: 'prg-p4-02', project_id: p4Id, activity_id: 'act-p4-02', update_date: '2026-09-12', percent_complete: 75, actual_quantity: 5625, quantity_to_date: 5625, status: 'approved', approved_at: '2026-09-12T17:00:00Z', rejected_reason: null, notes: 'انتهاء صب قواعد وميد 38 فيلا من أصل 50 فيلا.', created_at: now },
  ];

  const costTransactions: CostTransaction[] = [
    // Project 1 Transactions (Total = 689,900 SAR)
    { id: 'cst-01', project_id: p1Id, activity_id: 'act-01', boq_item_id: 'boq-01', category: 'Earthworks', transaction_date: '2026-07-15', description: 'مستخلص مقاول الحفريات ونقل المخلفات', cost_type: 'direct', amount: 40500, source: 'invoice', status: 'approved', approved_at: '2026-07-16T10:00:00Z', rejected_reason: null, invoice_number: 'INV-2026-001', vendor: 'شركة الرمال للحفريات', created_at: now },
    { id: 'cst-02', project_id: p1Id, activity_id: 'act-02', boq_item_id: 'boq-03', category: 'Concrete Works', transaction_date: '2026-07-24', description: 'توريد وصب خرسانة نظافة عادية', cost_type: 'direct', amount: 39900, source: 'invoice', status: 'approved', approved_at: '2026-07-25T09:00:00Z', rejected_reason: null, invoice_number: 'INV-2026-002', vendor: 'مصنع الشرق للخرسانة', created_at: now },
    { id: 'cst-03', project_id: p1Id, activity_id: 'act-03', boq_item_id: 'boq-04', category: 'Concrete Works', transaction_date: '2026-08-16', description: 'توريد خرسانة وحديد تسليح القواعد المسلحة', cost_type: 'direct', amount: 310000, source: 'invoice', status: 'approved', approved_at: '2026-08-17T11:00:00Z', rejected_reason: null, invoice_number: 'INV-2026-003', vendor: 'مجموعة الراجحي للصناعة', created_at: now },
    { id: 'cst-04', project_id: p1Id, activity_id: 'act-04', boq_item_id: 'boq-02', category: 'Earthworks', transaction_date: '2026-08-28', description: 'عزل القواعد والردم الهندسي واختبارات الدمك', cost_type: 'direct', amount: 19500, source: 'invoice', status: 'approved', approved_at: '2026-08-29T10:00:00Z', rejected_reason: null, invoice_number: 'INV-2026-004', vendor: 'شركة الرمال للحفريات', created_at: now },
    { id: 'cst-05', project_id: p1Id, activity_id: 'act-05', boq_item_id: 'boq-06', category: 'Concrete Works', transaction_date: '2026-09-10', description: 'دفعة صب ونجارة أعمدة وسقف الدور الأرضي', cost_type: 'direct', amount: 280000, source: 'invoice', status: 'approved', approved_at: '2026-09-11T14:00:00Z', rejected_reason: null, invoice_number: 'INV-2026-005', vendor: 'مصنع الشرق للخرسانة', created_at: now },

    // Project 2 Transactions (Highway - Total = 13,200,000 SAR)
    { id: 'cst-p2-01', project_id: p2Id, activity_id: 'act-p2-01', boq_item_id: 'boq-p2-01', category: 'Earthworks', transaction_date: '2026-07-08', description: 'مستخلص المسح الطبوغرافي ونقل الخدمات', cost_type: 'direct', amount: 4500000, source: 'invoice', status: 'approved', approved_at: '2026-07-10T10:00:00Z', rejected_reason: null, invoice_number: 'INV-HWY-01', vendor: 'شركة المقاولات الإنشائية', created_at: now },
    { id: 'cst-p2-02', project_id: p2Id, activity_id: 'act-p2-02', boq_item_id: 'boq-p2-01', category: 'Earthworks', transaction_date: '2026-08-25', description: 'أعمال التسوية والقطع الصخري الكامل', cost_type: 'direct', amount: 5300000, source: 'invoice', status: 'approved', approved_at: '2026-08-26T10:00:00Z', rejected_reason: null, invoice_number: 'INV-HWY-02', vendor: 'مصنع الشرق للطرق', created_at: now },
    { id: 'cst-p2-03', project_id: p2Id, activity_id: 'act-p2-03', boq_item_id: 'boq-p2-03', category: 'Drainage', transaction_date: '2026-09-11', description: 'دفعة صب وتوريد 27 عبارة صندوقية معتمدة', cost_type: 'direct', amount: 3400000, source: 'invoice', status: 'approved', approved_at: '2026-09-12T10:00:00Z', rejected_reason: null, invoice_number: 'INV-HWY-03', vendor: 'شركة الخرسانة المسبقة', created_at: now },

    // Project 3 Transactions (Hospital - Total = 24,320,000 SAR)
    { id: 'cst-p3-01', project_id: p3Id, activity_id: 'act-p3-01', boq_item_id: 'boq-p3-01', category: 'Piling', transaction_date: '2026-06-25', description: 'مستخلص الحفر العميق ونزح المياه', cost_type: 'direct', amount: 6700000, source: 'invoice', status: 'approved', approved_at: '2026-06-26T10:00:00Z', rejected_reason: null, invoice_number: 'INV-HSP-01', vendor: 'شركة الأساسات التخصصية', created_at: now },
    { id: 'cst-p3-02', project_id: p3Id, activity_id: 'act-p3-02', boq_item_id: 'boq-p3-01', category: 'Piling', transaction_date: '2026-08-25', description: 'مستخلص تنفيذ واختبار 650 خازوق CFA', cost_type: 'direct', amount: 11500000, source: 'invoice', status: 'approved', approved_at: '2026-08-26T10:00:00Z', rejected_reason: null, invoice_number: 'INV-HSP-02', vendor: 'شركة الأساسات التخصصية', created_at: now },
    { id: 'cst-p3-03', project_id: p3Id, activity_id: 'act-p3-03', boq_item_id: 'boq-p3-02', category: 'Foundations', transaction_date: '2026-09-12', description: 'دفعة صب اللبشة المسلحة مع العزل', cost_type: 'direct', amount: 6120000, source: 'invoice', status: 'approved', approved_at: '2026-09-12T14:00:00Z', rejected_reason: null, invoice_number: 'INV-HSP-03', vendor: 'مجموعة اليمامة للخرسانة', created_at: now },

    // Project 4 Transactions (Villas - Total = 5,950,000 SAR)
    { id: 'cst-p4-01', project_id: p4Id, activity_id: 'act-p4-01', boq_item_id: 'boq-p4-01', category: 'Earthworks', transaction_date: '2026-08-08', description: 'مستخلص تسوية الموقع وشبكات البنية التحتية', cost_type: 'direct', amount: 1750000, source: 'invoice', status: 'approved', approved_at: '2026-08-09T10:00:00Z', rejected_reason: null, invoice_number: 'INV-VIL-01', vendor: 'شركة الإعمار السكني', created_at: now },
    { id: 'cst-p4-02', project_id: p4Id, activity_id: 'act-p4-02', boq_item_id: 'boq-p4-02', category: 'Foundations', transaction_date: '2026-09-12', description: 'مستخلص صب قواعد وميد 38 فيلا سكنية', cost_type: 'direct', amount: 4200000, source: 'invoice', status: 'approved', approved_at: '2026-09-12T15:00:00Z', rejected_reason: null, invoice_number: 'INV-VIL-02', vendor: 'مصنع الرياض للخرسانة', created_at: now },
  ];

  // =========================================================================
  // 9. RISKS, ISSUES & PROCUREMENT SUBMITTALS
  // =========================================================================
  const risks: Risk[] = [
    { id: 'rsk-01', project_id: p1Id, title: 'تأخر توريد وحدات التكييف المركزي VRF من المصنع', description: 'احتمال تأخر الشحن لوحدات التكييف الرئيسية لمدة أسبوعين.', probability: 3, impact: 4, severity: 12, mitigation: 'التنسيق مع المورد لتأكيد تاريخ الشحن مبكراً وحجز دفعات من المخزون المحلي.', status: 'open', category: 'Procurement', identified_date: '2026-07-15', created_at: now },
    { id: 'rsk-02', project_id: p1Id, title: 'تذبذب أسعار حديد التسليح والخرسانة الجاهزة', description: 'ارتفاع محتمل في أسعار المواد الأساسية خلال أعمال الأدوار المتكررة.', probability: 2, impact: 3, severity: 6, mitigation: 'تثبيت أسعار التوريد بعقود مسبقة مع مصانع الخرسانة وموردي الحديد.', status: 'open', category: 'Financial', identified_date: '2026-07-20', created_at: now },
    { id: 'rsk-p2-01', project_id: p2Id, title: 'وجود خطوط مياه وخدمات بترولية غير موثقة بمسار الطريق', description: 'احتمال اعتراض خط أنابيب لم يتم رصده بالمسح المبدئي.', probability: 3, impact: 5, severity: 15, mitigation: 'استخدام أجهزة الرادار الأرضي GPR والتنسيق مع شركة أرامكو والبلدية.', status: 'open', category: 'Site', identified_date: '2026-06-10', created_at: now },
    { id: 'rsk-p3-01', project_id: p3Id, title: 'تأخر فسوحات واعتماد غرف الأشعة والطب النووي من هيئة الرقابة النووية', description: 'متطلبات ترخيص مشددة تتطلب اعتمادات متتالية.', probability: 4, impact: 4, severity: 16, mitigation: 'تقديم المخططات التنفيذية والخرائط المعتمدة عبر استشاري وقاية إشعاعية مرخص.', status: 'open', category: 'Regulatory', identified_date: '2026-05-15', created_at: now },
    { id: 'rsk-p4-01', project_id: p4Id, title: 'تعثر توريد الرخام الإيطالي المستورد لواجهات الفلل', description: 'تأخر سلاسل الإمداد البحرية للتشطيبات الفاخرة.', probability: 2, impact: 3, severity: 6, mitigation: 'اعتماد عينات بديلة من الرخام المحلي عالي الجودة متوافق مع المواصفات.', status: 'open', category: 'Procurement', identified_date: '2026-07-20', created_at: now },
  ];

  const issues: Issue[] = [
    { id: 'iss-01', project_id: p1Id, title: 'تعديل فتحات تمرير مواسير الصرف في الميد الأرضية', description: 'تعارض طفيف تم حله بإشراف الاستشاري واعتماد المخطط التنفيذي.', status: 'resolved', priority: 'medium', proposed_solution: 'زرع جلبات PVC معتمدة قبل الصب النهائي.', assignee: 'م. أحمد خالد (مهندس الموقع)', raised_date: '2026-08-01', resolved_date: '2026-08-05', created_at: now },
    { id: 'iss-p2-01', project_id: p2Id, title: 'تعارض عبارة تصريف سيول عند كم 7.2 مع خط كهرباء ضغط عالي', description: 'الحاجة لحماية أبراج الكهرباء المجاورة لمنطقة الحفر.', status: 'in_progress', priority: 'high', proposed_solution: 'تدعيم التربة بالستائر المعدنية وتعديل مسار القناة 15 متراً.', assignee: 'م. فهد الدوسري (مهندس الطرق)', raised_date: '2026-08-20', resolved_date: null, created_at: now },
    { id: 'iss-p3-01', project_id: p3Id, title: 'تعديل مسارات مواسير الغازات الطبية في غرف العمليات 3 و 4', description: 'تعارض بين مسار دكت فلاتر HEPA ومخارج الأكسجين الجراحية.', status: 'in_progress', priority: 'high', proposed_solution: 'إعادة توزيع الممرات العلوية بالتنسيق مع مهندس المعدات الطبية.', assignee: 'م. سامي الحربي (استشاري الكهروميكانيك)', raised_date: '2026-08-30', resolved_date: null, created_at: now },
  ];

  const procurementSubmittals: ProcurementSubmittal[] = [
    { id: 'sub-01', project_id: p1Id, activity_id: 'act-03', title: 'اعتماد حديد تسليح عالي المقاومة Gr. 60 (سابك)', submittal_type: 'material', submittal_code: 'MAT-RS-001', revision: '0', status: 'approved', submitted_date: '2026-07-10', reviewed_date: '2026-07-15', review_comments: 'معتمد وفق المواصفات القياسية السعودية SASO.', consultant_reviewer: 'دار الهندسة للاستشارات', created_at: now },
    { id: 'sub-02', project_id: p1Id, activity_id: 'act-08', title: 'اعتماد كابلات كهربائية مقاومة للحريق (الفنار)', submittal_type: 'material', submittal_code: 'MAT-EL-001', revision: '1', status: 'approved', submitted_date: '2026-08-05', reviewed_date: '2026-08-12', review_comments: 'معتمد ومطابق لاشتراطات الدفاع المدني.', consultant_reviewer: 'دار الهندسة للاستشارات', created_at: now },
    { id: 'sub-p2-01', project_id: p2Id, activity_id: 'act-p2-03', title: 'اعتماد خلطة الخرسانة المسلحة للعبارات C40/50', submittal_type: 'material', submittal_code: 'MAT-HWY-001', revision: '0', status: 'approved', submitted_date: '2026-07-15', reviewed_date: '2026-07-20', review_comments: 'معتمد للاستخدام في شبكات تصريف السيول.', consultant_reviewer: 'استشاري وزارة النقل', created_at: now },
    { id: 'sub-p3-01', project_id: p3Id, activity_id: 'act-p3-07', title: 'اعتماد أجهزة ومخارج الغازات الطبية Draeger الألمانية', submittal_type: 'material', submittal_code: 'MAT-HSP-001', revision: '0', status: 'approved', submitted_date: '2026-06-01', reviewed_date: '2026-06-15', review_comments: 'معتمد ومطابق لمعايير HTM 02-01 و CBAHI.', consultant_reviewer: 'استشاري الشؤون الصحية', created_at: now },
  ];

  // =========================================================================
  // 10. PROJECT BASELINES FOR ALL 4 PROJECTS
  // =========================================================================
  const projectBaselines: ProjectBaseline[] = [
    { id: 'bsl-p1-01', project_id: p1Id, baseline_name: 'خط الأساس المعتمد تعاقدياً (Target 1 - Rev 0)', is_active: true, status: 'approved', created_at: now },
    { id: 'bsl-p2-01', project_id: p2Id, baseline_name: 'خط الأساس المعتمد تعاقدياً لطريق الشرقية (Target 1 - Rev 0)', is_active: true, status: 'approved', created_at: now },
    { id: 'bsl-p3-01', project_id: p3Id, baseline_name: 'خط الأساس المعتمد لمستشفى جدة (Target 1 - Rev 0)', is_active: true, status: 'approved', created_at: now },
    { id: 'bsl-p4-01', project_id: p4Id, baseline_name: 'خط الأساس المعتمد لمجمع الفلل (Target 1 - Rev 0)', is_active: true, status: 'approved', created_at: now },
  ];

  // Map each baseline activity's planned cost accurately proportional to its budget weight
  const baselineActivities: BaselineActivity[] = activities.map((act) => {
    let actPlannedCost = 0;
    if (act.project_id === p1Id) {
      actPlannedCost = act.id === 'act-01' ? 42000 : act.id === 'act-02' ? 39900 : act.id === 'act-03' ? 323150 : act.id === 'act-04' ? 20250 : act.id === 'act-05' ? 468000 : act.id === 'act-06' ? 468000 : act.id === 'act-07' ? 440000 : act.id === 'act-08' ? 151700 : act.id === 'act-09' ? 244800 : act.id === 'act-10' ? 147350 : 0;
    } else if (act.project_id === p2Id) {
      actPlannedCost = act.id === 'act-p2-01' ? 4500000 : act.id === 'act-p2-02' ? 3600000 : act.id === 'act-p2-03' ? 8940000 : act.id === 'act-p2-04' ? 3600000 : act.id === 'act-p2-05' ? 7600000 : act.id === 'act-p2-06' ? 14780000 : act.id === 'act-p2-07' ? 2400000 : act.id === 'act-p2-08' ? 1470000 : act.id === 'act-p2-09' ? 1110000 : 0;
    } else if (act.project_id === p3Id) {
      actPlannedCost = act.id === 'act-p3-01' ? 11700000 : act.id === 'act-p3-02' ? 10200000 : act.id === 'act-p3-03' ? 10200000 : act.id === 'act-p3-04' ? 25760000 : act.id === 'act-p3-05' ? 4500000 : act.id === 'act-p3-06' ? 14800000 : act.id === 'act-p3-07' ? 22800000 : act.id === 'act-p3-08' ? 16500000 : act.id === 'act-p3-09' ? 8740000 : 0;
    } else {
      actPlannedCost = act.id === 'act-p4-01' ? 1800000 : act.id === 'act-p4-02' ? 5625000 : act.id === 'act-p4-03' ? 10250000 : act.id === 'act-p4-04' ? 4180000 : act.id === 'act-p4-05' ? 4350000 : act.id === 'act-p4-06' ? 4900000 : act.id === 'act-p4-07' ? 1395000 : 0;
    }

    return {
      id: `ba-${act.id}`,
      baseline_id: act.project_id === p1Id ? 'bsl-p1-01' : act.project_id === p2Id ? 'bsl-p2-01' : act.project_id === p3Id ? 'bsl-p3-01' : 'bsl-p4-01',
      activity_id: act.id,
      early_start: act.early_start || '2026-07-01',
      early_finish: act.early_finish || '2027-02-28',
      late_start: act.late_start || '2026-07-01',
      late_finish: act.late_finish || '2027-02-28',
      duration_days: act.duration_days,
      planned_cost: actPlannedCost,
      created_at: now,
    };
  });

  return {
    projects: [project1, project2, project3, project4],
    boq_items: boqItems,
    wbs_nodes: wbsNodes,
    activities,
    activity_links: activityLinks,
    resources,
    activity_resources: activityResources,
    budget_lines: budgetLines,
    risks,
    issues,
    progress_updates: progressUpdates,
    cost_transactions: costTransactions,
    procurement_submittals: procurementSubmittals,
    project_baselines: projectBaselines,
    baseline_activities: baselineActivities,
  };
}

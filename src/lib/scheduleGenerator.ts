import type { ParsedBoqRow } from '@/types';
import { categorizeBoqItem } from './boqParser';
import { calculateProductionDuration, type ProductivityRule } from './planningEngine';

export interface GenWbsNode {
  code: string;
  name: string;
  level: number;
  parent_code: string | null;
  sort_order: number;
}

export interface GenActivity {
  wbs_node_code: string | null;
  code: string;
  name: string;
  early_start: string;
  early_finish: string;
  late_start: string;
  late_finish: string;
  duration_days: number;
  planned_quantity: number;
  actual_quantity: number;
  unit: string;
  percent_complete: number;
  is_critical: boolean;
  is_milestone: boolean;
  actual_start: string | null;
  actual_finish: string | null;
  sort_order: number;
}

export interface GenLink {
  predecessor_code: string;
  successor_code: string;
  link_type: string;
  lag_days: number;
}

export interface GenResource {
  code: string;
  name: string;
  type: string;
  unit: string;
  unit_rate: number;
  availability: number;
}

export interface GenActivityResource {
  activityCode: string;
  resourceCode: string;
  planned_quantity: number;
}

export interface GenBudgetLine {
  wbs_node_code: string;
  description: string;
  planned_cost: number;
  committed_cost: number;
  actual_cost: number;
  remaining_cost: number;
}

export interface GeneratedSchedule {
  wbsNodes: GenWbsNode[];
  activities: GenActivity[];
  links: GenLink[];
  resources: GenResource[];
  activityResources: GenActivityResource[];
  budgetLines: GenBudgetLine[];
}

const CATEGORY_ORDER = [
  'Foundations', 'Earthworks', 'Concrete Works', 'Reinforcement Steel',
  'Masonry', 'Roofing & Insulation', 'Plastering', 'Tiling & Flooring',
  'Doors & Windows', 'Electrical', 'Plumbing & Drainage', 'HVAC', 'Painting', 'General',
];

const CATEGORY_BASE_DURATION: Record<string, number> = {
  'Foundations': 10, 'Earthworks': 5, 'Concrete Works': 7, 'Reinforcement Steel': 5,
  'Masonry': 10, 'Roofing & Insulation': 8, 'Plastering': 5, 'Tiling & Flooring': 7,
  'Doors & Windows': 6, 'Electrical': 12, 'Plumbing & Drainage': 10, 'HVAC': 10,
  'Painting': 4, 'General': 5,
};

const CATEGORY_RESOURCES: Record<string, { name: string; type: string; unit: string; rate: number }[]> = {
  'Earthworks': [
    { name: 'Excavator Operator', type: 'labor', unit: 'day', rate: 350 },
    { name: 'Excavator', type: 'equipment', unit: 'day', rate: 800 },
    { name: 'Laborer', type: 'labor', unit: 'day', rate: 150 },
  ],
  'Foundations': [
    { name: 'Concrete Crew', type: 'labor', unit: 'day', rate: 400 },
    { name: 'Concrete Pump', type: 'equipment', unit: 'day', rate: 1200 },
    { name: 'Ready Mix Concrete', type: 'material', unit: 'm³', rate: 450 },
  ],
  'Concrete Works': [
    { name: 'Concrete Crew', type: 'labor', unit: 'day', rate: 400 },
    { name: 'Concrete Pump', type: 'equipment', unit: 'day', rate: 1200 },
    { name: 'Ready Mix Concrete', type: 'material', unit: 'm³', rate: 450 },
  ],
  'Reinforcement Steel': [
    { name: 'Steel Fixer', type: 'labor', unit: 'day', rate: 250 },
    { name: 'Rebar Steel', type: 'material', unit: 'ton', rate: 3200 },
  ],
  'Masonry': [
    { name: 'Mason', type: 'labor', unit: 'day', rate: 200 },
    { name: 'Concrete Blocks', type: 'material', unit: 'piece', rate: 3.5 },
  ],
  'Roofing & Insulation': [
    { name: 'Roofing Crew', type: 'labor', unit: 'day', rate: 300 },
    { name: 'Insulation Material', type: 'material', unit: 'm²', rate: 85 },
  ],
  'Plastering': [
    { name: 'Plasterer', type: 'labor', unit: 'day', rate: 200 },
    { name: 'Mortar Mix', type: 'material', unit: 'm³', rate: 380 },
  ],
  'Tiling & Flooring': [
    { name: 'Tiler', type: 'labor', unit: 'day', rate: 220 },
    { name: 'Tiles', type: 'material', unit: 'm²', rate: 65 },
  ],
  'Doors & Windows': [
    { name: 'Carpenter', type: 'labor', unit: 'day', rate: 250 },
    { name: 'Door/Window Set', type: 'material', unit: 'set', rate: 850 },
  ],
  'Electrical': [
    { name: 'Electrician', type: 'labor', unit: 'day', rate: 280 },
    { name: 'Electrical Materials', type: 'material', unit: 'lot', rate: 5000 },
  ],
  'Plumbing & Drainage': [
    { name: 'Plumber', type: 'labor', unit: 'day', rate: 280 },
    { name: 'Pipes & Fittings', type: 'material', unit: 'lot', rate: 3500 },
  ],
  'HVAC': [
    { name: 'HVAC Technician', type: 'labor', unit: 'day', rate: 350 },
    { name: 'AC Units', type: 'material', unit: 'unit', rate: 4500 },
  ],
  'Painting': [
    { name: 'Painter', type: 'labor', unit: 'day', rate: 180 },
    { name: 'Paint', type: 'material', unit: 'drum', rate: 1200 },
  ],
  'General': [
    { name: 'General Laborer', type: 'labor', unit: 'day', rate: 150 },
  ],
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function generateSchedule(
  boqItems: ParsedBoqRow[],
  startDate: string,
  productivityRules: ProductivityRule[] = [],
): GeneratedSchedule {
  const projectStart = new Date(startDate);

  const categorized: Record<string, ParsedBoqRow[]> = {};
  for (const item of boqItems) {
    const cat = item.category || categorizeBoqItem(item.description);
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(item);
  }

  const sortedCategories = Object.keys(categorized).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const flatWbs: GenWbsNode[] = [];
  const wbsCatMap: { code: string; name: string; items: ParsedBoqRow[]; childCodes: string[] }[] = [];
  let catIndex = 0;

  for (const category of sortedCategories) {
    const catCode = `WBS.${String(catIndex + 1).padStart(2, '0')}`;
    flatWbs.push({ code: catCode, name: category, level: 1, parent_code: null, sort_order: catIndex });
    const childCodes: string[] = [];
    let itemIndex = 0;
    for (const item of categorized[category]) {
      const itemCode = `${catCode}.${String(itemIndex + 1).padStart(2, '0')}`;
      flatWbs.push({ code: itemCode, name: item.description.substring(0, 80), level: 2, parent_code: catCode, sort_order: itemIndex });
      childCodes.push(itemCode);
      itemIndex++;
    }
    wbsCatMap.push({ code: catCode, name: category, items: categorized[category], childCodes });
    catIndex++;
  }

  const activities: GenActivity[] = [];
  const resourceList: GenResource[] = [];
  const resourceCodeMap: Record<string, string> = {};
  let activitySort = 0;
  let currentDate = new Date(projectStart);

  for (const cat of wbsCatMap) {
    const catResources = CATEGORY_RESOURCES[cat.name] || CATEGORY_RESOURCES['General'];

    for (const res of catResources) {
      const resCode = `RES.${res.name.replace(/\s+/g, '_').toUpperCase()}`;
      if (!resourceCodeMap[res.name]) {
        resourceCodeMap[res.name] = resCode;
        resourceList.push({ code: resCode, name: res.name, type: res.type, unit: res.unit, unit_rate: res.rate, availability: 10 });
      }
    }

    for (let i = 0; i < cat.items.length; i++) {
      const item = cat.items[i];
      const wbsCode = cat.childCodes[i];
      const duration = calculateProductionDuration(item.quantity, cat.name, productivityRules);
      const actStart = new Date(currentDate);
      const actFinish = addDays(actStart, duration);

      activities.push({
        wbs_node_code: wbsCode,
        code: `ACT-${String(activitySort + 1).padStart(3, '0')}`,
        name: item.description.substring(0, 100),
        early_start: formatDate(actStart),
        early_finish: formatDate(actFinish),
        late_start: formatDate(actStart),
        late_finish: formatDate(actFinish),
        duration_days: duration,
        planned_quantity: item.quantity,
        actual_quantity: 0,
        unit: item.unit,
        percent_complete: 0,
        is_critical: true,
        is_milestone: false,
        actual_start: null,
        actual_finish: null,
        sort_order: activitySort,
      });
      activitySort++;
      currentDate = addDays(actFinish, 1);
    }
  }

  activities.push({
    wbs_node_code: null,
    code: `ACT-${String(activitySort + 1).padStart(3, '0')}`,
    name: 'Project Completion Milestone',
    early_start: formatDate(currentDate),
    early_finish: formatDate(currentDate),
    late_start: formatDate(currentDate),
    late_finish: formatDate(currentDate),
    duration_days: 0,
    planned_quantity: 0,
    actual_quantity: 0,
    unit: '',
    percent_complete: 0,
    is_critical: true,
    is_milestone: true,
    actual_start: null,
    actual_finish: null,
    sort_order: activitySort,
  });

  const links: GenLink[] = [];
  for (let i = 0; i < activities.length - 1; i++) {
    links.push({ predecessor_code: activities[i].code, successor_code: activities[i + 1].code, link_type: 'FS', lag_days: 0 });
  }

  const activityResources: GenActivityResource[] = [];
  for (const cat of wbsCatMap) {
    const catResources = CATEGORY_RESOURCES[cat.name] || CATEGORY_RESOURCES['General'];
    for (let i = 0; i < cat.items.length; i++) {
      const wbsCode = cat.childCodes[i];
      const actCode = activities.find((a) => a.wbs_node_code === wbsCode)?.code;
      if (!actCode) continue;
      const item = cat.items[i];
      for (const res of catResources) {
        const resCode = resourceCodeMap[res.name];
        const plannedQty = res.type === 'material'
          ? Math.max(1, item.quantity || 1)
          : Math.max(1, Math.round((CATEGORY_BASE_DURATION[cat.name] || 5) * Math.min(Math.sqrt(item.quantity || 1), 5)));
        activityResources.push({ activityCode: actCode, resourceCode: resCode, planned_quantity: plannedQty });
      }
    }
  }

  const budgetLines: GenBudgetLine[] = [];
  for (const cat of wbsCatMap) {
    for (let i = 0; i < cat.items.length; i++) {
      const item = cat.items[i];
      const wbsCode = cat.childCodes[i];
      budgetLines.push({
        wbs_node_code: wbsCode,
        description: item.description.substring(0, 100),
        planned_cost: item.total_price,
        committed_cost: item.total_price * 0.9,
        actual_cost: 0,
        remaining_cost: item.total_price,
      });
    }
  }

  return { wbsNodes: flatWbs, activities, links, resources: resourceList, activityResources, budgetLines };
}

export function calculateProjectDuration(activities: { early_start: string | null; early_finish: string | null }[]): number {
  if (activities.length === 0) return 0;
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  for (const a of activities) {
    if (!a.early_start || !a.early_finish) continue;
    const s = new Date(a.early_start);
    const f = new Date(a.early_finish);
    if (!minDate || s < minDate) minDate = s;
    if (!maxDate || f > maxDate) maxDate = f;
  }
  if (!minDate || !maxDate) return 0;
  return Math.round((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24));
}

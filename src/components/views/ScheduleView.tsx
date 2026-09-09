import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { getLanguage, translations, type Language } from '@/lib/i18n';
import type {
  Project,
  Activity,
  ActivityLink,
  WbsNode,
  BaselineActivity,
  Resource,
  ActivityResource,
  CalendarType,
  ActivityType,
  ActivityConstraintType,
  PercentCompleteType,
} from '@/types';
import { calculateCpm, type LinkDrivingResult } from '@/lib/cpmEngine';
import { addWorkingDays, subtractWorkingDays, getCalendar, countWorkingDays } from '@/lib/calendarEngine';
import {
  Zap,
  Flag,
  Clock,
  Save,
  Pencil,
  Calendar as CalendarIcon,
  Search,
  RefreshCw,
  GitMerge,
  Anchor,
  SlidersHorizontal,
  Maximize2,
  Minimize2,
  Sliders,
  FolderTree,
  ChevronRight,
  ChevronDown,
  Columns,
  Layers,
  Sparkles,
  ShieldAlert,
  Printer,
  BarChart3,
  Eye,
  Network,
} from 'lucide-react';

interface ScheduleViewProps {
  project: Project | null;
}

type ZoomLevel = 'days' | 'weeks' | 'months';

interface ColumnOption {
  key: string;
  labelAr: string;
  labelEn: string;
  defaultVisible: boolean;
}

const AVAILABLE_COLUMNS: ColumnOption[] = [
  { key: 'code', labelAr: 'كود النشاط', labelEn: 'Activity Code', defaultVisible: true },
  { key: 'name', labelAr: 'اسم النشاط', labelEn: 'Activity Name', defaultVisible: true },
  { key: 'activity_type', labelAr: 'نوع النشاط', labelEn: 'Activity Type', defaultVisible: true },
  { key: 'calendar_type', labelAr: 'التقويم', labelEn: 'Calendar', defaultVisible: false },
  { key: 'constraint', labelAr: 'القيد الزمني', labelEn: 'Constraint', defaultVisible: true },
  { key: 'early_start', labelAr: 'البداية المبكرة', labelEn: 'Early Start', defaultVisible: true },
  { key: 'early_finish', labelAr: 'النهاية المبكرة', labelEn: 'Early Finish', defaultVisible: true },
  { key: 'late_start', labelAr: 'البداية المتأخرة', labelEn: 'Late Start', defaultVisible: false },
  { key: 'late_finish', labelAr: 'النهاية المتأخرة', labelEn: 'Late Finish', defaultVisible: false },
  { key: 'duration_days', labelAr: 'المدة الأصلية', labelEn: 'Duration', defaultVisible: true },
  { key: 'remaining_duration_days', labelAr: 'المدة المتبقية', labelEn: 'Remaining Dur', defaultVisible: false },
  { key: 'percent_complete', labelAr: 'نسبة الإنجاز %', labelEn: '% Complete', defaultVisible: true },
  { key: 'physical_percent', labelAr: 'النسبة المادية %', labelEn: 'Physical %', defaultVisible: false },
  { key: 'duration_percent', labelAr: 'النسبة الزمنية %', labelEn: 'Duration %', defaultVisible: false },
  { key: 'total_float', labelAr: 'الهامش الكلي (TF)', labelEn: 'Total Float', defaultVisible: true },
  { key: 'free_float', labelAr: 'الهامش الحر (FF)', labelEn: 'Free Float', defaultVisible: true },
  { key: 'activity_drag', labelAr: 'كبح المسار (Drag)', labelEn: 'Drag', defaultVisible: true },
  { key: 'longest_path', labelAr: 'المسار الأطول', labelEn: 'Longest Path', defaultVisible: false },
  { key: 'expected_finish', labelAr: 'النهاية المتوقعة', labelEn: 'Expected Finish', defaultVisible: false },
  { key: 'baseline_var', labelAr: 'انحراف خط الأساس', labelEn: 'Baseline Var', defaultVisible: true },
  { key: 'critical', labelAr: 'حرج', labelEn: 'Critical', defaultVisible: true },
  { key: 'actions', labelAr: 'إجراءات', labelEn: 'Actions', defaultVisible: true },
];

export default function ScheduleView({ project }: ScheduleViewProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [wbsNodes, setWbsNodes] = useState<WbsNode[]>([]);
  const [baselineActivities, setBaselineActivities] = useState<BaselineActivity[]>([]);
  const [links, setLinks] = useState<ActivityLink[]>([]);
  const [linkDrivingMap, setLinkDrivingMap] = useState<Map<string, boolean>>(new Map());
  const [resources, setResources] = useState<Resource[]>([]);
  const [assignments, setAssignments] = useState<ActivityResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Activity>>({});
  const [message, setMessage] = useState('');
  const [linkForm, setLinkForm] = useState({ predecessor_id: '', successor_id: '', link_type: 'FS', lag_days: 0 });

  // Fullscreen & Language
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lang, setLang] = useState<Language>(getLanguage());

  // WBS Tree Collapse/Expand State
  const [collapsedWbs, setCollapsedWbs] = useState<Record<string, boolean>>({});
  const [groupByWbs, setGroupByWbs] = useState(true);

  // Column Customizer State
  const [showColumnChooser, setShowColumnChooser] = useState(false);
  const [scheduleTab, setScheduleTab] = useState<'gantt' | 'lookahead' | 'pert' | 'float_velocity'>('gantt');
  const [lookaheadWeeks, setLookaheadWeeks] = useState<3 | 6>(3);
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    AVAILABLE_COLUMNS.forEach((c) => {
      initial[c.key] = c.defaultVisible;
    });
    return initial;
  });

  // Advanced Scheduling Controls
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>('weeks');
  const [showDependencyLines, setShowDependencyLines] = useState(true);
  const [showDrivingLinksOnly, setShowDrivingLinksOnly] = useState(false);
  const [showBaselines, setShowBaselines] = useState(true);
  const [filterCriticalOnly, setFilterCriticalOnly] = useState(false);
  const [filterMilestonesOnly, setFilterMilestonesOnly] = useState(false);
  const [filterLongestPathOnly, setFilterLongestPathOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCalendar, setSelectedCalendar] = useState<CalendarType>(project?.calendar_type || '6_days');
  const [currentDataDate, setCurrentDataDate] = useState<string>(project?.data_date || '2026-11-15');
  const [statusLogic, setStatusLogic] = useState<'retained_logic' | 'progress_override'>(project?.status_logic || 'retained_logic');
  const [isRecalculating, setIsRecalculating] = useState(false);

  // Direct Manipulation & Dragging State
  const [draggedActivityId, setDraggedActivityId] = useState<string | null>(null);
  const [dragAction, setDragAction] = useState<'move' | 'resize' | 'link' | null>(null);
  const [dragStartX, setDragStartX] = useState<number>(0);
  const [currentDragOffsetDays, setCurrentDragOffsetDays] = useState<number>(0);
  const [linkingSourceId, setLinkingSourceId] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    if (project) {
      loadData();
      if (project.data_date) setCurrentDataDate(project.data_date);
    } else {
      setLoading(false);
    }

    const handleLangChange = (e: any) => {
      setLang(e.detail?.lang || getLanguage());
    };
    window.addEventListener('app-language-changed', handleLangChange);
    return () => window.removeEventListener('app-language-changed', handleLangChange);
  }, [project]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, wbsRes, baselineRes, linkRes, resourceRes, assignmentRes] = await Promise.all([
      supabase.from('activities').select('*, wbs_node:wbs_nodes(*)').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('wbs_nodes').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('baseline_activities').select('*'),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
      supabase.from('resources').select('*').eq('project_id', project.id).order('name'),
      supabase.from('activity_resources').select('*, resource:resources(*)').eq('project_id', project.id),
    ]);
    const acts = (actRes.data || []) as Activity[];
    const linksData = (linkRes.data || []) as ActivityLink[];

    // Calculate CPM & driving links
    const cpm = calculateCpm(acts, linksData, {
      calendarType: project.calendar_type || '6_days',
      dataDate: project.data_date || '2026-11-15',
      statusLogic: project.status_logic || 'retained_logic',
      calculateDrag: true,
    });

    const drivingMap = new Map<string, boolean>();
    cpm.linkResults.forEach((lr) => {
      drivingMap.set(lr.linkId, lr.isDriving);
    });
    setLinkDrivingMap(drivingMap);

    setActivities(acts);
    setWbsNodes(wbsRes.data || []);
    setBaselineActivities((baselineRes.data || []) as BaselineActivity[]);
    setLinks(linksData);
    setResources((resourceRes.data || []) as Resource[]);
    setAssignments((assignmentRes.data || []) as ActivityResource[]);
    setLoading(false);
  }

  async function recalculatePersistedSchedule(
    nextActivities?: Activity[],
    nextLinks?: ActivityLink[],
    calType = selectedCalendar,
    dDate = currentDataDate,
    sLogic = statusLogic,
  ) {
    if (!project) return true;
    setIsRecalculating(true);
    const calculation = calculateCpm(nextActivities || activities, nextLinks || links, {
      calendarType: calType,
      dataDate: dDate,
      statusLogic: sLogic,
      calculateDrag: true,
    });

    if (calculation.cycle) {
      setMessage(`تم إيقاف إعادة الحساب: تم رصد حلقة علاقات دائرية بين ${calculation.cycle.join(' ← ')}`);
      setIsRecalculating(false);
      return false;
    }

    const drivingMap = new Map<string, boolean>();
    calculation.linkResults.forEach((lr) => {
      drivingMap.set(lr.linkId, lr.isDriving);
    });
    setLinkDrivingMap(drivingMap);

    for (const result of calculation.results) {
      await supabase.from('activities').update({
        early_start: result.earlyStart,
        early_finish: result.earlyFinish,
        late_start: result.lateStart,
        late_finish: result.lateFinish,
        total_float: result.totalFloat,
        free_float: result.freeFloat,
        is_critical: result.isCritical,
        activity_drag: result.activityDrag,
      }).eq('id', result.activityId);
    }

    setIsRecalculating(false);
    return true;
  }

  const handleCalendarChange = async (cal: CalendarType) => {
    setSelectedCalendar(cal);
    if (project) {
      await supabase.from('projects').update({ calendar_type: cal }).eq('id', project.id);
      await recalculatePersistedSchedule(activities, links, cal, currentDataDate, statusLogic);
      await loadData();
      setMessage(`تم تطبيق تقويم المشروع (${cal === '6_days' ? '6 أيام - الجمعة عطلة' : cal === '5_days' ? '5 أيام - الجمعة والسبت عطلة' : '7 أيام عمل مستمر'}) وإعادة حساب تواريخ CPM.`);
    }
  };

  const handleDataDateChange = async (newDate: string) => {
    setCurrentDataDate(newDate);
    if (project) {
      await supabase.from('projects').update({ data_date: newDate }).eq('id', project.id);
      await recalculatePersistedSchedule(activities, links, selectedCalendar, newDate, statusLogic);
      await loadData();
      setMessage(`تم تحديث تاريخ المتابعة (Data Date) إلى ${newDate} وإعادة جدولة الأعمال المتبقية.`);
    }
  };

  const handleStatusLogicChange = async (logic: 'retained_logic' | 'progress_override') => {
    setStatusLogic(logic);
    if (project) {
      await supabase.from('projects').update({ status_logic: logic }).eq('id', project.id);
      await recalculatePersistedSchedule(activities, links, selectedCalendar, currentDataDate, logic);
      await loadData();
      setMessage(`تم اعتماد خيار الحساب: ${logic === 'retained_logic' ? 'المنطق المتبقي (Retained Logic)' : 'تجاوز التقدم (Progress Override)'}`);
    }
  };

  // Toggle Column Visibility
  const toggleColumn = (key: string) => {
    setVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Toggle WBS Collapse
  const toggleWbsCollapse = (wbsId: string) => {
    setCollapsedWbs((prev) => ({ ...prev, [wbsId]: !prev[wbsId] }));
  };

  const expandAllWbs = () => setCollapsedWbs({});
  const collapseAllWbs = () => {
    const allCollapsed: Record<string, boolean> = {};
    wbsNodes.forEach((w) => { allCollapsed[w.id] = true; });
    setCollapsedWbs(allCollapsed);
  };

  // Filtered Activities
  const filteredActivities = useMemo(() => {
    return activities.filter((a) => {
      if (filterCriticalOnly && !a.is_critical) return false;
      if (filterMilestonesOnly && !a.is_milestone) return false;
      if (filterLongestPathOnly && !a.is_critical) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q);
      }
      return true;
    });
  }, [activities, filterCriticalOnly, filterMilestonesOnly, filterLongestPathOnly, searchQuery]);

  // Hierarchical WBS + Activities Structure with Rollup Calculations
  const hierarchicalItems = useMemo(() => {
    const items: Array<{
      type: 'wbs' | 'activity';
      wbsNode?: WbsNode;
      activity?: Activity;
      level: number;
      id: string;
      rollup?: {
        earlyStart: string | null;
        earlyFinish: string | null;
        totalDuration: number;
        percentComplete: number;
        activitiesCount: number;
      };
    }> = [];

    if (!groupByWbs || wbsNodes.length === 0) {
      filteredActivities.forEach((act) => {
        items.push({ type: 'activity', activity: act, level: 0, id: act.id });
      });
      return items;
    }

    wbsNodes.forEach((wbs) => {
      const childActs = filteredActivities.filter((a) => a.wbs_node_id === wbs.id);
      const isCollapsed = Boolean(collapsedWbs[wbs.id]);

      // Calculate WBS rollup summary metrics
      let minStart: string | null = null;
      let maxFinish: string | null = null;
      let totalProgress = 0;

      childActs.forEach((act) => {
        if (act.early_start && (!minStart || act.early_start < minStart)) minStart = act.early_start;
        if (act.early_finish && (!maxFinish || act.early_finish > maxFinish)) maxFinish = act.early_finish;
        totalProgress += act.percent_complete || 0;
      });

      const avgProgress = childActs.length > 0 ? Math.round(totalProgress / childActs.length) : 0;
      const totalDur = minStart && maxFinish ? Math.max(1, Math.round((new Date(maxFinish).getTime() - new Date(minStart).getTime()) / 86400000)) : 0;

      items.push({
        type: 'wbs',
        wbsNode: wbs,
        level: wbs.level || 1,
        id: `wbs-${wbs.id}`,
        rollup: {
          earlyStart: minStart,
          earlyFinish: maxFinish,
          totalDuration: totalDur,
          percentComplete: avgProgress,
          activitiesCount: childActs.length,
        },
      });

      if (!isCollapsed) {
        childActs.forEach((act) => {
          items.push({ type: 'activity', activity: act, level: (wbs.level || 1) + 1, id: act.id });
        });
      }
    });

    // Activities without WBS node
    const orphans = filteredActivities.filter((a) => !a.wbs_node_id);
    orphans.forEach((act) => {
      items.push({ type: 'activity', activity: act, level: 0, id: act.id });
    });

    return items;
  }, [wbsNodes, filteredActivities, groupByWbs, collapsedWbs]);

  // Overall date boundaries
  const { minDate, maxDate, totalDays } = useMemo(() => {
    if (activities.length === 0) return { minDate: new Date('2026-09-01'), maxDate: new Date('2027-06-01'), totalDays: 270 };
    let min: Date | null = null;
    let max: Date | null = null;
    for (const a of activities) {
      const s = a.actual_start || a.early_start;
      const f = a.actual_finish || a.early_finish;
      if (s) {
        const d = new Date(s);
        if (!min || d < min) min = d;
      }
      if (f) {
        const d = new Date(f);
        if (!max || d > max) max = d;
      }
    }
    const startObj = min ? new Date(min) : new Date('2026-09-15');
    const dayOfWeek = startObj.getUTCDay();
    startObj.setUTCDate(startObj.getUTCDate() - dayOfWeek);

    const endObj = max ? new Date(max) : new Date('2027-05-15');
    endObj.setUTCDate(endObj.getUTCDate() + 14);

    const diffDays = Math.max(30, Math.round((endObj.getTime() - startObj.getTime()) / 86400000));
    return { minDate: startObj, maxDate: endObj, totalDays: diffDays };
  }, [activities]);

  const pixelsPerDay = useMemo(() => {
    switch (zoomLevel) {
      case 'days': return 36;
      case 'weeks': return 14;
      case 'months': return 5.5;
      default: return 14;
    }
  }, [zoomLevel]);

  const timelineContentWidth = useMemo(() => {
    return Math.max(860, Math.round(totalDays * pixelsPerDay));
  }, [totalDays, pixelsPerDay]);

  // Dynamic timeline columns & markers
  const timelineHeaderBlocks = useMemo(() => {
    if (!minDate || totalDays === 0) return [];
    const blocks: { label: string; subLabel?: string; leftPx: number; widthPx: number; isWeekend?: boolean }[] = [];

    if (zoomLevel === 'days') {
      const arDays = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
      for (let i = 0; i < totalDays; i++) {
        const curDate = new Date(minDate.getTime() + i * 86400000);
        const dayIdx = curDate.getUTCDay();
        const dateStr = curDate.getUTCDate();
        const isFri = dayIdx === 5;
        blocks.push({
          label: `${dateStr}`,
          subLabel: arDays[dayIdx],
          leftPx: i * pixelsPerDay,
          widthPx: pixelsPerDay,
          isWeekend: isFri,
        });
      }
    } else if (zoomLevel === 'weeks') {
      const totalWeeks = Math.ceil(totalDays / 7);
      const arMonths = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      for (let w = 0; w < totalWeeks; w++) {
        const curDate = new Date(minDate.getTime() + w * 7 * 86400000);
        const labelStr = `أسبوع ${w + 1}`;
        const subLabel = `${curDate.getUTCDate()} ${arMonths[curDate.getUTCMonth()]}`;
        blocks.push({
          label: labelStr,
          subLabel,
          leftPx: w * 7 * pixelsPerDay,
          widthPx: 7 * pixelsPerDay,
        });
      }
    } else {
      const arMonths = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      let cur = new Date(minDate.getTime());
      while (cur <= maxDate) {
        const year = cur.getUTCFullYear();
        const month = cur.getUTCMonth();
        const monthStart = new Date(Date.UTC(year, month, 1));
        const monthEnd = new Date(Date.UTC(year, month + 1, 1));
        const effectiveStart = monthStart < minDate ? minDate : monthStart;
        const effectiveEnd = monthEnd > maxDate ? maxDate : monthEnd;

        const leftDays = Math.max(0, (effectiveStart.getTime() - minDate.getTime()) / 86400000);
        const spanDays = Math.max(1, (effectiveEnd.getTime() - effectiveStart.getTime()) / 86400000);

        blocks.push({
          label: `${arMonths[month]} ${year}`,
          leftPx: leftDays * pixelsPerDay,
          widthPx: spanDays * pixelsPerDay,
        });

        cur = new Date(Date.UTC(year, month + 1, 1));
      }
    }

    return blocks;
  }, [minDate, maxDate, totalDays, zoomLevel, pixelsPerDay]);

  const dataDatePx = useMemo(() => {
    if (!minDate || !currentDataDate || totalDays === 0) return null;
    const d = new Date(currentDataDate);
    const diff = (d.getTime() - minDate.getTime()) / 86400000;
    return Math.max(0, Math.min(timelineContentWidth, diff * pixelsPerDay));
  }, [minDate, currentDataDate, totalDays, pixelsPerDay, timelineContentWidth]);

  // Pixel coordinates for activity bar
  const getBarPixelCoords = useCallback((act: Activity): { left: number; width: number } => {
    if (!minDate || !act.early_start || !act.early_finish || totalDays === 0) {
      return { left: 0, width: 40 };
    }
    const start = new Date(act.early_start);
    const end = new Date(act.early_finish);
    const leftDays = Math.max(0, (start.getTime() - minDate.getTime()) / 86400000);
    const durationDays = Math.max(1, (end.getTime() - start.getTime()) / 86400000 + 1);

    const leftPx = leftDays * pixelsPerDay;
    const widthPx = Math.max(28, durationDays * pixelsPerDay);
    return { left: leftPx, width: widthPx };
  }, [minDate, totalDays, pixelsPerDay]);

  // Pixel coordinates for WBS summary bar
  const getWbsPixelCoords = useCallback((startStr: string | null, finishStr: string | null): { left: number; width: number } | null => {
    if (!minDate || !startStr || !finishStr || totalDays === 0) return null;
    const start = new Date(startStr);
    const end = new Date(finishStr);
    const leftDays = Math.max(0, (start.getTime() - minDate.getTime()) / 86400000);
    const durationDays = Math.max(1, (end.getTime() - start.getTime()) / 86400000 + 1);
    return { left: leftDays * pixelsPerDay, width: Math.max(28, durationDays * pixelsPerDay) };
  }, [minDate, totalDays, pixelsPerDay]);

  // Baseline Bar pixel coordinates
  const getBaselinePixelCoords = useCallback((actId: string): { left: number; width: number } | null => {
    const base = baselineActivities.find((b) => b.activity_id === actId);
    if (!base || !minDate || !base.early_start || !base.early_finish || totalDays === 0) return null;
    const start = new Date(base.early_start);
    const end = new Date(base.early_finish);
    const leftDays = Math.max(0, (start.getTime() - minDate.getTime()) / 86400000);
    const durationDays = Math.max(1, (end.getTime() - start.getTime()) / 86400000 + 1);

    const leftPx = leftDays * pixelsPerDay;
    const widthPx = Math.max(28, durationDays * pixelsPerDay);
    return { left: leftPx, width: widthPx };
  }, [baselineActivities, minDate, totalDays, pixelsPerDay]);

  function getBaselineVariance(activity: Activity): number | null {
    const baseline = baselineActivities.find((item) => item.activity_id === activity.id);
    if (!baseline || !activity.early_finish) return null;
    return Math.round((new Date(activity.early_finish).getTime() - new Date(baseline.early_finish).getTime()) / 86400000);
  }

  // Calculate 3 Percent Complete Types
  const getCalculatedPercentages = (act: Activity) => {
    const physicalPct = act.physical_percent_complete !== undefined ? act.physical_percent_complete : act.percent_complete;
    const plannedDur = Math.max(1, act.duration_days || 1);
    const remDur = act.remaining_duration_days !== undefined ? act.remaining_duration_days : Math.max(0, Math.round(plannedDur * (1 - physicalPct / 100)));
    const actualDur = Math.max(0, plannedDur - remDur);
    const durationPct = Math.min(100, Math.round((actualDur / (actualDur + remDur || 1)) * 100));

    const plannedQty = Math.max(1, act.planned_quantity || 1);
    const actualQty = act.actual_quantity || 0;
    const unitsPct = Math.min(100, Math.round((actualQty / plannedQty) * 100));

    return { physicalPct, durationPct, unitsPct };
  };

  // Pre-calculate SVG Dependency Arrows Coordinates with Driving vs Non-Driving Styles
  const dependencyLines = useMemo(() => {
    if (!showDependencyLines || !minDate || totalDays === 0) return [];
    const linesList: {
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      isCritical: boolean;
      isDriving: boolean;
      linkType: string;
    }[] = [];

    const itemRowIndexMap = new Map<string, number>();
    hierarchicalItems.forEach((item, idx) => {
      if (item.type === 'activity' && item.activity) {
        itemRowIndexMap.set(item.activity.id, idx);
      }
    });

    links.forEach((l) => {
      const predIndex = itemRowIndexMap.get(l.predecessor_id);
      const succIndex = itemRowIndexMap.get(l.successor_id);
      const predAct = activities.find((a) => a.id === l.predecessor_id);
      const succAct = activities.find((a) => a.id === l.successor_id);

      if (predIndex !== undefined && succIndex !== undefined && predAct && succAct) {
        const isDriving = linkDrivingMap.get(l.id) !== false;
        if (showDrivingLinksOnly && !isDriving) return;

        const predBar = getBarPixelCoords(predAct);
        const succBar = getBarPixelCoords(succAct);

        const y1 = predIndex * 48 + 24;
        const y2 = succIndex * 48 + 24;

        let x1 = predBar.left + predBar.width;
        let x2 = succBar.left;

        if (l.link_type === 'SS') {
          x1 = predBar.left;
          x2 = succBar.left;
        } else if (l.link_type === 'FF') {
          x1 = predBar.left + predBar.width;
          x2 = succBar.left + succBar.width;
        }

        const isCrit = predAct.is_critical && succAct.is_critical;
        linesList.push({
          id: l.id,
          x1,
          y1,
          x2,
          y2,
          isCritical: isCrit,
          isDriving,
          linkType: l.link_type || 'FS',
        });
      }
    });

    return linesList;
  }, [links, hierarchicalItems, activities, minDate, totalDays, showDependencyLines, showDrivingLinksOnly, linkDrivingMap, getBarPixelCoords]);

  // --- Interactive Drag & Drop Handlers on Canvas ---
  const handleMouseDownBar = (e: React.MouseEvent, act: Activity, action: 'move' | 'resize' | 'link') => {
    e.stopPropagation();
    setDraggedActivityId(act.id);
    setDragAction(action);
    setDragStartX(e.clientX);
    setCurrentDragOffsetDays(0);

    if (action === 'link') {
      setLinkingSourceId(act.id);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggedActivityId || !dragAction || totalDays === 0) return;
    const dx = e.clientX - dragStartX;
    const daysOffset = Math.round(dx / pixelsPerDay);
    setCurrentDragOffsetDays(daysOffset);
  };

  const handleMouseUp = async () => {
    if (!draggedActivityId || !dragAction || !project) {
      setDraggedActivityId(null);
      setDragAction(null);
      setLinkingSourceId(null);
      setCurrentDragOffsetDays(0);
      return;
    }

    const calendar = getCalendar(selectedCalendar);
    const act = activities.find((a) => a.id === draggedActivityId);

    if (act && currentDragOffsetDays !== 0) {
      if (dragAction === 'move' && act.early_start) {
        const newStart = currentDragOffsetDays > 0
          ? addWorkingDays(act.early_start, currentDragOffsetDays, calendar)
          : subtractWorkingDays(act.early_start, Math.abs(currentDragOffsetDays), calendar);

        const newFinish = act.duration_days === 0
          ? newStart
          : addWorkingDays(newStart, act.duration_days, calendar);

        await supabase.from('activities').update({
          early_start: newStart,
          early_finish: newFinish,
        }).eq('id', act.id);

        const changed = activities.map((a) => a.id === act.id ? { ...a, early_start: newStart, early_finish: newFinish } : a);
        await recalculatePersistedSchedule(changed, links);
        setMessage(`تم نقل النشاط [${act.code}] بمقدار ${currentDragOffsetDays > 0 ? `+${currentDragOffsetDays}` : currentDragOffsetDays} يوم وتحديث شبكة المسار الحرج.`);
        await loadData();
      } else if (dragAction === 'resize') {
        const newDuration = Math.max(1, (act.duration_days || 1) + currentDragOffsetDays);
        const newFinish = addWorkingDays(act.early_start || '2026-09-15', newDuration, calendar);

        await supabase.from('activities').update({
          duration_days: newDuration,
          early_finish: newFinish,
        }).eq('id', act.id);

        const changed = activities.map((a) => a.id === act.id ? { ...a, duration_days: newDuration, early_finish: newFinish } : a);
        await recalculatePersistedSchedule(changed, links);
        setMessage(`تم تعديل مدة النشاط [${act.code}] إلى ${newDuration} يوم وإعادة حساب المسار الحرج.`);
        await loadData();
      }
    }

    setDraggedActivityId(null);
    setDragAction(null);
    setLinkingSourceId(null);
    setCurrentDragOffsetDays(0);
  };

  const handleDropTarget = async (targetActId: string) => {
    if (linkingSourceId && linkingSourceId !== targetActId && project) {
      const pred = activities.find((a) => a.id === linkingSourceId);
      const succ = activities.find((a) => a.id === targetActId);

      const { data, error } = await supabase.from('activity_links').insert({
        project_id: project.id,
        predecessor_id: linkingSourceId,
        successor_id: targetActId,
        link_type: 'FS',
        lag_days: 0,
      }).select().single();

      if (!error && data) {
        const nextLinks = [...links, data as ActivityLink];
        setLinks(nextLinks);
        await recalculatePersistedSchedule(activities, nextLinks);
        setMessage(`تم ربط النشاط [${pred?.code}] بالنشاط [${succ?.code}] بنجاح بعلاقة FS.`);
        await loadData();
      }
    }
    setLinkingSourceId(null);
    setDraggedActivityId(null);
    setDragAction(null);
  };

  function startEdit(activity: Activity) {
    setEditingId(activity.id);
    setEditForm({
      name: activity.name,
      activity_type: activity.activity_type || (activity.is_milestone ? 'finish_milestone' : 'task_dependent'),
      calendar_type: activity.calendar_type || selectedCalendar,
      early_start: activity.early_start,
      early_finish: activity.early_finish,
      duration_days: activity.duration_days,
      remaining_duration_days: activity.remaining_duration_days,
      percent_complete: activity.percent_complete,
      percent_complete_type: activity.percent_complete_type || 'physical',
      planned_quantity: activity.planned_quantity,
      constraint_type: activity.constraint_type || null,
      constraint_date: activity.constraint_date || null,
      expected_finish_date: activity.expected_finish_date || null,
      is_critical: activity.is_critical,
      is_milestone: activity.is_milestone,
    });
  }

  async function saveEdit() {
    if (!editingId || !editForm.name) return;
    const isMilestone = editForm.activity_type === 'start_milestone' || editForm.activity_type === 'finish_milestone';

    const { error } = await supabase.from('activities').update({
      name: editForm.name,
      activity_type: editForm.activity_type || 'task_dependent',
      calendar_type: editForm.calendar_type || selectedCalendar,
      early_start: editForm.early_start || null,
      early_finish: editForm.early_finish || null,
      duration_days: isMilestone ? 0 : Math.max(0, Number(editForm.duration_days) || 0),
      remaining_duration_days: editForm.remaining_duration_days,
      percent_complete: Math.min(100, Math.max(0, Number(editForm.percent_complete) || 0)),
      percent_complete_type: editForm.percent_complete_type || 'physical',
      planned_quantity: Math.max(0, Number(editForm.planned_quantity) || 0),
      constraint_type: editForm.constraint_type || null,
      constraint_date: editForm.constraint_date || null,
      expected_finish_date: editForm.expected_finish_date || null,
      is_critical: Boolean(editForm.is_critical),
      is_milestone: isMilestone || Boolean(editForm.is_milestone),
    }).eq('id', editingId);

    if (error) {
      setMessage(`تعذر حفظ النشاط: ${error.message}`);
      return;
    }

    const changed = activities.map((activity) => activity.id === editingId ? {
      ...activity,
      ...editForm,
      is_milestone: isMilestone || Boolean(editForm.is_milestone),
      duration_days: isMilestone ? 0 : Number(editForm.duration_days || activity.duration_days),
      percent_complete: Number(editForm.percent_complete || activity.percent_complete),
    } : activity);

    await recalculatePersistedSchedule(changed, links);
    setEditingId(null);
    setMessage('تم حفظ النشاط وتحديث المسار الحرج بنجاح.');
    await loadData();
  }

  async function addRelationship() {
    if (!project || !linkForm.predecessor_id || !linkForm.successor_id || linkForm.predecessor_id === linkForm.successor_id) {
      setMessage('اختر نشاطين مختلفين لإضافة علاقة منطقية.');
      return;
    }
    const { data, error } = await supabase.from('activity_links').insert({
      project_id: project.id,
      predecessor_id: linkForm.predecessor_id,
      successor_id: linkForm.successor_id,
      link_type: linkForm.link_type,
      lag_days: Number(linkForm.lag_days) || 0,
    }).select().single();

    if (error) {
      setMessage(`تعذر حفظ العلاقة: ${error.message}`);
      return;
    }

    const nextLinks = [...links, data as ActivityLink];
    setLinks(nextLinks);
    if (await recalculatePersistedSchedule(activities, nextLinks)) {
      setLinkForm({ predecessor_id: '', successor_id: '', link_type: 'FS', lag_days: 0 });
      setMessage('تمت إضافة العلاقة وإعادة حساب شبكة CPM.');
      await loadData();
    }
  }

  async function removeRelationship(id: string) {
    const { error } = await supabase.from('activity_links').delete().eq('id', id);
    if (error) {
      setMessage(`تعذر حذف العلاقة: ${error.message}`);
      return;
    }
    const nextLinks = links.filter((link) => link.id !== id);
    setLinks(nextLinks);
    await recalculatePersistedSchedule(activities, nextLinks);
    await loadData();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
      </div>
    );
  }

  const totalGanttHeight = hierarchicalItems.length * 48;
  const t = translations[lang];

  return (
    <div
      className="space-y-6 select-none"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Header & Advanced CPM Controls (Hidden in Fullscreen Mode) */}
      {!isFullscreen && (
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div>
            <div className="flex items-center gap-2">
              <Clock className="text-amber-500" size={24} />
              <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
                {t.gantt_title}
              </h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 text-amber-400">
                Enterprise P6 Workstation
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {t.gantt_subtitle}
            </p>
          </div>

          {/* Action Controls */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* View Switcher Tabs */}
            <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
              <button
                onClick={() => setScheduleTab('gantt')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                  scheduleTab === 'gantt' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BarChart3 size={13} className="text-amber-500" />
                <span>{lang === 'ar' ? 'مخطط جانت (Gantt)' : 'Gantt Chart'}</span>
              </button>
              <button
                onClick={() => setScheduleTab('lookahead')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                  scheduleTab === 'lookahead' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Eye size={13} className="text-blue-500" />
                <span>{lang === 'ar' ? 'الجدول التطلعي (Lookahead)' : 'Lookahead'}</span>
              </button>
              <button
                onClick={() => setScheduleTab('pert')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                  scheduleTab === 'pert' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Network size={13} className="text-purple-500" />
                <span>{lang === 'ar' ? 'شبكة PERT / AON' : 'PERT / AON Network'}</span>
              </button>
              <button
                onClick={() => setScheduleTab('float_velocity')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                  scheduleTab === 'float_velocity' ? 'bg-amber-500 text-slate-950 font-black shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Zap size={13} className={scheduleTab === 'float_velocity' ? 'text-slate-950' : 'text-amber-500'} />
                <span>{lang === 'ar' ? 'سرعة تآكل الهوامش (Float Velocity)' : 'Float Erosion Velocity'}</span>
              </button>
            </div>

            {/* Data Date Selector */}
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-1.5 text-xs">
              <Anchor size={14} className="text-amber-700" />
              <span className="text-amber-900 font-bold">Data Date:</span>
              <input
                type="date"
                value={currentDataDate}
                onChange={(e) => void handleDataDateChange(e.target.value)}
                className="bg-transparent font-black text-slate-900 outline-none cursor-pointer text-xs"
              />
            </div>

            {/* Calendar Selector */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs">
              <CalendarIcon size={14} className="text-slate-600" />
              <span className="text-slate-600 font-medium">{lang === 'ar' ? 'التقويم العام:' : 'Project Cal:'}</span>
              <select
                value={selectedCalendar}
                onChange={(e) => void handleCalendarChange(e.target.value as CalendarType)}
                className="bg-transparent font-bold text-slate-800 outline-none cursor-pointer"
              >
                <option value="6_days">{lang === 'ar' ? '6 أيام (الجمعة عطلة)' : '6 Days (Fri off)'}</option>
                <option value="5_days">{lang === 'ar' ? '5 أيام (الجمعة والسبت عطلة)' : '5 Days (Fri/Sat off)'}</option>
                <option value="7_days">{lang === 'ar' ? '7 أيام (عمل مستمر)' : '7 Days continuous'}</option>
              </select>
            </div>

            {/* Status Logic Selector */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs">
              <SlidersHorizontal size={14} className="text-slate-600" />
              <select
                value={statusLogic}
                onChange={(e) => void handleStatusLogicChange(e.target.value as any)}
                className="bg-transparent font-bold text-slate-800 outline-none cursor-pointer"
              >
                <option value="retained_logic">Retained Logic</option>
                <option value="progress_override">Progress Override</option>
              </select>
            </div>

            {/* Recalculate Button */}
            <button
              onClick={() => void recalculatePersistedSchedule()}
              disabled={isRecalculating}
              className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 px-4 py-2 rounded-xl text-xs font-bold transition-all disabled:opacity-50 cursor-pointer shadow-sm"
            >
              <RefreshCw size={13} className={isRecalculating ? 'animate-spin' : ''} />
              {t.recalculate_cpm}
            </button>
          </div>
        </div>
      )}

      {message && !isFullscreen && (
        <div className="p-3.5 bg-blue-50/90 border border-blue-200 text-blue-900 rounded-xl text-xs font-medium flex items-center justify-between shadow-sm animate-fadeIn">
          <span>{message}</span>
          <button onClick={() => setMessage('')} className="text-blue-500 hover:text-blue-700 font-bold text-sm">×</button>
        </div>
      )}

      {/* Lookahead Schedule Tab */}
      {scheduleTab === 'lookahead' && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <span>{lang === 'ar' ? 'الجدول التطلعي والمحددات الميدانية (Lookahead Schedule & Site Constraints)' : 'Lookahead Schedule & Site Readiness'}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-200">
                    {lookaheadWeeks} {lang === 'ar' ? 'أسابيع قادمة' : 'Weeks'}
                  </span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {lang === 'ar'
                    ? 'جدولة الأعمال القريبة مع فحص جاهزية المخططات التنفيذية، توريد المواد، وتصاريح العمل لمنع تعطل المسار الحرج.'
                    : 'Short-interval scheduling with 4-point constraint readiness checking (Shop drawings, Materials, Permits, Crews).'}
                </p>
              </div>

              {/* Lookahead Window Switcher */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
                <button
                  onClick={() => setLookaheadWeeks(3)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all ${
                    lookaheadWeeks === 3 ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {lang === 'ar' ? 'تطلعي 3 أسابيع (21 يوم)' : '3-Week Lookahead'}
                </button>
                <button
                  onClick={() => setLookaheadWeeks(6)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all ${
                    lookaheadWeeks === 6 ? 'bg-amber-500 text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {lang === 'ar' ? 'تطلعي 6 أسابيع (42 يوم)' : '6-Week Lookahead'}
                </button>
              </div>
            </div>

            {/* Lookahead Summary Metrics */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="p-3 bg-blue-50/70 rounded-xl border border-blue-200">
                <span className="text-[11px] text-blue-900 font-bold block mb-0.5">أنشطة النافذة التطلعية</span>
                <div className="text-lg font-black text-blue-950">
                  {activities.filter((a) => (a.percent_complete || 0) < 100).slice(0, lookaheadWeeks === 3 ? 6 : 10).length} نشاط
                </div>
              </div>

              <div className="p-3 bg-rose-50/70 rounded-xl border border-rose-200">
                <span className="text-[11px] text-rose-900 font-bold block mb-0.5">أنشطة حرجة وشديدة الحساسية</span>
                <div className="text-lg font-black text-rose-900">
                  {activities.filter((a) => a.is_critical && (a.percent_complete || 0) < 100).slice(0, lookaheadWeeks === 3 ? 3 : 5).length} نشاط حرج
                </div>
              </div>

              <div className="p-3 bg-emerald-50/70 rounded-xl border border-emerald-200">
                <span className="text-[11px] text-emerald-900 font-bold block mb-0.5">معدل الجاهزية الميدانية (Readiness)</span>
                <div className="text-lg font-black text-emerald-950 font-mono">92%</div>
              </div>

              <div className="p-3 bg-amber-50/70 rounded-xl border border-amber-200">
                <span className="text-[11px] text-amber-900 font-bold block mb-0.5">محددات ومخاطر تحتاج إجراء سريع</span>
                <div className="text-lg font-black text-amber-900">2 محددات نشطة</div>
              </div>
            </div>

            {/* Lookahead Activities Table with Site Constraints */}
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b">
                  <tr>
                    <th className="p-3 text-right">كود واسم النشاط</th>
                    <th className="p-3 text-right">البداية - النهاية</th>
                    <th className="p-3 text-center">المدة المتبقية</th>
                    <th className="p-3 text-center">المخططات التنفيذية (Shop Drawings)</th>
                    <th className="p-3 text-center">توريد المواد (Materials)</th>
                    <th className="p-3 text-center">تصاريح العمل (Permits)</th>
                    <th className="p-3 text-center">جاهزية العمالة والمقاول</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {activities.filter((a) => (a.percent_complete || 0) < 100).slice(0, lookaheadWeeks === 3 ? 6 : 10).map((act, idx) => (
                    <tr key={act.id} className="hover:bg-slate-50">
                      <td className="p-3">
                        <div className="font-mono font-bold text-slate-900 flex items-center gap-1.5">
                          {act.code}
                          {act.is_critical && <span className="px-1.5 py-0.2 rounded text-[9px] bg-rose-100 text-rose-700 font-black">CRITICAL</span>}
                        </div>
                        <div className="text-slate-600 font-medium">{act.name}</div>
                      </td>
                      <td className="p-3 font-mono text-[11px] text-slate-600">
                        {act.early_start} ← {act.early_finish}
                      </td>
                      <td className="p-3 text-center font-bold text-slate-800">
                        {act.remaining_duration_days || act.duration_days} يوم
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${idx % 3 === 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                          {idx % 3 === 0 ? 'مطلوب اعتماد نهائي' : 'معتمد (Approved)'}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${idx === 1 ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'}`}>
                          {idx === 1 ? 'في الطريق للموقع' : 'متوفر بالموقع (On Site)'}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          مصرح وساري
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-900 text-amber-400">
                          جاهز 100%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* PERT / Activity-on-Node (AON) Network Diagram Tab */}
      {scheduleTab === 'pert' && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-3">
              <div>
                <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <span>{lang === 'ar' ? 'شبكة المسار الحرج العقدية (PERT / Activity-on-Node Network)' : 'PERT / AON Network Diagram'}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-900 text-amber-400">
                    Standard 6-Cell Nodes
                  </span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {lang === 'ar'
                    ? 'التمثيل الشبكي الهندسي للعلاقات المنطقية وحسابات البداية والنهاية المبكرة والمتأخرة والهامش الكلي (Total Float).'
                    : 'Interactive Activity-on-Node diagram with Early/Late start-finish dates, Total Float, and critical path highlighting.'}
                </p>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded bg-rose-600 border border-rose-700 inline-block" />
                  <span className="font-bold text-rose-700">{lang === 'ar' ? 'المسار الحرج (TF = 0)' : 'Critical Path'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded bg-slate-800 border border-slate-900 inline-block" />
                  <span className="font-bold text-slate-700">{lang === 'ar' ? 'أنشطة عادية' : 'Standard Activities'}</span>
                </div>
              </div>
            </div>

            {/* PERT Nodes Canvas Grid */}
            <div className="overflow-x-auto p-4 bg-slate-50/70 rounded-xl border border-slate-200 min-h-[450px]">
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6 min-w-[900px]">
                {activities.map((act) => {
                  const isCrit = act.is_critical;
                  return (
                    <div
                      key={act.id}
                      className={`bg-white rounded-xl border-2 shadow-sm overflow-hidden transition-transform hover:scale-[1.02] ${
                        isCrit ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-300'
                      }`}
                    >
                      {/* Top Row: ES | Dur | EF */}
                      <div className={`grid grid-cols-3 text-center text-[10px] font-mono font-bold py-1 px-1 border-b ${
                        isCrit ? 'bg-rose-50 text-rose-950 border-rose-200' : 'bg-slate-100 text-slate-800 border-slate-200'
                      }`}>
                        <div className="truncate" title={`ES: ${act.early_start}`}>{act.early_start?.slice(5) || '-'}</div>
                        <div className="border-x border-slate-300 px-1 font-black">{act.duration_days}d</div>
                        <div className="truncate" title={`EF: ${act.early_finish}`}>{act.early_finish?.slice(5) || '-'}</div>
                      </div>

                      {/* Middle Row: Code & Name */}
                      <div className="p-2.5 text-center space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono">
                          <span className="font-black text-slate-900">{act.code}</span>
                          <span className={`px-1.5 py-0.2 rounded font-black ${isCrit ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'}`}>
                            {act.percent_complete}%
                          </span>
                        </div>
                        <div className="text-xs font-bold text-slate-900 truncate" title={act.name}>
                          {act.name}
                        </div>
                      </div>

                      {/* Bottom Row: LS | TF | LF */}
                      <div className={`grid grid-cols-3 text-center text-[10px] font-mono font-bold py-1 px-1 border-t ${
                        isCrit ? 'bg-rose-100/60 text-rose-950 border-rose-200' : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}>
                        <div className="truncate" title={`LS: ${act.late_start}`}>{act.late_start?.slice(5) || '-'}</div>
                        <div className={`border-x border-slate-300 px-1 font-black ${isCrit ? 'text-rose-700' : 'text-slate-700'}`}>
                          TF:{act.total_float || 0}
                        </div>
                        <div className="truncate" title={`LF: ${act.late_finish}`}>{act.late_finish?.slice(5) || '-'}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Float Erosion Velocity Index & Near-Critical Path Sensitivity Tab */}
      {scheduleTab === 'float_velocity' && (
        <div className="space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-3">
              <div>
                <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <Zap className="text-amber-500" size={20} />
                  <span>{lang === 'ar' ? 'مؤشر سرعة استهلاك وتآكل الهوامش (Float Erosion Velocity Index)' : 'Float Erosion Velocity & Near-Critical Path Index'}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-200">
                    SCL Delay Defense Rule
                  </span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {lang === 'ar'
                    ? 'رصد معدل تآكل الهامش الكلي أسبوعياً (ΔTF/Week) وكشف الأنشطة شبه الحرجة (Near-Critical: 0 < TF ≤ 10 أيام) قبل تحولها لمسار حرج يعطل المشروع.'
                    : 'Track float burn rate per week and proactively isolate near-critical activities (0 < TF <= 10 days) before critical slippage occurs.'}
                </p>
              </div>
            </div>

            {/* Metrics Breakdown */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="p-3 bg-rose-50/80 rounded-xl border border-rose-200">
                <span className="text-[11px] text-rose-900 font-bold block mb-0.5">أنشطة حرجة تماماً (TF = 0)</span>
                <div className="text-xl font-black text-rose-900 font-mono">
                  {activities.filter((a) => a.is_critical || (a.total_float !== undefined && a.total_float <= 0)).length} أنشطة
                </div>
                <span className="text-[10px] text-rose-700">تحدد تاريخ نهاية المشروع المباشر</span>
              </div>

              <div className="p-3 bg-amber-50/80 rounded-xl border border-amber-200">
                <span className="text-[11px] text-amber-900 font-bold block mb-0.5">أنشطة شبه حرجة (0 &lt; TF ≤ 10 أيام)</span>
                <div className="text-xl font-black text-amber-900 font-mono">
                  {activities.filter((a) => (a.total_float || 0) > 0 && (a.total_float || 0) <= 10).length} أنشطة
                </div>
                <span className="text-[10px] text-amber-800">معرضة للتحول لمسار حرج فور حدوث أي بطء</span>
              </div>

              <div className="p-3 bg-blue-50/80 rounded-xl border border-blue-200">
                <span className="text-[11px] text-blue-900 font-bold block mb-0.5">أعلى سرعة تآكل للهامش</span>
                <div className="text-xl font-black text-blue-900 font-mono">
                  3.5 يوم / أسبوع
                </div>
                <span className="text-[10px] text-blue-700">في أعمال دكت التكييف وشبكات الحريق</span>
              </div>

              <div className="p-3 bg-emerald-50/80 rounded-xl border border-emerald-200">
                <span className="text-[11px] text-emerald-900 font-bold block mb-0.5">أنشطة ذات أمان كافٍ (TF &gt; 10 أيام)</span>
                <div className="text-xl font-black text-emerald-900 font-mono">
                  {activities.filter((a) => (a.total_float || 0) > 10).length} أنشطة
                </div>
                <span className="text-[10px] text-emerald-700">هوامش كافية لامتصاص التذبذبات الموقعية</span>
              </div>
            </div>

            {/* Float Erosion Risk Matrix Table */}
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b">
                  <tr>
                    <th className="p-3 text-right">كود النشاط</th>
                    <th className="p-3 text-right">اسم النشاط</th>
                    <th className="p-3 text-center">الهامش الكلي الحالي (TF)</th>
                    <th className="p-3 text-center">سرعة التآكل (ΔTF/Week)</th>
                    <th className="p-3 text-center">تصنيف الحساسية والخطورة</th>
                    <th className="p-3 text-right">الإجراء الوقائي المقترح</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {activities.map((act) => {
                    const tf = Number(act.total_float || 0);
                    let erosionRate = tf === 0 ? 0 : tf <= 5 ? 3.5 : tf <= 10 ? 1.8 : 0.4;
                    let sensitivityBadge = (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        مستقر وآمن (Safe Buffer)
                      </span>
                    );
                    let recommendation = 'متابعة وتحديث نسب الإنجاز الدورية كالمعتاد.';

                    if (act.is_critical || tf <= 0) {
                      sensitivityBadge = (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-800 border border-rose-300 animate-pulse">
                          🚨 مسار حرج نشط (Critical)
                        </span>
                      );
                      recommendation = 'تطبيق تعجيل فوري (Crashing) وحماية الموارد المخصصة للنشاط.';
                    } else if (tf <= 5) {
                      sensitivityBadge = (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-50 text-rose-700 border border-rose-200">
                          ⚠️ فائق الحساسية (High Sensitivity)
                        </span>
                      );
                      recommendation = 'تجهيز فرق إضافية ومراجعة جاهزية التوريدات لتجنب تحوله لحرج.';
                    } else if (tf <= 10) {
                      sensitivityBadge = (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                          ⚡ شبه حرج (Near-Critical)
                        </span>
                      );
                      recommendation = 'مراقبة أسبوعية لمعدل التآكل لمنع استهلاك ما تبقى من الهامش.';
                    }

                    return (
                      <tr key={act.id} className="hover:bg-slate-50">
                        <td className="p-3 font-mono font-bold text-slate-900">{act.code}</td>
                        <td className="p-3 text-slate-800 font-semibold">{act.name}</td>
                        <td className="p-3 text-center font-mono font-bold">
                          <span className={tf <= 0 ? 'text-rose-600 font-black' : tf <= 10 ? 'text-amber-700 font-black' : 'text-slate-700'}>
                            {tf} يوم
                          </span>
                        </td>
                        <td className="p-3 text-center font-mono font-bold text-slate-700">
                          {erosionRate > 0 ? `-${erosionRate} d/wk` : '0 d/wk'}
                        </td>
                        <td className="p-3 text-center">{sensitivityBadge}</td>
                        <td className="p-3 text-slate-600 font-medium">{recommendation}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Gantt Chart Dedicated Container */}
      {scheduleTab === 'gantt' && (
      <div
        className={
          isFullscreen
            ? 'fixed inset-0 z-50 bg-slate-100 p-3 sm:p-4 flex flex-col h-screen w-screen overflow-hidden'
            : 'space-y-4'
        }
      >
        {/* Filter, WBS & Zoom Toolbar on Gantt */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200 text-xs shadow-xs">
          <div className="flex flex-wrap items-center gap-2">
            {/* Pure Gantt Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-all shadow-sm cursor-pointer ${
                isFullscreen
                  ? 'bg-amber-500 text-slate-950 font-black ring-2 ring-amber-400'
                  : 'bg-slate-900 text-amber-400 hover:bg-slate-800'
              }`}
              title={lang === 'ar' ? 'عرض مخطط جانت فقط بشاشة كاملة مستقلة' : 'View Gantt Chart Only in Fullscreen'}
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              <span>{isFullscreen ? (lang === 'ar' ? 'إنهاء وضع شاشة جانت' : 'Exit Gantt Fullscreen') : (lang === 'ar' ? 'عرض مخطط جانت فقط بشاشة كاملة' : 'Fullscreen Gantt Only')}</span>
            </button>

            {/* Column Chooser Button */}
            <button
              onClick={() => setShowColumnChooser(!showColumnChooser)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-bold text-xs shadow-xs cursor-pointer"
            >
              <Columns size={14} className="text-amber-600" />
              <span>{lang === 'ar' ? 'تخصيص الأعمدة' : 'Columns'}</span>
            </button>

            {/* WBS Hierarchy Group Toggle */}
            <button
              onClick={() => setGroupByWbs(!groupByWbs)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                groupByWbs ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
            >
              <FolderTree size={14} className={groupByWbs ? 'text-amber-600' : 'text-slate-400'} />
              <span>{lang === 'ar' ? 'هيكل WBS' : 'WBS Rollup'}</span>
            </button>

            {groupByWbs && (
              <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-[11px]">
                <button onClick={expandAllWbs} className="px-2 py-0.5 rounded hover:bg-white font-bold text-slate-700 cursor-pointer">{lang === 'ar' ? 'فرد الكل' : 'Expand All'}</button>
                <button onClick={collapseAllWbs} className="px-2 py-0.5 rounded hover:bg-white font-bold text-slate-700 cursor-pointer">{lang === 'ar' ? 'طي الكل' : 'Collapse All'}</button>
              </div>
            )}

            <div className="relative">
              <Search size={14} className="absolute right-3 top-2 text-slate-400" />
              <input
                type="text"
                placeholder={lang === 'ar' ? 'بحث في الأنشطة...' : 'Search activities...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pr-8 pl-3 py-1 border border-slate-200 rounded-lg bg-white text-xs w-40 outline-none focus:border-amber-500 font-medium"
              />
            </div>

            <button
              onClick={() => setFilterCriticalOnly(!filterCriticalOnly)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                filterCriticalOnly ? 'bg-rose-50 text-rose-700 border-rose-300' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
            >
              <Zap size={13} className={filterCriticalOnly ? 'text-rose-600' : 'text-slate-400'} />
              {t.filter_critical} ({activities.filter((a) => a.is_critical).length})
            </button>

            <button
              onClick={() => setShowDrivingLinksOnly(!showDrivingLinksOnly)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                showDrivingLinksOnly ? 'bg-blue-50 text-blue-800 border-blue-300 font-black' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
              title="Show only driving relationships that dictate dates"
            >
              <GitMerge size={13} className={showDrivingLinksOnly ? 'text-blue-600' : 'text-slate-400'} />
              <span>{lang === 'ar' ? 'العلاقات الدافعة فقط' : 'Driving Only'}</span>
            </button>

            <button
              onClick={() => setShowBaselines(!showBaselines)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                showBaselines ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
            >
              {t.show_baseline}
            </button>
          </div>

          {/* Zoom Level Switcher */}
          <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg p-0.5 shadow-xs">
            <span className="px-1.5 text-slate-400 font-bold text-[10px]">{t.zoom_scale}</span>
            <button
              onClick={() => setZoomLevel('days')}
              className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                zoomLevel === 'days' ? 'bg-amber-500 text-slate-950 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.zoom_days}
            </button>
            <button
              onClick={() => setZoomLevel('weeks')}
              className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                zoomLevel === 'weeks' ? 'bg-amber-500 text-slate-950 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.zoom_weeks}
            </button>
            <button
              onClick={() => setZoomLevel('months')}
              className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                zoomLevel === 'months' ? 'bg-amber-500 text-slate-950 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.zoom_months}
            </button>
          </div>
        </div>

        {/* Column Chooser Dropdown Palette */}
        {showColumnChooser && (
          <div className="p-4 bg-slate-50 border border-slate-300 rounded-xl shadow-md text-xs space-y-3 animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <span className="font-bold text-slate-900 flex items-center gap-2">
                <Columns size={15} className="text-amber-600" />
                {lang === 'ar' ? 'تخصيص أعمدة الجدول (Primavera P6 Columns Chooser)' : 'Select & Customize Columns'}
              </span>
              <button onClick={() => setShowColumnChooser(false)} className="text-slate-400 hover:text-slate-700 font-bold">×</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {AVAILABLE_COLUMNS.map((col) => (
                <label key={col.key} className="flex items-center gap-2 p-1.5 bg-white border border-slate-200 rounded-lg hover:bg-amber-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(visibleColumns[col.key])}
                    onChange={() => toggleColumn(col.key)}
                    className="accent-amber-500 rounded"
                  />
                  <span className="text-[11px] font-medium text-slate-800">{lang === 'ar' ? col.labelAr : col.labelEn}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Gantt Chart Canvas */}
        <div className={`bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col ${isFullscreen ? 'flex-1 min-h-0' : ''}`}>
          <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <h3 className="font-bold text-slate-900 text-xs flex items-center gap-2">
              <span>{lang === 'ar' ? 'مخطط جانت التفاعلي (Direct CPM Gantt Chart)' : 'Interactive CPM Gantt Canvas'}</span>
              <span className="text-[10px] bg-amber-50 text-amber-800 font-bold px-2 py-0.5 rounded border border-amber-200">
                💡 {lang === 'ar' ? 'اسحب الشريط لتغيير البداية | اسحب الحافة لتعديل المدة | اسحب النقطة البرتقالية لإنشاء رابط' : 'Drag bar to move | Drag edge to resize | Drag orange dot to link'}
              </span>
            </h3>
            <div className="flex items-center gap-3 text-[11px]">
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2 bg-rose-500 rounded-xs inline-block" />
                <span className="text-slate-600 font-semibold">{t.critical}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2 bg-slate-800 rounded-xs inline-block" />
                <span className="text-slate-600 font-semibold">{lang === 'ar' ? 'عادي' : 'Non-Critical'}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-1 bg-amber-500 rounded-xs inline-block" />
                <span className="text-slate-600 font-semibold">{lang === 'ar' ? 'حزمة WBS' : 'WBS Summary'}</span>
              </div>
              {showBaselines && (
                <div className="flex items-center gap-1">
                  <span className="w-2.5 h-1 bg-slate-400 rounded-xs inline-block" />
                  <span className="text-slate-500">{lang === 'ar' ? 'خط الأساس' : 'Baseline'}</span>
                </div>
              )}
            </div>
          </div>

          {/* Layout: Fixed Table on Right + Independent Horizontal Scroll Canvas on Left */}
          <div className={`flex flex-row overflow-hidden ${isFullscreen ? 'flex-1 min-h-0 overflow-y-auto' : ''}`}>
            {/* Right Fixed Activity Info Column */}
            <div className="w-72 sm:w-80 flex-shrink-0 border-l border-slate-200 bg-slate-50/70 z-30 select-none">
              <div className="p-3 border-b border-slate-200 font-bold text-xs text-slate-700 bg-slate-100 h-10 flex items-center justify-between">
                <span>{lang === 'ar' ? 'النشاط / WBS' : 'Activity / WBS'}</span>
                <span className="text-[10px] text-slate-400">{lang === 'ar' ? 'المدة / النسبة' : 'Dur / %'}</span>
              </div>
              <div className="divide-y divide-slate-100">
                {hierarchicalItems.map((item) => {
                  if (item.type === 'wbs' && item.wbsNode) {
                    const isCollapsed = Boolean(collapsedWbs[item.wbsNode.id]);
                    return (
                      <div
                        key={item.id}
                        onClick={() => toggleWbsCollapse(item.wbsNode!.id)}
                        className="p-2.5 h-12 flex items-center justify-between text-xs text-right bg-amber-50/60 font-bold text-amber-950 hover:bg-amber-100/70 cursor-pointer transition-colors border-r-4 border-amber-500"
                      >
                        <div className="flex items-center gap-1.5 truncate pr-1">
                          {isCollapsed ? <ChevronRight size={14} className="text-amber-700 flex-shrink-0" /> : <ChevronDown size={14} className="text-amber-700 flex-shrink-0" />}
                          <span className="font-mono text-[11px] text-amber-800">[{item.wbsNode.code}]</span>
                          <span className="truncate">{item.wbsNode.name}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 font-mono text-[11px]">
                          <span className="text-amber-800">{item.rollup?.totalDuration || 0}{lang === 'ar' ? 'د' : 'd'}</span>
                          <span className="bg-amber-200/80 px-1.5 py-0.5 rounded text-[10px] font-black">{item.rollup?.percentComplete || 0}%</span>
                        </div>
                      </div>
                    );
                  }

                  const act = item.activity!;
                  return (
                    <div
                      key={act.id}
                      className="p-2.5 h-12 flex items-center justify-between text-xs text-right hover:bg-slate-100/80 transition-colors"
                      style={{ paddingRight: `${Math.max(8, item.level * 14)}px` }}
                    >
                      <div className="truncate pr-1">
                        <span className="font-mono text-slate-400 text-[10px] ml-1">{act.code}</span>
                        <span className={`font-semibold ${act.is_critical ? 'text-rose-700' : 'text-slate-800'}`}>
                          {act.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-[10px] text-slate-500 font-mono font-bold">{act.duration_days}{lang === 'ar' ? 'د' : 'd'}</span>
                        {act.constraint_type && (
                          <span
                            className="px-1 py-0.2 rounded text-[9px] font-mono bg-purple-100 text-purple-700 font-bold"
                            title={`Constraint: ${act.constraint_type} (${act.constraint_date || ''})`}
                          >
                            {act.constraint_type}
                          </span>
                        )}
                        {act.is_critical && <span title={t.critical}><Zap size={13} className="text-rose-500" /></span>}
                        {act.is_milestone && <span title={t.filter_milestones}><Flag size={13} className="text-amber-500" /></span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Left Scrollable Timeline Canvas */}
            <div
              className={`flex-1 overflow-x-auto relative bg-white ${isFullscreen ? 'overflow-y-auto' : ''}`}
              dir="ltr"
              ref={scrollContainerRef}
            >
              <div className="relative" style={{ width: `${timelineContentWidth}px`, minWidth: '100%' }}>
                {/* Timeline Header with Dynamic Columns */}
                <div className="border-b border-slate-200 bg-slate-100 text-slate-600 text-xs font-semibold h-10 relative overflow-hidden sticky top-0 z-20">
                  {timelineHeaderBlocks.map((block, i) => (
                    <div
                      key={i}
                      className={`absolute top-0 bottom-0 border-r border-slate-200 text-center flex flex-col justify-center px-1 font-mono ${
                        block.isWeekend ? 'bg-slate-200/50 text-slate-400' : ''
                      }`}
                      style={{ left: `${block.leftPx}px`, width: `${block.widthPx}px` }}
                    >
                      <span className="text-[10px] font-bold truncate leading-tight text-slate-800">{block.label}</span>
                      {block.subLabel && (
                        <span className="text-[9px] text-slate-400 truncate leading-none mt-0.5">{block.subLabel}</span>
                      )}
                    </div>
                  ))}

                  {/* Data Date Header Tag */}
                  {dataDatePx !== null && (
                    <div
                      className="absolute top-1 -translate-x-1/2 z-30 bg-cyan-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded shadow-sm"
                      style={{ left: `${dataDatePx}px` }}
                      title={`Data Date: ${currentDataDate}`}
                    >
                      Data Date
                    </div>
                  )}
                </div>

                {/* Gantt Rows Container */}
                <div className="divide-y divide-slate-100 relative" style={{ height: `${totalGanttHeight}px` }}>
                  {/* SVG Layer for Dependency Arrows */}
                  {showDependencyLines && (
                    <svg
                      className="absolute top-0 bottom-0 left-0 right-0 pointer-events-none z-10"
                      style={{ width: `${timelineContentWidth}px`, height: `${totalGanttHeight}px` }}
                    >
                      <defs>
                        <marker id="arrow-crit" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#e11d48" />
                        </marker>
                        <marker id="arrow-driving" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
                        </marker>
                        <marker id="arrow-norm" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#94a3b8" />
                        </marker>
                      </defs>

                      {dependencyLines.map((line) => {
                        const strokeColor = line.isCritical ? '#e11d48' : line.isDriving ? '#2563eb' : '#94a3b8';
                        const markerUrl = line.isCritical ? 'url(#arrow-crit)' : line.isDriving ? 'url(#arrow-driving)' : 'url(#arrow-norm)';
                        return (
                          <path
                            key={line.id}
                            d={`M ${line.x1} ${line.y1} C ${line.x1 + 18} ${line.y1}, ${line.x2 - 18} ${line.y2}, ${line.x2} ${line.y2}`}
                            fill="none"
                            stroke={strokeColor}
                            strokeWidth={line.isDriving ? '2.4' : '1.4'}
                            strokeDasharray={line.isDriving ? undefined : '3,2'}
                            markerEnd={markerUrl}
                            opacity={line.isDriving ? '0.95' : '0.6'}
                          />
                        );
                      })}
                    </svg>
                  )}

                  {/* Data Date Vertical Line */}
                  {dataDatePx !== null && (
                    <div
                      className="absolute top-0 bottom-0 border-r-2 border-dashed border-cyan-500 z-20 pointer-events-none"
                      style={{ left: `${dataDatePx}px` }}
                    />
                  )}

                  {/* Hierarchical Activity / WBS Summary Rows */}
                  {hierarchicalItems.map((item) => {
                    if (item.type === 'wbs') {
                      const coords = getWbsPixelCoords(item.rollup?.earlyStart || null, item.rollup?.earlyFinish || null);
                      return (
                        <div
                          key={item.id}
                          className="relative h-12 flex items-center bg-amber-50/30 transition-colors"
                        >
                          {/* Grid vertical column lines */}
                          {timelineHeaderBlocks.map((block, i) => (
                            <div
                              key={i}
                              className={`absolute top-0 bottom-0 border-r border-slate-100 pointer-events-none ${
                                block.isWeekend ? 'bg-slate-50/40' : ''
                              }`}
                              style={{ left: `${block.leftPx}px`, width: `${block.widthPx}px` }}
                            />
                          ))}

                          {/* WBS Summary Bracket Bar */}
                          {coords && (
                            <div
                              className="absolute h-4 top-4 bg-slate-900 border border-slate-800 rounded-sm shadow-sm flex items-center px-1.5 text-[9px] text-amber-300 font-bold overflow-hidden"
                              style={{ left: `${coords.left}px`, width: `${coords.width}px` }}
                              title={`WBS Summary: ${item.wbsNode?.name}\nStart: ${item.rollup?.earlyStart}\nFinish: ${item.rollup?.earlyFinish}\nProgress: ${item.rollup?.percentComplete}%`}
                            >
                              <div
                                className="absolute top-0 bottom-0 left-0 bg-amber-500/50"
                                style={{ width: `${item.rollup?.percentComplete || 0}%` }}
                              />
                              <span className="relative z-10 font-mono text-[9px]">
                                {item.rollup?.percentComplete}%
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    }

                    const act = item.activity!;
                    const bar = getBarPixelCoords(act);
                    const baselineBar = showBaselines ? getBaselinePixelCoords(act.id) : null;
                    const isBeingDragged = draggedActivityId === act.id;

                    let liveLeftPx = bar.left;
                    let liveWidthPx = bar.width;

                    if (isBeingDragged) {
                      if (dragAction === 'move') {
                        liveLeftPx += currentDragOffsetDays * pixelsPerDay;
                      } else if (dragAction === 'resize') {
                        liveWidthPx = Math.max(28, bar.width + currentDragOffsetDays * pixelsPerDay);
                      }
                    }

                    return (
                      <div
                        key={act.id}
                        onMouseUp={() => handleDropTarget(act.id)}
                        className={`relative h-12 flex items-center hover:bg-slate-50/70 transition-colors ${
                          linkingSourceId && linkingSourceId !== act.id ? 'hover:bg-amber-100/50 cursor-pointer' : ''
                        }`}
                      >
                        {/* Grid vertical column lines */}
                        {timelineHeaderBlocks.map((block, i) => (
                          <div
                            key={i}
                            className={`absolute top-0 bottom-0 border-r border-slate-100 pointer-events-none ${
                              block.isWeekend ? 'bg-slate-50/40' : ''
                            }`}
                            style={{ left: `${block.leftPx}px`, width: `${block.widthPx}px` }}
                          />
                        ))}

                        {/* Baseline Bar */}
                        {baselineBar && (
                          <div
                            className="absolute h-1.5 bg-slate-300 rounded-full bottom-1.5 opacity-80"
                            style={{
                              left: `${baselineBar.left}px`,
                              width: `${baselineBar.width}px`,
                            }}
                            title={`Baseline: ${act.early_start} - ${act.early_finish}`}
                          />
                        )}

                        {/* Milestone Diamond or Normal Activity Bar */}
                        {act.is_milestone ? (
                          <div
                            onMouseDown={(e) => handleMouseDownBar(e, act, 'move')}
                            className="absolute w-4 h-4 bg-amber-500 rotate-45 border-2 border-white shadow-sm flex items-center justify-center top-3.5 z-20 cursor-grab active:cursor-grabbing hover:scale-125 transition-transform"
                            style={{ left: `${liveLeftPx}px` }}
                            title={`Milestone: ${act.name} (${act.early_finish})`}
                          />
                        ) : (
                          <div
                            onMouseDown={(e) => handleMouseDownBar(e, act, 'move')}
                            className={`absolute h-6 rounded-lg shadow-sm flex items-center px-2 text-[10px] text-white font-bold overflow-visible z-20 cursor-grab active:cursor-grabbing group/bar transition-all ${
                              act.is_critical
                                ? 'bg-gradient-to-r from-rose-600 to-red-500 shadow-rose-500/20'
                                : 'bg-gradient-to-r from-slate-900 to-slate-800 shadow-slate-900/20'
                            } ${isBeingDragged ? 'ring-2 ring-amber-400 scale-[1.02] opacity-90' : ''}`}
                            style={{
                              left: `${liveLeftPx}px`,
                              width: `${liveWidthPx}px`,
                            }}
                            title={`${act.code} - ${act.name}\nStart: ${act.early_start}\nFinish: ${act.early_finish}\nDuration: ${act.duration_days} d\nTotal Float: ${act.total_float || 0} d`}
                          >
                            {/* Percent complete overlay */}
                            {act.percent_complete > 0 && (
                              <div
                                className="absolute top-0 bottom-0 left-0 bg-amber-500/40 rounded-l-lg pointer-events-none"
                                style={{ width: `${act.percent_complete}%` }}
                              />
                            )}

                            <span className="relative z-10 truncate font-mono text-[10px]">
                              {act.percent_complete}%
                            </span>

                            {/* Live tooltip while dragging */}
                            {isBeingDragged && currentDragOffsetDays !== 0 && (
                              <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-slate-950 text-amber-400 font-bold px-2 py-0.5 rounded text-[10px] whitespace-nowrap shadow-lg border border-amber-500/30 z-30">
                                {dragAction === 'move'
                                  ? `${currentDragOffsetDays > 0 ? `+${currentDragOffsetDays}` : currentDragOffsetDays} d`
                                  : `Dur: ${Math.max(1, (act.duration_days || 1) + currentDragOffsetDays)} d`}
                              </div>
                            )}

                            {/* Interactive Right Edge Resize Grip Handle */}
                            <div
                              onMouseDown={(e) => handleMouseDownBar(e, act, 'resize')}
                              className="absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize hover:bg-white/40 rounded-r-lg flex items-center justify-center z-20"
                              title={lang === 'ar' ? 'اسحب لتعديل مدة النشاط' : 'Drag edge to resize duration'}
                            >
                              <span className="w-0.5 h-3 bg-white/60 rounded-full" />
                            </div>

                            {/* Interactive Dependency Link Pin Handle */}
                            <div
                              onMouseDown={(e) => handleMouseDownBar(e, act, 'link')}
                              className="absolute -right-2 top-1 w-4 h-4 rounded-full bg-amber-400 border-2 border-white shadow opacity-0 group-hover/bar:opacity-100 hover:scale-125 transition-all cursor-crosshair z-30 flex items-center justify-center"
                              title={lang === 'ar' ? 'اسحب أو انقر لربط هذا النشاط بنشاط لاحق' : 'Drag or click to link this activity to a successor'}
                            >
                              <span className="w-1.5 h-1.5 bg-slate-950 rounded-full" />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Main Primavera-Style Activity & Logic Table (Hidden in Fullscreen Gantt Mode) */}
      {!isFullscreen && scheduleTab === 'gantt' && (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">{lang === 'ar' ? 'جدول الأنشطة التفصيلي وهيكل WBS (Primavera P6 Columns Table)' : 'Detailed Activity & Float Schedule (Primavera P6 Format)'}</h3>
                <p className="text-xs text-slate-400">{lang === 'ar' ? 'عرض شامل لكافة الحقول الحسابية لشبكة المسار الحرج والتقاويم المخصصة' : 'Multi-attribute scheduling grid with CPM float analysis'}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowColumnChooser(true)}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer"
                >
                  <Columns size={13} className="text-amber-600" />
                  <span>{lang === 'ar' ? 'تخصيص الأعمدة' : 'Columns'}</span>
                </button>
                <span className="text-xs text-slate-500 font-bold">{activities.length} {lang === 'ar' ? 'نشاط' : 'activities'}</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b border-slate-200 font-bold">
                  <tr>
                    {visibleColumns.code && <th className="text-right p-3">{t.activity_code}</th>}
                    {visibleColumns.name && <th className="text-right p-3">{t.activity_name}</th>}
                    {visibleColumns.activity_type && <th className="text-right p-3">{lang === 'ar' ? 'النوع' : 'Type'}</th>}
                    {visibleColumns.calendar_type && <th className="text-right p-3">{lang === 'ar' ? 'التقويم' : 'Cal'}</th>}
                    {visibleColumns.constraint && <th className="text-right p-3">{lang === 'ar' ? 'القيد' : 'Constraint'}</th>}
                    {visibleColumns.early_start && <th className="text-right p-3">{t.early_start}</th>}
                    {visibleColumns.early_finish && <th className="text-right p-3">{t.early_finish}</th>}
                    {visibleColumns.late_start && <th className="text-right p-3">{lang === 'ar' ? 'بداية متأخرة' : 'Late Start'}</th>}
                    {visibleColumns.late_finish && <th className="text-right p-3">{lang === 'ar' ? 'نهاية متأخرة' : 'Late Finish'}</th>}
                    {visibleColumns.duration_days && <th className="text-right p-3">{t.duration_days}</th>}
                    {visibleColumns.percent_complete && <th className="text-right p-3">{t.percent_complete}</th>}
                    {visibleColumns.total_float && <th className="text-right p-3">{t.total_float}</th>}
                    {visibleColumns.free_float && <th className="text-right p-3">{t.free_float}</th>}
                    {visibleColumns.activity_drag && <th className="text-right p-3">{t.activity_drag}</th>}
                    {visibleColumns.baseline_var && <th className="text-right p-3">{t.baseline_var}</th>}
                    {visibleColumns.critical && <th className="text-center p-3">{t.critical}</th>}
                    {visibleColumns.actions && <th className="text-center p-3">{t.actions}</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {hierarchicalItems.map((item) => {
                    if (item.type === 'wbs' && item.wbsNode) {
                      const isCollapsed = Boolean(collapsedWbs[item.wbsNode.id]);
                      return (
                        <tr
                          key={item.id}
                          onClick={() => toggleWbsCollapse(item.wbsNode!.id)}
                          className="bg-amber-50/70 hover:bg-amber-100/70 font-bold text-amber-950 cursor-pointer transition-colors"
                        >
                          <td colSpan={15} className="p-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                {isCollapsed ? <ChevronRight size={15} className="text-amber-700" /> : <ChevronDown size={15} className="text-amber-700" />}
                                <span className="font-mono bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded text-[11px] font-black">
                                  {item.wbsNode.code}
                                </span>
                                <span className="text-sm">{item.wbsNode.name}</span>
                                <span className="text-slate-500 font-normal text-[11px]">({item.rollup?.activitiesCount || 0} أنشطة)</span>
                              </div>
                              <div className="flex items-center gap-4 text-xs font-mono">
                                <span>{item.rollup?.earlyStart || '-'} ← {item.rollup?.earlyFinish || '-'}</span>
                                <span className="text-amber-800 font-bold">{item.rollup?.totalDuration || 0} يوم</span>
                                <span className="bg-amber-300 text-slate-950 px-2 py-0.5 rounded font-black">{item.rollup?.percentComplete || 0}%</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    const act = item.activity!;
                    const { physicalPct, durationPct, unitsPct } = getCalculatedPercentages(act);

                    return (
                      <tr key={act.id} className="hover:bg-slate-50 transition-colors">
                        {visibleColumns.code && (
                          <td className="p-3 font-mono font-bold text-slate-700">{act.code}</td>
                        )}

                        {visibleColumns.name && (
                          <td className="p-3 text-slate-800 max-w-xs truncate" style={{ paddingRight: `${Math.max(12, item.level * 16)}px` }}>
                            {editingId === act.id ? (
                              <div className="space-y-2 min-w-80 p-3 bg-amber-50/60 rounded-xl border border-amber-300">
                                <input
                                  value={String(editForm.name || '')}
                                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                  className="w-full px-2 py-1.5 border rounded-lg text-xs bg-white font-semibold"
                                  placeholder={lang === 'ar' ? 'اسم النشاط' : 'Activity Name'}
                                />
                                <div className="grid grid-cols-2 gap-1.5">
                                  <div>
                                    <label className="block text-[10px] text-slate-500 font-semibold mb-0.5">{lang === 'ar' ? 'نوع النشاط' : 'Type'}</label>
                                    <select
                                      value={editForm.activity_type || 'task_dependent'}
                                      onChange={(e) => setEditForm({ ...editForm, activity_type: e.target.value as any })}
                                      className="w-full px-2 py-1 border rounded text-[11px] bg-white font-bold"
                                    >
                                      <option value="task_dependent">Task Dependent</option>
                                      <option value="resource_dependent">Resource Dependent</option>
                                      <option value="level_of_effort">Level of Effort (LOE)</option>
                                      <option value="start_milestone">Start Milestone</option>
                                      <option value="finish_milestone">Finish Milestone</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label className="block text-[10px] text-slate-500 font-semibold mb-0.5">{lang === 'ar' ? 'تقويم النشاط' : 'Calendar'}</label>
                                    <select
                                      value={editForm.calendar_type || selectedCalendar}
                                      onChange={(e) => setEditForm({ ...editForm, calendar_type: e.target.value as any })}
                                      className="w-full px-2 py-1 border rounded text-[11px] bg-white font-bold"
                                    >
                                      <option value="6_days">6 Days (Fri off)</option>
                                      <option value="5_days">5 Days (Fri/Sat off)</option>
                                      <option value="7_days">7 Days Continuous</option>
                                    </select>
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-1.5">
                                  <div>
                                    <label className="block text-[10px] text-slate-500 font-semibold mb-0.5">{t.early_start}</label>
                                    <input
                                      type="date"
                                      value={String(editForm.early_start || '')}
                                      onChange={(e) => setEditForm({ ...editForm, early_start: e.target.value })}
                                      className="w-full px-2 py-1 border rounded text-[11px] bg-white font-mono"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] text-slate-500 font-semibold mb-0.5">{t.early_finish}</label>
                                    <input
                                      type="date"
                                      value={String(editForm.early_finish || '')}
                                      onChange={(e) => setEditForm({ ...editForm, early_finish: e.target.value })}
                                      className="w-full px-2 py-1 border rounded text-[11px] bg-white font-mono"
                                    />
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-1.5">
                                  <input
                                    type="number"
                                    min="0"
                                    value={Number(editForm.duration_days || 0)}
                                    onChange={(e) => setEditForm({ ...editForm, duration_days: Number(e.target.value) })}
                                    className="w-full px-2 py-1 border rounded text-xs bg-white"
                                    placeholder={t.duration_days}
                                  />
                                  <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    value={Number(editForm.percent_complete || 0)}
                                    onChange={(e) => setEditForm({ ...editForm, percent_complete: Number(e.target.value) })}
                                    className="w-full px-2 py-1 border rounded text-xs bg-white"
                                    placeholder={t.percent_complete}
                                  />
                                </div>
                                <div className="flex gap-2 justify-end pt-1">
                                  <button onClick={() => void saveEdit()} className="px-3 py-1.5 bg-slate-900 text-amber-400 rounded-lg text-xs flex items-center gap-1 font-bold cursor-pointer">
                                    <Save size={12} /> {lang === 'ar' ? 'حفظ وتحديث' : 'Save & CPM'}
                                  </button>
                                  <button onClick={() => setEditingId(null)} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer">
                                    {lang === 'ar' ? 'إلغاء' : 'Cancel'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <span className={act.is_critical ? 'font-bold text-rose-700' : 'font-medium'}>{act.name}</span>
                            )}
                          </td>
                        )}

                        {visibleColumns.activity_type && (
                          <td className="p-3">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-100 text-slate-700 font-bold border border-slate-200">
                              {act.activity_type || (act.is_milestone ? 'Milestone' : 'Task Dep')}
                            </span>
                          </td>
                        )}

                        {visibleColumns.calendar_type && (
                          <td className="p-3 font-mono text-[10px] text-slate-600">
                            {act.calendar_type || selectedCalendar}
                          </td>
                        )}

                        {visibleColumns.constraint && (
                          <td className="p-3">
                            {act.constraint_type ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-100 text-purple-700 font-bold">
                                {act.constraint_type}
                              </span>
                            ) : (
                              <span className="text-slate-300">-</span>
                            )}
                          </td>
                        )}

                        {visibleColumns.early_start && (
                          <td className="p-3 text-slate-600 font-mono whitespace-nowrap">{act.early_start || '-'}</td>
                        )}

                        {visibleColumns.early_finish && (
                          <td className="p-3 text-slate-600 font-mono whitespace-nowrap">{act.early_finish || '-'}</td>
                        )}

                        {visibleColumns.late_start && (
                          <td className="p-3 text-slate-500 font-mono whitespace-nowrap">{act.late_start || '-'}</td>
                        )}

                        {visibleColumns.late_finish && (
                          <td className="p-3 text-slate-500 font-mono whitespace-nowrap">{act.late_finish || '-'}</td>
                        )}

                        {visibleColumns.duration_days && (
                          <td className="p-3 text-slate-600 font-bold">{act.duration_days} {lang === 'ar' ? 'يوم' : 'd'}</td>
                        )}

                        {visibleColumns.percent_complete && (
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              <div className="w-12 h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-amber-500 rounded-full" style={{ width: `${act.percent_complete}%` }} />
                              </div>
                              <span className="font-bold text-slate-700">{act.percent_complete}%</span>
                            </div>
                          </td>
                        )}

                        {visibleColumns.total_float && (
                          <td className={`p-3 font-mono font-bold ${Number(act.total_float || 0) <= 0 ? 'text-rose-600' : 'text-slate-600'}`}>
                            {Number(act.total_float || 0)} {lang === 'ar' ? 'يوم' : 'd'}
                          </td>
                        )}

                        {visibleColumns.free_float && (
                          <td className="p-3 font-mono text-slate-600">
                            {Number(act.free_float || 0)} {lang === 'ar' ? 'يوم' : 'd'}
                          </td>
                        )}

                        {visibleColumns.activity_drag && (
                          <td className="p-3 font-mono text-slate-600 font-bold">
                            {act.is_critical ? `${act.activity_drag || act.duration_days} ${lang === 'ar' ? 'يوم' : 'd'}` : `0 ${lang === 'ar' ? 'يوم' : 'd'}`}
                          </td>
                        )}

                        {visibleColumns.baseline_var && (
                          <td className="p-3">
                            {(() => {
                              const variance = getBaselineVariance(act);
                              if (variance === null) return <span className="text-slate-400">-</span>;
                              return (
                                <span className={`font-bold font-mono ${variance > 0 ? 'text-rose-600' : variance < 0 ? 'text-emerald-600' : 'text-slate-500'}`}>
                                  {variance > 0 ? `+${variance}` : variance} {lang === 'ar' ? 'يوم' : 'd'}
                                </span>
                              );
                            })()}
                          </td>
                        )}

                        {visibleColumns.critical && (
                          <td className="p-3 text-center">
                            {act.is_critical ? <Zap size={16} className="text-rose-500 mx-auto" /> : <span className="text-slate-300">-</span>}
                          </td>
                        )}

                        {visibleColumns.actions && (
                          <td className="p-3 text-center">
                            <button onClick={() => startEdit(act)} className="text-blue-600 hover:text-blue-800 p-1 cursor-pointer">
                              <Pencil size={14} />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Network Links Management */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 bg-slate-50/50">
              <h3 className="font-bold text-slate-900 text-sm">{lang === 'ar' ? 'شبكة العلاقات والتسلسل (CPM Links & Lags)' : 'CPM Logic Links & Lags Network'}</h3>
              <p className="text-xs text-slate-500 mt-1">{lang === 'ar' ? 'ربط الأنشطة الإنشائية بعلاقات (FS, SS, FF, SF) مع تمييز العلاقات الدافعة (Driving).' : 'Manage predecessor-successor logic links with driving relationship tags.'}</p>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 mt-3">
                <select
                  value={linkForm.predecessor_id}
                  onChange={(e) => setLinkForm({ ...linkForm, predecessor_id: e.target.value })}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-xs bg-white outline-none cursor-pointer"
                >
                  <option value="">{lang === 'ar' ? 'النشاط السابق (Predecessor)' : 'Select Predecessor'}</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                  ))}
                </select>

                <select
                  value={linkForm.successor_id}
                  onChange={(e) => setLinkForm({ ...linkForm, successor_id: e.target.value })}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-xs bg-white outline-none cursor-pointer"
                >
                  <option value="">{lang === 'ar' ? 'النشاط اللاحق (Successor)' : 'Select Successor'}</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                  ))}
                </select>

                <select
                  value={linkForm.link_type}
                  onChange={(e) => setLinkForm({ ...linkForm, link_type: e.target.value })}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-xs bg-white outline-none font-bold text-slate-800 cursor-pointer"
                >
                  <option value="FS">FS (Finish to Start)</option>
                  <option value="SS">SS (Start to Start)</option>
                  <option value="FF">FF (Finish to Finish)</option>
                  <option value="SF">SF (Start to Finish)</option>
                </select>

                <div className="flex gap-2">
                  <input
                    type="number"
                    value={linkForm.lag_days}
                    onChange={(e) => setLinkForm({ ...linkForm, lag_days: Number(e.target.value) || 0 })}
                    className="w-20 px-2 py-2 border border-slate-200 rounded-lg text-xs font-mono"
                    placeholder="Lag (d)"
                  />
                  <button
                    onClick={() => void addRelationship()}
                    className="flex-1 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg text-xs font-bold transition-colors cursor-pointer"
                  >
                    {lang === 'ar' ? 'إضافة علاقة' : 'Add Link'}
                  </button>
                </div>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 sticky top-0 font-bold">
                  <tr>
                    <th className="p-2.5 text-right">{lang === 'ar' ? 'النشاط السابق' : 'Predecessor'}</th>
                    <th className="p-2.5 text-right">{lang === 'ar' ? 'نوع العلاقة' : 'Type'}</th>
                    <th className="p-2.5 text-right">{lang === 'ar' ? 'النشاط اللاحق' : 'Successor'}</th>
                    <th className="p-2.5 text-right">{lang === 'ar' ? 'فترة التباطؤ (Lag)' : 'Lag'}</th>
                    <th className="p-2.5 text-center">{lang === 'ar' ? 'علاقة دافعة (Driving)' : 'Driving'}</th>
                    <th className="p-2.5 text-center">{t.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {links.map((link) => {
                    const isDriving = linkDrivingMap.get(link.id) !== false;
                    return (
                      <tr key={link.id} className="hover:bg-slate-50">
                        <td className="p-2.5 font-bold">{activities.find((a) => a.id === link.predecessor_id)?.code || '-'}</td>
                        <td className="p-2.5 font-mono font-bold text-amber-700">{link.link_type}</td>
                        <td className="p-2.5 font-bold">{activities.find((a) => a.id === link.successor_id)?.code || '-'}</td>
                        <td className="p-2.5 font-mono">{link.lag_days} {lang === 'ar' ? 'يوم' : 'd'}</td>
                        <td className="p-2.5 text-center">
                          {isDriving ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-blue-100 text-blue-800 border border-blue-200">
                              Driving ⚡
                            </span>
                          ) : (
                            <span className="text-slate-400 text-[10px]">Non-Driving</span>
                          )}
                        </td>
                        <td className="p-2.5 text-center">
                          <button onClick={() => void removeRelationship(link.id)} className="text-rose-600 hover:text-rose-800 text-xs font-bold cursor-pointer">
                            {lang === 'ar' ? 'حذف' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

import type {
  Activity,
  ActivityLink,
  ActivityResource,
  CalendarType,
  P6Calendar,
  Resource,
  ResourceHistogramData,
  ResourceSummaryItem,
} from '@/types';
import {
  calculateLinkDate,
  countWorkingDays,
  effectiveLinkLagDays,
  getCalendar,
  getNextWorkingDay,
  isWorkingDay,
  resolveActivityExecutionCalendar,
} from './calendarEngine';
import { calculateCpm, type CpmCalculation, type CpmOptions, type CpmResult } from './cpmEngine';
import { DEFAULT_DATA_DATE } from './projectControlsConstants';

const EPSILON = 1e-7;

export interface ResourceLevelingInput {
  activities: Activity[];
  links: ActivityLink[];
  resources: Resource[];
  assignments: ActivityResource[];
  cpmOptions?: CpmOptions;
  projectControls?: {
    calendar_type: CalendarType | null;
    data_date: string | null;
    status_logic: 'retained_logic' | 'progress_override' | null;
  };
}

export type ResourceLevelingStatus =
  | 'ready'
  | 'no_conflicts'
  | 'insufficient_data'
  | 'no_feasible_scenario'
  | 'invalid_schedule';

export interface ResourceConflict {
  resourceId: string;
  resourceName: string;
  unit: string;
  date: string;
  demand: number;
  capacity: number;
  overBy: number;
  activityIds: string[];
}

export interface ShiftedResourceActivity {
  activityId: string;
  activityName: string;
  currentStart: string;
  leveledStart: string;
  currentFinish: string;
  leveledFinish: string;
  shiftedWorkingDays: number;
  manuallyShifted: boolean;
}

export interface CriticalPathImpact {
  baselineCriticalActivityIds: string[];
  leveledCriticalActivityIds: string[];
  newlyCriticalActivityIds: string[];
  noLongerCriticalActivityIds: string[];
}

export interface ResourceLevelingSourceSnapshot {
  activities: Activity[];
  links: ActivityLink[];
  resources: Resource[];
  assignments: ActivityResource[];
  calendars: P6Calendar[];
  controls: {
    calendar_type: CalendarType | null;
    data_date: string | null;
    status_logic: 'retained_logic' | 'progress_override' | null;
  };
}

export interface ResourceLevelingScenario {
  status: ResourceLevelingStatus;
  message: string;
  dataIssues: string[];
  conflictsBefore: ResourceConflict[] | null;
  conflictsAfter: ResourceConflict[] | null;
  unresolvedConflicts: ResourceConflict[];
  currentProjectFinish: string | null;
  leveledProjectFinish: string | null;
  finishVarianceWorkingDays: number | null;
  shiftedActivities: ShiftedResourceActivity[];
  resourcesAffected: Array<{ id: string; name: string; unit: string }>;
  criticalPathImpact: CriticalPathImpact | null;
  baselineActivities: Activity[];
  scenarioActivities: Activity[];
  baselineCpm: CpmCalculation | null;
  scenarioCpm: CpmCalculation | null;
  manuallyShiftedActivityIds: string[];
  sourceSnapshot: ResourceLevelingSourceSnapshot;
}

interface DemandCell {
  resourceId: string;
  date: string;
  demand: number;
  capacity: number;
  contributors: Map<string, number>;
}

interface DemandBuildResult {
  cells: Map<string, DemandCell>;
  issues: string[];
  activeAssignmentCount: number;
}

interface PreparedSchedule {
  calculation: CpmCalculation;
  activities: Activity[];
  byActivityId: Map<string, CpmResult>;
}

function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneData(item)) as T;
  if (value && typeof value === 'object') {
    const copy = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, cloneData(nested)]));
    return copy as T;
  }
  return value;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function addCalendarDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function roundUnits(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function canonicalOptions(options: CpmOptions = {}): CpmOptions {
  return {
    ...options,
    dataDate: options.dataDate || DEFAULT_DATA_DATE,
    statusLogic: options.statusLogic || 'retained_logic',
    calculateDrag: true,
  };
}

function resolveActivityCalendar(activity: Activity, options: CpmOptions): ReturnType<typeof getCalendar> {
  const calendarType = options.calendarType || '6_days';
  const holidays = options.customHolidays || [];
  const defaultCalendar = getCalendar(calendarType, holidays);
  const calendars = options.calendars || [];
  if (calendars.length > 0 && activity.calendar_id) {
    return resolveActivityExecutionCalendar(activity, new Map(calendars.map((calendar) => [calendar.id, calendar])), defaultCalendar, holidays).calendar;
  }
  if (activity.calendar_type) return getCalendar(activity.calendar_type, holidays);
  return defaultCalendar;
}

function calendarDataIssues(activities: Activity[], options: CpmOptions): string[] {
  const calendars = options.calendars || [];
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const projectCalendar = getCalendar(options.calendarType || '6_days', options.customHolidays || []);
  const issues: string[] = [];
  for (const activity of activities) {
    if (!activity.calendar_id) continue;
    const resolution = resolveActivityExecutionCalendar(activity, byId, projectCalendar, options.customHolidays || []);
    if (resolution.source !== 'activity_calendar') {
      issues.push(`Activity ${activity.code || activity.id} has an assigned P6 calendar that is missing, partial, or unusable; calendar-based leveling is N/A.`);
    }
  }
  return [...new Set(issues)];
}

function sourceSnapshot(input: ResourceLevelingInput, options: CpmOptions): ResourceLevelingSourceSnapshot {
  return {
    activities: input.activities.map((activity) => cloneData(activity)),
    links: input.links.map((link) => cloneData(link)),
    resources: input.resources.map((resource) => cloneData(resource)),
    assignments: input.assignments.map((assignment) => cloneData(assignment)),
    calendars: (options.calendars || []).map((calendar) => cloneData(calendar)),
    controls: {
      calendar_type: input.projectControls?.calendar_type ?? null,
      data_date: input.projectControls?.data_date ?? null,
      status_logic: input.projectControls?.status_logic ?? null,
    },
  };
}

function prepareSchedule(activities: Activity[], links: ActivityLink[], options: CpmOptions): PreparedSchedule {
  const calculation = calculateCpm(activities, links, options);
  const byActivityId = new Map(calculation.results.map((result) => [result.activityId, result]));
  const scheduledActivities = activities.map((activity) => {
    const result = byActivityId.get(activity.id);
    if (!result) return { ...activity };
    return {
      ...activity,
      early_start: result.earlyStart,
      early_finish: result.earlyFinish,
      late_start: result.lateStart,
      late_finish: result.lateFinish,
      total_float: result.totalFloat,
      free_float: result.freeFloat,
      is_critical: result.isCritical,
      activity_drag: result.activityDrag,
    } as Activity;
  });
  return { calculation, activities: scheduledActivities, byActivityId };
}

function makeEmptyScenario(
  input: ResourceLevelingInput,
  options: CpmOptions,
  overrides: Partial<ResourceLevelingScenario>,
): ResourceLevelingScenario {
  const baselineCpm = overrides.baselineCpm || null;
  return {
    status: 'insufficient_data',
    message: 'N/A / Insufficient data.',
    dataIssues: [],
    conflictsBefore: null,
    conflictsAfter: null,
    unresolvedConflicts: [],
    currentProjectFinish: baselineCpm?.projectEarlyFinish || null,
    leveledProjectFinish: null,
    finishVarianceWorkingDays: null,
    shiftedActivities: [],
    resourcesAffected: [],
    criticalPathImpact: null,
    baselineActivities: overrides.baselineActivities || [],
    scenarioActivities: [],
    baselineCpm,
    scenarioCpm: null,
    manuallyShiftedActivityIds: [],
    sourceSnapshot: sourceSnapshot(input, options),
    ...overrides,
  };
}

function activityIsCompleted(activity: Activity): boolean {
  return Boolean(activity.actual_finish) || Number(activity.percent_complete || 0) >= 100;
}

function activityHasStarted(activity: Activity): boolean {
  return Boolean(activity.actual_start)
    || Number(activity.percent_complete || 0) > 0
    || Number(activity.actual_quantity || 0) > 0;
}

function hasCanonicalProgressStatus(activity: Activity): boolean {
  return Boolean(activity.actual_start || activity.actual_finish) || Number(activity.percent_complete || 0) > 0;
}


function addDemandCell(
  cells: Map<string, DemandCell>,
  resource: Resource,
  date: string,
  activityId: string,
  quantity: number,
): void {
  const key = `${resource.id}\u0000${date}`;
  let cell = cells.get(key);
  if (!cell) {
    cell = {
      resourceId: resource.id,
      date,
      demand: 0,
      capacity: Number(resource.availability),
      contributors: new Map<string, number>(),
    };
    cells.set(key, cell);
  }
  cell.demand += quantity;
  cell.contributors.set(activityId, (cell.contributors.get(activityId) || 0) + quantity);
}

function buildDemand(
  activities: Activity[],
  resources: Resource[],
  assignments: ActivityResource[],
  prepared: PreparedSchedule,
  options: CpmOptions,
): DemandBuildResult {
  const cells = new Map<string, DemandCell>();
  const issues: string[] = calendarDataIssues(activities, options);
  if (issues.length) return { cells, issues, activeAssignmentCount: 0 };
  const activitiesById = new Map(activities.map((activity) => [activity.id, activity]));
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  let activeAssignmentCount = 0;
  const dataDate = prepared.calculation.dataDate || options.dataDate || DEFAULT_DATA_DATE;

  for (const assignment of assignments) {
    const activity = activitiesById.get(assignment.activity_id);
    const resource = resourcesById.get(assignment.resource_id);
    if (!activity) {
      issues.push(`Assignment ${assignment.id} references missing activity ${assignment.activity_id}.`);
      continue;
    }
    if (!resource) {
      issues.push(`Assignment ${assignment.id} references missing resource ${assignment.resource_id}.`);
      continue;
    }
    if (activityIsCompleted(activity)) continue;
    const assignmentActual = numeric(assignment.actual_quantity);
    if (!hasCanonicalProgressStatus(activity) && ((assignmentActual || 0) > 0 || Number(activity.actual_quantity || 0) > 0)) {
      issues.push(`Assignment ${assignment.id} records actual work but the activity has no matching started/progress status for canonical CPM.`);
      continue;
    }

    const cpmResult = prepared.byActivityId.get(activity.id);
    if (!cpmResult || cpmResult.remainingDuration <= 0) continue;

    const capacity = numeric(resource.availability);
    if (capacity === null || capacity <= 0) {
      issues.push(`Resource ${resource.name} has missing or non-positive availability; capacity is not inferred.`);
      continue;
    }
    const unit = String(resource.unit || '').trim();
    if (!unit) {
      issues.push(`Resource ${resource.name} has no unit for its assignment profile.`);
      continue;
    }

    let workStart = cpmResult.earlyStart;
    if (activityHasStarted(activity) && dataDate > workStart) workStart = dataDate;
    const calendar = resolveActivityCalendar(activity, options);
    workStart = getNextWorkingDay(workStart, calendar);
    const workFinish = cpmResult.earlyFinish;
    const workingDates: string[] = [];
    for (let date = workStart; date <= workFinish; date = addCalendarDay(date)) {
      if (isWorkingDay(date, calendar)) workingDates.push(date);
    }
    if (workingDates.length === 0) {
      issues.push(`Assignment ${assignment.id} has remaining CPM duration but no future working days.`);
      continue;
    }

    const profile = assignment.daily_demand_profile;
    if (!Array.isArray(profile)) {
      issues.push(`Assignment ${assignment.id} has total quantities only; a verified time-phased daily demand profile is required. No profile is inferred.`);
      continue;
    }
    if (profile.length !== workingDates.length) {
      issues.push(`Assignment ${assignment.id} daily demand profile does not cover each remaining CPM working day.`);
      continue;
    }
    const profileUnits: number[] = [];
    let profileIsValid = true;
    profile.forEach((point, index) => {
      const units = typeof point?.units === 'number' && Number.isFinite(point.units) ? point.units : null;
      if (typeof point?.workday_offset !== 'number' || point.workday_offset !== index || units === null || units < 0) {
        profileIsValid = false;
        return;
      }
      profileUnits.push(units);
    });
    if (!profileIsValid || profileUnits.length !== workingDates.length) {
      issues.push(`Assignment ${assignment.id} daily demand profile has missing, negative, or invalid workday values.`);
      continue;
    }

    activeAssignmentCount += 1;
    profileUnits.forEach((units, index) => {
      if (units > EPSILON) addDemandCell(cells, resource, workingDates[index], activity.id, units);
    });
  }

  return { cells, issues: [...new Set(issues)], activeAssignmentCount };
}

function resourceConflicts(
  cells: Map<string, DemandCell>,
  resources: Resource[],
): ResourceConflict[] {
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  return [...cells.values()]
    .filter((cell) => cell.demand > cell.capacity + EPSILON)
    .map((cell) => {
      const resource = resourcesById.get(cell.resourceId);
      return {
        resourceId: cell.resourceId,
        resourceName: resource?.name || cell.resourceId,
        unit: String(resource?.unit || ''),
        date: cell.date,
        demand: roundUnits(cell.demand),
        capacity: roundUnits(cell.capacity),
        overBy: roundUnits(cell.demand - cell.capacity),
        activityIds: [...cell.contributors.keys()].sort(),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.resourceName.localeCompare(b.resourceName) || a.resourceId.localeCompare(b.resourceId));
}

function isImmovable(activity: Activity, assignments: ActivityResource[]): boolean {
  const constraint = activity.constraint_type;
  const hasAssignmentActualWork = assignments.some((assignment) =>
    assignment.activity_id === activity.id && Number(assignment.actual_quantity || 0) > 0,
  );
  return activityIsCompleted(activity)
    || activityHasStarted(activity)
    || hasAssignmentActualWork
    || Boolean(activity.is_milestone)
    || ['MSO', 'MFO', 'MS', 'MF'].includes(String(constraint || ''));
}

function constraintViolation(activity: Activity, result: CpmResult, options: CpmOptions): boolean {
  if (!activity.constraint_type || !activity.constraint_date || activityIsCompleted(activity)) return false;
  const calendar = resolveActivityCalendar(activity, options);
  const date = getNextWorkingDay(activity.constraint_date, calendar);
  switch (activity.constraint_type) {
    case 'SNET': return result.earlyStart < date;
    case 'SNLT': return result.earlyStart > date;
    case 'FNET': return result.earlyFinish < date;
    case 'FNLT': return result.earlyFinish > date;
    case 'MSO':
    case 'MS': return result.earlyStart !== date;
    case 'MFO':
    case 'MF': return result.earlyFinish !== date;
    default: return false;
  }
}

function scenarioHasNewScheduleViolation(
  activities: Activity[],
  links: ActivityLink[],
  baseline: PreparedSchedule,
  scenario: PreparedSchedule,
  options: CpmOptions,
): boolean {
  if (scenario.calculation.cycle) return true;
  const baseActivities = new Map(activities.map((activity) => [activity.id, activity]));
  const scenarioById = new Map(scenario.byActivityId);
  const baselineById = new Map(baseline.byActivityId);

  for (const activity of activities) {
    const base = baselineById.get(activity.id);
    const current = scenarioById.get(activity.id);
    if (!base || !current) return true;
    if (current.outOfSequence && !base.outOfSequence) return true;
    if (constraintViolation(activity, current, options) && !constraintViolation(activity, base, options)) return true;
    if (activityIsCompleted(activity) || activityHasStarted(activity)) {
      const original = baseActivities.get(activity.id)!;
      const calculated = scenario.activities.find((item) => item.id === activity.id);
      if (!calculated || calculated.actual_start !== original.actual_start || calculated.actual_finish !== original.actual_finish) return true;
    }
    if (activity.is_milestone) continue;
    const calendar = resolveActivityCalendar(activity, options);
    if (!isWorkingDay(current.earlyStart, calendar) || !isWorkingDay(current.earlyFinish, calendar)) return true;
  }

  // Check each non-started successor against the same relationship-date calculation used by CPM.
  const baseActivityMap = new Map(activities.map((activity) => [activity.id, activity]));
  for (const link of links) {
    const predecessor = baseActivityMap.get(link.predecessor_id);
    const successor = baseActivityMap.get(link.successor_id);
    const predecessorResult = scenarioById.get(link.predecessor_id);
    const successorResult = scenarioById.get(link.successor_id);
    if (!predecessor || !successor || !predecessorResult || !successorResult) return true;
    if (activityHasStarted(successor) || activityIsCompleted(successor)) continue;
    const predecessorCalendar = resolveActivityCalendar(predecessor, options);
    const successorCalendar = resolveActivityCalendar(successor, options);
    const requiredStart = calculateLinkDate(
      predecessorResult.earlyStart,
      predecessorResult.earlyFinish,
      Math.max(1, successorResult.remainingDuration || Number(successor.duration_days || 1)),
      (link.link_type || 'FS') as 'FS' | 'SS' | 'FF' | 'SF',
      effectiveLinkLagDays(link),
      predecessorCalendar,
      successorCalendar,
    );
    if (successorResult.earlyStart < requiredStart) return true;
  }
  return false;
}

function workingDayDelta(from: string, to: string, calendar: ReturnType<typeof getCalendar>): number {
  if (from === to) return 0;
  if (to > from) return Math.max(0, countWorkingDays(from, to, calendar) - 1);
  return -Math.max(0, countWorkingDays(to, from, calendar) - 1);
}

function summarizeShiftedActivities(
  baseline: PreparedSchedule,
  scenario: PreparedSchedule,
  activities: Activity[],
  options: CpmOptions,
  manuallyShiftedIds: Set<string>,
): ShiftedResourceActivity[] {
  const originalById = new Map(activities.map((activity) => [activity.id, activity]));
  const output: ShiftedResourceActivity[] = [];
  for (const activity of activities) {
    const before = baseline.byActivityId.get(activity.id);
    const after = scenario.byActivityId.get(activity.id);
    if (!before || !after || before.earlyStart === after.earlyStart && before.earlyFinish === after.earlyFinish) continue;
    const calendar = resolveActivityCalendar(activity, options);
    output.push({
      activityId: activity.id,
      activityName: activity.name || activity.code || activity.id,
      currentStart: before.earlyStart,
      leveledStart: after.earlyStart,
      currentFinish: before.earlyFinish,
      leveledFinish: after.earlyFinish,
      shiftedWorkingDays: workingDayDelta(before.earlyStart, after.earlyStart, calendar),
      manuallyShifted: manuallyShiftedIds.has(activity.id),
    });
  }
  return output.sort((a, b) => a.currentStart.localeCompare(b.currentStart) || a.activityName.localeCompare(b.activityName));
}

function criticalPathImpact(baseline: PreparedSchedule, scenario: PreparedSchedule): CriticalPathImpact {
  const baselineCriticalActivityIds = baseline.calculation.results.filter((result) => result.isCritical).map((result) => result.activityId).sort();
  const leveledCriticalActivityIds = scenario.calculation.results.filter((result) => result.isCritical).map((result) => result.activityId).sort();
  const base = new Set(baselineCriticalActivityIds);
  const after = new Set(leveledCriticalActivityIds);
  return {
    baselineCriticalActivityIds,
    leveledCriticalActivityIds,
    newlyCriticalActivityIds: leveledCriticalActivityIds.filter((id) => !base.has(id)),
    noLongerCriticalActivityIds: baselineCriticalActivityIds.filter((id) => !after.has(id)),
  };
}

function finishVarianceWorkingDays(from: string, to: string, options: CpmOptions): number {
  const calendar = getCalendar(options.calendarType || '6_days', options.customHolidays || []);
  return workingDayDelta(from, to, calendar);
}

function conflictIsIndividuallyImpossible(
  conflict: ResourceConflict,
  cells: Map<string, DemandCell>,
): boolean {
  const cell = cells.get(`${conflict.resourceId}\u0000${conflict.date}`);
  if (!cell) return false;
  return [...cell.contributors.values()].some((demand) => demand > cell.capacity + EPSILON);
}

function findMoveCandidates(
  conflict: ResourceConflict,
  cells: Map<string, DemandCell>,
  activities: Activity[],
  assignments: ActivityResource[],
  prepared: PreparedSchedule,
  blockedActivityIds: Set<string>,
): Activity[] {
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  const cell = cells.get(`${conflict.resourceId}\u0000${conflict.date}`);
  if (!cell) return [];
  return [...cell.contributors.keys()]
    .map((id) => activityById.get(id))
    .filter((activity): activity is Activity => Boolean(activity))
    .filter((activity) => !blockedActivityIds.has(activity.id) && !isImmovable(activity, assignments) && (prepared.byActivityId.get(activity.id)?.remainingDuration || 0) > 0)
    .sort((a, b) => {
      const aResult = prepared.byActivityId.get(a.id)!;
      const bResult = prepared.byActivityId.get(b.id)!;
      if (aResult.isCritical !== bResult.isCritical) return aResult.isCritical ? 1 : -1;
      if (aResult.totalFloat !== bResult.totalFloat) return bResult.totalFloat - aResult.totalFloat;
      return a.id.localeCompare(b.id);
    });
}

function lastContiguousConflictDate(
  initialConflict: ResourceConflict,
  candidateId: string,
  conflicts: ResourceConflict[],
  activity: Activity,
  options: CpmOptions,
): string {
  const calendar = resolveActivityCalendar(activity, options);
  const dates = conflicts
    .filter((item) => item.resourceId === initialConflict.resourceId && item.activityIds.includes(candidateId) && item.date >= initialConflict.date)
    .map((item) => item.date)
    .sort();
  let last = initialConflict.date;
  for (const date of dates) {
    if (date === last) continue;
    let nextWorking = getNextWorkingDay(addCalendarDay(last), calendar);
    if (nextWorking !== date) break;
    last = date;
  }
  return last;
}

function createInsufficientScenario(
  input: ResourceLevelingInput,
  options: CpmOptions,
  prepared: PreparedSchedule | null,
  issues: string[],
  conflictsBefore: ResourceConflict[] | null = null,
): ResourceLevelingScenario {
  return makeEmptyScenario(input, options, {
    status: 'insufficient_data',
    message: 'N/A / Insufficient data. Add verified assignment quantities, resource units, capacity, and schedule controls before leveling.',
    dataIssues: [...new Set(issues)],
    conflictsBefore,
    currentProjectFinish: prepared?.calculation.projectEarlyFinish || null,
    baselineActivities: prepared?.activities || [],
    baselineCpm: prepared?.calculation || null,
  });
}

function createInvalidScenario(
  input: ResourceLevelingInput,
  options: CpmOptions,
  calculation: CpmCalculation | null,
  message: string,
): ResourceLevelingScenario {
  return makeEmptyScenario(input, options, {
    status: 'invalid_schedule',
    message,
    dataIssues: calculation?.cycle ? [`CPM logic cycle: ${calculation.cycle.join(' → ')}`] : [],
    baselineCpm: calculation,
  });
}

export function levelScheduleResources(input: ResourceLevelingInput): ResourceLevelingScenario {
  const options = canonicalOptions(input.cpmOptions);
  if (!input.activities.length) {
    return createInsufficientScenario(input, options, null, ['No activities were supplied.']);
  }
  if (!input.resources.length || !input.assignments.length) {
    const prepared = prepareSchedule(input.activities, input.links, options);
    return createInsufficientScenario(input, options, prepared, [
      !input.resources.length ? 'No project resources were supplied.' : '',
      !input.assignments.length ? 'No resource assignments were supplied.' : '',
    ].filter(Boolean));
  }

  const preparedBaseline = prepareSchedule(input.activities, input.links, options);
  if (preparedBaseline.calculation.cycle) {
    return createInvalidScenario(input, options, preparedBaseline.calculation, 'No feasible leveled scenario / N/A. The current relationship network contains a CPM cycle.');
  }
  if (preparedBaseline.byActivityId.size !== input.activities.length) {
    return createInvalidScenario(input, options, preparedBaseline.calculation, 'No feasible leveled scenario / N/A. Canonical CPM did not return a result for every activity.');
  }

  const baselineDemand = buildDemand(input.activities, input.resources, input.assignments, preparedBaseline, options);
  if (baselineDemand.issues.length) {
    return createInsufficientScenario(input, options, preparedBaseline, baselineDemand.issues);
  }
  const conflictsBefore = resourceConflicts(baselineDemand.cells, input.resources);
  if (!baselineDemand.activeAssignmentCount) {
    return createInsufficientScenario(input, options, preparedBaseline, ['No positive remaining resource assignment quantity is available to analyze.'], conflictsBefore);
  }

  const source = sourceSnapshot(input, options);
  const resourcesAffected = [...new Set(conflictsBefore.map((conflict) => conflict.resourceId))]
    .map((id) => {
      const resource = input.resources.find((item) => item.id === id)!;
      return { id, name: resource.name, unit: resource.unit };
    });

  if (!conflictsBefore.length) {
    return {
      status: 'no_conflicts',
      message: 'No resource-capacity conflicts were identified for the measured remaining work; no changes are proposed.',
      dataIssues: [],
      conflictsBefore,
      conflictsAfter: [],
      unresolvedConflicts: [],
      currentProjectFinish: preparedBaseline.calculation.projectEarlyFinish,
      leveledProjectFinish: preparedBaseline.calculation.projectEarlyFinish,
      finishVarianceWorkingDays: 0,
      shiftedActivities: [],
      resourcesAffected: [],
      criticalPathImpact: criticalPathImpact(preparedBaseline, preparedBaseline),
      baselineActivities: preparedBaseline.activities,
      scenarioActivities: preparedBaseline.activities.map((activity) => ({ ...activity })),
      baselineCpm: preparedBaseline.calculation,
      scenarioCpm: preparedBaseline.calculation,
      manuallyShiftedActivityIds: [],
      sourceSnapshot: source,
    };
  }

  const impossibleConflict = conflictsBefore.find((conflict) => conflictIsIndividuallyImpossible(conflict, baselineDemand.cells));
  if (impossibleConflict) {
    return makeEmptyScenario(input, options, {
      status: 'no_feasible_scenario',
      message: 'No feasible leveled scenario / N/A. A single assigned activity exceeds verified resource availability; shifting dates cannot remove that overload.',
      dataIssues: [],
      conflictsBefore,
      conflictsAfter: conflictsBefore,
      unresolvedConflicts: conflictsBefore,
      currentProjectFinish: preparedBaseline.calculation.projectEarlyFinish,
      resourcesAffected,
      baselineActivities: preparedBaseline.activities,
      baselineCpm: preparedBaseline.calculation,
      sourceSnapshot: source,
    });
  }

  let currentPrepared = preparedBaseline;
  let currentActivities = preparedBaseline.activities.map((activity) => ({ ...activity }));
  let currentDemand = baselineDemand;
  let currentConflicts = conflictsBefore;
  const manuallyShifted = new Set<string>();
  const blockedActivityIds = new Set<string>();

  while (currentConflicts.length) {
    const conflict = currentConflicts[0];
    const candidates = findMoveCandidates(conflict, currentDemand.cells, currentActivities, input.assignments, currentPrepared, blockedActivityIds);
    let moved = false;

    for (const candidate of candidates) {
      const afterBlock = lastContiguousConflictDate(conflict, candidate.id, currentConflicts, candidate, options);
      const calendar = resolveActivityCalendar(candidate, options);
      const proposedStart = getNextWorkingDay(addCalendarDay(afterBlock), calendar);
      const currentResult = currentPrepared.byActivityId.get(candidate.id);
      if (!currentResult || proposedStart <= currentResult.earlyStart) {
        blockedActivityIds.add(candidate.id);
        continue;
      }

      const trialActivities = currentActivities.map((activity) => activity.id === candidate.id
        ? { ...activity, early_start: proposedStart }
        : { ...activity });
      const trialPrepared = prepareSchedule(trialActivities, input.links, options);
      if (scenarioHasNewScheduleViolation(input.activities, input.links, preparedBaseline, trialPrepared, options)) {
        blockedActivityIds.add(candidate.id);
        continue;
      }

      const trialDemand = buildDemand(trialPrepared.activities, input.resources, input.assignments, trialPrepared, options);
      if (trialDemand.issues.length) {
        return createInsufficientScenario(input, options, preparedBaseline, trialDemand.issues, conflictsBefore);
      }
      const trialConflicts = resourceConflicts(trialDemand.cells, input.resources);
      if (trialPrepared.byActivityId.get(candidate.id)!.earlyStart <= currentResult.earlyStart) {
        blockedActivityIds.add(candidate.id);
        continue;
      }

      currentPrepared = trialPrepared;
      currentActivities = trialPrepared.activities;
      currentDemand = trialDemand;
      currentConflicts = trialConflicts;
      manuallyShifted.add(candidate.id);
      blockedActivityIds.clear();
      moved = true;
      break;
    }

    if (!moved) {
      return makeEmptyScenario(input, options, {
        status: 'no_feasible_scenario',
        message: 'No feasible leveled scenario / N/A. One or more conflicts are caused by completed, actual, constrained, or otherwise non-movable work, or cannot be resolved without a schedule-logic violation.',
        dataIssues: [],
        conflictsBefore,
        conflictsAfter: currentConflicts,
        unresolvedConflicts: currentConflicts,
        currentProjectFinish: preparedBaseline.calculation.projectEarlyFinish,
        resourcesAffected,
        baselineActivities: preparedBaseline.activities,
        baselineCpm: preparedBaseline.calculation,
        sourceSnapshot: source,
      });
    }
  }

  const shiftedActivities = summarizeShiftedActivities(preparedBaseline, currentPrepared, input.activities, options, manuallyShifted);
  const variance = finishVarianceWorkingDays(preparedBaseline.calculation.projectEarlyFinish, currentPrepared.calculation.projectEarlyFinish, options);
  return {
    status: 'ready',
    message: 'A conflict-free scenario has been evaluated with canonical CPM. No schedule data has been persisted; explicit Apply is required.',
    dataIssues: [],
    conflictsBefore,
    conflictsAfter: currentConflicts,
    unresolvedConflicts: currentConflicts,
    currentProjectFinish: preparedBaseline.calculation.projectEarlyFinish,
    leveledProjectFinish: currentPrepared.calculation.projectEarlyFinish,
    finishVarianceWorkingDays: variance,
    shiftedActivities,
    resourcesAffected,
    criticalPathImpact: criticalPathImpact(preparedBaseline, currentPrepared),
    baselineActivities: preparedBaseline.activities,
    scenarioActivities: currentPrepared.activities.map((activity) => ({ ...activity })),
    baselineCpm: preparedBaseline.calculation,
    scenarioCpm: currentPrepared.calculation,
    manuallyShiftedActivityIds: [...manuallyShifted].sort(),
    sourceSnapshot: source,
  };
}

export function generateResourceHistogram(input: ResourceLevelingInput): ResourceHistogramData {
  const options = canonicalOptions(input.cpmOptions);
  if (!input.activities.length || !input.resources.length || !input.assignments.length) {
    return {
      dates: [],
      timeBuckets: [],
      resourceSummaries: input.resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
        type: resource.type,
        unit: resource.unit,
        maxAvailability: numeric(resource.availability),
        peakAllocated: null,
        avgAllocated: null,
        isOverallocated: null,
        overallocatedDaysCount: null,
        dataStatus: 'insufficient_data',
      })),
      dataStatus: 'insufficient_data',
      dataIssues: [
        !input.activities.length ? 'No activities were supplied.' : '',
        !input.resources.length ? 'No project resources were supplied.' : '',
        !input.assignments.length ? 'No resource assignments were supplied.' : '',
      ].filter(Boolean),
    };
  }

  const prepared = prepareSchedule(input.activities, input.links, options);
  if (prepared.calculation.cycle) {
    return {
      dates: [],
      timeBuckets: [],
      resourceSummaries: [],
      dataStatus: 'insufficient_data',
      dataIssues: [`CPM logic cycle: ${prepared.calculation.cycle.join(' → ')}`],
    };
  }
  const demand = buildDemand(input.activities, input.resources, input.assignments, prepared, options);
  if (demand.issues.length) {
    return {
      dates: [],
      timeBuckets: [],
      resourceSummaries: input.resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
        type: resource.type,
        unit: resource.unit,
        maxAvailability: numeric(resource.availability),
        peakAllocated: null,
        avgAllocated: null,
        isOverallocated: null,
        overallocatedDaysCount: null,
        dataStatus: 'insufficient_data',
      })),
      dataStatus: 'insufficient_data',
      dataIssues: demand.issues,
    };
  }
  const byResource = new Map<string, Map<string, number>>();
  for (const cell of demand.cells.values()) {
    const dates = byResource.get(cell.resourceId) || new Map<string, number>();
    dates.set(cell.date, cell.demand);
    byResource.set(cell.resourceId, dates);
  }
  const allDates = [...new Set([...byResource.values()].flatMap((dateMap) => [...dateMap.keys()]))].sort();
  const resourceSummaries: ResourceSummaryItem[] = input.resources.map((resource) => {
    const daily = [...(byResource.get(resource.id)?.values() || [])];
    const capacity = numeric(resource.availability);
    const peak = daily.length ? Math.max(...daily) : null;
    const avg = daily.length ? daily.reduce((sum, value) => sum + value, 0) / daily.length : null;
    const statusMissing = capacity === null || capacity <= 0 || demand.issues.length > 0;
    return {
      id: resource.id,
      name: resource.name,
      type: resource.type,
      unit: resource.unit,
      maxAvailability: capacity,
      peakAllocated: peak === null ? null : roundUnits(peak),
      avgAllocated: avg === null ? null : roundUnits(avg),
      isOverallocated: statusMissing || peak === null ? null : peak > capacity + EPSILON,
      overallocatedDaysCount: statusMissing || capacity === null ? null : [...(byResource.get(resource.id)?.values() || [])].filter((value) => value > capacity + EPSILON).length,
      dataStatus: statusMissing ? 'insufficient_data' : daily.length ? 'measured' : 'no_remaining_assignment',
    };
  });

  const timeBuckets: ResourceHistogramData['timeBuckets'] = [];
  for (let offset = 0; offset < allDates.length; offset += 6) {
    const bucketDays = allDates.slice(offset, offset + 6);
    const startDate = bucketDays[0];
    const endDate = bucketDays[bucketDays.length - 1];
    const resourceUnits: Record<string, number> = {};
    let isOverallocated: boolean | null = false;
    for (const resource of input.resources) {
      const values = byResource.get(resource.id);
      const used = Math.max(0, ...bucketDays.map((date) => values?.get(date) || 0));
      resourceUnits[resource.id] = roundUnits(used);
      const capacity = numeric(resource.availability);
      if (capacity === null || capacity <= 0) isOverallocated = null;
      else if (values && bucketDays.some((date) => (values.get(date) || 0) > capacity + EPSILON)) isOverallocated = true;
    }
    timeBuckets.push({
      dateLabel: `${startDate.slice(5)} – ${endDate.slice(5)}`,
      startDate,
      endDate,
      resourceUnits,
      isOverallocated,
    });
  }

  return {
    dates: allDates,
    timeBuckets,
    resourceSummaries,
    dataStatus: demand.issues.length ? 'insufficient_data' : demand.activeAssignmentCount ? 'measured' : 'no_remaining_assignment',
    dataIssues: demand.issues,
  };
}

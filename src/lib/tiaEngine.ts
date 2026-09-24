import type {
  Activity,
  ActivityLink,
  CalendarType,
  DelayClaimEvent,
  DelayEventType,
  DelayResponsibility,
  FragnetItem,
} from '@/types';
import { calculateCpm, type CpmOptions } from './cpmEngine';
import { addWorkingDays, countWorkingDays, getCalendar } from './calendarEngine';

/** Identifies records whose CPM impact was measured with the single-fragnet method below. */
export const TIA_ANALYSIS_METHOD = 'statused-cpm-single-fragnet-v1';

export interface TIAAnalysisInput {
  projectId: string;
  claimNumber: string;
  title: string;
  description: string;
  eventType: DelayEventType;
  responsibility: DelayResponsibility;
  /** The existing relationship to replace with predecessor → fragnet → successor. */
  insertionLinkId: string;
  delayDurationDays: number;
  impactStartDate: string;
  /** Optional, explicit user/contract input. No rate is assumed when omitted. */
  dailyIndirectCostRate?: number | null;
  contractualClause?: string | null;
  activities: Activity[];
  links: ActivityLink[];
  cpmOptions?: CpmOptions;
  /** Other real/user-recorded TIA events used only to surface date-overlap evidence. */
  recordedClaims?: DelayClaimEvent[];
}

export interface TIAConcurrencyOverlap {
  claimId: string;
  claimNumber: string;
  overlapStart: string;
  overlapEnd: string;
  measuredCriticalDelayDays: number;
}

export interface TIAConcurrencyAssessment {
  status: 'potential_overlap' | 'unavailable';
  evidence: TIAConcurrencyOverlap[];
  note: string;
}

export interface TIAEotRecommendation {
  status: 'approved' | 'not_recommended' | 'unproven';
  /** Null until a supported determination exists; zero is used only for zero measured CPM impact. */
  days: number | null;
  note: string;
}

/** In-memory analysis output. scenarioActivities/Links are never written to the source schedule. */
export interface TIAAnalysisResult extends DelayClaimEvent {
  scenarioActivities: Activity[];
  scenarioLinks: ActivityLink[];
  concurrencyAssessment: TIAConcurrencyAssessment;
  eotRecommendation: TIAEotRecommendation;
  assumptions: string[];
}

export class TIAValidationError extends Error {
  readonly code: 'invalid_input' | 'missing_insertion_link' | 'invalid_schedule' | 'cyclic_schedule' | 'finish_unavailable' | 'duplicate_fragnet_id';

  constructor(
    code: TIAValidationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'TIAValidationError';
    this.code = code;
  }
}

const validResponsibility: DelayResponsibility[] = [
  'excusable_compensable',
  'excusable_non_compensable',
  'non_excusable',
];

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizedIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'event';
}

function measuredFinishDeltaDays(before: string, after: string, calendar: ReturnType<typeof getCalendar>): number {
  if (!before || !after || after <= before) return 0;
  return Math.max(0, countWorkingDays(before, after, calendar) - 1);
}

function isRecordedForConcurrency(claim: DelayClaimEvent, dataDate: string): boolean {
  return (
    claim.analysis_method === TIA_ANALYSIS_METHOD &&
    claim.status !== 'rejected' &&
    claim.critical_delay_days > 0 &&
    isValidIsoDate(claim.start_date) &&
    isValidIsoDate(claim.end_date) &&
    claim.start_date <= dataDate
  );
}

/**
 * Reports only potential overlap supported by two recorded TIA events with measured CPM impact.
 * Absence of a qualifying record is explicitly unavailable, not a finding of no concurrency.
 */
export function assessConcurrencyEvidence(
  candidate: DelayClaimEvent,
  recordedClaims: DelayClaimEvent[],
  dataDate: string | null | undefined,
): TIAConcurrencyAssessment {
  if (
    candidate.analysis_method !== TIA_ANALYSIS_METHOD ||
    candidate.critical_delay_days <= 0 ||
    !dataDate ||
    !isValidIsoDate(dataDate) ||
    !isValidIsoDate(candidate.start_date) ||
    !isValidIsoDate(candidate.end_date) ||
    candidate.start_date > dataDate
  ) {
    return {
      status: 'unavailable',
      evidence: [],
      note: 'N/A — no occurred, measured CPM event window is available for comparison.',
    };
  }

  const candidateEnd = candidate.end_date > dataDate ? dataDate : candidate.end_date;
  const evidence = recordedClaims
    .filter((claim) => claim.id !== candidate.id && isRecordedForConcurrency(claim, dataDate))
    .flatMap((claim) => {
      const otherEnd = claim.end_date > dataDate ? dataDate : claim.end_date;
      const overlapStart = candidate.start_date > claim.start_date ? candidate.start_date : claim.start_date;
      const overlapEnd = candidateEnd < otherEnd ? candidateEnd : otherEnd;
      if (overlapStart > overlapEnd) return [];
      return [{
        claimId: claim.id,
        claimNumber: claim.claim_number,
        overlapStart,
        overlapEnd,
        measuredCriticalDelayDays: claim.critical_delay_days,
      }];
    });

  if (evidence.length === 0) {
    return {
      status: 'unavailable',
      evidence: [],
      note: 'N/A — no qualifying recorded delay event with measured CPM impact overlaps this event window.',
    };
  }

  return {
    status: 'potential_overlap',
    evidence,
    note: 'Potential date overlap is supported by recorded event windows and measured CPM impacts; it is not a concurrency or entitlement determination.',
  };
}

export function recommendEot(
  claim: DelayClaimEvent,
  concurrency: TIAConcurrencyAssessment,
): TIAEotRecommendation {
  if (claim.status === 'approved_eot' && claim.eot_days_claimed !== null && Number.isFinite(claim.eot_days_claimed)) {
    return {
      status: 'approved',
      days: claim.eot_days_claimed,
      note: 'Displays the EOT days already recorded in an approved determination; no new days are inferred.',
    };
  }

  if (claim.critical_delay_days === 0) {
    return {
      status: 'not_recommended',
      days: 0,
      note: 'No project-finish movement was measured by CPM, so the measured critical delay is zero.',
    };
  }

  if (claim.responsibility === 'non_excusable' || claim.status === 'rejected') {
    return {
      status: 'not_recommended',
      days: null,
      note: claim.status === 'rejected'
        ? 'The recorded event is rejected; no EOT is recommended.'
        : 'The user-recorded responsibility classification is non-excusable; no EOT is recommended.',
    };
  }

  const concurrencyNote = concurrency.status === 'potential_overlap'
    ? 'Potential overlapping recorded event evidence requires determination.'
    : 'Concurrency evidence is N/A and has not been established.';

  return {
    status: 'unproven',
    days: null,
    note: `Measured CPM impact is ${claim.critical_delay_days} working day(s); responsibility is recorded as ${claim.responsibility}. ${concurrencyNote} Entitlement evidence is insufficient, so EOT days are Unproven / N/A.`,
  };
}

export function performTimeImpactAnalysis(input: TIAAnalysisInput): TIAAnalysisResult {
  const {
    projectId,
    claimNumber,
    title,
    description,
    eventType,
    responsibility,
    insertionLinkId,
    delayDurationDays,
    impactStartDate,
    dailyIndirectCostRate,
    contractualClause,
    activities,
    links,
    cpmOptions = {},
    recordedClaims = [],
  } = input;

  if (!projectId.trim() || !claimNumber.trim() || !title.trim() || !description.trim()) {
    throw new TIAValidationError('invalid_input', 'Project, claim number, title, and event description are required.');
  }
  if (!validResponsibility.includes(responsibility) || !eventType) {
    throw new TIAValidationError('invalid_input', 'Select an event type and record a responsibility classification.');
  }
  if (!Number.isInteger(delayDurationDays) || delayDurationDays <= 0) {
    throw new TIAValidationError('invalid_input', 'Fragnet duration must be a positive whole number of days.');
  }
  if (!isValidIsoDate(impactStartDate)) {
    throw new TIAValidationError('invalid_input', 'Enter a valid impact start date.');
  }
  if (dailyIndirectCostRate !== undefined && dailyIndirectCostRate !== null &&
    (!Number.isFinite(dailyIndirectCostRate) || dailyIndirectCostRate < 0)) {
    throw new TIAValidationError('invalid_input', 'An entered daily rate must be a non-negative finite amount.');
  }
  if (activities.length === 0 || !insertionLinkId) {
    throw new TIAValidationError('invalid_schedule', 'A schedule and an explicit relationship insertion point are required.');
  }

  const activityIds = new Set<string>();
  for (const activity of activities) {
    if (activityIds.has(activity.id) || activity.project_id !== projectId ||
      !Number.isFinite(activity.duration_days) || activity.duration_days < 0) {
      throw new TIAValidationError('invalid_schedule', 'Source activities must have unique IDs, valid non-negative durations, and belong to the selected project.');
    }
    activityIds.add(activity.id);
  }
  const linkIds = new Set<string>();
  for (const link of links) {
    if (linkIds.has(link.id) ||
      !activityIds.has(link.predecessor_id) ||
      !activityIds.has(link.successor_id) ||
      link.predecessor_id === link.successor_id ||
      link.project_id !== projectId ||
      !['FS', 'SS', 'FF', 'SF'].includes(link.link_type) ||
      !Number.isFinite(link.lag_days)) {
      throw new TIAValidationError('invalid_schedule', 'Source relationships must have unique IDs, valid project activities, and finite lags.');
    }
    linkIds.add(link.id);
  }

  const insertionLink = links.find((link) => link.id === insertionLinkId);
  if (!insertionLink) {
    throw new TIAValidationError('missing_insertion_link', 'The selected relationship no longer exists in the source schedule.');
  }

  const predecessor = activities.find((activity) => activity.id === insertionLink.predecessor_id);
  const successor = activities.find((activity) => activity.id === insertionLink.successor_id);
  if (!predecessor || !successor || predecessor.id === successor.id ||
    predecessor.project_id !== projectId || successor.project_id !== projectId) {
    throw new TIAValidationError('invalid_schedule', 'The selected relationship must connect two distinct activities in this project.');
  }

  const calendarType: CalendarType = cpmOptions.calendarType || '6_days';
  const calendar = getCalendar(calendarType, cpmOptions.customHolidays || []);

  // Baseline is the unimpacted statused schedule, evaluated with the same canonical CPM options.
  const baselineCpm = calculateCpm(activities, links, cpmOptions);
  if (baselineCpm.cycle) {
    throw new TIAValidationError('cyclic_schedule', `The unimpacted schedule contains a logic cycle: ${baselineCpm.cycle.join(' → ')}.`);
  }
  const baselineFinish = baselineCpm.projectEarlyFinish;
  if (!isValidIsoDate(baselineFinish)) {
    throw new TIAValidationError('finish_unavailable', 'CPM could not determine a valid unimpacted project finish.');
  }

  const fragnetId = `tia-frg-${normalizedIdPart(claimNumber)}-${normalizedIdPart(insertionLinkId)}`;
  const incomingLinkId = `tia-frg-in-${normalizedIdPart(claimNumber)}-${normalizedIdPart(insertionLinkId)}`;
  const outgoingLinkId = `tia-frg-out-${normalizedIdPart(claimNumber)}-${normalizedIdPart(insertionLinkId)}`;
  if (activities.some((activity) => activity.id === fragnetId) ||
    linkIds.has(incomingLinkId) || linkIds.has(outgoingLinkId) || incomingLinkId === outgoingLinkId) {
    throw new TIAValidationError('duplicate_fragnet_id', 'A generated fragnet/activity relationship ID already exists in the source schedule.');
  }
  const fragnetCode = `FRG-${normalizedIdPart(claimNumber)}`;
  const fragnetName = `[Fragnet] ${title.trim()} (${delayDurationDays} d)`;

  const fragnetActivity: Activity = {
    id: fragnetId,
    project_id: projectId,
    wbs_node_id: predecessor.wbs_node_id,
    code: fragnetCode,
    name: fragnetName,
    early_start: impactStartDate,
    early_finish: null,
    late_start: null,
    late_finish: null,
    actual_start: null,
    actual_finish: null,
    duration_days: delayDurationDays,
    planned_quantity: 0,
    actual_quantity: 0,
    unit: 'day',
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    sort_order: predecessor.sort_order + 0.5,
    created_at: new Date().toISOString(),
  };

  const { predecessor: _predecessor, successor: _successor, ...relationshipFields } = insertionLink;
  const incomingLink: ActivityLink = {
    ...relationshipFields,
    id: incomingLinkId,
    predecessor_id: insertionLink.predecessor_id,
    successor_id: fragnetId,
  };
  const outgoingLink: ActivityLink = {
    ...relationshipFields,
    id: outgoingLinkId,
    predecessor_id: fragnetId,
    successor_id: insertionLink.successor_id,
    link_type: 'FS',
    lag_days: 0,
    lag_days_exact: 0,
    lag_hours: 0,
  };

  // Clone inputs and replace exactly the selected edge. The source activities/links remain untouched.
  const scenarioActivities = [...activities.map((activity) => ({ ...activity })), fragnetActivity];
  const scenarioLinks = [
    ...links.filter((link) => link.id !== insertionLinkId).map((link) => ({ ...link })),
    incomingLink,
    outgoingLink,
  ];

  const impactedCpm = calculateCpm(scenarioActivities, scenarioLinks, cpmOptions);
  if (impactedCpm.cycle) {
    throw new TIAValidationError('cyclic_schedule', `The fragnet scenario contains a logic cycle: ${impactedCpm.cycle.join(' → ')}.`);
  }
  const impactedFinish = impactedCpm.projectEarlyFinish;
  if (!isValidIsoDate(impactedFinish)) {
    throw new TIAValidationError('finish_unavailable', 'CPM could not determine a valid impacted project finish.');
  }

  // The event duration is never used as a substitute for a measured project-finish movement.
  const criticalDelayDays = measuredFinishDeltaDays(baselineFinish, impactedFinish, calendar);
  const impactEndDate = addWorkingDays(impactStartDate, delayDurationDays, calendar);
  const rate = dailyIndirectCostRate === undefined ? null : dailyIndirectCostRate;
  const contractualReference = contractualClause?.trim() || '';
  const fragnet: FragnetItem = {
    id: fragnetId,
    code: fragnetCode,
    name: fragnetName,
    duration_days: delayDurationDays,
    predecessor_id: insertionLink.predecessor_id,
    successor_id: insertionLink.successor_id,
    impact_date: impactStartDate,
    insertion_link_id: insertionLink.id,
    insertion_link_type: insertionLink.link_type,
    insertion_lag_days: insertionLink.lag_days,
  };

  const claimBase: DelayClaimEvent = {
    id: `claim-${normalizedIdPart(claimNumber)}-${Date.now()}`,
    project_id: projectId,
    claim_number: claimNumber.trim(),
    title: title.trim(),
    description: description.trim(),
    event_type: eventType,
    responsibility,
    start_date: impactStartDate,
    end_date: impactEndDate,
    affected_activity_id: insertionLink.predecessor_id,
    delay_duration_days: delayDurationDays,
    fragnets: [fragnet],
    pre_impact_project_finish: baselineFinish,
    post_impact_project_finish: impactedFinish,
    critical_delay_days: criticalDelayDays,
    eot_days_claimed: null,
    daily_indirect_cost_rate: rate,
    compensation_claimed_sar: null,
    status: 'draft',
    contractual_reference: contractualReference,
    created_at: new Date().toISOString(),
    analysis_method: TIA_ANALYSIS_METHOD,
  };

  const dataDate = cpmOptions.dataDate || baselineCpm.dataDate;
  const concurrencyAssessment = assessConcurrencyEvidence(claimBase, recordedClaims, dataDate);
  const eotRecommendation = recommendEot(claimBase, concurrencyAssessment);
  const canPriceApprovedEot = eotRecommendation.status === 'approved' &&
    eotRecommendation.days !== null &&
    responsibility === 'excusable_compensable' &&
    rate !== null;
  const compensation = canPriceApprovedEot ? eotRecommendation.days! * rate : null;

  const assumptions = [
    `Baseline and impacted dates use canonical CPM with data date ${dataDate || 'N/A'} and the supplied schedule status/calendar options.`,
    `One ${delayDurationDays}-day fragnet was inserted by replacing relationship ${insertionLink.id} (${insertionLink.predecessor_id} → ${insertionLink.successor_id}, ${insertionLink.link_type}, lag ${insertionLink.lag_days}d).`,
    'No source activity duration or source relationship was modified; no event-duration fallback is applied to critical delay.',
    concurrencyAssessment.note,
    rate === null
      ? 'No contractual/user daily rate or real cost evidence was supplied; prolongation cost is N/A.'
      : `An explicit user-entered daily rate of ${rate} was recorded; no cost is calculated until an approved EOT/cost basis exists.`,
    contractualReference
      ? `Contractual reference supplied by user: ${contractualReference}.`
      : 'No contractual clause or entitlement determination was supplied.',
  ];

  return {
    ...claimBase,
    compensation_claimed_sar: compensation,
    scenarioActivities,
    scenarioLinks,
    concurrencyAssessment,
    eotRecommendation,
    assumptions,
  };
}

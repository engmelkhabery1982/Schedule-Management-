import type {
  Activity,
  ActivityLink,
  CalendarType,
  DelayClaimEvent,
  DelayEventType,
  DelayResponsibility,
  FragnetItem,
} from '@/types';
import { calculateCpm } from './cpmEngine';
import { addWorkingDays, countWorkingDays, getCalendar } from './calendarEngine';

export interface TIAAnalysisInput {
  projectId: string;
  claimNumber: string;
  title: string;
  description: string;
  eventType: DelayEventType;
  responsibility: DelayResponsibility;
  affectedActivityId: string;
  delayDurationDays: number;
  impactStartDate: string;
  dailyIndirectCostRate?: number;
  contractualClause?: string;
  activities: Activity[];
  links: ActivityLink[];
  calendarType?: CalendarType;
}

export function performTimeImpactAnalysis(input: TIAAnalysisInput): DelayClaimEvent {
  const {
    projectId,
    claimNumber,
    title,
    description,
    eventType,
    responsibility,
    affectedActivityId,
    delayDurationDays,
    impactStartDate,
    dailyIndirectCostRate = 4800, // 4800 SAR/day typical site indirect overhead
    contractualClause = 'عقد فيديك الأحمر - المادة 8.4 (تمديد مدة الإنجاز) والمادة 20.1 (مطالبات المقاول)',
    activities,
    links,
    calendarType = '6_days',
  } = input;

  const calendar = getCalendar(calendarType);

  // 1. Pre-Impact CPM Run
  const preImpactCpm = calculateCpm(activities, links, calendarType);
  const preFinish = preImpactCpm.projectEarlyFinish;

  const affectedAct = activities.find((a) => a.id === affectedActivityId);
  const fragnetId = `frg-${Date.now()}`;
  const fragnetCode = `FRG-${claimNumber}`;
  const fragnetName = `[FragNet] ${title} (+${delayDurationDays} يوم)`;

  const fragnetItem: FragnetItem = {
    id: fragnetId,
    code: fragnetCode,
    name: fragnetName,
    duration_days: delayDurationDays,
    predecessor_id: affectedActivityId,
    successor_id: '',
    impact_date: impactStartDate,
  };

  // 2. Build Post-Impact network with Fragnet inserted
  // Find successors of the affected activity
  const affectedSuccessorLinks = links.filter((l) => l.predecessor_id === affectedActivityId);

  const fragnetActivity: Activity = {
    id: fragnetId,
    project_id: projectId,
    wbs_node_id: affectedAct?.wbs_node_id || null,
    code: fragnetCode,
    name: fragnetName,
    early_start: impactStartDate,
    early_finish: addWorkingDays(impactStartDate, delayDurationDays, calendar),
    late_start: null,
    late_finish: null,
    actual_start: null,
    actual_finish: null,
    duration_days: delayDurationDays,
    planned_quantity: 0,
    actual_quantity: 0,
    unit: 'day',
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
    sort_order: (affectedAct?.sort_order || 1) + 0.5,
    created_at: new Date().toISOString(),
  };

  // To model the delay impact on the affected activity itself, we can either:
  // a) Extend the affected activity's duration by delayDurationDays, OR
  // b) Insert the fragnet as a mandatory predecessor to downstream activities.
  // In professional TIA, the fragnet is linked FS from the affected activity, and all successors now depend on the fragnet.
  const modifiedActivities = activities.map((a) => {
    if (a.id === affectedActivityId && a.percent_complete < 100) {
      return {
        ...a,
        duration_days: (a.duration_days || 1) + delayDurationDays,
      };
    }
    return a;
  });

  const postActivities = [...modifiedActivities, fragnetActivity];

  const newLinks: ActivityLink[] = [
    ...links.filter((l) => l.predecessor_id !== affectedActivityId),
    {
      id: `lnk-frg-in-${fragnetId}`,
      project_id: projectId,
      predecessor_id: affectedActivityId,
      successor_id: fragnetId,
      link_type: 'FS',
      lag_days: 0,
    },
  ];

  if (affectedSuccessorLinks.length > 0) {
    affectedSuccessorLinks.forEach((origLink, idx) => {
      newLinks.push({
        id: `lnk-frg-out-${fragnetId}-${idx}`,
        project_id: projectId,
        predecessor_id: fragnetId,
        successor_id: origLink.successor_id,
        link_type: origLink.link_type || 'FS',
        lag_days: origLink.lag_days || 0,
      });
    });
  } else {
    // If no successors, link to the final milestone
    const lastMilestone = activities.find((a) => a.is_milestone && a.milestone_type === 'finish');
    if (lastMilestone) {
      newLinks.push({
        id: `lnk-frg-out-${fragnetId}-ms`,
        project_id: projectId,
        predecessor_id: fragnetId,
        successor_id: lastMilestone.id,
        link_type: 'FS',
        lag_days: 0,
      });
    }
  }

  // 3. Post-Impact CPM Run
  const postImpactCpm = calculateCpm(postActivities, newLinks, calendarType);
  const postFinish = postImpactCpm.projectEarlyFinish;

  // 4. Calculate Critical Delay & Entitlements
  let criticalDelayDays = Math.max(0, countWorkingDays(preFinish, postFinish, calendar) - 1);
  if (criticalDelayDays === 0) {
    criticalDelayDays = delayDurationDays;
  }

  const eotDaysClaimed = responsibility === 'non_excusable' ? 0 : criticalDelayDays;

  const prolongationCompensation =
    responsibility === 'excusable_compensable'
      ? eotDaysClaimed * dailyIndirectCostRate
      : 0;

  const impactEndDate = addWorkingDays(impactStartDate, delayDurationDays, calendar);

  return {
    id: `claim-${Date.now()}`,
    project_id: projectId,
    claim_number: claimNumber,
    title,
    description,
    event_type: eventType,
    responsibility,
    start_date: impactStartDate,
    end_date: impactEndDate,
    affected_activity_id: affectedActivityId,
    delay_duration_days: delayDurationDays,
    fragnets: [fragnetItem],
    pre_impact_project_finish: preFinish,
    post_impact_project_finish: postFinish,
    critical_delay_days: criticalDelayDays,
    eot_days_claimed: eotDaysClaimed,
    daily_indirect_cost_rate: dailyIndirectCostRate,
    compensation_claimed_sar: prolongationCompensation,
    status: 'draft',
    contractual_reference: contractualClause,
    created_at: new Date().toISOString(),
  };
}

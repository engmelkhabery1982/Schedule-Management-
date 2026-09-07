import type { Activity, ActivityLink } from '@/types';

export interface CpmResult {
  activityId: string;
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  totalFloat: number;
  isCritical: boolean;
}

export interface CpmCalculation {
  results: CpmResult[];
  cycle: string[] | null;
}

const DAY = 86400000;

function dateOnly(value: Date): string {
  return value.toISOString().split('T')[0];
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function diffDays(start: string, finish: string): number {
  return Math.round((new Date(`${finish}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / DAY);
}

function linkType(link: ActivityLink): 'FS' | 'SS' | 'FF' | 'SF' {
  return link.link_type === 'SS' || link.link_type === 'FF' || link.link_type === 'SF' ? link.link_type : 'FS';
}

function forwardConstraint(
  predecessor: { start: string; finish: string },
  successor: Activity,
  link: ActivityLink,
): string {
  const lag = Number(link.lag_days || 0);
  switch (linkType(link)) {
    case 'SS': return addDays(predecessor.start, lag);
    case 'FF': return addDays(predecessor.finish, lag - successor.duration_days);
    case 'SF': return addDays(predecessor.start, lag - successor.duration_days);
    default: return addDays(predecessor.finish, lag);
  }
}

function backwardConstraint(
  successor: { start: string; finish: string },
  predecessor: Activity,
  link: ActivityLink,
): string {
  const lag = Number(link.lag_days || 0);
  switch (linkType(link)) {
    case 'SS': return addDays(successor.start, -lag);
    case 'FF': return addDays(successor.finish, -lag - predecessor.duration_days);
    case 'SF': return addDays(successor.start, -lag - predecessor.duration_days);
    default: return addDays(successor.start, -lag - predecessor.duration_days);
  }
}

function findCycle(activities: Activity[], links: ActivityLink[]): string[] | null {
  const graph = new Map<string, string[]>();
  links.forEach((link) => graph.set(link.predecessor_id, [...(graph.get(link.predecessor_id) || []), link.successor_id]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  function visit(id: string): string[] | null {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const next of graph.get(id) || []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }
  for (const activity of activities) {
    const cycle = visit(activity.id);
    if (cycle) return cycle;
  }
  return null;
}

export function calculateCpm(activities: Activity[], links: ActivityLink[]): CpmCalculation {
  const cycle = findCycle(activities, links);
  if (cycle) return { results: [], cycle };
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const predecessors = new Map<string, ActivityLink[]>();
  const successors = new Map<string, ActivityLink[]>();
  links.forEach((link) => {
    predecessors.set(link.successor_id, [...(predecessors.get(link.successor_id) || []), link]);
    successors.set(link.predecessor_id, [...(successors.get(link.predecessor_id) || []), link]);
  });
  const order: Activity[] = [];
  const visited = new Set<string>();
  function topological(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    (successors.get(id) || []).forEach((link) => topological(link.successor_id));
    const activity = byId.get(id);
    if (activity) order.unshift(activity);
  }
  activities.forEach((activity) => topological(activity.id));

  const early = new Map<string, { start: string; finish: string }>();
  for (const activity of order) {
    const ownStart = activity.early_start || new Date().toISOString().split('T')[0];
    const predecessorStarts = (predecessors.get(activity.id) || [])
      .map((link) => {
        const predecessor = early.get(link.predecessor_id);
        return predecessor ? forwardConstraint(predecessor, activity, link) : null;
      })
      .filter((date): date is string => Boolean(date));
    const start = predecessorStarts.length > 0
      ? predecessorStarts.reduce((max, date) => date > max ? date : max, ownStart)
      : ownStart;
    early.set(activity.id, { start, finish: addDays(start, activity.duration_days) });
  }
  const projectFinish = [...early.values()].reduce((max, value) => value.finish > max ? value.finish : max, '');
  const late = new Map<string, { start: string; finish: string }>();
  for (const activity of [...order].reverse()) {
    const successorStarts = (successors.get(activity.id) || [])
      .map((link) => {
        const successor = late.get(link.successor_id);
        const successorActivity = byId.get(link.successor_id);
        return successor && successorActivity ? backwardConstraint(successor, activity, link) : null;
      })
      .filter((date): date is string => Boolean(date));
    const start = successorStarts.length > 0
      ? successorStarts.reduce((min, date) => date < min ? date : min, addDays(projectFinish, -activity.duration_days))
      : addDays(projectFinish, -activity.duration_days);
    late.set(activity.id, { start, finish: addDays(start, activity.duration_days) });
  }
  return {
    results: activities.map((activity) => {
      const e = early.get(activity.id) || { start: activity.early_start || projectFinish, finish: activity.early_finish || projectFinish };
      const l = late.get(activity.id) || e;
      const totalFloat = diffDays(e.start, l.start);
      return {
        activityId: activity.id,
        earlyStart: e.start,
        earlyFinish: e.finish,
        lateStart: l.start,
        lateFinish: l.finish,
        totalFloat,
        isCritical: totalFloat <= 0,
      };
    }),
    cycle: null,
  };
}

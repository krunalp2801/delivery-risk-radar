/**
 * Measured throughput, and what it implies about a date.
 *
 * This is the part of the report I would defend hardest, because it is the
 * part that replaces an opinion with an arithmetic. "Are we going to make it"
 * is usually answered by asking the team how they feel, and the answer is
 * reliably optimistic right up until it is not. Counting what the team has
 * actually closed per week and dividing the remainder by it is cruder and far
 * harder to argue with.
 *
 * Everything here is a pure function of a snapshot and a date.
 */

import { addDays, daysBetween, DAY_MS } from "./domain.ts";
import type { Issue } from "./domain.ts";

/** Issues (or points, when every issue has an estimate) remaining. */
export interface Remaining {
  /** Number of open issues. */
  count: number;
  /** Sum of estimates, or null when any open issue lacks one. */
  points: number | null;
}

/** When the last issue in a set closed, or undefined if none has. */
export function lastClosedAt(issues: Issue[]): string | undefined {
  const dates = issues
    .map((issue) => issue.closedAt)
    .filter((at): at is string => at !== undefined)
    .sort();
  return dates[dates.length - 1];
}

export function remainingWork(issues: Issue[]): Remaining {
  const open = issues.filter((issue) => issue.state === "open");
  const estimates = open.map((issue) => issue.estimate);
  // Partial estimates are worse than none: summing the issues that happen to
  // have points understates the remainder and does it invisibly.
  const points = estimates.every((e) => e !== undefined)
    ? estimates.reduce((sum, e) => sum + (e ?? 0), 0)
    : null;
  return { count: open.length, points };
}

export interface Throughput {
  /** Issues, or points when every closed issue in the window had an estimate. */
  perWeek: number;
  /** How much data this is based on. A projection from one week is a guess. */
  weeksObserved: number;
  unit: "issues" | "points";
  closedInWindow: number;
}

/**
 * Closure rate over a trailing window.
 *
 * The window is clamped to the age of the project, so a two-week-old project
 * does not get its throughput divided by four and look four times slower than
 * it is. That was the first bug I wrote in this file and it made every new
 * project look doomed.
 */
export function measureThroughput(issues: Issue[], takenAt: string, windowWeeks: number): Throughput {
  const now = Date.parse(takenAt);
  const windowStart = now - windowWeeks * 7 * DAY_MS;

  const closedInWindow = issues.filter((issue) => {
    if (issue.state !== "closed" || issue.closedAt === undefined) return false;
    const closed = Date.parse(issue.closedAt);
    return closed >= windowStart && closed <= now;
  });

  const earliestCreated = issues.reduce<number>(
    (min, issue) => Math.min(min, Date.parse(issue.createdAt)),
    now,
  );
  const projectAgeWeeks = Math.max((now - earliestCreated) / (7 * DAY_MS), 1 / 7);
  const weeksObserved = Math.min(windowWeeks, projectAgeWeeks);

  const everyClosedHasEstimate =
    closedInWindow.length > 0 && closedInWindow.every((issue) => issue.estimate !== undefined);
  const volume = everyClosedHasEstimate
    ? closedInWindow.reduce((sum, issue) => sum + (issue.estimate ?? 0), 0)
    : closedInWindow.length;

  return {
    perWeek: volume / weeksObserved,
    weeksObserved: Math.round(weeksObserved * 10) / 10,
    unit: everyClosedHasEstimate ? "points" : "issues",
    closedInWindow: closedInWindow.length,
  };
}

export interface Projection {
  /** Null when throughput is zero: "never" is not a date and must not be faked. */
  completion: string | null;
  /** Positive means late. Null without both a due date and a projection. */
  slipDays: number | null;
  weeksRemaining: number | null;
}

/**
 * Project a completion date from remaining work and measured throughput.
 *
 * Deliberately linear. A burn-up with a confidence interval would look more
 * sophisticated and would need more history than most projects have, and the
 * extra precision would be spurious: the dominant error here is unlogged
 * work, not the choice of curve.
 */
export function project(
  remaining: Remaining,
  throughput: Throughput,
  takenAt: string,
  dueOn?: string,
  /** When the last issue closed, for a milestone with nothing left. */
  finishedAt?: string,
): Projection {
  const volume = throughput.unit === "points" && remaining.points !== null ? remaining.points : remaining.count;

  if (volume === 0) {
    // Nothing left, so this is history rather than a forecast. The honest
    // completion date is when the last issue actually closed, not now, and
    // the slip is measured against that. Reporting `takenAt` here made a
    // milestone that shipped three weeks late read as "on the day".
    const lastClosed = finishedAt ?? takenAt;
    const slipDays = dueOn === undefined ? null : daysBetween(dueOn, lastClosed);
    return { completion: lastClosed, slipDays, weeksRemaining: 0 };
  }
  if (throughput.perWeek <= 0) {
    return { completion: null, slipDays: null, weeksRemaining: null };
  }

  const weeksRemaining = volume / throughput.perWeek;
  const completion = addDays(new Date(Date.parse(takenAt)), Math.ceil(weeksRemaining * 7));
  const slipDays = dueOn === undefined ? null : daysBetween(dueOn, completion.toISOString());

  return {
    completion: completion.toISOString(),
    slipDays,
    weeksRemaining: Math.round(weeksRemaining * 10) / 10,
  };
}

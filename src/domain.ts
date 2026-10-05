/**
 * The normalised model. One shape for GitHub issues, Jira issues and anything
 * else a source adapter can fill in.
 *
 * Every field here is one I have actually needed to answer "is this going to
 * land". The ones that are optional are optional because not every tracker
 * has them, not because they are nice-to-have: Jira will give you an estimate
 * and GitHub will not, and a report that silently assumes zero points for
 * every GitHub issue is worse than one that says it is counting issues.
 */

export interface Issue {
  /** "#412" on GitHub, "PROJ-412" on Jira. Whatever a human would type. */
  key: string;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  assignees: string[];
  labels: string[];
  milestone?: string;
  /** The issue's own due date, where the tracker has one. */
  dueOn?: string;
  /** Story points or equivalent. Absent on GitHub, so counting falls back to issues. */
  estimate?: number;
  /** Keys of issues this one is waiting on. */
  blockedBy: string[];
  /** How many times this was closed and opened again. */
  reopenCount: number;
  commentCount: number;
  /**
   * Last time a person did something here.
   *
   * Separate from `updatedAt` on purpose. A bot relabelling fifty issues
   * updates all fifty, and a staleness check that trusts `updatedAt` will
   * then report a healthy project the day before it slips.
   */
  lastActivityAt: string;
  /** When work actually started, where the tracker records a status change. */
  startedAt?: string;
  /** When scope was last added. Compared against `startedAt`, not against now. */
  scopeChangedAt?: string;
  /** How many people have held this issue. Churn is a signal. */
  assigneeHistoryCount?: number;
}

export interface Milestone {
  name: string;
  dueOn?: string;
  url?: string;
}

/** Everything a report is computed from. One fetch, one snapshot, one report. */
export interface Snapshot {
  /** "github:owner/name", "jira:PROJ", "fixtures". Printed in the report. */
  source: string;
  takenAt: string;
  issues: Issue[];
  milestones: Milestone[];
}

export interface IssueSource {
  readonly id: string;
  fetchSnapshot(): Promise<Snapshot>;
}

export type Severity = "low" | "medium" | "high";

export interface IssueSignal {
  rule: string;
  severity: Severity;
  weight: number;
  /** A fact about the issue. The report quotes this verbatim. */
  detail: string;
}

export interface IssueRisk {
  issue: Issue;
  score: number;
  signals: IssueSignal[];
}

export type Rag = "green" | "amber" | "red";

/**
 * A milestone's delivery forecast.
 *
 * `projectedCompletion` is the number worth arguing about, and the reason it
 * is reported with `throughputPerWeek` and `weeksObserved` next to it is that
 * a projection from two weeks of data deserves less trust than one from eight.
 */
export interface Forecast {
  milestone: Milestone;
  openCount: number;
  closedCount: number;
  /** Measured, not assumed: issues (or points) closed per week over the window. */
  throughputPerWeek: number;
  weeksObserved: number;
  /** Null when throughput is zero, because "never" is not a date. */
  projectedCompletion: string | null;
  /** Positive means late. Null when there is no due date or no projection. */
  slipDays: number | null;
  rag: Rag;
  /** Why it is this colour, in one sentence. */
  reason: string;
  /** The riskiest issues in this milestone, worst first. */
  topRisks: IssueRisk[];
}

export interface Report {
  source: string;
  generatedAt: string;
  /** Prose. Never used in any calculation. */
  narrative: string;
  narrativeBy: string;
  forecasts: Forecast[];
  /** Risky issues with no milestone, which is itself a finding. */
  unscheduled: IssueRisk[];
  totals: {
    issues: number;
    open: number;
    flagged: number;
    red: number;
    amber: number;
    green: number;
  };
}

export interface Thresholds {
  /** Days without human activity before a started issue counts as stalled. */
  staleDays: number;
  /** Trailing window for the throughput measurement. */
  throughputWeeks: number;
  /** Slip in days at which a milestone turns amber, then red. */
  amberSlipDays: number;
  redSlipDays: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  staleDays: 7,
  throughputWeeks: 4,
  amberSlipDays: 3,
  redSlipDays: 14,
};

export const DAY_MS = 86_400_000;

/** Whole days between two instants, positive when `b` is later. */
export function daysBetween(a: string | Date, b: string | Date): number {
  const from = typeof a === "string" ? Date.parse(a) : a.getTime();
  const to = typeof b === "string" ? Date.parse(b) : b.getTime();
  return Math.floor((to - from) / DAY_MS);
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

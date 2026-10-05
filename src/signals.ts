/**
 * Per-issue risk signals.
 *
 * Each is a pure function of one issue, the set of open issue keys (for
 * blocker chains) and the time the snapshot was taken. Passing the snapshot
 * time in rather than reading the clock is what makes a report reproducible:
 * the same snapshot re-run next month produces the same report, which is the
 * only way to argue about a projection after the fact.
 *
 * The signals are the ones I have watched actually precede a slip, running
 * delivery across 25-plus programmes. Most of them are about *movement*
 * rather than size: a big issue moving steadily is fine, a small one that has
 * not moved in two weeks is not.
 */

import { daysBetween } from "./domain.ts";
import type { Issue, IssueSignal, Thresholds } from "./domain.ts";

export interface SignalContext {
  /** When the snapshot was taken. Never `new Date()` inside a rule. */
  takenAt: string;
  /** Keys of every issue still open, for resolving blocker chains. */
  openKeys: ReadonlySet<string>;
  thresholds: Thresholds;
}

export interface SignalRule {
  name: string;
  /** Why this rule exists. Printed by `--explain`. */
  rationale: string;
  evaluate(issue: Issue, context: SignalContext): IssueSignal | null;
}

const signal = (
  rule: string,
  severity: IssueSignal["severity"],
  weight: number,
  detail: string,
): IssueSignal => ({ rule, severity, weight, detail });

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const SIGNAL_RULES: SignalRule[] = [
  {
    name: "stalled",
    rationale:
      "Work that started and then stopped is the single most reliable early warning. It usually means the person is blocked on something they have not said out loud yet.",
    evaluate(issue, context) {
      if (issue.state !== "open") return null;
      if (issue.startedAt === undefined) return null;
      const idle = daysBetween(issue.lastActivityAt, context.takenAt);
      if (idle < context.thresholds.staleDays) return null;
      // Grows with the idle time, capped so one forgotten issue cannot swamp
      // the milestone score on its own.
      const weight = Math.min(20 + (idle - context.thresholds.staleDays) * 3, 45);
      return signal(
        "stalled",
        idle >= context.thresholds.staleDays * 2 ? "high" : "medium",
        weight,
        `In progress but no activity for ${plural(idle, "day")}.`,
      );
    },
  },
  {
    name: "blocked_by_open_issue",
    rationale:
      "A blocker chain is the difference between one late issue and a late milestone. Depth matters more than count: two issues behind one blocker is a queue, one issue behind a chain of three is a schedule.",
    evaluate(issue, context) {
      if (issue.state !== "open") return null;
      const openBlockers = issue.blockedBy.filter((key) => context.openKeys.has(key));
      if (openBlockers.length === 0) return null;
      const weight = Math.min(18 + (openBlockers.length - 1) * 10, 40);
      return signal(
        "blocked_by_open_issue",
        openBlockers.length > 1 ? "high" : "medium",
        weight,
        `Blocked by ${plural(openBlockers.length, "open issue")}: ${openBlockers.join(", ")}.`,
      );
    },
  },
  {
    name: "overdue",
    rationale:
      "Its own due date has passed and it is still open. Not a prediction, a measurement, which is why it is weighted as heavily as anything here.",
    evaluate(issue, context) {
      if (issue.state !== "open" || issue.dueOn === undefined) return null;
      const late = daysBetween(issue.dueOn, context.takenAt);
      if (late <= 0) return null;
      return signal("overdue", "high", Math.min(25 + late * 2, 45), `Due date passed ${plural(late, "day")} ago.`);
    },
  },
  {
    name: "scope_added_after_start",
    rationale:
      "Scope added after work began is the most common cause of a slip that nobody saw coming, because the estimate everyone is still quoting was made before the change.",
    evaluate(issue) {
      if (issue.state !== "open") return null;
      if (issue.startedAt === undefined || issue.scopeChangedAt === undefined) return null;
      const after = daysBetween(issue.startedAt, issue.scopeChangedAt);
      if (after <= 0) return null;
      return signal(
        "scope_added_after_start",
        "high",
        30,
        `Scope changed ${plural(after, "day")} after work started, so the current estimate predates it.`,
      );
    },
  },
  {
    name: "reopened",
    rationale:
      "A reopened issue means it was called done and was not. The remaining work is, by definition, work nobody has estimated.",
    evaluate(issue) {
      if (issue.reopenCount < 1) return null;
      return signal(
        "reopened",
        issue.reopenCount > 1 ? "high" : "medium",
        Math.min(18 + (issue.reopenCount - 1) * 12, 40),
        `Reopened ${plural(issue.reopenCount, "time")}.`,
      );
    },
  },
  {
    name: "unassigned_near_due_date",
    rationale:
      "Unassigned is only a problem against a date. Two weeks out with nobody holding it, the plan is a wish.",
    evaluate(issue, context) {
      if (issue.state !== "open" || issue.assignees.length > 0) return null;
      if (issue.dueOn === undefined) return null;
      const until = daysBetween(context.takenAt, issue.dueOn);
      if (until > 14) return null;
      return signal(
        "unassigned_near_due_date",
        until < 0 ? "high" : "medium",
        until < 0 ? 30 : 22,
        until < 0
          ? `Nobody assigned and the due date has already passed.`
          : `Nobody assigned, due in ${plural(until, "day")}.`,
      );
    },
  },
  {
    name: "assignee_churn",
    rationale:
      "An issue that has passed through three pairs of hands is usually not hard, it is unclear. Each handover restarts the context from nothing.",
    evaluate(issue) {
      const held = issue.assigneeHistoryCount ?? issue.assignees.length;
      if (issue.state !== "open" || held < 3) return null;
      return signal(
        "assignee_churn",
        "medium",
        18,
        `Has been held by ${held} different people.`,
      );
    },
  },
  {
    name: "discussion_without_movement",
    rationale:
      "A long thread and no commits is a disagreement, not progress. It resolves in a meeting, not by waiting.",
    evaluate(issue, context) {
      if (issue.state !== "open" || issue.commentCount < 15) return null;
      const idle = daysBetween(issue.lastActivityAt, context.takenAt);
      if (idle < 3) return null;
      return signal(
        "discussion_without_movement",
        "medium",
        16,
        `${issue.commentCount} comments and nothing for ${plural(idle, "day")}, which usually means an unresolved disagreement.`,
      );
    },
  },
  {
    name: "aging",
    rationale:
      "Weak on its own, which is what its weight says. It earns its place by compounding: old and stalled and reopened is a different conversation from any one of the three.",
    evaluate(issue, context) {
      if (issue.state !== "open") return null;
      const age = daysBetween(issue.createdAt, context.takenAt);
      if (age < 60) return null;
      return signal("aging", "low", 10, `Open for ${plural(age, "day")}.`);
    },
  },
];

/** Run every rule against one issue. */
export function signalsFor(issue: Issue, context: SignalContext, rules: SignalRule[] = SIGNAL_RULES): IssueSignal[] {
  const out: IssueSignal[] = [];
  for (const rule of rules) {
    const found = rule.evaluate(issue, context);
    if (found !== null) out.push(found);
  }
  return out;
}

export function ruleByName(name: string): SignalRule | undefined {
  return SIGNAL_RULES.find((rule) => rule.name === name);
}

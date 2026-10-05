/**
 * Putting it together: per-issue scores, then a milestone forecast and a
 * colour, then a report.
 *
 * The colour is decided by the projection first and the signal pressure
 * second, and in that order deliberately. A milestone whose arithmetic says
 * it lands three weeks late is red whether or not any individual issue looks
 * unhealthy, because "everyone is working steadily and there is too much
 * left" is the most common way a date is missed.
 */

import { signalsFor, SIGNAL_RULES } from "./signals.ts";
import type { SignalContext, SignalRule } from "./signals.ts";
import { lastClosedAt, measureThroughput, project, remainingWork } from "./throughput.ts";
import { DEFAULT_THRESHOLDS } from "./domain.ts";
import type { Forecast, Issue, IssueRisk, Milestone, Rag, Snapshot, Thresholds } from "./domain.ts";

export interface AnalyseOptions {
  thresholds?: Thresholds;
  rules?: SignalRule[];
  /** How many risky issues to list per milestone. */
  topRisksPerMilestone?: number;
}

/** Score one issue. Capped at 100 so the number stays readable. */
export function scoreIssue(issue: Issue, context: SignalContext, rules: SignalRule[] = SIGNAL_RULES): IssueRisk {
  const signals = signalsFor(issue, context, rules);
  const score = Math.min(signals.reduce((sum, s) => sum + s.weight, 0), 100);
  return { issue, score, signals };
}

const byScore = (a: IssueRisk, b: IssueRisk): number =>
  b.score - a.score || a.issue.key.localeCompare(b.issue.key);

/**
 * Decide the colour and say why in one sentence.
 *
 * Split out and exported because this is the judgement call in the whole
 * package, and it should be possible to disagree with it in a test rather
 * than by reading the implementation.
 */
export function ragFor(
  slipDays: number | null,
  projected: string | null,
  openCount: number,
  pressure: number,
  thresholds: Thresholds,
): { rag: Rag; reason: string } {
  if (openCount === 0) {
    if (slipDays !== null && slipDays > 0) {
      return {
        rag: "green",
        reason: `Complete. It landed ${slipDays} days after its due date, which is worth knowing for the next estimate.`,
      };
    }
    return { rag: "green", reason: "Complete, and on or ahead of its due date." };
  }
  if (projected === null) {
    return {
      rag: "red",
      reason: `Nothing has closed in the last ${thresholds.throughputWeeks} weeks, so there is no rate to project from.`,
    };
  }
  if (slipDays !== null && slipDays >= thresholds.redSlipDays) {
    return { rag: "red", reason: `Measured throughput puts this ${slipDays} days past its due date.` };
  }
  if (slipDays !== null && slipDays >= thresholds.amberSlipDays) {
    return { rag: "amber", reason: `Measured throughput puts this ${slipDays} days past its due date.` };
  }
  // No date, or the date holds. Fall back to how unhealthy the work looks.
  if (pressure >= 50) {
    return {
      rag: "red",
      reason: slipDays === null
        ? "No due date, but the open work carries heavy risk signals."
        : `The date holds on current throughput, but the open work carries heavy risk signals.`,
    };
  }
  if (pressure >= 25) {
    return {
      rag: "amber",
      reason: slipDays === null
        ? "No due date, and several issues are showing risk signals."
        : "The date holds on current throughput, but several issues are showing risk signals.",
    };
  }
  return {
    rag: "green",
    reason: slipDays === null
      ? "No due date, and nothing is showing significant risk."
      : `On track: projected ${Math.abs(slipDays)} days ${slipDays <= 0 ? "early" : "late"}.`,
  };
}

/**
 * Average risk score across the open issues, which is what `ragFor` calls
 * pressure.
 *
 * Average rather than sum, because a milestone with forty healthy issues
 * should not look worse than one with three sick ones.
 */
export function pressureOf(risks: IssueRisk[]): number {
  const open = risks.filter((risk) => risk.issue.state === "open");
  if (open.length === 0) return 0;
  return Math.round(open.reduce((sum, risk) => sum + risk.score, 0) / open.length);
}

export interface Analysis {
  forecasts: Forecast[];
  unscheduled: IssueRisk[];
  risks: Map<string, IssueRisk>;
  totals: { issues: number; open: number; flagged: number; red: number; amber: number; green: number };
}

export function analyse(snapshot: Snapshot, options: AnalyseOptions = {}): Analysis {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const rules = options.rules ?? SIGNAL_RULES;
  const topN = options.topRisksPerMilestone ?? 5;

  const context: SignalContext = {
    takenAt: snapshot.takenAt,
    openKeys: new Set(snapshot.issues.filter((i) => i.state === "open").map((i) => i.key)),
    thresholds,
  };

  const risks = new Map<string, IssueRisk>();
  for (const issue of snapshot.issues) risks.set(issue.key, scoreIssue(issue, context, rules));

  // A milestone declared with no issues in it still gets a row: an empty
  // milestone two weeks from its date is a finding, not a blank.
  const names = new Set<string>(snapshot.milestones.map((m) => m.name));
  for (const issue of snapshot.issues) {
    if (issue.milestone !== undefined) names.add(issue.milestone);
  }

  const forecasts: Forecast[] = [];
  for (const name of names) {
    const milestone: Milestone = snapshot.milestones.find((m) => m.name === name) ?? { name };
    const issues = snapshot.issues.filter((issue) => issue.milestone === name);
    const issueRisks = issues.map((issue) => risks.get(issue.key)).filter((r): r is IssueRisk => r !== undefined);

    const remaining = remainingWork(issues);
    const throughput = measureThroughput(issues, snapshot.takenAt, thresholds.throughputWeeks);
    const projection = project(
      remaining,
      throughput,
      snapshot.takenAt,
      milestone.dueOn,
      lastClosedAt(issues),
    );
    const pressure = pressureOf(issueRisks);
    const { rag, reason } = ragFor(projection.slipDays, projection.completion, remaining.count, pressure, thresholds);

    forecasts.push({
      milestone,
      openCount: remaining.count,
      closedCount: issues.length - remaining.count,
      throughputPerWeek: Math.round(throughput.perWeek * 10) / 10,
      weeksObserved: throughput.weeksObserved,
      projectedCompletion: projection.completion,
      slipDays: projection.slipDays,
      rag,
      reason,
      topRisks: issueRisks.filter((r) => r.issue.state === "open" && r.score > 0).sort(byScore).slice(0, topN),
    });
  }

  // Worst first, and a milestone with a date before one without.
  const ragOrder: Record<Rag, number> = { red: 0, amber: 1, green: 2 };
  forecasts.sort(
    (a, b) =>
      ragOrder[a.rag] - ragOrder[b.rag] ||
      (b.slipDays ?? -9999) - (a.slipDays ?? -9999) ||
      a.milestone.name.localeCompare(b.milestone.name),
  );

  const unscheduled = snapshot.issues
    .filter((issue) => issue.milestone === undefined && issue.state === "open")
    .map((issue) => risks.get(issue.key))
    .filter((r): r is IssueRisk => r !== undefined && r.score > 0)
    .sort(byScore);

  const open = snapshot.issues.filter((i) => i.state === "open").length;
  const flagged = [...risks.values()].filter((r) => r.issue.state === "open" && r.score > 0).length;

  return {
    forecasts,
    unscheduled,
    risks,
    totals: {
      issues: snapshot.issues.length,
      open,
      flagged,
      red: forecasts.filter((f) => f.rag === "red").length,
      amber: forecasts.filter((f) => f.rag === "amber").length,
      green: forecasts.filter((f) => f.rag === "green").length,
    },
  };
}

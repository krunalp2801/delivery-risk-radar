/**
 * Rendering the report as Markdown.
 *
 * Markdown because the report's job is to be pasted somewhere: a GitHub
 * issue, a Slack canvas, a status email. A dashboard nobody opens is the
 * failure mode this is meant to avoid, so the output is designed to be read
 * where the conversation already happens.
 */

import type { Analysis } from "./risk.ts";
import type { Forecast, IssueRisk, Report, Snapshot } from "./domain.ts";

const RAG_MARK: Record<Forecast["rag"], string> = { red: "RED", amber: "AMBER", green: "GREEN" };

const date = (iso: string | null | undefined): string =>
  iso === null || iso === undefined ? "-" : iso.slice(0, 10);

const slip = (days: number | null): string => {
  if (days === null) return "-";
  if (days === 0) return "on the day";
  return days > 0 ? `+${days}d late` : `${Math.abs(days)}d early`;
};

export function buildReport(snapshot: Snapshot, analysis: Analysis, narrative: string, narrativeBy: string): Report {
  return {
    source: snapshot.source,
    generatedAt: snapshot.takenAt,
    narrative,
    narrativeBy,
    forecasts: analysis.forecasts,
    unscheduled: analysis.unscheduled,
    totals: analysis.totals,
  };
}

function issueLines(risks: IssueRisk[]): string[] {
  const out: string[] = [];
  for (const risk of risks) {
    const assignees = risk.issue.assignees.length === 0 ? "unassigned" : risk.issue.assignees.join(", ");
    out.push(`- **${risk.issue.key}** (${risk.score}) [${risk.issue.title}](${risk.issue.url}) — ${assignees}`);
    for (const signal of [...risk.signals].sort((a, b) => b.weight - a.weight)) {
      out.push(`  - \`${signal.rule}\` ${signal.detail}`);
    }
  }
  return out;
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];

  lines.push(`# Delivery risk report`);
  lines.push("");
  lines.push(`**${report.source}** · snapshot ${date(report.generatedAt)}`);
  lines.push("");
  lines.push(report.narrative);
  lines.push("");

  lines.push(`## Milestones`);
  lines.push("");
  if (report.forecasts.length === 0) {
    lines.push("_No milestones found in this snapshot._");
  } else {
    lines.push(`| | Milestone | Due | Open | Closed | Throughput | Projected | Slip |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const f of report.forecasts) {
      lines.push(
        `| ${RAG_MARK[f.rag]} | ${f.milestone.name} | ${date(f.milestone.dueOn)} | ${f.openCount} | ` +
          `${f.closedCount} | ${f.throughputPerWeek}/wk | ${date(f.projectedCompletion)} | ${slip(f.slipDays)} |`,
      );
    }
    lines.push("");
    lines.push(
      `Throughput is measured from issues actually closed in the trailing window, ` +
        `not from estimates. A projection built on fewer weeks deserves less trust; ` +
        `the observed window is listed per milestone below.`,
    );
  }
  lines.push("");

  for (const f of report.forecasts) {
    lines.push(`### ${RAG_MARK[f.rag]} — ${f.milestone.name}`);
    lines.push("");
    lines.push(f.reason);
    lines.push("");
    if (f.openCount === 0) {
      lines.push(
        `${f.closedCount} closed, nothing open. ` +
          (f.projectedCompletion === null
            ? `No close dates recorded.`
            : `The last issue closed ${date(f.projectedCompletion)}` +
              (f.milestone.dueOn === undefined ? `.` : `, against a due date of ${date(f.milestone.dueOn)}.`)),
      );
    } else {
      lines.push(
        `${f.openCount} open, ${f.closedCount} closed. ` +
          `Closing ${f.throughputPerWeek} per week measured over ${f.weeksObserved} weeks. ` +
          (f.projectedCompletion === null
            ? `No completion date can be projected.`
            : `At that rate the last issue closes around ${date(f.projectedCompletion)}` +
              (f.milestone.dueOn === undefined ? `.` : `, against a due date of ${date(f.milestone.dueOn)}.`)),
      );
    }
    lines.push("");
    if (f.topRisks.length === 0) {
      lines.push(`No issues in this milestone are showing risk signals.`);
    } else {
      lines.push(`Issues to look at:`);
      lines.push("");
      lines.push(...issueLines(f.topRisks));
    }
    lines.push("");
  }

  if (report.unscheduled.length > 0) {
    lines.push(`## Risky issues with no milestone`);
    lines.push("");
    lines.push(
      `These carry risk signals and sit in nobody's plan, which means no date moves when they slip.`,
    );
    lines.push("");
    lines.push(...issueLines(report.unscheduled));
    lines.push("");
  }

  lines.push(`## Totals`);
  lines.push("");
  lines.push(
    `${report.totals.issues} issues, ${report.totals.open} open, ${report.totals.flagged} showing risk signals. ` +
      `Milestones: ${report.totals.red} red, ${report.totals.amber} amber, ${report.totals.green} green.`,
  );
  lines.push("");
  lines.push(
    `_Every number above is computed from the snapshot by deterministic rules. ` +
      `The summary was written by \`${report.narrativeBy}\` and is not used in any calculation._`,
  );

  return lines.join("\n");
}

/** A one-line form for a Slack message or a cron job's log. */
export function renderOneLine(report: Report): string {
  const worst = report.forecasts[0];
  const head = worst === undefined
    ? "no milestones"
    : `worst: ${worst.milestone.name} ${worst.rag.toUpperCase()}${worst.slipDays === null ? "" : ` (${slip(worst.slipDays)})`}`;
  return `${report.source}: ${report.totals.red} red, ${report.totals.amber} amber, ${report.totals.flagged} issues flagged. ${head}.`;
}

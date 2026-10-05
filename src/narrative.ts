/**
 * The two paragraphs at the top of the report.
 *
 * Same discipline as the rest of the series: the model writes prose, the
 * arithmetic decides. It receives the computed forecast as input and returns
 * text that nothing reads back, so no number in the report can have come from
 * it. `narrative.test.ts` asserts that the whole report is identical under the
 * deterministic writer and under a hostile one that claims everything is on
 * track.
 *
 * The reason this is worth being strict about here specifically: a delivery
 * report is read by people deciding whether to intervene. If the summary and
 * the table can disagree, the summary wins, because that is the bit that gets
 * pasted into a status email.
 */

import type { Analysis } from "./risk.ts";
import type { Rag, Snapshot } from "./domain.ts";

export interface NarrativeRequest {
  snapshot: Snapshot;
  analysis: Analysis;
}

export interface NarrativeWriter {
  readonly id: string;
  write(request: NarrativeRequest): Promise<string>;
}

const LEAD: Record<Rag, string> = {
  red: "needs a decision this week",
  amber: "needs watching",
  green: "is on track",
};

/** The default. Deterministic, offline, and never contradicts the table. */
export const templateNarrative: NarrativeWriter = {
  id: "template",
  async write({ analysis }: NarrativeRequest): Promise<string> {
    const { totals, forecasts } = analysis;
    if (forecasts.length === 0) {
      return `No milestones found. ${totals.open} open issues, ${totals.flagged} showing risk signals.`;
    }

    const worst = forecasts[0];
    const lines: string[] = [];

    if (worst !== undefined) {
      const count = `${totals.red} of ${forecasts.length} milestone${forecasts.length === 1 ? "" : "s"} ` +
        `${totals.red === 1 ? "is" : "are"} red, ${totals.amber} amber.`;
      lines.push(
        `${count} The one to look at first is **${worst.milestone.name}**, which ${LEAD[worst.rag]}: ${worst.reason}`,
      );
    }

    const slipping = forecasts.filter((f) => f.openCount > 0 && f.slipDays !== null && f.slipDays > 0);
    if (slipping.length > 0) {
      lines.push(
        `Projected slip against stated dates: ` +
          slipping.map((f) => `${f.milestone.name} ${f.slipDays} days`).join(", ") +
          `. These come from measured closure rate over the trailing window, not from estimates.`,
      );
    }

    const stalled = [...analysis.risks.values()].filter((r) =>
      r.signals.some((s) => s.rule === "stalled"),
    );
    if (stalled.length > 0) {
      lines.push(
        `${stalled.length} issue${stalled.length === 1 ? " has" : "s have"} started and then stopped moving, which is usually someone blocked on something they have not said out loud.`,
      );
    }

    if (analysis.unscheduled.length > 0) {
      lines.push(`${analysis.unscheduled.length} risky issues have no milestone, so they are in nobody's plan.`);
    }

    return lines.join("\n\n");
  },
};

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

export interface AnthropicNarrativeOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** Exported so a test can assert what is sent, and what it is forbidden to do. */
export function buildPrompt({ snapshot, analysis }: NarrativeRequest): string {
  const rows = analysis.forecasts
    .map(
      (f) =>
        `- ${f.milestone.name}: ${f.rag.toUpperCase()}, ${f.openCount} open, ` +
        `${f.closedCount} closed, throughput ${f.throughputPerWeek}/week over ${f.weeksObserved} weeks, ` +
        `${f.slipDays === null ? "no date to compare" : `projected slip ${f.slipDays} days`}. ${f.reason}`,
    )
    .join("\n");

  const topIssues = analysis.forecasts
    .flatMap((f) => f.topRisks.slice(0, 3))
    .slice(0, 8)
    .map((r) => `- ${r.issue.key} (score ${r.score}): ${r.signals.map((s) => s.detail).join(" ")}`)
    .join("\n");

  return [
    `Delivery snapshot for ${snapshot.source}, taken ${snapshot.takenAt}.`,
    `${analysis.totals.open} open issues, ${analysis.totals.flagged} with risk signals.`,
    "",
    "Milestones, already analysed:",
    rows === "" ? "- none" : rows,
    "",
    "Highest-risk open issues:",
    topIssues === "" ? "- none" : topIssues,
    "",
    "Write two short paragraphs for the top of a weekly delivery report, for an",
    "engineering manager and their stakeholders. Say what needs a decision this",
    "week and what the likely cause is.",
    "",
    "Use only the facts above. Do not introduce numbers, dates or percentages",
    "that are not in them, do not recalculate anything, and do not soften or",
    "upgrade a RAG status: the colours are already decided. No bullet points.",
  ].join("\n");
}

/** LLM narrative, falling back to the template on any failure. */
export function anthropicNarrative(options: AnthropicNarrativeOptions): NarrativeWriter {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    id: `anthropic:${model}`,
    async write(request: NarrativeRequest): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 600,
            messages: [{ role: "user", content: buildPrompt(request) }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return templateNarrative.write(request);
        const body = (await res.json()) as MessagesResponse;
        const text = (body.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim();
        return text === "" ? templateNarrative.write(request) : text;
      } catch {
        return templateNarrative.write(request);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function resolveNarrative(env: Record<string, string | undefined>): NarrativeWriter {
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") return templateNarrative;
  const model = env["RADAR_NARRATIVE_MODEL"];
  return anthropicNarrative(model === undefined ? { apiKey } : { apiKey, model });
}

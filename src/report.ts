/**
 * The one function that does the whole job: snapshot in, Markdown out.
 *
 * Worth having as its own module because it is the only place the order of
 * operations matters, and the order is the design: analyse first, write prose
 * second, and never the other way round.
 */

import { buildReport, renderMarkdown } from "./digest.ts";
import { templateNarrative } from "./narrative.ts";
import { analyse } from "./risk.ts";
import type { AnalyseOptions } from "./risk.ts";
import type { NarrativeWriter } from "./narrative.ts";
import type { Report, Snapshot } from "./domain.ts";

export interface ReportOptions extends AnalyseOptions {
  narrative?: NarrativeWriter;
}

export async function reportFor(snapshot: Snapshot, options: ReportOptions = {}): Promise<Report> {
  const writer = options.narrative ?? templateNarrative;
  const analysis = analyse(snapshot, options);
  // The writer is handed the finished analysis and its output goes straight
  // into a string field. There is no path back into a number.
  const narrative = await writer.write({ snapshot, analysis });
  return buildReport(snapshot, analysis, narrative, writer.id);
}

export async function markdownFor(snapshot: Snapshot, options: ReportOptions = {}): Promise<string> {
  return renderMarkdown(await reportFor(snapshot, options));
}

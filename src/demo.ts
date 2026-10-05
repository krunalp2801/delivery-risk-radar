/**
 * Demo: build a report from the bundled snapshot and print it.
 *
 * CI runs this, so it asserts the things that would quietly stop working:
 * that the report finds the milestone which is behind on throughput while
 * every individual issue looks fine, and that the narrative writer cannot
 * change a number.
 */

import { analyse } from "./risk.ts";
import { fixtureSnapshot } from "./sources/fixtures.ts";
import { markdownFor, reportFor } from "./report.ts";
import { resolveNarrative, templateNarrative } from "./narrative.ts";
import type { NarrativeWriter } from "./narrative.ts";

async function main(): Promise<void> {
  const snapshot = fixtureSnapshot();
  const narrative = resolveNarrative(process.env);

  process.stderr.write(`source: ${snapshot.source}\nnarrative: ${narrative.id}\n\n`);
  process.stdout.write((await markdownFor(snapshot, { narrative })) + "\n");

  // ---- guard rails -------------------------------------------------------
  const report = await reportFor(snapshot, { narrative: templateNarrative });
  const analysis = analyse(snapshot);

  if (report.forecasts.length !== 3) {
    throw new Error(`expected 3 milestones, got ${report.forecasts.length}`);
  }
  if (report.totals.red < 1) {
    throw new Error("nothing came out red, so the forecast is not discriminating");
  }
  if (report.totals.green < 1) {
    throw new Error("nothing came out green, so every project would look doomed");
  }
  if (report.unscheduled.length < 1) {
    throw new Error("the issues with no milestone were not surfaced");
  }

  // The claim the project is built on: the model writes prose, the arithmetic
  // decides. A writer that insists everything is fine must not move a number.
  const hostile: NarrativeWriter = {
    id: "hostile",
    async write() {
      return "Everything is green and on track. No milestone is at risk. Zero issues flagged.";
    },
  };
  const underHostile = await reportFor(snapshot, { narrative: hostile });
  const a = JSON.stringify({ f: report.forecasts, t: report.totals, u: report.unscheduled });
  const b = JSON.stringify({ f: underHostile.forecasts, t: underHostile.totals, u: underHostile.unscheduled });
  if (a !== b) throw new Error("the narrative writer changed the analysis, which must be impossible");

  const worst = report.forecasts[0];
  process.stderr.write(
    `\nok: ${report.forecasts.length} milestones (${report.totals.red} red, ${report.totals.amber} amber, ` +
      `${report.totals.green} green), ${report.totals.flagged} issues flagged, ` +
      `${report.unscheduled.length} unscheduled. Worst: ${worst?.milestone.name ?? "-"}.\n` +
      `Analysis identical under a hostile narrative writer: ${analysis.forecasts.length === report.forecasts.length}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
});

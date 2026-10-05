import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { renderMarkdown, renderOneLine } from "../src/digest.ts";
import { reportFor } from "../src/report.ts";
import { fixtureSnapshot } from "../src/sources/fixtures.ts";
import { snapshot } from "./helpers.ts";

const report = () => reportFor(fixtureSnapshot());

describe("renderMarkdown", () => {
  it("leads with the source and the snapshot date", async () => {
    const md = renderMarkdown(await report());
    assert.match(md, /^# Delivery risk report/);
    assert.match(md, /fixtures:example\/checkout/);
    assert.match(md, /2026-09-29/);
  });

  it("renders a milestone table with one row per milestone", async () => {
    const r = await report();
    const md = renderMarkdown(r);
    const rows = md.split("\n").filter((line) => /^\| (RED|AMBER|GREEN) \|/.test(line));
    assert.equal(rows.length, r.forecasts.length);
  });

  it("marks the red milestone and shows its slip", async () => {
    const md = renderMarkdown(await report());
    assert.match(md, /\| RED \| v2\.1 Checkout \|.*\+\d+d late \|/);
  });

  it("lists each flagged issue with its score, link and signals", async () => {
    const md = renderMarkdown(await report());
    assert.match(md, /- \*\*#404\*\* \(\d+\) \[.*\]\(https:\/\/github\.com/);
    assert.match(md, /- `overdue` Due date passed/);
  });

  it("reports a finished milestone as history rather than a forecast", async () => {
    const md = renderMarkdown(await report());
    assert.match(md, /closed, nothing open\. The last issue closed/);
    assert.ok(!/0 open, 2 closed\. Closing 0 per week/.test(md), "a finished milestone should not be projected");
  });

  it("has a section for risky issues with no milestone", async () => {
    const md = renderMarkdown(await report());
    assert.match(md, /## Risky issues with no milestone/);
    assert.match(md, /no date moves when they slip/);
  });

  it("says where the numbers came from and who wrote the prose", async () => {
    const md = renderMarkdown(await report());
    assert.match(md, /measured from issues actually closed/);
    assert.match(md, /written by `template` and is not used in any calculation/);
  });

  it("copes with an empty snapshot", async () => {
    const md = renderMarkdown(await reportFor(snapshot([])));
    assert.match(md, /_No milestones found in this snapshot\._/);
    assert.match(md, /0 issues, 0 open/);
  });

  it("is stable: the same snapshot renders byte-identically", async () => {
    assert.equal(renderMarkdown(await report()), renderMarkdown(await report()));
  });
});

describe("renderOneLine", () => {
  it("fits a Slack message and names the worst milestone", async () => {
    const line = renderOneLine(await report());
    assert.ok(!line.includes("\n"));
    assert.match(line, /1 red/);
    assert.match(line, /worst: v2\.1 Checkout RED \(\+\d+d late\)/);
  });

  it("copes with no milestones at all", async () => {
    assert.match(renderOneLine(await reportFor(snapshot([]))), /no milestones/);
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { analyse, pressureOf, ragFor, scoreIssue } from "../src/risk.ts";
import { fixtureSnapshot } from "../src/sources/fixtures.ts";
import { DEFAULT_THRESHOLDS } from "../src/domain.ts";
import { ago, ahead, context, issue, snapshot, thresholds } from "./helpers.ts";
import type { IssueRisk } from "../src/domain.ts";

describe("scoreIssue", () => {
  it("sums signal weights and caps at 100", () => {
    const bad = issue({
      createdAt: ago(200),
      startedAt: ago(100),
      lastActivityAt: ago(90),
      dueOn: ago(60),
      reopenCount: 3,
      commentCount: 40,
      assigneeHistoryCount: 4,
    });
    assert.equal(scoreIssue(bad, context()).score, 100);
  });

  it("scores a healthy issue at zero with no signals", () => {
    const risk = scoreIssue(issue(), context());
    assert.equal(risk.score, 0);
    assert.deepEqual(risk.signals, []);
  });
});

describe("pressureOf", () => {
  const risk = (score: number, state: "open" | "closed" = "open"): IssueRisk => ({
    issue: issue({ state, ...(state === "closed" ? { closedAt: ago(1) } : {}) }),
    score,
    signals: [],
  });

  it("averages rather than sums, so a big healthy milestone is not penalised", () => {
    assert.equal(pressureOf([risk(90), risk(0), risk(0), risk(0)]), 23);
    assert.equal(pressureOf([risk(90), risk(90)]), 90);
  });

  it("ignores closed issues and handles an empty list", () => {
    assert.equal(pressureOf([risk(90, "closed"), risk(10)]), 10);
    assert.equal(pressureOf([]), 0);
  });
});

describe("ragFor", () => {
  const t = DEFAULT_THRESHOLDS;

  it("is green when the milestone is complete", () => {
    assert.equal(ragFor(null, null, 0, 90, t).rag, "green");
  });

  it("notes a completed milestone that landed late, for the next estimate", () => {
    const { rag, reason } = ragFor(12, ago(1), 0, 0, t);
    assert.equal(rag, "green");
    assert.match(reason, /landed 12 days after its due date/);
  });

  it("is red when there is no rate to project from", () => {
    const { rag, reason } = ragFor(null, null, 8, 0, t);
    assert.equal(rag, "red");
    assert.match(reason, /no rate to project from/);
  });

  it("bands on projected slip", () => {
    assert.equal(ragFor(2, ahead(5), 5, 0, t).rag, "green");
    assert.equal(ragFor(3, ahead(5), 5, 0, t).rag, "amber");
    assert.equal(ragFor(13, ahead(5), 5, 0, t).rag, "amber");
    assert.equal(ragFor(14, ahead(5), 5, 0, t).rag, "red");
  });

  it("lets signal pressure escalate a milestone whose date holds", () => {
    // "Everyone is working steadily and there is too much left" is one way to
    // miss a date. "The date holds but half the work is stalled" is another.
    assert.equal(ragFor(-10, ahead(5), 5, 24, t).rag, "green");
    assert.equal(ragFor(-10, ahead(5), 5, 25, t).rag, "amber");
    assert.equal(ragFor(-10, ahead(5), 5, 50, t).rag, "red");
  });

  it("still colours a milestone with no due date, from pressure alone", () => {
    const { rag, reason } = ragFor(null, ahead(20), 5, 60, t);
    assert.equal(rag, "red");
    assert.match(reason, /No due date/);
  });

  it("puts the projection ahead of the pressure", () => {
    // A milestone projected three weeks late is red even if every issue in it
    // looks perfectly healthy.
    assert.equal(ragFor(21, ahead(60), 10, 0, t).rag, "red");
  });

  it("honours custom slip thresholds", () => {
    const strict = thresholds({ amberSlipDays: 1, redSlipDays: 2 });
    assert.equal(ragFor(1, ahead(5), 5, 0, strict).rag, "amber");
    assert.equal(ragFor(2, ahead(5), 5, 0, strict).rag, "red");
  });
});

describe("analyse", () => {
  it("reports a milestone with no issues rather than dropping it", () => {
    // An empty milestone two weeks from its date is a finding, not a blank.
    const a = analyse(snapshot([], [{ name: "v9", dueOn: ahead(14) }]));
    assert.equal(a.forecasts.length, 1);
    assert.equal(a.forecasts[0]?.openCount, 0);
  });

  it("includes a milestone named only on an issue", () => {
    const a = analyse(snapshot([issue({ milestone: "ghost" })], []));
    assert.deepEqual(a.forecasts.map((f) => f.milestone.name), ["ghost"]);
  });

  it("sorts worst first: red before amber before green", () => {
    const a = analyse(fixtureSnapshot());
    const order = a.forecasts.map((f) => f.rag);
    const rank = { red: 0, amber: 1, green: 2 };
    assert.deepEqual(order.map((r) => rank[r]), [...order.map((r) => rank[r])].sort());
  });

  it("surfaces risky issues with no milestone separately", () => {
    const a = analyse(fixtureSnapshot());
    assert.ok(a.unscheduled.length >= 1);
    for (const risk of a.unscheduled) {
      assert.equal(risk.issue.milestone, undefined);
      assert.equal(risk.issue.state, "open");
      assert.ok(risk.score > 0, "a healthy unscheduled issue is not a finding");
    }
  });

  it("lists only open, flagged issues in topRisks, worst first", () => {
    for (const forecast of analyse(fixtureSnapshot()).forecasts) {
      const scores = forecast.topRisks.map((r) => r.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
      for (const risk of forecast.topRisks) {
        assert.equal(risk.issue.state, "open");
        assert.ok(risk.score > 0);
      }
    }
  });

  it("caps topRisks at the requested count", () => {
    const a = analyse(fixtureSnapshot(), { topRisksPerMilestone: 2 });
    for (const forecast of a.forecasts) assert.ok(forecast.topRisks.length <= 2);
  });

  it("totals add up", () => {
    const a = analyse(fixtureSnapshot());
    const snap = fixtureSnapshot();
    assert.equal(a.totals.issues, snap.issues.length);
    assert.equal(a.totals.open, snap.issues.filter((i) => i.state === "open").length);
    assert.equal(a.totals.red + a.totals.amber + a.totals.green, a.forecasts.length);
  });

  it("is deterministic for a given snapshot", () => {
    // The whole point of taking `takenAt` from the snapshot: a report can be
    // re-run next month and argued about.
    assert.deepEqual(analyse(fixtureSnapshot()), analyse(fixtureSnapshot()));
  });

  it("finds the milestone that is behind on throughput", () => {
    // The case a status meeting misses: no single issue looks alarming, there
    // is simply more left than the measured rate can deliver.
    const a = analyse(fixtureSnapshot());
    const red = a.forecasts.filter((f) => f.rag === "red");
    assert.equal(red.length, 1);
    assert.equal(red[0]?.milestone.name, "v2.1 Checkout");
    assert.ok((red[0]?.slipDays ?? 0) > 14);
    assert.match(red[0]?.reason ?? "", /throughput/);
  });
});

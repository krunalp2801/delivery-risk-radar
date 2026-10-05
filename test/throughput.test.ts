import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { lastClosedAt, measureThroughput, project, remainingWork } from "../src/throughput.ts";
import { ago, ahead, issue, NOW } from "./helpers.ts";

const closed = (daysAgo: number, estimate?: number) =>
  issue({
    key: `#c${daysAgo}`,
    state: "closed",
    createdAt: ago(daysAgo + 30),
    closedAt: ago(daysAgo),
    ...(estimate === undefined ? {} : { estimate }),
  });

describe("remainingWork", () => {
  it("counts open issues and ignores closed ones", () => {
    const r = remainingWork([issue({ key: "#1" }), issue({ key: "#2" }), closed(3)]);
    assert.equal(r.count, 2);
  });

  it("sums points only when every open issue has an estimate", () => {
    assert.equal(remainingWork([issue({ key: "#1", estimate: 3 }), issue({ key: "#2", estimate: 5 })]).points, 8);
    // Partial estimates are worse than none: summing only the issues that
    // happen to have points understates the remainder, invisibly.
    assert.equal(remainingWork([issue({ key: "#1", estimate: 3 }), issue({ key: "#2" })]).points, null);
  });

  it("reports zero points for no open issues rather than null", () => {
    assert.deepEqual(remainingWork([closed(1)]), { count: 0, points: 0 });
  });
});

describe("lastClosedAt", () => {
  it("returns the latest close date", () => {
    assert.equal(lastClosedAt([closed(10), closed(2), closed(30)]), ago(2));
  });

  it("returns undefined when nothing has closed", () => {
    assert.equal(lastClosedAt([issue()]), undefined);
  });
});

describe("measureThroughput", () => {
  it("counts only closes inside the window", () => {
    const t = measureThroughput([closed(3), closed(10), closed(40)], NOW, 4);
    assert.equal(t.closedInWindow, 2);
    assert.equal(t.unit, "issues");
  });

  it("divides by the window to get a weekly rate", () => {
    const issues = [closed(1), closed(4), closed(9), closed(16)];
    const t = measureThroughput(issues, NOW, 4);
    assert.equal(t.perWeek, 1);
    assert.equal(t.weeksObserved, 4);
  });

  it("clamps the window to the age of the project", () => {
    // A two-week-old project must not have its rate divided by four. This was
    // the first bug in this file and it made every new project look doomed.
    const young = [
      issue({ key: "#1", createdAt: ago(12) }),
      issue({ key: "#2", state: "closed", createdAt: ago(12), closedAt: ago(5) }),
      issue({ key: "#3", state: "closed", createdAt: ago(11), closedAt: ago(2) }),
    ];
    const t = measureThroughput(young, NOW, 4);
    assert.ok(t.weeksObserved < 2, `expected a short window, got ${t.weeksObserved}`);
    assert.ok(t.perWeek > 1, `expected a healthy rate, got ${t.perWeek}`);
  });

  it("switches to points when every close in the window had an estimate", () => {
    const t = measureThroughput([closed(3, 5), closed(10, 3)], NOW, 4);
    assert.equal(t.unit, "points");
    assert.equal(t.perWeek, 2);
  });

  it("falls back to counting issues if any close lacks an estimate", () => {
    assert.equal(measureThroughput([closed(3, 5), closed(10)], NOW, 4).unit, "issues");
  });

  it("reports zero for a window with no closes", () => {
    const t = measureThroughput([issue({ createdAt: ago(90) }), closed(60)], NOW, 4);
    assert.equal(t.perWeek, 0);
    assert.equal(t.closedInWindow, 0);
  });

  it("never divides by zero on a snapshot taken the day a project started", () => {
    const t = measureThroughput([issue({ createdAt: NOW })], NOW, 4);
    assert.ok(Number.isFinite(t.perWeek));
    assert.ok(t.weeksObserved > 0);
  });
});

describe("project", () => {
  const throughput = { perWeek: 2, weeksObserved: 4, unit: "issues" as const, closedInWindow: 8 };

  it("divides remaining work by the measured rate", () => {
    const p = project({ count: 10, points: null }, throughput, NOW);
    assert.equal(p.weeksRemaining, 5);
    assert.equal(p.completion?.slice(0, 10), ahead(35).slice(0, 10));
  });

  it("reports slip against a due date, positive when late", () => {
    const late = project({ count: 10, points: null }, throughput, NOW, ahead(7));
    const early = project({ count: 2, points: null }, throughput, NOW, ahead(60));
    assert.equal(late.slipDays, 28);
    assert.ok((early.slipDays ?? 0) < 0);
  });

  it("returns null rather than a fake date when nothing is closing", () => {
    // "Never" is not a date. Inventing one here would be the single most
    // misleading thing this package could do.
    const p = project({ count: 10, points: null }, { ...throughput, perWeek: 0 }, NOW, ahead(7));
    assert.equal(p.completion, null);
    assert.equal(p.slipDays, null);
    assert.equal(p.weeksRemaining, null);
  });

  it("reports history, not a forecast, when nothing is left", () => {
    const p = project({ count: 0, points: 0 }, throughput, NOW, ahead(10), ago(5));
    assert.equal(p.completion, ago(5));
    assert.equal(p.weeksRemaining, 0);
    assert.equal(p.slipDays, -15, "it finished 15 days before its due date");
  });

  it("reports a completed milestone that landed late as late", () => {
    // Reporting `takenAt` here made a milestone that shipped three weeks late
    // read as "on the day".
    const p = project({ count: 0, points: 0 }, throughput, NOW, ago(30), ago(9));
    assert.equal(p.slipDays, 21);
  });

  it("has no slip to report without a due date", () => {
    assert.equal(project({ count: 4, points: null }, throughput, NOW).slipDays, null);
  });

  it("uses points when both the rate and the remainder are in points", () => {
    const pointsRate = { perWeek: 10, weeksObserved: 4, unit: "points" as const, closedInWindow: 8 };
    const p = project({ count: 2, points: 40 }, pointsRate, NOW);
    assert.equal(p.weeksRemaining, 4, "40 points at 10 a week, not 2 issues at 10 a week");
  });

  it("falls back to counting issues when the remainder has no points", () => {
    const pointsRate = { perWeek: 10, weeksObserved: 4, unit: "points" as const, closedInWindow: 8 };
    assert.equal(project({ count: 20, points: null }, pointsRate, NOW).weeksRemaining, 2);
  });
});

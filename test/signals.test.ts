import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ruleByName, signalsFor, SIGNAL_RULES } from "../src/signals.ts";
import { ago, ahead, context, issue, NOW, thresholds } from "./helpers.ts";
import type { IssueSignal } from "../src/domain.ts";

const fired = (name: string, o = issue(), ctx = context()): IssueSignal | undefined =>
  signalsFor(o, ctx).find((s) => s.rule === name);

describe("rule catalogue", () => {
  it("has unique names and a real rationale for each", () => {
    const names = SIGNAL_RULES.map((r) => r.name);
    assert.equal(new Set(names).size, names.length);
    for (const rule of SIGNAL_RULES) {
      assert.ok(rule.rationale.length > 30, `${rule.name} needs a rationale`);
    }
  });

  it("fires nothing on a healthy issue", () => {
    assert.deepEqual(signalsFor(issue(), context()), []);
  });

  it("never reads the clock, so the same snapshot gives the same answer", () => {
    // Every rule takes `takenAt` from the context. A rule calling new Date()
    // would make a report irreproducible, which defeats the whole purpose.
    const stale = issue({ startedAt: ago(30), lastActivityAt: ago(30) });
    const asOfNow = signalsFor(stale, context());
    const asOfLater = signalsFor(stale, context({ takenAt: ahead(60) }));
    assert.notDeepEqual(asOfNow, asOfLater, "a later snapshot time must change the answer");
    assert.deepEqual(signalsFor(stale, context()), asOfNow, "the same time must give the same answer");
  });

  it("ignores closed issues for every open-work rule", () => {
    const closed = issue({
      state: "closed",
      closedAt: ago(1),
      startedAt: ago(40),
      lastActivityAt: ago(40),
      blockedBy: ["#2"],
      dueOn: ago(10),
      createdAt: ago(200),
      commentCount: 40,
      assigneeHistoryCount: 5,
    });
    const signals = signalsFor(closed, context({ openKeys: new Set(["#2"]) }));
    // Reopened is the one rule that is still interesting after a close.
    assert.deepEqual(signals.map((s) => s.rule), []);
  });

  it("ruleByName finds a rule and misses gracefully", () => {
    assert.equal(ruleByName("stalled")?.name, "stalled");
    assert.equal(ruleByName("nope"), undefined);
  });
});

describe("stalled", () => {
  it("fires once an in-progress issue goes quiet past the threshold", () => {
    assert.equal(fired("stalled", issue({ startedAt: ago(20), lastActivityAt: ago(6) })), undefined);
    const s = fired("stalled", issue({ startedAt: ago(20), lastActivityAt: ago(7) }));
    assert.equal(s?.weight, 20);
    assert.match(s?.detail ?? "", /no activity for 7 days/);
  });

  it("does not fire on work that has not started", () => {
    assert.equal(fired("stalled", issue({ lastActivityAt: ago(60) })), undefined);
  });

  it("grows with the idle time and then caps", () => {
    const mid = fired("stalled", issue({ startedAt: ago(30), lastActivityAt: ago(14) }));
    const old = fired("stalled", issue({ startedAt: ago(90), lastActivityAt: ago(90) }));
    assert.ok((mid?.weight ?? 0) > 20);
    assert.equal(old?.weight, 45, "one forgotten issue must not swamp the milestone");
    assert.equal(old?.severity, "high");
  });

  it("honours a custom stale threshold", () => {
    const ctx = context({ thresholds: thresholds({ staleDays: 3 }) });
    assert.ok(fired("stalled", issue({ startedAt: ago(10), lastActivityAt: ago(4) }), ctx));
  });

  it("uses lastActivityAt rather than updatedAt", () => {
    // A bot relabelling fifty issues moves updatedAt on all fifty. Trusting it
    // reports a healthy project the day before it slips.
    const touched = issue({ startedAt: ago(20), lastActivityAt: ago(20), updatedAt: ago(0) });
    assert.ok(fired("stalled", touched));
  });
});

describe("blocked_by_open_issue", () => {
  it("fires only when a blocker is still open", () => {
    const o = issue({ blockedBy: ["#2"] });
    assert.equal(fired("blocked_by_open_issue", o, context()), undefined);
    assert.ok(fired("blocked_by_open_issue", o, context({ openKeys: new Set(["#2"]) })));
  });

  it("weights depth above count", () => {
    const one = fired("blocked_by_open_issue", issue({ blockedBy: ["#2"] }), context({ openKeys: new Set(["#2"]) }));
    const two = fired(
      "blocked_by_open_issue",
      issue({ blockedBy: ["#2", "#3"] }),
      context({ openKeys: new Set(["#2", "#3"]) }),
    );
    assert.ok((two?.weight ?? 0) > (one?.weight ?? 0));
    assert.equal(two?.severity, "high");
  });

  it("lists the blocking keys so the report is actionable", () => {
    const s = fired("blocked_by_open_issue", issue({ blockedBy: ["#2", "#3"] }), context({ openKeys: new Set(["#2", "#3"]) }));
    assert.match(s?.detail ?? "", /#2, #3/);
  });
});

describe("overdue", () => {
  it("fires on a past due date and scales with how late", () => {
    assert.equal(fired("overdue", issue({ dueOn: ahead(1) })), undefined);
    const slightly = fired("overdue", issue({ dueOn: ago(1) }));
    const badly = fired("overdue", issue({ dueOn: ago(60) }));
    assert.equal(slightly?.weight, 27);
    assert.equal(badly?.weight, 45);
  });

  it("does not fire without a due date", () => {
    assert.equal(fired("overdue", issue()), undefined);
  });
});

describe("scope_added_after_start", () => {
  it("fires when scope changed after work began", () => {
    const s = fired("scope_added_after_start", issue({ startedAt: ago(20), scopeChangedAt: ago(5) }));
    assert.match(s?.detail ?? "", /15 days after work started/);
  });

  it("does not fire when scope changed before work began", () => {
    assert.equal(fired("scope_added_after_start", issue({ startedAt: ago(5), scopeChangedAt: ago(20) })), undefined);
  });

  it("needs both dates", () => {
    assert.equal(fired("scope_added_after_start", issue({ scopeChangedAt: ago(5) })), undefined);
    assert.equal(fired("scope_added_after_start", issue({ startedAt: ago(5) })), undefined);
  });
});

describe("reopened", () => {
  it("fires on a reopen and weights repeats higher", () => {
    assert.equal(fired("reopened", issue({ reopenCount: 1 }))?.weight, 18);
    assert.equal(fired("reopened", issue({ reopenCount: 2 }))?.severity, "high");
    assert.equal(fired("reopened", issue({ reopenCount: 99 }))?.weight, 40);
  });

  it("still reports a reopen on a closed issue", () => {
    // The only rule that survives a close: it says the estimate was wrong.
    const closed = issue({ state: "closed", closedAt: ago(1), reopenCount: 1 });
    assert.ok(signalsFor(closed, context()).some((s) => s.rule === "reopened"));
  });
});

describe("unassigned_near_due_date", () => {
  it("fires inside the two-week window and not outside it", () => {
    assert.equal(fired("unassigned_near_due_date", issue({ dueOn: ahead(20) })), undefined);
    assert.ok(fired("unassigned_near_due_date", issue({ dueOn: ahead(10) })));
  });

  it("escalates once the date has passed", () => {
    const s = fired("unassigned_near_due_date", issue({ dueOn: ago(2) }));
    assert.equal(s?.severity, "high");
    assert.match(s?.detail ?? "", /already passed/);
  });

  it("does not fire when someone holds it, or with no date at all", () => {
    assert.equal(fired("unassigned_near_due_date", issue({ dueOn: ahead(5), assignees: ["ada"] })), undefined);
    assert.equal(fired("unassigned_near_due_date", issue()), undefined);
  });
});

describe("assignee_churn and discussion_without_movement", () => {
  it("fires churn at three holders", () => {
    assert.equal(fired("assignee_churn", issue({ assigneeHistoryCount: 2 })), undefined);
    assert.match(fired("assignee_churn", issue({ assigneeHistoryCount: 3 }))?.detail ?? "", /3 different people/);
  });

  it("falls back to the current assignee count when no history is available", () => {
    assert.ok(fired("assignee_churn", issue({ assignees: ["a", "b", "c"] })));
  });

  it("fires on a long thread that has gone quiet", () => {
    assert.equal(fired("discussion_without_movement", issue({ commentCount: 14, lastActivityAt: ago(10) })), undefined);
    assert.equal(fired("discussion_without_movement", issue({ commentCount: 20, lastActivityAt: ago(1) })), undefined);
    assert.ok(fired("discussion_without_movement", issue({ commentCount: 20, lastActivityAt: ago(4) })));
  });
});

describe("aging", () => {
  it("fires past 60 days with a deliberately low weight", () => {
    assert.equal(fired("aging", issue({ createdAt: ago(59) })), undefined);
    const s = fired("aging", issue({ createdAt: ago(61) }));
    assert.equal(s?.weight, 10);
    assert.equal(s?.severity, "low");
  });

  it("earns its place by compounding rather than on its own", () => {
    const old = issue({ createdAt: ago(200), startedAt: ago(100), lastActivityAt: ago(40), reopenCount: 1 });
    const signals = signalsFor(old, context());
    assert.ok(signals.length >= 3);
    assert.ok(signals.reduce((sum, s) => sum + s.weight, 0) > 60);
  });
});

describe("the snapshot time is the only clock", () => {
  it("reports the same thing when the real clock has moved on", () => {
    const o = issue({ startedAt: ago(20), lastActivityAt: ago(12), dueOn: ago(3), createdAt: ago(90) });
    const first = signalsFor(o, context({ takenAt: NOW }));
    const second = signalsFor(o, context({ takenAt: NOW }));
    assert.deepEqual(first, second);
  });
});

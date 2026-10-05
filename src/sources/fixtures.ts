/**
 * A bundled snapshot of a fictional project, so the tool runs with no
 * credentials and the demo output is byte-identical on every machine.
 *
 * It is modelled on a project in the state these reports are actually useful
 * in: not on fire, not fine. One milestone quietly behind on throughput while
 * every individual issue looks reasonable, one healthy, one finished, and a
 * handful of risky issues sitting in nobody's plan. The first of those is the
 * case a status meeting misses, because there is nothing to point at.
 */

import { DAY_MS } from "../domain.ts";
import type { Issue, IssueSource, Milestone, Snapshot } from "../domain.ts";

/** Fixed, so the demo and the tests are deterministic. */
export const FIXTURE_TAKEN_AT = "2026-09-29T09:00:00.000Z";

const BASE = Date.parse(FIXTURE_TAKEN_AT);
/** Days before the snapshot. `ago(3)` is three days ago. */
const ago = (days: number): string => new Date(BASE - days * DAY_MS).toISOString();
/** Days after the snapshot. */
const ahead = (days: number): string => new Date(BASE + days * DAY_MS).toISOString();

interface Spec {
  key: string;
  title: string;
  state?: "open" | "closed";
  createdDaysAgo: number;
  activeDaysAgo?: number;
  closedDaysAgo?: number;
  startedDaysAgo?: number;
  scopeChangedDaysAgo?: number;
  dueInDays?: number;
  milestone?: string;
  assignees?: string[];
  labels?: string[];
  blockedBy?: string[];
  reopenCount?: number;
  comments?: number;
  heldBy?: number;
}

const issue = (spec: Spec): Issue => {
  const out: Issue = {
    key: spec.key,
    title: spec.title,
    url: `https://github.com/example/checkout/issues/${spec.key.replace("#", "")}`,
    state: spec.state ?? "open",
    createdAt: ago(spec.createdDaysAgo),
    updatedAt: ago(spec.activeDaysAgo ?? 0),
    assignees: spec.assignees ?? [],
    labels: spec.labels ?? [],
    blockedBy: spec.blockedBy ?? [],
    reopenCount: spec.reopenCount ?? 0,
    commentCount: spec.comments ?? 2,
    lastActivityAt: ago(spec.activeDaysAgo ?? 0),
  };
  if (spec.closedDaysAgo !== undefined) out.closedAt = ago(spec.closedDaysAgo);
  if (spec.startedDaysAgo !== undefined) out.startedAt = ago(spec.startedDaysAgo);
  if (spec.scopeChangedDaysAgo !== undefined) out.scopeChangedAt = ago(spec.scopeChangedDaysAgo);
  if (spec.dueInDays !== undefined) out.dueOn = spec.dueInDays >= 0 ? ahead(spec.dueInDays) : ago(-spec.dueInDays);
  if (spec.milestone !== undefined) out.milestone = spec.milestone;
  if (spec.heldBy !== undefined) out.assigneeHistoryCount = spec.heldBy;
  return out;
};

const CHECKOUT = "v2.1 Checkout";
const RETURNS = "v2.2 Returns";
const HARDENING = "v2.0 Hardening";

const SPECS: Spec[] = [
  // --- v2.1 Checkout: the quiet one. Eleven open, closing about one a week.
  { key: "#401", title: "Split payment across two cards", createdDaysAgo: 74, startedDaysAgo: 30, activeDaysAgo: 19, milestone: CHECKOUT, assignees: ["sofia"], comments: 21 },
  { key: "#402", title: "Apply store credit before card charge", createdDaysAgo: 70, startedDaysAgo: 26, activeDaysAgo: 2, milestone: CHECKOUT, assignees: ["sofia"] },
  { key: "#403", title: "Idempotency key on the charge endpoint", createdDaysAgo: 68, startedDaysAgo: 40, activeDaysAgo: 12, milestone: CHECKOUT, assignees: ["marek"], blockedBy: ["#404"], comments: 9 },
  { key: "#404", title: "Decide on the payment provider's retry semantics", createdDaysAgo: 66, activeDaysAgo: 11, milestone: CHECKOUT, comments: 34, dueInDays: -4 },
  { key: "#405", title: "Guest checkout without an account", createdDaysAgo: 61, startedDaysAgo: 22, scopeChangedDaysAgo: 9, activeDaysAgo: 1, milestone: CHECKOUT, assignees: ["ada"] },
  { key: "#406", title: "3-D Secure challenge flow", createdDaysAgo: 58, startedDaysAgo: 35, activeDaysAgo: 24, milestone: CHECKOUT, assignees: ["marek"], reopenCount: 2, heldBy: 3 },
  { key: "#407", title: "Address autocomplete for DE and AT", createdDaysAgo: 52, activeDaysAgo: 5, milestone: CHECKOUT, dueInDays: 6 },
  { key: "#408", title: "Tax calculation for cross-border orders", createdDaysAgo: 44, startedDaysAgo: 14, activeDaysAgo: 8, milestone: CHECKOUT, assignees: ["ada"], blockedBy: ["#404", "#409"] },
  { key: "#409", title: "Replace the legacy VAT table", createdDaysAgo: 41, activeDaysAgo: 3, milestone: CHECKOUT, assignees: ["jon"] },
  { key: "#410", title: "Checkout analytics events", createdDaysAgo: 30, activeDaysAgo: 4, milestone: CHECKOUT },
  { key: "#411", title: "Error states for a declined card", createdDaysAgo: 22, startedDaysAgo: 6, activeDaysAgo: 1, milestone: CHECKOUT, assignees: ["sofia"] },
  { key: "#390", title: "Cart totals rounding", state: "closed", createdDaysAgo: 80, closedDaysAgo: 24, activeDaysAgo: 24, milestone: CHECKOUT },
  { key: "#391", title: "Coupon stacking rules", state: "closed", createdDaysAgo: 78, closedDaysAgo: 17, activeDaysAgo: 17, milestone: CHECKOUT },
  { key: "#392", title: "Checkout session expiry", state: "closed", createdDaysAgo: 72, closedDaysAgo: 9, activeDaysAgo: 9, milestone: CHECKOUT },
  { key: "#393", title: "Saved card list ordering", state: "closed", createdDaysAgo: 60, closedDaysAgo: 2, activeDaysAgo: 2, milestone: CHECKOUT },

  // --- v2.2 Returns: healthy, well ahead of a distant date.
  { key: "#420", title: "Returns portal skeleton", state: "closed", createdDaysAgo: 40, closedDaysAgo: 20, activeDaysAgo: 20, milestone: RETURNS },
  { key: "#421", title: "Return reason taxonomy", state: "closed", createdDaysAgo: 38, closedDaysAgo: 14, activeDaysAgo: 14, milestone: RETURNS },
  { key: "#422", title: "Print a return label", state: "closed", createdDaysAgo: 35, closedDaysAgo: 8, activeDaysAgo: 8, milestone: RETURNS },
  { key: "#423", title: "Refund on scan-in", state: "closed", createdDaysAgo: 30, closedDaysAgo: 3, activeDaysAgo: 3, milestone: RETURNS },
  { key: "#424", title: "Partial returns", createdDaysAgo: 25, startedDaysAgo: 4, activeDaysAgo: 1, milestone: RETURNS, assignees: ["jon"] },
  { key: "#425", title: "Return window per product category", createdDaysAgo: 20, activeDaysAgo: 2, milestone: RETURNS, assignees: ["ada"] },

  // --- v2.0 Hardening: done.
  { key: "#380", title: "Rotate the payment webhook secret", state: "closed", createdDaysAgo: 95, closedDaysAgo: 40, activeDaysAgo: 40, milestone: HARDENING },
  { key: "#381", title: "Rate limit the public API", state: "closed", createdDaysAgo: 92, closedDaysAgo: 36, activeDaysAgo: 36, milestone: HARDENING },

  // --- no milestone: in nobody's plan.
  { key: "#430", title: "Flaky test in the payment suite", createdDaysAgo: 88, startedDaysAgo: 50, activeDaysAgo: 31, comments: 18 },
  { key: "#431", title: "Upgrade the Node runtime on the workers", createdDaysAgo: 64, startedDaysAgo: 21, activeDaysAgo: 16, assignees: ["marek"], reopenCount: 1 },
  { key: "#432", title: "Document the refund flow", createdDaysAgo: 12, activeDaysAgo: 6 },
];

export const FIXTURE_MILESTONES: Milestone[] = [
  { name: CHECKOUT, dueOn: ahead(3), url: "https://github.com/example/checkout/milestone/3" },
  { name: RETURNS, dueOn: ahead(47), url: "https://github.com/example/checkout/milestone/4" },
  { name: HARDENING, dueOn: ago(30), url: "https://github.com/example/checkout/milestone/2" },
];

export const FIXTURE_ISSUES: Issue[] = SPECS.map(issue);

export function fixtureSnapshot(): Snapshot {
  return {
    source: "fixtures:example/checkout",
    takenAt: FIXTURE_TAKEN_AT,
    issues: FIXTURE_ISSUES,
    milestones: FIXTURE_MILESTONES,
  };
}

export function fixtureSource(): IssueSource {
  return {
    id: "fixtures",
    async fetchSnapshot(): Promise<Snapshot> {
      return fixtureSnapshot();
    },
  };
}

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { githubSource, parseBlockedBy } from "../src/sources/github.ts";
import { jiraSource } from "../src/sources/jira.ts";
import { fixtureSnapshot, fixtureSource, FIXTURE_TAKEN_AT } from "../src/sources/fixtures.ts";
import { sourceFromEnv } from "../src/cli.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/sources/transport.ts";

/** A transport that answers by URL substring and records every request. */
function routed(routes: Array<[string, HttpResponse]>): Transport & { readonly sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  return {
    sent,
    async send(request: HttpRequest): Promise<HttpResponse> {
      sent.push(request);
      for (const [match, response] of routes) {
        if (request.url.includes(match)) return response;
      }
      return { status: 404, headers: {}, body: "{}" };
    },
  };
}

const json = (body: unknown, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const GH_ISSUES = [
  {
    number: 401,
    title: "Split payment",
    html_url: "https://github.com/o/r/issues/401",
    state: "open",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    assignees: [{ login: "sofia" }],
    labels: [{ name: "in progress" }],
    milestone: { title: "v2.1", due_on: "2026-10-02T00:00:00Z", html_url: "https://github.com/o/r/milestone/3" },
    comments: 21,
    body: "Blocked by #404 and #405.\nSee also #999.",
  },
  {
    number: 402,
    title: "A pull request pretending to be an issue",
    html_url: "https://github.com/o/r/pull/402",
    state: "open",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    pull_request: { url: "x" },
  },
  {
    number: 390,
    title: "Done thing",
    html_url: "https://github.com/o/r/issues/390",
    state: "closed",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-09-05T00:00:00Z",
    closed_at: "2026-09-05T00:00:00Z",
    labels: ["chore"],
  },
];

const GH_MILESTONES = [
  { title: "v2.1", due_on: "2026-10-02T00:00:00Z", html_url: "https://github.com/o/r/milestone/3" },
  { title: "backlog", due_on: null },
];

const githubRoutes = (): Array<[string, HttpResponse]> => [
  ["/milestones", json(GH_MILESTONES)],
  ["/events", json([
    { event: "assigned", created_at: "2026-07-05T00:00:00Z", actor: { login: "sofia" } },
    { event: "assigned", created_at: "2026-08-01T00:00:00Z", actor: { login: "marek" } },
    { event: "assigned", created_at: "2026-08-10T00:00:00Z", actor: { login: "ada" } },
    { event: "reopened", created_at: "2026-08-20T00:00:00Z", actor: { login: "marek" } },
    { event: "labeled", created_at: "2026-09-01T00:00:00Z", label: { name: "scope-change" }, actor: { login: "ada" } },
    { event: "labeled", created_at: "2026-09-28T00:00:00Z", label: { name: "needs-triage" }, actor: { login: "stale[bot]" } },
  ])],
  ["/issues", json(GH_ISSUES)],
];

describe("parseBlockedBy", () => {
  it("reads the three spellings people actually use", () => {
    assert.deepEqual(parseBlockedBy("Blocked by #12"), ["#12"]);
    assert.deepEqual(parseBlockedBy("depends on #12, #13"), ["#12", "#13"]);
    assert.deepEqual(parseBlockedBy("Waiting on: #12 and #13"), ["#12", "#13"]);
  });

  it("ignores unrelated issue references", () => {
    // "See also #999" is not a blocker, and treating it as one would invent
    // a dependency graph nobody wrote.
    assert.deepEqual(parseBlockedBy("Fixes #1. See also #999."), []);
  });

  it("deduplicates and copes with no body", () => {
    assert.deepEqual(parseBlockedBy("blocked by #12. Also blocked by #12."), ["#12"]);
    assert.deepEqual(parseBlockedBy(null), []);
    assert.deepEqual(parseBlockedBy(undefined), []);
  });
});

describe("githubSource", () => {
  const source = (overrides: Partial<Parameters<typeof githubSource>[0]> = {}) =>
    githubSource({
      repo: "o/r",
      transport: routed(githubRoutes()),
      now: () => new Date("2026-09-29T09:00:00Z"),
      ...overrides,
    });

  it("maps issues into the normalised model", async () => {
    const snap = await source().fetchSnapshot();
    const issue = snap.issues.find((i) => i.key === "#401");
    assert.equal(issue?.title, "Split payment");
    assert.deepEqual(issue?.assignees, ["sofia"]);
    assert.equal(issue?.milestone, "v2.1");
    assert.equal(issue?.commentCount, 21);
    assert.deepEqual(issue?.blockedBy, ["#404", "#405"]);
  });

  it("drops pull requests, which would double-count throughput", async () => {
    const snap = await source().fetchSnapshot();
    assert.deepEqual(snap.issues.map((i) => i.key).sort(), ["#390", "#401"]);
  });

  it("reads milestones including one with no due date", async () => {
    const snap = await source().fetchSnapshot();
    assert.deepEqual(snap.milestones.map((m) => m.name), ["v2.1", "backlog"]);
    assert.equal(snap.milestones.find((m) => m.name === "backlog")?.dueOn, undefined);
  });

  it("sends the token when given one and omits it when not", async () => {
    const withToken = routed(githubRoutes());
    await githubSource({ repo: "o/r", transport: withToken, token: "t" }).fetchSnapshot();
    assert.equal(withToken.sent[0]?.headers["authorization"], "Bearer t");

    const without = routed(githubRoutes());
    await githubSource({ repo: "o/r", transport: without }).fetchSnapshot();
    assert.equal(without.sent[0]?.headers["authorization"], undefined);
  });

  it("costs two requests without the timeline, and one per issue with it", async () => {
    // The trade-off made visible. The version of this that quietly fires a
    // request per issue is the version that rate-limits someone mid-release.
    const cheap = routed(githubRoutes());
    await githubSource({ repo: "o/r", transport: cheap }).fetchSnapshot();
    assert.equal(cheap.sent.length, 2, "issues + milestones");

    const thorough = routed(githubRoutes());
    await githubSource({ repo: "o/r", transport: thorough, includeTimeline: true }).fetchSnapshot();
    assert.equal(thorough.sent.filter((r) => r.url.includes("/events")).length, 2, "one per issue");
  });

  it("without the timeline, says what it does not know", async () => {
    const snap = await source().fetchSnapshot();
    const issue = snap.issues.find((i) => i.key === "#401");
    assert.equal(issue?.reopenCount, 0);
    assert.equal(issue?.lastActivityAt, issue?.updatedAt);
    assert.equal(issue?.assigneeHistoryCount, undefined);
  });

  it("with the timeline, fills in history and ignores bot activity", async () => {
    const snap = await source({ includeTimeline: true }).fetchSnapshot();
    const issue = snap.issues.find((i) => i.key === "#401");
    assert.equal(issue?.reopenCount, 1);
    assert.equal(issue?.assigneeHistoryCount, 3);
    assert.equal(issue?.startedAt, "2026-07-05T00:00:00Z");
    assert.equal(issue?.scopeChangedAt, "2026-09-01T00:00:00Z");
    // The bot relabelled it on the 28th. Counting that as activity is what
    // makes a stale project look healthy.
    assert.equal(issue?.lastActivityAt, "2026-09-01T00:00:00Z");
  });

  it("explains an exhausted rate limit instead of returning HTTP 403", async () => {
    const limited: Transport = {
      async send(): Promise<HttpResponse> {
        return {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" },
          body: "{}",
        };
      },
    };
    await assert.rejects(
      () => githubSource({ repo: "o/r", transport: limited }).fetchSnapshot(),
      /rate limit exhausted.*GITHUB_TOKEN/s,
    );
  });

  it("reports any other failure with its status", async () => {
    const broken: Transport = { async send() { return { status: 500, headers: {}, body: "" }; } };
    await assert.rejects(() => githubSource({ repo: "o/r", transport: broken }).fetchSnapshot(), /HTTP 500/);
  });

  it("caps how many issues a first run pulls", async () => {
    const snap = await source({ maxIssues: 1 }).fetchSnapshot();
    assert.equal(snap.issues.length, 1);
  });
});

describe("jiraSource", () => {
  const JIRA_BODY = {
    issues: [
      {
        key: "PROJ-1",
        fields: {
          summary: "Checkout rewrite",
          status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          created: "2026-07-01T00:00:00.000+0000",
          updated: "2026-09-20T00:00:00.000+0000",
          duedate: "2026-10-02",
          assignee: { displayName: "Sofia" },
          labels: ["payments"],
          comment: { total: 7 },
          fixVersions: [{ name: "v2.1", releaseDate: "2026-10-05" }],
          customfield_10016: 8,
          issuelinks: [
            { type: { inward: "is blocked by" }, inwardIssue: { key: "PROJ-9", fields: { status: { statusCategory: { key: "indeterminate" } } } } },
            { type: { inward: "is blocked by" }, inwardIssue: { key: "PROJ-8", fields: { status: { statusCategory: { key: "done" } } } } },
            { type: { inward: "relates to" }, inwardIssue: { key: "PROJ-7", fields: { status: { statusCategory: { key: "indeterminate" } } } } },
          ],
        },
        changelog: {
          histories: [
            { created: "2026-07-05T00:00:00.000+0000", items: [{ field: "status", fromString: "To Do", toString: "In Progress" }] },
            { created: "2026-08-01T00:00:00.000+0000", items: [{ field: "assignee", toString: "Marek" }] },
            { created: "2026-08-15T00:00:00.000+0000", items: [{ field: "status", fromString: "Done", toString: "In Progress" }] },
            { created: "2026-09-10T00:00:00.000+0000", items: [{ field: "Story Points", fromString: "5", toString: "8" }] },
          ],
        },
      },
      {
        key: "PROJ-2",
        fields: {
          summary: "Shipped",
          status: { statusCategory: { key: "done" } },
          created: "2026-06-01T00:00:00.000+0000",
          updated: "2026-09-01T00:00:00.000+0000",
          resolutiondate: "2026-09-01T00:00:00.000+0000",
          fixVersions: [{ name: "v2.1", releaseDate: "2026-10-05" }],
          customfield_10016: 3,
        },
      },
    ],
  };

  const source = (transport: Transport) =>
    jiraSource({
      baseUrl: "https://org.atlassian.net",
      email: "me@example.com",
      apiToken: "t",
      jql: "project = PROJ",
      transport,
      now: () => new Date("2026-09-29T09:00:00Z"),
    });

  it("gets the whole history in one request, unlike GitHub", async () => {
    const transport = routed([["/rest/api/3/search", json(JIRA_BODY)]]);
    await source(transport).fetchSnapshot();
    assert.equal(transport.sent.length, 1);
    assert.match(transport.sent[0]?.body ?? "", /"expand":\["changelog"\]/);
  });

  it("maps status category to open and closed", async () => {
    const snap = await source(routed([["/search", json(JIRA_BODY)]])).fetchSnapshot();
    assert.equal(snap.issues.find((i) => i.key === "PROJ-1")?.state, "open");
    assert.equal(snap.issues.find((i) => i.key === "PROJ-2")?.state, "closed");
  });

  it("derives started, reopened, scope change and assignee history from the changelog", async () => {
    const snap = await source(routed([["/search", json(JIRA_BODY)]])).fetchSnapshot();
    const issue = snap.issues.find((i) => i.key === "PROJ-1");
    assert.equal(issue?.startedAt, "2026-07-05T00:00:00.000+0000");
    assert.equal(issue?.reopenCount, 1);
    assert.equal(issue?.scopeChangedAt, "2026-09-10T00:00:00.000+0000");
    assert.equal(issue?.assigneeHistoryCount, 1);
    assert.equal(issue?.lastActivityAt, "2026-09-10T00:00:00.000+0000");
  });

  it("keeps only unresolved blockers, and only real blocker links", async () => {
    const snap = await source(routed([["/search", json(JIRA_BODY)]])).fetchSnapshot();
    assert.deepEqual(snap.issues.find((i) => i.key === "PROJ-1")?.blockedBy, ["PROJ-9"]);
  });

  it("reads the estimate and turns fix versions into milestones", async () => {
    const snap = await source(routed([["/search", json(JIRA_BODY)]])).fetchSnapshot();
    assert.equal(snap.issues.find((i) => i.key === "PROJ-1")?.estimate, 8);
    assert.deepEqual(snap.milestones, [{ name: "v2.1", dueOn: "2026-10-05T00:00:00Z" }]);
  });

  it("sends basic auth and reports rejected credentials clearly", async () => {
    const transport = routed([["/search", json(JIRA_BODY)]]);
    await source(transport).fetchSnapshot();
    assert.equal(
      transport.sent[0]?.headers["authorization"],
      "Basic " + Buffer.from("me@example.com:t").toString("base64"),
    );

    const rejecting = routed([["/search", json({}, 401)]]);
    await assert.rejects(() => source(rejecting).fetchSnapshot(), /Check JIRA_EMAIL and JIRA_API_TOKEN/);
  });
});

describe("fixtureSource", () => {
  it("returns a fixed snapshot, so the demo is byte-identical everywhere", async () => {
    const snap = await fixtureSource().fetchSnapshot();
    assert.equal(snap.takenAt, FIXTURE_TAKEN_AT);
    assert.deepEqual(snap, fixtureSnapshot());
  });

  it("has open and closed issues, three milestones and unscheduled work", async () => {
    const snap = await fixtureSource().fetchSnapshot();
    assert.equal(snap.milestones.length, 3);
    assert.ok(snap.issues.some((i) => i.state === "closed"));
    assert.ok(snap.issues.some((i) => i.milestone === undefined));
  });
});

describe("sourceFromEnv", () => {
  it("falls back to the fixtures with an empty environment", () => {
    assert.equal(sourceFromEnv({}).id, "fixtures");
  });

  it("prefers GitHub when a repo is set", () => {
    assert.equal(sourceFromEnv({ GITHUB_REPO: "o/r" }).id, "github:o/r");
  });

  it("uses Jira when its credentials are complete", () => {
    const id = sourceFromEnv({
      JIRA_BASE_URL: "https://x.atlassian.net",
      JIRA_EMAIL: "a@b.c",
      JIRA_API_TOKEN: "t",
      JIRA_JQL: "project = P",
    }).id;
    assert.equal(id, "jira:project = P");
  });

  it("ignores half-configured Jira credentials rather than failing later", () => {
    assert.equal(sourceFromEnv({ JIRA_BASE_URL: "https://x", JIRA_EMAIL: "a@b.c" }).id, "fixtures");
  });
});

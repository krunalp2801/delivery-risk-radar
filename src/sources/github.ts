/**
 * GitHub as a source.
 *
 * The interesting constraint here is cost. One list call gives you every
 * issue, but it does not give you history: GitHub's `updated_at` moves when a
 * bot relabels an issue, and nothing in the list response tells you whether
 * an issue was reopened, when it started, or how many people have held it.
 * All of that lives in the per-issue timeline, which is one request each.
 *
 * So the timeline pass is opt-in. Off, you get a report built on list data
 * with `reopenCount` at zero and `lastActivityAt` equal to `updated_at`, and
 * the report says so. On, you get the real signals and spend a request per
 * issue. On a 400-issue repo that is 400 requests against a 5,000 per hour
 * budget, which is affordable weekly and not hourly.
 *
 * Making that visible rather than choosing silently is the point. The version
 * of this that quietly fires 400 requests is the version that gets someone's
 * token rate-limited during a release.
 */

import { httpTransport } from "./transport.ts";
import type { Transport } from "./transport.ts";
import type { Issue, IssueSource, Milestone, Snapshot } from "../domain.ts";

export interface GithubOptions {
  /** "owner/name" */
  repo: string;
  token?: string;
  apiUrl?: string;
  transport?: Transport;
  /** Fetch per-issue timelines. Accurate, and one request per issue. */
  includeTimeline?: boolean;
  /** Stop after this many issues. Protects a first run against a huge repo. */
  maxIssues?: number;
  now?: () => Date;
}

interface GhUser { login?: string }
interface GhLabel { name?: string }
interface GhMilestone { title?: string; due_on?: string | null; html_url?: string }

interface GhIssue {
  number?: number;
  title?: string;
  html_url?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  assignees?: GhUser[];
  labels?: Array<GhLabel | string>;
  milestone?: GhMilestone | null;
  comments?: number;
  body?: string | null;
  /** Present on issues that are really pull requests. */
  pull_request?: unknown;
}

interface GhEvent {
  event?: string;
  created_at?: string;
  label?: GhLabel;
  actor?: GhUser;
}

/**
 * Labels that mean "this is being worked on".
 *
 * A convention rather than a feature: GitHub has no status field, so the
 * start of work has to be inferred. Assignment is the most reliable proxy
 * when no label convention exists.
 */
const IN_PROGRESS_LABELS = ["in progress", "in-progress", "wip", "doing", "started"];

/** Labels whose arrival counts as scope being added. */
const SCOPE_LABELS = ["scope", "scope-change", "scope creep", "extra", "additional"];

/**
 * GitHub has no blocker links, so the convention is prose. This reads the
 * three spellings people actually use.
 */
export function parseBlockedBy(body: string | null | undefined): string[] {
  if (body === null || body === undefined) return [];
  const out = new Set<string>();
  const re = /(?:blocked\s+by|depends\s+on|waiting\s+on)\s*:?\s*((?:#\d+[\s,and]*)+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    for (const ref of (m[1] ?? "").match(/#\d+/g) ?? []) out.add(ref);
  }
  return [...out];
}

const labelNames = (labels: GhIssue["labels"]): string[] =>
  (labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter((n) => n !== "");

export function githubSource(options: GithubOptions): IssueSource {
  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const transport = options.transport ?? httpTransport();
  const now = options.now ?? (() => new Date());
  const maxIssues = options.maxIssues ?? 300;

  const headers = (): Record<string, string> => {
    const base: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "delivery-risk-radar",
    };
    if (options.token !== undefined && options.token !== "") base["authorization"] = `Bearer ${options.token}`;
    return base;
  };

  const getJson = async <T>(path: string): Promise<T> => {
    const res = await transport.send({ url: `${apiUrl}${path}`, method: "GET", headers: headers() });
    if (res.status === 403 && (res.headers["x-ratelimit-remaining"] ?? "") === "0") {
      const reset = res.headers["x-ratelimit-reset"] ?? "";
      throw new Error(
        `GitHub rate limit exhausted${reset === "" ? "" : `, resets at ${new Date(Number(reset) * 1000).toISOString()}`}. ` +
          `Set GITHUB_TOKEN, or run without --timeline, which costs one request per issue.`,
      );
    }
    if (res.status >= 400) throw new Error(`GitHub ${path} returned HTTP ${res.status}`);
    return JSON.parse(res.body) as T;
  };

  /** Fill in what only the timeline knows. */
  const enrich = async (issue: Issue, number: number): Promise<Issue> => {
    const events = await getJson<GhEvent[]>(`/repos/${options.repo}/issues/${number}/events?per_page=100`);
    const assignedTo = new Set<string>();
    let reopenCount = 0;
    let startedAt: string | undefined;
    let scopeChangedAt: string | undefined;
    let lastHuman = issue.createdAt;

    for (const event of events) {
      const at = event.created_at ?? "";
      const actor = event.actor?.login ?? "";
      const isBot = actor.endsWith("[bot]") || actor.endsWith("-bot");
      if (!isBot && at > lastHuman) lastHuman = at;

      if (event.event === "reopened") reopenCount += 1;
      if (event.event === "assigned") {
        if (actor !== "") assignedTo.add(actor);
        if (startedAt === undefined) startedAt = at;
      }
      const label = (event.label?.name ?? "").toLowerCase();
      if (event.event === "labeled") {
        if (IN_PROGRESS_LABELS.includes(label) && startedAt === undefined) startedAt = at;
        if (SCOPE_LABELS.some((s) => label.includes(s))) scopeChangedAt = at;
      }
    }

    const enriched: Issue = { ...issue, reopenCount, lastActivityAt: lastHuman };
    if (startedAt !== undefined) enriched.startedAt = startedAt;
    if (scopeChangedAt !== undefined) enriched.scopeChangedAt = scopeChangedAt;
    if (assignedTo.size > 0) enriched.assigneeHistoryCount = assignedTo.size;
    return enriched;
  };

  return {
    id: `github:${options.repo}`,

    async fetchSnapshot(): Promise<Snapshot> {
      const raw = await getJson<GhIssue[]>(
        `/repos/${options.repo}/issues?state=all&per_page=100&sort=updated&direction=desc`,
      );
      // The issues endpoint returns pull requests too. They are a different
      // kind of object with a different lifecycle and they would double-count
      // throughput, so they are dropped rather than reported.
      const issuesOnly = raw.filter((i) => i.pull_request === undefined).slice(0, maxIssues);

      let issues: Issue[] = issuesOnly.map((raw_): Issue => {
        const issue: Issue = {
          key: `#${raw_.number ?? 0}`,
          title: raw_.title ?? "",
          url: raw_.html_url ?? "",
          state: raw_.state === "closed" ? "closed" : "open",
          createdAt: raw_.created_at ?? "",
          updatedAt: raw_.updated_at ?? "",
          assignees: (raw_.assignees ?? []).map((a) => a.login ?? "").filter((l) => l !== ""),
          labels: labelNames(raw_.labels),
          blockedBy: parseBlockedBy(raw_.body),
          reopenCount: 0,
          commentCount: raw_.comments ?? 0,
          // Without the timeline this is the best available answer, and it
          // over-reports activity whenever a bot has touched the issue.
          lastActivityAt: raw_.updated_at ?? raw_.created_at ?? "",
        };
        if (raw_.closed_at !== null && raw_.closed_at !== undefined) issue.closedAt = raw_.closed_at;
        if (raw_.milestone?.title !== undefined) issue.milestone = raw_.milestone.title;
        const labels = issue.labels.map((l) => l.toLowerCase());
        if (labels.some((l) => IN_PROGRESS_LABELS.includes(l))) issue.startedAt = issue.createdAt;
        else if (issue.assignees.length > 0 && issue.state === "open") issue.startedAt = issue.createdAt;
        return issue;
      });

      if (options.includeTimeline === true) {
        const enriched: Issue[] = [];
        for (const issue of issues) {
          enriched.push(await enrich(issue, Number(issue.key.slice(1))));
        }
        issues = enriched;
      }

      const rawMilestones = await getJson<GhMilestone[]>(
        `/repos/${options.repo}/milestones?state=all&per_page=100`,
      );
      const milestones: Milestone[] = rawMilestones.map((m) => {
        const milestone: Milestone = { name: m.title ?? "" };
        if (m.due_on !== null && m.due_on !== undefined) milestone.dueOn = m.due_on;
        if (m.html_url !== undefined) milestone.url = m.html_url;
        return milestone;
      });

      return { source: `github:${options.repo}`, takenAt: now().toISOString(), issues, milestones };
    },
  };
}

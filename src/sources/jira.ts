/**
 * Jira as a source.
 *
 * The contrast with GitHub is the whole reason both adapters are here. Jira
 * returns the changelog in the same search call via `expand=changelog`, so
 * one request gets you status transitions, reopens and assignee history for
 * every issue at once. GitHub charges a request per issue for the same thing.
 *
 * That difference is not a detail, it decides what the tool can afford to do.
 * Against Jira the full signal set is free; against GitHub it is opt-in.
 */

import { httpTransport } from "./transport.ts";
import type { Transport } from "./transport.ts";
import type { Issue, IssueSource, Milestone, Snapshot } from "../domain.ts";

export interface JiraOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  jql: string;
  transport?: Transport;
  maxIssues?: number;
  /** Field id holding the estimate. Jira installs vary. */
  storyPointsField?: string;
  now?: () => Date;
}

interface JiraChangeItem { field?: string; fromString?: string | null; toString?: string | null }
interface JiraHistory { created?: string; items?: JiraChangeItem[]; author?: { accountId?: string } }

interface JiraIssue {
  key?: string;
  fields?: Record<string, unknown> & {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
    duedate?: string | null;
    assignee?: { displayName?: string } | null;
    labels?: string[];
    comment?: { total?: number };
    fixVersions?: Array<{ name?: string; releaseDate?: string }>;
    issuelinks?: Array<{
      type?: { inward?: string };
      inwardIssue?: { key?: string; fields?: { status?: { statusCategory?: { key?: string } } } };
    }>;
  };
  changelog?: { histories?: JiraHistory[] };
}

interface JiraSearchResponse { issues?: JiraIssue[] }

const DONE = "done";

export function jiraSource(options: JiraOptions): IssueSource {
  const transport = options.transport ?? httpTransport();
  const now = options.now ?? (() => new Date());
  const maxIssues = options.maxIssues ?? 200;
  const pointsField = options.storyPointsField ?? "customfield_10016";
  const auth = "Basic " + Buffer.from(`${options.email}:${options.apiToken}`).toString("base64");

  return {
    id: `jira:${options.jql}`,

    async fetchSnapshot(): Promise<Snapshot> {
      const res = await transport.send({
        url: `${options.baseUrl}/rest/api/3/search`,
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: auth },
        body: JSON.stringify({
          jql: options.jql,
          maxResults: maxIssues,
          // One call, history included. This is the thing GitHub cannot do.
          expand: ["changelog"],
          fields: [
            "summary", "status", "created", "updated", "resolutiondate", "duedate",
            "assignee", "labels", "comment", "fixVersions", "issuelinks", pointsField,
          ],
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error("Jira rejected the credentials. Check JIRA_EMAIL and JIRA_API_TOKEN.");
      }
      if (res.status >= 400) throw new Error(`Jira search returned HTTP ${res.status}`);

      const body = JSON.parse(res.body) as JiraSearchResponse;
      const milestones = new Map<string, Milestone>();

      const issues: Issue[] = (body.issues ?? []).map((raw): Issue => {
        const fields = raw.fields ?? {};
        const done = fields.status?.statusCategory?.key === DONE;

        let reopenCount = 0;
        let startedAt: string | undefined;
        let scopeChangedAt: string | undefined;
        let lastActivityAt = fields.created ?? "";
        const assignees = new Set<string>();

        for (const history of raw.changelog?.histories ?? []) {
          const at = history.created ?? "";
          if (at > lastActivityAt) lastActivityAt = at;
          for (const item of history.items ?? []) {
            if (item.field === "status") {
              const to = (item.toString ?? "").toLowerCase();
              const from = (item.fromString ?? "").toLowerCase();
              if (startedAt === undefined && (to.includes("progress") || to.includes("doing"))) startedAt = at;
              if (from.includes("done") || from.includes("closed") || from.includes("resolved")) reopenCount += 1;
            }
            if (item.field === "assignee" && item.toString !== null && item.toString !== undefined) {
              assignees.add(item.toString);
            }
            // Jira records an estimate change as a field edit, which is the
            // cleanest scope-change signal any of these trackers gives you.
            if (item.field === "Story Points" || item.field === "timeoriginalestimate") scopeChangedAt = at;
          }
        }

        const version = fields.fixVersions?.[0];
        if (version?.name !== undefined && !milestones.has(version.name)) {
          const milestone: Milestone = { name: version.name };
          if (version.releaseDate !== undefined) milestone.dueOn = `${version.releaseDate}T00:00:00Z`;
          milestones.set(version.name, milestone);
        }

        const blockedBy = (fields.issuelinks ?? [])
          .filter((link) => (link.type?.inward ?? "").toLowerCase().includes("blocked"))
          .filter((link) => link.inwardIssue?.fields?.status?.statusCategory?.key !== DONE)
          .map((link) => link.inwardIssue?.key ?? "")
          .filter((key) => key !== "");

        const issue: Issue = {
          key: raw.key ?? "",
          title: fields.summary ?? "",
          url: `${options.baseUrl}/browse/${raw.key ?? ""}`,
          state: done ? "closed" : "open",
          createdAt: fields.created ?? "",
          updatedAt: fields.updated ?? "",
          assignees: fields.assignee?.displayName === undefined ? [] : [fields.assignee.displayName],
          labels: fields.labels ?? [],
          blockedBy,
          reopenCount,
          commentCount: fields.comment?.total ?? 0,
          lastActivityAt,
        };
        if (fields.resolutiondate !== null && fields.resolutiondate !== undefined) {
          issue.closedAt = fields.resolutiondate;
        }
        if (fields.duedate !== null && fields.duedate !== undefined) issue.dueOn = `${fields.duedate}T00:00:00Z`;
        if (version?.name !== undefined) issue.milestone = version.name;
        const points = fields[pointsField];
        if (typeof points === "number") issue.estimate = points;
        if (startedAt !== undefined) issue.startedAt = startedAt;
        if (scopeChangedAt !== undefined) issue.scopeChangedAt = scopeChangedAt;
        if (assignees.size > 0) issue.assigneeHistoryCount = assignees.size;
        return issue;
      });

      return {
        source: `jira:${options.jql}`,
        takenAt: now().toISOString(),
        issues,
        milestones: [...milestones.values()],
      };
    },
  };
}

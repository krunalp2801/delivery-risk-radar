/**
 * `delivery-risk-radar` — print a delivery risk report as Markdown.
 *
 * Picks a source from the environment: GITHUB_REPO, else Jira credentials,
 * else the bundled fixtures. The output goes to stdout so it can be piped
 * into a file, a gist, or `gh issue comment --body-file -`.
 */

import { markdownFor } from "./report.ts";
import { renderOneLine } from "./digest.ts";
import { reportFor } from "./report.ts";
import { resolveNarrative } from "./narrative.ts";
import { fixtureSource } from "./sources/fixtures.ts";
import { githubSource } from "./sources/github.ts";
import { jiraSource } from "./sources/jira.ts";
import { DEFAULT_THRESHOLDS } from "./domain.ts";
import { SIGNAL_RULES } from "./signals.ts";
import type { IssueSource, Thresholds } from "./domain.ts";

const USAGE = `delivery-risk-radar

  npm run report                 report from GITHUB_REPO, Jira, or the fixtures
  npm run report -- --one-line   one line, for a Slack message or a cron log
  npm run report -- --timeline   GitHub only: fetch per-issue history
                                 (accurate, one request per issue)
  npm run report -- --explain    print the signal rules and why each exists
  npm run report -- --help

Environment: see .env.example. With nothing set it runs on bundled fixtures.
`;

function thresholdsFromEnv(env: Record<string, string | undefined>): Thresholds {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    staleDays: num(env["RADAR_STALE_DAYS"], DEFAULT_THRESHOLDS.staleDays),
    throughputWeeks: num(env["RADAR_THROUGHPUT_WEEKS"], DEFAULT_THRESHOLDS.throughputWeeks),
    amberSlipDays: num(env["RADAR_AMBER_SLIP_DAYS"], DEFAULT_THRESHOLDS.amberSlipDays),
    redSlipDays: num(env["RADAR_RED_SLIP_DAYS"], DEFAULT_THRESHOLDS.redSlipDays),
  };
}

/** Choose a source, and say which one was chosen on stderr. */
export function sourceFromEnv(
  env: Record<string, string | undefined>,
  options: { includeTimeline?: boolean } = {},
): IssueSource {
  const repo = env["GITHUB_REPO"];
  if (repo !== undefined && repo !== "") {
    const githubOptions: Parameters<typeof githubSource>[0] = { repo };
    const token = env["GITHUB_TOKEN"];
    if (token !== undefined && token !== "") githubOptions.token = token;
    const apiUrl = env["GITHUB_API_URL"];
    if (apiUrl !== undefined && apiUrl !== "") githubOptions.apiUrl = apiUrl;
    if (options.includeTimeline === true) githubOptions.includeTimeline = true;
    return githubSource(githubOptions);
  }

  const jiraUrl = env["JIRA_BASE_URL"];
  const jiraEmail = env["JIRA_EMAIL"];
  const jiraToken = env["JIRA_API_TOKEN"];
  if (jiraUrl !== undefined && jiraEmail !== undefined && jiraToken !== undefined && jiraToken !== "") {
    return jiraSource({
      baseUrl: jiraUrl,
      email: jiraEmail,
      apiToken: jiraToken,
      jql: env["JIRA_JQL"] ?? "statusCategory != Done ORDER BY updated DESC",
    });
  }

  return fixtureSource();
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  if (argv.includes("--explain")) {
    for (const rule of SIGNAL_RULES) {
      process.stdout.write(`${rule.name}\n  ${rule.rationale}\n\n`);
    }
    return;
  }

  const source = sourceFromEnv(process.env, { includeTimeline: argv.includes("--timeline") });
  process.stderr.write(`source: ${source.id}\n`);

  const snapshot = await source.fetchSnapshot();
  const options = { thresholds: thresholdsFromEnv(process.env), narrative: resolveNarrative(process.env) };

  if (argv.includes("--one-line")) {
    process.stdout.write(renderOneLine(await reportFor(snapshot, options)) + "\n");
    return;
  }
  process.stdout.write((await markdownFor(snapshot, options)) + "\n");
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
});

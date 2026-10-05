/** Public surface. */

export { analyse, pressureOf, ragFor, scoreIssue } from "./risk.ts";
export type { Analysis, AnalyseOptions } from "./risk.ts";
export { ruleByName, signalsFor, SIGNAL_RULES } from "./signals.ts";
export type { SignalContext, SignalRule } from "./signals.ts";
export { measureThroughput, project, remainingWork } from "./throughput.ts";
export type { Projection, Remaining, Throughput } from "./throughput.ts";
export { buildReport, renderMarkdown, renderOneLine } from "./digest.ts";
export {
  anthropicNarrative,
  buildPrompt,
  resolveNarrative,
  templateNarrative,
} from "./narrative.ts";
export type { NarrativeRequest, NarrativeWriter } from "./narrative.ts";
export { githubSource, parseBlockedBy } from "./sources/github.ts";
export type { GithubOptions } from "./sources/github.ts";
export { jiraSource } from "./sources/jira.ts";
export type { JiraOptions } from "./sources/jira.ts";
export { fixtureSnapshot, fixtureSource, FIXTURE_TAKEN_AT } from "./sources/fixtures.ts";
export { httpTransport } from "./sources/transport.ts";
export type { HttpRequest, HttpResponse, Transport } from "./sources/transport.ts";
export { addDays, daysBetween, DAY_MS, DEFAULT_THRESHOLDS } from "./domain.ts";
export type {
  Forecast,
  Issue,
  IssueRisk,
  IssueSignal,
  IssueSource,
  Milestone,
  Rag,
  Report,
  Severity,
  Snapshot,
  Thresholds,
} from "./domain.ts";

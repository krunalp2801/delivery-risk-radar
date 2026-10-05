/**
 * Test helpers. A fixed snapshot time and an issue builder, so each test
 * states only the field under examination.
 */

import { DAY_MS } from "../src/domain.ts";
import type { Issue, SnapshotLike } from "./types.ts";
import type { Snapshot, Thresholds } from "../src/domain.ts";
import { DEFAULT_THRESHOLDS } from "../src/domain.ts";
import type { SignalContext } from "../src/signals.ts";

export const NOW = "2026-09-29T09:00:00.000Z";
const BASE = Date.parse(NOW);

export const ago = (days: number): string => new Date(BASE - days * DAY_MS).toISOString();
export const ahead = (days: number): string => new Date(BASE + days * DAY_MS).toISOString();

export function issue(patch: Partial<Issue> = {}): Issue {
  return {
    key: "#1",
    title: "An issue",
    url: "https://example.test/1",
    state: "open",
    createdAt: ago(10),
    updatedAt: ago(1),
    assignees: [],
    labels: [],
    blockedBy: [],
    reopenCount: 0,
    commentCount: 2,
    lastActivityAt: ago(1),
    ...patch,
  };
}

export function context(patch: Partial<SignalContext> = {}): SignalContext {
  return {
    takenAt: NOW,
    openKeys: new Set<string>(),
    thresholds: DEFAULT_THRESHOLDS,
    ...patch,
  };
}

export function snapshot(issues: Issue[], milestones: Snapshot["milestones"] = []): Snapshot {
  return { source: "test", takenAt: NOW, issues, milestones };
}

export const thresholds = (patch: Partial<Thresholds> = {}): Thresholds => ({
  ...DEFAULT_THRESHOLDS,
  ...patch,
});

export type { SnapshotLike };

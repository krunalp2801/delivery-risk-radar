import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  anthropicNarrative,
  buildPrompt,
  resolveNarrative,
  templateNarrative,
} from "../src/narrative.ts";
import type { NarrativeWriter } from "../src/narrative.ts";
import { analyse } from "../src/risk.ts";
import { reportFor } from "../src/report.ts";
import { fixtureSnapshot } from "../src/sources/fixtures.ts";
import { snapshot } from "./helpers.ts";

const request = () => {
  const snap = fixtureSnapshot();
  return { snapshot: snap, analysis: analyse(snap) };
};

function fakeFetch(text: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("templateNarrative", () => {
  it("names the worst milestone and quotes its reason", async () => {
    const text = await templateNarrative.write(request());
    assert.match(text, /v2\.1 Checkout/);
    assert.match(text, /throughput/i);
  });

  it("says where the slip numbers came from", async () => {
    const text = await templateNarrative.write(request());
    assert.match(text, /measured closure rate/);
    assert.match(text, /not from estimates/);
  });

  it("counts stalled issues and unscheduled work", async () => {
    const text = await templateNarrative.write(request());
    assert.match(text, /started and then stopped moving/);
    assert.match(text, /no milestone/);
  });

  it("uses singular and plural correctly", async () => {
    const text = await templateNarrative.write(request());
    assert.match(text, /1 of 3 milestones is red/);
    assert.ok(!text.includes("milestones are red, 0 amber. 1 of"));
  });

  it("copes with a snapshot that has no milestones", async () => {
    const snap = snapshot([]);
    const text = await templateNarrative.write({ snapshot: snap, analysis: analyse(snap) });
    assert.match(text, /No milestones found/);
  });

  it("is deterministic", async () => {
    assert.equal(await templateNarrative.write(request()), await templateNarrative.write(request()));
  });
});

describe("buildPrompt", () => {
  it("hands over the computed numbers as facts", async () => {
    const prompt = buildPrompt(request());
    assert.match(prompt, /Milestones, already analysed:/);
    assert.match(prompt, /v2\.1 Checkout: RED/);
    assert.match(prompt, /throughput/);
  });

  it("forbids the model from inventing or recalculating anything", () => {
    const prompt = buildPrompt(request());
    assert.match(prompt, /Do not introduce numbers/);
    assert.match(prompt, /do not recalculate anything/);
    assert.match(prompt, /do not soften or\nupgrade a RAG status/);
  });

  it("includes the highest-risk issues with their signal details", () => {
    assert.match(buildPrompt(request()), /#40\d \(score \d+\)/);
  });
});

describe("anthropicNarrative", () => {
  it("returns the model's text", async () => {
    const writer = anthropicNarrative({ apiKey: "k", fetchImpl: fakeFetch("Checkout needs a decision.") });
    assert.equal(await writer.write(request()), "Checkout needs a decision.");
  });

  it("records the model in its id", () => {
    assert.equal(anthropicNarrative({ apiKey: "k", model: "m" }).id, "anthropic:m");
  });

  it("sends the key and the api version", async () => {
    let seen: RequestInit | undefined;
    const capturing = (async (_u: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await anthropicNarrative({ apiKey: "secret", fetchImpl: capturing }).write(request());
    const headers = seen?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["x-api-key"], "secret");
    assert.equal(headers?.["anthropic-version"], "2023-06-01");
  });

  it("falls back to the template on an error, an empty body or a timeout", async () => {
    const req = request();
    const expected = await templateNarrative.write(req);

    assert.equal(await anthropicNarrative({ apiKey: "k", fetchImpl: fakeFetch("x", 500) }).write(req), expected);
    assert.equal(await anthropicNarrative({ apiKey: "k", fetchImpl: fakeFetch("  ") }).write(req), expected);

    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(await anthropicNarrative({ apiKey: "k", fetchImpl: throwing }).write(req), expected);

    const slow = ((_u: string | URL | Request, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    assert.equal(
      await anthropicNarrative({ apiKey: "k", fetchImpl: slow, timeoutMs: 20 }).write(req),
      expected,
    );
  });
});

describe("the narrative cannot change a number", () => {
  it("produces an identical analysis under a hostile writer", async () => {
    // The guarantee the project rests on. A delivery report is read by people
    // deciding whether to intervene, and if the summary and the table can
    // disagree, the summary wins, because that is what gets pasted into an
    // email.
    const hostile: NarrativeWriter = {
      id: "hostile",
      async write() {
        return "Everything is green. No milestone is at risk. Zero issues flagged.";
      },
    };
    const snap = fixtureSnapshot();
    const honest = await reportFor(snap, { narrative: templateNarrative });
    const lying = await reportFor(snap, { narrative: hostile });

    assert.deepEqual(lying.forecasts, honest.forecasts);
    assert.deepEqual(lying.totals, honest.totals);
    assert.deepEqual(lying.unscheduled, honest.unscheduled);
    assert.notEqual(lying.narrative, honest.narrative);
    assert.equal(lying.narrativeBy, "hostile");
  });

  it("records which writer produced the text, so a fallback is still visible", async () => {
    const report = await reportFor(fixtureSnapshot());
    assert.equal(report.narrativeBy, "template");
  });
});

describe("resolveNarrative", () => {
  it("uses the template with no key", () => {
    assert.equal(resolveNarrative({}).id, "template");
    assert.equal(resolveNarrative({ ANTHROPIC_API_KEY: "   " }).id, "template");
  });

  it("uses the model when a key is present, honouring an override", () => {
    assert.match(resolveNarrative({ ANTHROPIC_API_KEY: "k" }).id, /^anthropic:/);
    assert.equal(
      resolveNarrative({ ANTHROPIC_API_KEY: "k", RADAR_NARRATIVE_MODEL: "claude-opus-5" }).id,
      "anthropic:claude-opus-5",
    );
  });
});

import { describe, expect, it } from "vitest";
import { type AgentUsage, mergeAgentUsage } from "./shared.ts";

const entry = (overrides: Partial<AgentUsage>): AgentUsage => ({
  agent: "polaris",
  inputTokens: 0,
  outputTokens: 0,
  ...overrides,
});

describe("mergeAgentUsage", () => {
  it("returns undefined when both sides are undefined", () => {
    expect(mergeAgentUsage(undefined, undefined)).toBeUndefined();
  });

  it("returns a copy of b when a is undefined", () => {
    const b = entry({ inputTokens: 10 });
    expect(mergeAgentUsage(undefined, b)).toEqual(b);
  });

  it("returns a copy of a when b is undefined", () => {
    const a = entry({ inputTokens: 10 });
    expect(mergeAgentUsage(a, undefined)).toEqual(a);
  });

  it("sums inputTokens and outputTokens unconditionally", () => {
    const merged = mergeAgentUsage(
      entry({ inputTokens: 10, outputTokens: 5 }),
      entry({ inputTokens: 20, outputTokens: 7 })
    );
    expect(merged?.inputTokens).toBe(30);
    expect(merged?.outputTokens).toBe(12);
  });

  it("keeps cache/cost fields undefined when both sides lack them", () => {
    // this matters so downstream aggregateUsage doesn't persist spurious 0s into the DB
    const merged = mergeAgentUsage(entry({ inputTokens: 10 }), entry({ inputTokens: 20 }));
    expect(merged?.cacheReadTokens).toBeUndefined();
    expect(merged?.cacheWriteTokens).toBeUndefined();
    expect(merged?.costUsd).toBeUndefined();
  });

  it("sums cache and cost fields when either side reports them", () => {
    const merged = mergeAgentUsage(
      entry({ inputTokens: 10, cacheReadTokens: 100, costUsd: 0.01 }),
      entry({ inputTokens: 20, cacheWriteTokens: 50, costUsd: 0.02 })
    );
    expect(merged?.cacheReadTokens).toBe(100);
    expect(merged?.cacheWriteTokens).toBe(50);
    expect(merged?.costUsd).toBeCloseTo(0.03, 10);
  });

  it("preserves the agent id of the left operand", () => {
    // the aggregator is called inside a single agent's run() - the agent label
    // is a fixed property of the harness, not something that can flip mid-run
    const merged = mergeAgentUsage(
      entry({ agent: "claude", inputTokens: 10 }),
      entry({ agent: "something-else", inputTokens: 20 })
    );
    expect(merged?.agent).toBe("claude");
  });

  it("returns a fresh object rather than the input reference", () => {
    // callers treat AgentUsage as immutable; returning the input itself would
    // leak that invariant. mutating the returned value must not affect inputs.
    const a = entry({ inputTokens: 10 });
    const mergedWithUndef = mergeAgentUsage(a, undefined);
    expect(mergedWithUndef).not.toBe(a);
    expect(mergedWithUndef).toEqual(a);

    const b = entry({ inputTokens: 20 });
    const mergedFromUndef = mergeAgentUsage(undefined, b);
    expect(mergedFromUndef).not.toBe(b);
    expect(mergedFromUndef).toEqual(b);
  });
});

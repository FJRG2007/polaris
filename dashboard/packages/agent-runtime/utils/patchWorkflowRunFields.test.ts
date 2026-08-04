import { describe, expect, it } from "vitest";
import type { AgentUsage } from "../agents/shared.ts";
import { aggregateUsage } from "./patchWorkflowRunFields.ts";

const entry = (overrides: Partial<AgentUsage>): AgentUsage => ({
  agent: "polaris",
  inputTokens: 0,
  outputTokens: 0,
  ...overrides,
});

describe("aggregateUsage", () => {
  it("returns empty object for empty input", () => {
    expect(aggregateUsage([])).toEqual({});
  });

  it("drops fields that sum to zero so NULL stays 'not reported'", () => {
    // a run that only recorded input tokens shouldn't write zero into output/cache/cost -
    // those columns stay NULL so dashboards can tell 'zero' from 'never reported'.
    expect(aggregateUsage([entry({ inputTokens: 42 })])).toEqual({ inputTokens: 42 });
  });

  it("sums a single entry with all fields present", () => {
    expect(
      aggregateUsage([
        entry({
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 1000,
          cacheWriteTokens: 200,
          costUsd: 0.12,
        }),
      ])
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      costUsd: 0.12,
    });
  });

  it("sums multiple entries across agents", () => {
    expect(
      aggregateUsage([
        entry({
          agent: "claude",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 1000,
          costUsd: 0.1,
        }),
        entry({
          agent: "polaris",
          inputTokens: 200,
          outputTokens: 80,
          cacheReadTokens: 2000,
          cacheWriteTokens: 300,
          costUsd: 0.25,
        }),
      ])
    ).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 3000,
      cacheWriteTokens: 300,
      // floating-point sum - specifying exact value documents expected precision
      costUsd: 0.35,
    });
  });

  it("treats undefined cache/cost as zero and drops when the sum is still zero", () => {
    expect(
      aggregateUsage([
        entry({ inputTokens: 10, outputTokens: 5 }),
        entry({ inputTokens: 20, outputTokens: 15 }),
      ])
    ).toEqual({ inputTokens: 30, outputTokens: 20 });
  });

  it("clamps individual INT fields at INT4_MAX so partial-persist cannot happen", () => {
    // server-side per-field rejection would silently drop the huge column and
    // keep the small ones, producing a row with a NULL for the missing metric.
    // clamping client-side guarantees the wire payload is self-consistent.
    const result = aggregateUsage([
      entry({ inputTokens: 3_000_000_000, outputTokens: 42, cacheReadTokens: 5 }),
    ]);
    expect(result.inputTokens).toBe(2_147_483_647);
    expect(result.outputTokens).toBe(42);
    expect(result.cacheReadTokens).toBe(5);
  });
});

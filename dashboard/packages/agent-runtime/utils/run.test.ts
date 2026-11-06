import { describe, expect, it } from "vitest";
import type { AgentResult } from "../agents/shared.ts";
import type { ToolState } from "../toolState.ts";
import { requireSubmittedReview } from "./run.ts";

function makeToolState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    repos: new Map([["o/r", { owner: "o", name: "r", dir: "/tmp/r", access: "primary" }]]),
    primaryRepoKey: "o/r",
    progressComment: undefined,
    hadProgressComment: false,
    prepushFailureCount: 0,
    noopReviewSubmissions: 0,
    backgroundProcesses: new Map(),
    usageEntries: [],
    ...overrides,
  };
}

const ok: AgentResult = { success: true, output: "done" };

describe("requireSubmittedReview", () => {
  it("fails a Review run that never submitted a review, even with other writes", () => {
    const result = requireSubmittedReview(
      ok,
      makeToolState({ selectedMode: "Review", wasUpdated: true })
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("the review finished without posting a review on the pull request");
    expect(result.output).toBe("done");
  });

  it("keeps a Review run that submitted a review", () => {
    const toolState = makeToolState({
      selectedMode: "Review",
      review: { id: 1, nodeId: "PRR_1", reviewedSha: "abc" },
    });
    expect(requireSubmittedReview(ok, toolState)).toBe(ok);
  });

  it("leaves IncrementalReview and other modes alone", () => {
    expect(requireSubmittedReview(ok, makeToolState({ selectedMode: "IncrementalReview" }))).toBe(ok);
    expect(requireSubmittedReview(ok, makeToolState({ selectedMode: "Build" }))).toBe(ok);
  });

  it("keeps an earlier failure as it was", () => {
    const failed: AgentResult = { success: false, output: "", error: "refused" };
    expect(requireSubmittedReview(failed, makeToolState({ selectedMode: "Review" }))).toBe(failed);
  });
});

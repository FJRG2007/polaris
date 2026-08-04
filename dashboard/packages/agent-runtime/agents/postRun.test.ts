import { describe, expect, it } from "vitest";
import type { ToolState } from "../toolState.ts";
import { getUnsubmittedReview } from "./postRun.ts";

function makeToolState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    repos: new Map([["o/r", { owner: "o", name: "r", dir: "/tmp/r", access: "primary" }]]),
    primaryRepoKey: "o/r",
    progressComment: undefined,
    hadProgressComment: true,
    prepushFailureCount: 0,
    noopReviewSubmissions: 0,
    backgroundProcesses: new Map(),
    usageEntries: [],
    ...overrides,
  };
}

describe("getUnsubmittedReview", () => {
  it("returns null when mode is not a review mode", () => {
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "Build" }))).toBeNull();
    expect(getUnsubmittedReview(makeToolState())).toBeNull();
  });

  it("returns null when a review was already submitted", () => {
    expect(
      getUnsubmittedReview(
        makeToolState({
          selectedMode: "Review",
          review: { id: 1, nodeId: "n", reviewedSha: undefined },
        })
      )
    ).toBeNull();
  });

  it("fires for Review even when report_progress wrote a final summary", () => {
    // Review's only valid exit is `create_pull_request_review`. a summary
    // comment is not a substitute, and accepting it here previously let
    // subagent-flipped `finalSummaryWritten` silence the gate.
    expect(
      getUnsubmittedReview(makeToolState({ selectedMode: "Review", finalSummaryWritten: true }))
    ).toBe("Review");
  });

  it("returns null for IncrementalReview when report_progress wrote a final summary", () => {
    // IncrementalReview treats `report_progress` as a legitimate
    // "no review warranted" exit, matching the post-failure error message.
    expect(
      getUnsubmittedReview(
        makeToolState({ selectedMode: "IncrementalReview", finalSummaryWritten: true })
      )
    ).toBeNull();
  });

  it("returns null when there is no progress comment to anchor the failure to", () => {
    expect(
      getUnsubmittedReview(makeToolState({ selectedMode: "Review", hadProgressComment: false }))
    ).toBeNull();
  });

  it("returns the selected mode when the gate should fire", () => {
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "Review" }))).toBe("Review");
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "IncrementalReview" }))).toBe(
      "IncrementalReview"
    );
  });
});

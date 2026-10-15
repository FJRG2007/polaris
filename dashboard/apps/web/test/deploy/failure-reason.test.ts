/**
 * Why a deployment did not go live, read back from what was stored.
 *
 * The reason is written once in English and said on screen in the reader's
 * language, so the fixed ones have to be recognised exactly - including rows
 * written before the wording was shared, which carry the same text.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    CANCELED_REASON,
    deployFailureReason,
    NO_REASON,
    RESTARTED_REASON,
    stoppedByHand,
    timedOutReason
} from "@/lib/deploy/failure-reason";

describe("a deploy stopped by hand", () => {
    it("is a cancel with the cancel's reason, not one a deadline stopped", () => {
        expect(stoppedByHand("cancelled", CANCELED_REASON)).toBe(true);
        expect(stoppedByHand("cancelled", timedOutReason(60))).toBe(false);
        expect(stoppedByHand("failed", CANCELED_REASON)).toBe(false);
    });
});

describe("reading a stored deploy reason", () => {
    it("recognises a deploy cut off by a restart, as old rows stored it", () => {
        expect(
            deployFailureReason("failed", "Polaris restarted while this deploy was running")
        ).toEqual({
            kind: "restarted"
        });
        expect(RESTARTED_REASON).toBe("Polaris restarted while this deploy was running");
    });

    it("recognises a cancel and a deadline, with the minutes it ran", () => {
        expect(deployFailureReason("cancelled", CANCELED_REASON)).toEqual({ kind: "canceled" });
        expect(deployFailureReason("cancelled", "Canceled")).toEqual({ kind: "canceled" });
        expect(deployFailureReason("cancelled", timedOutReason(60))).toEqual({
            kind: "timedOut",
            minutes: 60
        });
    });

    it("keeps a builder's own message as it was written", () => {
        expect(deployFailureReason("failed", "npm ci exited with code 1")).toEqual({
            kind: "text",
            text: "npm ci exited with code 1"
        });
    });

    it("still says something for a failure that stored no reason", () => {
        expect(deployFailureReason("failed", null)).toEqual({ kind: "noReason" });
        expect(deployFailureReason("failed", "  ")).toEqual({ kind: "noReason" });
        expect(deployFailureReason("failed", NO_REASON)).toEqual({ kind: "noReason" });
    });

    it("says nothing for a deploy that went live or is still going", () => {
        for (const status of ["running", "queued", "deploying", "stopped", "removed"])
            expect(deployFailureReason(status, "anything")).toBeNull();
        expect(deployFailureReason("rolled_back", null)).toBeNull();
    });
});

describe("the words for it", () => {
    const keys = ["failedTitle", "stoppedTitle", "restarted", "canceled", "timedOut", "noReason"];
    for (const locale of ["en-US", "es-ES"]) {
        it(`exist in ${locale}`, () => {
            const messages = JSON.parse(
                readFileSync(
                    new URL(`../../messages/${locale}/deployService.json`, import.meta.url),
                    "utf8"
                )
            ) as { failure: Record<string, string> };
            for (const key of keys) expect(messages.failure[key]?.length).toBeGreaterThan(0);
            expect(messages.failure.timedOut).toContain("{minutes}");
        });
    }
});

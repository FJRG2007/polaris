/**
 * Ignoring an issue for a while or for a number of events, as Sentry's
 * "ignore until": what an ignore writes, what the bulk action accepts, and
 * when one more event opens an issue again.
 */

import { describe, expect, it } from "vitest";
import { statusColumns } from "@/lib/telemetry/workflow-service";
import { bulkStatusSchema, ignoreColumns, reopenReason } from "@/lib/telemetry/issue-query";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const ISSUE = "0192f0aa-0000-7000-8000-0000000000e1";

const base = { status: "unresolved", resolvedInRelease: null, timesSeen: 4, ignoredUntil: null, ignoreUntilSeen: null };

describe("what an ignore writes", () => {
    it("ends at a time measured from now", () => {
        expect(ignoreColumns({ ignoreFor: "24h" }, 4, NOW)).toEqual({
            ignoredUntil: new Date("2026-11-13T10:00:00.000Z"),
            ignoreUntilSeen: null
        });
    });

    it("ends at a count measured from what it has already seen", () => {
        expect(ignoreColumns({ ignoreCount: 100 }, 4, NOW)).toEqual({ ignoredUntil: null, ignoreUntilSeen: 104 });
    });

    it("with no condition, never ends on its own", () => {
        expect(ignoreColumns(undefined, 4, NOW)).toEqual({ ignoredUntil: null, ignoreUntilSeen: null });
    });

    it("is cleared by any other status", () => {
        expect(statusColumns("ignored", null, "u1", undefined, NOW, { ignoreFor: "1h" }, 0).ignoredUntil).toEqual(
            new Date("2026-11-12T11:00:00.000Z")
        );
        expect(statusColumns("unresolved", null, "u1", undefined, NOW, { ignoreFor: "1h" }, 0)).toEqual(
            expect.objectContaining({ ignoredUntil: null, ignoreUntilSeen: null })
        );
        expect(statusColumns("resolved", "1.0", "u1", "now", NOW, { ignoreCount: 10 }, 3)).toEqual(
            expect.objectContaining({ status: "resolved", ignoredUntil: null, ignoreUntilSeen: null })
        );
    });
});

describe("the bulk status input", () => {
    it("takes the offered windows and counts", () => {
        expect(bulkStatusSchema.safeParse({ issueIds: [ISSUE], status: "ignored", ignoreFor: "7d" }).success).toBe(true);
        expect(bulkStatusSchema.safeParse({ issueIds: [ISSUE], status: "ignored", ignoreCount: 1000 }).success).toBe(
            true
        );
    });

    it("refuses anything else", () => {
        expect(bulkStatusSchema.safeParse({ issueIds: [ISSUE], status: "ignored", ignoreFor: "3y" }).success).toBe(
            false
        );
        expect(bulkStatusSchema.safeParse({ issueIds: [ISSUE], status: "ignored", ignoreCount: 7 }).success).toBe(false);
        expect(bulkStatusSchema.safeParse({ issueIds: [ISSUE], status: "ignored", ignoreCount: 10.5 }).success).toBe(
            false
        );
    });
});

describe("when one more event opens an issue again", () => {
    it("leaves an open issue alone", () => {
        expect(reopenReason(base, "1.0", NOW)).toBeNull();
    });

    it("calls a resolved issue seen in another release a regression", () => {
        expect(reopenReason({ ...base, status: "resolved", resolvedInRelease: "1.0" }, "1.1", NOW)).toBe("regressed");
        expect(reopenReason({ ...base, status: "resolved", resolvedInRelease: "1.0" }, "1.0", NOW)).toBeNull();
        expect(reopenReason({ ...base, status: "resolved" }, null, NOW)).toBe("regressed");
    });

    it("ends an ignore whose time has passed", () => {
        const until = new Date(NOW.getTime() + 1000);
        expect(reopenReason({ ...base, status: "ignored", ignoredUntil: until }, null, NOW)).toBeNull();
        expect(reopenReason({ ...base, status: "ignored", ignoredUntil: until }, null, until)).toBe("unignored");
    });

    it("ends an ignore on the event it was waiting for", () => {
        expect(reopenReason({ ...base, status: "ignored", timesSeen: 8, ignoreUntilSeen: 10 }, null, NOW)).toBeNull();
        expect(reopenReason({ ...base, status: "ignored", timesSeen: 9, ignoreUntilSeen: 10 }, null, NOW)).toBe(
            "unignored"
        );
    });

    it("keeps an ignore with no condition", () => {
        expect(reopenReason({ ...base, status: "ignored", timesSeen: 10_000 }, "2.0", NOW)).toBeNull();
    });
});

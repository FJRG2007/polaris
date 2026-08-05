/**
 * Scheduled deletions are swept lazily, on browse. Browsing is the most frequent
 * thing anybody does in Drive, so the sweep has to cost nothing when there is
 * nothing to do - and it must still run for the connection nobody is looking at,
 * which is the cron's job and never throttled.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The throttle remembers connections for the life of the module, so each test uses
// its own id and primes what it needs: one that leant on another's leftovers would
// pass or fail on the order they happened to run in.
const BROWSED = "018f2b7a-0000-7000-8000-0000000000e1";
const REBROWSED = "018f2b7a-0000-7000-8000-0000000000e2";

const findMany = vi.fn(async () => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        scheduledDeletion: { findMany, deleteMany: vi.fn(async () => ({ count: 0 })), create: vi.fn() }
    }
}));
vi.mock("@/lib/storage-service", () => ({ getDriver: vi.fn() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: vi.fn(async () => undefined) }));

const { sweepDueDeletions } = await import("../../src/lib/scheduled-deletion-service");

describe("scheduled deletion sweep", () => {
    beforeEach(() => {
        findMany.mockClear();
        vi.restoreAllMocks();
    });

    it("queries once for a connection however often it is browsed", async () => {
        await sweepDueDeletions(BROWSED);
        await sweepDueDeletions(BROWSED);
        await sweepDueDeletions(BROWSED);
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("queries again once the interval has passed", async () => {
        const browsedAt = Date.now();
        await sweepDueDeletions(REBROWSED);
        vi.spyOn(Date, "now").mockReturnValue(browsedAt + 61_000);
        await sweepDueDeletions(REBROWSED);
        expect(findMany).toHaveBeenCalledTimes(2);
    });

    it("never throttles the sweep that covers every connection", async () => {
        await sweepDueDeletions();
        await sweepDueDeletions();
        expect(findMany).toHaveBeenCalledTimes(2);
    });

    it("skips a source that cannot have schedules at all", async () => {
        await sweepDueDeletions("container:018f2b7a");
        expect(findMany).not.toHaveBeenCalled();
    });
});

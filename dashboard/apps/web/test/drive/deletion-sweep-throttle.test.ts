/**
 * Scheduled deletions are swept lazily, on browse. Browsing is the most frequent
 * thing anybody does in Drive, so the sweep has to cost nothing when there is
 * nothing to do - and it must still run for the connection nobody is looking at,
 * which is the cron's job and never throttled.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION = "018f2b7a-0000-7000-8000-0000000000e1";

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
        await sweepDueDeletions(CONNECTION);
        await sweepDueDeletions(CONNECTION);
        await sweepDueDeletions(CONNECTION);
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("queries again once the interval has passed", async () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
        await sweepDueDeletions(CONNECTION);
        expect(findMany).toHaveBeenCalledTimes(1);
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

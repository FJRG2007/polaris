/**
 * One runner at a time, across processes.
 *
 * Two web containers overlap during a rollover, and an operator who followed the
 * old advice still has a crontab pointed at the routes. What has to hold is that
 * the second of those does not start a backup the first is already taking - and,
 * just as importantly, that the first one finishing does not release a lease it
 * had already lost, which would hand the job to a third while the second is still
 * inside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    key: string;
    value: string;
}

const rows = new Map<string, Row>();

const create = vi.fn(async ({ data }: { data: Row }) => {
    if (rows.has(data.key)) throw new Error("Unique constraint failed");
    rows.set(data.key, { key: data.key, value: data.value });
    return data;
});

const updateMany = vi.fn(
    async ({
        where,
        data
    }: {
        where: { key: string; value?: string | { lt: string } };
        data: { value: string };
    }) => {
        const row = rows.get(where.key);
        if (!row) return { count: 0 };
        const wanted = where.value;
        if (typeof wanted === "string" && row.value !== wanted) return { count: 0 };
        if (typeof wanted === "object" && wanted !== null && !(row.value < wanted.lt)) return { count: 0 };
        row.value = data.value;
        return { count: 1 };
    }
);

vi.mock("@polaris/db", () => ({ prisma: { setting: { create, updateMany } } }));

const { withLease } = await import("../../src/lib/cron/lease");

/** What a second process would see: the same helper, against the same rows. */
const other = withLease;

describe("holding a job against another process", () => {
    beforeEach(() => {
        rows.clear();
        vi.clearAllMocks();
    });

    it("runs the work and reports what it returned", async () => {
        const done = await withLease("backups", 60_000, async () => "swept");
        expect(done).toBe("swept");
    });

    it("refuses a second runner while the first is inside it", async () => {
        let secondRan = false;
        await withLease("backups", 60_000, async () => {
            const blocked = await other("backups", 60_000, async () => {
                secondRan = true;
                return "also swept";
            });
            expect(blocked).toBeNull();
        });
        expect(secondRan).toBe(false);
    });

    it("lets the next runner straight in once the first is done", async () => {
        await withLease("backups", 60_000, async () => "first");
        const second = await withLease("backups", 60_000, async () => "second");
        expect(second).toBe("second");
    });

    it("takes over a lease left behind by a process that died", async () => {
        // A holder that never released: the row is there, its expiry is not.
        rows.set("cron.lease.backups", {
            key: "cron.lease.backups",
            value: "1999-01-01T00:00:00.000Z abandoned"
        });
        const taken = await withLease("backups", 60_000, async () => "took over");
        expect(taken).toBe("took over");
    });

    it("releases the lease even when the work throws", async () => {
        await expect(
            withLease("backups", 60_000, async () => {
                throw new Error("the archive failed");
            })
        ).rejects.toThrow("the archive failed");

        const after = await withLease("backups", 60_000, async () => "next pass");
        expect(after).toBe("next pass");
    });

    it("does not release a lease it has already lost", async () => {
        // The first runner's lease expires mid-job and a second takes it over.
        // When the first finally finishes it must leave the second's lease alone,
        // or a third would walk straight into work already in progress.
        let asTheSecondLeftIt = "";
        const slow = withLease("backups", -1, async () => {
            const takenOver = await other("backups", 60_000, async () => "took over mid-job");
            expect(takenOver).toBe("took over mid-job");
            asTheSecondLeftIt = rows.get("cron.lease.backups")?.value ?? "";
            return "finished late";
        });
        await expect(slow).resolves.toBe("finished late");

        // The first runner's release found a value that was not its own and did
        // nothing, which is the whole point of the token.
        expect(rows.get("cron.lease.backups")?.value).toBe(asTheSecondLeftIt);
    });

    it("keeps one job's lease clear of another's", async () => {
        await withLease("backups", 60_000, async () => {
            const reminders = await other("task-reminders", 60_000, async () => "sent");
            expect(reminders).toBe("sent");
        });
    });
});

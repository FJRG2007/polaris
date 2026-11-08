/**
 * A repeated alert folds into the row already on the bell.
 *
 * The bell once took fifty copies of "Every camera at Home stopped answering",
 * one a minute. These pin the write itself: a repeat inside the window bumps the
 * count of the existing row rather than adding one, two processes racing end in
 * one row, a key outside the window starts a new row, and past the burst ceiling
 * new alerts of one event land on a single summary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    type: string;
    title: string;
    dedupKey: string | null;
    firstSeenAt: Date | null;
    repeatCount: number;
    createdAt: Date;
}

let rows: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.type !== undefined && row.type !== where.type) return false;
    if (where.dedupKey !== undefined && row.dedupKey !== where.dedupKey) return false;
    const first = where.firstSeenAt as { gte: Date } | undefined;
    if (first && !(row.firstSeenAt && row.firstSeenAt >= first.gte)) return false;
    const created = where.createdAt as { gte: Date } | undefined;
    if (created && !(row.createdAt >= created.gte)) return false;
    return true;
}

/** Yields between the read and the write, so racing callers really interleave. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

vi.mock("@polaris/db", () => ({
    prisma: {
        notification: {
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                await tick();
                const hit = rows.filter((row) => matches(row, where));
                for (const row of hit) {
                    if ("dedupKey" in data) row.dedupKey = data.dedupKey as string | null;
                    if (data.repeatCount) row.repeatCount += 1;
                    if (data.createdAt) row.createdAt = data.createdAt as Date;
                    if (typeof data.title === "string") row.title = data.title;
                }
                return { count: hit.length };
            },
            create: async ({ data }: { data: Row }) => {
                await tick();
                if (
                    data.dedupKey &&
                    rows.some((row) => row.userId === data.userId && row.dedupKey === data.dedupKey)
                )
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                const row = {
                    ...data,
                    id: `n${rows.length}`,
                    dedupKey: data.dedupKey ?? null,
                    firstSeenAt: data.firstSeenAt ?? null,
                    repeatCount: data.repeatCount ?? 1,
                    createdAt: new Date()
                };
                rows.push(row);
                return row;
            },
            count: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
                const n = rows.filter((row) => matches(row, where)).length;
                return take === undefined ? n : Math.min(n, take);
            }
        }
    }
}));

const { createNotification } = await import("../../src/lib/notification-service");

const HOUR = 60 * 60 * 1000;

function alert(title = "Every camera at Home stopped answering", key = "places:home") {
    return {
        userId: "owner",
        type: "places.offline",
        title,
        dedupKey: key,
        repeat: {
            windowMs: HOUR,
            burst: {
                limit: 3,
                windowMs: 10 * 60 * 1000,
                summary: async () => ({ title: "More alerts like this", body: title })
            }
        }
    };
}

beforeEach(() => {
    rows = [];
});

describe("a repeat inside the window", () => {
    it("folds into one row however many times it is raised", async () => {
        expect(await createNotification(alert())).toBe("created");
        for (let i = 0; i < 49; i += 1) expect(await createNotification(alert())).toBe("collapsed");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.repeatCount).toBe(50);
    });

    it("ends in one row when two processes raise it at once", async () => {
        const outcomes = await Promise.all([createNotification(alert()), createNotification(alert())]);

        expect(outcomes.sort()).toEqual(["collapsed", "created"]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.repeatCount).toBe(2);
    });
});

describe("a repeat after the window", () => {
    it("is a new row, and the old one gives its key up", async () => {
        await createNotification(alert());
        const old = rows[0];
        if (old) old.firstSeenAt = new Date(Date.now() - 2 * HOUR);

        expect(await createNotification(alert())).toBe("created");
        expect(rows).toHaveLength(2);
        expect(rows[0]?.dedupKey).toBeNull();
        expect(rows[1]?.dedupKey).toBe("places:home");
    });
});

describe("a burst of different alerts of one event", () => {
    it("lands past the ceiling on one summary row", async () => {
        for (let i = 0; i < 3; i += 1)
            expect(await createNotification(alert(`Camera ${i}`, `k${i}`))).toBe("created");
        expect(await createNotification(alert("Camera 3", "k3"))).toBe("held");
        expect(await createNotification(alert("Camera 4", "k4"))).toBe("held");

        expect(rows).toHaveLength(4);
        const summary = rows.find((row) => row.dedupKey === "burst:places.offline");
        expect(summary?.title).toBe("More alerts like this");
        expect(summary?.repeatCount).toBe(2);
    });

    it("never holds an alert with no ceiling (a critical event)", async () => {
        for (let i = 0; i < 6; i += 1) {
            const input = { ...alert(`Sign-in ${i}`, `s${i}`), repeat: { windowMs: HOUR } };
            expect(await createNotification(input)).toBe("created");
        }
        expect(rows).toHaveLength(6);
    });
});

describe("an alert with no key", () => {
    it("is written as it always was", async () => {
        await createNotification({ userId: "owner", type: "x", title: "One" });
        await createNotification({ userId: "owner", type: "x", title: "One" });
        expect(rows).toHaveLength(2);
    });
});

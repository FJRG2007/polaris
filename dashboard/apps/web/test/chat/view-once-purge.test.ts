/**
 * A view-once file nobody can open any more leaves no bytes behind: after the
 * last member's look in a direct message or a group, or after its wait.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
    id: string;
    viewOnce: boolean;
    path: string;
    posterPath: string | null;
    connectionId: string | null;
    posterConnectionId: string | null;
    createdAt: Date;
};

const rows = new Map<string, Row>();
const opens: { attachmentId: string; userId: string }[] = [];
const members: { channelId: string; userId: string }[] = [];
const kinds = new Map<string, string>();
const removed: string[] = [];
const kept: string[] = [];

const matches = (row: Row, where: Record<string, unknown>) => {
    const ids = (where.id as { in?: string[] } | undefined)?.in;
    if (ids && !ids.includes(row.id)) return false;
    if (where.viewOnce !== undefined && row.viewOnce !== where.viewOnce) return false;
    const notPath = (where.path as { not?: string } | undefined)?.not;
    if (notPath !== undefined && row.path === notPath) return false;
    const created = where.createdAt as { gte: Date; lt: Date } | undefined;
    if (created && (row.createdAt < created.gte || row.createdAt >= created.lt)) return false;
    return true;
};

vi.mock("@/lib/chat/attachments", () => ({
    removeStoredFiles: async (files: { path: string }[]) => {
        removed.push(...files.map((file) => file.path));
    }
}));
vi.mock("@/lib/chat/report-files", () => ({
    keepForReports: async (ids: string[]) => {
        kept.push(...ids);
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret-test-secret-test-secret" }) }));
vi.mock("@polaris/db", () => ({
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    prisma: {
        chatAttachment: {
            findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
                [...rows.values()].filter((row) => matches(row, where)).slice(0, take ?? Infinity),
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
                for (const row of rows.values()) if (matches(row, where)) Object.assign(row, data);
                return {};
            }
        },
        chatChannel: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                kinds.has(where.id) ? { kind: kinds.get(where.id) } : null
        },
        chatAttachmentOpen: {
            findMany: async ({ where }: { where: { attachmentId: string } }) =>
                opens.filter((open) => open.attachmentId === where.attachmentId)
        },
        chatChannelMember: {
            count: async ({ where }: { where: { channelId: string; userId: { notIn: string[] } } }) =>
                members.filter(
                    (member) => member.channelId === where.channelId && !where.userId.notIn.includes(member.userId)
                ).length
        }
    }
}));

const once = await import("@/lib/chat/view-once");

const NOW = new Date("2026-11-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function stored(id: string, ageDays = 0): Row {
    const row: Row = {
        id,
        viewOnce: true,
        path: `c1/${id}.jpg`,
        posterPath: null,
        connectionId: null,
        posterConnectionId: null,
        createdAt: new Date(NOW.getTime() - ageDays * DAY)
    };
    rows.set(id, row);
    return row;
}

const file = (id: string, channelId = "c1") =>
    ({
        id,
        name: "a.jpg",
        contentType: "image/jpeg",
        connectionId: null,
        path: `c1/${id}.jpg`,
        viewSeconds: 10,
        message: { id: "m1", channelId, authorId: "sender" }
    }) as const;

beforeEach(() => {
    rows.clear();
    opens.length = 0;
    members.length = 0;
    kinds.clear();
    removed.length = 0;
    kept.length = 0;
});

describe("after the last look", () => {
    it("keeps the bytes while a member of the group has not opened it", async () => {
        stored("a");
        kinds.set("c1", "group");
        members.push({ channelId: "c1", userId: "sender" }, { channelId: "c1", userId: "ana" }, { channelId: "c1", userId: "bo" });
        opens.push({ attachmentId: "a", userId: "ana" });
        expect(await once.purgeIfSpent(file("a"))).toBe(false);
        expect(rows.get("a")?.path).toBe("c1/a.jpg");
        expect(removed).toEqual([]);
    });

    it("removes them once everyone but the sender has, and marks the row spent", async () => {
        stored("a").posterPath = "c1/a.poster.jpg";
        kinds.set("c1", "dm");
        members.push({ channelId: "c1", userId: "sender" }, { channelId: "c1", userId: "ana" });
        opens.push({ attachmentId: "a", userId: "ana" });
        expect(await once.purgeIfSpent(file("a"))).toBe(true);
        expect(rows.get("a")).toMatchObject({ path: once.VIEW_ONCE_SPENT, posterPath: null });
        expect(removed.sort()).toEqual(["c1/a.jpg", "c1/a.poster.jpg"]);
        // A report holding it keeps its own copy first.
        expect(kept).toEqual(["a"]);
        expect(once.viewOnceSpent(rows.get("a")!.path)).toBe(true);
    });

    it("leaves a space's channel to the sweep, having no fixed list of readers", async () => {
        stored("a");
        kinds.set("c1", "text");
        expect(await once.purgeIfSpent(file("a"))).toBe(false);
        expect(removed).toEqual([]);
    });

    it("does nothing the second time", async () => {
        stored("a");
        expect(await once.purgeViewOnce(["a"])).toBe(1);
        expect(await once.purgeViewOnce(["a"])).toBe(0);
        expect(removed).toEqual(["c1/a.jpg"]);
    });
});

describe("the sweep", () => {
    it("purges what is past its wait and nothing newer", async () => {
        stored("old", 15);
        stored("fresh", 3);
        expect(await once.sweepViewOnce(NOW)).toBe(1);
        expect(rows.get("old")?.path).toBe(once.VIEW_ONCE_SPENT);
        expect(rows.get("fresh")?.path).toBe("c1/fresh.jpg");
    });

    it("works through more than one batch", async () => {
        for (let i = 0; i < 250; i++) stored(`f${i}`, 20);
        expect(await once.sweepViewOnce(NOW)).toBe(250);
        expect(removed).toHaveLength(250);
    });
});

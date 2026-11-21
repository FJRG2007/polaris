/**
 * The recent messages a report of a conversation or a person carries.
 *
 * Only what the reporter can read: nothing from a conversation they cannot
 * reach, nothing shown to one other reader, nothing before their floor - the
 * query is asserted to carry each of those - and a stored list read back is
 * nothing rather than an error when it is not what was written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let reachable = true;
let rows: Array<Record<string, unknown>> = [];
const asked: Array<Record<string, unknown>> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findMany: vi.fn(async (query: Record<string, unknown>) => {
                asked.push(query);
                return rows;
            })
        },
        user: { findMany: vi.fn(async () => [{ id: "ada", name: "Ada" }]) }
    }
}));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: vi.fn(async () => (reachable ? { channelId: "c1" } : null))
}));
vi.mock("@/lib/chat/history-visibility", () => ({
    readableSince: vi.fn(async () => new Date("2026-01-01T00:00:00Z")),
    sinceClause: vi.fn(() => ({ floor: "reader" }))
}));
vi.mock("@/components/rich-text/excerpt", () => ({
    plainExcerpt: (body: string, length: number) => body.slice(0, length)
}));

const { REPORT_CONTEXT, readReportContext, recentReadable } = await import(
    "@/lib/chat/report-context"
);

beforeEach(() => {
    reachable = true;
    asked.length = 0;
    rows = [
        { authorId: "ada", authorLabel: null, body: "second", createdAt: new Date("2026-02-02") },
        { authorId: null, authorLabel: "Webhook", body: "first", createdAt: new Date("2026-02-01") }
    ];
});

describe("what a report carries", () => {
    it("is nothing from a conversation the reporter cannot reach", async () => {
        reachable = false;
        expect(await recentReadable({ id: "grace" }, "c1")).toEqual([]);
        expect(asked).toHaveLength(0);
    });

    it("asks only for what the reporter can read, at most five, oldest first", async () => {
        const found = await recentReadable({ id: "grace" }, "c1");
        expect(found.map((entry) => entry.excerpt)).toEqual(["first", "second"]);
        expect(found.map((entry) => entry.authorName)).toEqual(["Webhook", "Ada"]);
        const where = asked[0]!.where as Record<string, unknown>;
        expect(where).toMatchObject({
            channelId: "c1",
            parentId: null,
            deletedAt: null,
            audience: { isEmpty: true },
            AND: [{ floor: "reader" }]
        });
        expect(where).not.toHaveProperty("authorId");
        expect(asked[0]!.take).toBe(REPORT_CONTEXT);
    });

    it("narrows to one person when a person is reported", async () => {
        await recentReadable({ id: "grace" }, "c1", "ada");
        expect((asked[0]!.where as Record<string, unknown>).authorId).toBe("ada");
    });

    it("reads a stored list back, and anything else as nothing", () => {
        const entry = { authorId: "ada", authorName: "Ada", excerpt: "hi", sentAt: "2026-02-02" };
        expect(readReportContext([entry])).toEqual([entry]);
        expect(readReportContext([])).toEqual([]);
        expect(readReportContext(null)).toEqual([]);
        expect(readReportContext([{ excerpt: 4 }])).toEqual([]);
        expect(readReportContext(Array(REPORT_CONTEXT + 1).fill(entry))).toEqual([]);
    });
});

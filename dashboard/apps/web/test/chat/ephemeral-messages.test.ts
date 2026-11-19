/**
 * Ephemeral messages: seen in the conversation only by their audience, and
 * never by what speaks for the conversation - unread, search, toasts, the
 * rail's last line - nor woken on anybody else's screen by a live frame.
 *
 * The where clauses are run against rows with a small matcher for the parts
 * that decide visibility, so the test reads what the queries would return.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "0190a1b2-0000-7000-8000-000000000001";
const OTHER = "0190a1b2-0000-7000-8000-000000000002";

const rawQueries: string[] = [];
const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
let row: { channelId: string; audience: string[] } | null;
let executed: number;

vi.mock("@polaris/db", () => ({
    Prisma: {},
    prisma: {
        $queryRaw: async (strings: TemplateStringsArray) => {
            rawQueries.push(strings.join("?"));
            return [];
        },
        $executeRaw: async () => executed,
        chatMessage: {
            findFirst: async () => row,
            updateMany: async (args: { where: { audience: { equals: string[] } }; data: Record<string, unknown> }) => {
                updates.push(args as never);
                const sole = row && row.audience.length === 1 && row.audience[0] === args.where.audience.equals[0];
                return { count: sole ? 1 : 0 };
            }
        }
    }
}));

const history = await import("@/lib/chat/history-visibility");
const ephemeral = await import("@/lib/chat/ephemeral");
const { lastMessages } = await import("@/lib/chat/last-messages");

interface Row {
    id: string;
    audience: string[];
}
const rows: Row[] = [
    { id: "everyone", audience: [] },
    { id: "mine", audience: [ME] },
    { id: "theirs", audience: [OTHER] },
    { id: "both", audience: [ME, OTHER] }
];

/** The visibility parts of a Prisma where clause, run against one row; anything else holds. */
function matches(where: any, one: Row): boolean {
    if (!where || typeof where !== "object") return true;
    return Object.entries(where).every(([key, value]: [string, any]) => {
        if (key === "AND") return (value as unknown[]).every((part) => matches(part, one));
        if (key === "OR") return (value as unknown[]).some((part) => matches(part, one));
        if (key === "audience") {
            if ("isEmpty" in value) return (one.audience.length === 0) === value.isEmpty;
            if ("has" in value) return one.audience.includes(value.has);
        }
        return true;
    });
}
const seen = (where: unknown) => rows.filter((one) => matches(where, one)).map((one) => one.id);

beforeEach(() => {
    rawQueries.length = 0;
    updates.length = 0;
    row = null;
    executed = 0;
});

describe("the conversation itself (a page, a thread, what changed)", () => {
    it("shows an ephemeral message to its audience and to nobody else", () => {
        expect(seen(history.sinceClause(null, ME))).toEqual(["everyone", "mine", "both"]);
        expect(seen(history.sinceClause(null, OTHER))).toEqual(["everyone", "theirs", "both"]);
    });

    it("shows none without a reader", () => {
        expect(seen(history.sinceClause(null))).toEqual(["everyone"]);
    });
});

describe("what speaks for the conversation (unread counts, search, toasts)", () => {
    it("never counts an ephemeral message, not even for the one it is for", () => {
        expect(seen(history.readableWhere(new Map(), ME))).toEqual(["everyone"]);
        expect(seen(history.readableWhere(new Map([["c1", new Date(0)]]), OTHER))).toEqual(["everyone"]);
    });

    it("leaves it out of the rail's last line", async () => {
        await lastMessages(ME, ["0190a1b2-0000-7000-8000-0000000000c1"]);
        expect(rawQueries).toHaveLength(1);
        expect(rawQueries[0]).toContain('cardinality("audience") = 0');
    });
});

describe("a live frame", () => {
    it("about an ephemeral message wakes only its audience", () => {
        const frame = { kind: "posted", audience: [ME] };
        expect(ephemeral.frameReaches(frame, ME)).toBe(true);
        expect(ephemeral.frameReaches(frame, OTHER)).toBe(false);
    });

    it("about anything else reaches everybody it did before", () => {
        expect(ephemeral.frameReaches({ kind: "posted" }, OTHER)).toBe(true);
        // A call's audience is the call's business, decided where it was.
        expect(ephemeral.frameReaches({ kind: "call", audience: [ME] }, OTHER)).toBe(true);
    });
});

describe("one message", () => {
    it("is seen by its audience only", () => {
        expect(ephemeral.seesMessage([], OTHER)).toBe(true);
        expect(ephemeral.seesMessage(null, OTHER)).toBe(true);
        expect(ephemeral.seesMessage([ME], ME)).toBe(true);
        expect(ephemeral.seesMessage([ME], OTHER)).toBe(false);
    });

    it("goes within a day, or sooner when the conversation's timer says so", () => {
        const now = new Date("2026-11-19T10:00:00Z");
        expect(ephemeral.ephemeralExpiry(now, null).getTime() - now.getTime()).toBe(ephemeral.EPHEMERAL_LIFETIME_MS);
        const soon = new Date("2026-11-19T10:05:00Z");
        expect(ephemeral.ephemeralExpiry(now, soon)).toEqual(soon);
    });
});

describe("Dismiss", () => {
    it("ends a message only its reader could see", async () => {
        row = { channelId: "c1", audience: [ME] };
        expect(await ephemeral.dismissEphemeral(ME, "m1")).toEqual({ channelId: "c1", audience: [ME] });
        expect(updates[0]?.data.expiresAt).toBeInstanceOf(Date);
    });

    it("takes only the reader off a shared one, never leaving it for everybody", async () => {
        row = { channelId: "c1", audience: [ME, OTHER] };
        executed = 1;
        expect(await ephemeral.dismissEphemeral(ME, "m1")).toEqual({ channelId: "c1", audience: [ME] });
        expect(updates.every((update) => !("audience" in update.data))).toBe(true);
    });

    it("does nothing for somebody it was not for", async () => {
        row = null;
        expect(await ephemeral.dismissEphemeral(OTHER, "m1")).toBeNull();
        expect(updates).toHaveLength(0);
    });
});

/**
 * The reads that grow with a space are bounded in the database: unread stops
 * one row past the badge's cap for every channel, opened or not; a member list
 * is a page with a cursor and a capped count; and a page of the room for the
 * MLS handler is a keyset read, not the whole roster sliced in memory.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const READER = "00000000-0000-4000-8000-000000000001";
const SPACE = "00000000-0000-4000-8000-0000000000aa";
const CHANNEL = "00000000-0000-4000-8000-0000000000cc";

type Query = { where?: Record<string, unknown>; take?: number; cursor?: unknown; skip?: number };

const state = vi.hoisted(() => ({
    calls: [] as { model: string; method: string; query: Query }[],
    /** How many messages each channel holds, unbounded. */
    history: new Map<string, number>(),
    members: [] as string[]
}));

vi.mock("@polaris/db", () => {
    const model = (name: string) =>
        new Proxy(
            {},
            {
                get: (_, method: string) => async (query: Query = {}) => {
                    state.calls.push({ model: name, method, query });
                    if (name === "chatMessage" && method === "findMany") {
                        const channelId = query.where?.channelId as string;
                        const held = state.history.get(channelId) ?? 0;
                        const shown = Math.min(held, query.take ?? held);
                        return Array.from({ length: shown }, (_, n) => ({ id: `${channelId}-${n}` }));
                    }
                    if (name === "chatSpace" && method === "findUnique") {
                        return { ownerId: READER, owner: { name: "Owner" }, orgId: null, visibility: "private" };
                    }
                    if (name === "chatChannel" && method === "findUnique") {
                        return {
                            id: CHANNEL,
                            kind: "text",
                            spaceId: SPACE,
                            ownerId: null,
                            createdById: null,
                            private: false,
                            archived: false,
                            membersMaySend: true,
                            space: { archived: false }
                        };
                    }
                    if ((name === "chatSpaceMember" || name === "chatChannelMember") && method === "findMany") {
                        const gt = (query.where?.userId as { gt?: string } | undefined)?.gt;
                        const rows = [...state.members].sort().filter((id) => !gt || id > gt);
                        return rows.slice(0, query.take ?? rows.length).map((userId) => ({
                            id: userId,
                            userId,
                            role: "member",
                            user: { name: userId }
                        }));
                    }
                    if (method === "count") return Math.min(state.members.length, query.take ?? Infinity);
                    if (method === "findMany" || method === "groupBy") return [];
                    return null;
                }
            }
        );
    const prisma = new Proxy({}, { get: (_, name: string) => model(name) });
    return { prisma };
});

import { inBatches } from "@/lib/chat/bounded";
import * as chat from "@/lib/chat/chat-service";
import { conversationAudiencePage } from "@/lib/chat/access";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

beforeEach(() => {
    state.calls = [];
    state.history = new Map();
    state.members = [];
});

describe("unread", () => {
    it("reads at most UNREAD_LIMIT rows per channel, even for one never opened", async () => {
        state.history.set("never-opened", 1_000_000);
        state.history.set("opened", 3);
        const counts = await chat.unreadCounts(
            { id: READER, isAdmin: false },
            [{ id: "never-opened" }, { id: "opened" }],
            new Map([["opened", { lastReadAt: new Date(0) }]])
        );
        const reads = state.calls.filter((call) => call.model === "chatMessage");
        expect(reads.every((call) => call.method === "findMany")).toBe(true);
        expect(reads.every((call) => call.query.take === chat.UNREAD_LIMIT)).toBe(true);
        expect(chat.UNREAD_LIMIT).toBe(100);
        expect(counts.get("never-opened")).toBe(99);
        expect(counts.get("opened")).toBe(3);
    });

    it("never runs a COUNT or group-by over the history", async () => {
        state.history.set("c", 5);
        await chat.unreadCounts({ id: READER, isAdmin: false }, [{ id: "c" }], new Map());
        expect(
            state.calls.some(
                (call) => call.model === "chatMessage" && (call.method === "count" || call.method === "groupBy")
            )
        ).toBe(false);
    });
});

describe("member list", () => {
    it("is a page with a cursor and a capped count, never the whole space", async () => {
        state.members = Array.from({ length: 450 }, (_, n) => id(n + 2));
        const first = await chat.listSpaceMembersPage({ id: READER, isAdmin: false }, SPACE);
        const read = state.calls.find((call) => call.model === "chatSpaceMember" && call.method === "findMany");
        expect(read?.query.take).toBe(chat.MEMBER_PAGE);
        const counted = state.calls.find((call) => call.model === "chatSpaceMember" && call.method === "count");
        expect(counted?.query.take).toBe(chat.MEMBER_COUNT_CAP);
        // The owner leads the first page, then a page of rows.
        expect(first.members).toHaveLength(chat.MEMBER_PAGE + 1);
        expect(first.next).not.toBeNull();
        expect(first.total).toBe(451);

        state.calls = [];
        await chat.listSpaceMembersPage({ id: READER, isAdmin: false }, SPACE, first.next);
        const paged = state.calls.find((call) => call.model === "chatSpaceMember" && call.method === "findMany");
        expect(paged?.query.cursor).toEqual({ id: first.next });
        expect(paged?.query.skip).toBe(1);
    });

    it("ignores a cursor that is not an id rather than passing it to the database", async () => {
        state.members = [id(2)];
        await chat.listSpaceMembersPage({ id: READER, isAdmin: false }, SPACE, "not-an-id");
        const read = state.calls.find((call) => call.model === "chatSpaceMember" && call.method === "findMany");
        expect(read?.query.cursor).toBeUndefined();
    });
});

describe("audience page", () => {
    it("is a keyset read in the database with a take", async () => {
        state.members = Array.from({ length: 30 }, (_, n) => id(n + 2));
        const page = await conversationAudiencePage({ id: READER }, CHANNEL, id(10), 5);
        expect(page).toEqual([id(11), id(12), id(13), id(14), id(15)]);
        const reads = state.calls.filter(
            (call) => (call.model === "chatSpaceMember" || call.model === "chatChannelMember") && call.method === "findMany"
        );
        expect(reads.length).toBeGreaterThan(0);
        for (const call of reads) {
            expect(call.query.take).toBe(5);
            expect(call.query.where).toHaveProperty("userId.gt", id(10));
        }
    });
});

describe("inBatches", () => {
    it("never runs more than the cap at once and keeps the order", async () => {
        let inFlight = 0;
        let peak = 0;
        const out = await inBatches(
            Array.from({ length: 50 }, (_, n) => n),
            4,
            async (n) => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 0));
                inFlight--;
                return n * 2;
            }
        );
        expect(peak).toBe(4);
        expect(out).toEqual(Array.from({ length: 50 }, (_, n) => n * 2));
    });
});

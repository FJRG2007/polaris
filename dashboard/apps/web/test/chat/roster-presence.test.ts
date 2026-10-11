/**
 * The member list arrives with who is around, read beside the names.
 *
 * Read through the same privacy rule the faces use, in bounded batches, and once:
 * the counts in the headings are about everybody, so the browser must not have
 * to ask about every member a second time to draw them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    members: [] as { userId: string; name: string; role: string }[],
    statuses: new Map<string, string>(),
    batches: [] as number[],
    viewers: [] as unknown[]
}));

vi.mock("@/lib/chat/chat-service", () => ({
    listChannelMembers: async () => state.members
}));
vi.mock("@/lib/presence-service", () => ({
    presenceFor: async (viewer: unknown, ids: readonly string[]) => {
        state.batches.push(ids.length);
        state.viewers.push(viewer);
        return new Map(
            ids.map((id) => [id, { status: state.statuses.get(id) ?? "offline", note: "" }])
        );
    }
}));

import { listChannelRoster } from "@/lib/chat/roster";

const VIEWER = { id: "ada", isAdmin: false };

beforeEach(() => {
    state.batches = [];
    state.viewers = [];
    state.statuses = new Map();
});

describe("reading a member list with presence", () => {
    it("marks away and do-not-disturb as around, and offline or hidden as not", async () => {
        state.members = ["a", "b", "c", "d"].map((id) => ({
            userId: id,
            name: id,
            role: "member"
        }));
        state.statuses = new Map([
            ["a", "online"],
            ["b", "idle"],
            ["c", "busy"]
        ]);
        const roster = await listChannelRoster(VIEWER, "c1");
        expect(roster.map((member) => [member.userId, member.online])).toEqual([
            ["a", true],
            ["b", true],
            ["c", true],
            ["d", false]
        ]);
        expect(state.viewers).toEqual([VIEWER]);
    });

    it("asks about a large space in bounded batches, each member once", async () => {
        state.members = Array.from({ length: 1201 }, (_, index) => ({
            userId: `u${index}`,
            name: `u${index}`,
            role: "member"
        }));
        const roster = await listChannelRoster(VIEWER, "c1");
        expect(roster).toHaveLength(1201);
        expect(state.batches).toEqual([500, 500, 201]);
    });

    it("asks nothing for an empty list", async () => {
        state.members = [];
        expect(await listChannelRoster(VIEWER, "c1")).toEqual([]);
        expect(state.batches).toEqual([]);
    });
});

/**
 * Who can be messaged at all.
 *
 * The rule is small and the reason it matters is not: somebody whose chat has
 * been switched off has no screen a message could arrive on, so putting them in
 * a conversation would be a room where one person is spoken to and never hears
 * it - and the person speaking would have no way to find out.
 *
 * The picker leaves them out, and the write refuses them. The second is the one
 * asserted hardest, because the first is a convenience and this is the check.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let withChat = new Set<string>(["ada", "grace"]);

vi.mock("@polaris/auth", () => ({
    can: async (userId: string, permission: string) =>
        permission === "chat.use" && withChat.has(userId)
}));

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSpace: { findUnique: async () => null, findMany: async () => [] },
        chatSpaceMember: { findUnique: async () => null },
        chatChannel: { findUnique: async () => null, findMany: async () => [] },
        chatChannelMember: { findUnique: async () => null, findMany: async () => [] }
    }
}));

const access = await import("../../src/lib/chat/access");

beforeEach(() => {
    withChat = new Set(["ada", "grace"]);
});

describe("who can be messaged", () => {
    it("keeps whoever holds the chat", async () => {
        const allowed = await access.messageable(["ada", "grace"]);
        expect([...allowed].sort()).toEqual(["ada", "grace"]);
    });

    it("leaves out somebody whose chat is switched off", async () => {
        const allowed = await access.messageable(["ada", "turing"]);
        expect(allowed.has("ada")).toBe(true);
        expect(allowed.has("turing")).toBe(false);
    });

    it("answers nothing for nobody, without asking", async () => {
        expect((await access.messageable([])).size).toBe(0);
    });

    it("asks once per account however many times it is named", async () => {
        const allowed = await access.messageable(["ada", "ada", "ada"]);
        expect([...allowed]).toEqual(["ada"]);
    });

    it("follows the capability rather than a stored flag", async () => {
        expect((await access.messageable(["turing"])).size).toBe(0);
        // What switching it on from the admin profile does.
        withChat.add("turing");
        expect((await access.messageable(["turing"])).has("turing")).toBe(true);
    });
});

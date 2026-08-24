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

vi.mock("@/lib/rich-text/mention-service", () => ({ like: (term: string) => ({ contains: term }) }));

/** Who has hidden themselves, and from whom. Everybody else is on the default,
 *  which is findable. */
let hidden = new Set<string>();

vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async (_viewer: { id: string }, userIds: readonly string[]) =>
        new Set(userIds.filter((id) => !hidden.has(id)))
}));

/** Everybody on this pretend instance. The point of the search test is that the
 *  query is over accounts and not over who shares a Tasks space with whom, so
 *  none of these share anything. */
const accounts = [
    { id: "ada", name: "Ada Lovelace", email: "ada@example.com", username: "ada", bannedAt: null },
    { id: "grace", name: "Grace Hopper", email: "grace@example.com", username: "g1203", bannedAt: null },
    { id: "turing", name: "Alan Turing", email: "alan@example.com", username: "alan", bannedAt: null },
    { id: "gone", name: "Banned Person", email: "gone@example.com", username: "gone", bannedAt: new Date() }
];

/** Just enough of the query this test cares about: the exclusions in the `where`
 *  and a "contains" over the three identity columns. */
function findUsers({ where }: { where: Record<string, unknown> }) {
    const not = (where.id as { not?: string } | undefined)?.not;
    const term = ((where.OR as { name?: { contains: string } }[] | undefined)?.[0]?.name?.contains ?? "")
        .toLowerCase();
    return accounts.filter((person) => {
        if (person.id === not) return false;
        if (where.bannedAt === null && person.bannedAt !== null) return false;
        if (!term) return true;
        return [person.name, person.email, person.username].some((field) =>
            field.toLowerCase().includes(term)
        );
    });
}

vi.mock("@polaris/db", () => ({
    // The filter every screen hides a suspended or switched-off account with.
    // A constant rather than a stub: it is the real value, and a test that
    // invented its own would be checking a different rule than the code runs.
    VISIBLE_USER: { bannedAt: null, disabledAt: null },
    prisma: {
        // Nobody has blocked anybody here; blocking has its own test.
        userBlock: { findMany: async () => [] },
        user: { findMany: async (args: { where: Record<string, unknown> }) => findUsers(args) },
        chatSpace: { findUnique: async () => null, findMany: async () => [] },
        chatSpaceMember: { findUnique: async () => null },
        chatChannel: { findUnique: async () => null, findMany: async () => [] },
        chatChannelMember: { findUnique: async () => null, findMany: async () => [] }
    }
}));

const access = await import("../../src/lib/chat/access");

beforeEach(() => {
    withChat = new Set(["ada", "grace"]);
    hidden = new Set();
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

/**
 * Who the picker offers.
 *
 * The bug: it borrowed the account search written for a drop point's allowlist,
 * whose reach is "people you already share a Tasks space or an organization
 * with". So a colleague on the same instance came back as "Nobody else to add",
 * and switching their chat on changed nothing, because they were never in the
 * search. An internal messenger reaches everybody signed in here who has the
 * chat, and nobody else.
 */
describe("finding somebody to talk to", () => {
    it("finds anybody on the instance, not only people you share work with", async () => {
        const found = await access.searchForConversation({ id: "ada" }, "grace");
        expect(found.people.map((person) => person.id)).toEqual(["grace"]);
    });

    it("finds them by their username, which is what a list of people shows", async () => {
        const found = await access.searchForConversation({ id: "ada" }, "g1203");
        expect(found.people.map((person) => person.id)).toEqual(["grace"]);
    });

    it("leaves out somebody without the chat, and says how many", async () => {
        const found = await access.searchForConversation({ id: "ada" }, "alan");
        expect(found.people).toEqual([]);
        // The count is what lets the picker say why it is empty instead of
        // implying the account does not exist.
        expect(found.withheld).toBe(1);

        withChat.add("turing");
        const again = await access.searchForConversation({ id: "ada" }, "alan");
        expect(again.people.map((person) => person.id)).toEqual(["turing"]);
        expect(again.withheld).toBe(0);
    });

    it("never offers you yourself", async () => {
        const found = await access.searchForConversation({ id: "ada" }, "ada");
        expect(found.people).toEqual([]);
    });

    it("never offers a banned account", async () => {
        withChat.add("gone");
        const found = await access.searchForConversation({ id: "ada" }, "banned");
        expect(found.people).toEqual([]);
    });
});

/**
 * What a picker is not.
 *
 * An instance is not always a company where everybody may know everybody, so
 * nothing here enumerates: an empty box and a single letter both answer with
 * nothing, and somebody who has taken themselves out of the search is not in it
 * - not as a result, and not as a number in a line saying how many were left
 * out.
 */
describe("what it refuses to list", () => {
    it("answers an empty box with an empty list", async () => {
        const found = await access.searchForConversation({ id: "ada" }, "");
        expect(found).toEqual({ people: [], withheld: 0 });
    });

    it("answers one letter the same way", async () => {
        // A single letter is the first page of a directory, not a search.
        const found = await access.searchForConversation({ id: "ada" }, "g");
        expect(found.people).toEqual([]);
    });

    it("leaves out somebody who has hidden themselves", async () => {
        hidden.add("grace");
        const found = await access.searchForConversation({ id: "ada" }, "grace");
        expect(found.people).toEqual([]);
    });

    it("does not count them either, since counting them says they exist", async () => {
        hidden.add("turing");
        const found = await access.searchForConversation({ id: "ada" }, "alan");
        expect(found).toEqual({ people: [], withheld: 0 });
    });
});

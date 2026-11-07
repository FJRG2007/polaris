/**
 * Only friends autocomplete.
 *
 * A few letters find a friend by name or handle. Anybody else is found only by
 * their whole username, so two letters at a time cannot list the instance.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Account {
    id: string;
    name: string;
    email: string;
    username: string;
}

const accounts: Account[] = [
    { id: "viewer", name: "Test Viewer", email: "viewer@example.test", username: "viewer" },
    { id: "friend", name: "Fixture Friend", email: "friend@example.test", username: "fixture_friend" },
    { id: "stranger", name: "Fixture Stranger", email: "stranger@example.test", username: "fixture_stranger" }
];

let friends = new Set<string>();

type Text = { contains: string } | string;

function textMatches(value: string, rule: Text): boolean {
    return typeof rule === "string"
        ? value === rule
        : value.toLowerCase().includes(rule.contains.toLowerCase());
}

/** One clause of the search's `where`, applied to a row in memory. */
function clauseMatches(person: Account, clause: Record<string, unknown>): boolean {
    for (const [field, rule] of Object.entries(clause)) {
        if (field === "OR") {
            if (!(rule as Record<string, unknown>[]).some((inner) => clauseMatches(person, inner))) {
                return false;
            }
        } else if (field === "id") {
            const id = rule as { in?: string[]; not?: string };
            if (id.in && !id.in.includes(person.id)) return false;
            if (id.not && id.not === person.id) return false;
        } else if (field === "name" || field === "username" || field === "email") {
            if (!textMatches(person[field], rule as Text)) return false;
        }
    }
    return true;
}

vi.mock("@/lib/rich-text/mention-service", () => ({
    like: (term: string) => ({ contains: term })
}));
// The instance's discovery policy, as the operator left it; null is the default.
let storedPolicy: string | null = null;
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => storedPolicy,
    setSetting: async () => {}
}));
vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async (_viewer: { id: string }, userIds: readonly string[]) => new Set(userIds)
}));
vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => new Set<string>() }));
vi.mock("@/lib/friends-service", () => ({ friendIds: async () => friends }));
vi.mock("@polaris/db", () => ({
    VISIBLE_USER: { bannedAt: null, disabledAt: null },
    prisma: {
        user: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                accounts.filter((person) => clauseMatches(person, where))
        }
    }
}));

const { findPeople } = await import("@/lib/people-search");

async function search(term: string): Promise<string[]> {
    const found = await findPeople({ id: "viewer" }, term, { reachableOnly: false });
    return found.people.map((person) => person.id);
}

describe("finding somebody who is not a friend", () => {
    beforeEach(() => {
        friends = new Set(["friend"]);
        storedPolicy = null;
    });

    it("lists nobody from a few letters", async () => {
        expect(await search("fi")).toEqual(["friend"]);
        expect(await search("strang")).toEqual([]);
        expect(await search("Fixture")).toEqual(["friend"]);
    });

    it("finds them by their whole username, with or without the @", async () => {
        expect(await search("fixture_stranger")).toEqual(["stranger"]);
        expect(await search("@Fixture_Stranger")).toEqual(["stranger"]);
    });

    it("never matches on the email address", async () => {
        expect(await search("stranger@example.test")).toEqual([]);
        expect(await search("example.test")).toEqual([]);
    });

    it("lists nobody at all for somebody with no friends", async () => {
        friends = new Set();
        expect(await search("fixture")).toEqual([]);
    });
});

describe("the instance's discovery policy", () => {
    beforeEach(() => {
        friends = new Set(["friend"]);
    });

    function policy(rules: Record<string, boolean>) {
        storedPolicy = JSON.stringify({
            usernameExact: true,
            usernamePartial: false,
            namePartial: false,
            emailExact: false,
            ...rules
        });
    }

    it("finds a stranger by part of their username only when that is on", async () => {
        policy({ usernamePartial: true });
        expect(await search("fixture_str")).toEqual(["stranger"]);
        expect(await search("Fixture Stranger")).toEqual([]);
    });

    it("finds a stranger by part of their name only when that is on", async () => {
        policy({ namePartial: true });
        expect(await search("Stranger")).toEqual(["stranger"]);
        expect(await search("fixture_str")).toEqual([]);
    });

    it("finds a stranger by their whole address only when that is on, never part of it", async () => {
        policy({ emailExact: true });
        expect(await search("stranger@example.test")).toEqual(["stranger"]);
        expect(await search("example.test")).toEqual([]);
    });

    it("stops finding strangers by username when that is off, and keeps friends", async () => {
        policy({ usernameExact: false });
        expect(await search("fixture_stranger")).toEqual([]);
        expect(await search("Friend")).toEqual(["friend"]);
    });

    it("reads an unreadable value as the defaults", async () => {
        storedPolicy = "not json";
        expect(await search("fixture_stranger")).toEqual(["stranger"]);
        expect(await search("Stranger")).toEqual([]);
    });
});

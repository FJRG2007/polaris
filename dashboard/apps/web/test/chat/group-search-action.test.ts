/**
 * What the group picker is told about each person it finds.
 *
 * Friends and colleagues come back plain and first. Everybody else comes back
 * with the reason in words, and a stranger is marked requestable only when
 * their own "who can ask to be your friend" setting would take the request -
 * so the button beside them is never one that gets refused.
 */

import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    askable: new Set<string>(["alan"]),
    askedAbout: [] as string[][]
}));

vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: "ada", name: "Ada" })
}));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/chat/access");
    return {
        ...actual,
        searchForConversation: async () => ({
            people: [
                { id: "hopper", name: "Hopper" },
                { id: "alan", name: "Alan" },
                { id: "grace", name: "Grace" },
                { id: "linus", name: "Linus" },
                { id: "turing", name: "Turing" }
            ],
            withheld: 1
        })
    };
});
vi.mock("@/lib/chat/group-reach", () => ({
    groupStandings: async () =>
        new Map([
            ["hopper", "pending"],
            ["alan", "stranger"],
            ["grace", "friend"],
            ["linus", "stranger"],
            ["turing", "colleague"]
        ]),
    mayJoinGroup: (standing: string) => standing === "friend" || standing === "colleague"
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, field: string, ids: string[]) => {
        fake.askedAbout.push([field, ...ids]);
        return new Set(ids.filter((id) => fake.askable.has(id)));
    }
}));

const { searchGroupPeopleAction } = await import("@/app/(app)/chat/actions");

describe("the group picker's search", () => {
    it("puts who can be added first, and says why about everybody else", async () => {
        const result = await searchGroupPeopleAction("a");
        expect(result.withheld).toBe(1);
        expect(result.results).toEqual([
            { id: "grace", name: "Grace" },
            { id: "turing", name: "Turing" },
            {
                id: "hopper",
                name: "Hopper",
                unavailable: "Friend request pending",
                requestable: false
            },
            { id: "alan", name: "Alan", unavailable: "Not your friend yet", requestable: true },
            { id: "linus", name: "Linus", unavailable: "Not your friend yet", requestable: false }
        ]);
        // Only strangers are asked about, and only about friend requests.
        expect(fake.askedAbout).toEqual([["friendRequests", "alan", "linus"]]);
    });
});

/**
 * A space's member list, split into who is around and who is not.
 *
 * Pinned on the pure function so the order is a fact rather than something read
 * off a screen: around first, by name; everybody else after, by name and dimmed;
 * away and do-not-disturb are around; the live answer beats the snapshot.
 */

import { describe, expect, it } from "vitest";
import { rosterItems, type ChatRosterMember } from "@/lib/chat/roster-groups";

const member = (
    userId: string,
    name: string,
    online: boolean,
    role = "member"
): ChatRosterMember => ({
    userId,
    name,
    role,
    online
});

const SPACE = [
    member("u1", "zoe", true),
    member("u2", "Ada", false, "owner"),
    member("u3", "bob", true, "admin"),
    member("u4", "Carl", false),
    member("u5", "Eve", true)
];

const shape = (items: ReturnType<typeof rosterItems>) =>
    items.map((item) =>
        item.kind === "heading"
            ? `# ${item.section} ${item.count}`
            : `${item.member.name}${item.away ? " (dim)" : ""}`
    );

describe("a space's member list", () => {
    it("puts who is around first and everybody else after, each by name", () => {
        expect(shape(rosterItems(SPACE, new Map(), true))).toEqual([
            "# online 3",
            "bob",
            "Eve",
            "zoe",
            "# offline 2",
            "Ada (dim)",
            "Carl (dim)"
        ]);
    });

    it("counts away and do-not-disturb as around, and offline as not", () => {
        const live = new Map([
            ["u2", { status: "idle" as const }],
            ["u4", { status: "busy" as const }],
            ["u1", { status: "offline" as const }]
        ]);
        expect(shape(rosterItems(SPACE, live, true))).toEqual([
            "# online 4",
            "Ada",
            "bob",
            "Carl",
            "Eve",
            "# offline 1",
            "zoe (dim)"
        ]);
    });

    it("leaves out a section nobody is in", () => {
        const items = rosterItems([member("u1", "Ada", true)], new Map(), true);
        expect(shape(items)).toEqual(["# online 1", "Ada"]);
    });

    it("draws nothing for an empty list", () => {
        expect(rosterItems([], new Map(), true)).toEqual([]);
    });

    it("keeps a group in order of standing, with nobody dimmed", () => {
        expect(shape(rosterItems(SPACE, new Map(), false))).toEqual([
            "Ada",
            "bob",
            "Carl",
            "Eve",
            "zoe"
        ]);
    });

    it("reads a number in a name as a number", () => {
        const numbered = [member("a", "User 10", true), member("b", "User 9", true)];
        expect(shape(rosterItems(numbered, new Map(), true))).toEqual([
            "# online 2",
            "User 9",
            "User 10"
        ]);
    });

    it("gives every row a key of its own, headings included", () => {
        const keys = rosterItems(SPACE, new Map(), true).map((item) => item.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

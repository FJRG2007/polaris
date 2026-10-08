/**
 * A group's roster, a page at a time, and the people who could join it.
 *
 * What an operator whose "Customers" group holds everybody depends on: the
 * roster is never read whole, the next page resumes after the last member shown,
 * the row's own page says truthfully whether there is more, and somebody to add
 * is found by name - with whoever is already in the group shown but not offered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const GROUP = "00000000-0000-7000-8000-0000000000a1";
const id = (n: number) => `018f2b7a-0000-7000-8000-${String(n).padStart(12, "0")}`;
const roster = Array.from({ length: 120 }, (_, index) => ({
    user: { id: id(index), name: `Member ${index}`, email: `m${index}@example.com` }
}));

let asked: { where: Record<string, unknown>; take?: number }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        groupMember: {
            findMany: async (query: { where: { userId?: { gt: string } }; take: number }) => {
                asked.push(query);
                const after = query.where.userId?.gt;
                return roster.filter((row) => !after || row.user.id > after).slice(0, query.take);
            }
        },
        user: {
            findMany: async (query: { take: number }) => {
                asked.push(query as never);
                return [
                    { id: id(1), name: "Member 1", groups: [{ groupId: GROUP }] },
                    { id: id(500), name: "Member 500", groups: [] }
                ];
            }
        },
        group: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/rich-text/mention-service", () => ({
    like: (term: string) => ({ contains: term, mode: "insensitive" })
}));

const { readGroupMembers, firstMembers, findGroupCandidates, GROUP_MEMBERS_PAGE, GROUP_PREVIEW } = await import(
    "@/lib/group-members"
);

beforeEach(() => {
    asked = [];
});

describe("a group's roster", () => {
    it("walks every member once, a bounded page at a time", async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const page = await readGroupMembers(GROUP, cursor);
            seen.push(...page.items.map((member) => member.id));
            cursor = page.next;
        } while (cursor);
        expect(seen).toEqual(roster.map((row) => row.user.id));
        expect(asked.every((query) => query.take === GROUP_MEMBERS_PAGE + 1)).toBe(true);
    });

    it("reads a cursor nobody issued as the top", async () => {
        const page = await readGroupMembers(GROUP, "'; drop table");
        expect(page.items[0]?.id).toBe(id(0));
    });

    it("says whether the row's first page is all of it", () => {
        expect(firstMembers(roster.slice(0, GROUP_PREVIEW + 1)).next).toBe(id(GROUP_PREVIEW - 1));
        expect(firstMembers(roster.slice(0, GROUP_PREVIEW)).next).toBeNull();
    });
});

describe("somebody to add", () => {
    it("asks nothing for a single letter", async () => {
        expect(await findGroupCandidates(GROUP, "m")).toEqual([]);
        expect(asked).toHaveLength(0);
    });

    it("marks who is already in the group, from a bounded search", async () => {
        const found = await findGroupCandidates(GROUP, "member");
        expect(found).toEqual([
            { id: id(1), name: "Member 1", member: true },
            { id: id(500), name: "Member 500", member: false }
        ]);
        expect(asked[0]?.take).toBe(20);
    });
});

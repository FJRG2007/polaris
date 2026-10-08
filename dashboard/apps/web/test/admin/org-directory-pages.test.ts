/**
 * The organizations list, a page at a time.
 *
 * What an operator whose every customer has an organization depends on: a page
 * is a bounded read in a stable order, the next one resumes after the last
 * organization shown, a search is asked of the database, and the owner counts
 * toward the roster the row reports.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const id = (n: number) => `018f2b7a-0000-7000-8000-${String(n).padStart(12, "0")}`;
const orgs = Array.from({ length: 75 }, (_, index) => ({
    id: id(index),
    slug: `org-${index}`,
    name: `Org ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
    owner: { name: "Owner" },
    _count: { members: 2, teams: 1, spaces: 0 }
}));

let asked: { where: Record<string, unknown>; take: number; orderBy: unknown }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: {
            findMany: async (query: { where: { AND?: Record<string, unknown>[] }; take: number; orderBy: unknown }) => {
                asked.push(query);
                const keyset = query.where.AND?.[1] as { OR: [{ createdAt: { gt: Date } }] } | undefined;
                const from = keyset?.OR[0].createdAt.gt;
                return orgs.filter((org) => !from || org.createdAt > from).slice(0, query.take);
            }
        }
    }
}));
vi.mock("@/lib/rich-text/mention-service", () => ({
    like: (term: string) => ({ contains: term, mode: "insensitive" })
}));

const { listOrgDirectoryPage, ORG_PAGE } = await import("@/lib/org-directory");

beforeEach(() => {
    asked = [];
});

describe("a page of organizations", () => {
    it("walks every organization once, oldest first, a bounded page at a time", async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const page = await listOrgDirectoryPage({ cursor });
            seen.push(...page.items.map((org) => org.id));
            cursor = page.next;
        } while (cursor);
        expect(seen).toEqual(orgs.map((org) => org.id));
        expect(asked).toHaveLength(2);
        expect(asked[0]?.take).toBe(ORG_PAGE + 1);
        expect(asked[0]?.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    });

    it("counts the owner in the roster", async () => {
        const page = await listOrgDirectoryPage();
        expect(page.items[0]?.memberCount).toBe(3);
    });

    it("asks the database for a search by name, handle or owner", async () => {
        await listOrgDirectoryPage({ query: " acme " });
        const where = JSON.stringify(asked[0]?.where);
        expect(where).toContain('"slug":{"contains":"acme"');
        expect(where).toContain('"owner"');
    });

    it("refuses a page larger than the ceiling", async () => {
        await expect(listOrgDirectoryPage({ limit: 5000 })).rejects.toThrow();
    });
});

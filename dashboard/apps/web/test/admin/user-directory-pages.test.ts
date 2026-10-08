/**
 * The people directory, a page at a time.
 *
 * What an operator with ten thousand accounts depends on: a page is a bounded
 * read, the next one resumes after the last person shown rather than counting
 * past everybody before it, a search and a cut are asked of the database so a
 * page is full of matches, and a cursor somebody made up is no page rather than
 * an error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Person {
    id: string;
    createdAt: Date;
}

let people: Person[] = [];
let asked: { where: unknown; take?: number; orderBy: unknown }[] = [];

function row(person: Person) {
    return {
        ...person,
        name: `Person ${person.id.slice(-2)}`,
        email: `${person.id.slice(-2)}@example.com`,
        username: null,
        company: null,
        isAdmin: false,
        bannedAt: null,
        banReason: null,
        bannedUntil: null,
        emailVerified: true,
        phone: null,
        twoFactorEnabled: false,
        roles: [],
        groups: [],
        accessGroupBindings: [],
        security: null,
        sessionStates: []
    };
}

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        user: {
            findMany: async (query: { where: Record<string, unknown>; take?: number; orderBy: unknown }) => {
                asked.push(query);
                // Enough of the keyset to page the fixture: after the cursor's row.
                const and = (query.where.AND as Record<string, unknown>[] | undefined) ?? [];
                const keyset = and.find((part) => "OR" in part && Array.isArray(part.OR) && "createdAt" in (part.OR as object[])[0]!) as
                    | { OR: [{ createdAt: { gt: Date } }, { createdAt: Date; id: { gt: string } }] }
                    | undefined;
                const rest = keyset
                    ? people.filter(
                          (person) =>
                              person.createdAt > keyset.OR[0].createdAt.gt ||
                              (person.createdAt.getTime() === keyset.OR[1].createdAt.getTime() &&
                                  person.id > keyset.OR[1].id.gt)
                      )
                    : people;
                return rest.slice(0, query.take).map(row);
            }
        }
    }
}));
vi.mock("@/lib/session-directory", () => ({ describeOrigin: () => "" }));
let provider = "postgresql";
vi.mock("@/lib/rich-text/mention-service", () => ({
    like: (term: string) => (provider === "sqlite" ? { contains: term } : { contains: term, mode: "insensitive" })
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/notifications/session-events", () => ({ notifySessionsClosed: async () => undefined }));
vi.mock("@/lib/session-guard", () => ({ revokeSessionsRefusedByRules: async () => undefined }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/personal-drive", () => ({ discardPersonalDrive: async () => undefined }));
vi.mock("@polaris/auth", () => ({
    markPrincipalsMoved: async () => undefined,
    updateEnforcedRules: async () => undefined
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));

const { listUserDirectoryPage, DIRECTORY_PAGE } = await import("@/lib/user-admin-service");
const { decodeCursor, encodeCursor } = await import("@/lib/pagination/cursor");

const id = (n: number) => `018f2b7a-0000-7000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
    asked = [];
    // Two people share a creation instant, which is what the id is there for.
    const start = Date.UTC(2026, 0, 1);
    people = Array.from({ length: 130 }, (_, index) => ({
        id: id(index),
        createdAt: new Date(start + Math.floor(index / 2) * 1000)
    }));
});

describe("a page of the directory", () => {
    it("reads one page and one row past it, oldest first", async () => {
        const page = await listUserDirectoryPage();
        expect(page.items).toHaveLength(DIRECTORY_PAGE);
        expect(page.next).not.toBeNull();
        expect(asked[0]?.take).toBe(DIRECTORY_PAGE + 1);
        expect(asked[0]?.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    });

    it("walks the whole directory without showing anybody twice or skipping them", async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const page = await listUserDirectoryPage({ cursor });
            seen.push(...page.items.map((user) => user.id));
            cursor = page.next;
        } while (cursor);
        expect(seen).toEqual(people.map((person) => person.id));
        expect(asked).toHaveLength(3);
    });

    it("asks the database to narrow a search and a cut, across names, roles and groups", async () => {
        await listUserDirectoryPage({ query: "  ana ", filter: "admins" });
        const where = JSON.stringify(asked[0]?.where);
        expect(where).toContain('"isAdmin":true');
        expect(where).toContain('"contains":"ana","mode":"insensitive"');
        expect(where).toContain('"roles"');
        expect(where).toContain('"groups"');
    });

    it("searches without a case mode the database underneath would refuse", async () => {
        provider = "sqlite";
        try {
            await listUserDirectoryPage({ query: "ana" });
        } finally {
            provider = "postgresql";
        }
        const where = JSON.stringify(asked[0]?.where);
        expect(where).toContain('"contains":"ana"');
        expect(where).not.toContain('"mode"');
    });

    it("counts somebody limited by a group or by a list an administrator set", async () => {
        await listUserDirectoryPage({ filter: "limited" });
        const where = JSON.stringify(asked[0]?.where);
        expect(where).toContain('"accessGroupBindings":{"some":{"enforced":true}}');
        expect(where).toContain('"adminCidrs":{"not":"[]"}');
    });

    it("never hands out more than the ceiling, whatever is asked for", async () => {
        await listUserDirectoryPage({ limit: 200 });
        expect(asked[0]?.take).toBe(201);
        await expect(listUserDirectoryPage({ limit: 5000 })).rejects.toThrow();
    });

    it("reads a cursor nobody issued as the top of the list", async () => {
        const page = await listUserDirectoryPage({ cursor: "not-a-cursor" });
        expect(page.items[0]?.id).toBe(people[0]?.id);
    });
});

describe("the cursor", () => {
    it("round-trips the row it names", () => {
        const at = new Date("2026-03-01T10:00:00.000Z");
        expect(decodeCursor(encodeCursor({ at, id: id(7) }))).toEqual({ at, id: id(7) });
    });

    it("is nothing when it is not one", () => {
        expect(decodeCursor(Buffer.from('["x","y"]').toString("base64url"))).toBeNull();
        expect(decodeCursor("a".repeat(500))).toBeNull();
        expect(decodeCursor(null)).toBeNull();
    });
});

/**
 * Which shelf an alert belongs on, and who can see it there.
 *
 * The rule the bell and every badge follow: an alert about the account is on
 * every shelf, an alert about work is on the shelf that work is listed on. The
 * part that is easy to get wrong is the recipient who cannot open that shelf -
 * filed there, the alert would be one they never see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The organizations each account is on the roster of, owner included. */
let rosters: Record<string, string[]> = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: {
            findFirst: async ({ where }: { where: { id: string; OR: [{ ownerId: string }, unknown] } }) => {
                const userId = where.OR[0].ownerId;
                return (rosters[userId] ?? []).includes(where.id) ? { id: where.id } : null;
            }
        }
    }
}));

const { onShelf, PERSONAL_SHELF, shelfFilter, shelfKey } = await import("@/lib/shelf");
const { openShelfFor, recipientShelf } = await import("@/lib/workspace-scope");

beforeEach(() => {
    rosters = {};
});

describe("the shelf rule", () => {
    it("shows an alert about the account on every shelf", () => {
        expect(onShelf(null, PERSONAL_SHELF)).toBe(true);
        expect(onShelf(null, "acme")).toBe(true);
    });

    it("shows an alert about work only on that work's shelf", () => {
        expect(onShelf("acme", "acme")).toBe(true);
        expect(onShelf("acme", PERSONAL_SHELF)).toBe(false);
        expect(onShelf("acme", "globex")).toBe(false);
        expect(onShelf(PERSONAL_SHELF, "acme")).toBe(false);
        expect(onShelf(PERSONAL_SHELF, PERSONAL_SHELF)).toBe(true);
    });

    it("is the same rule as a filter on the table", () => {
        expect(shelfFilter("acme")).toEqual({ OR: [{ shelf: null }, { shelf: "acme" }] });
    });

    it("names the personal shelf the way the client does", () => {
        expect(shelfKey(null)).toBe("personal");
        expect(shelfKey("acme")).toBe("acme");
    });
});

describe("filing an alert for its recipient", () => {
    it("files one about the account under no shelf", async () => {
        expect(await recipientShelf("u1", undefined)).toBeNull();
    });

    it("files one about somebody's own work under the personal shelf", async () => {
        expect(await recipientShelf("u1", { orgId: null })).toBe(PERSONAL_SHELF);
    });

    it("files one about an organization's work under that organization", async () => {
        rosters = { u1: ["acme"] };
        expect(await recipientShelf("u1", { orgId: "acme" })).toBe("acme");
    });

    it("files it under no shelf for somebody who cannot switch to that organization", async () => {
        // Given one space of a company, not on its roster: there is no shelf
        // they could open to find it, so every shelf shows it.
        rosters = { u2: ["globex"] };
        expect(await recipientShelf("u2", { orgId: "acme" })).toBeNull();
    });
});

describe("the open shelf outside a request", () => {
    it("is the personal one, where there is no cookie to read", async () => {
        expect(await openShelfFor("u1")).toBe(PERSONAL_SHELF);
    });
});

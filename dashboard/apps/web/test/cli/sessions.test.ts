/**
 * A CLI sign-in as a session.
 *
 * The API key is the one source of truth: the sessions screen lists the live CLI
 * keys, signing one out revokes that key and nothing else, signing out
 * everywhere includes them, and a sign-in locked to its address is signed out -
 * logged and its owner told - when it turns up from another, exactly as a
 * session is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-04T10:00:00Z");

interface Row {
    [key: string]: unknown;
}

let keys: Row[] = [];
let made = 0;
let security: Row[] = [];
const audits: Row[] = [];
const notices: Row[] = [];

/** The where clauses `lib/cli/sessions` writes, evaluated like the database. */
function match(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === "OR") {
            return (value as Row[]).some((clause) => match(row, clause));
        }
        if (key === "expiresAt" && value !== null && typeof value === "object") {
            const at = row["expiresAt"] as Date | null;
            return at !== null && at > (value as { gt: Date }).gt;
        }
        return row[key] === value;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        apiKey: {
            findMany: async ({ where }: { where: Row }) => keys.filter((row) => match(row, where)),
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                const hit = keys.filter((row) => match(row, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            }
        },
        userSecurity: {
            findUnique: async ({ where }: { where: Row }) =>
                security.find((row) => row["userId"] === where["userId"]) ?? null
        }
    }
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: Row) => void audits.push(entry)
}));
vi.mock("@/lib/notifications/session-events", () => ({
    notifySessionsClosed: async (entry: Row) => void notices.push(entry)
}));

const { cliAddressAllows, listCliSessions, pinCliSession, revokeCliSession, revokeCliSessions } =
    await import("@/lib/cli/sessions");

/** A CLI key as `claimCliSignIn` leaves it. */
function cliKey(overrides: Row = {}): Row {
    return {
        id: `key-${++made}`,
        userId: ADA,
        kind: "cli",
        name: "CLI - ada-laptop",
        clientName: "ada-laptop",
        clientOs: "macOS",
        clientVersion: "0.4.6",
        signedInIp: "203.0.113.4",
        createdAt: new Date("2026-10-01T09:00:00Z"),
        lastUsedAt: new Date("2026-10-04T09:59:00Z"),
        lastUsedIp: "203.0.113.4",
        expiresAt: new Date("2027-10-01T09:00:00Z"),
        revokedAt: null,
        pinToAddress: null,
        ...overrides
    };
}

beforeEach(() => {
    keys = [];
    made = 0;
    security = [];
    audits.length = 0;
    notices.length = 0;
});

describe("listing", () => {
    it("shows each live CLI sign-in with its computer, system, version, addresses and times", async () => {
        keys.push(cliKey());
        const [row] = await listCliSessions(ADA, NOW);
        expect(row).toEqual({
            id: "key-1",
            name: "ada-laptop",
            os: "macOS",
            version: "0.4.6",
            signedInIp: "203.0.113.4",
            createdAt: "2026-10-01T09:00:00.000Z",
            lastUsedAt: "2026-10-04T09:59:00.000Z",
            lastUsedIp: "203.0.113.4",
            expiresAt: "2027-10-01T09:00:00.000Z",
            pinToAddress: null,
            pinnedByRule: false
        });
    });

    it("leaves out revoked and expired sign-ins, ordinary keys, and other accounts'", async () => {
        keys.push(
            cliKey({ revokedAt: new Date("2026-10-02T00:00:00Z") }),
            cliKey({ expiresAt: new Date("2026-10-03T00:00:00Z") }),
            cliKey({ kind: "key" }),
            cliKey({ userId: BOB }),
            cliKey({ expiresAt: null })
        );
        const rows = await listCliSessions(ADA, NOW);
        expect(rows.map((row) => row.id)).toEqual(["key-5"]);
    });

    it("says when the account's rule locks it", async () => {
        security.push({ userId: ADA, pinSessionsToAddress: "all" });
        keys.push(cliKey());
        expect((await listCliSessions(ADA, NOW))[0]?.pinnedByRule).toBe(true);
    });
});

describe("signing out", () => {
    it("revokes that one key, and only for its owner", async () => {
        keys.push(cliKey(), cliKey());
        expect(await revokeCliSession(BOB, "key-1", NOW)).toBe(false);
        expect(await revokeCliSession(ADA, "key-1", NOW)).toBe(true);
        expect(keys[0]?.["revokedAt"]).toEqual(NOW);
        expect(keys[1]?.["revokedAt"]).toBeNull();
        // Already ended: nothing left to end.
        expect(await revokeCliSession(ADA, "key-1", NOW)).toBe(false);
    });

    it("never revokes a key that is not a CLI sign-in", async () => {
        keys.push(cliKey({ kind: "key" }));
        expect(await revokeCliSession(ADA, "key-1", NOW)).toBe(false);
        expect(keys[0]?.["revokedAt"]).toBeNull();
    });

    it("everywhere ends every live one the account has, and says how many", async () => {
        keys.push(cliKey(), cliKey(), cliKey({ kind: "key" }), cliKey({ userId: BOB }));
        expect(await revokeCliSessions(ADA, NOW)).toBe(2);
        expect(keys.map((row) => row["revokedAt"] === NOW)).toEqual([true, true, false, false]);
    });
});

describe("the address lock", () => {
    const key = (overrides: Row = {}) => ({
        id: "key-1",
        userId: ADA,
        lastUsedIp: "203.0.113.4",
        pinToAddress: null as boolean | null,
        clientOs: "macOS",
        ...overrides
    });

    it("lets an unlocked sign-in move", async () => {
        keys.push(cliKey());
        expect(await cliAddressAllows(key(), "198.51.100.7")).toBe(true);
        expect(keys[0]?.["revokedAt"]).toBeNull();
    });

    it("signs a locked one out when it turns up somewhere else, logs it and tells the owner", async () => {
        keys.push(cliKey({ pinToAddress: true }));
        expect(await cliAddressAllows(key({ pinToAddress: true }), "198.51.100.7")).toBe(false);
        expect(keys[0]?.["revokedAt"]).not.toBeNull();
        expect(audits).toEqual([
            expect.objectContaining({
                action: "account.cli.compromised",
                metadata: { from: "203.0.113.4", to: "198.51.100.7" }
            })
        ]);
        expect(notices).toEqual([expect.objectContaining({ userId: ADA, count: 1 })]);
    });

    it("follows the account's rule when the sign-in has no answer of its own", async () => {
        security.push({ userId: ADA, pinSessionsToAddress: "all" });
        keys.push(cliKey());
        expect(await cliAddressAllows(key(), "198.51.100.7")).toBe(false);
    });

    it("lets a locked one through from the same address, or on its first use", async () => {
        expect(await cliAddressAllows(key({ pinToAddress: true }), "203.0.113.4")).toBe(true);
        expect(
            await cliAddressAllows(key({ pinToAddress: true, lastUsedIp: null }), "198.51.100.7")
        ).toBe(true);
        expect(audits).toEqual([]);
    });

    it("can be locked, unlocked or handed back to the rule, by its owner only", async () => {
        keys.push(cliKey());
        expect(await pinCliSession(BOB, "key-1", true)).toBe(false);
        expect(await pinCliSession(ADA, "key-1", true)).toBe(true);
        expect(keys[0]?.["pinToAddress"]).toBe(true);
        expect(await pinCliSession(ADA, "key-1", null)).toBe(true);
        expect(keys[0]?.["pinToAddress"]).toBeNull();
    });
});

/**
 * Pairing an extension's connection with the computer it runs on: a nonce the
 * extension is issued and Polaris Desktop presents over its own session. Bound
 * only by the account, the connection and a session with a device key - once,
 * and only while it is fresh.
 */

import { hashToken } from "@polaris/core/tokens";
import { PAIRING_NONCE_TTL_MS } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "11111111-1111-4111-8111-111111111111";
const EVE = "22222222-2222-4222-8222-222222222222";
const KEY = "a".repeat(64);

interface Pairing {
    id: string;
    userId: string;
    extensionSessionId: string;
    nonceHash: string;
    expiresAt: Date;
    createdAt: Date;
}
interface Connection {
    id: string;
    userId: string;
    revokedAt: Date | null;
    deviceKey: string | null;
    runtimeId: string | null;
}

let pairings: Pairing[] = [];
let connections: Connection[] = [];
let blocked: string[] = [];
let serial = 0;

vi.mock("@/lib/device-sessions/device-key", () => ({
    isDeviceBlocked: async (_userId: string, key: string | null) => !!key && blocked.includes(key)
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        extensionSession: {
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                connections.find((row) => row.id === where.id && row.userId === where.userId && !row.revokedAt) ?? null,
            update: async ({ where, data }: { where: { id: string }; data: Partial<Connection> }) =>
                Object.assign(connections.find((row) => row.id === where.id)!, data),
            updateMany: async ({ where, data }: { where: { id: string; userId: string }; data: Partial<Connection> }) => {
                const hit = connections.filter((row) => row.id === where.id && row.userId === where.userId && !row.revokedAt);
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            },
            findMany: async ({ where }: { where: { userId: string } }) =>
                connections.filter((row) => row.userId === where.userId && !row.revokedAt && row.runtimeId)
        },
        extensionDevicePairing: {
            deleteMany: async ({ where }: { where: { id?: string | { in: string[] }; expiresAt?: { lt: Date } } }) => {
                const before = pairings.length;
                pairings = pairings.filter((row) => {
                    if (where.expiresAt) return row.expiresAt >= where.expiresAt.lt;
                    if (typeof where.id === "string") return row.id !== where.id;
                    return !where.id!.in.includes(row.id);
                });
                return { count: before - pairings.length };
            },
            findMany: async ({ where }: { where: { extensionSessionId: string } }) =>
                pairings.filter((row) => row.extensionSessionId === where.extensionSessionId),
            findUnique: async ({ where }: { where: { nonceHash: string } }) =>
                pairings.find((row) => row.nonceHash === where.nonceHash) ?? null,
            create: async ({ data }: { data: Omit<Pairing, "id" | "createdAt"> }) => {
                serial += 1;
                const row = { ...data, id: `p${serial}`, createdAt: new Date(serial) };
                pairings.push(row);
                return row;
            }
        }
    }
}));

const { claimPairing, offerPairing, pairingExtensionIds } = await import("@/lib/device-sessions/device-pairing");

const NOW = new Date("2026-11-23T10:00:00Z");

beforeEach(() => {
    pairings = [];
    blocked = [];
    connections = [
        { id: "ext-ada", userId: ADA, revokedAt: null, deviceKey: null, runtimeId: null },
        { id: "ext-eve", userId: EVE, revokedAt: null, deviceKey: null, runtimeId: null }
    ];
});

async function nonceFor(id = "ext-ada", userId = ADA): Promise<string> {
    const offer = await offerPairing({ id, userId }, null, NOW);
    if (offer.paired) throw new Error("already paired");
    return offer.nonce;
}

describe("pairing an extension with Polaris Desktop", () => {
    it("binds the connection to the presenting session's device key", async () => {
        const nonce = await nonceFor();
        expect(pairings[0]!.nonceHash).toBe(hashToken(nonce));

        expect(await claimPairing({ userId: ADA, deviceKey: KEY }, nonce, NOW)).toEqual({ bound: true });
        expect(connections[0]!.deviceKey).toBe(KEY);
        expect(pairings).toHaveLength(0);
        expect(await offerPairing({ id: "ext-ada", userId: ADA }, null, NOW)).toEqual({ paired: true });
    });

    it("refuses an expired nonce", async () => {
        const nonce = await nonceFor();
        const late = new Date(NOW.getTime() + PAIRING_NONCE_TTL_MS + 1);
        expect(await claimPairing({ userId: ADA, deviceKey: KEY }, nonce, late)).toEqual({ bound: false, reason: "expired" });
        expect(connections[0]!.deviceKey).toBeNull();
    });

    it("refuses a nonce presented a second time", async () => {
        const nonce = await nonceFor();
        await claimPairing({ userId: ADA, deviceKey: KEY }, nonce, NOW);
        connections[0]!.deviceKey = null;
        expect(await claimPairing({ userId: ADA, deviceKey: "b".repeat(64) }, nonce, NOW)).toEqual({ bound: false, reason: "unknown" });
        expect(connections[0]!.deviceKey).toBeNull();
    });

    it("refuses a desktop signed in to another account, and burns the nonce", async () => {
        const nonce = await nonceFor();
        expect(await claimPairing({ userId: EVE, deviceKey: KEY }, nonce, NOW)).toEqual({ bound: false, reason: "wrong-account" });
        expect(await claimPairing({ userId: ADA, deviceKey: KEY }, nonce, NOW)).toEqual({ bound: false, reason: "unknown" });
        expect(connections[0]!.deviceKey).toBeNull();
    });

    it("refuses a session that carries no device key", async () => {
        const nonce = await nonceFor();
        expect(await claimPairing({ userId: ADA, deviceKey: null }, nonce, NOW)).toEqual({ bound: false, reason: "no-device-key" });
    });

    it("refuses a nonce whose connection has ended since", async () => {
        const nonce = await nonceFor();
        connections[0]!.revokedAt = NOW;
        expect(await claimPairing({ userId: ADA, deviceKey: KEY }, nonce, NOW)).toEqual({ bound: false, reason: "connection-ended" });
    });

    it("refuses a device the account blocked", async () => {
        const nonce = await nonceFor();
        blocked = [KEY];
        expect(await claimPairing({ userId: ADA, deviceKey: KEY }, nonce, NOW)).toEqual({ bound: false, reason: "blocked" });
        expect(connections[0]!.deviceKey).toBeNull();
    });

    it("refuses a nonce nobody issued", async () => {
        expect(await claimPairing({ userId: ADA, deviceKey: KEY }, "x".repeat(43), NOW)).toEqual({ bound: false, reason: "unknown" });
    });

    it("keeps only a few live nonces per connection", async () => {
        for (let i = 0; i < 6; i++) await nonceFor();
        expect(pairings.length).toBeLessThanOrEqual(3);
    });

    it("does not issue to a connection of another account", async () => {
        await expect(offerPairing({ id: "ext-eve", userId: ADA }, null, NOW)).rejects.toThrow();
    });

    it("lists the browser ids the extensions reported, for the host manifest", async () => {
        await offerPairing({ id: "ext-ada", userId: ADA }, "abcdefghijklmnopabcdefghijklmnop", NOW);
        expect(await pairingExtensionIds(ADA)).toEqual(["abcdefghijklmnopabcdefghijklmnop"]);
        expect(await pairingExtensionIds(EVE)).toEqual([]);
    });
});

/**
 * Everything one remembered device holds, and taking it away.
 *
 * The account page can list passes, sessions and passkeys, and until now none of
 * those three lists said which of them were the same device. A session cookie is
 * host-only and a passkey is bound to one address, so the laptop signed in on
 * polaris.local and on the domain is two sessions and two credentials, and the
 * only thing they present in common is what the browser says it is.
 *
 * So this is about the join and about its edges: it must reach across every
 * name the deployment answers on, must not reach across devices or accounts, and
 * must still list - and still end - a pass that nothing describes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHROME = "Mozilla/5.0 (Windows NT 10.0) Chrome/140";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605";

interface Pass {
    id: string;
    current: boolean;
    userAgent: string | null;
    ip: string | null;
    host: string | null;
    rememberedAt: string | null;
    lastSeenAt: string | null;
    expiresAt: string;
}

let passes: Pass[] = [];
let sessionRows: Record<string, unknown>[] = [];
let passkeyRows: Record<string, unknown>[] = [];
const deleted: Record<string, unknown>[] = [];
const passkeyQueries: Record<string, unknown>[] = [];

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/network-service", () => ({ networkPublicIp: async () => "85.87.156.88" }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_APP_URL: "https://polaris.example.com" }) }));
vi.mock("@polaris/auth", () => ({
    TRUST_DEVICE_COOKIE_NAMES: ["polaris.trust_device"],
    adoptTrustedDevice: async () => false,
    currentTrustedDevice: () => null,
    listTrustedDevices: async () => passes,
    verifyQuickPin: async () => false
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        // The account's own rule about addresses, which the directory reads to
        // say what each session's "follow the account" currently amounts to.
        userSecurity: { findUnique: async () => null },
        session: {
            findMany: async () => sessionRows,
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                deleted.push(where);
                const ids = (where.id as { in: string[] }).in;
                const before = sessionRows.length;
                sessionRows = sessionRows.filter((row) => !ids.includes(row.id as string));
                return { count: before - sessionRows.length };
            }
        },
        passkey: {
            findMany: async ({ where }: { where: Record<string, unknown> }) => {
                passkeyQueries.push(where);
                return passkeyRows.filter(
                    (row) => where.userAgent === undefined || row.userAgent === where.userAgent
                );
            }
        }
    }
}));

const { revokeDeviceSessions, trustedDeviceDetail } = await import("../../src/lib/session-directory");

function pass(overrides: Partial<Pass> = {}): Pass {
    return {
        id: "trust-device-aaaaaaaa",
        current: false,
        userAgent: CHROME,
        ip: "192.168.1.131",
        host: "polaris.local",
        rememberedAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-08-01T10:00:00.000Z",
        expiresAt: "2026-08-19T10:00:00.000Z",
        ...overrides
    };
}

/** One Session row as the directory selects it. */
function session(id: string, userAgent: string, host: string, ip = "85.87.156.88") {
    return {
        id,
        createdAt: new Date("2026-08-01T10:00:00Z"),
        expiresAt: new Date("2026-09-01T10:00:00Z"),
        ipAddress: ip,
        userAgent,
        state: { userAgent, host, ip, lastSeenAt: new Date("2026-08-03T10:00:00Z"), approval: "approved" }
    };
}

beforeEach(() => {
    passes = [pass()];
    sessionRows = [];
    passkeyRows = [];
    deleted.length = 0;
    passkeyQueries.length = 0;
});

describe("opening a remembered device", () => {
    it("gathers what it has open on every name, not only the one it was remembered on", async () => {
        sessionRows = [
            session("session-1", CHROME, "polaris.local", "192.168.1.131"),
            session("session-2", CHROME, "polaris.example.com"),
            session("session-3", SAFARI, "polaris.example.com")
        ];
        const detail = await trustedDeviceDetail("user-1", "session-1", "trust-device-aaaaaaaa");
        expect(detail?.identified).toBe(true);
        expect(detail?.sessions.map((row) => row.host)).toEqual(["polaris.local", "polaris.example.com"]);
        expect(detail?.sessions.filter((row) => row.current)).toHaveLength(1);
    });

    it("asks only for the passkeys that browser registered", async () => {
        passkeyRows = [
            { id: "key-1", name: "Laptop", rpId: "polaris.local", userAgent: CHROME, createdAt: new Date() },
            { id: "key-2", name: null, rpId: null, userAgent: SAFARI, createdAt: new Date() }
        ];
        const detail = await trustedDeviceDetail("user-1", "session-1", "trust-device-aaaaaaaa");
        expect(passkeyQueries[0]).toEqual({ userId: "user-1", userAgent: CHROME });
        expect(detail?.passkeys.map((key) => key.id)).toEqual(["key-1"]);
    });

    it("pairs the local address it was remembered at with the network's public one", async () => {
        const detail = await trustedDeviceDetail("user-1", "session-1", "trust-device-aaaaaaaa");
        expect(detail?.device.ip).toBe("192.168.1.131");
        expect(detail?.device.publicIp).toBe("85.87.156.88");
    });

    // Nothing describes it, so nothing can be attributed to it - but it is still
    // a pass somebody may want to end, which is why it opens at all.
    it("attributes nothing to a pass that was never described", async () => {
        passes = [pass({ userAgent: null, ip: null, host: null, rememberedAt: null })];
        sessionRows = [session("session-1", CHROME, "polaris.local")];
        const detail = await trustedDeviceDetail("user-1", "session-1", "trust-device-aaaaaaaa");
        expect(detail?.identified).toBe(false);
        expect(detail?.sessions).toEqual([]);
        expect(detail?.passkeys).toEqual([]);
    });

    it("has nothing to show for a pass that is no longer held", async () => {
        expect(await trustedDeviceDetail("user-1", "session-1", "trust-device-gone")).toBeNull();
    });
});

describe("signing a device out", () => {
    it("ends its sessions on every domain and leaves other devices signed in", async () => {
        sessionRows = [
            session("session-1", CHROME, "polaris.local"),
            session("session-2", CHROME, "polaris.example.com"),
            session("session-3", SAFARI, "polaris.example.com")
        ];
        const result = await revokeDeviceSessions("user-1", "session-9", "trust-device-aaaaaaaa");
        expect(result.count).toBe(2);
        expect(result.endedCurrent).toBe(false);
        expect(sessionRows.map((row) => row.id)).toEqual(["session-3"]);
    });

    // Ending only the sessions somebody is not reading from would leave exactly
    // the one they meant to end when the device is the one in their hand.
    it("says when it ended the session doing the asking, so the cookie can go too", async () => {
        sessionRows = [session("session-1", CHROME, "polaris.local")];
        const result = await revokeDeviceSessions("user-1", "session-1", "trust-device-aaaaaaaa");
        expect(result.endedCurrent).toBe(true);
    });

    it("scopes the delete to the account, never to the ids alone", async () => {
        sessionRows = [session("session-1", CHROME, "polaris.local")];
        await revokeDeviceSessions("user-1", "session-9", "trust-device-aaaaaaaa");
        expect(deleted[0]?.userId).toBe("user-1");
    });

    it("ends nothing for a device nothing describes", async () => {
        passes = [pass({ userAgent: null })];
        sessionRows = [session("session-1", CHROME, "polaris.local")];
        const result = await revokeDeviceSessions("user-1", "session-9", "trust-device-aaaaaaaa");
        expect(result).toEqual({ count: 0, endedCurrent: false });
        expect(deleted).toEqual([]);
    });
});

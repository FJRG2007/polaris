/**
 * A device's sign-in is a session now, and the credential it already holds keeps
 * working: a CLI, Stream Deck or TV paired before the change presents the same
 * `plk_` key and is let in, the address lock covers every kind, a key somebody
 * made is still a key, and an app's actions are written against its own session
 * so "Activity from this session" has something to show.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let verified: Record<string, unknown> | null = null;
let lockAllows = true;
const lockChecked: string[] = [];
let connections: { id: string; tokenHash: string; revokedAt: Date | null }[] = [];

vi.mock("@polaris/auth", () => ({
    verifyApiKey: async () => verified,
    touchApiKey: async () => undefined
}));
vi.mock("@polaris/core", async (original) => ({
    ...(await original<typeof import("@polaris/core")>()),
    userAgentAllowed: () => true
}));
vi.mock("@/lib/device-sessions/sessions", () => ({
    deviceAddressAllows: async (key: { kind: string }) => {
        lockChecked.push(key.kind);
        return lockAllows;
    }
}));
vi.mock("@/lib/network-rules", () => ({ evaluateAccountAccess: async () => ({ allowed: true }) }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.4",
    clientUserAgent: async () => "plr/0.4.6"
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/api-usage/recorder", () => ({ noteKeyCall: () => undefined }));
vi.mock("@polaris/db", () => ({
    prisma: {
        extensionSession: {
            findUnique: async ({ where }: { where: { tokenHash: string } }) =>
                connections.find((row) => row.tokenHash === where.tokenHash) ?? null
        }
    }
}));

const { authenticateApiKey } = await import("@/lib/api-key-auth");
const { credentialSessionId } = await import("@/lib/device-sessions/credential-session");
const { DEVICE_KINDS, isDeviceSessionKind } = await import("@/lib/device-sessions/kinds");
const { hashToken } = await import("@polaris/core/tokens");

/** A key as an install paired before this change holds it: no client fields. */
function oldKey(kind: string) {
    return {
        id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: [],
        projectId: null,
        kind,
        rules: {},
        clients: {},
        lastUsedIp: null,
        pinToAddress: null,
        clientOs: null
    };
}

function presenting(token = "plk_abc_secret"): Request {
    return new Request("https://polaris.test/api/x", {
        headers: { authorization: `Bearer ${token}` }
    });
}

beforeEach(() => {
    verified = null;
    lockAllows = true;
    lockChecked.length = 0;
    connections = [];
});

describe("the credential a device already holds", () => {
    it.each(["cli", "streamdeck"])("still lets a %s in", async (kind) => {
        verified = oldKey(kind);
        expect(await authenticateApiKey(presenting())).toMatchObject({ kind, keyId: verified.id });
    });

    it("still lets a TV in on the TV's own routes, and nowhere else", async () => {
        verified = oldKey("tv");
        expect(await authenticateApiKey(presenting(), { tv: true })).toMatchObject({ kind: "tv" });
        expect(await authenticateApiKey(presenting())).toBeNull();
    });

    it.each(DEVICE_KINDS)("answers to the address lock as a %s session", async (kind) => {
        verified = oldKey(kind);
        lockAllows = false;
        expect(await authenticateApiKey(presenting(), { tv: true })).toBeNull();
        expect(lockChecked).toEqual([kind]);
    });

    it("leaves a key somebody made out of the session lock", async () => {
        verified = oldKey("key");
        lockAllows = false;
        expect(await authenticateApiKey(presenting())).toMatchObject({ kind: "key" });
        expect(lockChecked).toEqual([]);
    });
});

describe("which keys are sessions", () => {
    it("is every registry kind and never an ordinary key", () => {
        expect(DEVICE_KINDS).toEqual(["cli", "streamdeck", "tv"]);
        for (const kind of DEVICE_KINDS) expect(isDeviceSessionKind(kind)).toBe(true);
        expect(isDeviceSessionKind("key")).toBe(false);
        expect(isDeviceSessionKind("toString")).toBe(false);
    });
});

describe("the session an app's activity is written against", () => {
    it.each(DEVICE_KINDS)("is a %s's own sign-in", async (kind) => {
        verified = oldKey(kind);
        expect(await credentialSessionId("Bearer plk_abc_secret")).toBe(verified.id);
    });

    it("is nothing for a key somebody made", async () => {
        verified = oldKey("key");
        expect(await credentialSessionId("Bearer plk_abc_secret")).toBeUndefined();
    });

    it("is the extension's live connection, and not one that was ended", async () => {
        connections = [
            { id: "conn-live", tokenHash: hashToken("ext-live"), revokedAt: null },
            { id: "conn-gone", tokenHash: hashToken("ext-gone"), revokedAt: new Date() }
        ];
        expect(await credentialSessionId("Bearer ext-live")).toBe("conn-live");
        expect(await credentialSessionId("Bearer ext-gone")).toBeUndefined();
        expect(await credentialSessionId(null)).toBeUndefined();
        expect(await credentialSessionId("Basic abc")).toBeUndefined();
    });
});

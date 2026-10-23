/**
 * A Send's address rules are Polaris's own, outside the Send protocol. They are
 * checked on the one access endpoint every opener goes through - the /vs page
 * and any Bitwarden client alike - before the password and before the count,
 * and a client's PUT, which cannot carry them, must leave them as they are.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        vaultSend: { findUnique, findFirst, update, updateMany, fields: { accessCount: "accessCount" } }
    }
}));
vi.mock("@/lib/vault/account", () => ({ bumpRevision: vi.fn(async () => undefined) }));
vi.mock("@/lib/vault/blobs", () => ({ deleteVaultBlob: vi.fn(async () => undefined) }));
const verifyLinkPassword = vi.fn(async () => true);
vi.mock("@polaris/core/link-password", () => ({
    hashLinkPassword: async (value: string) => `hashed:${value}`,
    verifyLinkPassword
}));
let inRegion = true;
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => inRegion }));

const sends = await import("@/lib/vault/sends");

const SEND = "01a081bf-94a6-76c1-9907-ab70aa5f6474";
const USER = "01a081bf-94a6-76c1-9907-ab70aa5f6475";
const row = (overrides: Record<string, unknown> = {}) => ({
    id: SEND,
    accessId: "access-id",
    type: 0,
    data: '{"name":"n"}',
    key: "k",
    passwordHash: null,
    maxAccessCount: null,
    accessCount: 0,
    expirationDate: null,
    deletionDate: new Date(Date.now() + 86_400_000),
    disabled: false,
    hideEmail: true,
    fileSize: null,
    createdAt: new Date(),
    revisionDate: new Date(),
    storedPath: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    ...overrides
});

beforeEach(() => {
    vi.clearAllMocks();
    inRegion = true;
});

describe("a Send's address rules", () => {
    it("open as before when none are set, as on every existing Send", async () => {
        findUnique.mockResolvedValueOnce(row());
        update.mockResolvedValueOnce({});
        const result = await sends.accessSend("access-id", undefined, "203.0.113.9");
        expect(result.ok).toBe(true);
        // The rules are not part of the Send handed back to a stranger.
        expect(result.ok && "allowedCidrs" in result.send).toBe(false);
    });

    it("refuse an address outside the list before the password is tried or a view is counted", async () => {
        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["198.51.100.0/24"]', passwordHash: "h", maxAccessCount: 1 }));
        expect(await sends.accessSend("access-id", "guess", "203.0.113.9")).toEqual({ ok: false, reason: "address" });
        expect(verifyLinkPassword).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("let an address inside the list through", async () => {
        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["198.51.100.0/24"]' }));
        update.mockResolvedValueOnce({});
        expect((await sends.accessSend("access-id", undefined, "198.51.100.7")).ok).toBe(true);
    });

    it("refuse a visitor outside the countries", async () => {
        inRegion = false;
        findUnique.mockResolvedValueOnce(row({ allowedCountries: '["ES"]' }));
        expect(await sends.accessSend("access-id", undefined, "203.0.113.9")).toEqual({ ok: false, reason: "address" });
    });

    it("survive a Bitwarden client's PUT, which only writes protocol fields", async () => {
        findFirst.mockResolvedValueOnce({ id: SEND });
        update.mockResolvedValueOnce(row());
        await sends.updateSend(USER, SEND, {
            type: 0,
            name: "2.a|b|c",
            notes: null,
            key: "2.a|b|c",
            text: { text: "2.a|b|c", hidden: false },
            file: null,
            password: null,
            maxAccessCount: null,
            expirationDate: null,
            deletionDate: new Date(Date.now() + 86_400_000),
            disabled: false,
            hideEmail: true
        });
        const data = update.mock.calls[0][0].data as Record<string, unknown>;
        for (const field of ["allowedCidrs", "allowedCountries", "allowedContinents"]) {
            expect(field in data).toBe(false);
        }
    });

    it("are set by the owner only, from the Sends screen", async () => {
        updateMany.mockResolvedValueOnce({ count: 0 });
        expect(await sends.setSendRules(USER, SEND, { allowedCidrs: [], allowedCountries: ["ES"], allowedContinents: [] })).toBe(false);
        expect(updateMany.mock.calls[0][0].where).toEqual({ id: SEND, userId: USER });

        updateMany.mockResolvedValueOnce({ count: 1 });
        expect(await sends.setSendRules(USER, SEND, { allowedCidrs: ["10.0.0.0/8"], allowedCountries: [], allowedContinents: [] })).toBe(true);
        expect(updateMany.mock.calls[1][0].data).toMatchObject({ allowedCidrs: '["10.0.0.0/8"]', allowedCountries: "[]" });
    });
});

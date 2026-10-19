/**
 * Turning one of the account's passkeys on to unlock the vault: the session's
 * step-up proof is required, the credential has to be the account's own,
 * changes are rate-limited and audited, nothing the server is sent can carry a
 * PRF output, and the name and address are read from the sign-in passkey.
 */

import * as vaultCrypto from "@/lib/vault/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
    passkey: { findFirst: vi.fn(), findMany: vi.fn() },
    vaultPasskey: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
        updateMany: vi.fn()
    }
}));
const stepUpGranted = vi.hoisted(() => vi.fn());
const recordAudit = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/step-up-grant", () => ({ stepUpGranted }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_APP_URL: "https://polaris.example.test" })
}));

const { enrollVaultPasskey, removeVaultPasskey, listVaultPasskeys, listVaultPasskeyChoices } =
    await import("@/lib/vault/passkeys");
const { vaultPasskeyEnrollSchema } = await import("@/lib/vault/passkey-schema");
const { buildEnrollment, toBase64Url } = await import("@/lib/vault/passkey-client");

const PRF = new Uint8Array(32).fill(9);
const SALT = new Uint8Array(32).fill(5);
const CREDENTIAL = toBase64Url(new Uint8Array(24).fill(1));
const OTHER_CREDENTIAL = toBase64Url(new Uint8Array(24).fill(2));

async function enrollment() {
    return buildEnrollment({
        vaultKey: vaultCrypto.generateSymmetricKey(),
        credentialId: CREDENTIAL,
        prfOutput: PRF,
        prfSalt: SALT
    });
}

async function parsedEnrollment() {
    return vaultPasskeyEnrollSchema.parse(await enrollment());
}

beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
    stepUpGranted.mockResolvedValue(true);
    prisma.passkey.findFirst.mockResolvedValue({ id: "pk", name: "Work laptop" });
    prisma.vaultPasskey.findUnique.mockResolvedValue(null);
    prisma.vaultPasskey.count.mockResolvedValue(0);
    prisma.vaultPasskey.upsert.mockResolvedValue({ id: "row-1" });
});

describe("what the browser sends", () => {
    it("carries the wrap, the salt and the id, and never the PRF output", async () => {
        const parsed = await parsedEnrollment();
        const wire = JSON.stringify(parsed);
        expect(wire).not.toContain(vaultCrypto.toBase64(PRF));
        expect(wire).not.toContain(toBase64Url(PRF));
        expect(Object.keys(parsed).sort()).toEqual(["credentialId", "prfSalt", "wrappedKey"]);
        // What was sent opens with the PRF output, which stayed in the tab.
        expect(
            await vaultCrypto.unwrapVaultKeyWithPasskey(parsed.wrappedKey, PRF, SALT)
        ).not.toBeNull();
    });

    it("refuses a body that tries to carry the PRF output, a key, a name or an address", async () => {
        const body = await enrollment();
        const prfOutput = vaultCrypto.toBase64(PRF);
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, prfOutput }).success).toBe(false);
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, vaultKey: "x" }).success).toBe(false);
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, wrappedKey: "plain" }).success).toBe(
            false
        );
        // Both belong to the sign-in passkey, never the browser's to send.
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, name: "Phone" }).success).toBe(false);
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, rpId: "evil.test" }).success).toBe(
            false
        );
    });
});

describe("enrollVaultPasskey", () => {
    it("requires this session's step-up proof for vault passkeys", async () => {
        stepUpGranted.mockResolvedValue(false);
        const result = await enrollVaultPasskey("u1", "s1", await parsedEnrollment());
        expect(result).toEqual({ ok: false, reason: "needs_proof" });
        expect(prisma.vaultPasskey.upsert).not.toHaveBeenCalled();
        expect(stepUpGranted).toHaveBeenCalledWith("u1", "s1", "vault-passkeys");
    });

    it("refuses a credential that is not one of the account's passkeys", async () => {
        prisma.passkey.findFirst.mockResolvedValue(null);
        const result = await enrollVaultPasskey("u1", "s1", await parsedEnrollment());
        expect(result).toEqual({ ok: false, reason: "not_your_passkey" });
        expect(prisma.vaultPasskey.upsert).not.toHaveBeenCalled();
    });

    it("stores the wrap alone and audits which passkey, by its account name", async () => {
        const body = await parsedEnrollment();
        expect(await enrollVaultPasskey("u1", "s1", body)).toEqual({ ok: true });
        expect(prisma.vaultPasskey.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: {
                    userId: "u1",
                    credentialId: CREDENTIAL,
                    prfSalt: body.prfSalt,
                    wrappedKey: body.wrappedKey
                }
            })
        );
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "vault.passkey.added",
                metadata: { passkeyId: "pk", name: "Work laptop" }
            })
        );
        expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(body.wrappedKey);
        expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(body.prfSalt);
    });

    it("stops at the rate limit before checking anything", async () => {
        rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 120_000 });
        const result = await enrollVaultPasskey("u1", "s1", await parsedEnrollment());
        expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
        expect(stepUpGranted).not.toHaveBeenCalled();
    });

    it("refuses past the most passkeys a vault may have", async () => {
        prisma.vaultPasskey.count.mockResolvedValue(10);
        const result = await enrollVaultPasskey("u1", "s1", await parsedEnrollment());
        expect(result).toEqual({ ok: false, reason: "too_many" });
    });
});

describe("removeVaultPasskey", () => {
    it("removes only the account's own row, and audits it", async () => {
        prisma.vaultPasskey.findFirst.mockResolvedValue({ id: "row-1", credentialId: CREDENTIAL });
        expect(await removeVaultPasskey("u1", "row-1")).toEqual({ ok: true });
        expect(prisma.vaultPasskey.deleteMany).toHaveBeenCalledWith({
            where: { id: "row-1", userId: "u1" }
        });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "vault.passkey.removed",
                metadata: { passkeyId: "pk", name: "Work laptop" }
            })
        );
    });

    it("says so when the row is not there", async () => {
        prisma.vaultPasskey.findFirst.mockResolvedValue(null);
        expect(await removeVaultPasskey("u1", "row-2")).toEqual({ ok: false, reason: "not_found" });
        expect(prisma.vaultPasskey.deleteMany).not.toHaveBeenCalled();
    });
});

describe("listVaultPasskeys", () => {
    it("only lists rows whose sign-in passkey still exists, at that passkey's address", async () => {
        prisma.passkey.findMany.mockResolvedValue([
            { id: "pk", credentialID: CREDENTIAL, rpId: "home.example.test" },
            { id: "pk2", credentialID: OTHER_CREDENTIAL, rpId: null }
        ]);
        prisma.vaultPasskey.findMany.mockResolvedValue([
            { id: "row-1", credentialId: CREDENTIAL, prfSalt: "s", wrappedKey: "w" },
            { id: "row-2", credentialId: OTHER_CREDENTIAL, prfSalt: "s", wrappedKey: "w" }
        ]);
        const entries = await listVaultPasskeys("u1");
        expect(prisma.vaultPasskey.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: "u1", credentialId: { in: [CREDENTIAL, OTHER_CREDENTIAL] } }
            })
        );
        // A passkey from before they followed the address belongs to the published one.
        expect(entries.map((entry) => entry.rpId)).toEqual([
            "home.example.test",
            "polaris.example.test"
        ]);
    });
});

describe("listVaultPasskeyChoices", () => {
    it("lists every sign-in passkey under its own name, and whether it unlocks the vault", async () => {
        const added = new Date("2026-10-01T00:00:00.000Z");
        prisma.passkey.findMany.mockResolvedValue([
            {
                id: "pk",
                name: " Phone ",
                deviceType: "multiDevice",
                createdAt: added,
                credentialID: CREDENTIAL,
                rpId: null
            },
            {
                id: "pk2",
                name: null,
                deviceType: "singleDevice",
                createdAt: added,
                credentialID: OTHER_CREDENTIAL,
                rpId: "home.example.test"
            }
        ]);
        prisma.vaultPasskey.findMany.mockResolvedValue([
            { id: "row-1", credentialId: CREDENTIAL, lastUsedAt: null }
        ]);
        expect(await listVaultPasskeyChoices("u1")).toEqual([
            {
                passkeyId: "pk",
                name: "Phone",
                deviceType: "multiDevice",
                addedAt: added.toISOString(),
                credentialId: CREDENTIAL,
                rpId: "polaris.example.test",
                vault: { id: "row-1", lastUsedAt: null }
            },
            {
                passkeyId: "pk2",
                name: null,
                deviceType: "singleDevice",
                addedAt: added.toISOString(),
                credentialId: OTHER_CREDENTIAL,
                rpId: "home.example.test",
                vault: null
            }
        ]);
    });

    it("reads nothing more for an account without passkeys", async () => {
        prisma.passkey.findMany.mockResolvedValue([]);
        expect(await listVaultPasskeyChoices("u1")).toEqual([]);
        expect(prisma.vaultPasskey.findMany).not.toHaveBeenCalled();
    });
});

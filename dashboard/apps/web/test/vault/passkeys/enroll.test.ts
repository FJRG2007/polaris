/**
 * Enrolling a passkey to unlock the vault: the master password is required,
 * the credential has to be the account's own, changes are rate-limited and
 * audited, and nothing the server is sent can carry a PRF output.
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
const verifyMasterPassword = vi.hoisted(() => vi.fn());
const recordAudit = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/vault/account", () => ({ verifyMasterPassword }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));

const { enrollVaultPasskey, removeVaultPasskey, listVaultPasskeys } = await import("@/lib/vault/passkeys");
const { vaultPasskeyEnrollSchema } = await import("@/lib/vault/passkey-schema");
const { buildEnrollment, toBase64Url } = await import("@/lib/vault/passkey-client");

const PRF = new Uint8Array(32).fill(9);
const SALT = new Uint8Array(32).fill(5);
const CREDENTIAL = toBase64Url(new Uint8Array(24).fill(1));

async function enrollment() {
    return buildEnrollment({
        vaultKey: vaultCrypto.generateSymmetricKey(),
        credentialId: CREDENTIAL,
        prfOutput: PRF,
        prfSalt: SALT,
        rpId: "polaris.example.test",
        name: "  Work   laptop ",
        masterPasswordHash: "client-hash"
    });
}

async function parsedEnrollment() {
    return vaultPasskeyEnrollSchema.parse(await enrollment());
}

beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
    verifyMasterPassword.mockResolvedValue(true);
    prisma.passkey.findFirst.mockResolvedValue({ id: "pk" });
    prisma.vaultPasskey.findUnique.mockResolvedValue(null);
    prisma.vaultPasskey.count.mockResolvedValue(0);
    prisma.vaultPasskey.upsert.mockResolvedValue({ id: "row-1" });
});

describe("what the browser sends", () => {
    it("carries the wrap, the salt and the id, and never the PRF output", async () => {
        const parsed = await parsedEnrollment();
        expect(parsed.name).toBe("Work laptop");
        const wire = JSON.stringify(parsed);
        expect(wire).not.toContain(vaultCrypto.toBase64(PRF));
        expect(wire).not.toContain(toBase64Url(PRF));
        expect(Object.keys(parsed).sort()).toEqual([
            "credentialId",
            "masterPasswordHash",
            "name",
            "prfSalt",
            "rpId",
            "wrappedKey"
        ]);
        // What was sent opens with the PRF output, which stayed in the tab.
        expect(await vaultCrypto.unwrapVaultKeyWithPasskey(parsed.wrappedKey, PRF, SALT)).not.toBeNull();
    });

    it("refuses a body that tries to carry the PRF output or a key", async () => {
        const body = await enrollment();
        const prfOutput = vaultCrypto.toBase64(PRF);
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, prfOutput }).success).toBe(false);
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, vaultKey: "x" }).success).toBe(false);
        expect(vaultPasskeyEnrollSchema.safeParse({ ...body, wrappedKey: "plain" }).success).toBe(false);
    });
});

describe("enrollVaultPasskey", () => {
    it("requires the master password", async () => {
        verifyMasterPassword.mockResolvedValue(false);
        const result = await enrollVaultPasskey("u1", await parsedEnrollment());
        expect(result).toEqual({ ok: false, reason: "wrong_password" });
        expect(prisma.vaultPasskey.upsert).not.toHaveBeenCalled();
        expect(verifyMasterPassword).toHaveBeenCalledWith("u1", "client-hash");
    });

    it("refuses a credential that is not one of the account's passkeys", async () => {
        prisma.passkey.findFirst.mockResolvedValue(null);
        const result = await enrollVaultPasskey("u1", await parsedEnrollment());
        expect(result).toEqual({ ok: false, reason: "not_your_passkey" });
        expect(prisma.vaultPasskey.upsert).not.toHaveBeenCalled();
    });

    it("stores the wrap and audits the name and address only", async () => {
        const body = await parsedEnrollment();
        expect(await enrollVaultPasskey("u1", body)).toEqual({ ok: true });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "vault.passkey.added",
                metadata: { name: "Work laptop", rpId: "polaris.example.test" }
            })
        );
        expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(body.wrappedKey);
        expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(body.prfSalt);
    });

    it("stops at the rate limit before checking anything", async () => {
        rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 120_000 });
        const result = await enrollVaultPasskey("u1", await parsedEnrollment());
        expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
        expect(verifyMasterPassword).not.toHaveBeenCalled();
    });

    it("refuses past the most passkeys a vault may have", async () => {
        prisma.vaultPasskey.count.mockResolvedValue(10);
        const result = await enrollVaultPasskey("u1", await parsedEnrollment());
        expect(result).toEqual({ ok: false, reason: "too_many" });
    });
});

describe("removeVaultPasskey", () => {
    it("removes only the account's own row, and audits it", async () => {
        prisma.vaultPasskey.findFirst.mockResolvedValue({ id: "row-1", name: "Phone", rpId: "h" });
        expect(await removeVaultPasskey("u1", "row-1")).toEqual({ ok: true });
        expect(prisma.vaultPasskey.deleteMany).toHaveBeenCalledWith({
            where: { id: "row-1", userId: "u1" }
        });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "vault.passkey.removed" })
        );
    });

    it("says so when the row is not there", async () => {
        prisma.vaultPasskey.findFirst.mockResolvedValue(null);
        expect(await removeVaultPasskey("u1", "row-2")).toEqual({ ok: false, reason: "not_found" });
        expect(prisma.vaultPasskey.deleteMany).not.toHaveBeenCalled();
    });
});

describe("listVaultPasskeys", () => {
    it("only lists rows whose sign-in passkey still exists", async () => {
        prisma.passkey.findMany.mockResolvedValue([{ credentialID: CREDENTIAL }]);
        prisma.vaultPasskey.findMany.mockResolvedValue([]);
        await listVaultPasskeys("u1");
        expect(prisma.vaultPasskey.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: "u1", credentialId: { in: [CREDENTIAL] } } })
        );
    });
});

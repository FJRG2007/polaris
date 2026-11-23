/**
 * Creating a vault or changing its master password asks for the Polaris account
 * password, which now arrives typed or as an OPAQUE proof (docs/chat-e2ee-phase1.md,
 * "Password flows over OPAQUE"). Pinned: the core schema takes both and nothing
 * else, the action runs its check through `withPasswordOrProof`, and a proof that
 * does not check out is a wrong password with nothing written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    gate: vi.fn(),
    verifyAccountPassword: vi.fn(async () => true),
    createVault: vi.fn(async () => ({ ok: true }))
}));

vi.mock("@polaris/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@polaris/core")>();
    const { z } = await import("zod");
    // The key material has its own tests; only the account password is in question here.
    return {
        ...actual,
        vaultSetupSchema: z.object({ accountPassword: actual.vaultAccountPasswordSchema }).passthrough()
    };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "u1" }) }));
vi.mock("@polaris/auth", () => ({ getUserSecurity: vi.fn(), verifyAccountPassword: state.verifyAccountPassword }));
vi.mock("@/lib/chat/e2ee/opaque-password", () => ({ withPasswordOrProof: state.gate }));
vi.mock("@/lib/vault/account", () => ({ createVault: state.createVault }));
vi.mock("@/lib/vault/sends", () => ({}));
vi.mock("@/lib/vault/ciphers", () => ({}));
vi.mock("@/lib/vault/folders", () => ({}));
vi.mock("@/lib/vault/access-log", () => ({}));
vi.mock("@/lib/vault/passkeys", () => ({ listVaultPasskeys: vi.fn() }));
vi.mock("@/lib/vault/account-identity", () => ({ accountIdentity: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: vi.fn() }));
vi.mock("@/app/(app)/vault/vault-refusal", () => ({
    vaultRefusal: async (key: string) => key,
    schemaRefusal: async (_message: string | undefined, fallback: string) => fallback
}));

const core = await import("@polaris/core");
const actions = await import("@/app/(app)/vault/vault-actions");

const PROOF = { loginId: "00000000-0000-4000-8000-000000000000", finishLoginRequest: "A".repeat(64) };
const VAULT = { masterPasswordHash: "hash", key: "key", keys: {}, kdf: 0, kdfIterations: 600000 };

beforeEach(() => {
    vi.clearAllMocks();
    state.gate.mockImplementation(async (_userId: string, given: unknown, run: (password: string) => unknown) =>
        typeof given === "string" ? run(given) : run("stand-in")
    );
});

describe("the vault's account password", () => {
    it("is a typed password or a proof, nothing else", () => {
        expect(core.vaultAccountPasswordSchema.safeParse("typed").success).toBe(true);
        expect(core.vaultAccountPasswordSchema.safeParse(PROOF).success).toBe(true);
        expect(core.vaultAccountPasswordSchema.safeParse({ loginId: PROOF.loginId }).success).toBe(true);
        expect(core.vaultAccountPasswordSchema.safeParse("").success).toBe(false);
        expect(core.vaultAccountPasswordSchema.safeParse({ loginId: "not-a-uuid" }).success).toBe(false);
        expect(core.vaultAccountPasswordSchema.safeParse({ ...PROOF, finishLoginRequest: "not base64url!" }).success).toBe(
            false
        );
    });

    it("creates the vault on a proof, checked on its stand-in", async () => {
        expect(await actions.createAccountVaultAction({ ...VAULT, accountPassword: PROOF })).toEqual({});
        expect(state.gate).toHaveBeenCalledWith("u1", PROOF, expect.any(Function));
        expect(state.verifyAccountPassword).toHaveBeenCalledWith({}, "u1", "stand-in");
        expect(state.createVault).toHaveBeenCalledOnce();
    });

    it("still takes a typed password from an older dashboard", async () => {
        expect(await actions.createAccountVaultAction({ ...VAULT, accountPassword: "typed" })).toEqual({});
        expect(state.verifyAccountPassword).toHaveBeenCalledWith({}, "u1", "typed");
    });

    it("a proof that does not check out is a wrong password and writes nothing", async () => {
        state.gate.mockResolvedValue(null);
        expect(await actions.createAccountVaultAction({ ...VAULT, accountPassword: PROOF })).toEqual({
            error: "errors.wrongPolarisPassword"
        });
        expect(state.createVault).not.toHaveBeenCalled();
    });
});

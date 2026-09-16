/**
 * The two ways a client can come away without an account credential, which are
 * not the same thing and must not arrive looking like it.
 *
 * The extension refuses an approval that carries only the vault: signing in to
 * the account is the way in and the vault is what is behind it, so half a
 * sign-in is a session the popup cannot go anywhere from. That refusal is only
 * honest if an absent credential means what it says.
 *
 * An account that holds no `vault.use` has genuinely nothing to be given, and
 * saying so is the answer. A credential that could not be written is a different
 * story with the same ending - and by the time this runs the approval has been
 * spent, so an answer that quietly dropped the field would end a request nothing
 * can revive and tell somebody their account had lost vault access when asking
 * again was all they needed to do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const scopesAvailableTo = vi.fn(async () => ["vault.use"]);
const createApiKey = vi.fn(async () => ({ id: "key-1", prefix: "pol", secret: "pol.secret" }));

vi.mock("@polaris/auth", () => ({
    scopesAvailableTo: (...args: unknown[]) => scopesAvailableTo(...(args as [])),
    createApiKey: (...args: unknown[]) => createApiKey(...(args as [])),
    listApiKeys: vi.fn(async () => []),
    deleteApiKey: vi.fn(async () => undefined)
}));

const { issueClientKey } = await import("@/lib/vault/client-key");

const DEVICE = { identifier: "device-abc", name: "Brave on Windows" };

beforeEach(() => {
    scopesAvailableTo.mockClear();
    createApiKey.mockClear();
});

describe("the credential a client is let in with", () => {
    it("hands back the secret it just wrote", async () => {
        await expect(issueClientKey("user-1", DEVICE)).resolves.toBe("pol.secret");
    });

    it("says nothing when the account holds nothing to carry", async () => {
        // `vault.use` taken away between asking and approving. There is no
        // credential to issue, and that is an answer rather than a failure.
        scopesAvailableTo.mockResolvedValueOnce([]);
        await expect(issueClientKey("user-1", DEVICE)).resolves.toBeNull();
        expect(createApiKey).not.toHaveBeenCalled();
    });

    it("fails rather than coming back empty when it could not be written", async () => {
        // Swallowed, this arrives as the same absent field as the refusal above -
        // and a client that cannot use an approval without it is then told the
        // wrong thing about an account that is perfectly fine.
        createApiKey.mockRejectedValueOnce(new Error("the database was not there"));
        await expect(issueClientKey("user-1", DEVICE)).rejects.toThrow();
    });
});

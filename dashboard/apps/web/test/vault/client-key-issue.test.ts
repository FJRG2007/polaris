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
const listApiKeys = vi.fn(
    async (): Promise<{ id: string; description: string; createdAt: string }[]> => []
);
const deleteApiKey = vi.fn(async () => undefined);

vi.mock("@polaris/auth", () => ({
    scopesAvailableTo: (...args: unknown[]) => scopesAvailableTo(...(args as [])),
    createApiKey: (...args: unknown[]) => createApiKey(...(args as [])),
    listApiKeys: (...args: unknown[]) => listApiKeys(...(args as [])),
    deleteApiKey: (...args: unknown[]) => deleteApiKey(...(args as []))
}));

const { clientKeyMark, issueClientKey } = await import("@/lib/vault/client-key");

const DEVICE = { identifier: "device-abc", name: "Brave on Windows" };

/** What this same browser was given the last time it was let in. */
const HELD = {
    id: "key-held",
    description: clientKeyMark(DEVICE.identifier),
    createdAt: "2026-09-01T10:00:00.000Z"
};

/** The credential this call writes, as the list shows it once it exists. */
const WRITTEN = {
    id: "key-1",
    description: clientKeyMark(DEVICE.identifier),
    createdAt: "2026-09-16T10:00:00.000Z"
};

beforeEach(() => {
    scopesAvailableTo.mockClear();
    createApiKey.mockClear();
    listApiKeys.mockClear();
    deleteApiKey.mockClear();
    listApiKeys.mockReset();
    listApiKeys.mockImplementation(async () => []);
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

/**
 * What this browser still holds when the new credential could not be written.
 *
 * Re-connecting replaces rather than accumulates, and the obvious way to write
 * that is to clear what the device had and then write the new one. The obvious
 * way is wrong: the clearing succeeds, the write fails, and a browser that was
 * working before it asked is now a browser with nothing - while the approval row
 * it spent getting here is gone, so it cannot even ask again without the person
 * going back to Polaris and approving a second time.
 *
 * Writing first, and reading what to clear only after the write, leaves the
 * device exactly as it was when the write fails and with one credential when it
 * succeeds - even if another approval for it was being claimed at the same time.
 */
describe("a credential that could not be written", () => {
    it("leaves the one this browser already had", async () => {
        listApiKeys.mockImplementation(async () => [HELD]);
        createApiKey.mockRejectedValueOnce(new Error("the database was not there"));

        await expect(issueClientKey("user-1", DEVICE)).rejects.toThrow();
        expect(deleteApiKey).not.toHaveBeenCalled();
    });

    it("is replaced, not added to, once the write has gone through", async () => {
        // The other half: the reason the delete is there at all. One per client,
        // so a second approval from the same browser must not leave the first
        // credential valid behind it.
        listApiKeys.mockImplementation(async () => [WRITTEN, HELD]);

        await expect(issueClientKey("user-1", DEVICE)).resolves.toBe("pol.secret");
        expect(deleteApiKey).toHaveBeenCalledWith("user-1", HELD.id);
        expect(deleteApiKey).toHaveBeenCalledTimes(1);
    });

    it("clears one another approval for this browser wrote while this one was writing", async () => {
        // Read before the write, the list would not have had it, and the device
        // would come away with two live credentials.
        const raced = { ...WRITTEN, id: "key-raced", createdAt: "2026-09-16T09:59:59.000Z" };
        let written = false;
        createApiKey.mockImplementationOnce(async () => {
            written = true;
            return { id: WRITTEN.id, prefix: "pol", secret: "pol.secret" };
        });
        listApiKeys.mockImplementation(async () => (written ? [WRITTEN, raced] : []));

        await expect(issueClientKey("user-1", DEVICE)).resolves.toBe("pol.secret");
        expect(deleteApiKey).toHaveBeenCalledWith("user-1", raced.id);
    });

    it("leaves a newer credential for this browser alone", async () => {
        // Two claims racing: the older one must not take out the newer one's,
        // or each would clear the other's and the device would hold none.
        const newer = { ...WRITTEN, id: "key-newer", createdAt: "2026-09-16T10:00:01.000Z" };
        listApiKeys.mockImplementation(async () => [newer, WRITTEN]);

        await expect(issueClientKey("user-1", DEVICE)).resolves.toBe("pol.secret");
        expect(deleteApiKey).not.toHaveBeenCalled();
    });

    it("still hands the new credential over when the old ones could not be cleared", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        listApiKeys.mockImplementation(async () => [WRITTEN, HELD]);
        deleteApiKey.mockRejectedValueOnce(new Error("the database was not there"));

        await expect(issueClientKey("user-1", DEVICE)).resolves.toBe("pol.secret");
        expect(error).toHaveBeenCalledWith(expect.stringContaining(HELD.id), expect.any(Error));
        error.mockRestore();
    });

    it("still hands the new credential over when the list could not be read", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        listApiKeys.mockRejectedValueOnce(new Error("the database was not there"));

        await expect(issueClientKey("user-1", DEVICE)).resolves.toBe("pol.secret");
        expect(deleteApiKey).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    it("leaves another browser's credential alone", async () => {
        // The mark carries the device it was issued to precisely so that
        // re-connecting one browser does not sign the others out.
        listApiKeys.mockImplementation(async () => [
            WRITTEN,
            { id: "key-other", description: clientKeyMark("device-xyz"), createdAt: HELD.createdAt }
        ]);

        await expect(issueClientKey("user-1", DEVICE)).resolves.toBe("pol.secret");
        expect(deleteApiKey).not.toHaveBeenCalled();
    });
});

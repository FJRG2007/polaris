/**
 * Opening the vault with the master password.
 *
 * The password screen is the one place in this extension where being wrong about
 * why something failed is worse than failing: every refusal used to read "that
 * password did not open the vault", so an extension that could not run the
 * account's key derivation told somebody their correct master password was
 * wrong - about the one credential nobody can reset for them.
 *
 * So these open a vault made by the same code the dashboard makes one with, in
 * both key derivations an account may be on, and pin each refusal to its own
 * reason.
 */

import { describe, expect, it } from "vitest";
import { KDF_ARGON2ID, KDF_PBKDF2, type KdfSettings } from "@polaris/core";
import { createVaultKeys, symmetricKeyBytes } from "@polaris/vault-crypto";
import { openVault, unlockRefusal, type WrappedKeys } from "../src/lib/unlock";

const EMAIL = "ana@example.com";
const PASSWORD = "the master password";

/** Far below what a real vault uses: these are about the algorithm, not the cost. */
const PBKDF2: KdfSettings = {
    kdf: KDF_PBKDF2,
    kdfIterations: 1000,
    kdfMemory: null,
    kdfParallelism: null
};

const ARGON2: KdfSettings = {
    kdf: KDF_ARGON2ID,
    kdfIterations: 2,
    kdfMemory: 16,
    kdfParallelism: 1
};

/** A vault as the dashboard creates one, reduced to what this browser keeps. */
async function vaultOn(
    settings: KdfSettings
): Promise<{ wrapped: WrappedKeys; vaultKey: Uint8Array }> {
    const { keys, vaultKey } = await createVaultKeys(PASSWORD, EMAIL, settings);
    return {
        wrapped: {
            key: keys.protectedKey,
            privateKey: keys.encryptedPrivateKey,
            kdf: settings
        },
        vaultKey: symmetricKeyBytes(vaultKey)
    };
}

describe("opening a vault with the master password", () => {
    it("hands back the same key the vault was created with", async () => {
        const { wrapped, vaultKey } = await vaultOn(PBKDF2);

        const outcome = await openVault(PASSWORD, EMAIL, wrapped);

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(Buffer.from(symmetricKeyBytes(outcome.key)).equals(Buffer.from(vaultKey))).toBe(
            true
        );
    });

    // The dashboard offers Argon2id and says it is harder to attack. An extension
    // that cannot open what that setting produces turns choosing it into locking
    // yourself out of your own browser.
    it("opens an Argon2id vault as well as a PBKDF2 one", async () => {
        const { wrapped, vaultKey } = await vaultOn(ARGON2);

        const outcome = await openVault(PASSWORD, EMAIL, wrapped);

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(Buffer.from(symmetricKeyBytes(outcome.key)).equals(Buffer.from(vaultKey))).toBe(
            true
        );
    });

    it("takes the address the way every other client writes it", async () => {
        const { wrapped } = await vaultOn(PBKDF2);

        // The salt is lowercased inside the derivation, so a profile that came
        // down with the address spelled differently still opens the same vault.
        expect((await openVault(PASSWORD, "  ANA@Example.com ", wrapped)).ok).toBe(true);
    });
});

describe("why it did not open", () => {
    it("says the password is wrong only when it is", async () => {
        const { wrapped } = await vaultOn(PBKDF2);

        const outcome = await openVault("not the master password", EMAIL, wrapped);

        expect(outcome).toEqual({ ok: false, reason: "wrong" });
    });

    it("says nothing is held when this browser has no keys to unlock", async () => {
        expect(await openVault(PASSWORD, EMAIL, null)).toEqual({ ok: false, reason: "nothing" });
    });

    // The address is the salt. Without it there is no derivation to attempt, and
    // attempting one against an empty string would refuse a correct password.
    it("says nothing is held when the address is missing", async () => {
        const { wrapped } = await vaultOn(PBKDF2);

        expect(await openVault(PASSWORD, null, wrapped)).toEqual({ ok: false, reason: "nothing" });
    });

    it("says nothing is held when what was kept is not a set of KDF settings", async () => {
        const { wrapped } = await vaultOn(PBKDF2);

        for (const kdf of [undefined, null, {}, { kdf: 0 }, { kdf: 0, kdfIterations: 0 }]) {
            expect(await openVault(PASSWORD, EMAIL, { ...wrapped, kdf })).toEqual({
                ok: false,
                reason: "nothing"
            });
        }
    });

    /**
     * A derivation this browser will not run.
     *
     * Which is what a manifest without `wasm-unsafe-eval` does to every Argon2id
     * vault - the WebAssembly build throws rather than returning a wrong key - and
     * the guard has to catch it there rather than letting the worker answer
     * "something went wrong". Provoked here with settings the Argon2 build
     * refuses, because a test cannot revoke a browser's own policy.
     */
    it("says the derivation would not run, rather than blaming the password", async () => {
        const { wrapped } = await vaultOn(ARGON2);

        const outcome = await openVault(PASSWORD, EMAIL, {
            ...wrapped,
            kdf: { ...ARGON2, kdfMemory: 0 }
        });

        expect(outcome).toEqual({ ok: false, reason: "unavailable" });
    });
});

describe("what the popup says about each", () => {
    it("blames the password in one case and only that one", () => {
        expect(unlockRefusal("wrong")).toContain("password");
        expect(unlockRefusal("nothing")).not.toContain("password did not");
        expect(unlockRefusal("unavailable")).not.toContain("password did not");
    });

    it("says what mends the two that are not the reader's doing", () => {
        expect(unlockRefusal("nothing")).toContain("Polaris");
        expect(unlockRefusal("unavailable")).toContain("Updating");
    });
});

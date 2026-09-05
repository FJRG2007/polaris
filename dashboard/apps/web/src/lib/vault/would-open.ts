"use client";

/**
 * Whether a password somebody is about to set on their Polaris account would
 * also open their vault.
 *
 * The mirror of the check the vault screens make, and it runs from the other
 * side because that is the only side that can run it. The server holds a hash of
 * a hash of the master password and can derive nothing from a plaintext, so the
 * candidate is derived HERE - with the same salt and the same stretching the
 * vault itself uses - and only the resulting hash is asked about. The account
 * password does not become something the vault can read, and the master password
 * still never leaves a browser.
 *
 * It costs one full key derivation, which is deliberately slow. That is a second
 * or so on submit, once, on a screen where the person is already waiting.
 *
 * False whenever it cannot be answered - no vault, no permission, a browser
 * without the crypto. This is a check that stops somebody making one credential
 * do two jobs; it is not the thing standing between an attacker and an account,
 * and it must never be the reason somebody cannot change their own password.
 */

import * as crypto from "@/lib/vault/crypto";
import {
    passwordOpensVaultAction,
    vaultDerivationAction
} from "@/app/(app)/vault/vault-actions";

export async function passwordWouldOpenVault(candidate: string): Promise<boolean> {
    if (!candidate) return false;
    try {
        const derivation = await vaultDerivationAction();
        if (!derivation?.exists) return false;
        const masterKey = await crypto.deriveMasterKey(
            candidate,
            derivation.email,
            derivation.kdf
        );
        const hash = await crypto.masterPasswordHash(masterKey, candidate);
        return (await passwordOpensVaultAction(hash)).opens;
    } catch {
        return false;
    }
}

/** What the screens say when it does. One sentence, in both places, because it
 *  is one rule. */
export const SAME_AS_VAULT =
    "That is your vault's master password. If they are the same, whoever learns one has the vault as well.";

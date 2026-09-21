/**
 * Opening the vault with the master password, and why it did not open.
 *
 * Apart from the worker because one boolean was the whole problem: a browser
 * holding nothing to unlock with, a key derivation this browser refuses to run,
 * and a password that is actually wrong all came back as `false` - and the popup
 * told all three of them that their password was wrong. Only one of those three
 * is something the reader did, and the other two cannot be mended by typing it
 * again more carefully.
 *
 * The derivation is the one worth naming. A vault on Argon2id is opened through
 * a WebAssembly build, and a browser can refuse to run one: manifest v3 blocks
 * WebAssembly in an extension unless the manifest asks for it, so the same
 * password that opens the vault on the dashboard cannot open it here. That is a
 * fault in the extension rather than in what was typed, and the sentence in
 * front of somebody has to say so or the only conclusion left to them is that
 * they have forgotten their master password.
 */

import type { WrappedKeys } from "@/lib/accounts";
import { KDF_ARGON2ID, type KdfSettings } from "@polaris/core";
import {
    decryptBytes,
    deriveMasterKey,
    stretchMasterKey,
    symmetricKeyFromBytes,
    type SymmetricKey
} from "@polaris/vault-crypto";

/** The record the worker holds and `accounts` parks, named again here because it
 *  is what this takes. Described in one place: a second copy of the shape is a
 *  second thing to keep in step with what the server sends. */
export type { WrappedKeys };

/**
 * Why a master password did not open the vault.
 *
 * - `wrong` is what it says, and the only one of the three that is.
 * - `nothing` is a browser with no wrapped key or no address to salt with, which
 *   is a session that has to be established again rather than typed at.
 * - `unavailable` is a derivation this browser would not run.
 */
export type UnlockFailure = "wrong" | "nothing" | "unavailable";

export type UnlockOutcome =
    | { readonly ok: true; readonly key: SymmetricKey }
    | { readonly ok: false; readonly reason: UnlockFailure };

/** The settings as a client may use them, or null if what arrived is not a set
 *  of KDF settings at all. */
function readKdf(value: unknown): KdfSettings | null {
    if (typeof value !== "object" || value === null) return null;
    const held = value as Record<string, unknown>;
    const kdf = held["kdf"];
    const iterations = held["kdfIterations"];
    if (typeof kdf !== "number" || typeof iterations !== "number" || iterations <= 0) return null;
    const memory = held["kdfMemory"];
    const parallelism = held["kdfParallelism"];
    return {
        kdf: kdf === KDF_ARGON2ID ? KDF_ARGON2ID : 0,
        kdfIterations: iterations,
        kdfMemory: typeof memory === "number" ? memory : null,
        kdfParallelism: typeof parallelism === "number" ? parallelism : null
    };
}

/**
 * Turn a master password into the vault key, or say what stopped it.
 *
 * Pure in the sense that matters: it takes what the worker is holding and gives
 * back a key, touching no storage and no network, so it can be exercised against
 * a vault the same code created.
 */
export async function openVault(
    password: string,
    email: string | null,
    wrapped: WrappedKeys | null
): Promise<UnlockOutcome> {
    if (!wrapped || !email) return { ok: false, reason: "nothing" };
    const settings = readKdf(wrapped.kdf);
    if (!settings) return { ok: false, reason: "nothing" };

    let stretched: SymmetricKey;
    try {
        // The derivation, and only the derivation, inside the guard: this is
        // where a browser that will not run WebAssembly throws, and everything
        // after it is arithmetic that cannot.
        stretched = await stretchMasterKey(await deriveMasterKey(password, email, settings));
    } catch {
        return { ok: false, reason: "unavailable" };
    }

    const raw = await decryptBytes(wrapped.key, stretched);
    if (raw === null || raw.length !== 64) return { ok: false, reason: "wrong" };
    return { ok: true, key: symmetricKeyFromBytes(raw) };
}

/** What each refusal reads as in the popup. One sentence, and the two that are
 *  not the reader's doing say what will mend them. */
export function unlockRefusal(reason: UnlockFailure): string {
    if (reason === "nothing") {
        return "This browser is no longer holding your vault keys. Ask Polaris to let it in again.";
    }
    if (reason === "unavailable") {
        return "This copy of the extension could not run your vault's key derivation. Updating it is what fixes that.";
    }
    return "That password did not open the vault.";
}

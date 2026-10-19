/**
 * The browser half of unlocking the vault with a passkey: ask the
 * authenticator for its PRF output, and turn that into a wrap or an unwrap
 * without anything but the wrap leaving the tab.
 *
 * WebAuthn's PRF extension is evaluated here with no server challenge, and that
 * is deliberate: nothing about the assertion is checked anywhere, because the
 * proof is the output itself - only the authenticator that holds the credential
 * can produce the bytes that open the wrap. A forged assertion opens nothing.
 */

import * as crypto from "@/lib/vault/crypto";
import type { VaultPasskeyEnrollInput, VaultPasskeyEntry } from "@/lib/vault/passkey-schema";

/** Whether this browser can unlock with a passkey, and why not when it cannot. */
export type PasskeySupport = "supported" | "unknown" | "no-webauthn" | "no-prf";

/** Why a passkey ceremony gave back nothing to use. */
export type PasskeyFailure = "cancelled" | "no-prf" | "wrong" | "stale" | "failed";

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };

interface CapabilityProbe {
    getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
}

/**
 * What this browser says about PRF. "unknown" is a browser that predates the
 * capabilities call: the option is offered, and a passkey that gives back no
 * PRF output is explained at that point instead.
 */
export async function passkeySupport(): Promise<PasskeySupport> {
    if (typeof window === "undefined" || !window.isSecureContext) return "no-webauthn";
    const credential = (window as unknown as { PublicKeyCredential?: CapabilityProbe })
        .PublicKeyCredential;
    if (!credential || typeof navigator.credentials?.get !== "function") return "no-webauthn";
    if (typeof credential.getClientCapabilities !== "function") return "unknown";
    try {
        const capabilities = await credential.getClientCapabilities();
        const prf = capabilities["extension:prf"];
        if (prf === false) return "no-prf";
        return prf === true ? "supported" : "unknown";
    } catch {
        return "unknown";
    }
}

export function toBase64Url(bytes: Uint8Array): string {
    return crypto.toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    return crypto.fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

function toBytes(source: BufferSource): Uint8Array {
    return source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

/** One assertion with the PRF evaluated, against the given credentials and salts. */
async function evaluatePrf(
    salts: ReadonlyMap<string, Uint8Array>
): Promise<{ credentialId: string; output: Uint8Array } | { failure: PasskeyFailure }> {
    const ids = [...salts.keys()];
    // One candidate asks with `eval`, which every PRF browser understands;
    // several need a salt each, which is what `evalByCredential` is for.
    const prf =
        ids.length === 1
            ? { eval: { first: salts.get(ids[0]!)! } }
            : {
                  evalByCredential: Object.fromEntries(
                      ids.map((id) => [id, { first: salts.get(id)! }])
                  )
              };
    let assertion: Credential | null;
    try {
        assertion = await navigator.credentials.get({
            publicKey: {
                challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
                rpId: window.location.hostname,
                allowCredentials: ids.map((id) => ({
                    type: "public-key" as const,
                    id: fromBase64Url(id)
                })),
                userVerification: "required",
                timeout: 120_000,
                extensions: { prf } as AuthenticationExtensionsClientInputs
            }
        });
    } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        return {
            failure: name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "failed"
        };
    }
    if (!assertion || !("getClientExtensionResults" in assertion)) return { failure: "failed" };
    const key = assertion as PublicKeyCredential;
    const first = (key.getClientExtensionResults() as PrfResults).prf?.results?.first;
    if (!first) return { failure: "no-prf" };
    const output = toBytes(first);
    if (output.length < crypto.PASSKEY_PRF_BYTES) return { failure: "no-prf" };
    return { credentialId: toBase64Url(new Uint8Array(key.rawId)), output };
}

/**
 * Everything the server is sent to enroll a passkey: the wrap, the salt, the
 * credential id and the master password hash. The PRF output is used here and
 * dropped; there is no field for it.
 */
export async function buildEnrollment(input: {
    vaultKey: crypto.SymmetricKey;
    credentialId: string;
    prfOutput: Uint8Array;
    prfSalt: Uint8Array;
    rpId: string;
    name: string;
    masterPasswordHash: string;
}): Promise<VaultPasskeyEnrollInput> {
    return {
        masterPasswordHash: input.masterPasswordHash,
        credentialId: input.credentialId,
        rpId: input.rpId,
        prfSalt: crypto.toBase64(input.prfSalt),
        wrappedKey: await crypto.wrapVaultKeyWithPasskey(
            input.vaultKey,
            input.prfOutput,
            input.prfSalt
        ),
        name: input.name
    };
}

/** Ask one of the account's passkeys for a PRF output and wrap the vault key under it. */
export async function enrollWithPasskey(input: {
    vaultKey: crypto.SymmetricKey;
    candidates: readonly string[];
    name: string;
    masterPasswordHash: string;
}): Promise<{ enrollment: VaultPasskeyEnrollInput } | { failure: PasskeyFailure }> {
    if (input.candidates.length === 0) return { failure: "failed" };
    // One salt for whichever passkey answers: it is drawn before anybody knows
    // which one that will be, and stored against the one that did.
    const salt = crypto.generatePasskeyPrfSalt();
    const result = await evaluatePrf(new Map(input.candidates.map((id) => [id, salt])));
    if ("failure" in result) return result;
    const enrollment = await buildEnrollment({
        vaultKey: input.vaultKey,
        credentialId: result.credentialId,
        prfOutput: result.output,
        prfSalt: salt,
        rpId: window.location.hostname,
        name: input.name,
        masterPasswordHash: input.masterPasswordHash
    });
    // Proved before it is sent: a wrap this tab cannot open again is a passkey
    // that would sit in the list and never unlock anything.
    const check = await crypto.unwrapVaultKeyWithPasskey(
        enrollment.wrappedKey,
        result.output,
        salt
    );
    result.output.fill(0);
    return check ? { enrollment } : { failure: "failed" };
}

/** The enrolled passkeys this address can use: a passkey only answers on its own. */
export function usablePasskeys(
    entries: readonly VaultPasskeyEntry[] | undefined
): VaultPasskeyEntry[] {
    if (!entries || typeof window === "undefined") return [];
    return entries.filter((entry) => entry.rpId === window.location.hostname);
}

/** Open the vault with whichever enrolled passkey the person picks. */
export async function unlockWithPasskey(
    entries: readonly VaultPasskeyEntry[]
): Promise<{ key: crypto.SymmetricKey; id: string } | { failure: PasskeyFailure }> {
    if (entries.length === 0) return { failure: "failed" };
    const salts = new Map(
        entries.map((entry) => [entry.credentialId, crypto.fromBase64(entry.prfSalt)])
    );
    const result = await evaluatePrf(salts);
    if ("failure" in result) return result;
    const entry = entries.find((candidate) => candidate.credentialId === result.credentialId);
    if (!entry) return { failure: "wrong" };
    const key = await crypto.unwrapVaultKeyWithPasskey(
        entry.wrappedKey,
        result.output,
        salts.get(entry.credentialId)!
    );
    result.output.fill(0);
    return key ? { key, id: entry.id } : { failure: "stale" };
}

/**
 * The passkey lock (design 3.2): the account key sealed under the output of the
 * WebAuthn PRF extension (Level 3, 10.1.4), asked for in the same gesture as
 * signing in with the passkey.
 *
 * PRF is uneven across browsers, so this lock is only ever an extra one: a
 * passkey or a browser that gives back no PRF output yields `null` from
 * `prfOutputOf`, no lock is created, and nothing else changes - no error, no
 * prompt, no different sign-in.
 *
 * The PRF input is one fixed, domain-separated value rather than one per
 * account or per credential: the passkey sign-in is usernameless (the browser's
 * own chooser picks the account), so the input has to be asked for before
 * anybody - client or server - knows which account is signing in. The
 * authenticator's own per-credential secret, mixed with the relying party by
 * the browser, is what makes the output unique to one passkey on one site. The
 * account and the credential id are in the envelope's binding, so an envelope
 * made for one passkey never opens under another's output.
 *
 * The output never leaves the tab: the assertion posted to the server is built
 * field by field and carries no extension results.
 */

import { canonical, owned } from "./bytes";
import { importLockSecret, openAccountKey, sealAccountKey, type LockBinding } from "./locks";

const PRF_LABEL = "polaris/chat-e2ee/ak-lock/v1/passkey-prf-input";
export const PRF_OUTPUT_BYTES = 32;

/** The PRF input (`eval.first`) every passkey sign-in asks for. */
export async function prfInput(): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", owned(canonical(PRF_LABEL))));
}

/** The `extensions` member to add to `navigator.credentials.get` options. */
export async function prfExtension(): Promise<{ prf: { eval: { first: Uint8Array<ArrayBuffer> } } }> {
    return { prf: { eval: { first: await prfInput() } } };
}

type PrfClientResults = { prf?: { results?: { first?: BufferSource } } };

/**
 * The PRF output an assertion carried, or null when there is none - which is
 * the ordinary case on a browser or authenticator without PRF, not an error.
 */
export function prfOutputOf(clientExtensionResults: unknown): Uint8Array | null {
    const first = (clientExtensionResults as PrfClientResults | null)?.prf?.results?.first;
    if (!first) return null;
    const bytes =
        first instanceof ArrayBuffer
            ? new Uint8Array(first)
            : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    return bytes.length >= PRF_OUTPUT_BYTES ? new Uint8Array(bytes) : null;
}

function bindingFor(userId: string, credentialId: string, akVersion: number): LockBinding {
    if (!credentialId) throw new RangeError("A passkey lock names its credential");
    return { userId, kind: "passkey-prf", lockId: credentialId, akVersion };
}

export async function sealWithPasskey(
    accountKey: Uint8Array,
    prfOutput: Uint8Array,
    userId: string,
    credentialId: string,
    akVersion: number
): Promise<Uint8Array> {
    const key = await importLockSecret(prfOutput);
    return sealAccountKey(accountKey, key, bindingFor(userId, credentialId, akVersion));
}

export async function openWithPasskey(
    envelope: Uint8Array,
    prfOutput: Uint8Array,
    userId: string,
    credentialId: string,
    akVersion: number
): Promise<Uint8Array> {
    const key = await importLockSecret(prfOutput);
    return openAccountKey(envelope, key, bindingFor(userId, credentialId, akVersion));
}

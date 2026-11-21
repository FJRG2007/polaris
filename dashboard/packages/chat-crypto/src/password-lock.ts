/**
 * The password lock, client half (design 3.2 and owner objective "a breached
 * server yields no messages"): OPAQUE (RFC 9807) through `@serenity-kit/opaque`,
 * which wraps `opaque-ke` (ristretto255, triple-DH) compiled to WebAssembly.
 *
 * The password never leaves this tab, not even at registration. OPAQUE's
 * `exportKey` - a secret only someone who knows the password can compute, and
 * which the server never sees - is imported straight into a non-extractable
 * HKDF key and becomes the lock secret for the account key's envelope.
 *
 * The key-stretching function is Argon2id at 128 MiB (the order Threema
 * Desktop uses), as a closed list of one versioned profile: the profile is not
 * read from the server, so a malicious server cannot talk a client down to
 * cheaper parameters (11.1 items 7 and 13). Raising it later means a v2 profile
 * the client tries after v1, never a value the server supplies.
 */

import { fromBase64Url } from "./bytes";
import * as opaque from "@serenity-kit/opaque";
import { importLockSecret, openAccountKey, sealAccountKey, type LockBinding } from "./locks";

/** The one key-stretching profile: Argon2id, 128 MiB, 3 passes, 1 lane. */
export const PASSWORD_KSF_V1 = {
    "argon2id-custom": { memory: 131072, iterations: 3, parallelism: 1 }
} as const;

/** The password lock's id inside its binding. One per account. */
export const PASSWORD_LOCK_ID = "password";

/** A wrong password, told apart from a broken exchange only at this layer. */
export class PasswordRejectedError extends Error {
    constructor() {
        super("The password did not match");
        this.name = "PasswordRejectedError";
    }
}

function identifiersFor(userId: string): { client: string } {
    if (!userId) throw new RangeError("A password lock belongs to an account");
    return { client: userId };
}

function bindingFor(userId: string, akVersion: number): LockBinding {
    return { userId, kind: "password", lockId: PASSWORD_LOCK_ID, akVersion };
}

async function lockKeyFrom(exportKey: string): Promise<CryptoKey> {
    const bytes = fromBase64Url(exportKey);
    try {
        return await importLockSecret(bytes);
    } finally {
        bytes.fill(0);
    }
}

export async function startPasswordRegistration(
    password: string
): Promise<{ state: string; registrationRequest: string }> {
    await opaque.ready;
    const started = opaque.client.startRegistration({ password });
    return { state: started.clientRegistrationState, registrationRequest: started.registrationRequest };
}

/**
 * Finish registering. Returns the OPAQUE record (for the server) and the lock
 * key (which stays here); with an account key given, also its envelope sealed
 * under the new password lock.
 */
export async function finishPasswordRegistration(input: {
    readonly state: string;
    readonly registrationResponse: string;
    readonly password: string;
    readonly userId: string;
    readonly accountKey?: Uint8Array;
    readonly akVersion?: number;
}): Promise<{ registrationRecord: string; lockKey: CryptoKey; envelope: Uint8Array | null }> {
    await opaque.ready;
    const finished = opaque.client.finishRegistration({
        clientRegistrationState: input.state,
        registrationResponse: input.registrationResponse,
        password: input.password,
        identifiers: identifiersFor(input.userId),
        keyStretching: PASSWORD_KSF_V1
    });
    const lockKey = await lockKeyFrom(finished.exportKey);
    const envelope =
        input.accountKey && input.akVersion !== undefined
            ? await sealWithPassword(input.accountKey, lockKey, input.userId, input.akVersion)
            : null;
    return { registrationRecord: finished.registrationRecord, lockKey, envelope };
}

/** The account key sealed under a password lock key from a finished exchange. */
export async function sealWithPassword(
    accountKey: Uint8Array,
    lockKey: CryptoKey,
    userId: string,
    akVersion: number
): Promise<Uint8Array> {
    return sealAccountKey(accountKey, lockKey, bindingFor(userId, akVersion));
}

export async function startPasswordLogin(
    password: string
): Promise<{ state: string; startLoginRequest: string }> {
    await opaque.ready;
    const started = opaque.client.startLogin({ password });
    return { state: started.clientLoginState, startLoginRequest: started.startLoginRequest };
}

/**
 * Finish the OPAQUE login. A wrong password - or a server that is not the one
 * the record was made with - throws PasswordRejectedError and sends nothing.
 * The lock key stays in this tab; only `finishLoginRequest` goes to the server.
 */
export async function finishPasswordLogin(input: {
    readonly state: string;
    readonly loginResponse: string;
    readonly password: string;
    readonly userId: string;
}): Promise<{ finishLoginRequest: string; lockKey: CryptoKey }> {
    await opaque.ready;
    const finished = opaque.client.finishLogin({
        clientLoginState: input.state,
        loginResponse: input.loginResponse,
        password: input.password,
        identifiers: identifiersFor(input.userId),
        keyStretching: PASSWORD_KSF_V1
    });
    if (!finished) throw new PasswordRejectedError();
    return {
        finishLoginRequest: finished.finishLoginRequest,
        lockKey: await lockKeyFrom(finished.exportKey)
    };
}

/** The account key out of the password envelope the server released. */
export async function openWithPassword(
    envelope: Uint8Array,
    lockKey: CryptoKey,
    userId: string,
    akVersion: number
): Promise<Uint8Array> {
    return openAccountKey(envelope, lockKey, bindingFor(userId, akVersion));
}

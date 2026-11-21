/**
 * The browser half of the OPAQUE password sign-in and of the adoption that
 * moves an existing account onto it (docs/chat-e2ee-phase1.md).
 *
 * Only ever called by the sign-in form when the server rendered it with the
 * internal flag on; with the flag off the form never imports a byte of this.
 *
 * Neither function can make a sign-in fail. `signInWithOpaque` returns null for
 * anything short of a session - a wrong password, an account not moved yet, a
 * network error - and the form then signs in the old way. `adoptOpaque` runs
 * after the old way succeeded and swallows every failure: the account stays on
 * its password hash and the next sign-in tries again.
 */

import type { SignInBody } from "@/lib/chat/e2ee/schemas";
import * as deviceLock from "@polaris/chat-crypto/device-lock";
import { LOCK_ENVELOPE_BYTES } from "@polaris/chat-crypto/locks";
import * as passwordLock from "@polaris/chat-crypto/password-lock";

const ROUTE = "/api/e2ee/sign-in";

function fromText(value: string): Uint8Array {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function post<T>(body: SignInBody): Promise<T | null> {
    try {
        const response = await fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(body)
        });
        return response.ok ? ((await response.json()) as T) : null;
    } catch {
        return null;
    }
}

interface Started {
    readonly loginId: string;
    readonly loginResponse: string;
    readonly userId: string;
}

interface ReleasedLock {
    readonly akVersion: number;
    readonly envelope: string;
}

/** Open the released password envelope and keep the account key behind this
 *  browser's device lock. Best effort: a failure leaves nothing half-written. */
async function keepAccountKey(userId: string, lockKey: CryptoKey, released: ReleasedLock | null) {
    if (!released) return;
    try {
        const envelope = fromText(released.envelope);
        if (envelope.length !== LOCK_ENVELOPE_BYTES) return;
        const accountKey = await passwordLock.openWithPassword(envelope, lockKey, userId, released.akVersion);
        await deviceLock.createDeviceLock(
            deviceLock.indexedDbDeviceLockStore(),
            userId,
            accountKey,
            released.akVersion
        );
        accountKey.fill(0);
    } catch {
        // Not a reason to fail a sign-in; another lock opens it later.
    }
}

/**
 * Sign in over OPAQUE. Returns whether a second factor is still owed, or null
 * when the old password sign-in should run instead.
 */
export async function signInWithOpaque(
    email: string,
    password: string
): Promise<{ challenged: boolean } | null> {
    try {
        const started = await passwordLock.startPasswordLogin(password);
        const step = await post<Started>({
            op: "sign-in-start",
            email,
            startLoginRequest: started.startLoginRequest
        });
        if (!step) return null;
        const finished = await passwordLock.finishPasswordLogin({
            state: started.state,
            loginResponse: step.loginResponse,
            password,
            userId: step.userId
        });
        const done = await post<{ challenged: boolean; passwordLock: ReleasedLock | null }>({
            op: "sign-in-finish",
            loginId: step.loginId,
            finishLoginRequest: finished.finishLoginRequest
        });
        if (!done) return null;
        await keepAccountKey(step.userId, finished.lockKey, done.passwordLock);
        return { challenged: done.challenged === true };
    } catch {
        return null;
    }
}

/**
 * Move the account onto OPAQUE, right after the old password sign-in accepted
 * this password: register a record, then prove it with a full login before the
 * server will ever sign in with it. Never throws.
 */
export async function adoptOpaque(email: string, password: string): Promise<boolean> {
    try {
        const registration = await passwordLock.startPasswordRegistration(password);
        const answered = await post<{ userId: string; registrationResponse: string }>({
            op: "adopt-start",
            email,
            registrationRequest: registration.registrationRequest
        });
        if (!answered) return false;
        const made = await passwordLock.finishPasswordRegistration({
            state: registration.state,
            registrationResponse: answered.registrationResponse,
            password,
            userId: answered.userId
        });
        const stored = await post<{ stored: boolean }>({
            op: "adopt-finish",
            email,
            password,
            registrationRecord: made.registrationRecord
        });
        if (!stored) return false;

        const login = await passwordLock.startPasswordLogin(password);
        const step = await post<Started>({ op: "verify-start", email, startLoginRequest: login.startLoginRequest });
        if (!step) return false;
        const finished = await passwordLock.finishPasswordLogin({
            state: login.state,
            loginResponse: step.loginResponse,
            password,
            userId: step.userId
        });
        const verified = await post<{ verified: boolean }>({
            op: "verify-finish",
            loginId: step.loginId,
            finishLoginRequest: finished.finishLoginRequest
        });
        return verified?.verified === true;
    } catch {
        return false;
    }
}

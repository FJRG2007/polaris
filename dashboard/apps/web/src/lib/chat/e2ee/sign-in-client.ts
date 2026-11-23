/**
 * The browser half of the OPAQUE password sign-in and of the adoption that
 * moves an existing account onto it (docs/chat-e2ee-phase1.md).
 *
 * Called by the sign-in form when the server rendered it with the password
 * lock on; with the kill switch the form loads it only to retry a password the
 * old route refused (`signInWithOpaque` alone, never the adoption), for the
 * accounts whose password was set over OPAQUE and exists nowhere else.
 *
 * Neither function can make a sign-in fail or slow it down by more than one
 * Argon2id run. `signInWithOpaque` returns null for anything short of a
 * session - a wrong password, an account not moved yet, a worker that did not
 * start, a network error - and the form then signs in the old way. Everything
 * after the session exists (the adoption, opening or sealing the account key)
 * is queued here in the background and never awaited by the form: the
 * redirect does not wait for it, it swallows every failure, and the next
 * sign-in tries again. Every Argon2id runs in the password worker.
 */

import type { SignInBody } from "@/lib/chat/e2ee/schemas";
import type { PasswordKsfVersion } from "@polaris/chat-crypto/password-lock";
import { settleAfterPassword } from "@/lib/chat/e2ee/account-key-client";
import * as passwordLock from "@/lib/chat/e2ee/password-worker-client";

const ROUTE = "/api/e2ee/sign-in";

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
    /** The record's key-stretching profile; absent from a host that predates v2. */
    readonly ksfVersion?: PasswordKsfVersion;
}

interface ReleasedLock {
    readonly akVersion: number;
    readonly envelope: string;
}

/** The background work after a sign-in, one job after another. */
let queue: Promise<unknown> = Promise.resolve();

function inBackground(job: () => Promise<unknown>): Promise<void> {
    const next = queue.then(job).then(
        () => undefined,
        () => undefined
    );
    queue = next;
    return next;
}

/** Settles once every queued background job has. For tests and the sign-out path. */
export function backgroundIdle(): Promise<void> {
    return queue.then(() => undefined);
}

/**
 * Sign in over OPAQUE: one Argon2id run, in the worker. Returns whether a second
 * factor is still owed, or null when the old password sign-in should run
 * instead. With a full session, the account key is settled in the background.
 */
export async function signInWithOpaque(
    email: string,
    password: string,
    onStretching?: () => void
): Promise<{ challenged: boolean } | null> {
    try {
        const started = await passwordLock.startPasswordLogin(password);
        const step = await post<Started>({
            op: "sign-in-start",
            email,
            startLoginRequest: started.startLoginRequest
        });
        if (!step) return null;
        onStretching?.();
        const finished = await passwordLock.finishPasswordLogin({
            state: started.state,
            loginResponse: step.loginResponse,
            password,
            userId: step.userId,
            ksfVersion: step.ksfVersion
        });
        const done = await post<{ challenged: boolean; passwordLock: ReleasedLock | null }>({
            op: "sign-in-finish",
            loginId: step.loginId,
            finishLoginRequest: finished.finishLoginRequest
        });
        if (!done) return null;
        // The released envelope opens with this login's own lock key, so the
        // usual case needs no second login at all.
        if (done.challenged !== true)
            void inBackground(() =>
                settleAfterPassword(password, {
                    lockKey: finished.lockKey,
                    userId: step.userId,
                    lock: done.passwordLock
                })
            );
        return { challenged: done.challenged === true };
    } catch {
        return null;
    }
}

/**
 * Move the account onto OPAQUE, right after the old password sign-in accepted
 * this password: register a record, then prove it with a full login before the
 * server will ever sign in with it. With a full session already issued, the
 * account key is then settled on the adopted record. Never throws.
 */
export async function adoptOpaque(email: string, password: string, fullSession = false): Promise<boolean> {
    const adopted = await adopt(email, password);
    if (adopted && fullSession) await settleAfterPassword(password, null);
    return adopted;
}

/** `adoptOpaque` queued behind the sign-in, so the redirect never waits for it. */
export function adoptInBackground(email: string, password: string, fullSession: boolean): Promise<void> {
    return inBackground(() => adoptOpaque(email, password, fullSession));
}

/**
 * After the second factor was answered: settle the account key with the held
 * password, once any adoption queued by the sign-in has finished.
 */
export function settleInBackground(password: string): Promise<void> {
    return inBackground(() => settleAfterPassword(password, null));
}

async function adopt(email: string, password: string): Promise<boolean> {
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
            registrationRecord: made.registrationRecord,
            ksfVersion: made.ksfVersion
        });
        if (!stored) return false;

        const login = await passwordLock.startPasswordLogin(password);
        const step = await post<Started>({ op: "verify-start", email, startLoginRequest: login.startLoginRequest });
        if (!step) return false;
        const finished = await passwordLock.finishPasswordLogin({
            state: login.state,
            loginResponse: step.loginResponse,
            password,
            userId: step.userId,
            ksfVersion: step.ksfVersion
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

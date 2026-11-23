/**
 * The browser half of proving and setting a password without sending it
 * (docs/chat-e2ee-phase1.md, "Password flows over OPAQUE").
 *
 * A form asks `opaquePasswordReady()` first. When it answers with the account's
 * identity, the account has a verified OPAQUE record for its current password
 * and the form runs `provePassword` / `prepareNewPassword`, handing the server
 * action only what they return. When it answers null - the password lock is
 * switched off, the account has not moved yet, the host predates these routes,
 * or the network failed - the form uses its old action, which still takes the
 * password. Every Argon2id runs in the password worker; a worker that does not
 * start throws `PasswordFlowUnavailable` before anything was sent, and the form
 * falls back the same way.
 */

import type { StepUpProofInput } from "@polaris/core";
import type { KeysBody, OpaqueFinish } from "@/lib/chat/e2ee/schemas";
import { keyState } from "@/lib/chat/e2ee/account-key-client";
import { settleInBackground } from "@/lib/chat/e2ee/sign-in-client";
import type { PasswordKsfVersion } from "@polaris/chat-crypto/password-lock";
import * as passwordWorker from "@/lib/chat/e2ee/password-worker-client";
import { startCheckedRegistration, type PasswordIdentity } from "@/lib/chat/e2ee/password-rules";

const ROUTE = "/api/e2ee/keys";

/** The OPAQUE path cannot run here; the form uses its old action instead. */
export class PasswordFlowUnavailable extends Error {
    constructor() {
        super("The password cannot be handled over OPAQUE here");
        this.name = "PasswordFlowUnavailable";
    }
}

interface Started {
    readonly loginId: string;
    readonly loginResponse: string;
    readonly userId: string;
    readonly ksfVersion?: PasswordKsfVersion;
}

async function post<T>(body: KeysBody): Promise<T> {
    let response: Response;
    try {
        response = await fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(body)
        });
    } catch {
        throw new PasswordFlowUnavailable();
    }
    if (!response.ok) throw new PasswordFlowUnavailable();
    return (await response.json()) as T;
}

/** The account's identity when its password can be proven and set over OPAQUE,
 *  or null when the form should use its old action. Never throws. */
export async function opaquePasswordReady(): Promise<PasswordIdentity | null> {
    try {
        const state = await keyState();
        return state?.adopted === true && state.identity ? state.identity : null;
    } catch {
        return null;
    }
}

/** A worker failure before anything reached the server reads as "use the old
 *  action"; a refused password is passed on as it is. */
async function inWorker<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof Error && caught.name === "PasswordRejectedError") throw caught;
        if (caught instanceof Error && caught.name === "PasswordRuleError") throw caught;
        throw new PasswordFlowUnavailable();
    }
}

/** Finish a login the server action completes. A wrong password ends the
 *  client's half with nothing to send: the action is still called, without a
 *  finish, so the attempt is spent, counted and audited on the server. */
async function finishFor(password: string, state: string, step: Started): Promise<OpaqueFinish> {
    try {
        const finished = await passwordWorker.finishPasswordLogin({
            state,
            loginResponse: step.loginResponse,
            password,
            userId: step.userId,
            ksfVersion: step.ksfVersion
        });
        return { loginId: step.loginId, finishLoginRequest: finished.finishLoginRequest };
    } catch (caught) {
        if (caught instanceof Error && caught.name === "PasswordRejectedError") return { loginId: step.loginId };
        throw new PasswordFlowUnavailable();
    }
}

/** A proof of the current password for one server action (single use). */
export async function provePassword(password: string): Promise<OpaqueFinish> {
    const started = await inWorker(() => passwordWorker.startPasswordLogin(password));
    const step = await post<Started>({ op: "proof-start", startLoginRequest: started.startLoginRequest });
    return finishFor(password, started.state, step);
}

/**
 * A new password, checked against Polaris's rules (throws `PasswordRuleError`),
 * registered and then verified by a full login - all before the server action
 * that commits it runs. Returns that login's finish for the action.
 */
export async function prepareNewPassword(password: string, identity: PasswordIdentity): Promise<OpaqueFinish> {
    const registration = await inWorker(() => startCheckedRegistration(password, identity));
    const answered = await post<{ userId: string; registrationResponse: string }>({
        op: "set-start",
        registrationRequest: registration.registrationRequest
    });
    const made = await inWorker(() =>
        passwordWorker.finishPasswordRegistration({
            state: registration.state,
            registrationResponse: answered.registrationResponse,
            password,
            userId: answered.userId
        })
    );
    const login = await inWorker(() => passwordWorker.startPasswordLogin(password));
    const step = await post<Started>({
        op: "set-verify",
        registrationRecord: made.registrationRecord,
        ksfVersion: made.ksfVersion,
        startLoginRequest: login.startLoginRequest
    });
    const finish = await finishFor(password, login.state, step);
    // Our own record refusing our own password means something is broken, not
    // a typo: nothing is committed and the form falls back.
    if (!finish.finishLoginRequest) throw new PasswordFlowUnavailable();
    return finish;
}

/** After a new password was committed: seal the account key's password lock
 *  under it from what this browser holds, in the background. */
export function resealAfterNewPassword(password: string): void {
    void settleInBackground(password);
}

/** What a form sends where it used to send the account password: a proof when
 *  the account can give one, the password itself otherwise and on every
 *  fallback. `onStretching` fires when the key stretching is about to run. */
export async function sentPassword(password: string, onStretching?: () => void): Promise<string | OpaqueFinish> {
    if (!password || !(await opaquePasswordReady())) return password;
    try {
        onStretching?.();
        return await provePassword(password);
    } catch {
        return password;
    }
}

/** A step-up proof as it is sent: a typed password becomes its OPAQUE proof when
 *  the account can give one, anything else (and every fallback) goes as it is.
 *  `onStretching` fires when the key stretching is about to run. */
export async function sentStepUpProof(
    proof: StepUpProofInput,
    onStretching?: () => void
): Promise<StepUpProofInput | ({ proof: "opaque-password" } & OpaqueFinish)> {
    if (proof.proof !== "password" || !(await opaquePasswordReady())) return proof;
    try {
        onStretching?.();
        return { proof: "opaque-password", ...(await provePassword(proof.password)) };
    } catch {
        return proof;
    }
}

"use server";

/**
 * The enrollment step's own actions: send a code to the account's address, and
 * arm the factor with it.
 *
 * Both resolve the session with resolveSession() rather than requireUser(), for
 * the reason every screen behind a gate does - requireUser() is what sent the
 * person here, so calling it from here would bounce them back to the page they
 * are already on. They are still refused outright without a session: this arms a
 * factor on an account, and nothing about being on the enrollment screen makes
 * that safe to do unauthenticated.
 *
 * The authenticator path is not here. It runs through better-auth's browser
 * client, exactly as it does from Account > Security, so the two ways of arming an
 * authenticator are the same code and cannot drift apart.
 */

import { headers } from "next/headers";
import { resolveSession } from "@/lib/session";
import { setTotpUnclaimed } from "@polaris/auth";
import { armFactorByEmail, sendEnrollmentCode } from "@/lib/second-factor-enrollment";

interface ActionResult {
    error?: string;
    ok?: string;
}

export async function sendEnrollmentCodeAction(): Promise<ActionResult & { sentTo?: string }> {
    const user = await resolveSession();
    if (!user) return { error: "Sign in again." };
    const result = await sendEnrollmentCode(user.id);
    if (result.error) return { error: result.error };
    return { ok: "Code sent.", sentTo: result.sentTo };
}

export async function armByEmailAction(
    password: unknown,
    code: unknown
): Promise<ActionResult & { backupCodes?: string[] }> {
    const user = await resolveSession();
    if (!user) return { error: "Sign in again." };
    if (typeof password !== "string" || password.length === 0) return { error: "Enter your password." };
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return { error: "Enter the 6-digit code." };

    const result = await armFactorByEmail(user.id, await headers(), password, code);
    if (result.error) return { error: result.error };
    return { ok: "Two-step verification is on.", backupCodes: result.backupCodes };
}

/**
 * Note that the authenticator the browser just verified is a real one.
 *
 * The client arms it through better-auth directly, so this is how the server hears
 * about it. It only ever clears the mark, which is why it is safe for the browser
 * to be the one that reports it: the worst a spurious call does is stop offering an
 * emailed code to somebody who already has an authenticator, and the mark is
 * re-read from the account rather than trusted from the request.
 */
export async function noteAuthenticatorArmedAction(): Promise<ActionResult> {
    const user = await resolveSession();
    if (!user) return { error: "Sign in again." };
    await setTotpUnclaimed(user.id, false);
    return { ok: "Two-step verification is on." };
}

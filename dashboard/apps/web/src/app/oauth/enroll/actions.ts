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
import type { EnrollmentChoice } from "./enroll-view";
import { enrollmentOptions, owesSecondFactor } from "@/lib/instance-security";
import { armFactorByEmail, sendEnrollmentCode } from "@/lib/second-factor-enrollment";

interface ActionResult {
    error?: string;
    ok?: string;
}

/** What the enrollment step would ask of the account that has just signed in, or
 *  null when it would ask nothing. */
export interface PendingEnrollment {
    readonly account: string;
    readonly name: string;
    readonly options: EnrollmentChoice[];
}

/**
 * Whether the account that just registered still owes a second factor, and what
 * it may arm one with.
 *
 * The same two questions the enrollment page asks on the server, asked from the
 * browser instead. It exists so registering can finish the enrollment on the page
 * it is already on, while the password the person typed a second ago is still in
 * the form they typed it into - navigating to the enrollment screen would leave
 * that behind and have to ask for it again, which is asking somebody to confirm
 * they are themselves moments after proving it.
 */
export async function pendingEnrollmentAction(): Promise<PendingEnrollment | null> {
    const user = await resolveSession();
    if (!user || !(await owesSecondFactor(user.id))) return null;
    return { account: user.email, name: user.name, options: await enrollmentOptions(user.id) };
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

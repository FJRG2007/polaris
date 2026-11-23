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
import { getTranslations } from "@/lib/i18n/request";
import { setTotpUnclaimed } from "@polaris/auth";
import type { EnrollmentChoice } from "./enroll-view";
import { enrollmentOptions, owesPhone, owesSecondFactor } from "@/lib/instance-security";
import { removePhoneFor, sendPhoneCodeFor, setPhoneFor, verifyPhoneFor } from "@/app/(app)/account/security/phone-steps";
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
    const t = await getTranslations("auth");
    const user = await resolveSession();
    if (!user) return { error: t("enroll.errors.signInAgain") };
    const result = await sendEnrollmentCode(user.id);
    if (result.error) return { error: result.error };
    return { ok: t("enroll.codeSent"), sentTo: result.sentTo };
}

export async function armByEmailAction(
    password: unknown,
    code: unknown
): Promise<ActionResult & { backupCodes?: string[] }> {
    const t = await getTranslations("auth");
    const user = await resolveSession();
    if (!user) return { error: t("enroll.errors.signInAgain") };
    if (typeof password !== "string" || password.length === 0) return { error: t("enroll.errors.enterPassword") };
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return { error: t("enroll.errors.enterCode") };

    const result = await armFactorByEmail(user.id, await headers(), password, code);
    if (result.error) return { error: result.error };
    return { ok: t("enroll.armed"), backupCodes: result.backupCodes };
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
    const t = await getTranslations("auth");
    const user = await resolveSession();
    if (!user) return { error: t("enroll.errors.signInAgain") };
    await setTotpUnclaimed(user.id, false);
    return { ok: t("enroll.armed") };
}

/**
 * The phone the instance requires, written and confirmed from the enrollment step.
 *
 * The same steps Account > Details runs, with two differences that are what make
 * this step completable. The session is resolved directly, because the guard is
 * what sent the person here. And the new-device wait is not applied: this is a
 * sign-in that has just happened, so it is always a new device, and the wait would
 * hold the account on a step it is not allowed to finish. What bounds that is the
 * first check - these act only for an account the requirement is holding right
 * now, and writing the number still asks for the password.
 */
async function heldForPhone(): Promise<{ userId: string } | ActionResult> {
    const t = await getTranslations("auth");
    const user = await resolveSession();
    if (!user) return { error: t("enroll.errors.signInAgain") };
    if (!(await owesPhone(user.id))) return { error: t("enroll.phone.nothingOwed") };
    return { userId: user.id };
}

export async function enrollSetPhoneAction(input: unknown): Promise<ActionResult> {
    const held = await heldForPhone();
    return "userId" in held ? setPhoneFor(held.userId, input) : held;
}

export async function enrollRemovePhoneAction(password: unknown): Promise<ActionResult> {
    const held = await heldForPhone();
    return "userId" in held ? removePhoneFor(held.userId, password) : held;
}

export async function enrollSendPhoneCodeAction(): Promise<ActionResult> {
    const held = await heldForPhone();
    return "userId" in held ? sendPhoneCodeFor(held.userId) : held;
}

export async function enrollVerifyPhoneAction(code: unknown): Promise<ActionResult> {
    const held = await heldForPhone();
    return "userId" in held ? verifyPhoneFor(held.userId, code) : held;
}

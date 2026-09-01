"use server";

/**
 * Profile self-service actions. Each re-resolves the session, so a user can only
 * ever change their own profile or addresses. The credential work (verify, hash)
 * lives in @polaris/auth so there is one source of truth for how passwords are
 * stored; password and security settings live under ./security.
 *
 * The addresses, the username and the linked GitHub account are identity rather
 * than presentation - they are what a password reset is sent to and what the
 * account is known by - so each passes the new-device gate when the account has
 * asked for one. A display name or a company is left alone by it: those change
 * nothing about who can get in.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { emailField, USERNAME_COOLDOWN_KEY, usernameCooldownDays } from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getSetting } from "@/lib/setting-store";
import { rateLimit } from "@/lib/rate-limit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import {
    saveProfileDetails,
    setProfileCompanies,
    setProfileOrganizations
} from "@/lib/profile-service";
import { requestEmailVerification } from "@/lib/email-verification-service";
import {
    addUserEmail,
    promoteUserEmail,
    removeUserEmail,
    setUserEmailRecovery,
    updateUserProfile
} from "@polaris/auth";

const emailIdSchema = z.string().uuid();

/** Verification links cost the provider's quota and land in someone's inbox, so
 *  asking for one is throttled per account. */
const VERIFY_LIMIT = 5;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Send a confirmation link to one of the user's own addresses. The service
 * checks the address really is theirs, so a forged id proves nothing.
 */
export async function verifyEmailAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = emailField.safeParse(input);
    if (!parsed.success) return { error: "Unknown address." };
    const throttle = await rateLimit(`email-verify:${user.id}`, VERIFY_LIMIT, VERIFY_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many requests. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
    }
    const result = await requestEmailVerification(user.id, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.verification-sent" });
    }
    return result;
}

/**
 * Whether a profile save would actually take a different username.
 *
 * The form sends every field on every save, so gating on "a username was sent"
 * would stop a new device fixing its display name for a week over a value it did
 * not touch. Compared the way a username is matched - trimmed and caseless -
 * since retyping the same name in different capitals is not a change.
 */
async function changesUsername(userId: string, username: string | null | undefined): Promise<boolean> {
    if (username === undefined) return false;
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    return (username ?? "").trim().toLowerCase() !== (row?.username ?? "").trim().toLowerCase();
}

const usernameCheckSchema = z.object({
    username: z.string().max(64),
    /** What the form currently holds, so a suggestion is built out of what
     *  somebody has just typed rather than out of what was saved last week. */
    display: z.string().max(120).optional(),
    firstName: z.string().max(120).optional(),
    lastName: z.string().max(120).optional()
});

/** How many handles one account may ask about in a minute. Generous enough that
 *  typing a name never reaches it - the field waits for a pause before it asks -
 *  and low enough that this is not a way to walk the namespace. */
const USERNAME_CHECKS_PER_MINUTE = 40;

/**
 * Whether a username is free, and what to take instead when it is not.
 *
 * Answered while somebody types, because a handle field that says nothing until
 * Save is a field they fill in, wait on, and are then told to try again with no
 * idea what would work.
 *
 * The shape of the handle is judged by `usernameField`, here and in the form, so
 * a name that is too short or has a space in it never reaches the database at
 * all. What this adds is the one question a schema cannot answer.
 *
 * It does reveal whether a handle exists, and that cannot be avoided: a field
 * that would not say so is a field that lets two people take the same name. It
 * is kept narrow - one handle per call, nothing about the account behind it, a
 * session required, and a ceiling per account per minute.
 */
export async function checkUsernameAction(
    input: unknown
): Promise<{ free?: boolean; problem?: string; suggestions?: string[]; error?: string }> {
    const user = await requireUser();
    const parsed = usernameCheckSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not a username" };

    const shape = core.usernameField.safeParse(parsed.data.username);
    if (!shape.success) {
        // The schema's own sentence, which is the one the form is already
        // showing. Answered rather than refused, so the field has one place to
        // read its verdict from.
        return { free: false, problem: shape.error.issues[0]?.message ?? "That username cannot be used", suggestions: [] };
    }

    const allowed = await rateLimit(`username-check:${user.id}`, USERNAME_CHECKS_PER_MINUTE, 60_000);
    if (!allowed.ok) return { error: "Too many checks. Wait a moment." };

    const { checkUsername } = await import("@/lib/username-availability");
    const verdict = await checkUsername(user.id, shape.data, {
        display: parsed.data.display,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        email: user.email
    });
    return { free: verdict.free, problem: verdict.problem, suggestions: [...verdict.suggestions] };
}

export async function updateProfileAction(input: {
    name?: string;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    company?: string | null;
    description?: string | null;
}): Promise<{ error?: string }> {
    const user = await requireUser();
    if (await changesUsername(user.id, input.username)) {
        const blocked = await newDeviceRefusal(user);
        if (blocked) return { error: blocked };
    }
    const result = await updateUserProfile(
        user.id,
        {
            name: typeof input.name === "string" ? input.name : undefined,
            firstName: input.firstName === undefined ? undefined : (input.firstName ?? ""),
            lastName: input.lastName === undefined ? undefined : (input.lastName ?? ""),
            username: input.username === undefined ? undefined : (input.username ?? ""),
            company: input.company === undefined ? undefined : (input.company ?? ""),
            description: input.description === undefined ? undefined : (input.description ?? "")
        },
        // The operator's wait between handle changes. Read here because the
        // setting store is the dashboard's, and the auth package deliberately
        // does not reach into it.
        { cooldownDays: usernameCooldownDays(await getSetting(USERNAME_COOLDOWN_KEY)) }
    );
    if (!result.error) revalidatePath("/account");
    return result;
}

/**
 * Where somebody works, on their own profile: the line they typed and the
 * organizations here they have marked as theirs.
 *
 * Its own action rather than another field on the profile form, because the two
 * halves are two different claims - one Polaris can vouch for, one it cannot -
 * and they are edited on their own card for the same reason.
 *
 * The ids arrive from a browser like any other list, so they are narrowed to
 * rosters this account is actually on before anything is stored: marking an
 * organization you are not in would put a tick beside a company you have nothing
 * to do with.
 */
const companiesSchema = z.object({
    // Several, because a person holds several at a time. Each is the same field
    // the single one was, so nothing about what one may say has changed.
    companies: z.array(core.companyField).max(core.MOST_COMPANIES),
    organizationIds: z.array(z.string().uuid()).max(50)
});

export async function saveCompaniesAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = companiesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check what you typed" };

    await setProfileCompanies(user.id, parsed.data.companies);
    await setProfileOrganizations(user.id, parsed.data.organizationIds);
    revalidatePath("/account");
    return {};
}

/**
 * The one line under somebody's name, how they want to be referred to, and the
 * addresses they hand out with themselves.
 *
 * Its own action beside the companies one and apart from the profile form, for
 * the same reason: three answers edited on one card, and a form that replaced
 * the whole account every time one of them changed would undo whatever the other
 * cards had saved since the page loaded.
 */
const detailsSchema = z.object({
    headline: core.headlineField,
    pronouns: core.pronounsField,
    links: core.profileLinksSchema
});

export async function saveProfileDetailsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = detailsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check what you typed" };
    await saveProfileDetails(user.id, parsed.data);
    revalidatePath("/account");
    return {};
}

export async function addEmailAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = emailField.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a valid email" };
    const result = await addUserEmail(user.id, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.added" });
        revalidatePath("/account");
    }
    return result;
}

export async function removeEmailAction(emailId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = emailIdSchema.safeParse(emailId);
    if (!parsed.success) return { error: "That address is no longer on your account." };
    const result = await removeUserEmail(user.id, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.removed" });
        revalidatePath("/account");
    }
    return result;
}

export async function setEmailRecoveryAction(emailId: unknown, recovery: boolean): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = emailIdSchema.safeParse(emailId);
    if (!parsed.success) return { error: "That address is no longer on your account." };
    const result = await setUserEmailRecovery(user.id, parsed.data, recovery === true);
    if (!result.error) {
        await recordAudit({
            actorId: user.id,
            action: recovery === true ? "account.email.recovery-set" : "account.email.recovery-cleared"
        });
        revalidatePath("/account");
    }
    return result;
}

export async function promoteEmailAction(emailId: unknown, currentPassword: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = emailIdSchema.safeParse(emailId);
    if (!parsed.success) return { error: "That address is no longer on your account." };
    const result = await promoteUserEmail(auth, user.id, parsed.data, String(currentPassword));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.primary-changed" });
        revalidatePath("/account");
    }
    return result;
}

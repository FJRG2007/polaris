"use server";

/**
 * The second factor's own settings: the phone number a code can be sent to, and
 * which methods the account will accept.
 *
 * Every action re-resolves the session, so a user only ever changes their own.
 * The ones that widen the ways into the account - writing a number, turning a
 * method on - re-verify the password inside @polaris/auth, and the confirmation
 * code is throttled per account because six digits is a guessable secret.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import { getTranslations } from "@/lib/i18n/request";
import { withProvenPassword } from "@polaris/auth";
import { opaqueFinish, passwordOrProof } from "@/lib/chat/e2ee/schemas";
import { provenPasswordHash, withPasswordOrProof, withPasswordProof } from "@/lib/chat/e2ee/opaque-password";
import { setLoginApprovalAction } from "./actions";
import { forwardAuthCookies } from "@/lib/auth-cookies";
import { methodLabel } from "./known-sentences";
import { firstIssue, localized } from "./action-messages";
import {
    CODE_CHECK_LIMIT,
    CODE_CHECK_WINDOW_MS,
    CODE_SEND_LIMIT,
    CODE_SEND_WINDOW_MS,
    addPhoneFor,
    makePhonePrimaryFor,
    removePhoneFor,
    sendPhoneCodeFor,
    verifyPhoneFor
} from "./phone-steps";
import { checkTelegramLink, startTelegramLink, unlinkTelegram } from "@/lib/messaging/telegram-link";
import { describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import { isStricter, twoFactorPolicySchema } from "@/lib/two-factor-policy";
import { loadTwoFactorPolicy, saveTwoFactorPolicy } from "@/lib/two-factor-policy-store";
import { twoFactorPreferencesSchema } from "@polaris/core";
import { getUserSecurity, regenerateBackupCodes, setTwoFactorPreferences, verifyAccountPassword } from "@polaris/auth";

type ActionResult = { error?: string };

export async function addPhoneAction(input: unknown): Promise<ActionResult & { id?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    return addPhoneFor(user.id, input);
}

export async function removePhoneAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    return removePhoneFor(user.id, input);
}

export async function makePhonePrimaryAction(id: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    return makePhonePrimaryFor(user.id, id);
}

/** Send a confirmation code to a number on the account (see sendPhoneCodeFor). */
export async function sendPhoneCodeAction(id?: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    return sendPhoneCodeFor(user.id, id);
}

/**
 * Start linking Telegram: a one-time deep link to the deployment's bot. Pressing
 * Start there is what lets the bot write to this person at all.
 */
export async function startTelegramLinkAction(): Promise<{ url?: string; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const throttle = await rateLimit(`telegram-link:${user.id}`, CODE_SEND_LIMIT, CODE_SEND_WINDOW_MS);
    if (!throttle.ok) {
        const t = await getTranslations("accountSecurity");
        return { error: t("errors.tooManyCodes", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }
    return localized(await startTelegramLink(user.id));
}

/** Whether the Start press arrived; binds the chat when it did. */
export async function checkTelegramLinkAction(): Promise<{ linked: boolean; error?: string }> {
    const user = await requireUser();
    const throttle = await rateLimit(`telegram-check:${user.id}`, 60, CODE_CHECK_WINDOW_MS);
    if (!throttle.ok) return { linked: false };
    const result = await checkTelegramLink(user.id);
    if (result.linked) {
        await recordAudit({ actorId: user.id, action: "account.telegram.linked" });
        revalidatePath("/account/security", "layout");
    }
    return result.error ? { linked: false, ...(await localized({ error: result.error })) } : result;
}

export async function unlinkTelegramAction(): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    await unlinkTelegram(user.id);
    await recordAudit({ actorId: user.id, action: "account.telegram.unlinked" });
    revalidatePath("/account/security", "layout");
    return {};
}

export async function verifyPhoneAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    return verifyPhoneFor(user.id, input);
}

/** How often one account may mint a set of backup codes. The endpoint checks a
 *  password, so it is a guessing surface as much as it is a control. */
const BACKUP_CODES_LIMIT = 5;
const BACKUP_CODES_WINDOW_MS = 15 * 60 * 1000;

const regenerateBackupCodesSchema = z.object({
    password: passwordOrProof
});

/**
 * Mint a fresh set of backup codes and hand them back once.
 *
 * The only path by which a user gets codes after enrolment, and the only way to
 * replace a set that has been spent, printed and lost, or read over somebody's
 * shoulder. It invalidates whatever is left of the old set, which is the point:
 * the answer to "my printout is compromised" has to be one action, not turning
 * the authenticator off and on again.
 *
 * The codes are returned to the caller and nowhere else - the audit line records
 * that a set was issued and how many, never the codes themselves.
 */
export async function regenerateBackupCodesAction(
    input: unknown
): Promise<{ codes?: string[]; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = regenerateBackupCodesSchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");
    const throttle = await rateLimit(`backup-codes:${user.id}`, BACKUP_CODES_LIMIT, BACKUP_CODES_WINDOW_MS);
    if (!throttle.ok) {
        const t = await getTranslations("accountSecurity");
        return { error: t("errors.tooManyAttempts", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }

    const requestHeaders = await headers();
    const result =
        (await withPasswordOrProof(user.id, parsed.data.password, (password) =>
            regenerateBackupCodes(auth, requestHeaders, password)
        )) ?? { error: (await getTranslations("accountSecurity"))("known.wrongPassword") };
    if (result.codes) {
        await recordAudit({
            actorId: user.id,
            action: "account.2fa.backup-codes-issued",
            metadata: { count: result.codes.length }
        });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}

const savePreferencesSchema = z.object({
    preferences: twoFactorPreferencesSchema,
    password: z.string().min(1, "Password is required")
});

/**
 * Save which methods the account accepts and which one it offers first.
 *
 * A method may only be turned on when it could actually deliver right now:
 * accepting one that cannot is how an account ends up offering a way in that
 * silently sends nothing. The check is here rather than in @polaris/auth because
 * what can deliver is a fact about this deployment, not about the settings.
 */
export async function saveTwoFactorPreferencesAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = savePreferencesSchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");

    const statuses = await describeTwoFactorMethods(user.id);
    const unusable = parsed.data.preferences.methods.find(
        (method) => !statuses.find((status) => status.method === method)?.available
    );
    if (unusable) {
        const t = await getTranslations("accountSecurity");
        return { error: t("errors.methodCannotSend", { method: methodLabel(t, unusable) }) };
    }

    // A method this Polaris does not offer right now (SMS switched off) is not on
    // the page, so it never comes back in the form - keep it as the account left
    // it, so turning SMS back on brings the account's choice back with it.
    const stored = await getUserSecurity(user.id);
    const hidden = stored.twoFactorMethods.filter(
        (method) => !statuses.some((status) => status.method === method)
    );
    const preferences = {
        ...parsed.data.preferences,
        methods: [...parsed.data.preferences.methods, ...hidden.filter((method) => !parsed.data.preferences.methods.includes(method))]
    };
    const result = await setTwoFactorPreferences(auth, user.id, preferences, parsed.data.password);
    if (!result.error) {
        await recordAudit({
            actorId: user.id,
            action: "account.2fa.methods-updated",
            metadata: {
                methods: parsed.data.preferences.methods,
                preferred: parsed.data.preferences.preferred
            }
        });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}

const savePolicySchema = z.object({
    policy: twoFactorPolicySchema,
    password: z.string().min(1, "Password is required")
});

/**
 * Save which set-up methods count as a second factor and how strict a sign-in
 * is. Behind the password and the new-device wait whichever way it moves: a
 * stricter policy can lock somebody out of a device they are about to lose, and a
 * looser one is exactly what somebody holding a stolen session would want.
 *
 * At least one set-up method must stay accepted. The sign-in side falls back to
 * every set-up method if the refusals ever cover them all (a channel going away
 * later), but a choice that already does is refused here, where it can be said.
 */
export async function saveTwoFactorPolicyAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = savePolicySchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");

    const t = await getTranslations("accountSecurity");
    const throttle = await rateLimit(`2fa-policy:${user.id}`, CODE_CHECK_LIMIT, CODE_CHECK_WINDOW_MS);
    if (!throttle.ok) return { error: t("errors.policyTooMany") };

    const statuses = await describeTwoFactorMethods(user.id);
    const setUp = statuses.filter((status) => status.enabled && status.available).map((status) => status.method);
    const next = parsed.data.policy;
    if (setUp.length > 0 && setUp.every((method) => next.refused.includes(method))) {
        return { error: t("errors.keepOneMethod") };
    }
    if (!(await verifyAccountPassword(auth, user.id, parsed.data.password))) {
        return { error: t("errors.policyWrongPassword") };
    }

    const previous = await loadTwoFactorPolicy(user.id);
    await saveTwoFactorPolicy(user.id, next);
    await recordAudit({
        actorId: user.id,
        action: "account.2fa.policy-updated",
        metadata: {
            refused: next.refused,
            strictness: next.strictness,
            previousRefused: previous.refused,
            previousStrictness: previous.strictness,
            stricter: isStricter(previous, next)
        }
    });
    revalidatePath("/account/security", "layout");
    return {};
}

const twoFactorChangesSchema = z.object({
    preferences: z.unknown().optional(),
    policy: z.unknown().optional(),
    approval: z.boolean().optional(),
    password: passwordOrProof
});

/**
 * The method list, the policy and the approval gate, saved from the one
 * confirmation that asked for the password once: each step is the action of its
 * own, in this order, stopping at the first refusal. A typed password goes to
 * each as it is; a proof (docs/chat-e2ee-phase1.md, "Password flows over
 * OPAQUE") is checked once here and each step gets its own one-use stand-in for
 * the hash read after it, so one Argon2id in the browser covers all three.
 */
export async function saveTwoFactorChangesAction(input: unknown): Promise<ActionResult> {
    const parsed = twoFactorChangesSchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");
    const { preferences, policy, approval, password } = parsed.data;
    let withPassword: <T>(run: (typed: string) => Promise<T>) => Promise<T>;
    if (typeof password === "string") {
        withPassword = (run) => run(password);
    } else {
        const user = await requireUser();
        const blocked = await newDeviceRefusal(user);
        if (blocked) return localized({ error: blocked });
        const hash = await provenPasswordHash(user.id, opaqueFinish.parse(password));
        if (!hash) return { error: (await getTranslations("accountSecurity"))("known.wrongPassword") };
        withPassword = (run) => withProvenPassword(hash, run);
    }
    const steps: Array<() => Promise<ActionResult>> = [];
    if (preferences !== undefined)
        steps.push(() => withPassword((typed) => saveTwoFactorPreferencesAction({ preferences, password: typed })));
    if (policy !== undefined)
        steps.push(() => withPassword((typed) => saveTwoFactorPolicyAction({ policy, password: typed })));
    if (approval !== undefined) steps.push(() => withPassword((typed) => setLoginApprovalAction(approval, typed)));
    for (const step of steps) {
        const result = await step();
        if (result.error) return result;
    }
    return {};
}

/** better-auth's authenticator endpoints, narrowed here for the two calls below. */
interface AuthenticatorEndpoints {
    enableTwoFactor(input: {
        body: { password: string; method: "totp" };
        headers: Headers;
    }): Promise<{ totpURI?: string; backupCodes?: string[] }>;
    disableTwoFactor(input: {
        body: { password: string };
        headers: Headers;
        returnHeaders: true;
    }): Promise<{ headers: Headers }>;
}

/**
 * The first step of setting the authenticator up, on a proof of the password
 * instead of the password (docs/chat-e2ee-phase1.md, "Password flows over
 * OPAQUE"): better-auth's own endpoint mints the secret and the backup codes,
 * exactly as the browser's call to it does. Nothing is armed until the code
 * from the app is checked, which stays the browser's call.
 */
export async function startAuthenticatorOpaqueAction(
    proof: unknown
): Promise<{ totpURI?: string; backupCodes?: string[]; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = opaqueFinish.safeParse(proof);
    const t = await getTranslations("accountSecurity");
    if (!parsed.success) return { error: t("errors.unreadable") };
    const requestHeaders = await headers();
    const api = auth.api as unknown as AuthenticatorEndpoints;
    try {
        const started = await withPasswordProof(user.id, parsed.data, (password) =>
            api.enableTwoFactor({ body: { password, method: "totp" }, headers: requestHeaders })
        );
        if (!started) return { error: t("known.wrongPassword") };
        if (!started.totpURI || !started.backupCodes) return { error: t("authenticator.startFailed") };
        return { totpURI: started.totpURI, backupCodes: started.backupCodes };
    } catch {
        return { error: t("authenticator.startFailed") };
    }
}

/**
 * Remove the authenticator on a proof of the password. better-auth's endpoint
 * replaces the session as it does for the browser's own call, and its cookies
 * are carried onto this response, so the browser moves to the new session the
 * caller announced with `beginSessionRotationAction` first.
 */
export async function turnOffAuthenticatorOpaqueAction(proof: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = opaqueFinish.safeParse(proof);
    const t = await getTranslations("accountSecurity");
    if (!parsed.success) return { error: t("errors.unreadable") };
    const requestHeaders = await headers();
    const api = auth.api as unknown as AuthenticatorEndpoints;
    try {
        const done = await withPasswordProof(user.id, parsed.data, (password) =>
            api.disableTwoFactor({ body: { password }, headers: requestHeaders, returnHeaders: true })
        );
        if (!done) return { error: t("known.wrongPassword") };
        await forwardAuthCookies(done.headers);
        return {};
    } catch {
        return { error: t("authenticator.turnOffFailed") };
    }
}

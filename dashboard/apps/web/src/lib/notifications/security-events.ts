/**
 * Telling somebody their account's protection changed.
 *
 * Every one of these is something an attacker holding the account would do
 * early - move the address the resets go to, take a passkey off, mint a key that
 * outlives the session - and the owner learning about it late is the whole
 * problem. So the alert is raised from the audit trail rather than from each
 * screen: an action worth writing to the log is worth telling the account about,
 * and hanging it there means a new security action is one line in this table
 * instead of a notification somebody has to remember to add.
 *
 * Deliberately only changes. A refused sign-in, a wrong PIN, a failed recovery
 * answer - those are attempts rather than modifications, they are noisy, and
 * they are already written to the history the account can read.
 *
 * The `account.security` event is critical, so the record always reaches the
 * bell however the rules are set. That is the point of it: the first thing worth
 * doing with a stolen account is muting the alarm.
 */

import { notify } from "./dispatch";

interface SecurityChange {
    /** What happened, as the recipient reads it. */
    title: string;
    /** The screen it was done on, so the alert lands where it can be undone. */
    href: string;
}

const SECURITY = "/account/security";
const SESSIONS = "/account/sessions";

/**
 * The audit actions that change how an account is protected. An action that is
 * not here raises nothing, which is what keeps the ordinary log - a file
 * uploaded, a container restarted - out of the security alert.
 */
const SECURITY_CHANGES: Readonly<Record<string, SecurityChange>> = {
    "account.password.changed": { title: "Your password was changed", href: SECURITY },
    "account.password.recovered": { title: "Your password was replaced from the recovery questions", href: SECURITY },
    "account.recovery.completed": { title: "Your password was reset after a recovery request", href: SECURITY },
    "account.pin.set": { title: "A quick unlock PIN was set", href: SECURITY },
    "account.pin.cleared": { title: "The quick unlock PIN was removed", href: SECURITY },
    "account.security-questions.set": { title: "Your recovery questions were replaced", href: SECURITY },
    "account.security-questions.cleared": { title: "Your recovery questions were removed", href: SECURITY },
    "account.phone.set": { title: "A phone number was added to your account", href: SECURITY },
    "account.phone.verified": { title: "Your phone number was confirmed", href: SECURITY },
    "account.phone.removed": { title: "Your phone number was removed", href: SECURITY },
    "account.2fa.methods-updated": { title: "Your two-factor methods changed", href: SECURITY },
    "account.2fa.backup-codes-issued": { title: "A new set of backup codes was issued", href: SECURITY },
    "account.2fa.trusted-device-revoked": { title: "A remembered device was removed", href: SESSIONS },
    "account.2fa.trusted-devices-revoked": { title: "Every remembered device was removed", href: SESSIONS },
    "account.passkey.removed": { title: "A passkey was removed from your account", href: SECURITY },
    "account.passkey.added": { title: "A passkey was added to your account", href: SECURITY },
    "account.login-approval.enabled": { title: "Sign-ins now have to be approved", href: SECURITY },
    "account.login-approval.disabled": { title: "Sign-ins no longer have to be approved", href: SECURITY },
    "account.new-device-grace.updated": { title: "The wait for a new device changed", href: SECURITY },
    "account.session-limits.updated": { title: "Your session limits changed", href: SECURITY },
    "account.session-binding.updated": { title: "What your sessions are tied to changed", href: SECURITY },
    // The pin itself, not the refusal it later causes. A session being refused
    // has its own alert, with the whole account of who turned up - see
    // notifications/session-breach.
    "account.session.pinned": { title: "A session was tied to its address", href: SESSIONS },
    "account.successor.set": { title: "An account successor was named", href: SECURITY },
    "account.successor.cleared": { title: "The account successor was removed", href: SECURITY },
    "connection.signin.allowed": { title: "A connected account may now sign you in", href: SECURITY },
    "connection.signin.refused": { title: "A connected account may no longer sign you in", href: SECURITY },
    "account.signin-rules.updated": { title: "Your sign-in rules changed", href: "/account/access" },
    "account.access-group.created": { title: "An address group was added to your sign-in rules", href: "/account/access" },
    "account.access-group.updated": { title: "An address group in your sign-in rules changed", href: "/account/access" },
    "account.access-group.deleted": { title: "An address group was removed from your sign-in rules", href: "/account/access" },
    "account.email.added": { title: "An email address was added to your account", href: "/account" },
    "account.email.removed": { title: "An email address was removed from your account", href: "/account" },
    "account.email.primary-changed": { title: "Your main email address changed", href: "/account" },
    "account.api-key.created": { title: "An API key was created", href: "/account/api-keys" },
    "account.api-key.updated": { title: "An API key was changed", href: "/account/api-keys" },
    "account.api-key.revoked": { title: "An API key was revoked", href: "/account/api-keys" },
    "account.api-key.deleted": { title: "An API key was deleted", href: "/account/api-keys" },
    "account.ai-key.added": { title: "An AI provider key was added", href: "/account/ai-keys" },
    "account.ai-key.deleted": { title: "An AI provider key was removed", href: "/account/ai-keys" }
};

/** What the alert says under the headline. The same line every time, because the
 *  answer to all of them is the same and it is the only one that matters. */
const ADVICE = "If this was not you, change your password and sign out every other device.";

/**
 * Raise the alert for one audited action, when that action changed how the
 * account is protected. Anything else is ignored, so this can sit on the audit
 * trail as a whole.
 *
 * `userId` is the account whose protection changed, which is the actor on every
 * one of these: they are all things a person does to their own account.
 */
export async function notifySecurityChange(userId: string | null, action: string): Promise<void> {
    const change = SECURITY_CHANGES[action];
    if (!userId || !change) return;
    await notify({
        userId,
        event: "account.security",
        title: change.title,
        body: ADVICE,
        href: change.href
    });
}

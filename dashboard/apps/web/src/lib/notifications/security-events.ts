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
import { wordsFor } from "./notice-words";
import type { NamespaceKey } from "@/lib/i18n/types";

interface SecurityChange {
    /** What happened, as the recipient reads it: its key in the `notices` catalog. */
    key: NamespaceKey<"notices">;
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
    "account.password.changed": { key: "security.account_password_changed", href: SECURITY },
    "account.password.recovered": { key: "security.account_password_recovered", href: SECURITY },
    "account.recovery.completed": { key: "security.account_recovery_completed", href: SECURITY },
    "account.pin.set": { key: "security.account_pin_set", href: SECURITY },
    "account.pin.cleared": { key: "security.account_pin_cleared", href: SECURITY },
    "account.security-questions.set": {
        key: "security.account_security_questions_set",
        href: SECURITY
    },
    "account.security-questions.cleared": {
        key: "security.account_security_questions_cleared",
        href: SECURITY
    },
    "account.phone.set": { key: "security.account_phone_set", href: SECURITY },
    "account.phone.verified": { key: "security.account_phone_verified", href: SECURITY },
    "account.phone.removed": { key: "security.account_phone_removed", href: SECURITY },
    "account.2fa.methods-updated": { key: "security.account_2fa_methods_updated", href: SECURITY },
    "account.2fa.backup-codes-issued": {
        key: "security.account_2fa_backup_codes_issued",
        href: SECURITY
    },
    "account.2fa.trusted-device-revoked": {
        key: "security.account_2fa_trusted_device_revoked",
        href: SESSIONS
    },
    "account.2fa.trusted-devices-revoked": {
        key: "security.account_2fa_trusted_devices_revoked",
        href: SESSIONS
    },
    "account.passkey.removed": { key: "security.account_passkey_removed", href: SECURITY },
    "account.passkey.added": { key: "security.account_passkey_added", href: SECURITY },
    "account.login-approval.enabled": {
        key: "security.account_login_approval_enabled",
        href: SECURITY
    },
    "account.login-approval.disabled": {
        key: "security.account_login_approval_disabled",
        href: SECURITY
    },
    "account.new-device-grace.updated": {
        key: "security.account_new_device_grace_updated",
        href: SECURITY
    },
    "account.session-limits.updated": {
        key: "security.account_session_limits_updated",
        href: SECURITY
    },
    "account.session-binding.updated": {
        key: "security.account_session_binding_updated",
        href: SECURITY
    },
    // The pin itself, not the refusal it later causes. A session being refused
    // has its own alert, with the whole account of who turned up - see
    // notifications/session-breach.
    "account.session.pinned": { key: "security.account_session_pinned", href: SESSIONS },
    "account.extension.pinned": { key: "security.account_extension_pinned", href: SESSIONS },
    "account.successor.set": { key: "security.account_successor_set", href: SECURITY },
    "account.successor.cleared": { key: "security.account_successor_cleared", href: SECURITY },
    "connection.signin.allowed": { key: "security.connection_signin_allowed", href: SECURITY },
    "connection.signin.refused": { key: "security.connection_signin_refused", href: SECURITY },
    "account.signin-rules.updated": {
        key: "security.account_signin_rules_updated",
        href: "/account/access"
    },
    "account.access-group.created": {
        key: "security.account_access_group_created",
        href: "/account/access"
    },
    "account.access-group.updated": {
        key: "security.account_access_group_updated",
        href: "/account/access"
    },
    "account.access-group.deleted": {
        key: "security.account_access_group_deleted",
        href: "/account/access"
    },
    "account.email.added": { key: "security.account_email_added", href: "/account/details" },
    "account.email.removed": { key: "security.account_email_removed", href: "/account/details" },
    "account.email.primary-changed": {
        key: "security.account_email_primary_changed",
        href: "/account/details"
    },
    "account.api-key.created": {
        key: "security.account_api_key_created",
        href: "/account/api-keys"
    },
    "account.api-key.updated": {
        key: "security.account_api_key_updated",
        href: "/account/api-keys"
    },
    "account.api-key.revoked": {
        key: "security.account_api_key_revoked",
        href: "/account/api-keys"
    },
    "account.api-key.deleted": {
        key: "security.account_api_key_deleted",
        href: "/account/api-keys"
    },
    "account.ai-key.added": { key: "security.account_ai_key_added", href: "/account/ai-keys" },
    "account.ai-key.deleted": { key: "security.account_ai_key_deleted", href: "/account/ai-keys" },
    // An assistant connected over MCP is a credential like a key, made by a
    // different door; one ended because its token turned up twice means
    // somebody else held it.
    "account.oauth.connected": {
        key: "security.account_oauth_connected",
        href: "/account/assistants"
    },
    "account.oauth.updated": {
        key: "security.account_oauth_updated",
        href: "/account/assistants"
    },
    "account.oauth.replay-detected": {
        key: "security.account_oauth_replay_detected",
        href: "/account/assistants"
    }
};

/** What the alert says under the headline. The same line every time, because the
 *  answer to all of them is the same and it is the only one that matters. */

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
    const t = await wordsFor(userId, "notices");
    await notify({
        userId,
        event: "account.security",
        title: t(change.key),
        body: t("security.advice"),
        href: change.href
    });
}

/**
 * Polaris's password rules, checked in the browser before a password becomes an
 * OPAQUE record (docs/chat-e2ee-phase1.md, "Password rules under OPAQUE").
 *
 * Under OPAQUE the server never sees the password, so it cannot run the rules
 * the old routes run on submit. Every flow that registers a NEW password over
 * OPAQUE (sign-up, reset, change, recovery) goes through `startCheckedRegistration`,
 * which refuses before any OPAQUE message exists. The rules are the same ones the
 * server enforces elsewhere, imported, not restated:
 *
 * - length: `passwordField` (10-256; `recoveryResetSchema` uses the same bounds),
 * - identity: `passwordMatchesIdentity`, the check behind `refuseIdentityPassword`,
 * - breached: Have I Been Pwned by k-anonymity through this Polaris's own
 *   `/api/polaris/pwned/[prefix]` (only five hex characters of the SHA-1 leave
 *   the tab). Like every other breach check here it fails open.
 *
 * Adoption at sign-in does not run it: that password was checked by the server
 * when it was set, and refusing it now would lock its owner out.
 */

import { breachCountFrom } from "@/lib/pwned-passwords";
import { passwordField, passwordMatchesIdentity } from "@polaris/core";
import * as passwordWorker from "@/lib/chat/e2ee/password-worker-client";

export type PasswordRuleProblem = "length" | "identity" | "breached";

/** The account a new password must not be built from. */
export interface PasswordIdentity {
    readonly name?: string | null;
    readonly username?: string | null;
    readonly email?: string | null;
}

/** A refused password, carrying which rule it broke so the form can say so. */
export class PasswordRuleError extends Error {
    constructor(readonly problem: PasswordRuleProblem) {
        super(`The password breaks the ${problem} rule`);
        this.name = "PasswordRuleError";
    }
}

async function ownRange(prefix: string): Promise<string | null> {
    try {
        const response = await fetch(`/api/polaris/pwned/${prefix}`, { credentials: "same-origin" });
        return response.ok ? await response.text() : null;
    } catch {
        return null;
    }
}

/** The first rule this password breaks, or null when it keeps them all. */
export async function passwordRuleProblem(
    password: string,
    identity: PasswordIdentity,
    range: (prefix: string) => Promise<string | null> = ownRange
): Promise<PasswordRuleProblem | null> {
    if (!passwordField.safeParse(password).success) return "length";
    if (passwordMatchesIdentity(password, [identity.name, identity.username, identity.email])) return "identity";
    return ((await breachCountFrom(password, range)) ?? 0) > 0 ? "breached" : null;
}

/** OPAQUE registration step one for a new password, refused with a
 *  `PasswordRuleError` when the password breaks a rule. */
export async function startCheckedRegistration(
    password: string,
    identity: PasswordIdentity,
    range?: (prefix: string) => Promise<string | null>
): Promise<{ state: string; registrationRequest: string }> {
    const problem = await passwordRuleProblem(password, identity, range);
    if (problem) throw new PasswordRuleError(problem);
    return passwordWorker.startPasswordRegistration(password);
}

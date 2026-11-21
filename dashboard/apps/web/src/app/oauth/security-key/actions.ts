"use server";

/**
 * The two server steps of the security-key screen. Both resolve the session
 * directly rather than through requireUser, which would send the caller back
 * to this screen instead of answering.
 */

import { auth } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { confirmAccountPassword } from "@polaris/auth";
import { announceNewPasskey } from "@/lib/passkey-announce";

/** Prove the account password before a new passkey is registered, as Account > Security does. */
export async function confirmPasswordForKeyAction(password: unknown): Promise<{ error?: string }> {
    const session = await resolveSession();
    if (!session) return { error: (await getTranslations("auth"))("securityKey.signedOut") };
    const ok = await confirmAccountPassword(auth, session.id, session.sessionId, String(password ?? ""));
    if (!ok) return { error: (await getTranslations("accountSecurity"))("known.wrongPassword") };
    return {};
}

/** Log and announce the passkey just registered here, once. */
export async function noteKeyAddedAction(): Promise<void> {
    const session = await resolveSession();
    if (session) await announceNewPasskey(session.id);
}

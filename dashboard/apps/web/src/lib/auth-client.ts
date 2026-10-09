"use client";

/**
 * Browser auth client for sign-in/out, second-factor management, passkeys, and
 * sign-in by emailed link. The plugins are registered here rather than driven
 * through server actions: they own the TOTP secret, the challenge cookie, the
 * link token and the WebAuthn ceremony, so letting them talk to their own
 * endpoints keeps that material out of Polaris code entirely. Passkeys in
 * particular cannot work any other way - the credential never leaves the browser.
 */

import { createAuthClient } from "better-auth/react";
import { leaveAccount } from "@/lib/account-switch";
import { passkeyClient } from "@better-auth/passkey/client";
import { signOutAccountAction } from "@/app/device-account-actions";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    plugins: [twoFactorClient(), magicLinkClient(), passkeyClient()]
});

export const { signIn, signUp, useSession } = authClient;

/**
 * Sign the account this browser is acting as out, and forget what was kept for it.
 *
 * Only that account: a browser can hold several, and the others stay signed in -
 * the next one takes over, and the sign-in screen this lands on sends it straight
 * on to its own home. Ending every account at once is the switcher's separate
 * "sign out of all".
 *
 * Screens paint from a snapshot of their last read before the request leaves, and
 * those snapshots outlive a sign-out, so `leaveAccount` drops them along with the
 * rest of the account's traces and reloads the page - here rather than at each
 * place that signs out, so a new one cannot forget, and in a `finally`, because a
 * sign-out that failed on the wire has still ended this session's claim on what
 * is in the tab.
 */
export async function signOut(): Promise<void> {
    try {
        await signOutAccountAction();
    } finally {
        await leaveAccount("/oauth/login");
    }
}

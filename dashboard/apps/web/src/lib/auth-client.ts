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
import { dropAllSnapshots } from "@/lib/snapshot-cache";
import { passkeyClient } from "@better-auth/passkey/client";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    plugins: [twoFactorClient(), magicLinkClient(), passkeyClient()]
});

export const { signIn, signUp, useSession } = authClient;

/**
 * Sign out, and forget what this tab kept while signed in.
 *
 * Screens paint from a snapshot of their last read before the request leaves, and
 * sessionStorage outlives a sign-out: signing out and signing in as somebody else
 * in the same tab would show the previous reader's mail subjects and file names
 * for as long as the first paint lasts. Dropped here rather than at each of the
 * five places that sign out, so a sixth cannot forget - and in a `finally`,
 * because a sign-out that failed on the wire has still ended this session's claim
 * on what is in the tab.
 */
export async function signOut(
    ...args: Parameters<typeof authClient.signOut>
): Promise<ReturnType<typeof authClient.signOut>> {
    try {
        return await authClient.signOut(...args);
    } finally {
        dropAllSnapshots();
    }
}

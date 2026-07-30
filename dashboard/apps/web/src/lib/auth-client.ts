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
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
    plugins: [twoFactorClient(), magicLinkClient(), passkeyClient()]
});

export const { signIn, signUp, signOut, useSession } = authClient;

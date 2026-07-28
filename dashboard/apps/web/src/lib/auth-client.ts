"use client";

/**
 * Browser auth client for sign-in/out and second-factor management from client
 * components. The two-factor plugin is registered here rather than driven through
 * server actions: it owns the TOTP secret and the challenge cookie, so letting it
 * talk to its own endpoints keeps that material out of Polaris code entirely.
 */

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    plugins: [twoFactorClient()]
});

export const { signIn, signUp, signOut, useSession } = authClient;

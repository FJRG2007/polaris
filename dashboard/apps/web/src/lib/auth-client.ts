"use client";

/** Browser auth client for sign-in/up/out from client components. */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
export const { signIn, signUp, signOut, useSession } = authClient;

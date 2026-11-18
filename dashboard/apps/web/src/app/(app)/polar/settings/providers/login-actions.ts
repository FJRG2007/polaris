"use server";

/**
 * The subscription logins on AI providers, for the signed-in person's own keys: start one, check
 * on it, and for GitLab hand back the address the browser landed on. The work
 * is `connection-actions.ts`; this file says whose it is.
 */

import * as connection from "@/lib/agents/connection-actions";
import type { LoginStart, LoginState } from "@/lib/agents/provider-logins";
import type { GoUsageRow } from "@/lib/agents/go-usage";
import { accountScope } from "./scope";

export async function startProviderLoginAction(input: unknown): Promise<LoginStart | { error: "failed" }> {
    return connection.startLogin(await accountScope(), input);
}

export async function pollProviderLoginAction(input: unknown): Promise<LoginState> {
    return connection.pollLogin(await accountScope(), input);
}

export async function finishGitlabLoginAction(input: unknown): Promise<LoginState> {
    return connection.finishGitlab(await accountScope(), input);
}

/** The OpenCode Go allowance of each Console sign-in. */
export async function goUsageAction(): Promise<GoUsageRow[]> {
    return connection.goUsage(await accountScope());
}

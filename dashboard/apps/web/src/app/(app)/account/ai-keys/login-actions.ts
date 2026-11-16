"use server";

/**
 * The subscription logins on AI provider keys: start one, check on it, and for
 * GitLab hand back the address the browser landed on. Every login is the
 * signed-in person's own; the key it ends with is theirs.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import {
    PROVIDER_LOGINS,
    finishGitlabLogin,
    pollProviderLogin,
    startProviderLogin,
    type LoginStart,
    type LoginState
} from "@/lib/agents/provider-logins";
import { goUsageFor, type GoUsageRow } from "@/lib/agents/go-usage";
import { gitlabInstanceSchema } from "@/lib/agents/login-instances";

const providerSchema = z.enum(PROVIDER_LOGINS);
/** A provider alone (its public instance), or with where to sign in. */
const startSchema = z.union([
    providerSchema.transform((provider) => ({ provider, gitlab: undefined })),
    z.object({ provider: z.literal("gitlab"), gitlab: gitlabInstanceSchema })
]);
const idSchema = z.string().uuid();
const pasteSchema = z.string().trim().min(1).max(4096);

export async function startProviderLoginAction(input: unknown): Promise<LoginStart | { error: "failed" }> {
    const user = await requireUser();
    const { provider, gitlab } = startSchema.parse(input);
    try {
        return await startProviderLogin(user.id, provider, undefined, undefined, gitlab ? { gitlab } : {});
    } catch (caught) {
        console.warn("[provider-login] start failed:", caught instanceof Error ? caught.message : "error");
        return { error: "failed" };
    }
}

export async function pollProviderLoginAction(input: unknown): Promise<LoginState> {
    const user = await requireUser();
    const state = await pollProviderLogin(user.id, idSchema.parse(input));
    if (state.state === "done") revalidatePath("/account/ai-keys");
    return state;
}

export async function finishGitlabLoginAction(input: unknown): Promise<LoginState> {
    const user = await requireUser();
    const { id, pasted } = z.object({ id: idSchema, pasted: pasteSchema }).parse(input);
    const state = await finishGitlabLogin(user.id, id, pasted);
    if (state.state === "done") revalidatePath("/account/ai-keys");
    return state;
}

/** The OpenCode Go allowance of each of this person's Console sign-ins. */
export async function goUsageAction(): Promise<GoUsageRow[]> {
    const user = await requireUser();
    return goUsageFor(user.id);
}

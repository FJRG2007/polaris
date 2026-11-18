/**
 * The subscription logins and cloud accounts of AI providers, for whoever owns
 * them: an account on its own screen, or the deployment on Management.
 *
 * Each screen's server actions establish who is signed in and what they may
 * write, then hand that scope here - the same split `model-key-actions.ts`
 * makes for keys - so both screens parse and store a login the same way.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { KeyScope } from "@/lib/agents/model-key-actions";
import { goUsageFor, type GoUsageRow } from "@/lib/agents/go-usage";
import { cloudCredentialSchema } from "@/lib/agents/cloud-credentials";
import { copilotDomainSchema, gitlabInstanceSchema } from "@/lib/agents/login-instances";
import {
    addCloudAccount,
    finishDigitaloceanLogin,
    startDigitaloceanLogin,
    type DigitaloceanFinish
} from "@/lib/agents/cloud-accounts";
import {
    PROVIDER_LOGINS,
    finishGitlabLogin,
    pollProviderLogin,
    startProviderLogin,
    type LoginStart,
    type LoginState
} from "@/lib/agents/provider-logins";

export type CloudAddResult = { ok: true } | { ok: false; reason: string };

const providerSchema = z.enum(PROVIDER_LOGINS);
/** A provider alone (its public instance), or with where to sign in. */
const startSchema = z.union([
    providerSchema.transform((provider) => ({ provider })),
    z.object({ provider: z.literal("gitlab"), gitlab: gitlabInstanceSchema }),
    z.object({ provider: z.literal("github-copilot"), copilotDomain: copilotDomainSchema })
]);
const idSchema = z.string().uuid();
const pasteSchema = z.string().trim().min(1).max(4096);

export async function startLogin(scope: KeyScope, input: unknown): Promise<LoginStart | { error: "failed" }> {
    const { provider, ...place } = startSchema.parse(input);
    try {
        return await startProviderLogin(scope.owner, provider, undefined, undefined, place);
    } catch (caught) {
        console.warn("[provider-login] start failed:", caught instanceof Error ? caught.message : "error");
        return { error: "failed" };
    }
}

export async function pollLogin(scope: KeyScope, input: unknown): Promise<LoginState> {
    const state = await pollProviderLogin(scope.owner, idSchema.parse(input));
    if (state.state === "done") revalidatePath(scope.path);
    return state;
}

export async function finishGitlab(scope: KeyScope, input: unknown): Promise<LoginState> {
    const { id, pasted } = z.object({ id: idSchema, pasted: pasteSchema }).parse(input);
    const state = await finishGitlabLogin(scope.owner, id, pasted);
    if (state.state === "done") revalidatePath(scope.path);
    return state;
}

/** The OpenCode Go allowance of each of the owner's Console sign-ins. */
export function goUsage(scope: KeyScope): Promise<GoUsageRow[]> {
    return goUsageFor(scope.owner);
}

function settled(scope: KeyScope, result: DigitaloceanFinish): CloudAddResult {
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath(scope.path);
    return { ok: true };
}

export async function addCloud(scope: KeyScope, input: unknown): Promise<CloudAddResult> {
    const parsed = cloudCredentialSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    try {
        return settled(scope, await addCloudAccount(scope.owner, parsed.data));
    } catch (caught) {
        console.warn("[cloud-account] add failed:", caught instanceof Error ? caught.name : "error");
        return { ok: false, reason: "unreachable" };
    }
}

export function startDigitalocean(scope: KeyScope): { id: string; url: string } {
    return startDigitaloceanLogin(scope.owner);
}

export async function finishDigitalocean(scope: KeyScope, input: unknown): Promise<CloudAddResult> {
    const parsed = z
        .object({ id: z.string().uuid(), pasted: z.string().trim().min(1).max(8192) })
        .safeParse(input);
    if (!parsed.success) return { ok: false, reason: "bad-paste" };
    try {
        return settled(scope, await finishDigitaloceanLogin(scope.owner, parsed.data.id, parsed.data.pasted));
    } catch (caught) {
        console.warn("[cloud-account] DigitalOcean failed:", caught instanceof Error ? caught.name : "error");
        return { ok: false, reason: "unreachable" };
    }
}

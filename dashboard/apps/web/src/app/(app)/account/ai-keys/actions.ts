"use server";

/**
 * The AI provider keys one account brought itself.
 *
 * The gate, and nothing else: every action here establishes the signed-in person
 * and hands the writes their own rows to work on. The writes themselves are
 * shared with the deployment's own keys under /integrations/models, so the two
 * screens cannot drift apart in what they check before storing a credential.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import {
    canAssistSignin,
    answerSignin,
    beginSignin,
    endSignin,
    identifySignin,
    signinScreen,
    type SigninIdentity,
    type SigninView
} from "@/lib/agents/signin-runtime";
import { agentSigninAnswerSchema, agentSigninEnvSchema, agentSigninIdSchema } from "@polaris/core";
import {
    addKey,
    editKey,
    removeKey,
    reorderKeys,
    type KeyActionResult,
    type KeyScope
} from "@/lib/agents/model-key-actions";

/** This person's own keys, read on their own screen. */
async function scope(): Promise<KeyScope> {
    const user = await requireUser();
    return { owner: user.id, actorId: user.id, path: "/account/ai-keys", audit: "account" };
}

export async function addModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return addKey(await scope(), input);
}

export async function updateModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return editKey(await scope(), input);
}

export async function deleteModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return removeKey(await scope(), input);
}

export async function reorderModelKeysAction(input: unknown): Promise<KeyActionResult> {
    return reorderKeys(await scope(), input);
}

// ---------------------------------------------------------------------------
// Signing an agent in, with Polaris supplying the machine
// ---------------------------------------------------------------------------

/**
 * The four calls behind the assisted sign-in.
 *
 * Every one of them establishes the signed-in person and passes their own id
 * down, because this is the only place in Polaris where somebody who is not an
 * administrator causes a container to start: the runtime bounds how many, and it
 * can only do that against an account it was told.
 *
 * Errors are said rather than shown: what comes back from a daemon that would
 * not start a container is not a sentence for a screen.
 */
export async function beginAgentSigninAction(env: unknown): Promise<{ id?: string; error?: string }> {
    const user = await requireUser();
    const parsed = agentSigninEnvSchema.safeParse(env);
    const t = await getTranslations("account");
    if (!parsed.success) return { error: t("aiKeys.errors.notAssisted") };
    if (!canAssistSignin(parsed.data)) return { error: t("aiKeys.errors.notAssisted") };
    try {
        const attempt = await beginSignin(user.id, parsed.data);
        return { id: attempt.id };
    } catch (error) {
        // The bound and the "already open" case are written to be read; anything
        // else is a machine talking to itself.
        if (error instanceof Error && error.message.startsWith("A sign-in is already open")) {
            return { error: error.message };
        }
        console.error("[agent-signin] could not start:", error);
        return { error: t("aiKeys.errors.couldNotStart") };
    }
}

export async function agentSigninScreenAction(
    id: unknown
): Promise<{ view?: SigninView; error?: string }> {
    const user = await requireUser();
    const parsed = agentSigninIdSchema.safeParse(id);
    if (!parsed.success) return { error: (await getTranslations("account"))("aiKeys.errors.notOpen") };
    try {
        return { view: await signinScreen(user.id, parsed.data) };
    } catch {
        // Includes the minute before the container answers at all, which is not a
        // failure - the dialog reads a missing view as "still starting".
        return { error: (await getTranslations("account"))("aiKeys.errors.notOpen") };
    }
}

export async function answerAgentSigninAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = agentSigninAnswerSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? (await getTranslations("account"))("aiKeys.errors.typeSomething") };
    }
    try {
        await answerSignin(user.id, parsed.data.id, parsed.data.text);
        return {};
    } catch {
        return { error: (await getTranslations("account"))("aiKeys.errors.notOpen") };
    }
}

export async function endAgentSigninAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = agentSigninIdSchema.safeParse(id);
    // Nothing to say: an id that is not one names no container, and the caller is
    // closing a dialog either way.
    if (parsed.success) await endSignin(user.id, parsed.data);
    return {};
}

/**
 * Who the open sign-in belongs to.
 *
 * Asked by the dialog once the credential is in hand, so the row it is about to
 * write can carry an address rather than only a name somebody typed. Never
 * fails: an identity nobody could read is an empty object, and a credential with
 * no identity is still a working credential.
 */
export async function agentSigninIdentityAction(input: unknown): Promise<SigninIdentity> {
    const user = await requireUser();
    const parsed = agentSigninAnswerSchema
        .pick({ id: true })
        .extend({ env: agentSigninEnvSchema })
        .safeParse(input);
    if (!parsed.success) return {};
    return identifySignin(user.id, parsed.data.id, parsed.data.env);
}

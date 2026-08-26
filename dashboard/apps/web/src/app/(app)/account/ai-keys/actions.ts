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

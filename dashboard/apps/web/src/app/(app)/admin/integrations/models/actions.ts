"use server";

/**
 * The AI provider keys the deployment itself holds.
 *
 * The gate, and nothing else: a key here is spent by anybody the administrator
 * shares it with, so every action establishes an administrator first and then
 * hands the writes the deployment's own rows. The writes are the same ones an
 * account's screen uses, which is what keeps a credential stored here checked
 * exactly as carefully as one somebody brings themselves.
 */

import { requireAdmin } from "@/lib/session";
import { INSTANCE } from "@/lib/agents/model-keys";
import {
    addKey,
    editKey,
    removeKey,
    reorderKeys,
    type KeyActionResult,
    type KeyScope
} from "@/lib/agents/model-key-actions";

/** The deployment's keys, written by whichever administrator is signed in. */
async function scope(): Promise<KeyScope> {
    const admin = await requireAdmin();
    return { owner: INSTANCE, actorId: admin.id, path: "/admin/integrations/models", audit: "instance" };
}

export async function addInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return addKey(await scope(), input);
}

export async function updateInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return editKey(await scope(), input);
}

export async function deleteInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return removeKey(await scope(), input);
}

export async function reorderInstanceModelKeysAction(input: unknown): Promise<KeyActionResult> {
    return reorderKeys(await scope(), input);
}

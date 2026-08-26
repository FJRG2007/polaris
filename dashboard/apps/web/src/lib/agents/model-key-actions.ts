/**
 * Adding, renaming, replacing, removing and reordering a provider key.
 *
 * The same four writes serve both screens: an account's own keys under
 * /account/ai-keys and the deployment's under /integrations/models. Only who is
 * allowed to ask differs, and that is settled by the caller before it gets here
 * - each screen's actions file is the gate, and passes the owner it just
 * established. Nothing in this module decides who anybody is.
 *
 * A key is write-only from the moment it is saved: no function here reads one
 * back, so a screen cannot leak one and neither can a mistake in one.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { readGatewayConfig } from "@/lib/integrations/registry";
import { checkProviderKey } from "@/lib/agents/provider-key-check";
import { createModelKeySchema, reorderModelKeysSchema, updateModelKeySchema } from "@polaris/core";
import {
    createModelKey,
    deleteModelKey,
    isStorableProvider,
    ownerHasModelKeyName,
    ownerHasModelSecret,
    providerOfModelKey,
    reorderModelKeys,
    updateModelKey,
    type KeyOwner
} from "@/lib/agents/model-keys";

/** What a write reports back. `warning` is the case that is neither: the key was
 *  stored, and the provider could not be asked whether it is any good. */
export interface KeyActionResult {
    error?: string;
    warning?: string;
}

/** Whose keys are being written, who is writing them, and where that is read. */
export interface KeyScope {
    owner: KeyOwner;
    /** The signed-in person, for the audit trail. The owner of the keys on their
     *  own screen, and the administrator on the deployment's. */
    actorId: string;
    /** The screen to revalidate once the list has changed. */
    path: string;
    /** What the audit trail calls these writes: `account` or `instance`. */
    audit: "account" | "instance";
}

/**
 * The two collisions worth a sentence of their own, told apart by which index
 * refused. Every other write conflict here is a bug, not something to explain.
 */
function conflict(caught: unknown): "name" | "secret" | null {
    if (typeof caught !== "object" || caught === null) return null;
    const error = caught as { code?: string; meta?: { target?: unknown } };
    if (error.code !== "P2002") return null;
    const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
    return target.toLowerCase().includes("fingerprint") ? "secret" : "name";
}

/** Said in the second person on both screens: an administrator reading this is
 *  the person who would have added the other one. */
const NAME_TAKEN = "There is already a key by that name.";
const SECRET_TAKEN = "That key was already added for this provider.";

export async function addKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = createModelKeySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the key" };
    if (!isStorableProvider(parsed.data.provider)) return { error: "That is not a model provider." };

    if (await ownerHasModelKeyName(scope.owner, parsed.data.name)) return { error: NAME_TAKEN };

    // Checked before the provider is troubled with it: the same key stored twice
    // is two rows that expire together and hit one ceiling together, and the
    // person adding it believes they added a spare.
    if (
        await ownerHasModelSecret(scope.owner, parsed.data.provider, parsed.data.secret, {
            config: parsed.data.config
        })
    ) {
        return { error: SECRET_TAKEN };
    }

    // Asked before it is stored: a key the provider refuses outright is a typo,
    // and storing it would turn that into a failed run somebody has to trace.
    const check = await checkProviderKey(parsed.data.provider, parsed.data.secret);
    if (check.state === "rejected") return { error: check.reason };

    try {
        await createModelKey(scope.owner, {
            provider: parsed.data.provider,
            name: parsed.data.name,
            secret: parsed.data.secret,
            // Through the same reader every gateway config goes through, so one
            // shape is stored whichever screen wrote it, then widened to the
            // plain object the store keeps.
            config: parsed.data.config ? { ...readGatewayConfig(parsed.data.config) } : undefined,
            expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null
        });
    } catch (caught) {
        const clash = conflict(caught);
        if (clash) return { error: clash === "secret" ? SECRET_TAKEN : NAME_TAKEN };
        throw caught;
    }

    // The provider and the name are recorded, never the key or any part of it:
    // an audit row is read by more people than the credential ever should be.
    await recordAudit({
        actorId: scope.actorId,
        action: `${scope.audit}.ai-key.added`,
        targetType: "modelProvider",
        targetId: parsed.data.provider,
        metadata: { name: parsed.data.name }
    });
    revalidatePath(scope.path);
    return check.state === "unverified" ? { warning: check.reason } : {};
}

export async function editKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = updateModelKeySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the key" };

    if (await ownerHasModelKeyName(scope.owner, parsed.data.name, parsed.data.id)) return { error: NAME_TAKEN };

    // Only a key that was actually retyped is checked. A rename, or moving the
    // end date, should not fail because the provider is having a bad morning.
    let warning: string | undefined;
    if (parsed.data.secret !== undefined) {
        const provider = await providerOfModelKey(scope.owner, parsed.data.id);
        if (!provider) return { error: "That key is gone." };
        // Excluding this row: retyping the same key it already holds is a
        // no-op, not somebody's second copy of it.
        if (
            await ownerHasModelSecret(scope.owner, provider, parsed.data.secret, {
                exceptId: parsed.data.id,
                config: parsed.data.config
            })
        ) {
            return { error: SECRET_TAKEN };
        }
        const check = await checkProviderKey(provider, parsed.data.secret);
        if (check.state === "rejected") return { error: check.reason };
        if (check.state === "unverified") warning = check.reason;
    }

    let changed: boolean;
    try {
        changed = await updateModelKey(scope.owner, parsed.data.id, {
            name: parsed.data.name,
            secret: parsed.data.secret,
            config: parsed.data.config ? { ...readGatewayConfig(parsed.data.config) } : undefined,
            expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null
        });
    } catch (caught) {
        const clash = conflict(caught);
        if (clash) return { error: clash === "secret" ? SECRET_TAKEN : NAME_TAKEN };
        throw caught;
    }
    if (!changed) return { error: "That key is gone." };

    await recordAudit({
        actorId: scope.actorId,
        action: `${scope.audit}.ai-key.${parsed.data.secret === undefined ? "renamed" : "replaced"}`,
        targetType: "modelKey",
        targetId: parsed.data.id,
        metadata: { name: parsed.data.name }
    });
    revalidatePath(scope.path);
    return warning ? { warning } : {};
}

export async function removeKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: "Pick a key" };

    if (!(await deleteModelKey(scope.owner, parsed.data.id))) return { error: "That key is gone." };
    await recordAudit({
        actorId: scope.actorId,
        action: `${scope.audit}.ai-key.deleted`,
        targetType: "modelKey",
        targetId: parsed.data.id
    });
    revalidatePath(scope.path);
    return {};
}

/** The order to try them in, as the table now reads top to bottom. */
export async function reorderKeys(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = reorderModelKeysSchema.safeParse(input);
    if (!parsed.success) return { error: "Could not read the new order." };

    await reorderModelKeys(scope.owner, parsed.data.ids);
    revalidatePath(scope.path);
    return {};
}

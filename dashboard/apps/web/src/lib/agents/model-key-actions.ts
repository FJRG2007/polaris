/**
 * Adding, renaming, replacing, removing and reordering a provider key.
 *
 * The same four writes serve both screens: an account's own keys under
 * /polar/settings/providers and the deployment's under /admin/apps/polar/settings/providers. Only who is
 * allowed to ask differs, and that is settled by the caller before it gets here
 * - each screen's actions file is the gate, and passes the owner it just
 * established. Nothing in this module decides who anybody is.
 *
 * A key is write-only from the moment it is saved: no function here reads one
 * back, so a screen cannot leak one and neither can a mistake in one.
 */

import { machineLoginOf } from "@/lib/agents/machine-logins";
import { markHomeSignin } from "@/lib/agents/home-signins";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { readGatewayConfig } from "@/lib/integrations/registry";
import { checkProviderKey } from "@/lib/agents/provider-key-check";
import { refreshEndpointModelsWithKey } from "@/lib/agents/endpoint-models";
import { ensureProviderCatalog } from "@/lib/integrations/provider-catalog";
import { createModelKeySchema, reorderModelKeysSchema, updateModelKeySchema } from "@polaris/core";
import {
    createModelKey,
    deleteModelKey,
    heldModelKey,
    isStorableProvider,
    ownerHasModelKeyName,
    ownerHasModelSecret,
    providerOfModelKey,
    reorderModelKeys,
    setModelKeyEnabled,
    setModelKeyLimits,
    clearModelKeyCooling,
    updateModelKey,
    type KeyOwner
} from "@/lib/agents/model-keys";
import { readerWords } from "@/lib/i18n/reader-words";
import { keyLimitsSchema } from "@/lib/agents/key-limits";
import { agentSignins } from "@/lib/agents/agent-signins";
import { isFolderId } from "@/lib/agents/account-folders";
import { clearAccountFolder } from "@/lib/agents/signin-runtime";
import { reachable, safeUrl } from "@/lib/safe-fetch";

/** What a write reports back. `warning` is the case that is neither: the key was
 *  stored, and the provider could not be asked whether it is any good. */
export interface KeyActionResult {
    error?: string;
    warning?: string;
    /** Set when Anthropic answered that the key has to name a workspace, or
     *  named one it cannot use, so the form can ask for the Workspace ID. */
    needsWorkspace?: boolean;
}

/** A refusal from the provider check, with the hint the form acts on. */
function refusal(check: { code: string; reason: string }): KeyActionResult {
    return check.code === "workspace"
        ? { error: check.reason, needsWorkspace: true }
        : { error: check.reason };
}

/** The workspace a write names, for Anthropic only: anywhere else the field has
 *  no meaning and is dropped rather than stored. */
function workspaceFor<T extends string | null | undefined>(
    provider: string,
    value: T
): T | undefined {
    return provider === "anthropic" ? value : undefined;
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
    const target = Array.isArray(error.meta?.target)
        ? error.meta.target.join(",")
        : String(error.meta?.target ?? "");
    return target.toLowerCase().includes("fingerprint") ? "secret" : "name";
}

/** Said in the second person on both screens: an administrator reading this is
 *  the person who would have added the other one. */
const NAME_TAKEN = "There is already a key by that name.";
const SECRET_TAKEN = "That key was already added for this provider.";

/**
 * Why a person's own endpoint cannot be saved, or null when it can. A key saved
 * on an account is called by the dashboard from inside the deployment, so its
 * address has to be a public one; only the deployment's own keys, which an
 * administrator saves, may point at the local network. Checked again on every
 * call (`configuredFetch`), since a name can resolve elsewhere tomorrow.
 */
async function endpointRefusal(
    scope: KeyScope,
    config: { baseUrl?: string } | undefined
): Promise<string | null> {
    if (scope.audit !== "account" || !config?.baseUrl) return null;
    const url = safeUrl(config.baseUrl, Number.POSITIVE_INFINITY);
    if (url && (await reachable(url.hostname))) return null;
    return (await readerWords("api"))("refusals.aiKeys.privateEndpoint");
}

export async function addKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = createModelKeySchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await readerWords("api"))("refusals.aiKeys.checkKey")
        };
    // A provider an operator added in another process is known once the
    // catalogue is read again.
    await ensureProviderCatalog();
    if (!isStorableProvider(parsed.data.provider))
        return { error: (await readerWords("api"))("refusals.aiKeys.notAProvider") };
    // A login kept in an account folder is stored by its sign-in, as the id of
    // the folder it made in this person's home: nothing typed can be one.
    const folderLogin = agentSignins().find((signin) => signin.slug === parsed.data.provider && signin.folder);
    if (folderLogin && (scope.owner === null || !isFolderId(parsed.data.secret)))
        return { error: (await readerWords("api"))("refusals.aiKeys.signInHere") };

    if (await ownerHasModelKeyName(scope.owner, parsed.data.name)) return { error: NAME_TAKEN };

    const refusedEndpoint = await endpointRefusal(scope, parsed.data.config);
    if (refusedEndpoint) return { error: refusedEndpoint };

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
    const workspaceId = workspaceFor(parsed.data.provider, parsed.data.workspaceId);
    const check = await checkProviderKey(parsed.data.provider, parsed.data.secret, {
        workspaceId
    });
    if (check.state === "rejected") return refusal(check);

    try {
        await createModelKey(scope.owner, {
            provider: parsed.data.provider,
            name: parsed.data.name,
            secret: parsed.data.secret,
            // Through the same reader every gateway config goes through, so one
            // shape is stored whichever screen wrote it, then widened to the
            // plain object the store keeps.
            // Through the gateway's own reader where there is one, and otherwise
            // whatever the login said about whose account it is. Never both:
            // they belong to different kinds of row and one reader would have to
            // guess which it had.
            config: parsed.data.config
                ? { ...readGatewayConfig(parsed.data.config) }
                : parsed.data.identity && Object.keys(parsed.data.identity).length > 0
                  ? { ...parsed.data.identity }
                  : workspaceId
                    ? { workspaceId }
                    : undefined,
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
    listModelsWith(parsed.data.provider, parsed.data.secret, check.state);
    revalidatePath(scope.path);
    return check.state === "unverified" ? { warning: check.reason } : {};
}

/**
 * A provider reached by its own endpoint that lists its models only to a key
 * (Numes) offers nothing past its default model until one is saved, so the key
 * that just passed its check is used once to read that list. Left running: the
 * save does not wait on somebody else's endpoint, and a failure keeps the list
 * there was.
 */
function listModelsWith(provider: string, secret: string, state: string): void {
    if (state !== "valid") return;
    void refreshEndpointModelsWithKey(provider, secret).catch(() => undefined);
}

export async function editKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = updateModelKeySchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await readerWords("api"))("refusals.aiKeys.checkKey")
        };

    if (await ownerHasModelKeyName(scope.owner, parsed.data.name, parsed.data.id))
        return { error: NAME_TAKEN };
    // The machine's own login holds no key: only its name and end date change.
    const keyed = parsed.data.secret !== undefined || parsed.data.config !== undefined;
    if (keyed && (await machineLoginOf(scope.owner, parsed.data.id)))
        return { error: (await readerWords("api"))("refusals.aiKeys.checkKey") };

    const refusedEndpoint = await endpointRefusal(scope, parsed.data.config);
    if (refusedEndpoint) return { error: refusedEndpoint };

    // Only a key that was actually retyped is checked. A rename, or moving the
    // end date, should not fail because the provider is having a bad morning.
    let warning: string | undefined;
    // Read once a key or a workspace changes: both are told apart by provider.
    let provider: string | null = null;
    /** What the check said of a retyped key, which is the only one listed with. */
    let retyped: string | undefined;
    if (parsed.data.secret !== undefined || parsed.data.workspaceId !== undefined) {
        provider = await providerOfModelKey(scope.owner, parsed.data.id);
        if (!provider) return { error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
    }
    const workspaceId = provider ? workspaceFor(provider, parsed.data.workspaceId) : undefined;
    if (provider && parsed.data.secret !== undefined) {
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
        const check = await checkProviderKey(provider, parsed.data.secret, { workspaceId });
        if (check.state === "rejected") return refusal(check);
        if (check.state === "unverified") warning = check.reason;
        retyped = check.state;
    } else if (provider && workspaceId !== undefined) {
        // A new workspace is checked with the key already held: a mistyped one
        // would otherwise only show up as the next run's failure.
        const held = await heldModelKey(scope.owner, parsed.data.id);
        if (!held) return { error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
        if (held.secret && (workspaceId ?? null) !== held.workspaceId) {
            const check = await checkProviderKey(provider, held.secret, { workspaceId });
            if (check.state === "rejected") return refusal(check);
            if (check.state === "unverified") warning = check.reason;
        }
    }

    let changed: boolean;
    try {
        changed = await updateModelKey(scope.owner, parsed.data.id, {
            name: parsed.data.name,
            secret: parsed.data.secret,
            config: parsed.data.config ? { ...readGatewayConfig(parsed.data.config) } : undefined,
            workspaceId,
            expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null
        });
    } catch (caught) {
        const clash = conflict(caught);
        if (clash) return { error: clash === "secret" ? SECRET_TAKEN : NAME_TAKEN };
        throw caught;
    }
    if (!changed) return { error: (await readerWords("api"))("refusals.aiKeys.keyGone") };

    await recordAudit({
        actorId: scope.actorId,
        action: `${scope.audit}.ai-key.${parsed.data.secret === undefined ? "renamed" : "replaced"}`,
        targetType: "modelKey",
        targetId: parsed.data.id,
        metadata: { name: parsed.data.name }
    });
    if (provider && parsed.data.secret !== undefined && retyped)
        listModelsWith(provider, parsed.data.secret, retyped);
    revalidatePath(scope.path);
    return warning ? { warning } : {};
}

export async function removeKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: (await readerWords("api"))("refusals.aiKeys.pickKey") };
    if (!(await removeOne(scope, parsed.data.id)))
        return { error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
    revalidatePath(scope.path);
    return {};
}

/** What a write over several rows reports: the rows it did change. */
export interface BulkKeyResult extends KeyActionResult {
    done: string[];
}

/** The rows a bulk write names: at least one, never an unbounded list. */
const bulkIds = z.array(z.string().uuid()).min(1).max(200);

/**
 * Remove several at once. Each row is deleted through the same owner-scoped
 * write a single remove uses, so a row that is not this scope's is skipped
 * rather than touched, and the result names only what went.
 */
export async function removeKeys(scope: KeyScope, input: unknown): Promise<BulkKeyResult> {
    const parsed = z.object({ ids: bulkIds }).safeParse(input);
    if (!parsed.success) return { done: [], error: (await readerWords("api"))("refusals.aiKeys.pickKey") };
    const done: string[] = [];
    for (const id of new Set(parsed.data.ids)) if (await removeOne(scope, id)) done.push(id);
    revalidatePath(scope.path);
    if (done.length === 0) return { done, error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
    return { done };
}

/** One row gone, with what has to follow it; false when the scope holds no such row. */
async function removeOne(scope: KeyScope, id: string): Promise<boolean> {
    // A login kept in an account folder: read which folder before the row goes,
    // so its sign-out - clearing that folder - can follow.
    const folder = scope.owner ? await accountFolderOf(scope.owner, id) : null;
    const machine = await machineLoginOf(scope.owner, id);
    if (!(await deleteModelKey(scope.owner, id))) return false;
    if (folder && scope.owner) void clearAccountFolder(scope.owner, folder.env, folder.id);
    // Off the list too, or the next read would write the row straight back. The
    // login on the machine stays until it is signed out, which the screen offers.
    if (machine && scope.owner) await markHomeSignin(scope.owner, machine, false).catch(() => undefined);
    await recordAudit({
        actorId: scope.actorId,
        action: `${scope.audit}.ai-key.deleted`,
        targetType: "modelKey",
        targetId: id
    });
    return true;
}

/** The account folder a stored row names (`account-folders.ts`), or null for
 *  any other row. */
async function accountFolderOf(owner: string, id: string): Promise<{ env: string; id: string } | null> {
    const provider = await providerOfModelKey(owner, id);
    const signin = provider ? agentSignins().find((one) => one.slug === provider && one.folder) : undefined;
    if (!signin) return null;
    const held = await heldModelKey(owner, id);
    return held?.secret && isFolderId(held.secret) ? { env: signin.env, id: held.secret } : null;
}

/** Switch one on or off. Off keeps the key and its place; no run spends it. */
export async function toggleKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = z.object({ id: z.string().uuid(), enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: (await readerWords("api"))("refusals.aiKeys.pickKey") };
    if (!(await toggleOne(scope, parsed.data.id, parsed.data.enabled)))
        return { error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
    revalidatePath(scope.path);
    return {};
}

/** Switch several on or off, each through the owner-scoped write one switch uses. */
export async function toggleKeys(scope: KeyScope, input: unknown): Promise<BulkKeyResult> {
    const parsed = z.object({ ids: bulkIds, enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return { done: [], error: (await readerWords("api"))("refusals.aiKeys.pickKey") };
    const done: string[] = [];
    for (const id of new Set(parsed.data.ids))
        if (await toggleOne(scope, id, parsed.data.enabled)) done.push(id);
    revalidatePath(scope.path);
    if (done.length === 0) return { done, error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
    return { done };
}

async function toggleOne(scope: KeyScope, id: string, enabled: boolean): Promise<boolean> {
    if (!(await setModelKeyEnabled(scope.owner, id, enabled))) return false;
    await recordAudit({
        actorId: scope.actorId,
        action: `${scope.audit}.ai-key.${enabled ? "enabled" : "disabled"}`,
        targetType: "modelKey",
        targetId: id
    });
    return true;
}

/** The order to try them in, as the table now reads top to bottom. */
export async function reorderKeys(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = reorderModelKeysSchema.safeParse(input);
    if (!parsed.success)
        return { error: (await readerWords("api"))("refusals.aiKeys.orderUnreadable") };

    await reorderModelKeys(scope.owner, parsed.data.ids);
    revalidatePath(scope.path);
    return {};
}

/** Set one key's own allowance: what Polar's router holds it to before it steps
 *  on to the next key. */
export async function limitKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = z.object({ id: z.string().uuid(), limits: keyLimitsSchema }).safeParse(input);
    if (!parsed.success) return { error: (await readerWords("api"))("refusals.aiKeys.pickKey") };

    if (!(await setModelKeyLimits(scope.owner, parsed.data.id, parsed.data.limits))) {
        return { error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
    }
    await recordAudit({
        actorId: scope.actorId,
        action: `${scope.audit}.ai-key.limited`,
        targetType: "modelKey",
        targetId: parsed.data.id
    });
    revalidatePath(scope.path);
    return {};
}

/** Put a cooled-down key back in rotation now. */
export async function reviveKey(scope: KeyScope, input: unknown): Promise<KeyActionResult> {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: (await readerWords("api"))("refusals.aiKeys.pickKey") };

    if (!(await clearModelKeyCooling(scope.owner, parsed.data.id))) {
        return { error: (await readerWords("api"))("refusals.aiKeys.keyGone") };
    }
    revalidatePath(scope.path);
    return {};
}

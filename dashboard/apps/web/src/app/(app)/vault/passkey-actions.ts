"use server";

/**
 * Turning the account's own passkeys on and off as a way to unlock the vault.
 * Unlocking itself has no action: it happens in the tab, from what the lock
 * screen already has.
 */

import * as passkeys from "@/lib/vault/passkeys";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { vaultRefusal } from "./vault-refusal";
import {
    vaultPasskeyEnrollSchema,
    vaultPasskeyIdSchema,
    type VaultPasskeyChoice
} from "@/lib/vault/passkey-schema";

/** A refusal, and whether it is the step-up proof that ran out, so the card asks again. */
type ChangeOutcome = { error?: string; needsProof?: boolean };

async function refusal(result: passkeys.PasskeyChangeResult): Promise<ChangeOutcome> {
    if (result.ok) return {};
    switch (result.reason) {
        case "rate_limited":
            return {
                error: await vaultRefusal("passkeys.rateLimited", {
                    minutes: Math.max(1, Math.ceil((result.retryAfterMs ?? 60_000) / 60_000))
                })
            };
        case "needs_proof":
            return { error: await vaultRefusal("passkeys.needsProof"), needsProof: true };
        case "not_your_passkey":
            return { error: await vaultRefusal("passkeys.notYours") };
        case "too_many":
            return { error: await vaultRefusal("passkeys.tooMany") };
        default:
            return { error: await vaultRefusal("passkeys.gone") };
    }
}

/** The account's sign-in passkeys, each with whether it unlocks the vault. */
export async function vaultPasskeyChoicesAction(): Promise<VaultPasskeyChoice[]> {
    const user = await requirePermission("vault.use");
    return passkeys.listVaultPasskeyChoices(user.id);
}

export async function enrollVaultPasskeyAction(input: unknown): Promise<ChangeOutcome> {
    const user = await requirePermission("vault.use");
    const parsed = vaultPasskeyEnrollSchema.safeParse(input);
    // Nothing in this body is typed by a person, so one sentence covers it.
    if (!parsed.success) return { error: await vaultRefusal("errors.invalidRequest") };
    const result = await passkeys.enrollVaultPasskey(user.id, user.sessionId, parsed.data);
    if (result.ok) revalidatePath("/vault", "layout");
    return refusal(result);
}

export async function removeVaultPasskeyAction(id: unknown): Promise<ChangeOutcome> {
    const user = await requirePermission("vault.use");
    const parsed = vaultPasskeyIdSchema.safeParse(id);
    if (!parsed.success) return { error: await vaultRefusal("errors.invalidRequest") };
    const result = await passkeys.removeVaultPasskey(user.id, parsed.data);
    if (result.ok) revalidatePath("/vault", "layout");
    return refusal(result);
}

/** Recorded after the tab has opened the vault with a passkey; nothing depends on it. */
export async function vaultPasskeyUsedAction(id: unknown): Promise<void> {
    const user = await requirePermission("vault.use");
    const parsed = vaultPasskeyIdSchema.safeParse(id);
    if (parsed.success) await passkeys.markVaultPasskeyUsed(user.id, parsed.data);
}

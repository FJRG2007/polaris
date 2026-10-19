"use server";

/**
 * Enrolling and removing the passkeys that unlock the vault. Unlocking itself
 * has no action: it happens in the tab, from what the lock screen already has.
 */

import * as passkeys from "@/lib/vault/passkeys";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { vaultRefusal } from "./vault-refusal";
import { vaultPasskeyEnrollSchema, vaultPasskeyIdSchema } from "@/lib/vault/passkey-schema";

async function refusal(result: passkeys.PasskeyChangeResult): Promise<{ error?: string }> {
    if (result.ok) return {};
    switch (result.reason) {
        case "rate_limited":
            return {
                error: await vaultRefusal("passkeys.rateLimited", {
                    minutes: Math.max(1, Math.ceil((result.retryAfterMs ?? 60_000) / 60_000))
                })
            };
        case "wrong_password":
            return { error: await vaultRefusal("errors.wrongMaster") };
        case "not_your_passkey":
            return { error: await vaultRefusal("passkeys.notYours") };
        case "too_many":
            return { error: await vaultRefusal("passkeys.tooMany") };
        default:
            return { error: await vaultRefusal("passkeys.gone") };
    }
}

/** The account's sign-in passkeys, which are the ones a vault may be unlocked with. */
export async function vaultPasskeyCandidatesAction(): Promise<string[]> {
    const user = await requirePermission("vault.use");
    return passkeys.signInCredentialIds(user.id);
}

export async function enrollVaultPasskeyAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = vaultPasskeyEnrollSchema.safeParse(input);
    // Nothing in this body is typed by a person except the name, and the
    // screen checks that one as it is typed - so one sentence covers it.
    if (!parsed.success) return { error: await vaultRefusal("errors.invalidRequest") };
    const result = await passkeys.enrollVaultPasskey(user.id, parsed.data);
    if (result.ok) revalidatePath("/vault", "layout");
    return refusal(result);
}

export async function removeVaultPasskeyAction(id: unknown): Promise<{ error?: string }> {
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

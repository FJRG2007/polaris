"use server";

/**
 * Setting, revealing and removing what a runner carries into a job.
 *
 * Each of these is checked against the pool's owner inside the service rather
 * than here, so an id that arrived from a form cannot select somebody else's
 * pool. What this layer owns is the shape of the input and keeping the value out
 * of anything that is not the one call that needs it.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { deleteRunnerSecret, revealRunnerSecret, setRunnerSecret } from "@/lib/runners/runner-secrets";

const SECRETS_PATH = "/apps/runners/secrets";

const setSchema = z.object({
    poolId: z.string().uuid(),
    key: z.string().trim().min(1, "Name this secret").max(80),
    value: z.string().min(1, "Enter the value").max(8000),
    /** "" for every repository the pool serves, else the repository it is for. */
    scopeKey: z
        .string()
        .trim()
        .max(140)
        .regex(/^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?)?$/, "Not a repository")
        .default("")
});

export async function setRunnerSecretAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = setSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the secret" };
    try {
        await setRunnerSecret(user.id, parsed.data);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save that secret" };
    }
    revalidatePath(SECRETS_PATH);
    return {};
}

export async function deleteRunnerSecretAction(secretId: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    if (!z.string().uuid().safeParse(secretId).success) return { error: "Not a secret" };
    try {
        await deleteRunnerSecret(user.id, secretId);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove that secret" };
    }
    revalidatePath(SECRETS_PATH);
    return {};
}

/** Show one value back to the person who set it. Deliberately one at a time: a
 *  call that returned every value would put all of them in one response. */
export async function revealRunnerSecretAction(secretId: string): Promise<{ value?: string; error?: string }> {
    const user = await requirePermission("system.manage");
    if (!z.string().uuid().safeParse(secretId).success) return { error: "Not a secret" };
    try {
        const value = await revealRunnerSecret(user.id, secretId);
        return value === null ? { error: "That secret is gone" } : { value };
    } catch {
        // A value encrypted under a master key that has since changed cannot be
        // read back, and saying which of the two it is helps nobody.
        return { error: "This value could not be read. Set it again to replace it." };
    }
}

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
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import { knownRunnerText, runnerText } from "@/lib/runners/words";

const SECRETS_PATH = "/apps/runners/secrets";

type RunnersKey = NamespaceKey<"runners">;

/** A reply in the reader's language. */
async function say(key: RunnersKey): Promise<string> {
    return (await getTranslations("runners"))(key);
}

/** What went wrong, in the reader's words; a sentence the service did not write
 *  passes through. */
async function failure(caught: unknown, fallback: RunnersKey): Promise<string> {
    const t = await getTranslations("runners");
    return caught instanceof Error ? runnerText(t, caught.message) : t(fallback);
}

const setSchema = z.object({
    poolId: z.string().uuid(),
    // i18n-ignore said in the reader's words by lib/runners/words
    key: z.string().trim().min(1, "Name this secret").max(80),
    // i18n-ignore
    value: z.string().min(1, "Enter the value").max(8000),
    /** "" for every repository the pool serves, else the repository it is for. */
    scopeKey: z
        .string()
        .trim()
        .max(140)
        // i18n-ignore answered as secrets.errors.check
        .regex(/^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?)?$/, "Not a repository")
        .default("")
});

export async function setRunnerSecretAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = setSchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("runners");
        const message = parsed.error.issues[0]?.message;
        return { error: (message ? knownRunnerText(t, message) : null) ?? t("secrets.errors.check") };
    }
    try {
        await setRunnerSecret(user.id, parsed.data);
    } catch (caught) {
        return { error: await failure(caught, "secrets.errors.save") };
    }
    revalidatePath(SECRETS_PATH);
    return {};
}

export async function deleteRunnerSecretAction(secretId: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    if (!z.string().uuid().safeParse(secretId).success) return { error: await say("secrets.errors.notASecret") };
    try {
        await deleteRunnerSecret(user.id, secretId);
    } catch (caught) {
        return { error: await failure(caught, "secrets.errors.remove") };
    }
    revalidatePath(SECRETS_PATH);
    return {};
}

/** Show one value back to the person who set it. Deliberately one at a time: a
 *  call that returned every value would put all of them in one response. */
export async function revealRunnerSecretAction(secretId: string): Promise<{ value?: string; error?: string }> {
    const user = await requirePermission("system.manage");
    if (!z.string().uuid().safeParse(secretId).success) return { error: await say("secrets.errors.notASecret") };
    try {
        const value = await revealRunnerSecret(user.id, secretId);
        return value === null ? { error: await say("secrets.errors.gone") } : { value };
    } catch {
        // A value encrypted under a master key that has since changed cannot be
        // read back, and saying which of the two it is helps nobody.
        return { error: await say("secrets.errors.unreadable") };
    }
}

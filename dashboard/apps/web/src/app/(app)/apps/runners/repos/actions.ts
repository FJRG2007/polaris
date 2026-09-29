"use server";

/**
 * Changing what one repository may do with somebody's machine.
 *
 * Every one of these widens or narrows who can execute code on hardware the
 * operator owns, so the input is re-validated here rather than trusted from the
 * form, and the change is written through the service that records it in the
 * audit log. The page may have been open since before the repository was made
 * public.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { RUNNER_EVENTS } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { setRepoPolicy } from "@/lib/runners/runner-repo-config";
import { setForkApproval, FORK_APPROVAL_POLICIES } from "@/lib/github-runners";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import { runnerText } from "@/lib/runners/words";

const REPOS_PATH = "/apps/runners/repos";

/** What went wrong, in the reader's words: a sentence the runner service wrote is
 *  translated, anything else (GitHub's own refusal) passes through. */
async function failure(caught: unknown, fallback: NamespaceKey<"runners">): Promise<string> {
    const t = await getTranslations("runners");
    return caught instanceof Error ? runnerText(t, caught.message) : t(fallback);
}

/** "owner/repo", or an owner on its own for an organization registration. The
 *  same shape RunnerPoolTarget keys have, checked because it selects the row. */
const targetKeySchema = z
    .string()
    .trim()
    .min(1)
    .max(140)
    // i18n-ignore the only refusal here is answered as errors.checkChoice
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/, "Not a repository");

const policySchema = z.object({
    poolId: z.string().uuid(),
    key: targetKeySchema,
    events: z.array(z.enum(RUNNER_EVENTS)).max(RUNNER_EVENTS.length),
    allowForks: z.boolean(),
    allowPublic: z.boolean(),
    secrets: z.boolean()
});

export async function setRepoPolicyAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = policySchema.safeParse(input);
    // What the form sends is chosen, not typed, so a refusal here is a stale or
    // tampered form rather than something to explain field by field.
    if (!parsed.success) return { error: (await getTranslations("runners"))("errors.checkChoice") };
    try {
        await setRepoPolicy(user.id, parsed.data);
    } catch (caught) {
        return { error: await failure(caught, "errors.save") };
    }
    revalidatePath(REPOS_PATH);
    return {};
}

const approvalSchema = z.object({
    owner: z.string().trim().min(1).max(39),
    repo: z.string().trim().min(1).max(100),
    policy: z.enum(FORK_APPROVAL_POLICIES)
});

/**
 * Tighten GitHub's own approval rule for pull requests from outside the
 * repository.
 *
 * Offered here because it is the half Polaris cannot do from the machine: the
 * guard refuses a fork after GitHub has already queued the job, and this stops it
 * being queued at all. It changes a setting on GitHub rather than in Polaris,
 * which is why it is a separate, explicit action.
 */
export async function setForkApprovalAction(input: unknown): Promise<{ error?: string }> {
    await requirePermission("system.manage");
    const parsed = approvalSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("runners"))("errors.checkRepository") };
    try {
        await setForkApproval(parsed.data.owner, parsed.data.repo, parsed.data.policy);
    } catch (caught) {
        return { error: await failure(caught, "errors.githubRefused") };
    }
    revalidatePath(REPOS_PATH);
    return {};
}

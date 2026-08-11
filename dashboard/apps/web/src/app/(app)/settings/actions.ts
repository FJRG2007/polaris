"use server";

/**
 * Settings server actions. Gated to admins: update state and deployment settings
 * are operator surfaces.
 */

import { loadEnv } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { legalContactSchema } from "@polaris/core";
import { setLegalContact } from "@/lib/legal/service";
import { saveUpdateSource } from "@/lib/update-source";
import { type UpdateTrigger } from "@/lib/update-runner";
import { collectUpdateReport, issueUrl } from "@/lib/update-report";
import { getUpdateStatus, resetUpdateStatus, type UpdateStatus } from "@/lib/update-service";
import { getAutoUpdatePolicy, saveAutoUpdatePolicy, startUpdate } from "@/lib/update-watcher";
import { autoUpdatePolicySchema, updateSourceSchema, type AutoUpdatePolicy, type UpdateSource } from "@polaris/core";

/**
 * Current update status. `force` re-reads the registry and GitHub for the "Check
 * for updates" button; simply opening the page takes the cached answer, which
 * keeps a page visit from spending an API call every time.
 */
export async function checkUpdatesAction(force = true): Promise<UpdateStatus> {
    await requireAdmin();
    return getUpdateStatus(force);
}

/** Ask the host agent to install an update the way this deployment is set to. */
export async function triggerHostUpdateAction(): Promise<{ status: UpdateTrigger; }> {
    await requireAdmin();
    return { status: await startUpdate() };
}

/**
 * Change where updates come from. The cached status describes what an update
 * meant under the old answer, so it goes with it: after the switch the card has
 * to re-read, not offer a published image to a deployment that now builds its own.
 */
export async function saveUpdateSourceAction(input: unknown): Promise<{ source?: UpdateSource; error?: string; }> {
    await requireAdmin();
    const parsed = updateSourceSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not a way of updating Polaris." };
    await saveUpdateSource(parsed.data);
    resetUpdateStatus();
    return { source: parsed.data };
}

/** How this deployment installs updates on its own. */
export async function autoUpdatePolicyAction(): Promise<AutoUpdatePolicy> {
    await requireAdmin();
    return getAutoUpdatePolicy();
}

/**
 * Change when updates install themselves. Validated here rather than trusted
 * from the form, because this decides when the deployment restarts itself.
 */
export async function saveAutoUpdateAction(input: unknown): Promise<{ policy?: AutoUpdatePolicy; error?: string; }> {
    await requireAdmin();
    const parsed = autoUpdatePolicySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That schedule is not valid." };
    await saveAutoUpdatePolicy(parsed.data);
    return { policy: parsed.data };
}

/**
 * Change the address shown on the public pages.
 *
 * Its own action rather than part of anything else: those pages are what an
 * outside review desk reads, and this is the one line on them a deployment gets
 * to write. Empty clears it, which publishes no contact at all.
 */
export async function saveLegalContactAction(input: unknown): Promise<{ contact?: string; error?: string; }> {
    await requireAdmin();
    const parsed = legalContactSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That is not a contact." };
    await setLegalContact(parsed.data || null);
    return { contact: parsed.data };
}

/**
 * A prefilled bug report for an update that failed. Admin-only, like the log it
 * quotes: it carries the host's build output and the deployment's own domain.
 *
 * Returns a link rather than filing anything. What goes in is a host's log, so the
 * operator gets to read it on GitHub's own form and decide - the alternative would
 * be publishing their output on their behalf.
 */
export async function updateReportAction(): Promise<{ url: string; }> {
    await requireAdmin();
    return { url: issueUrl(loadEnv().POLARIS_REPO, await collectUpdateReport()) };
}

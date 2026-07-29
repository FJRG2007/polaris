"use server";

/**
 * Settings server actions. The update check re-runs the GitHub comparison,
 * bypassing the cache, so the operator gets a fresh answer on demand. Gated to
 * admins: update state and deployment settings are operator surfaces.
 */

import { HostdClient } from "@polaris/hostd-client";
import { loadEnv } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { getUpdateStatus, type UpdateStatus } from "@/lib/update-service";
import { collectUpdateReport, issueUrl } from "@/lib/update-report";

export async function checkUpdatesAction(): Promise<UpdateStatus> {
    await requireAdmin();
    return getUpdateStatus(true);
}

/** Result of asking the host agent to update and redeploy Polaris. */
export type UpdateTrigger = "started" | "unavailable" | "disabled" | "unreachable";

/**
 * Ask the host agent (hostd) to pull the latest image and redeploy. Degrades to
 * "unreachable" when no agent is running and "unavailable" when it has no update
 * command configured, so the UI can fall back to the manual instruction.
 */
export async function triggerHostUpdateAction(): Promise<{ status: UpdateTrigger }> {
    await requireAdmin();
    try {
        const client = new HostdClient();
        if (!(await client.health())) return { status: "unreachable" };
        return { status: await client.update() };
    } catch {
        return { status: "unreachable" };
    }
}

/**
 * A prefilled bug report for an update that failed. Admin-only, like the log it
 * quotes: it carries the host's build output and the deployment's own domain.
 *
 * Returns a link rather than filing anything. What goes in is a host's log, so the
 * operator gets to read it on GitHub's own form and decide - the alternative would
 * be publishing their output on their behalf.
 */
export async function updateReportAction(): Promise<{ url: string }> {
    await requireAdmin();
    return { url: issueUrl(loadEnv().POLARIS_REPO, await collectUpdateReport()) };
}


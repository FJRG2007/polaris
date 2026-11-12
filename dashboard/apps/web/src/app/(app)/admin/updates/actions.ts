"use server";

/**
 * Updates server actions. Gated to admins: when and how this deployment updates
 * is an operator surface.
 */

import { loadEnv } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { saveUpdateSource } from "@/lib/update-source";
import { ownVulnerabilities, type OwnVulnerabilities } from "@/lib/security/own-images";
import { type UpdateTrigger } from "@/lib/update-runner";
import { collectUpdateReport, issueUrl } from "@/lib/update-report";
import { getUpdateStatus, resetUpdateStatus, type UpdateStatus } from "@/lib/update-service";
import { getAutoUpdatePolicy, saveAutoUpdatePolicy, startUpdate } from "@/lib/update-watcher";
import { recordAudit } from "@/lib/audit-service";
import {
    DEFAULT_QUIET_HOUR,
    getSecurityUpdatePolicy,
    quietHour,
    saveSecurityUpdatePolicy,
    updateChangelog,
    type UpdateChangelog
} from "@/lib/update-changelog";
import { z } from "zod";
import {
    SECURITY_UPDATE_TIMINGS,
    securityUpdateTimesSchema,
    autoUpdatePolicySchema,
    securityPolicyLowers,
    securityPolicyTakesRisk,
    updateSourceSchema,
    type AutoUpdatePolicy,
    type SecurityUpdatePolicy,
    type UpdateSource
} from "@polaris/core";

/**
 * Current update status. `force` re-reads the registry and GitHub for the "Check
 * for updates" button; simply opening the page takes the cached answer, which
 * keeps a page visit from spending an API call every time.
 */
export async function checkUpdatesAction(force = true): Promise<UpdateStatus> {
    await requireAdmin();
    return getUpdateStatus(force);
}

/** What the scans found in Polaris's own images here; null when none ran. */
export async function ownVulnerabilitiesAction(): Promise<OwnVulnerabilities | null> {
    await requireAdmin();
    return ownVulnerabilities().catch(() => null);
}

/** Ask the host agent to install an update the way this deployment is set to. */
export async function triggerHostUpdateAction(): Promise<{ status: UpdateTrigger }> {
    await requireAdmin();
    return { status: await startUpdate() };
}

/**
 * Change where updates come from. The cached status describes what an update
 * meant under the old answer, so it goes with it: after the switch the card has
 * to re-read, not offer a published image to a deployment that now builds its own.
 */
export async function saveUpdateSourceAction(
    input: unknown
): Promise<{ source?: UpdateSource; error?: string }> {
    await requireAdmin();
    const parsed = updateSourceSchema.safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("settings.errors.notASource") };
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
export async function saveAutoUpdateAction(
    input: unknown
): Promise<{ policy?: AutoUpdatePolicy; error?: string }> {
    await requireAdmin();
    const parsed = autoUpdatePolicySchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("admin"))("settings.errors.invalidSchedule")
        };
    await saveAutoUpdatePolicy(parsed.data);
    return { policy: parsed.data };
}

/** What the update on offer carries, read from its commits; null when there is
 *  nothing on offer or GitHub could not be read. */
export async function updateChangelogAction(): Promise<UpdateChangelog | null> {
    await requireAdmin();
    const status = await getUpdateStatus();
    return updateChangelog(status.current, status.latest).catch(() => null);
}

/** How a security fix installs itself here, and the hour "quiet" means. */
export async function securityUpdatePolicyAction(): Promise<{
    policy: SecurityUpdatePolicy;
    quietHour: number;
}> {
    await requireAdmin();
    const [policy, hour] = await Promise.all([getSecurityUpdatePolicy(), quietHour().catch(() => DEFAULT_QUIET_HOUR)]);
    return { policy, quietHour: hour };
}

const timing = z.enum(SECURITY_UPDATE_TIMINGS);
const securityUpdateInput = z.object({
    critical: timing,
    high: timing,
    medium: timing,
    low: timing,
    /** The time each severity set to "every day at" installs at. */
    times: securityUpdateTimesSchema.default({}),
    /** The administrator said, in so many words, that they accept leaving a
     *  critical or high fix waiting. Required for exactly that. */
    acceptRisk: z.boolean().default(false)
});

/**
 * Change how security fixes install themselves.
 *
 * Taking critical or high below "immediately" is refused unless the request
 * carries the administrator's acceptance of the risk, and is recorded - who
 * and when - in the policy and the audit log. Everything else needs nothing.
 */
export async function saveSecurityUpdateAction(
    input: unknown
): Promise<{ policy?: SecurityUpdatePolicy; error?: string }> {
    const user = await requireAdmin();
    const parsed = securityUpdateInput.safeParse(input);
    const t = await getTranslations("admin");
    if (!parsed.success) return { error: t("settings.security.errors.invalid") };
    const { acceptRisk, ...timings } = parsed.data;
    const previous = await getSecurityUpdatePolicy();
    const risky = securityPolicyTakesRisk(timings);
    // Only a change that leaves a critical or high fix waiting longer than it
    // did asks for the acceptance again; saving medium or low beside a risk
    // already accepted keeps that acceptance as it was.
    const lowered = securityPolicyLowers(previous, timings);
    if (lowered && !acceptRisk) return { error: t("settings.security.errors.riskNotAccepted") };
    const policy: SecurityUpdatePolicy = {
        ...timings,
        // A time picked for a severity is kept when it is switched away from
        // "every day at", so switching back does not lose it.
        times: { ...previous.times, ...timings.times },
        riskAccepted: !risky
            ? null
            : lowered || !previous.riskAccepted
              ? { by: user.id, at: new Date().toISOString() }
              : previous.riskAccepted
    };
    await saveSecurityUpdatePolicy(policy);
    await recordAudit({
        actorId: user.id,
        action: "system.security-updates",
        metadata: { ...timings, riskAccepted: risky }
    });
    return { policy };
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

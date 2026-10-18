"use server";

/**
 * Everything the Ad blocker screen asks for and changes.
 *
 * Administrators only: the blocker answers every device's lookups. Each action
 * validates its input against the schema the screen validates with, and a
 * refusal comes back as a sentence in the reader's language rather than a throw.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { findApp } from "@/lib/apps/catalog";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import * as blocker from "@/lib/dns-blocker/service";
import * as insights from "@/lib/dns-blocker/insights";
import * as queryLog from "@/lib/dns-blocker/query-log";
import { getTranslations } from "@/lib/i18n/request";
import { installApp } from "@/lib/apps/install-service";
import { DNS_BLOCKER_APP } from "@/lib/dns-blocker/settings";
import { defaultInstallInput } from "@/lib/apps/install-defaults";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

/** The sentence a failure is shown as. Only refusals written for a reader are
 *  passed on; anything else is logged and said generically. */
async function failed(error: unknown): Promise<{ error: string }> {
    const t = await getTranslations("dnsBlocker");
    if (error instanceof blocker.DnsBlockerRefusal) return { error: t(`errors.${error.code}`) };
    if (error instanceof z.ZodError) return { error: t("errors.invalid") };
    console.error("polaris: ad blocker action failed:", error);
    return { error: t("errors.generic") };
}

function refresh(): void {
    revalidatePath("/apps/dns-blocker");
}

/** Install the app from its own screen. Runs nothing: the DNS server starts only
 *  when somebody turns blocking on. */
export async function installDnsBlockerAppAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        const manifest = findApp(DNS_BLOCKER_APP);
        if (!manifest) return failed(new blocker.DnsBlockerRefusal("notInstalled"));
        const { installedAppId } = await installApp(
            user.id,
            user.id,
            defaultInstallInput(manifest)
        );
        await recordAudit({
            actorId: user.id,
            action: "apps.install",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath("/", "layout");
        revalidatePath("/apps/marketplace");
        refresh();
        return {};
    } catch (error) {
        return failed(error);
    }
}

/** Where the blocker stands. Asked after the first paint, and again on Retry. */
export async function dnsBlockerStatusAction(): Promise<
    Result<{ status: blocker.DnsBlockerStatus }>
> {
    await requireAdmin();
    try {
        return { status: await blocker.dnsBlockerStatus() };
    } catch (error) {
        return failed(error);
    }
}

export async function saveDnsSettingsAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        // Stored even when the DNS server did not take them, so recorded either way.
        const notApplied = await blocker.saveSettings(input, user.id).then(
            () => null,
            (error: unknown) => {
                if (error instanceof blocker.DnsBlockerRefusal && error.code === "notApplied")
                    return error;
                throw error;
            }
        );
        await recordAudit({
            actorId: user.id,
            action: "dnsBlocker.settings",
            targetType: "installedApp",
            targetId: DNS_BLOCKER_APP
        });
        refresh();
        return notApplied ? failed(notApplied) : {};
    } catch (error) {
        return failed(error);
    }
}

/** Turn blocking on, or start the DNS server again when it could not start. */
export async function turnOnDnsBlockerAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        await blocker.turnOn(user.id);
        await recordAudit({
            actorId: user.id,
            action: "dnsBlocker.on",
            targetType: "installedApp",
            targetId: DNS_BLOCKER_APP
        });
        refresh();
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function turnOffDnsBlockerAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        await blocker.turnOff();
        await recordAudit({
            actorId: user.id,
            action: "dnsBlocker.off",
            targetType: "installedApp",
            targetId: DNS_BLOCKER_APP
        });
        refresh();
        return {};
    } catch (error) {
        return failed(error);
    }
}

/** Today's numbers and the newest lookups that match the filter. */
export async function dnsInsightsAction(
    input: unknown,
    fresh?: unknown
): Promise<Result<{ insights: insights.DnsInsights }>> {
    await requireAdmin();
    try {
        return {
            insights: await insights.dnsInsights(
                queryLog.queryFilterSchema.parse(input),
                z.boolean().default(false).parse(fresh)
            )
        };
    } catch (error) {
        return failed(error);
    }
}

/** Let every lookup through for the given minutes. */
export async function pauseDnsBlockingAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const { minutes } = queryLog.pauseSchema.parse(input);
        await insights.pauseBlocking(minutes);
        await recordAudit({ actorId: user.id, action: "dnsBlocker.pause", metadata: { minutes } });
        return {};
    } catch (error) {
        return failed(error);
    }
}

/** End a pause early. */
export async function resumeDnsBlockingAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        await insights.resumeBlocking();
        await recordAudit({ actorId: user.id, action: "dnsBlocker.resume" });
        return {};
    } catch (error) {
        return failed(error);
    }
}

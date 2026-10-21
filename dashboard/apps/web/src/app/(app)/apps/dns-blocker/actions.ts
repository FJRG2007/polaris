"use server";

/**
 * Everything the Network filter screen asks for and changes.
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
import { DNS_BLOCKER_APP, type DnsSettings } from "@/lib/dns-blocker/settings";
import { defaultInstallInput } from "@/lib/apps/install-defaults";
import { networkDevices, type NetworkDevice } from "@/lib/dns-blocker/devices";
import { dnsHistoryInputSchema, type DnsHistory } from "@/lib/dns-blocker/history";
import * as reputation from "@/lib/dns-blocker/reputation-service";
import { applyRuleEdit, dnsRuleEditSchema } from "@/lib/dns-blocker/rules";
import { reputationDomainSchema, type ReputationOff } from "@/lib/dns-blocker/reputation";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

/** The sentence a failure is shown as. Only refusals written for a reader are
 *  passed on; anything else is logged and said generically. */
async function failed(error: unknown): Promise<{ error: string }> {
    const t = await getTranslations("dnsBlocker");
    if (error instanceof blocker.DnsBlockerRefusal) return { error: t(`errors.${error.code}`) };
    if (error instanceof z.ZodError) return { error: t("errors.invalid") };
    console.error("polaris: network filter action failed:", error);
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
        // Which categories are on may have changed what the DNS server's
        // reputation files should hold.
        await reputation.republishReputation();
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

/** The range's numbers and one page of the lookups that match the filter. */
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

/** The newest lookups that match, for the live view. */
export async function dnsTailAction(
    input: unknown
): Promise<Result<{ rows: queryLog.QueryRow[] }>> {
    await requireAdmin();
    try {
        return { rows: await insights.tailQueries(queryLog.queryFilterSchema.parse(input)) };
    } catch (error) {
        return failed(error);
    }
}

/** How many names the lists hold and when they were last loaded. `metrics` is
 *  null when the engine runs a configuration from before they were counted. */
export async function dnsListsAction(): Promise<
    Result<{ metrics: queryLog.EngineMetrics | null }>
> {
    await requireAdmin();
    try {
        return { metrics: await insights.engineMetrics() };
    } catch (error) {
        return failed(error);
    }
}

/** Download every list again now. */
export async function refreshDnsListsAction(): Promise<Result> {
    const user = await requireAdmin();
    try {
        await insights.refreshLists();
        await recordAudit({ actorId: user.id, action: "dnsBlocker.refreshLists" });
        return {};
    } catch (error) {
        return failed(error);
    }
}

/**
 * Allow or block a name from the query log: added to that list, taken off the
 * other, and applied. Answers with the settings as saved, so the form below
 * shows the rule without a reload.
 */
export async function ruleFromLogAction(
    input: unknown
): Promise<Result<{ settings: DnsSettings }>> {
    const user = await requireAdmin();
    try {
        const { domain, list } = queryLog.ruleFromLogSchema.parse(input);
        const current = await blocker.readSettings();
        const other = list === "allow" ? "deny" : "allow";
        const next: DnsSettings = {
            ...current,
            [list]: current[list].includes(domain) ? current[list] : [...current[list], domain],
            [other]: current[other].filter((rule) => rule !== domain)
        };
        const notApplied = await blocker.saveSettings(next, user.id).then(
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
            targetId: DNS_BLOCKER_APP,
            metadata: { [list]: domain }
        });
        refresh();
        return notApplied ? failed(notApplied) : { settings: next };
    } catch (error) {
        return failed(error);
    }
}

/** Whether the blocker blocks one name right now, and by which list. */
export async function dnsLookupAction(
    input: unknown
): Promise<Result<{ lookup: queryLog.DnsLookup }>> {
    await requireAdmin();
    try {
        const { domain } = queryLog.lookupSchema.parse(input);
        return { lookup: await insights.lookupName(domain) };
    } catch (error) {
        return failed(error);
    }
}

/** Every device the log saw over a range, with its name and groups as saved. */
export async function dnsDevicesAction(
    input: unknown
): Promise<Result<{ devices: NetworkDevice[]; logOff: boolean }>> {
    await requireAdmin();
    try {
        const { range, fresh } = z
            .object({
                range: queryLog.queryFilterSchema.shape.range,
                fresh: z.boolean().default(false)
            })
            .parse(input);
        const [seen, settings] = await Promise.all([
            insights.seenDevices(range, fresh),
            blocker.readSettings()
        ]);
        return { devices: networkDevices(seen.devices, settings), logOff: seen.logOff };
    } catch (error) {
        return failed(error);
    }
}

/** The finished days of a range, added up from the rows kept for the long term. */
export async function dnsHistoryAction(input: unknown): Promise<Result<{ history: DnsHistory }>> {
    await requireAdmin();
    try {
        const { range } = dnsHistoryInputSchema.parse(input);
        return { history: await insights.dnsHistory(range) };
    } catch (error) {
        return failed(error);
    }
}

/** Which addresses asked the blocker in the last 24 hours, for the check under the router
 *  steps. The same read of the log as the insights card's unfiltered view. */
export async function dnsClientsAction(
    fresh?: unknown
): Promise<Result<{ clients: readonly string[]; logOff: boolean }>> {
    await requireAdmin();
    try {
        const read = await insights.dnsInsights(
            queryLog.queryFilterSchema.parse({}),
            z.boolean().default(false).parse(fresh)
        );
        return { clients: read.stats.clients.map((client) => client.address), logOff: read.logOff };
    } catch (error) {
        return failed(error);
    }
}

/** Let every lookup through for the given seconds, or until resumed (0). */
export async function pauseDnsBlockingAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    try {
        const { seconds } = queryLog.pauseSchema.parse(input);
        await insights.pauseBlocking(seconds);
        await recordAudit({ actorId: user.id, action: "dnsBlocker.pause", metadata: { seconds } });
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

/** Whether reputation lookups run, and the domains they flagged. */
export async function dnsReputationAction(
    input: unknown
): Promise<Result<{ off: ReputationOff | null; flagged: reputation.FlaggedDomain[] }>> {
    await requireAdmin();
    try {
        const search = z.object({ search: z.string().trim().max(253) }).parse(input).search;
        const [off, flagged] = await Promise.all([
            reputation.reputationOff(),
            reputation.flaggedDomains(search)
        ]);
        return { off, flagged };
    } catch (error) {
        return failed(error);
    }
}

/** Ask Dymo about one flagged domain again now. */
export async function recheckDnsReputationAction(input: unknown): Promise<Result> {
    await requireAdmin();
    try {
        const { domain } = reputationDomainSchema.parse(input);
        const outcome = await reputation.recheckDomain(domain);
        if (outcome === "checked") return {};
        const t = await getTranslations("dnsBlocker");
        return { error: t(`reputation.off.${outcome}`) };
    } catch (error) {
        return failed(error);
    }
}

/** Add, change or remove one of the operator's own rules, saved on its own. */
export async function editDnsRuleAction(
    input: unknown
): Promise<Result<{ settings: DnsSettings }>> {
    const user = await requireAdmin();
    try {
        const edit = dnsRuleEditSchema.parse(input);
        const current = await blocker.readSettings();
        const rules = applyRuleEdit(current, edit);
        if (typeof rules === "string") {
            const t = await getTranslations("dnsBlocker");
            return { error: t(`rules.refusal.${rules}`) };
        }
        const next: DnsSettings = { ...current, ...rules };
        const notApplied = await blocker.saveSettings(next, user.id).then(
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
            targetId: DNS_BLOCKER_APP,
            metadata: { rule: edit.op }
        });
        refresh();
        return notApplied ? failed(notApplied) : { settings: next };
    } catch (error) {
        return failed(error);
    }
}

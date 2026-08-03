"use server";

/**
 * Firewall server actions. One rule per scope, read and written through the same
 * pair regardless of which page is editing - the standalone firewall, a project's
 * own page, or the panel on a single service.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { syncAppRoutes } from "@/lib/deploy-service";
import { syncDashboardRoute } from "@/lib/domain-edge";
import { wafAddressActivity, wafTraffic } from "@/lib/waf-analytics-service";
import { getWafRule, setWafRule, type WafRuleView } from "@/lib/waf-service";
import {
    getWafIgnoreList,
    getWafJails,
    setWafIgnoreList,
    setWafJails,
    type WafJailSettings
} from "@/lib/waf-ban-service";
import {
    currentWafAnomalies,
    getWafAnomalySettings,
    setWafAnomalySettings,
    type WafAnomalySettings
} from "@/lib/waf-anomaly-service";
import {
    getWafFeed,
    listWafBans,
    publishWafIntel,
    recordWafBan,
    removeWafBan,
    setWafFeedEnabled
} from "@/lib/waf-intel-service";
import {
    cidrOrIp,
    WAF_JAIL_IDS,
    WAF_LIST_MAX,
    type WafAddressActivity,
    type WafCustomRule,
    type WafJail,
    type WafAnomaly,
    type WafScopeType,
    type WafTrafficSummary
} from "@polaris/core";

/** The two scopes nobody owns: they reach every service on the instance, or the
 *  dashboard itself, so `deploy.manage` (which an ordinary member holds) is not
 *  enough to read or write them - only `system.manage`. */
const OPERATOR_SCOPES = new Set<WafScopeType>(["global", "polaris"]);

const FIREWALL_PATH = "/apps/firewall";

/** A jail as the panel may change it. The label and the description belong to the
 *  release, so they are not accepted from the client at all. */
const wafJailSchema = z.object({
    id: z.enum(WAF_JAIL_IDS),
    enabled: z.boolean(),
    maxRetry: z.number().int().min(1).max(1000),
    findTimeSec: z.number().int().min(10).max(86400),
    banTimeSec: z.number().int().min(60).max(30 * 24 * 3600)
});

export async function getWafRuleAction(input: {
    scopeType: WafScopeType;
    scopeId: string;
}): Promise<{ rule?: WafRuleView; error?: string }> {
    const user = await requirePermission("deploy.manage");
    if (OPERATOR_SCOPES.has(input.scopeType)) await requirePermission("system.manage");
    try {
        return { rule: await getWafRule(user.id, input.scopeType, input.scopeId) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not load the firewall rule" };
    }
}

/**
 * One scope's rule as the editor holds and writes it - the same shape `getWafRuleAction`
 * returns, so the screen never has to translate between a read and a write.
 *
 * Every field is written on every save because the action takes the whole scope. That
 * is why the editor composes each change against the last saved value rather than
 * against what is on screen: a partial write here would be a silent revert of whatever
 * the caller left out.
 */
export interface WafScopeRule {
    ipAllowlist: string[];
    ipDenylist: string[];
    requireLogin: boolean;
    browserIntegrity: boolean;
    emailObfuscation: boolean;
    presets: string[];
    rules: WafCustomRule[];
}

export async function setWafRuleAction(
    input: WafScopeRule & { scopeType: WafScopeType; scopeId: string }
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    if (OPERATOR_SCOPES.has(input.scopeType)) await requirePermission("system.manage");
    try {
        const { scopeType, scopeId, ...rule } = input;
        await setWafRule(user.id, scopeType, scopeId, rule);
        await recordAudit({ actorId: user.id, action: "deploy.waf.set", targetType: scopeType, targetId: scopeId || "global" });
        // Polaris's own rule lives on the dashboard's route rather than an app's, so
        // it is the dashboard route that has to be republished for it to take effect.
        if (scopeType === "polaris") {
            await syncDashboardRoute();
        } else {
            // The local edge applies instantly via the file provider; remote-server apps
            // pick up the change on their next deploy (their rules ride on container labels).
            await syncAppRoutes().catch(() => undefined);
        }
        revalidatePath("/apps/firewall");
        revalidatePath("/apps/deploy");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the firewall rule" };
    }
}

/**
 * Everything the instance-wide panels show, in one round trip: what the firewall has
 * been doing, who is currently banned, how the jails are set, and which intelligence
 * feeds are on. One action rather than five because the panels are rendered together
 * and five would be five waterfalls.
 */
export async function getWafOverviewAction(hours = 24): Promise<{
    traffic?: WafTrafficSummary;
    bans?: WafBanView[];
    jails?: WafJail[];
    ignore?: string[];
    tor?: { enabled: boolean; count: number; fetchedAt: string | null; error: string | null };
    anomalies?: WafAnomaly[];
    anomalySettings?: WafAnomalySettings;
    error?: string;
}> {
    await requirePermission("system.manage");
    try {
        const [traffic, bans, jails, ignore, feed, anomalies, anomalySettings] = await Promise.all([
            wafTraffic(hours),
            listWafBans(),
            getWafJails(),
            getWafIgnoreList(),
            getWafFeed("tor"),
            currentWafAnomalies(),
            getWafAnomalySettings()
        ]);
        return {
            traffic,
            bans: bans.map((ban) => ({
                ip: ban.ip,
                reason: ban.reason,
                source: ban.source,
                note: ban.note,
                until: ban.until ? ban.until.toISOString() : null,
                offences: ban.offences
            })),
            jails,
            ignore,
            anomalies,
            anomalySettings,
            tor: {
                enabled: feed?.enabled ?? false,
                count: countEntries(feed?.entries),
                fetchedAt: feed?.fetchedAt ? feed.fetchedAt.toISOString() : null,
                error: feed?.error ?? null
            }
        };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not load the firewall overview" };
    }
}

/** A ban as the panel renders it - dates as strings, so it crosses the boundary. */
export interface WafBanView {
    readonly ip: string;
    readonly reason: string;
    readonly source: string;
    readonly note: string | null;
    readonly until: string | null;
    readonly offences: number;
}

function countEntries(json: string | undefined): number {
    if (!json) return 0;
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
        return 0;
    }
}

/**
 * Everything one address did, so a ban can be checked rather than believed.
 *
 * Its own round trip rather than part of the overview: the evidence for one address
 * is hundreds of lines, nobody opens it for most bans, and loading it with the page
 * would make every operator pay for the one who wanted it.
 */
export async function getWafAddressActivityAction(
    ip: string,
    hours = 24
): Promise<{ activity?: WafAddressActivity; error?: string }> {
    await requirePermission("system.manage");
    const address = cidrOrIp.safeParse(ip);
    if (!address.success) return { error: "That is not a valid address" };
    const window = z.number().int().min(1).max(168).safeParse(hours);
    if (!window.success) return { error: "That is not a valid window" };
    try {
        return { activity: await wafAddressActivity(address.data, window.data) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not read that address's activity" };
    }
}

export async function setWafJailsAction(jails: WafJailSettings[]): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = z.array(wafJailSchema).max(32).safeParse(jails);
    if (!parsed.success) return { error: "Those jail settings are not valid" };
    try {
        await setWafJails(parsed.data);
        await recordAudit({ actorId: user.id, action: "waf.jails.set", targetType: "global", targetId: "jails" });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the jail settings" };
    }
}

export async function setWafIgnoreListAction(entries: string[]): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = z.array(cidrOrIp).max(WAF_LIST_MAX).safeParse(entries);
    if (!parsed.success) return { error: "Enter valid IP addresses or CIDR ranges" };
    try {
        await setWafIgnoreList(parsed.data);
        await recordAudit({ actorId: user.id, action: "waf.jails.ignore", targetType: "global", targetId: "ignore" });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the list" };
    }
}

/** Lift a ban by hand. The address can be banned again the moment it re-offends,
 *  which is what makes this safe to offer without a confirmation. */
export async function liftWafBanAction(ip: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = cidrOrIp.safeParse(ip);
    if (!parsed.success) return { error: "That is not a valid address" };
    try {
        await removeWafBan(parsed.data);
        await recordAudit({ actorId: user.id, action: "waf.ban.lift", targetType: "ip", targetId: parsed.data });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not lift the ban" };
    }
}

/** Block or stop blocking the Tor network. Turning it on fetches the exit list
 *  immediately, so the count the panel shows is real rather than pending. */
export async function setTorBlockedAction(enabled: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await setWafFeedEnabled("tor", enabled);
        await recordAudit({ actorId: user.id, action: "waf.feed.tor", targetType: "global", targetId: String(enabled) });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the Tor setting" };
    }
}

const anomalySettingsSchema = z.object({
    enabled: z.boolean(),
    autoBlock: z.boolean(),
    banTimeSec: z.number().int().min(60).max(30 * 24 * 3600),
    minHits: z.number().int().min(5).max(100000),
    overBaseline: z.number().int().min(2).max(1000),
    assetMax: z.number().int().min(5).max(100000),
    variantMax: z.number().int().min(5).max(100000)
});

export async function setWafAnomalySettingsAction(settings: WafAnomalySettings): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = anomalySettingsSchema.safeParse(settings);
    if (!parsed.success) return { error: "Those anomaly settings are not valid" };
    try {
        await setWafAnomalySettings(parsed.data);
        await recordAudit({ actorId: user.id, action: "waf.anomalies.set", targetType: "global", targetId: "anomalies" });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the settings" };
    }
}

/** Block the address behind a finding by hand, for an operator who has looked at the
 *  evidence and does not want to wait for automatic blocking to be trusted. */
export async function blockAnomalyAction(ip: string, note: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = cidrOrIp.safeParse(ip);
    if (!parsed.success) return { error: "That is not a valid address" };
    try {
        const settings = await getWafAnomalySettings();
        await recordWafBan({
            ip: parsed.data,
            reason: "manual",
            source: "anomaly",
            note: note.slice(0, 200),
            until: new Date(Date.now() + settings.banTimeSec * 1000)
        });
        await publishWafIntel();
        await recordAudit({ actorId: user.id, action: "waf.anomaly.block", targetType: "ip", targetId: parsed.data });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not block that address" };
    }
}

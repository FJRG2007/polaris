"use server";

/**
 * Firewall server actions. One rule per scope, read and written through the same
 * pair regardless of which page is editing - the standalone firewall, a project's
 * own page, or the panel on a single service.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { syncAppRoutes } from "@/lib/deploy-service";
import { syncDashboardRoute } from "@/lib/domain-edge";
import { requirePermission, userHasManage } from "@/lib/session";
import { accountsAtAddress, type AddressAccount } from "@/lib/address-accounts";
import { wafAddressActivity, wafLogWindow, wafTraffic } from "@/lib/waf-analytics-service";
import {
    getWafInherited,
    getWafRule,
    setWafRule,
    type WafInheritedView,
    type WafRuleView
} from "@/lib/waf-service";
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
    setWafFeedEnabled,
    wafFeedEnabled
} from "@/lib/waf-intel-service";

type WafAddressActivity = core.WafAddressActivity;
type WafAnomaly = core.WafAnomaly;
type WafCustomRule = core.WafCustomRule;
type WafJail = core.WafJail;
type WafPrincipalGrant = core.WafPrincipalGrant;
type WafPrincipalType = core.WafPrincipalType;
type WafScopeType = core.WafScopeType;
type WafTrafficSummary = core.WafTrafficSummary;

/** The two scopes nobody owns: they reach every service on the instance, or the
 *  dashboard itself, so `deploy.manage` (which an ordinary member holds) is not
 *  enough to read or write them - only `system.manage`. */
const OPERATOR_SCOPES = new Set<WafScopeType>(["global", "polaris"]);

const FIREWALL_PATH = "/apps/firewall";

/** A jail as the panel may change it. The label and the description belong to the
 *  release, so they are not accepted from the client at all. */
const wafJailSchema = z.object({
    id: z.enum(core.WAF_JAIL_IDS),
    enabled: z.boolean(),
    maxRetry: z.number().int().min(1).max(1000),
    findTimeSec: z.number().int().min(10).max(86400),
    banTimeSec: z
        .number()
        .int()
        .min(60)
        .max(30 * 24 * 3600)
});

/** How a feed rule is doing, for the row and the page that open onto it. Instance-wide
 *  however narrow the scope being edited is, which is what the rule's own page says. */
export interface WafFeedView {
    readonly enabled: boolean;
    readonly count: number;
    readonly fetchedAt: string | null;
    readonly error: string | null;
}

/**
 * One scope's rule, what it inherits, and the feeds that apply to it regardless.
 *
 * All three in one round trip because the rule list cannot be drawn without them: a
 * managed row that shows the scope's own switch alone says "Off" for a pack the
 * instance is already enforcing, and a feed row would have nothing to show at all.
 */
export async function getWafRuleAction(input: {
    scopeType: WafScopeType;
    scopeId: string;
}): Promise<{
    rule?: WafRuleView;
    inherited?: WafInheritedView;
    tor?: WafFeedView;
    error?: string;
}> {
    const user = await requirePermission("deploy.manage");
    if (OPERATOR_SCOPES.has(input.scopeType)) await requirePermission("system.manage");
    try {
        const [rule, inherited, tor] = await Promise.all([
            getWafRule(user.id, input.scopeType, input.scopeId),
            getWafInherited(user.id, input.scopeType, input.scopeId),
            torFeedView(await userHasManage(user, "system.manage"))
        ]);
        return { rule, inherited, tor };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "Could not load the firewall rule"
        };
    }
}

/**
 * The Tor feed as the rule list shows it.
 *
 * Whether the rule is on is part of the rule and goes to anyone who may read the scope.
 * How the fetch is going does not: the size of the list, when it last landed and why it
 * last failed are the instance's own plumbing, and a project member editing their own
 * service has no use for "the exit list responded 503" - it is a detail about
 * infrastructure they do not run. So the switch travels and the diagnostics only go to
 * an operator.
 */
async function torFeedView(detailed: boolean): Promise<WafFeedView> {
    const feed = await getWafFeed("tor");
    const enabled = wafFeedEnabled(feed);
    if (!detailed) return { enabled, count: 0, fetchedAt: null, error: null };
    return {
        enabled,
        count: countEntries(feed?.entries),
        fetchedAt: feed?.fetchedAt ? feed.fetchedAt.toISOString() : null,
        error: feed?.error ?? null
    };
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
    loginAllowPrincipals: WafPrincipalGrant[];
    loginDenyPrincipals: WafPrincipalGrant[];
    browserIntegrity: boolean;
    sqlInjectionProtection: boolean;
    xssProtection: boolean;
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
        await recordAudit({
            actorId: user.id,
            action: "deploy.waf.set",
            targetType: scopeType,
            targetId: scopeId || "global"
        });
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
        return {
            error: caught instanceof Error ? caught.message : "Could not save the firewall rule"
        };
    }
}

/** What one rule matches over the recent log, keyed as the caller asked for it. */
export type WafRuleMatches = Record<string, { total: number; series: number[] }>;

/**
 * What each rule on a scope matches, over the traffic the edge actually saw.
 *
 * A replay rather than a record, and the screen says so: the access log knows a
 * request was refused, not which rule refused it, so counting per rule from the log
 * alone would be attribution by guesswork. Running the rules over real traffic answers
 * a better question anyway - it works for a rule that is switched OFF, which is
 * precisely when somebody is deciding whether to arm it.
 *
 * Its own round trip rather than part of the rule, because it reads megabytes of log
 * and the rules themselves have to be on screen immediately.
 */
export async function getWafRuleMatchesAction(input: {
    scopeType: WafScopeType;
    scopeId: string;
    hours?: number;
}): Promise<{ matches?: WafRuleMatches; from?: number; to?: number; error?: string }> {
    const user = await requirePermission("deploy.manage");
    if (OPERATOR_SCOPES.has(input.scopeType)) await requirePermission("system.manage");
    try {
        const hours = Math.max(1, Math.min(input.hours ?? 24, 24 * 7));
        const rule = await getWafRule(user.id, input.scopeType, input.scopeId);

        // A managed rule expands to several rules and the row shows the pack, so each
        // probe carries the row it belongs to and the parts are summed back together.
        const owners = new Map<string, string>();
        const probes = rule.rules.map((entry, index) => {
            const key = `c${index}`;
            owners.set(key, `custom:${index}`);
            return { key, rule: entry };
        });
        // Every managed rule, armed or not: "what would this catch here?" is the
        // question an operator looking at the switch is trying to answer.
        for (const managed of core.WAF_MANAGED_RULES) {
            managed.rules.forEach((entry, index) => {
                const key = `m${managed.id}#${index}`;
                owners.set(key, managed.id);
                probes.push({ key, rule: entry });
            });
        }

        const { entries, from, to } = await wafLogWindow(hours);
        const matches: WafRuleMatches = {};
        for (const [key, value] of core.wafRuleActivity(entries, probes, from, to)) {
            const owner = owners.get(key);
            if (!owner) continue;
            const current = matches[owner] ?? { total: 0, series: value.series.map(() => 0) };
            current.total += value.total;
            value.series.forEach((count, index) => {
                current.series[index] = (current.series[index] ?? 0) + count;
            });
            matches[owner] = current;
        }
        return { matches, from, to };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "Could not read recent traffic"
        };
    }
}

/** Somebody a require-login rule can name, as the picker lists them. */
export interface WafPrincipalOption {
    /** `<type>:<id>`, the form the rule stores and the edge compares. */
    readonly ref: string;
    readonly type: WafPrincipalType;
    readonly label: string;
    /** What tells two people with the same name apart. Absent for groups and roles,
     *  whose names are unique already. */
    readonly sublabel?: string;
}

/**
 * Who a require-login rule can be narrowed to: every user, group and role on the
 * instance.
 *
 * Its own round trip rather than part of the rule, because most scopes never require a
 * login and the ones that do usually admit everybody - so loading the directory with
 * the firewall would make every operator pay for the few who narrow it.
 *
 * Gated on `deploy.manage` like the rule itself and nothing stricter: naming who may
 * reach a service is part of configuring it, and the list is names and email addresses
 * of colleagues on the same instance rather than anything the caller could not already
 * see. It is a read - who exists - and never a write to any of them.
 */
export async function listWafPrincipalsAction(): Promise<{
    principals?: WafPrincipalOption[];
    error?: string;
}> {
    await requirePermission("deploy.manage");
    try {
        const [users, groups, roles] = await Promise.all([
            prisma.user.findMany({
                select: { id: true, name: true, email: true },
                orderBy: { name: "asc" }
            }),
            prisma.group.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
            prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
        ]);
        return {
            principals: [
                // Roles and groups first: naming one is how an operator writes a rule
                // that keeps meaning what they meant after the next person joins.
                ...roles.map((role) => ({
                    ref: `role:${role.id}`,
                    type: "role" as const,
                    label: role.name
                })),
                ...groups.map((group) => ({
                    ref: `group:${group.id}`,
                    type: "group" as const,
                    label: group.name
                })),
                ...users.map((user) => ({
                    ref: `user:${user.id}`,
                    type: "user" as const,
                    label: user.name,
                    sublabel: user.email
                }))
            ]
        };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not load the directory" };
    }
}

/**
 * Everything the instance-wide panels show, in one round trip: what the firewall has
 * been doing, who is currently banned, how the jails are set, and which addresses it
 * leaves alone. One action rather than five because the panels are rendered together
 * and five would be five waterfalls.
 *
 * The Tor list is not here: it is a rule now, and it is read with the rest of them.
 */
export async function getWafOverviewAction(hours = 24): Promise<{
    traffic?: WafTrafficSummary;
    bans?: WafBanView[];
    jails?: WafJail[];
    trusted?: string[];
    anomalies?: WafAnomaly[];
    anomalySettings?: WafAnomalySettings;
    error?: string;
}> {
    await requirePermission("system.manage");
    try {
        const [traffic, bans, jails, trusted, anomalies, anomalySettings] = await Promise.all([
            wafTraffic(hours),
            listWafBans(),
            getWafJails(),
            getWafIgnoreList(),
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
            trusted,
            anomalies,
            anomalySettings
        };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "Could not load the firewall overview"
        };
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
 *
 * Who was signed in from it travels with the requests, and only to an administrator.
 * It is the same second question every time - "is this one of ours?" - and it names
 * accounts, which is the People screen's to give out and no operator's by default.
 * Absent rather than empty when the reader may not have it, so the screen can tell
 * "nobody has ever signed in from here" from "not yours to see".
 *
 * A failure to read them costs the names and nothing else. The requests are what
 * the dialog was opened for and the evidence a ban is judged on; replacing them
 * with an error because the second, optional question could not be answered would
 * withhold the answer the reader came for.
 */
export async function getWafAddressActivityAction(
    ip: string,
    hours = 24
): Promise<{ activity?: WafAddressActivity; accounts?: AddressAccount[]; error?: string }> {
    const user = await requirePermission("system.manage");
    const address = core.cidrOrIp.safeParse(ip);
    if (!address.success) return { error: "That is not a valid address" };
    const window = z.number().int().min(1).max(168).safeParse(hours);
    if (!window.success) return { error: "That is not a valid window" };
    try {
        const [activity, accounts] = await Promise.all([
            wafAddressActivity(address.data, window.data),
            user.isAdmin
                ? accountsAtAddress(address.data).catch((error) => {
                      console.error("polaris: could not read the accounts at an address:", error);
                      return undefined;
                  })
                : undefined
        ]);
        return { activity, accounts };
    } catch (caught) {
        return {
            error:
                caught instanceof Error ? caught.message : "Could not read that address's activity"
        };
    }
}

export async function setWafJailsAction(jails: WafJailSettings[]): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = z.array(wafJailSchema).max(32).safeParse(jails);
    if (!parsed.success) return { error: "Those jail settings are not valid" };
    try {
        await setWafJails(parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "waf.jails.set",
            targetType: "global",
            targetId: "jails"
        });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "Could not save the jail settings"
        };
    }
}

export async function setWafIgnoreListAction(entries: string[]): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = z.array(core.cidrOrIp).max(core.WAF_LIST_MAX).safeParse(entries);
    if (!parsed.success) return { error: "Enter valid IP addresses or CIDR ranges" };
    try {
        await setWafIgnoreList(parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "waf.jails.ignore",
            targetType: "global",
            targetId: "ignore"
        });
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
    const parsed = core.cidrOrIp.safeParse(ip);
    if (!parsed.success) return { error: "That is not a valid address" };
    try {
        await removeWafBan(parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "waf.ban.lift",
            targetType: "ip",
            targetId: parsed.data
        });
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
        await recordAudit({
            actorId: user.id,
            action: "waf.feed.tor",
            targetType: "global",
            targetId: String(enabled)
        });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "Could not change the Tor setting"
        };
    }
}

const anomalySettingsSchema = z.object({
    enabled: z.boolean(),
    autoBlock: z.boolean(),
    banTimeSec: z
        .number()
        .int()
        .min(60)
        .max(30 * 24 * 3600),
    minHits: z.number().int().min(5).max(100000),
    overBaseline: z.number().int().min(2).max(1000),
    assetMax: z.number().int().min(5).max(100000),
    variantMax: z.number().int().min(5).max(100000)
});

export async function setWafAnomalySettingsAction(
    settings: WafAnomalySettings
): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = anomalySettingsSchema.safeParse(settings);
    if (!parsed.success) return { error: "Those anomaly settings are not valid" };
    try {
        await setWafAnomalySettings(parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "waf.anomalies.set",
            targetType: "global",
            targetId: "anomalies"
        });
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
    const parsed = core.cidrOrIp.safeParse(ip);
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
        await recordAudit({
            actorId: user.id,
            action: "waf.anomaly.block",
            targetType: "ip",
            targetId: parsed.data
        });
        revalidatePath(FIREWALL_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not block that address" };
    }
}

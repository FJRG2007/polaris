"use server";

/**
 * Firewall server actions. One rule per scope, read and written through the same
 * pair regardless of which page is editing - the standalone firewall, a project's
 * own page, or the panel on a single service.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as intel from "@/lib/waf-intel-service";
import { recordAudit } from "@/lib/audit-service";
import { syncAppRoutes } from "@/lib/deploy-service";
import { syncDashboardRoute } from "@/lib/domain-edge";
import { requirePermission, userHasManage } from "@/lib/session";
import { accountsAtAddress, type AddressAccounts } from "@/lib/address-accounts";
import { liftHostBlocks } from "@/lib/waf-ssh-service";
import { getWafJails, setWafJails, type WafJailSettings } from "@/lib/waf-ban-service";
import { wafAddressActivity, wafLogWindow, wafTraffic } from "@/lib/waf-analytics-service";
import {
    getWafInherited,
    getWafRule,
    setWafRule,
    type WafInheritedView,
    type WafRuleView
} from "@/lib/waf-service";
import {
    currentWafAnomalies,
    getWafAnomalySettings,
    setWafAnomalySettings,
    type WafAnomalySettings
} from "@/lib/waf-anomaly-service";
import { getTranslations } from "@/lib/i18n/request";
import { findAccountsAsAdmin, findPeople, SHORTEST_SEARCH } from "@/lib/people-search";
import { like } from "@/lib/rich-text/mention-service";
import type { NamespaceKey } from "@/lib/i18n/types";

type FirewallKey = NamespaceKey<"firewall">;

/** A reply in the reader's language. */
async function say(key: FirewallKey): Promise<string> {
    return (await getTranslations("firewall"))(key);
}

/** What went wrong, for the reader: a service's own sentence passes through, and
 *  anything that is not an Error reads as `fallback`. */
async function failure(caught: unknown, fallback: FirewallKey): Promise<string> {
    return caught instanceof Error ? caught.message : say(fallback);
}

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

// None of these revalidates the page. The screen reads everything it shows through
// these actions and keeps it itself, and a revalidation from an action re-renders the
// whole route on every switch - which is what made the page flicker under the finger.

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
            error: await failure(caught, "errors.load")
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
    const feed = await intel.getWafFeed("tor");
    const enabled = intel.wafFeedEnabled(feed);
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
    frameProtection: boolean;
    frameAncestors: string[];
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
        return {};
    } catch (caught) {
        return {
            error: await failure(caught, "errors.save")
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
            error: await failure(caught, "errors.traffic")
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

/** The most stored refs one read resolves - well past any rule anybody writes. */
const MAX_NAMED = 200;

/** How many people one search offers. */
const PEOPLE_FOUND = 20;

const namedRefsSchema = z.array(z.string().trim().min(1).max(80)).max(MAX_NAMED);

const principalSearchSchema = z.string().trim().max(120);

const scopeSchema = z.object({
    scopeType: z.enum(core.WAF_SCOPE_TYPES),
    scopeId: z.string().max(80)
});

/** The ids of one kind among stored refs, as uuids - anything else names nobody. */
function idsOf(refs: readonly string[], type: WafPrincipalType): string[] {
    const ids = refs
        .filter((ref) => ref.startsWith(`${type}:`))
        .map((ref) => ref.slice(type.length + 1));
    return ids.filter((id) => z.string().uuid().safeParse(id).success);
}

/**
 * The roles and groups a require-login rule can be narrowed to, and the names of
 * whoever the rule being edited already names.
 *
 * Scoped to the caller. An instance administrator is offered every role and group;
 * anybody else holding `deploy.manage` - a customer of a hosting company running
 * their own services on it - is offered the roles and groups they are in, and
 * nothing that would tell them who else the instance serves. People are never
 * listed here: they are found by name with `findWafPeopleAction`, which is bounded
 * and honours each person's own say over who can find them. The directory this
 * used to return was every account's name and email address, to anybody who could
 * deploy.
 *
 * `scope` is the rule on screen. The entries stored in it are resolved whoever
 * they are, because the rule is the caller's to edit and an entry they cannot
 * read is one they cannot remove; a person outside the caller's reach is named
 * without their email address. They are read from the stored rule, after the
 * same ownership check that guards reading it, and never taken from the
 * request - ids sent by the browser would name anybody on the instance.
 */
export async function listWafPrincipalsAction(scope?: {
    scopeType: WafScopeType;
    scopeId: string;
}): Promise<{
    principals?: WafPrincipalOption[];
    error?: string;
}> {
    const user = await requirePermission("deploy.manage");
    const where = scopeSchema.optional().safeParse(scope);
    if (!where.success) return { error: await say("errors.directory") };
    if (where.data && OPERATOR_SCOPES.has(where.data.scopeType)) await requirePermission("system.manage");
    try {
        const stored = where.data ? await getWafRule(user.id, where.data.scopeType, where.data.scopeId) : null;
        const refs = namedRefsSchema.safeParse(
            stored ? [...stored.loginAllowPrincipals, ...stored.loginDenyPrincipals].map((grant) => grant.ref) : []
        );
        if (!refs.success) return { error: await say("errors.directory") };
        const mine = user.isAdmin ? {} : { members: { some: { userId: user.id } } };
        const [roles, groups, namedRoles, namedGroups, namedUsers] = await Promise.all([
            prisma.role.findMany({
                where: user.isAdmin ? {} : { users: { some: { userId: user.id } } },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
                take: MAX_NAMED
            }),
            prisma.group.findMany({
                where: mine,
                select: { id: true, name: true },
                orderBy: { name: "asc" },
                take: MAX_NAMED
            }),
            prisma.role.findMany({
                where: { id: { in: idsOf(refs.data, "role") } },
                select: { id: true, name: true }
            }),
            prisma.group.findMany({
                where: { id: { in: idsOf(refs.data, "group") } },
                select: { id: true, name: true }
            }),
            prisma.user.findMany({
                where: { id: { in: idsOf(refs.data, "user") } },
                select: { id: true, name: true, email: true }
            })
        ]);
        const offered = new Map<string, WafPrincipalOption>();
        // Roles and groups first: naming one is how an operator writes a rule that
        // keeps meaning what they meant after the next person joins.
        for (const role of [...roles, ...namedRoles]) {
            offered.set(`role:${role.id}`, { ref: `role:${role.id}`, type: "role", label: role.name });
        }
        for (const group of [...groups, ...namedGroups]) {
            offered.set(`group:${group.id}`, { ref: `group:${group.id}`, type: "group", label: group.name });
        }
        for (const person of namedUsers) {
            offered.set(`user:${person.id}`, {
                ref: `user:${person.id}`,
                type: "user",
                label: person.name,
                sublabel: user.isAdmin || person.id === user.id ? person.email : undefined
            });
        }
        return { principals: [...offered.values()] };
    } catch (caught) {
        return { error: await failure(caught, "errors.directory") };
    }
}

/**
 * People a require-login rule can name, found by what was typed.
 *
 * An administrator finds anybody on the instance, by name, email or username,
 * since they can already read the whole directory. Anybody else finds whoever
 * they could find anywhere else in Polaris - the same search the share dialogs
 * use, which leaves out people who chose not to be found and people either side
 * has blocked - and themselves. Either way it is a page of matches, never a list
 * of everybody.
 */
export async function findWafPeopleAction(query: string): Promise<{
    results?: { id: string; name: string }[];
    error?: string;
}> {
    const user = await requirePermission("deploy.manage");
    const parsed = principalSearchSchema.safeParse(query);
    if (!parsed.success || parsed.data.length < SHORTEST_SEARCH) return { results: [] };
    const term = parsed.data;
    try {
        if (user.isAdmin) return { results: await findAccountsAsAdmin(term, PEOPLE_FOUND) };
        const contains = like(term);
        const [found, self] = await Promise.all([
            findPeople({ id: user.id }, term, { reachableOnly: false, limit: PEOPLE_FOUND }),
            prisma.user.findFirst({
                where: { id: user.id, OR: [{ name: contains }, { email: contains }, { username: contains }] },
                select: { id: true, name: true }
            })
        ]);
        return { results: self ? [self, ...found.people] : found.people };
    } catch (caught) {
        return { error: await failure(caught, "errors.directory") };
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
            intel.listWafBans(),
            getWafJails(),
            intel.getWafIgnoreList(),
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
            error: await failure(caught, "errors.overview")
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
 * Absent rather than empty whenever it was not asked - a reader who may not have it,
 * or a range, which is recorded against no address in particular - so the screen can
 * tell "nobody has ever signed in from here" from "nobody looked".
 *
 * A failure to read them costs the names and nothing else. The requests are what
 * the dialog was opened for and the evidence a ban is judged on; replacing them
 * with an error because the second, optional question could not be answered would
 * withhold the answer the reader came for.
 *
 * Naming them is recorded. The log holds addresses hashed precisely so they are not
 * kept in the clear, and this is the one path that reverses that - an administrator
 * submits an address and is told which accounts have signed in from it. A read that
 * turns the log's own privacy inside out is worth a line of its own.
 */
export async function getWafAddressActivityAction(
    ip: string,
    hours = 24
): Promise<{
    activity?: WafAddressActivity;
    accounts?: AddressAccounts;
    ban?: Awaited<ReturnType<typeof intel.wafBanFor>>;
    error?: string;
}> {
    const user = await requirePermission("system.manage");
    const address = core.cidrOrIp.safeParse(ip);
    if (!address.success) return { error: await say("errors.address") };
    const window = z.number().int().min(1).max(168).safeParse(hours);
    if (!window.success) return { error: await say("errors.window") };
    try {
        // A ban can be a range, and sessions and sign-ins are recorded against the
        // one address they came from - so a range matches nothing, and answering it
        // with an empty list would say "nobody has ever signed in from here" about
        // addresses nobody looked at. Left out instead, which the screen already
        // reads as "not asked" rather than as "none".
        const [activity, accounts, ban] = await Promise.all([
            wafAddressActivity(address.data, window.data),
            user.isAdmin && core.isIpAddress(address.data)
                ? accountsAtAddress(address.data).catch((error) => {
                      console.error("polaris: could not read the accounts at an address:", error);
                      return undefined;
                  })
                : undefined,
            // Why this address is being turned away, which the request list cannot
            // say: it shows 403s without the rule that produced them, and reading a
            // reason out of a wall of them is the operator's job only because nothing
            // here was doing it.
            intel.wafBanFor(address.data).catch((error) => {
                console.error("polaris: could not read the ban on an address:", error);
                return undefined;
            })
        ]);
        // Only when they were actually named: a range, a reader who may not have
        // them, and a lookup that failed all leave nothing to have looked at.
        if (accounts) {
            await recordAudit({
                actorId: user.id,
                action: "waf.address.accounts",
                targetType: "ip",
                targetId: address.data,
                metadata: { accounts: accounts.list.length }
            });
        }
        return { activity, accounts, ban: ban ?? undefined };
    } catch (caught) {
        return {
            error: await failure(caught, "errors.activity")
        };
    }
}

export async function setWafJailsAction(jails: WafJailSettings[]): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = z.array(wafJailSchema).max(32).safeParse(jails);
    if (!parsed.success) return { error: await say("errors.jailsInvalid") };
    try {
        await setWafJails(parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "waf.jails.set",
            targetType: "global",
            targetId: "jails"
        });
        return {};
    } catch (caught) {
        return {
            error: await failure(caught, "errors.jailsSave")
        };
    }
}

export async function setWafIgnoreListAction(entries: string[]): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = z.array(core.cidrOrIp).max(core.WAF_LIST_MAX).safeParse(entries);
    if (!parsed.success) return { error: await say("errors.addresses") };
    try {
        await intel.setWafIgnoreList(parsed.data);
        // Trusting lifts the bans, and a ban reaches the machines as well as the edge.
        for (const ip of parsed.data) {
            await liftHostBlocks(ip).catch((error) => {
                console.error("polaris: could not lift a host-level block:", error);
            });
        }
        await recordAudit({
            actorId: user.id,
            action: "waf.jails.ignore",
            targetType: "global",
            targetId: "ignore"
        });
        return {};
    } catch (caught) {
        return { error: await failure(caught, "errors.listSave") };
    }
}

/** Lift a ban by hand. The address can be banned again the moment it re-offends,
 *  which is what makes this safe to offer without a confirmation. */
export async function liftWafBanAction(ip: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = core.cidrOrIp.safeParse(ip);
    if (!parsed.success) return { error: await say("errors.address") };
    try {
        await intel.removeWafBan(parsed.data);
        // The edge is only half of where a ban lives; the SSH jail drops the address
        // in each machine's own firewall, and a row deleted here left that in place.
        await liftHostBlocks(parsed.data).catch((error) => {
            console.error("polaris: could not lift a host-level block:", error);
        });
        await recordAudit({
            actorId: user.id,
            action: "waf.ban.lift",
            targetType: "ip",
            targetId: parsed.data
        });
        return {};
    } catch (caught) {
        return { error: await failure(caught, "errors.lift") };
    }
}

/** Block or stop blocking the Tor network. Turning it on fetches the exit list
 *  immediately, so the count the panel shows is real rather than pending. */
export async function setTorBlockedAction(enabled: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await intel.setWafFeedEnabled("tor", enabled);
        await recordAudit({
            actorId: user.id,
            action: "waf.feed.tor",
            targetType: "global",
            targetId: String(enabled)
        });
        return {};
    } catch (caught) {
        return {
            error: await failure(caught, "errors.tor")
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
    if (!parsed.success) return { error: await say("errors.anomalyInvalid") };
    try {
        await setWafAnomalySettings(parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "waf.anomalies.set",
            targetType: "global",
            targetId: "anomalies"
        });
        return {};
    } catch (caught) {
        return { error: await failure(caught, "errors.settingsSave") };
    }
}

/** Block the address behind a finding by hand, for an operator who has looked at the
 *  evidence and does not want to wait for automatic blocking to be trusted. */
export async function blockAnomalyAction(ip: string, note: string): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = core.cidrOrIp.safeParse(ip);
    if (!parsed.success) return { error: await say("errors.address") };
    try {
        const settings = await getWafAnomalySettings();
        await intel.recordWafBan({
            ip: parsed.data,
            reason: "manual",
            source: "anomaly",
            note: note.slice(0, 200),
            until: new Date(Date.now() + settings.banTimeSec * 1000)
        });
        await intel.publishWafIntel();
        await recordAudit({
            actorId: user.id,
            action: "waf.anomaly.block",
            targetType: "ip",
            targetId: parsed.data
        });
        return {};
    } catch (caught) {
        return { error: await failure(caught, "errors.block") };
    }
}

/**
 * An account's own access rules, server side: reading and saving them, carrying an
 * account's old sign-in allowlist into them, and judging a sign-in or a session's
 * request against them.
 *
 * The evaluation itself is `evaluateAccountRules` in @polaris/core, the same pure
 * function the preview on the screen runs. This module only resolves the facts it
 * reads - the location and the network reputation are looked up only when a rule
 * actually asks about them, so an account with no such rule costs no lookup.
 *
 * Limits an administrator imposed (`resolveEnforcedRules`) are judged first and on
 * their own: an account's rules can narrow what it may do, never widen that.
 */

import { prisma, type Prisma } from "@polaris/db";
import { resolveEnforcedRules } from "@polaris/auth";
import {
    accountRuleFieldsUsed,
    accountRuleGroupIds,
    accountRuleSchema,
    describeClient,
    evaluateAccountRules,
    isHandheld,
    legacyAllowlistRule,
    unionRules,
    type AccountRule,
    type AccountRuleFacts,
    type AccountRuleNetwork,
    type AccountRuleVerdict,
    type EffectiveAccessRules
} from "@polaris/core";
import { resolveGeo } from "@/lib/geo-service";
import { verifyIp } from "@/lib/integrations/dymo";
import { evaluateNetworkRules } from "@/lib/network-rules";
import { takeServedLookup } from "@/lib/integrations/provider-pause";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

/** The name the carried-over rule and saved list are given. Stored text, kept in
 *  English like every other server-written name; the owner can rename either. */
const IMPORTED_RULE_NAME = "Sign-in places (from earlier settings)";
const IMPORTED_GROUP_NAME = "Sign-in places (from earlier settings)";

/** What a request said about the browser making it. */
export interface RequestClient {
    readonly userAgent: string | null;
    readonly brands: string | null;
    readonly platform: string | null;
}

function hasEntries(row: { allowedCidrs: string; allowedCountries: string; allowedContinents: string }): boolean {
    const union = unionRules([row]);
    return union.allowedCidrs.length > 0 || union.allowedCountries.length > 0 || union.allowedContinents.length > 0;
}

/**
 * Carry the account's old sign-in allowlist into its rules, once.
 *
 * The marker is claimed in the same transaction that writes the rule, with a
 * conditional update, so two requests racing on first sight do it once and a
 * retry after a failure does it again from the start. Nothing old is deleted:
 * the inline entries are copied into a saved list (so they stay editable, and
 * the rule keeps the union the old evaluator enforced), the groups bound to the
 * account are named by the rule as they are, and the old columns are left in
 * place - they are simply no longer read for this account.
 */
export async function ensureAccountRulesMigrated(userId: string): Promise<void> {
    const security = await prisma.userSecurity.findUnique({
        where: { userId },
        select: { accessRulesMigratedAt: true, allowedCidrs: true, allowedCountries: true, allowedContinents: true }
    });
    // No settings row has no old allowlist either.
    if (!security || security.accessRulesMigratedAt) return;
    await migrateAccountRules(userId);
}

/** The move itself, exported for the test that holds it to the old semantics. */
export async function migrateAccountRules(userId: string): Promise<{ migrated: boolean; groupIds: string[] }> {
    return prisma.$transaction(async (tx) => {
        const claimed = await tx.userSecurity.updateMany({
            where: { userId, accessRulesMigratedAt: null },
            data: { accessRulesMigratedAt: new Date() }
        });
        if (claimed.count === 0) return { migrated: false, groupIds: [] };

        const [inline, bindings] = await Promise.all([
            tx.userSecurity.findUnique({
                where: { userId },
                select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true }
            }),
            tx.userAccessGroup.findMany({ where: { userId, enforced: false }, select: { groupId: true } })
        ]);
        const groupIds = bindings.map((binding) => binding.groupId);
        if (inline && hasEntries(inline)) {
            // A name already taken (the owner made one called that) gets a number,
            // so the copy is never refused and never merged into somebody's list.
            const taken = new Set(
                (await tx.accessGroup.findMany({ where: { ownerId: userId }, select: { name: true } })).map((row) => row.name)
            );
            let name = IMPORTED_GROUP_NAME;
            for (let n = 2; taken.has(name); n += 1) name = `${IMPORTED_GROUP_NAME} ${n}`;
            const group = await tx.accessGroup.create({
                data: {
                    ownerId: userId,
                    name,
                    allowedCidrs: inline.allowedCidrs,
                    allowedCountries: inline.allowedCountries,
                    allowedContinents: inline.allowedContinents
                },
                select: { id: true }
            });
            groupIds.unshift(group.id);
        }
        if (groupIds.length === 0) return { migrated: true, groupIds };

        const rule = legacyAllowlistRule(groupIds, IMPORTED_RULE_NAME);
        const position = await tx.accountAccessRule.count({ where: { userId } });
        await tx.accountAccessRule.create({
            data: {
                userId,
                position,
                name: rule.name,
                enabled: rule.enabled,
                action: rule.action,
                timeZone: rule.timeZone,
                conditions: rule.conditions as unknown as Prisma.InputJsonValue
            }
        });
        return { migrated: true, groupIds };
    });
}

/** The account's rules, in order. A stored row that no longer parses is reported
 *  and kept out of evaluation - every write goes through the same schema, so this
 *  is a corrupted row, and guessing at what it meant is worse. */
export async function listAccountRules(userId: string): Promise<AccountRule[]> {
    await ensureAccountRulesMigrated(userId);
    const rows = await prisma.accountAccessRule.findMany({
        where: { userId },
        orderBy: { position: "asc" },
        select: { id: true, name: true, enabled: true, action: true, conditions: true, timeZone: true }
    });
    const rules: AccountRule[] = [];
    for (const row of rows) {
        const parsed = accountRuleSchema.safeParse({ ...row });
        if (parsed.success) rules.push(parsed.data);
        else console.error(`account access rule ${row.id} does not parse:`, parsed.error.issues[0]?.message);
    }
    return rules;
}

/** Replace the account's rules with these, in this order. */
export async function saveAccountRules(userId: string, rules: readonly AccountRule[]): Promise<void> {
    await ensureAccountRulesMigrated(userId);
    await prisma.$transaction([
        prisma.accountAccessRule.deleteMany({ where: { userId } }),
        prisma.accountAccessRule.createMany({
            data: rules.map((rule, position) => ({
                ...(rule.id ? { id: rule.id } : {}),
                userId,
                position,
                name: rule.name,
                enabled: rule.enabled,
                action: rule.action,
                timeZone: rule.timeZone,
                conditions: rule.conditions as unknown as Prisma.InputJsonValue
            }))
        })
    ]);
}

/** Whether this Polaris can tell what kind of network an address is on. */
export async function reputationAvailable(): Promise<boolean> {
    const state = await getIntegrationState("dymo");
    if (!state?.enabled) return false;
    return Boolean(await getIntegrationSecret("dymo"));
}

const NETWORK_BY_REASON: Record<string, AccountRuleNetwork> = {
    VPN: "vpn",
    PROXY: "proxy",
    TOR_NETWORK: "tor",
    FRAUD: "fraud",
    HIGH_RISK_SCORE: "high_risk"
};

/** Bounded, short-lived memory of what the provider said, so a session moving
 *  between requests is not one paid lookup per request. */
const networkMemo = new Map<string, { at: number; network: ReadonlySet<AccountRuleNetwork> }>();
const NETWORK_MEMO_MS = 60 * 60_000;
const NETWORK_MEMO_MAX = 5_000;

/** What the reputation provider says about an address, or null when it cannot be
 *  asked - no integration, no key, no budget, or an error. Null satisfies no rule,
 *  so an outage never locks anyone out. */
export async function networkOf(ip: string | null): Promise<ReadonlySet<AccountRuleNetwork> | null> {
    if (!ip) return null;
    const memo = networkMemo.get(ip);
    if (memo && Date.now() - memo.at < NETWORK_MEMO_MS) return memo.network;
    const state = await getIntegrationState("dymo");
    if (!state?.enabled) return null;
    const apiKey = await getIntegrationSecret("dymo");
    if (!apiKey || !(await takeServedLookup("dymo"))) return null;
    try {
        const { reasons } = await verifyIp(apiKey, ip, Object.keys(NETWORK_BY_REASON));
        const network = new Set(reasons.map((reason) => NETWORK_BY_REASON[reason]).filter((value) => !!value));
        if (networkMemo.size >= NETWORK_MEMO_MAX) networkMemo.delete(networkMemo.keys().next().value as string);
        networkMemo.set(ip, { at: Date.now(), network });
        return network;
    } catch {
        return null;
    }
}

/** The saved lists the rules name, owned by this account. */
async function groupsFor(userId: string, rules: readonly AccountRule[]): Promise<Map<string, EffectiveAccessRules>> {
    const ids = accountRuleGroupIds(rules);
    if (ids.length === 0) return new Map();
    const rows = await prisma.accessGroup.findMany({
        where: { ownerId: userId, id: { in: ids } },
        select: { id: true, allowedCidrs: true, allowedCountries: true, allowedContinents: true }
    });
    return new Map(rows.map((row) => [row.id, unionRules([row])]));
}

/** A saved list as it would be after an edit (`replacement`) or a delete (null),
 *  so a change to a list can be judged before it is written. */
export interface GroupChange {
    readonly id: string;
    readonly replacement: EffectiveAccessRules | null;
}

/** Resolve exactly the facts these rules read. */
export async function resolveAccountRuleFacts(
    userId: string,
    rules: readonly AccountRule[],
    ip: string | null,
    client: RequestClient,
    knownCountry?: string | null,
    groupChange?: GroupChange
): Promise<AccountRuleFacts> {
    const used = accountRuleFieldsUsed(rules);
    const reading = describeClient(client.userAgent, client.brands, client.platform);
    const needsPlace = used.has("country") || used.has("continent") || used.has("access_group");
    const [country, network, groups] = await Promise.all([
        knownCountry !== undefined
            ? Promise.resolve(knownCountry)
            : needsPlace && ip
              ? resolveGeo(ip).then((geo) => geo.countryCode)
              : Promise.resolve(null),
        used.has("network") ? networkOf(ip) : Promise.resolve(null),
        groupsFor(userId, rules)
    ]);
    if (groupChange && groups.has(groupChange.id)) {
        if (groupChange.replacement) groups.set(groupChange.id, groupChange.replacement);
        else groups.delete(groupChange.id);
    }
    return {
        ip,
        country,
        os: client.userAgent ? reading.os : null,
        browser: client.userAgent ? reading.browser : null,
        handheld: client.userAgent ? isHandheld(reading.os) : null,
        network,
        now: new Date(),
        groups
    };
}

export interface AccountAccessDecision {
    /** `allow`, `challenge` or `block`. */
    readonly action: AccountRuleVerdict["action"];
    /** Whose rule decided: an administrator's limit, the account's own, or none. */
    readonly source: "enforced" | "own" | null;
    /** The name of the account's rule that decided, for the audit record. */
    readonly ruleName: string | null;
    /** The resolved country, when a lookup happened. Stored alongside sessions. */
    readonly country: string | null;
}

/**
 * Judge a sign-in or a session's request against everything that governs the
 * account. The administrator's limits refuse outright; the account's own rules
 * then decide, first match wins.
 */
export async function evaluateAccountRequest(
    userId: string,
    ip: string | null,
    client: RequestClient,
    rules?: readonly AccountRule[]
): Promise<AccountAccessDecision> {
    const enforced = await evaluateNetworkRules(await resolveEnforcedRules(userId), ip ?? undefined);
    if (!enforced.allowed) return { action: "block", source: "enforced", ruleName: null, country: enforced.country };
    const own = rules ?? (await listAccountRules(userId));
    if (own.length === 0) return { action: "allow", source: null, ruleName: null, country: enforced.country };
    const facts = await resolveAccountRuleFacts(userId, own, ip, client, enforced.country ?? undefined);
    const verdict = evaluateAccountRules(own, facts);
    return {
        action: verdict.action,
        source: verdict.rule ? "own" : null,
        ruleName: verdict.rule?.name ?? null,
        country: facts.country ?? enforced.country
    };
}

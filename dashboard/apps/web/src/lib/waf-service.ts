/**
 * WAF rule resolution and persistence. Rules live at four scopes for a deployed
 * service (global, project, environment, application) and are merged least-privilege:
 * allowlists AND (each scope can only narrow, never widen), denylists union,
 * requireLogin ORs, the principals a login admits AND like the allowlists while the
 * ones it refuses union like the denylists, and custom rules concatenate
 * broadest-scope-first so a global rule is tried before a project's.
 * The merged result is materialized into each
 * server's edge (Traefik) by the router generators, so the controls keep enforcing
 * when the Polaris control plane is down. Every read/write is ownership-checked.
 *
 * The fifth scope, `polaris`, is the dashboard's own ingress. It stands apart: it is
 * not part of any project, takes no part in a service's merge, and is materialized
 * into the dashboard's own edge route rather than an app's.
 */

import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    instanceDefaultWafPresets,
    polarisDefaultWafPresets,
    WAF_SCOPE_ORDER,
    wafCustomRuleSchema,
    wafRuleInputSchema,
    wafPrincipalGrantSchema,
    type ResolvedWaf,
    type WafCustomRule,
    type WafPrincipalGrant,
    type WafRuleInput,
    type WafScopeType
} from "@polaris/core";

/**
 * The two instance-wide scopes start protected rather than open: a fresh Polaris
 * blocks vulnerability scanners, exposed dotfiles and CMS probing before anyone
 * visits the firewall page. Only these two, because they are the only scopes that
 * exist before an operator creates anything.
 *
 * The choice is recorded, never inferred. Once one of these rows exists its packs are
 * authoritative - including an empty list, which is how "I turned them all off" is
 * stored - so the row is kept even when it is otherwise empty. Inferring the default
 * from an absent row would quietly re-enable every pack the operator had just
 * switched off.
 */
const SCOPES_WITH_DEFAULTS = new Set<WafScopeType>(["global", "polaris"]);

/**
 * What an unwritten scope enforces.
 *
 * The two differ, and deliberately. `global` covers whatever anyone deploys, so it can
 * only turn on what is safe for a stack nobody has described yet. `polaris` covers one
 * known application - this one - so there is nothing left to be careful about and it
 * arms everything.
 */
function defaultPresets(scopeType: WafScopeType): string[] {
    if (scopeType === "polaris") return polarisDefaultWafPresets();
    if (scopeType === "global") return instanceDefaultWafPresets();
    return [];
}

/** Parse a stored JSON string list, tolerating a malformed value as empty. */
function parseList(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

/** Principal grants as stored, validated on read for the same reason the custom rules
 *  below are: one entry that no longer parses must not take the rest of the list -
 *  and with it the narrowing the operator wrote - down with it. */
function parseGrants(json: string): WafPrincipalGrant[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry) => {
            const grant = wafPrincipalGrantSchema.safeParse(entry);
            return grant.success ? [grant.data] : [];
        });
    } catch {
        return [];
    }
}

/**
 * Custom rules as stored. Validated on read rather than cast: they were written by a
 * validated action, but a rule that survived a schema change is a rule the edge would
 * run against every request, and one bad entry must not take the rest with it.
 */
function parseCustomRules(json: string): WafCustomRule[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry) => {
            const rule = wafCustomRuleSchema.safeParse(entry);
            return rule.success ? [rule.data] : [];
        });
    } catch {
        return [];
    }
}

interface RuleRow {
    readonly scopeType: string;
    readonly ipAllowlist: string;
    readonly ipDenylist: string;
    readonly requireLogin: boolean;
    readonly loginAllowPrincipals: string;
    readonly loginDenyPrincipals: string;
    readonly browserIntegrity: boolean;
    readonly sqlInjectionProtection: boolean;
    readonly xssProtection: boolean;
    readonly emailObfuscation: boolean;
    readonly presets: string;
    readonly rules: string;
}

/** The columns every resolver reads, named once so the three queries cannot drift. */
const RULE_SELECT = {
    scopeType: true,
    ipAllowlist: true,
    ipDenylist: true,
    requireLogin: true,
    loginAllowPrincipals: true,
    loginDenyPrincipals: true,
    browserIntegrity: true,
    sqlInjectionProtection: true,
    xssProtection: true,
    emailObfuscation: true,
    presets: true,
    rules: true
} as const;

/** Merge scope rows into the effective decision (order-independent). */
function mergeRules(rows: readonly RuleRow[]): ResolvedWaf {
    const rank = (scopeType: string): number => WAF_SCOPE_ORDER[scopeType as WafScopeType] ?? 99;
    const ordered = [...rows].sort((a, b) => rank(a.scopeType) - rank(b.scopeType));
    const allowLists: string[][] = [];
    const loginAllowLists: WafPrincipalGrant[][] = [];
    const loginDeny: WafPrincipalGrant[] = [];
    const deny = new Set<string>();
    const presets = new Set<string>();
    const rules: WafCustomRule[] = [];
    let requireLogin = false;
    let browserIntegrity = false;
    // The three that start true and are intersected, so any scope can clear one for what
    // it covers. All are on before anyone configures anything, and that is exactly why
    // they cannot union: a default that unions is a default no scope can escape.
    let sqlInjectionProtection = true;
    let xssProtection = true;
    let emailObfuscation = true;
    for (const row of ordered) {
        const allow = parseList(row.ipAllowlist);
        if (allow.length > 0) allowLists.push(allow);
        // Collected the same way, and an empty one is dropped for the same reason: a
        // scope that named nobody has not narrowed anything, so it must not turn into a
        // list that admits nobody.
        const admitted = parseGrants(row.loginAllowPrincipals);
        if (admitted.length > 0) loginAllowLists.push(admitted);
        // Refusals flatten instead, like the address denylist right below: a refusal
        // applies wherever it was written, so which scope wrote it changes nothing.
        loginDeny.push(...parseGrants(row.loginDenyPrincipals));
        for (const entry of parseList(row.ipDenylist)) deny.add(entry);
        // A pack union, not a per-scope list: a pack enabled anywhere above applies
        // here too, and a child scope cannot switch off a parent's. Turning one off
        // where it is wrong is done with an `allow` rule above it, which is the same
        // exception mechanism every other block uses.
        for (const id of parseList(row.presets)) presets.add(id);
        if (row.requireLogin) requireLogin = true;
        if (row.browserIntegrity) browserIntegrity = true;
        if (!row.sqlInjectionProtection) sqlInjectionProtection = false;
        if (!row.xssProtection) xssProtection = false;
        if (!row.emailObfuscation) emailObfuscation = false;
        // Concatenated, not merged: a rule set is ordered and first-match-wins, so a
        // broader scope's rules have to be offered the request first - otherwise a
        // project could write an `allow` that overrides an instance-wide block.
        rules.push(...parseCustomRules(row.rules));
    }
    return {
        allowLists,
        deny: [...deny],
        requireLogin,
        loginAllowLists,
        loginDeny,
        browserIntegrity,
        sqlInjectionProtection,
        xssProtection,
        emailObfuscation,
        presets: [...presets],
        rules
    };
}

/**
 * An empty decision: allow all, deny none, no login required, no packs, no rules.
 *
 * The injection checks and `emailObfuscation` are true here for the same reason they
 * are true in the schema - it is the state of an instance nobody has configured, and
 * that state is "on".
 */
const EMPTY_WAF: ResolvedWaf = {
    allowLists: [],
    deny: [],
    requireLogin: false,
    loginAllowLists: [],
    loginDeny: [],
    browserIntegrity: false,
    sqlInjectionProtection: true,
    xssProtection: true,
    emailObfuscation: true,
    presets: [],
    rules: []
};

/** The global row a never-configured instance behaves as if it had. */
const DEFAULT_GLOBAL_ROW: RuleRow = {
    scopeType: "global",
    ipAllowlist: "[]",
    ipDenylist: "[]",
    requireLogin: false,
    loginAllowPrincipals: "[]",
    loginDenyPrincipals: "[]",
    browserIntegrity: false,
    sqlInjectionProtection: true,
    xssProtection: true,
    emailObfuscation: true,
    presets: JSON.stringify(defaultPresets("global")),
    rules: "[]"
};

/** The dashboard's own row, likewise, when its scope has never been written. */
const DEFAULT_POLARIS_ROW: RuleRow = {
    ...DEFAULT_GLOBAL_ROW,
    scopeType: "polaris",
    presets: JSON.stringify(defaultPresets("polaris"))
};

/** The rows to merge, standing in the instance defaults when the global scope has
 *  never been written. An existing row always wins, empty packs included. */
function withInstanceDefaults(rows: readonly RuleRow[]): RuleRow[] {
    return rows.some((row) => row.scopeType === "global") ? [...rows] : [DEFAULT_GLOBAL_ROW, ...rows];
}

/**
 * Resolve the effective WAF decision for one application by merging its own rule
 * with its environment, project, and the global rule. Returns the empty decision
 * when nothing is configured (the common case, so it stays cheap).
 */
export async function resolveWaf(applicationId: string): Promise<ResolvedWaf> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            environmentId: true,
            environment: { select: { projectId: true } },
            // The machine it runs on, and the groups that machine belongs to: a rule
            // written about a server has to reach whatever is deployed there.
            target: { select: { hostId: true } }
        }
    });
    if (!app) return EMPTY_WAF;
    const hostId = app.target?.hostId ?? null;
    const groupIds = hostId ? await groupsOfHosts([hostId]) : new Map<string, string[]>();
    const rows = await prisma.wafRule.findMany({
        where: {
            OR: [
                { scopeType: "global", scopeId: "" },
                { scopeType: "server-group", scopeId: { in: groupIds.get(hostId ?? "") ?? [] } },
                { scopeType: "server", scopeId: hostId ?? "" },
                { scopeType: "project", scopeId: app.environment.projectId },
                { scopeType: "environment", scopeId: app.environmentId },
                { scopeType: "application", scopeId: applicationId }
            ]
        },
        select: RULE_SELECT
    });
    return mergeRules(withInstanceDefaults(rows));
}

/** Group ids per host, for the hosts given. One query, so resolving a hundred routes
 *  does not become a hundred membership lookups. */
async function groupsOfHosts(hostIds: readonly string[]): Promise<Map<string, string[]>> {
    const byHost = new Map<string, string[]>();
    const ids = hostIds.filter((id) => id !== "");
    if (ids.length === 0) return byHost;
    const rows = await prisma.hostGroupMember.findMany({
        where: { hostId: { in: [...new Set(ids)] } },
        select: { hostId: true, groupId: true }
    });
    for (const row of rows) {
        const list = byHost.get(row.hostId);
        if (list) list.push(row.groupId);
        else byHost.set(row.hostId, [row.groupId]);
    }
    return byHost;
}

/**
 * The dashboard's own decision, which no deployed service takes part in. Read on the
 * edge-sync path rather than per request: it is materialized into the dashboard's
 * router, so it is consulted when the route is written, not when it is used.
 */
export async function resolvePolarisWaf(): Promise<ResolvedWaf> {
    const row = await prisma.wafRule.findUnique({
        where: { scopeType_scopeId: { scopeType: "polaris", scopeId: "" } },
        select: RULE_SELECT
    });
    // Defaults apply here too, and for the same reason - the dashboard is reachable
    // from the internet before anyone configures anything.
    return mergeRules([row ?? DEFAULT_POLARIS_ROW]);
}

/**
 * Resolve the effective WAF decision for many applications at once, in two queries
 * total (apps + rules) rather than the per-app pair resolveWaf runs. Callers that
 * materialize every route (syncAppRoutes) use this to avoid a serial 2N round-trip
 * on instances with many domains. Every id in the input maps to a decision - an
 * unknown id gets the empty decision, so lookups never miss.
 */
export async function resolveWafBatch(applicationIds: readonly string[]): Promise<Map<string, ResolvedWaf>> {
    const ids = [...new Set(applicationIds)];
    const result = new Map<string, ResolvedWaf>(ids.map((id): [string, ResolvedWaf] => [id, EMPTY_WAF]));
    if (ids.length === 0) return result;
    const apps = await prisma.application.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            environmentId: true,
            environment: { select: { projectId: true } },
            target: { select: { hostId: true } }
        }
    });
    const projectIds = new Set<string>();
    const environmentIds = new Set<string>();
    const hostIds = new Set<string>();
    for (const app of apps) {
        environmentIds.add(app.environmentId);
        projectIds.add(app.environment.projectId);
        if (app.target?.hostId) hostIds.add(app.target.hostId);
    }
    const groupsByHost = await groupsOfHosts([...hostIds]);
    const allGroupIds = new Set<string>();
    for (const groups of groupsByHost.values()) for (const id of groups) allGroupIds.add(id);
    const rows = await prisma.wafRule.findMany({
        where: {
            OR: [
                { scopeType: "global", scopeId: "" },
                { scopeType: "server-group", scopeId: { in: [...allGroupIds] } },
                { scopeType: "server", scopeId: { in: [...hostIds] } },
                { scopeType: "project", scopeId: { in: [...projectIds] } },
                { scopeType: "environment", scopeId: { in: [...environmentIds] } },
                { scopeType: "application", scopeId: { in: ids } }
            ]
        },
        select: { ...RULE_SELECT, scopeId: true }
    });
    const globalRows = rows.filter((row) => row.scopeType === "global");
    const byScope = new Map<string, RuleRow[]>();
    for (const row of rows) {
        if (row.scopeType === "global") continue;
        const key = `${row.scopeType}:${row.scopeId}`;
        const list = byScope.get(key);
        if (list) list.push(row);
        else byScope.set(key, [row]);
    }
    for (const app of apps) {
        const hostId = app.target?.hostId ?? null;
        const applicable = [
            ...globalRows,
            ...(hostId ? (groupsByHost.get(hostId) ?? []).flatMap((id) => byScope.get(`server-group:${id}`) ?? []) : []),
            ...(hostId ? (byScope.get(`server:${hostId}`) ?? []) : []),
            ...(byScope.get(`project:${app.environment.projectId}`) ?? []),
            ...(byScope.get(`environment:${app.environmentId}`) ?? []),
            ...(byScope.get(`application:${app.id}`) ?? [])
        ];
        result.set(app.id, mergeRules(withInstanceDefaults(applicable)));
    }
    return result;
}

/** The stored WAF rule for one scope, as the editor consumes it. */
export interface WafRuleView {
    readonly ipAllowlist: string[];
    readonly ipDenylist: string[];
    readonly requireLogin: boolean;
    /** Who this scope alone admits and refuses - not what it inherits. */
    readonly loginAllowPrincipals: WafPrincipalGrant[];
    readonly loginDenyPrincipals: WafPrincipalGrant[];
    readonly browserIntegrity: boolean;
    readonly sqlInjectionProtection: boolean;
    readonly xssProtection: boolean;
    readonly emailObfuscation: boolean;
    /** Managed rule packs enabled on this scope alone - not the union it inherits. */
    readonly presets: string[];
    readonly rules: WafCustomRule[];
}

/**
 * Verify the caller owns the scope, so a rule is only readable/writable by the
 * owner of the underlying project/service. The global and polaris scopes carry no
 * owner - they are instance-wide operator controls the server action gates on
 * `system.manage` (not the member-held `deploy.manage`) - so ownership always passes
 * here for them.
 */
async function assertScopeOwner(ownerId: string, scopeType: WafScopeType, scopeId: string): Promise<void> {
    if (scopeType === "global" || scopeType === "polaris") return;
    if (scopeType === "project") {
        if ((await prisma.project.count({ where: { id: scopeId, ownerId } })) === 0) {
            throw new Error("Project not found");
        }
        return;
    }
    if (scopeType === "environment") {
        if ((await prisma.environment.count({ where: { id: scopeId, project: { ownerId } } })) === 0) {
            throw new Error("Environment not found");
        }
        return;
    }
    if (scopeType === "server") {
        if ((await prisma.host.count({ where: { id: scopeId, ownerId } })) === 0) {
            throw new Error("Server not found");
        }
        return;
    }
    if (scopeType === "server-group") {
        if ((await prisma.hostGroup.count({ where: { id: scopeId, ownerId } })) === 0) {
            throw new Error("Server group not found");
        }
        return;
    }
    if ((await prisma.application.count({ where: { id: scopeId, environment: { project: { ownerId } } } })) === 0) {
        throw new Error("Service not found");
    }
}

/** Read the WAF rule for one scope (empty view when none exists yet). */
export async function getWafRule(
    ownerId: string,
    scopeType: WafScopeType,
    scopeId: string
): Promise<WafRuleView> {
    await assertScopeOwner(ownerId, scopeType, scopeId);
    const row = await prisma.wafRule.findUnique({
        where: { scopeType_scopeId: { scopeType, scopeId } },
        select: {
            ipAllowlist: true,
            ipDenylist: true,
            requireLogin: true,
            loginAllowPrincipals: true,
            loginDenyPrincipals: true,
            browserIntegrity: true,
            sqlInjectionProtection: true,
            xssProtection: true,
            emailObfuscation: true,
            presets: true,
            rules: true
        }
    });
    if (!row) {
        // An unwritten instance scope must show the packs it is actually enforcing,
        // or the page would offer to "enable" protection that is already on and the
        // first save would look like it changed nothing. The same applies to the two
        // injection checks and email obfuscation, on before anyone has been here.
        return {
            ipAllowlist: [],
            ipDenylist: [],
            requireLogin: false,
            loginAllowPrincipals: [],
            loginDenyPrincipals: [],
            browserIntegrity: false,
            sqlInjectionProtection: true,
            xssProtection: true,
            emailObfuscation: true,
            presets: defaultPresets(scopeType),
            rules: []
        };
    }
    return {
        ipAllowlist: parseList(row.ipAllowlist),
        ipDenylist: parseList(row.ipDenylist),
        requireLogin: row.requireLogin,
        loginAllowPrincipals: parseGrants(row.loginAllowPrincipals),
        loginDenyPrincipals: parseGrants(row.loginDenyPrincipals),
        browserIntegrity: row.browserIntegrity,
        sqlInjectionProtection: row.sqlInjectionProtection,
        xssProtection: row.xssProtection,
        emailObfuscation: row.emailObfuscation,
        presets: parseList(row.presets),
        rules: parseCustomRules(row.rules)
    };
}

/**
 * What a scope is already enforcing because something above it says so.
 *
 * The editor writes one scope's own row, so without this every managed rule on a
 * project reads "Off" while the instance-wide default is refusing scanners on its
 * behalf - a switch that says the opposite of what is happening, which is the one thing
 * a firewall screen must never do.
 *
 * The two directions are not symmetric, because the rules are not: a pack or the
 * integrity check unions downward (true here means armed above and unstoppable from
 * here), while the injection checks and obfuscation intersect (false here means a
 * broader scope switched it off and this one cannot switch it back on).
 */
export interface WafInheritedView {
    readonly presets: string[];
    readonly browserIntegrity: boolean;
    readonly requireLogin: boolean;
    readonly sqlInjectionProtection: boolean;
    readonly xssProtection: boolean;
    readonly emailObfuscation: boolean;
}

/** Nothing above it: the two instance-wide scopes, and any scope whose parents are
 *  all unwritten. */
const NOTHING_INHERITED: WafInheritedView = {
    presets: [],
    browserIntegrity: false,
    requireLogin: false,
    sqlInjectionProtection: true,
    xssProtection: true,
    emailObfuscation: true
};

/**
 * The scopes strictly above this one, resolved into a single view.
 *
 * `polaris` and `global` inherit nothing - one is the dashboard's own ingress and takes
 * no part in a service's merge, the other is the top of that merge. Everything else
 * gets the global row (real or defaulted) plus whichever of its parents exist.
 */
export async function getWafInherited(
    ownerId: string,
    scopeType: WafScopeType,
    scopeId: string
): Promise<WafInheritedView> {
    await assertScopeOwner(ownerId, scopeType, scopeId);
    if (scopeType === "polaris" || scopeType === "global") return NOTHING_INHERITED;

    // Which parents to look for. An application is the only scope with more than one,
    // and the machine it runs on is reached through its target rather than its project.
    const filters: { scopeType: WafScopeType; scopeId: string }[] = [];
    if (scopeType === "server" || scopeType === "application") {
        const hostId =
            scopeType === "server"
                ? scopeId
                : ((
                      await prisma.application.findUnique({
                          where: { id: scopeId },
                          select: { target: { select: { hostId: true } } }
                      })
                  )?.target?.hostId ?? null);
        if (hostId) {
            if (scopeType === "application") filters.push({ scopeType: "server", scopeId: hostId });
            for (const groupId of (await groupsOfHosts([hostId])).get(hostId) ?? []) {
                filters.push({ scopeType: "server-group", scopeId: groupId });
            }
        }
    }
    if (scopeType === "environment") {
        const environment = await prisma.environment.findUnique({
            where: { id: scopeId },
            select: { projectId: true }
        });
        if (environment) filters.push({ scopeType: "project", scopeId: environment.projectId });
    }
    if (scopeType === "application") {
        const app = await prisma.application.findUnique({
            where: { id: scopeId },
            select: { environmentId: true, environment: { select: { projectId: true } } }
        });
        if (app) {
            filters.push({ scopeType: "project", scopeId: app.environment.projectId });
            filters.push({ scopeType: "environment", scopeId: app.environmentId });
        }
    }

    const rows = await prisma.wafRule.findMany({
        where: { OR: [{ scopeType: "global", scopeId: "" }, ...filters] },
        select: RULE_SELECT
    });
    const merged = mergeRules(withInstanceDefaults(rows));
    return {
        presets: [...merged.presets],
        browserIntegrity: merged.browserIntegrity,
        requireLogin: merged.requireLogin,
        sqlInjectionProtection: merged.sqlInjectionProtection,
        xssProtection: merged.xssProtection,
        emailObfuscation: merged.emailObfuscation
    };
}

/** Set once the dashboard's scope has been brought up to the full pack list, so it is
 *  brought up exactly once and an operator who then switches something off keeps it
 *  switched off. */
const POLARIS_ARMED_KEY = "waf.polaris.armed";

/**
 * Bring the dashboard's own scope up to the packs it now defaults to, once.
 *
 * A saved row is authoritative, which is right for a scope an operator has an opinion
 * about and wrong for this one: an instance configured before the crawler packs were
 * part of the Polaris default has them off because they were off everywhere, not
 * because anyone decided the dashboard should be indexed. So the two lists are unioned
 * a single time and the fact is recorded - after that the row wins again, and turning
 * one back off sticks.
 *
 * Returns whether anything changed, so the caller can republish the route rather than
 * republishing on every boot.
 */
export async function armPolarisPresets(): Promise<boolean> {
    if (await getSetting(POLARIS_ARMED_KEY)) return false;
    const row = await prisma.wafRule.findUnique({
        where: { scopeType_scopeId: { scopeType: "polaris", scopeId: "" } },
        select: { presets: true }
    });
    // No row means the defaults are already what is being enforced - nothing to raise.
    if (!row) {
        await setSetting(POLARIS_ARMED_KEY, new Date().toISOString());
        return false;
    }
    const merged = [...new Set([...parseList(row.presets), ...defaultPresets("polaris")])];
    const changed = merged.length !== parseList(row.presets).length;
    if (changed) {
        await prisma.wafRule.update({
            where: { scopeType_scopeId: { scopeType: "polaris", scopeId: "" } },
            data: { presets: JSON.stringify(merged) }
        });
    }
    await setSetting(POLARIS_ARMED_KEY, new Date().toISOString());
    return changed;
}

/**
 * Save the WAF rule for one scope. An all-empty rule is stored as absence (the row
 * is deleted) so an unconfigured scope leaves no noise and resolveWaf stays cheap.
 * Validated against the shared schema server-side regardless of the client.
 */
export async function setWafRule(
    ownerId: string,
    scopeType: WafScopeType,
    scopeId: string,
    input: WafRuleInput
): Promise<void> {
    await assertScopeOwner(ownerId, scopeType, scopeId);
    const parsed = wafRuleInputSchema.parse(input);
    // "Empty" is the state a never-configured scope is in, not merely a falsy one: the
    // injection checks and email obfuscation are ON when nothing has been saved, so a
    // scope that switches any of them OFF is carrying a decision and its row has to
    // survive.
    const empty =
        parsed.ipAllowlist.length === 0 &&
        parsed.ipDenylist.length === 0 &&
        parsed.rules.length === 0 &&
        parsed.presets.length === 0 &&
        parsed.loginAllowPrincipals.length === 0 &&
        parsed.loginDenyPrincipals.length === 0 &&
        !parsed.requireLogin &&
        !parsed.browserIntegrity &&
        parsed.sqlInjectionProtection &&
        parsed.xssProtection &&
        parsed.emailObfuscation;
    // An instance scope keeps its row even when empty: absence there means "never
    // configured" and re-applies the default packs, so deleting it would silently
    // undo an operator who had just switched every one of them off.
    if (empty && !SCOPES_WITH_DEFAULTS.has(scopeType)) {
        await prisma.wafRule.deleteMany({ where: { scopeType, scopeId } });
        return;
    }
    const data = {
        ipAllowlist: JSON.stringify(parsed.ipAllowlist),
        ipDenylist: JSON.stringify(parsed.ipDenylist),
        requireLogin: parsed.requireLogin,
        loginAllowPrincipals: JSON.stringify(parsed.loginAllowPrincipals),
        loginDenyPrincipals: JSON.stringify(parsed.loginDenyPrincipals),
        browserIntegrity: parsed.browserIntegrity,
        sqlInjectionProtection: parsed.sqlInjectionProtection,
        xssProtection: parsed.xssProtection,
        emailObfuscation: parsed.emailObfuscation,
        presets: JSON.stringify(parsed.presets),
        rules: JSON.stringify(parsed.rules)
    };
    await prisma.wafRule.upsert({
        where: { scopeType_scopeId: { scopeType, scopeId } },
        create: { scopeType, scopeId, ...data },
        update: data
    });
}

/**
 * Who may use Polar on this deployment, and who may spend its provider keys.
 *
 * Two questions, answered separately, because they are different decisions: an
 * operator may want everybody to have Polar on keys they bring themselves while
 * keeping the deployment's own billing to the administrators. Each is an
 * audience - only administrators, chosen people and groups, or everybody signed
 * in - and a guest (an account whose only role is `guest`, which exists to be
 * identified at a share link and reaches no app) is in none of them unless the
 * audience says so or names them.
 *
 * Both are also permissions (`polar.use`, `polar.spend`), managed like every
 * other app's: a role, a group's policy or one account's override under
 * Management > Users that names either one decides it, a deny over an allow.
 * The audiences here answer only when none of those says anything, which is
 * what keeps every install that predates the permissions where it was.
 *
 * Every Polar route asks `polarCaller`, and every place Polar picks a credential
 * asks `polarKeySources` / `polarCredentialFor`, so the screen and the server
 * read one answer. The policy lives in the settings table: a deployment that
 * has never saved one reads the defaults below, which is how an existing
 * install gets this without anything being written.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { resolveGlobalStatements } from "@polaris/auth";
import { evaluateStatements, type AuthzDecision, type PolicyStatement } from "@polaris/core";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import type { SessionUser } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/setting-store";
import { CONNECTOR_AUDIENCES, DEFAULT_CONNECTOR_POLICY } from "@/lib/polar/connectors/shared";
import {
    chatCredentialFor,
    instanceKeysAreShared,
    keySourcesFor,
    type ChatCredential,
    type KeySource
} from "@/lib/agents/model-keys";

const POLICY_KEY = "polar.access";

export const AUDIENCES = ["admins", "chosen", "everyone"] as const;
export type AudienceKind = (typeof AUDIENCES)[number];

const audienceSchema = z.object({
    who: z.enum(AUDIENCES),
    userIds: z.array(z.string().uuid()).max(500).default([]),
    groupIds: z.array(z.string().uuid()).max(200).default([]),
    guests: z.boolean().default(false)
});
export type PolarAudience = z.infer<typeof audienceSchema>;

/**
 * Who may connect their own MCP servers to Polar, and where to. Open to
 * everybody who uses Polar with no list by default, so an install that never
 * saved it has connectors without anybody setting them up. A private address
 * stays out of reach unless an administrator lets it in: a connector is a
 * request from inside the deployment's network to an address somebody typed.
 */
const connectorPolicySchema = z.object({
    who: z.enum(CONNECTOR_AUDIENCES).default("everyone"),
    /** Hosts a connector may be on; empty allows any public host. */
    hosts: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(100).default([]),
    /** Whether a connector may be on the deployment's own network. */
    privateNetwork: z.boolean().default(false)
});
export type PolarConnectorPolicy = z.infer<typeof connectorPolicySchema>;

export const polarPolicySchema = z.object({
    use: audienceSchema,
    spend: audienceSchema,
    /** Whether Polar may search and read the web. On unless an administrator
     *  turned it off, so a policy saved before this existed keeps it on. */
    web: z.boolean().default(true),
    connectors: connectorPolicySchema.default(DEFAULT_CONNECTOR_POLICY)
});
export type PolarPolicy = z.infer<typeof polarPolicySchema>;

/**
 * What a deployment that never saved a policy gets when its keys are not
 * shared, and what a stored policy that no longer reads falls back to.
 *
 * Using Polar stays open to everybody signed in, which is what every install
 * already did - minus guests, who reach no other app either. Spending the
 * deployment's keys is the administrators' alone: before this, every account
 * ran on the operator's billing without anybody having decided it, and the safe
 * reading of "nobody decided" is "nobody but the operator".
 */
export const DEFAULT_POLAR_POLICY: PolarPolicy = {
    use: { who: "everyone", userIds: [], groupIds: [], guests: false },
    spend: { who: "admins", userIds: [], groupIds: [], guests: false },
    web: true,
    connectors: DEFAULT_CONNECTOR_POLICY
};

/**
 * The policy of a deployment that never saved one, given whether its
 * administrator shares the deployment's keys. Sharing them is a decision
 * somebody already made about who spends them, so it carries over: everybody
 * signed in, as before, rather than taking the keys away on an update.
 */
export function unsavedPolarPolicy(keysShared: boolean): PolarPolicy {
    if (!keysShared) return DEFAULT_POLAR_POLICY;
    return { ...DEFAULT_POLAR_POLICY, spend: { ...DEFAULT_POLAR_POLICY.spend, who: "everyone" } };
}

export async function readPolarPolicy(): Promise<PolarPolicy> {
    const raw = await getSetting(POLICY_KEY);
    if (!raw) return unsavedPolarPolicy(await instanceKeysAreShared());
    try {
        const parsed = polarPolicySchema.safeParse(JSON.parse(raw));
        // A row that no longer reads is not a reason to open anything up.
        return parsed.success ? parsed.data : DEFAULT_POLAR_POLICY;
    } catch {
        return DEFAULT_POLAR_POLICY;
    }
}

export async function savePolarPolicy(policy: PolarPolicy): Promise<void> {
    await setSetting(POLICY_KEY, JSON.stringify(polarPolicySchema.parse(policy)));
}

/** What the policy needs to know about one account. */
export interface AccessFacts {
    userId: string;
    isAdmin: boolean;
    guest: boolean;
    groupIds: readonly string[];
    /** What this account's roles, group policies and own overrides say about
     *  `polar.use` and `polar.spend`; absent is the same as nothing said. */
    grants?: PolarGrants;
}

/** The permission system's word on each, before the audiences are asked. */
export interface PolarGrants {
    use: AuthzDecision;
    spend: AuthzDecision;
}

/** Read the two decisions out of one account's global statements. Pure. */
export function polarGrantsOf(statements: readonly PolicyStatement[]): PolarGrants {
    return {
        use: evaluateStatements(statements, "polar.use", "*"),
        spend: evaluateStatements(statements, "polar.spend", "*")
    };
}

/**
 * Whether an account is in, with the permission system asked first: an explicit
 * deny keeps it out and an explicit allow lets it in, whatever the audience
 * says. An administrator is in regardless, as everywhere else in Polaris.
 */
function admitted(
    decision: AuthzDecision | undefined,
    audience: PolarAudience,
    facts: AccessFacts
): boolean {
    if (facts.isAdmin) return true;
    if (decision === "deny") return false;
    if (decision === "allow") return true;
    return audienceAdmits(audience, facts);
}

/** Whether one audience takes one account. Pure, so it can be asserted. */
export function audienceAdmits(audience: PolarAudience, facts: AccessFacts): boolean {
    if (facts.isAdmin) return true;
    if (audience.who === "admins") return false;
    // Naming somebody is the explicit decision a guest needs.
    if (audience.userIds.includes(facts.userId)) return true;
    if (facts.guest && !audience.guests) return false;
    if (audience.who === "everyone") return true;
    return facts.groupIds.some((id) => audience.groupIds.includes(id));
}

export interface PolarAccess {
    use: boolean;
    spend: boolean;
    /** Whether this account's turns may search and read the web. */
    web: boolean;
    /** Whether this account may connect and use its own MCP servers. */
    connectors: boolean;
}

/** One account's answer to both questions. Pure. */
export function decidePolarAccess(policy: PolarPolicy, facts: AccessFacts): PolarAccess {
    const use = admitted(facts.grants?.use, policy.use, facts);
    const connectors = policy.connectors ?? DEFAULT_CONNECTOR_POLICY;
    return {
        use,
        spend: use && admitted(facts.grants?.spend, policy.spend, facts),
        web: use && policy.web,
        connectors:
            use && (connectors.who === "everyone" || (connectors.who === "admins" && facts.isAdmin))
    };
}

const FACTS_SELECT = {
    id: true,
    isAdmin: true,
    roles: { select: { role: { select: { name: true } } } },
    groups: { select: { groupId: true } }
} as const;

function factsOf(row: {
    id: string;
    isAdmin: boolean;
    roles: { role: { name: string } }[];
    groups: { groupId: string }[];
}): AccessFacts {
    const roles = row.roles.map((entry) => entry.role.name);
    return {
        userId: row.id,
        isAdmin: row.isAdmin,
        // No role but guest - or none at all - reaches no app, so it is a guest here.
        guest: !row.isAdmin && roles.every((name) => name === "guest"),
        groupIds: row.groups.map((entry) => entry.groupId)
    };
}

async function factsFor(userId: string): Promise<AccessFacts> {
    const [row, statements] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: FACTS_SELECT }),
        resolveGlobalStatements(userId)
    ]);
    if (!row) return { userId, isAdmin: false, guest: true, groupIds: [] };
    return { ...factsOf(row), grants: polarGrantsOf(statements) };
}

/** This account's Polar access. A store that cannot be read answers no. */
export async function polarAccessFor(userId: string): Promise<PolarAccess> {
    try {
        const [policy, facts] = await Promise.all([readPolarPolicy(), factsFor(userId)]);
        return decidePolarAccess(policy, facts);
    } catch (error) {
        console.error("polar: could not read the access policy", error);
        return { use: false, spend: false, web: false, connectors: false };
    }
}

/**
 * What an account would have with `statements` in place of its own: the
 * capabilities screen asks it with the account's overrides taken out, which is
 * what "follow their role" leaves them with - the deployment's Polar access
 * included, and not only what a role grants.
 */
export async function polarAccessWith(
    userId: string,
    statements: readonly PolicyStatement[]
): Promise<PolarAccess> {
    const [policy, row] = await Promise.all([
        readPolarPolicy(),
        prisma.user.findUnique({ where: { id: userId }, select: FACTS_SELECT })
    ]);
    const facts = row
        ? factsOf(row)
        : { userId, isAdmin: false, guest: true, groupIds: [] as string[] };
    return decidePolarAccess(policy, { ...facts, grants: polarGrantsOf(statements) });
}

/**
 * The accounts among `userIds` that may use Polar, read with one policy and one
 * query. A store that cannot be read answers nobody.
 */
export async function polarUsersAmong(userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    try {
        const [policy, rows] = await Promise.all([
            readPolarPolicy(),
            prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: FACTS_SELECT })
        ]);
        // One resolution per account found, all at once: the list is a page of
        // people-search results, never the directory.
        const grants = await Promise.all(
            rows.map(async (row) => polarGrantsOf(await resolveGlobalStatements(row.id)))
        );
        return new Set(
            rows
                .filter(
                    (row, index) =>
                        decidePolarAccess(policy, { ...factsOf(row), grants: grants[index] }).use
                )
                .map((row) => row.id)
        );
    } catch (error) {
        console.error("polar: could not read the access policy", error);
        return new Set();
    }
}

/**
 * The caller of a Polar route, or the response to send instead. The one check
 * every route under `/api/polar` makes, so none of them can let somebody in
 * that the launcher hid from.
 */
export async function polarCaller(): Promise<SessionUser | NextResponse> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (!(await polarAccessFor(user.id)).use)
        return NextResponse.json({ error: "polar_not_allowed" }, { status: 403 });
    return user;
}

/** The providers Polar may use for this person, with the deployment's keys left
 *  out unless the policy lets them spend those. */
export async function polarKeySources(
    userId: string,
    access?: PolarAccess
): Promise<Map<string, KeySource>> {
    const [sources, granted] = await Promise.all([
        keySourcesFor(userId),
        access ?? polarAccessFor(userId)
    ]);
    if (granted.spend) return sources;
    return new Map([...sources].filter(([, source]) => source === "own"));
}

/** The credential a Polar call spends, held to the same rule. */
export async function polarCredentialFor(
    userId: string,
    provider: string,
    payer: KeySource | null = null,
    access?: PolarAccess
): Promise<ChatCredential | null> {
    if ((access ?? (await polarAccessFor(userId))).spend)
        return chatCredentialFor(userId, provider, payer);
    if (payer === "instance") return null;
    return chatCredentialFor(userId, provider, "own");
}

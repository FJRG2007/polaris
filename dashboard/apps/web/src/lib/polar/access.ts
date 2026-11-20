/**
 * Who may use Polar on this deployment, and who may spend its provider keys.
 *
 * Two questions, answered separately, because they are different decisions: an
 * operator may want everybody to have Polar on keys they bring themselves while
 * keeping the deployment's own billing to the administrators. Both are
 * permissions (`polar.use`, `polar.spend`), decided like every other app's: by
 * roles, group policies and one account's override under Management > Users, a
 * deny over an allow. An administrator always may. Nothing else decides - the
 * audiences an earlier release kept for Polar were carried into roles and
 * overrides once (`access-carry.ts`) and are no longer read.
 *
 * Every Polar route asks `polarCaller`, and every place Polar picks a credential
 * asks `polarKeySources` / `polarCredentialFor`, so the screen and the server
 * read one answer. The rest of Polar's options (the web, connectors, the free
 * models) live in the settings table: a deployment that has never saved them
 * reads the defaults below.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import type { SessionUser } from "@/lib/session";
import { zenCredential } from "@/lib/polar/zen-free";
import { resolveGlobalStatements } from "@polaris/auth";
import { getSetting, setSetting } from "@/lib/setting-store";
import { ensurePolarAccessCarried } from "@/lib/polar/access-carry";
import { ZEN_FREE_SLUG, isSubscriptionToken } from "@/lib/polar/shared";
import { evaluateStatements, type AuthzDecision, type PolicyStatement } from "@polaris/core";
import { CONNECTOR_AUDIENCES, DEFAULT_CONNECTOR_POLICY } from "@/lib/polar/connectors/shared";
import {
    chatCredentialFor,
    chatCredentialsFor,
    keySourcesFor,
    type ChatCredential,
    type KeySource
} from "@/lib/agents/model-keys";

/** The stored row. It may still hold the audiences an earlier release saved
 *  under `use` and `spend`; they are kept as they are and never read here. */
export const POLAR_POLICY_KEY = "polar.access";

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

/** Polar's options, edited in Polar's own settings. */
export const polarPolicySchema = z.object({
    /** Whether Polar may search and read the web. On unless an administrator
     *  turned it off, so a policy saved before this existed keeps it on. */
    web: z.boolean().default(true),
    connectors: connectorPolicySchema.default(DEFAULT_CONNECTOR_POLICY),
    /** Whether an account with no usable key gets OpenCode Zen's free models
     *  (`zen-free.ts`). On unless an administrator turned it off, so a policy
     *  saved before this existed keeps it on. */
    freeModels: z.boolean().default(true),
    /** Whether a plan ends on a free model for everybody, a person with keys of
     *  their own included (`zen-stand-in.ts`). Off unless an administrator
     *  turned it on, so a policy saved before this existed keeps the free
     *  stand-in to the people with no key. */
    zenStandInEveryone: z.boolean().default(false)
});
export type PolarPolicy = z.infer<typeof polarPolicySchema>;

/** What a deployment that never saved the options reads, and what a stored row
 *  that no longer reads falls back to. */
export const DEFAULT_POLAR_POLICY: PolarPolicy = {
    web: true,
    connectors: DEFAULT_CONNECTOR_POLICY,
    freeModels: true,
    zenStandInEveryone: false
};

/** The stored row as an object, whatever else it holds; null when absent or
 *  unreadable. */
async function storedRow(): Promise<Record<string, unknown> | null> {
    const raw = await getSetting(POLAR_POLICY_KEY);
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export async function readPolarPolicy(): Promise<PolarPolicy> {
    const row = await storedRow();
    if (!row) return DEFAULT_POLAR_POLICY;
    const parsed = polarPolicySchema.safeParse(row);
    // A row that no longer reads is not a reason to open anything up.
    return parsed.success ? parsed.data : DEFAULT_POLAR_POLICY;
}

/**
 * Store the options over the row as it is. Whatever else the row holds - the
 * audiences an earlier release saved - is written back untouched, so the
 * change that stopped reading them stays reversible.
 */
export async function savePolarPolicy(policy: PolarPolicy): Promise<PolarPolicy> {
    const next = polarPolicySchema.parse(policy);
    await setSetting(POLAR_POLICY_KEY, JSON.stringify({ ...(await storedRow()), ...next }));
    return next;
}

/** What the decision needs to know about one account. */
export interface AccessFacts {
    isAdmin: boolean;
    /** What this account's roles, group policies and own overrides say about
     *  `polar.use` and `polar.spend`; absent is the same as nothing said. */
    grants?: PolarGrants;
}

/** The permission system's word on each. */
export interface PolarGrants {
    use: AuthzDecision;
    spend: AuthzDecision;
}

/**
 * Read the two decisions out of one account's global statements. Pure.
 *
 * Any matching deny counts, `*` included. An allow counts only from a statement
 * that names Polar (`polar.use`, `polar.spend`, `polar.*`). The built-in roles
 * hold `polar.use` by name, so this costs nobody anything; what it keeps out is
 * a role or a policy allowing `*`, which never meant Polar - and above all never
 * meant spending the deployment's keys, billed to its administrator. The
 * administrators' own role holds `*`, and they are allowed regardless.
 */
export function polarGrantsOf(statements: readonly PolicyStatement[]): PolarGrants {
    const naming = statements
        .filter((statement) => statement.effect === "allow")
        .map((statement) => ({
            ...statement,
            actions: statement.actions.filter((pattern) => pattern.startsWith("polar."))
        }));
    const decide = (action: string): AuthzDecision => {
        const decision = evaluateStatements(statements, action, "*");
        return decision === "allow" ? evaluateStatements(naming, action, "*") : decision;
    };
    return { use: decide("polar.use"), spend: decide("polar.spend") };
}

export interface PolarAccess {
    use: boolean;
    spend: boolean;
    /** Whether this account's turns may search and read the web. */
    web: boolean;
    /** Whether this account may connect and use its own MCP servers. */
    connectors: boolean;
    /** Whether this account's plans end on the free stand-in even when it
     *  holds keys of its own. */
    zenStandInEveryone: boolean;
}

/** One account's answer to both questions. Pure. */
export function decidePolarAccess(policy: PolarPolicy, facts: AccessFacts): PolarAccess {
    const use = facts.isAdmin || facts.grants?.use === "allow";
    // Spending needs Polar itself: a grant of the keys alone opens nothing.
    const spend = use && (facts.isAdmin || facts.grants?.spend === "allow");
    const connectors = policy.connectors ?? DEFAULT_CONNECTOR_POLICY;
    return {
        use,
        spend,
        web: use && policy.web,
        connectors:
            use && (connectors.who === "everyone" || (connectors.who === "admins" && facts.isAdmin)),
        zenStandInEveryone: use && policy.freeModels && policy.zenStandInEveryone
    };
}

const NOBODY: PolarAccess = {
    use: false,
    spend: false,
    web: false,
    connectors: false,
    zenStandInEveryone: false
};

/**
 * The carry of the old audiences into roles, before anything is decided: an
 * update must never answer from roles that do not hold Polar yet. Once per
 * process, and a failure is logged and tried again on the next call.
 */
async function carried(): Promise<void> {
    try {
        await ensurePolarAccessCarried();
    } catch (error) {
        console.error("polar: could not carry the old access into roles", error);
    }
}

async function isAdministrator(userId: string): Promise<boolean> {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    return row?.isAdmin === true;
}

/** This account's Polar access. A store that cannot be read answers no. */
export async function polarAccessFor(userId: string): Promise<PolarAccess> {
    try {
        await carried();
        const [policy, isAdmin, statements] = await Promise.all([
            readPolarPolicy(),
            isAdministrator(userId),
            resolveGlobalStatements(userId)
        ]);
        return decidePolarAccess(policy, { isAdmin, grants: polarGrantsOf(statements) });
    } catch (error) {
        console.error("polar: could not read the access policy", error);
        return NOBODY;
    }
}

/**
 * What an account would have with `statements` in place of its own: the
 * capabilities screen asks it with the account's overrides taken out, which is
 * what "follow their role" leaves them with.
 */
export async function polarAccessWith(
    userId: string,
    statements: readonly PolicyStatement[]
): Promise<PolarAccess> {
    await carried();
    const [policy, isAdmin] = await Promise.all([readPolarPolicy(), isAdministrator(userId)]);
    return decidePolarAccess(policy, { isAdmin, grants: polarGrantsOf(statements) });
}

/**
 * The accounts among `userIds` that may use Polar, read with one query. A store
 * that cannot be read answers nobody.
 */
export async function polarUsersAmong(userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    try {
        await carried();
        const [policy, rows] = await Promise.all([
            readPolarPolicy(),
            prisma.user.findMany({
                where: { id: { in: [...userIds] } },
                select: { id: true, isAdmin: true }
            })
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
                        decidePolarAccess(policy, { isAdmin: row.isAdmin, grants: grants[index] })
                            .use
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

/**
 * Whether this account may be offered OpenCode Zen's free models: it may use
 * Polar and no administrator switched the free tier off. A policy that cannot
 * be read answers no - nothing is sent to an outside service on a guess.
 */
export async function zenFreeAllowed(access: PolarAccess): Promise<boolean> {
    if (!access.use) return false;
    try {
        return (await readPolarPolicy()).freeModels;
    } catch (error) {
        console.error("polar: could not read the access policy", error);
        return false;
    }
}

/** The free tier's credential when it is allowed, for the two readers below.
 *  It is nobody's key, so a payer of "own" never reaches it. */
async function zenCredentials(
    userId: string,
    payer: KeySource | null,
    access?: PolarAccess
): Promise<ChatCredential[]> {
    if (payer === "own") return [];
    const granted = access ?? (await polarAccessFor(userId));
    return (await zenFreeAllowed(granted)) ? [zenCredential()] : [];
}

/** The credential a Polar call spends, held to the same rule. */
export async function polarCredentialFor(
    userId: string,
    provider: string,
    payer: KeySource | null = null,
    access?: PolarAccess
): Promise<ChatCredential | null> {
    if (provider === ZEN_FREE_SLUG) return (await zenCredentials(userId, payer, access))[0] ?? null;
    const spend = (access ?? (await polarAccessFor(userId))).spend;
    if (!spend && payer === "instance") return null;
    const credential = await chatCredentialFor(userId, provider, spend ? payer : "own");
    if (!credential || !isSubscriptionToken(credential)) return credential;
    // The first is a subscription token: the next that is a key, if any.
    const all = await chatCredentialsFor(userId, provider, spend ? payer : "own");
    return all.find((entry) => !isSubscriptionToken(entry)) ?? null;
}

/** Every credential a Polar call may spend for one provider, in the order the
 *  router tries them, held to the same rule. */
export async function polarCredentialsFor(
    userId: string,
    provider: string,
    payer: KeySource | null = null,
    access?: PolarAccess
): Promise<ChatCredential[]> {
    if (provider === ZEN_FREE_SLUG) return zenCredentials(userId, payer, access);
    const spend = (access ?? (await polarAccessFor(userId))).spend;
    if (!spend && payer === "instance") return [];
    const all = await chatCredentialsFor(userId, provider, spend ? payer : "own");
    return all.filter((entry) => !isSubscriptionToken(entry));
}

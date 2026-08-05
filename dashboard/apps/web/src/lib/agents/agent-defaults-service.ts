/**
 * What repositories inherit, and from where.
 *
 * Three tiers answer the same questions: the instance, one GitHub account or
 * organization, and one repository. A repository reads its own columns first,
 * then its owner login's row, then the instance row, and anything none of them
 * answers falls to the built-in defaults in @polaris/core. The resolution itself
 * is pure and lives there; this module is the reads and writes behind it.
 *
 * The two tiers above a repository share one table because they are the same
 * shape and differ only in how widely they apply - `scope` is the empty string
 * for the instance and a GitHub login for an account. One table means one write
 * path, and no chance of the two drifting apart.
 */

import { prisma } from "@polaris/db";
import {
    resolveAgentPolicy,
    type AgentDefaultsInput,
    type AgentExecution,
    type AgentPolicy,
    type AgentPolicyOverride,
    type AgentPushPolicy,
    type AgentShellPolicy
} from "@polaris/core";

/** The instance-wide tier. Not a login, so it can never collide with one. */
export const GENERAL_SCOPE = "";

/** One tier as the screens read and write it. Every field is nullable: null is
 *  "inherit", and the screen renders it as such. */
export interface AgentDefaultsView {
    scope: string;
    execution: AgentExecution | null;
    poolId: string | null;
    poolName: string | null;
    model: string | null;
    effort: string | null;
    push: AgentPushPolicy | null;
    shell: AgentShellPolicy | null;
    publicRepos: boolean | null;
    privateRepos: boolean | null;
    pullRequests: boolean | null;
    issues: boolean | null;
    gate: string | null;
}

/** The GitHub account a repository belongs to, which is the scope key its
 *  organization tier is stored under. Lowercased, because GitHub logins are
 *  case-insensitive and two rows for one account would silently disagree. */
export function scopeOf(repoFullName: string): string {
    return (repoFullName.split("/")[0] ?? "").toLowerCase();
}

const SELECT = {
    scope: true,
    execution: true,
    poolId: true,
    model: true,
    effort: true,
    push: true,
    shell: true,
    publicRepos: true,
    privateRepos: true,
    pullRequests: true,
    issues: true,
    gate: true,
    pool: { select: { name: true } }
} as const;

type Row = {
    scope: string;
    execution: string | null;
    poolId: string | null;
    model: string | null;
    effort: string | null;
    push: string | null;
    shell: string | null;
    publicRepos: boolean | null;
    privateRepos: boolean | null;
    pullRequests: boolean | null;
    issues: boolean | null;
    gate: string | null;
    pool: { name: string } | null;
};

function toView(row: Row): AgentDefaultsView {
    return {
        scope: row.scope,
        execution: row.execution as AgentExecution | null,
        poolId: row.poolId,
        poolName: row.pool?.name ?? null,
        model: row.model,
        effort: row.effort,
        push: row.push as AgentPushPolicy | null,
        shell: row.shell as AgentShellPolicy | null,
        publicRepos: row.publicRepos,
        privateRepos: row.privateRepos,
        pullRequests: row.pullRequests,
        issues: row.issues,
        gate: row.gate
    };
}

/** Every tier this owner has set, general first and organizations after it in
 *  name order - the order the settings screen lists them in. */
export async function listAgentDefaults(ownerId: string): Promise<AgentDefaultsView[]> {
    const rows = await prisma.agentDefaults.findMany({ where: { ownerId }, select: SELECT, orderBy: { scope: "asc" } });
    return rows.map(toView);
}

/** One tier, or null when nobody has set it. */
export async function getAgentDefaults(ownerId: string, scope: string): Promise<AgentDefaultsView | null> {
    const row = await prisma.agentDefaults.findUnique({
        where: { ownerId_scope: { ownerId, scope } },
        select: SELECT
    });
    return row ? toView(row) : null;
}

/**
 * Store one tier.
 *
 * A tier whose every field is null is deleted rather than kept: an empty row and
 * no row mean the same thing to the resolver, and leaving it would show an
 * organization on the settings screen that decides nothing.
 */
export async function saveAgentDefaults(ownerId: string, input: AgentDefaultsInput): Promise<void> {
    const { scope, ...values } = input;
    const empty = Object.values(values).every((value) => value === null);
    if (empty) {
        await prisma.agentDefaults.deleteMany({ where: { ownerId, scope } });
        return;
    }
    // A pool only means anything for `runners`; storing one beside another
    // execution would leave the screen showing a machine nothing runs on.
    const poolId = values.execution === "runners" ? values.poolId : null;
    const data = { ...values, poolId };
    await prisma.agentDefaults.upsert({
        where: { ownerId_scope: { ownerId, scope } },
        create: { ownerId, scope, ...data },
        update: data
    });
}

export async function removeAgentDefaults(ownerId: string, scope: string): Promise<void> {
    await prisma.agentDefaults.deleteMany({ where: { ownerId, scope } });
}

/** What a tier contributes to the policy, with the columns that are not part of
 *  it left out. */
function overrideOf(row: AgentDefaultsView | AgentPolicyOverride | null): AgentPolicyOverride | null {
    if (!row) return null;
    const value = row as AgentDefaultsView;
    return {
        publicRepos: value.publicRepos ?? null,
        privateRepos: value.privateRepos ?? null,
        pullRequests: value.pullRequests ?? null,
        issues: value.issues ?? null,
        gate: (value.gate as AgentPolicy["gate"] | null) ?? null
    };
}

/** What a repository row itself decides. Its own columns win over both tiers. */
export interface RepoPolicyColumns {
    repoFullName: string;
    pullRequests: boolean | null;
    issues: boolean | null;
    gate: string | null;
}

/**
 * The policy in force for one repository.
 *
 * Both tiers are read in one query rather than two: they are rows of the same
 * table and the webhook path asks for this on every event it might act on.
 */
export async function policyForRepo(ownerId: string, repo: RepoPolicyColumns): Promise<AgentPolicy> {
    const scope = scopeOf(repo.repoFullName);
    const rows = await prisma.agentDefaults.findMany({
        where: { ownerId, scope: { in: [scope, GENERAL_SCOPE] } },
        select: SELECT
    });
    const org = rows.find((row) => row.scope === scope) ?? null;
    const general = rows.find((row) => row.scope === GENERAL_SCOPE) ?? null;
    return resolveAgentPolicy(
        {
            pullRequests: repo.pullRequests,
            issues: repo.issues,
            gate: (repo.gate as AgentPolicy["gate"] | null) ?? null
        },
        overrideOf(org ? toView(org) : null),
        overrideOf(general ? toView(general) : null)
    );
}

/**
 * The policy a repository nobody has configured yet would get.
 *
 * Used by the add dialog, which has to know whether the visibility it is looking
 * at is allowed before it offers to enable anything.
 */
export async function policyForNewRepo(ownerId: string, repoFullName: string): Promise<AgentPolicy> {
    return policyForRepo(ownerId, { repoFullName, pullRequests: null, issues: null, gate: null });
}

/**
 * The configuration a new repository starts from, tier by tier.
 *
 * Only the fields a tier actually answered are returned; the caller falls back
 * to the recommendation for the execution and to the visibility-derived shell,
 * both of which depend on the repository rather than on a tier.
 */
export async function inheritedConfig(
    ownerId: string,
    repoFullName: string
): Promise<Pick<AgentDefaultsView, "execution" | "poolId" | "model" | "effort" | "push" | "shell">> {
    const scope = scopeOf(repoFullName);
    const rows = await prisma.agentDefaults.findMany({
        where: { ownerId, scope: { in: [scope, GENERAL_SCOPE] } },
        select: SELECT
    });
    const org = rows.find((row) => row.scope === scope);
    const general = rows.find((row) => row.scope === GENERAL_SCOPE);
    const pick = <K extends "execution" | "poolId" | "model" | "effort" | "push" | "shell">(key: K) =>
        (org?.[key] ?? general?.[key] ?? null) as AgentDefaultsView[K];
    return {
        execution: pick("execution"),
        poolId: pick("poolId"),
        model: pick("model"),
        effort: pick("effort"),
        push: pick("push"),
        shell: pick("shell")
    };
}

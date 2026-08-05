/**
 * The repositories somebody turned the agent on for.
 *
 * Reads and writes AgentRepo, and answers the one question the screens keep
 * asking: given this repository, where should it run and what can it run on. The
 * advice itself is pure and lives in @polaris/core; what this module adds is the
 * facts that feed it, which are all about this instance rather than the
 * repository - whether a pool already covers it, whether the box can start a
 * container, and whether GitHub could reach us at all.
 */

import { prisma } from "@polaris/db";
import { getCapabilities } from "@polaris/config";
import { appBaseUrl } from "@/lib/domain-service";
import { parseLabels } from "@/lib/runners/runner-labels";
import { inheritedConfig } from "@/lib/agents/agent-defaults-service";
import {
    DEFAULT_AGENT_PUSH_POLICY,
    defaultShellPolicy,
    recommendExecution,
    type AgentExecution,
    type AgentRepoConfigInput,
    type ExecutionAdvice
} from "@polaris/core";

/** One enabled repository, as every Agents screen reads it. */
export interface AgentRepoView {
    id: string;
    repoFullName: string;
    installationId: string;
    isPrivate: boolean;
    execution: AgentExecution;
    poolId: string | null;
    poolName: string | null;
    model: string;
    effort: string;
    push: string;
    shell: string;
    enabled: boolean;
    /** Null means "inherit", from the organization tier and then the instance's.
     *  What they resolve to is `policyForRepo`. */
    pullRequests: boolean | null;
    issues: boolean | null;
    gate: string | null;
    workflowInstalledAt: Date | null;
    error: string | null;
    automationCount: number;
    lastRunAt: Date | null;
}

export async function listAgentRepos(ownerId: string): Promise<AgentRepoView[]> {
    const rows = await prisma.agentRepo.findMany({
        where: { ownerId },
        orderBy: { repoFullName: "asc" },
        include: {
            pool: { select: { name: true } },
            _count: { select: { automations: true } },
            runs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        repoFullName: row.repoFullName,
        installationId: row.installationId,
        isPrivate: row.isPrivate,
        execution: row.execution as AgentExecution,
        poolId: row.poolId,
        poolName: row.pool?.name ?? null,
        model: row.model,
        effort: row.effort,
        push: row.push,
        shell: row.shell,
        enabled: row.enabled,
        pullRequests: row.pullRequests,
        issues: row.issues,
        gate: row.gate,
        workflowInstalledAt: row.workflowInstalledAt,
        error: row.error,
        automationCount: row._count.automations,
        lastRunAt: row.runs[0]?.createdAt ?? null
    }));
}

export async function getAgentRepo(ownerId: string, repoId: string): Promise<AgentRepoView | null> {
    const all = await listAgentRepos(ownerId);
    return all.find((row) => row.id === repoId) ?? null;
}

/** The repository a webhook is about, whoever enabled it. Webhooks carry no
 *  session, so this is the one read that is not scoped to an owner. */
export async function agentRepoByFullName(repoFullName: string) {
    return prisma.agentRepo.findFirst({
        where: { repoFullName, enabled: true },
        include: { automations: { where: { enabled: true } } }
    });
}

/**
 * Whether a runner pool would take a job for this repository.
 *
 * Asked of the pool's resolved targets rather than its scope, because a scope
 * naming an account is a question for GitHub that was already answered once, and
 * re-asking it per repository on a settings screen would spend the connection's
 * rate limit on a list that changes when somebody creates a repository.
 */
export async function poolsServing(ownerId: string, repoFullName: string): Promise<Array<{ id: string; name: string; labels: string[] }>> {
    const owner = repoFullName.split("/")[0] ?? "";
    const pools = await prisma.runnerPool.findMany({
        where: {
            ownerId,
            enabled: true,
            targets: { some: { OR: [{ key: repoFullName }, { key: owner, kind: "org" }] } }
        },
        select: { id: true, name: true, labels: true }
    });
    return pools.map((pool) => ({ id: pool.id, name: pool.name, labels: parseLabels(pool.labels) }));
}

/**
 * What Polaris advises for this repository, and what it cannot offer.
 *
 * `publiclyReachable` is read from the configured app URL rather than probed: an
 * instance reachable only on a LAN has a LAN address configured, and a hosted
 * runner cannot reach it whatever a probe from inside the network would say.
 */
export async function adviseExecution(ownerId: string, repoFullName: string, isPrivate: boolean): Promise<ExecutionAdvice> {
    const [pools, appUrl, serverCapable] = await Promise.all([
        poolsServing(ownerId, repoFullName),
        appBaseUrl(),
        Promise.resolve(canRunContainers())
    ]);
    return recommendExecution({
        isPrivate,
        servingPool: pools.length > 0,
        serverCapable,
        publiclyReachable: isPublicUrl(appUrl)
    });
}

/** Whether an address is one a machine outside this network could resolve and
 *  reach. A hostname that is plainly local is not, and neither is a bare IP in a
 *  private range. */
export function isPublicUrl(raw: string | null): boolean {
    if (!raw) return false;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        const [a = 0, b = 0] = host.split(".").map(Number);
        if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
    }
    // A name with no dot cannot be resolved from outside, whatever it resolves to
    // in here.
    return host.includes(".");
}

/**
 * Whether this instance can start a container to run an agent in.
 *
 * Read from the capability snapshot the daemon probe keeps current rather than
 * probed here: the answer changes when the host daemon starts or stops, which is
 * rare, and a settings screen should not pay a round trip for it.
 */
export function canRunContainers(): boolean {
    return getCapabilities().docker;
}

export interface EnableAgentRepoInput {
    repoFullName: string;
    installationId: string;
    isPrivate: boolean;
    config: AgentRepoConfigInput;
}

/**
 * Turn the agent on for a repository, or change how it runs.
 *
 * Upsert rather than create: enabling a repository that is already enabled is the
 * same decision restated, and refusing it would mean somebody who re-ran the
 * wizard sees an error instead of their settings.
 */
export async function upsertAgentRepo(
    ownerId: string,
    input: EnableAgentRepoInput
): Promise<{ id: string; created: boolean }> {
    const shared = {
        installationId: input.installationId,
        isPrivate: input.isPrivate,
        execution: input.config.execution,
        poolId: input.config.execution === "runners" ? input.config.poolId : null,
        model: input.config.model,
        effort: input.config.effort,
        push: input.config.push,
        shell: input.config.shell,
        enabled: input.config.enabled,
        pullRequests: input.config.pullRequests,
        issues: input.config.issues,
        gate: input.config.gate,
        // A change of execution invalidates whatever workflow is in the repository,
        // so the installer runs again rather than trusting the stamp.
        error: null
    };
    // Whether this is the first time is worth knowing: a repository being added
    // gets the rules that make it answer anything, and one being re-saved must
    // not have rules somebody deleted put back.
    const before = await prisma.agentRepo.findUnique({
        where: { ownerId_repoFullName: { ownerId, repoFullName: input.repoFullName } },
        select: { id: true }
    });
    const row = await prisma.agentRepo.upsert({
        where: { ownerId_repoFullName: { ownerId, repoFullName: input.repoFullName } },
        create: { ownerId, repoFullName: input.repoFullName, ...shared },
        update: shared,
        select: { id: true }
    });
    return { id: row.id, created: before === null };
}

/**
 * The rules a repository starts with.
 *
 * A repository with none answers a direct mention and nothing else, which is not
 * what somebody who just turned the agent on expects: they opened an issue and
 * waited. The two seeded here are the ones the settings already have switches
 * for, so a repository does out of the box exactly what its own settings say it
 * will - the switch and the rule can no longer disagree by one being absent.
 *
 * Seeded rather than implied, so they show up under Automations as rules
 * somebody can read, narrow with a label, give instructions to, or delete. A
 * deleted rule stays deleted: this only ever runs when the row is new.
 */
export async function seedDefaultAutomations(repoId: string): Promise<void> {
    const empty = JSON.stringify({ labels: [], branches: [], authors: [] });
    await prisma.agentAutomation.createMany({
        data: [
            {
                repoId,
                trigger: "issue.opened",
                condition: empty,
                mode: null,
                instructions: "",
                enabled: true
            },
            {
                repoId,
                trigger: "pr.opened",
                condition: empty,
                // Reviewing is what a new pull request wants, and leaving the mode
                // unset would let the agent decide to implement something instead.
                // Spelled as the runtime's own catalogue spells it.
                mode: "Review",
                instructions: "",
                enabled: true
            }
        ]
    });
}

/** Stop running agents here. The row stays: the automations and the run history on
 *  it are worth keeping, and turning it back on should not mean setting it up
 *  again. */
export async function setAgentRepoEnabled(ownerId: string, repoId: string, enabled: boolean): Promise<boolean> {
    const { count } = await prisma.agentRepo.updateMany({ where: { id: repoId, ownerId }, data: { enabled } });
    return count > 0;
}

/** Forget the repository entirely, with its automations and runs. */
export async function removeAgentRepo(ownerId: string, repoId: string): Promise<boolean> {
    const { count } = await prisma.agentRepo.deleteMany({ where: { id: repoId, ownerId } });
    return count > 0;
}

/**
 * The configuration offered for a repository nobody has configured yet.
 *
 * Whatever the tiers above it answered wins; the rest comes from the repository
 * itself. The execution falls back to the recommendation rather than to a fixed
 * value because the right answer depends on what this instance can do, and the
 * shell falls back to the visibility for the reason in `defaultShellPolicy`.
 */
export async function defaultConfigFor(
    ownerId: string,
    repoFullName: string,
    isPrivate: boolean,
    model: string
): Promise<AgentRepoConfigInput & { advice: ExecutionAdvice }> {
    const [advice, inherited] = await Promise.all([
        adviseExecution(ownerId, repoFullName, isPrivate),
        inheritedConfig(ownerId, repoFullName)
    ]);
    const execution = inherited.execution ?? advice.execution;
    const pools = execution === "runners" ? await poolsServing(ownerId, repoFullName) : [];
    return {
        execution,
        poolId: execution === "runners" ? (inherited.poolId ?? pools[0]?.id ?? null) : null,
        model: inherited.model ?? model,
        effort: (inherited.effort as AgentRepoConfigInput["effort"]) ?? "medium",
        push: inherited.push ?? DEFAULT_AGENT_PUSH_POLICY,
        shell: inherited.shell ?? defaultShellPolicy(isPrivate),
        enabled: true,
        // The tiers already answer these; a new repository overrides nothing.
        pullRequests: null,
        issues: null,
        gate: null,
        advice
    };
}

/**
 * What a GitHub connection is allowed to do with self-hosted runners.
 *
 * Registering a runner needs a permission neither of Polaris's connection
 * methods asks for by default, and the two methods spell it differently:
 *
 *   - A GitHub App needs `administration: write` on an installation to register
 *     runners on its repositories, or `organization_self_hosted_runners: write`
 *     to register them for the whole organization. The second is far narrower and
 *     is the one to prefer wherever it applies.
 *   - A classic Personal Access Token needs the `repo` scope for repositories and
 *     `admin:org` for organizations. A fine-grained token reports no scopes at
 *     all, so its access cannot be read ahead of time.
 *
 * Working this out before a call is what lets Polaris say "add this permission"
 * instead of surfacing a bare 403 an hour into setting a runner up. The logic is
 * pure so it can be exercised without a GitHub account.
 */

/** Where a runner is registered. Org-level covers every repo in the org at once. */
export const RUNNER_SCOPES = ["repo", "org"] as const;
export type RunnerScope = (typeof RUNNER_SCOPES)[number];

/** The App permission that grants repository-level runner registration. */
export const RUNNER_REPO_PERMISSION = "administration";

/** The App permission that grants organization-level runner registration. */
export const RUNNER_ORG_PERMISSION = "organization_self_hosted_runners";

export interface RunnerInstallation {
    login: string;
    /** "Organization" or "User", as GitHub reports it. */
    accountType?: string;
    permissions: Record<string, string>;
}

export interface RunnerAccessInput {
    method: "pat" | "app" | null;
    /**
     * Scopes from a classic token's `x-oauth-scopes` header. Null means the
     * header was absent, which is what a fine-grained token looks like - not the
     * same as "no scopes".
     */
    patScopes?: string[] | null;
    installations?: RunnerInstallation[];
}

/** What one account can have runners registered against. */
export interface RunnerAccountAccess {
    login: string;
    /** Runners can be registered on this account's repositories. */
    repo: boolean;
    /** Runners can be registered for the organization as a whole. */
    org: boolean;
}

export interface RunnerAccess {
    method: "pat" | "app" | null;
    /** At least one account can have a runner registered somewhere. */
    ready: boolean;
    /** True when Polaris cannot tell without trying (a fine-grained token). */
    unknown: boolean;
    accounts: RunnerAccountAccess[];
    /** What the operator has to change, or null when nothing is missing. */
    advice: string | null;
}

function granted(permissions: Record<string, string>, name: string): boolean {
    return permissions[name] === "write" || permissions[name] === "admin";
}

/** Evaluate a connection's runner access. */
export function evaluateRunnerAccess(input: RunnerAccessInput): RunnerAccess {
    if (!input.method) {
        return {
            method: null,
            ready: false,
            unknown: false,
            accounts: [],
            advice: "Connect GitHub under Integrations before adding runners."
        };
    }

    if (input.method === "app") {
        const accounts = (input.installations ?? []).map((install) => ({
            login: install.login,
            repo: granted(install.permissions, RUNNER_REPO_PERMISSION),
            org:
                install.accountType === "Organization" &&
                granted(install.permissions, RUNNER_ORG_PERMISSION)
        }));
        const ready = accounts.some((account) => account.repo || account.org);
        return {
            method: "app",
            ready,
            unknown: false,
            accounts,
            advice: ready ? null : appAdvice(accounts.length > 0)
        };
    }

    // A classic token announces its scopes; a fine-grained one does not, and
    // guessing either way would be worse than saying so.
    if (input.patScopes === null || input.patScopes === undefined) {
        return {
            method: "pat",
            ready: true,
            unknown: true,
            accounts: [],
            advice:
                "Polaris cannot read a fine-grained token's permissions. Give it Administration: read and write on the repositories you want runners for, and it will tell you if that is missing when you add one."
        };
    }

    const scopes = input.patScopes.map((scope) => scope.trim().toLowerCase());
    const repo = scopes.includes("repo");
    const org = scopes.includes("admin:org");
    return {
        method: "pat",
        ready: repo || org,
        unknown: false,
        accounts: [],
        advice: repo || org ? null : "This token has neither the `repo` nor the `admin:org` scope, so it cannot register runners. Replace it, or connect a GitHub App instead."
    };
}

function appAdvice(hasInstallations: boolean): string {
    if (!hasInstallations) return "The GitHub App is not installed on any account yet.";
    return "The GitHub App cannot register runners yet. On its settings page add Repository permissions > Administration: Read and write for repository runners, or Organization permissions > Self-hosted runners: Read and write for organization-wide ones, then approve the request on each installation.";
}

/**
 * Labels decide which jobs land on a runner, so they are normalized the way
 * GitHub does: lowercased, trimmed, de-duplicated, and never empty. The platform
 * labels GitHub adds by itself are not repeated here.
 */
export function normalizeRunnerLabels(labels: string[]): string[] {
    const seen = new Set<string>();
    for (const label of labels) {
        const clean = label.trim().toLowerCase();
        if (clean && clean.length <= 64) seen.add(clean);
    }
    return [...seen];
}

/**
 * How much of the machine a job is allowed to see.
 *
 *   - `container` throws the whole environment away with the container it ran in,
 *     which is the only one of the two that survives a hostile workflow.
 *   - `workspace` gives each job an empty directory on the machine itself. It is a
 *     clean slate, not a boundary: a job still runs as the login and can read what
 *     that login can read. It exists for machines with no container engine, and
 *     everything that offers it says so.
 */
export const RUNNER_ISOLATIONS = ["container", "workspace"] as const;
export type RunnerIsolation = (typeof RUNNER_ISOLATIONS)[number];

/** One ephemeral runner's life. It registers, waits, takes a single job, exits. */
export const RUNNER_JOB_STATES = ["starting", "idle", "busy", "finished", "failed"] as const;
export type RunnerJobState = (typeof RUNNER_JOB_STATES)[number];

/** States in which a runner still occupies one of a pool's slots. */
export const RUNNER_JOB_LIVE_STATES: readonly RunnerJobState[] = ["starting", "idle", "busy"];

/** Ceiling on runners a single pool keeps alive. Each one is a real process on
 *  somebody's machine, so the number is bounded rather than free-form. */
export const MAX_RUNNER_CONCURRENCY = 8;

/**
 * Whether this connection may register runners on a target, and why not when it
 * may not. Read before a pool is offered, so an operator finds out here rather
 * than after wiring up a machine.
 *
 * A fine-grained token reports no scopes, so its access is unknowable in advance
 * (`access.unknown`); that is allowed through and fails later with GitHub's own
 * refusal, which is more honest than blocking on a guess.
 */
export function runnerTargetRefusal(access: RunnerAccess, scope: RunnerScope, owner: string): string | null {
    if (!access.method) return "Connect GitHub under Integrations before adding runners.";
    if (access.unknown) return null;
    if (access.method === "pat") return access.ready ? null : access.advice;

    const account = access.accounts.find((entry) => entry.login.toLowerCase() === owner.trim().toLowerCase());
    if (!account) return `The GitHub App is not installed on ${owner}.`;
    if (scope === "org") {
        return account.org
            ? null
            : `The connection cannot register organization runners for ${owner}. Grant it Organization permissions > Self-hosted runners: Read and write.`;
    }
    return account.repo
        ? null
        : `The connection cannot register runners on ${owner}'s repositories. Grant it Repository permissions > Administration: Read and write, or register at the organization level instead.`;
}

/** What a machine can actually offer, as observed on it rather than as recorded
 *  when it was enrolled - a container engine can be installed or removed later. */
export interface RunnerHostCapability {
    readonly platform: "linux" | "darwin";
    /** True when the login Polaris signs in as can reach the container engine. On
     *  most systems that group is root-equivalent, so it is granted explicitly at
     *  enrollment and never assumed. */
    readonly containerEngine: boolean;
}

export interface ResolvedIsolation {
    readonly isolation: RunnerIsolation;
    /** Why the requested isolation is unavailable, or null when it was granted. */
    readonly refusal: string | null;
    /** What the operator should know about what they are getting. */
    readonly note: string;
}

/**
 * Settle what a pool actually gets. A request for container isolation is refused
 * rather than quietly downgraded: a workflow author who was told their jobs are
 * contained would otherwise be wrong about it, which is worse than not starting.
 */
export function resolveRunnerIsolation(
    requested: RunnerIsolation,
    capability: RunnerHostCapability
): ResolvedIsolation {
    if (requested === "container") {
        if (capability.platform === "darwin") {
            return {
                isolation: "container",
                refusal: "Jobs cannot be contained on macOS yet. Choose a clean workspace, and expect it to share the machine.",
                note: ""
            };
        }
        if (!capability.containerEngine) {
            return {
                isolation: "container",
                refusal: "The Polaris login on this machine cannot reach a container engine. Re-run the enrollment command with --docker, or choose a clean workspace.",
                note: ""
            };
        }
        return { isolation: "container", refusal: null, note: "Each job runs in its own container and leaves nothing behind." };
    }

    return {
        isolation: "workspace",
        refusal: null,
        note:
            capability.platform === "darwin"
                ? "Each job gets an empty directory on the Mac itself. It is a clean slate, not a boundary: a job can reach anything the Polaris login can."
                : "Each job gets an empty directory on the machine itself. It is a clean slate, not a boundary: a job can reach anything the Polaris login can."
    };
}

/**
 * GitHub refuses a name already registered on the target and caps it at 64
 * characters, so the pool's name is trimmed and the runner's own id makes it
 * unique. Kept readable, because this string is what shows up in a workflow log.
 *
 * The suffix comes off the END of the id. These are UUIDv7s, whose leading 48 bits
 * are a millisecond timestamp - a pool starting several runners at once would give
 * them all the same prefix, and GitHub would reject every one after the first.
 */
export function runnerName(poolName: string, jobId: string): string {
    return `${runnerNamePrefix(poolName)}${jobId.replace(/-/g, "").slice(-12)}`;
}

/** What every runner of a pool is named after. Reconciliation uses it to spot
 *  registrations GitHub still holds that Polaris has no runner for - the ones left
 *  behind when a machine died mid-job. */
export function runnerNamePrefix(poolName: string): string {
    const slug = poolName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
    return `polaris-${slug || "runner"}-`;
}

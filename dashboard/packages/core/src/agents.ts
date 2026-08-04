/**
 * Where a coding agent runs for a repository, and what starts it.
 *
 * Three places can run one, and the difference between them is who pays and who
 * has to be reachable:
 *
 *   - `actions` puts the job on a GitHub-hosted runner. Free on a public
 *     repository, metered on a private one, and it costs the operator no
 *     hardware at all.
 *   - `runners` puts the same job on one of the operator's own machines through
 *     an existing runner pool. GitHub still orchestrates it, so a private
 *     repository still spends the account's Actions minutes.
 *   - `server` skips GitHub Actions entirely: Polaris clones the repository and
 *     runs the agent in a container on its own box, then reports back over the
 *     API. Nothing is metered, and no workflow file is involved.
 *
 * The recommendation below is the whole point of offering three. Left to
 * themselves people put private repositories on GitHub-hosted runners, which is
 * the one combination that bills by the minute for something the operator
 * already has hardware for.
 *
 * One asymmetry drives most of this: the runtime calls back to the instance for
 * its run context, its tokens and its results. A GitHub-hosted runner is on the
 * public internet, so `actions` is only possible when Polaris is reachable from
 * there. The operator's own machines and Polaris itself are not subject to that.
 */

/** Where a repository's runs happen. */
export const AGENT_EXECUTIONS = ["actions", "runners", "server"] as const;
export type AgentExecution = (typeof AGENT_EXECUTIONS)[number];

/** How each choice reads on the screen that makes it. */
export const AGENT_EXECUTION_LABELS: Record<AgentExecution, string> = {
    actions: "GitHub Actions",
    runners: "Polaris runners",
    server: "Polaris server"
};

/** What each choice actually does, in the terms that decide between them. */
export const AGENT_EXECUTION_NOTES: Record<AgentExecution, string> = {
    actions: "Runs on a GitHub-hosted machine. Free on public repositories, billed per minute on private ones.",
    runners: "Runs on one of your enrolled servers through a runner pool. GitHub still schedules it, so a private repository still spends Actions minutes.",
    server: "Runs in a container on the Polaris box, without GitHub Actions. Nothing is metered and the repository needs no workflow file."
};

/**
 * What Polaris knows when it is asked where a repository should run.
 *
 * `servingPool` and `serverCapable` are facts about this instance rather than
 * preferences: a pool that already covers the repository, and a box that can
 * start containers. `publiclyReachable` is the constraint that rules options
 * out rather than ranking them.
 */
export interface ExecutionAdviceInput {
    /** Whether the repository is private. A public one is the cheap case. */
    readonly isPrivate: boolean;
    /** Whether a runner pool already registers runners for this repository. */
    readonly servingPool: boolean;
    /** Whether this instance can start a container to run an agent in. */
    readonly serverCapable: boolean;
    /**
     * Whether a GitHub-hosted runner could reach this instance. False on a
     * LAN-only install, which cannot use `actions` at all: the job would start
     * and then fail asking for its run context.
     */
    readonly publiclyReachable: boolean;
}

export interface ExecutionAdvice {
    /** What Polaris would pick. */
    readonly execution: AgentExecution;
    /** Why, in one sentence, shown beside the choice. */
    readonly reason: string;
    /**
     * Choices that cannot work here at all, with the reason. A choice in this
     * map is refused rather than discouraged: the run would fail.
     */
    readonly unavailable: Partial<Record<AgentExecution, string>>;
}

/**
 * Where this repository should run, and why.
 *
 * Advice, never a lock. Whatever the operator picks is what gets stored - the
 * only choices they cannot make are the ones in `unavailable`, which would not
 * run at all.
 */
export function recommendExecution(input: ExecutionAdviceInput): ExecutionAdvice {
    const unavailable: Partial<Record<AgentExecution, string>> = {};
    if (!input.publiclyReachable) {
        unavailable.actions =
            "A GitHub-hosted runner has to reach this Polaris instance, and it has no public address yet.";
    }
    if (!input.serverCapable) {
        unavailable.server = "This Polaris instance cannot start containers, so it cannot run an agent itself.";
    }
    if (!input.servingPool) {
        unavailable.runners = "No runner pool covers this repository yet. Add one under Apps > Runners.";
    }

    // A public repository costs nothing on GitHub's own machines, and running it
    // on the operator's hardware would spend something to save nothing. It is
    // also the case where a stranger can open the pull request that triggers the
    // run, which is a reason to keep it off the operator's box rather than on it.
    if (!input.isPrivate && !unavailable.actions) {
        return {
            execution: "actions",
            reason: "This repository is public, so GitHub-hosted runners are free and nothing runs on your hardware.",
            unavailable
        };
    }

    // Private repositories are where the meter runs. A pool that already covers
    // this repository is the cheapest thing that still behaves like CI, so it
    // comes before the standalone executor.
    if (input.isPrivate && !unavailable.runners) {
        return {
            execution: "runners",
            reason: "A runner pool already covers this repository, so it runs on your own machine instead of a hosted one.",
            unavailable
        };
    }

    if (input.isPrivate && !unavailable.server) {
        return {
            execution: "server",
            reason: "This repository is private, and running it here spends no GitHub Actions minutes.",
            unavailable
        };
    }

    if (!unavailable.server) {
        return {
            execution: "server",
            reason: "This instance has no public address, so the run happens here rather than on a hosted machine.",
            unavailable
        };
    }

    if (!unavailable.actions) {
        return {
            execution: "actions",
            reason: input.isPrivate
                ? "Nothing here can run it, so it falls to GitHub-hosted runners. A private repository is billed per minute."
                : "GitHub-hosted runners are free for this repository.",
            unavailable
        };
    }

    // Everything is refused. Still return the choice whose blocker is the one
    // worth fixing rather than nothing at all: the screen shows the reason.
    return {
        execution: "server",
        reason: "Nothing can run this repository yet. Fix one of the reasons below.",
        unavailable
    };
}

/**
 * What can start a run.
 *
 * These are Polaris's own names rather than GitHub's event names, because one
 * choice here can span several events (a mention arrives on an issue comment, a
 * review comment or an issue body) and because the list is what an operator
 * reads on a form. The mapping to GitHub events lives in the webhook.
 */
export const AGENT_TRIGGERS = [
    "mention",
    "issue.opened",
    "issue.labeled",
    "pr.opened",
    "pr.review_requested",
    "pr.review_submitted",
    "ci.failed",
    "manual"
] as const;
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number];

export const AGENT_TRIGGER_LABELS: Record<AgentTrigger, string> = {
    mention: "Mentioned",
    "issue.opened": "Issue opened",
    "issue.labeled": "Issue labelled",
    "pr.opened": "Pull request opened",
    "pr.review_requested": "Review requested",
    "pr.review_submitted": "Review submitted",
    "ci.failed": "Checks failed",
    manual: "Started by hand"
};

export const AGENT_TRIGGER_NOTES: Record<AgentTrigger, string> = {
    mention: "Somebody names the app in an issue, a pull request or a comment. Always on: it is how people ask for something specific.",
    "issue.opened": "A new issue. Useful for triage, or for attempting a fix straight away.",
    "issue.labeled": "A label is added to an issue. Pair it with a label so only the ones you mark are picked up.",
    "pr.opened": "A new pull request, for an automatic review.",
    "pr.review_requested": "The app is asked for a review by name.",
    "pr.review_submitted": "Somebody reviewed a pull request, so their feedback can be addressed.",
    "ci.failed": "A check run failed, so the logs can be read and a fix attempted.",
    manual: "Started from Polaris, with a prompt you write."
};

/**
 * The trigger every enabled repository answers, whatever else is configured.
 *
 * A mention is a person addressing the app directly. Turning that off would
 * leave a repository where the app is installed, appears to be listening, and
 * silently is not.
 */
export const ALWAYS_ON_TRIGGER: AgentTrigger = "mention";

/** Read a stored trigger list back, keeping only names this version knows, so a
 *  row written by a newer Polaris cannot widen what runs here. */
export function parseAgentTriggers(stored: string): AgentTrigger[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return AGENT_TRIGGERS.filter((trigger) => parsed.includes(trigger));
}

/** Where a run got to. */
export const AGENT_RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const AGENT_RUN_STATE_LABELS: Record<AgentRunState, string> = {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled"
};

/** Whether a run has stopped moving. */
export function isTerminalRunState(state: AgentRunState): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * What the agent may do with git, and with a shell.
 *
 * Both are the runtime's own vocabulary, repeated here because they are stored
 * on the repository row and rendered on a form. `restricted` is the interesting
 * value in each: it is what makes an agent useful on a repository nobody wants
 * it pushing to the default branch of.
 */
export const AGENT_PUSH_POLICIES = ["disabled", "restricted", "enabled"] as const;
export type AgentPushPolicy = (typeof AGENT_PUSH_POLICIES)[number];

export const AGENT_PUSH_POLICY_LABELS: Record<AgentPushPolicy, string> = {
    disabled: "Read-only",
    restricted: "Feature branches only",
    enabled: "Full access"
};

export const AGENT_PUSH_POLICY_NOTES: Record<AgentPushPolicy, string> = {
    disabled: "The agent can read the repository and comment, and cannot push anything.",
    restricted: "The agent can push its own branches and open pull requests. It cannot push to the default branch, delete a branch, or push tags.",
    enabled: "The agent can push anywhere it has access to, including the default branch."
};

export const AGENT_SHELL_POLICIES = ["disabled", "restricted", "enabled"] as const;
export type AgentShellPolicy = (typeof AGENT_SHELL_POLICIES)[number];

export const AGENT_SHELL_POLICY_LABELS: Record<AgentShellPolicy, string> = {
    disabled: "No shell",
    restricted: "Shell without secrets",
    enabled: "Full shell"
};

export const AGENT_SHELL_POLICY_NOTES: Record<AgentShellPolicy, string> = {
    disabled: "The agent cannot run commands. It can still read files and use its git and GitHub tools.",
    restricted: "The agent can run commands, with secrets filtered out of the environment they see.",
    enabled: "The agent can run commands with the job's full environment."
};

/**
 * What a repository gets before anybody configures it.
 *
 * Pushing is restricted rather than disabled, because an agent that cannot open
 * a pull request cannot do the thing most people install it for, and a feature
 * branch is reviewable. The shell default depends on visibility and is decided
 * by `defaultShellPolicy` rather than fixed here.
 */
export const DEFAULT_AGENT_PUSH_POLICY: AgentPushPolicy = "restricted";

/**
 * The shell a repository gets by default.
 *
 * A public repository can have a pull request opened by anybody, and the agent
 * reads that pull request. Filtering secrets out of the environment it can run
 * commands in is the difference between a prompt-injection attempt reading the
 * repository and reading the operator's keys.
 */
export function defaultShellPolicy(isPrivate: boolean): AgentShellPolicy {
    return isPrivate ? "enabled" : "restricted";
}

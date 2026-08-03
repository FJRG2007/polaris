/**
 * Who is allowed to make one of the operator's machines run something.
 *
 * A self-hosted runner is not a queue worker that inspects a job and decides
 * whether to take it. It is registered against a repository before any work
 * exists, GitHub hands it whatever matches its labels, and by then the code is
 * already on the machine. Anything decided per job therefore has to be decided
 * *on* the machine, in the window GitHub leaves for it: the job hook that runs
 * once a job has been assigned and before any step of it runs. A non-zero exit
 * there means the job never starts, which is the only refusal worth having - one
 * that happens after a step has run is a refusal that already lost.
 *
 * That is what this module produces. The policy is data an operator sets per
 * repository; `renderJobGuard` turns it into the script that enforces it. The
 * decision is written once, in the script, rather than once here and once again
 * in shell - a guard that disagrees with the screen that configured it is worse
 * than no guard at all.
 *
 * The defaults are GitHub's own advice rather than the permissive thing: a
 * self-hosted runner is for private repositories, and a pull request from a fork
 * is a stranger's code asking to run on your hardware with your secrets in its
 * environment. Both are off until somebody turns them on and is told what they
 * are turning on.
 */

/**
 * The events an operator chooses between. These are GitHub's own event names,
 * because that is what a workflow's `on:` block says and what the guard reads
 * out of the environment - friendlier words would only let the two disagree.
 *
 * `other` stands for every event not named here (a release, a schedule change, a
 * repository dispatch). It exists so the list can stay short without silently
 * allowing whatever GitHub adds next.
 */
export const RUNNER_EVENTS = ["push", "pull_request", "workflow_dispatch", "schedule", "other"] as const;
export type RunnerEvent = (typeof RUNNER_EVENTS)[number];

/** How each event reads on the screen that turns it on. */
export const RUNNER_EVENT_LABELS: Record<RunnerEvent, string> = {
    push: "Pushes",
    pull_request: "Pull requests",
    workflow_dispatch: "Started by hand",
    schedule: "On a schedule",
    other: "Everything else"
};

/** What each event actually lets in, in the terms that decide it. */
export const RUNNER_EVENT_NOTES: Record<RunnerEvent, string> = {
    push: "A commit or tag pushed to this repository.",
    pull_request: "A pull request opened or updated, so it is built and tested before it is merged.",
    workflow_dispatch: "Somebody starting a workflow from the Actions tab.",
    schedule: "A workflow on a cron, which runs whether anybody is watching or not.",
    other: "Releases, issue comments, and anything else a workflow listens for."
};

/** GitHub events Polaris maps onto the `push` choice. A tag is a push. */
const PUSH_EVENTS = ["push", "create", "delete"];

/** GitHub events Polaris maps onto the `pull_request` choice. `pull_request_target`
 *  is in here deliberately: it runs against the base repository with full access,
 *  so it is the more dangerous of the two rather than the safer one. */
const PULL_REQUEST_EVENTS = [
    "pull_request",
    "pull_request_target",
    "pull_request_review",
    "pull_request_review_comment"
];

/** What one repository lets onto the machine. */
export interface RunnerRepoPolicy {
    /** Events whose jobs may run. Anything else is refused on the machine. */
    readonly events: readonly RunnerEvent[];
    /**
     * Whether a pull request whose code comes from a fork may run. Off by
     * default and worth keeping off: the code in a fork pull request is written
     * by whoever opened it, and it runs with whatever the environment holds.
     */
    readonly allowForks: boolean;
    /**
     * Whether this repository being public is accepted. A public repository is
     * one where anybody at all can open that pull request, which is why GitHub
     * recommends never pointing a self-hosted runner at one.
     */
    readonly allowPublic: boolean;
    /** Whether the secrets set for this repository are put in its jobs' reach. */
    readonly secrets: boolean;
}

/**
 * What a repository gets before anybody configures it: builds on pushes, on
 * pull requests and on demand, nothing from a fork, and no public repository
 * served at all.
 *
 * Pull requests are on, because a repository whose pull requests do not build is
 * a CI setup that does not do what CI is for, and a pull request inside a
 * private repository was opened by somebody who already has access to it. It is
 * the fork case that is off, which is the case that is actually dangerous.
 */
export const DEFAULT_RUNNER_REPO_POLICY: RunnerRepoPolicy = {
    events: ["push", "pull_request", "workflow_dispatch"],
    allowForks: false,
    allowPublic: false,
    secrets: true
};

/** Read a stored event list back, keeping only names this version knows. A row
 *  written by a newer Polaris must not silently widen what runs here. */
export function parseRunnerEvents(stored: string): RunnerEvent[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return [...DEFAULT_RUNNER_REPO_POLICY.events];
    }
    if (!Array.isArray(parsed)) return [...DEFAULT_RUNNER_REPO_POLICY.events];
    return RUNNER_EVENTS.filter((event) => parsed.includes(event));
}

/** A repository is public, private, or Polaris has not been able to ask yet. */
export type RepoVisibility = "public" | "private" | null;

/**
 * Whether a repository may be served at all, and why not when it may not.
 *
 * This is the refusal worth making before a runner is even started: a public
 * repository nobody opted into should not have a machine sitting on it waiting
 * for the first stranger to open a pull request.
 */
export function repoServingRefusal(policy: RunnerRepoPolicy, visibility: RepoVisibility): string | null {
    if (visibility === "public" && !policy.allowPublic) {
        return "This repository is public, so anybody can open a pull request that runs on your machine. Allow public repositories on it if that is what you want.";
    }
    if (policy.events.length === 0) return "Nothing is allowed to run here: no events are turned on.";
    return null;
}

/**
 * What handing this repository its secrets currently means, or null when it
 * means nothing worth saying. A sentence rather than a flag, because the same
 * words belong beside the switch that causes it and in the list that shows it.
 */
export function secretsWarning(policy: RunnerRepoPolicy, visibility: RepoVisibility): string | null {
    if (!policy.secrets) return null;
    if (visibility === "public" && policy.allowPublic) {
        return "This repository is public and its jobs can read the secrets set for it. Anybody who gets a workflow to run here reads them too.";
    }
    if (policy.allowForks) {
        return "Pull requests from forks run here and their jobs can read the secrets set for it. Whoever opens one chooses the code that reads them.";
    }
    return null;
}

/**
 * What a value carried into a job may be called.
 *
 * The same rule as a shell variable, because that is what it becomes. It is also
 * why the reserved names below are refused rather than merely discouraged: this
 * ends up in the same environment the guard reads to decide whether the job may
 * run at all, and a secret that could be called `GITHUB_REPOSITORY` would be a
 * secret that can rewrite what the job appears to be.
 */
const VALID_SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Prefixes the runner sets for itself, and the guard depends on. */
const RESERVED_SECRET_PREFIXES = ["GITHUB_", "RUNNER_", "ACTIONS_"];

/** Why this name cannot be used, or null when it can. */
export function secretKeyRefusal(key: string): string | null {
    const clean = key.trim();
    if (!clean) return "Name this secret";
    if (clean.length > 80) return "That name is too long";
    if (!VALID_SECRET_KEY.test(clean)) {
        return "A name can only be letters, digits and underscores, and cannot start with a digit";
    }
    const reserved = RESERVED_SECRET_PREFIXES.find((prefix) => clean.toUpperCase().startsWith(prefix));
    return reserved ? `Names starting with ${reserved} belong to the runner and cannot be replaced` : null;
}

/**
 * Why this value cannot be used, or null when it can.
 *
 * A value is one line. That is the shape of where these end up rather than a
 * limitation anybody chose: the runner reads them out of a line-per-variable
 * file, and a container carries them as single environment entries. A multi-line
 * value would be truncated at the first newline or corrupt the line after it, so
 * the refusal says what to do instead rather than accepting something that
 * cannot work.
 */
export function secretValueRefusal(value: string): string | null {
    if (!value) return "Enter the value";
    if (value.length > 8000) return "That value is too long for a runner to carry";
    if (/[\r\n]/.test(value)) {
        return "A value has to be one line. For a key or a certificate, store it as base64 and decode it in the workflow step that needs it.";
    }
    return null;
}

/** Where Polaris keeps what a job turned out to be, beside the runner that ran
 *  it. Read when the runner is reaped: an ephemeral runner has de-registered by
 *  then, so GitHub can no longer be asked what it took. */
export const JOB_FACTS_FILE = "polaris-job.json";

/**
 * The same record, written a second way, for the runners Polaris cannot read a
 * file out of.
 *
 * A job on the local box runs in a container started through the host daemon,
 * which forwards a short allowlist of read calls and nothing that fetches a file
 * from inside one. What Polaris can always read is the container's log - so the
 * record is also printed to whatever process 1 is writing to, which in a
 * container is exactly that log. The marker is what tells it apart from the
 * runner's own chatter.
 */
export const JOB_FACTS_MARKER = "::polaris-job::";

/** Pull the record out of a runner's log, newest wins. Returns null when the log
 *  carries no such line, which is every runner that was stood down before it was
 *  ever given a job. */
export function factsFromLog(log: string): JobFacts | null {
    const lines = log.split(/\r?\n/).filter((line) => line.includes(JOB_FACTS_MARKER));
    const last = lines.at(-1);
    if (!last) return null;
    return parseJobFacts(last.slice(last.indexOf(JOB_FACTS_MARKER) + JOB_FACTS_MARKER.length));
}

export interface JobGuardInput {
    readonly policy: RunnerRepoPolicy;
    /** What the repository is right now, so a repository that turned public
     *  after the pool was set up is refused rather than trusted. */
    readonly visibility: RepoVisibility;
}

/**
 * The script GitHub runs between assigning a job to a runner and starting it.
 *
 * POSIX shell with no dependencies, because it runs on whatever the operator
 * enrolled and the one thing it must never do is fail to run. Every refusal
 * prints why: that lands in the job's own log under "Set up runner", and it is
 * the only place the person whose pull request was refused is going to look.
 *
 * The facts are recorded first, so a refused job is still accounted for - "your
 * pull request was blocked" is exactly the run somebody needs to see. Fork
 * detection is the one thing needing the event payload, and it is only emitted
 * when the answer changes something. The runner ships its own Node, which is
 * what reads it; when that cannot be found the job is refused rather than
 * allowed, because the alternative is running a stranger's code on the strength
 * of a missing file.
 */
export function renderJobGuard(input: JobGuardInput): string {
    const { policy, visibility } = input;
    const allowed = new Set<string>();
    for (const event of policy.events) {
        if (event === "push") for (const name of PUSH_EVENTS) allowed.add(name);
        else if (event === "pull_request") for (const name of PULL_REQUEST_EVENTS) allowed.add(name);
        else if (event !== "other") allowed.add(event);
    }

    return `#!/bin/sh
# Written by Polaris, and rewritten every time this runner starts. GitHub runs it
# once a job has been assigned to this runner and before any step of that job
# runs, so exiting non-zero here means the job never touches the machine.
set -u

EVENT="\${GITHUB_EVENT_NAME:-}"

# The record goes beside this script, which is a directory Polaris chose and can
# read back. Derived rather than written in, because the two ways a runner is
# started put it in two different places and only the script knows which it is in.
RECORD_DIR=\$(cd "\$(dirname "\$0")" 2>/dev/null && pwd) || RECORD_DIR=""
[ -n "\$RECORD_DIR" ] || RECORD_DIR="\${RUNNER_TEMP:-/tmp}"
RECORD="\$RECORD_DIR/${JOB_FACTS_FILE}"

# What this job is, written before anything can refuse it: a refused job is still
# a run somebody has to be able to see the reason for.
#
# Written twice on purpose. The file is what Polaris reads off a machine it has a
# login on; the line on process 1's output is what it reads out of a container's
# log, which is all the host daemon will hand back. Whichever one survives, the
# run is accounted for.
record() {
    JSON=\$(printf '{"workflow":"%s","job":"%s","runId":"%s","runNumber":"%s","event":"%s","actor":"%s","ref":"%s","sha":"%s","repository":"%s","refused":"%s"}' \\
        "\${GITHUB_WORKFLOW:-}" "\${GITHUB_JOB:-}" "\${GITHUB_RUN_ID:-}" "\${GITHUB_RUN_NUMBER:-}" \\
        "\${GITHUB_EVENT_NAME:-}" "\${GITHUB_ACTOR:-}" "\${GITHUB_REF_NAME:-}" "\${GITHUB_SHA:-}" \\
        "\${GITHUB_REPOSITORY:-}" "\$1")
    printf '%s\\n' "\$JSON" > "\$RECORD" 2>/dev/null || true
    printf '${JOB_FACTS_MARKER}%s\\n' "\$JSON" > /proc/1/fd/1 2>/dev/null || true
}

refuse() {
    record "\$1"
    echo "Polaris did not let this job run on \${GITHUB_REPOSITORY:-this repository}."
    echo "\$1"
    echo "Change what is allowed under Apps > Runners > Repositories."
    exit 1
}

record ""

${visibility === "public" && !policy.allowPublic ? `refuse "This repository is public, and public repositories are not allowed on this runner."\n\n` : ""}case "\$EVENT" in
${eventCases(allowed, policy.events.includes("other"))}esac

${forkGuard(policy)}exit 0
`;
}

/** The `case` arms deciding the event: every allowed name, then what happens to
 *  everything nobody named. */
function eventCases(allowed: ReadonlySet<string>, everythingElse: boolean): string {
    const arms = allowed.size > 0 ? `    ${[...allowed].join(" | ")})\n        :\n        ;;\n` : "";
    const rest = everythingElse
        ? `    *)\n        # "Everything else" is on, so an event nobody named is let through.\n        :\n        ;;\n`
        : `    *)\n        refuse "Jobs started by '\$EVENT' are not allowed on this runner."\n        ;;\n`;
    return `${arms}${rest}`;
}

/**
 * The part that reads the event payload, emitted only when the answer matters.
 * A policy refusing pull requests outright has already refused above, and one
 * that allows forks has nothing left to ask.
 */
function forkGuard(policy: RunnerRepoPolicy): string {
    if (policy.allowForks || !policy.events.includes("pull_request")) return "";
    return `# A pull request carries the branch it wants merged, and that branch can live in
# somebody else's copy of the repository. Whoever opened it wrote the code about to
# run, so it is refused unless forks were explicitly allowed.
case "\$EVENT" in
    ${PULL_REQUEST_EVENTS.join(" | ")})
        PAYLOAD="\${GITHUB_EVENT_PATH:-}"
        [ -n "\$PAYLOAD" ] && [ -r "\$PAYLOAD" ] || refuse "Polaris could not read this job's event, so it could not tell whether the code comes from a fork."

        NODE=""
        for candidate in "\${RUNNER_ROOT:-.}"/externals/node*/bin/node /usr/local/bin/node; do
            [ -x "\$candidate" ] && NODE="\$candidate" && break
        done
        [ -n "\$NODE" ] || NODE=\$(command -v node 2>/dev/null || true)
        [ -n "\$NODE" ] || refuse "Polaris could not tell whether this pull request comes from a fork, so it did not run it."

        HEAD=\$("\$NODE" -e 'const p=(require(process.argv[1]).pull_request)||{};process.stdout.write(String((p.head&&p.head.repo&&p.head.repo.full_name)||""))' "\$PAYLOAD" 2>/dev/null || true)
        BASE=\$("\$NODE" -e 'const p=(require(process.argv[1]).pull_request)||{};process.stdout.write(String((p.base&&p.base.repo&&p.base.repo.full_name)||process.env.GITHUB_REPOSITORY||""))' "\$PAYLOAD" 2>/dev/null || true)
        [ -n "\$HEAD" ] || refuse "Polaris could not read where this pull request's code comes from, so it did not run it."
        [ "\$HEAD" = "\$BASE" ] || refuse "This pull request's code comes from \$HEAD, which is a fork of \$BASE. Pull requests from forks are not allowed on this runner."
        ;;
esac

`;
}

/** What Polaris reads back out of the record. Every field is optional: it is
 *  written by a shell script on a machine that was running a workflow, and a run
 *  that only half-recorded itself is still worth listing. */
export interface JobFacts {
    readonly workflow: string | null;
    readonly job: string | null;
    readonly runId: string | null;
    readonly runNumber: string | null;
    readonly event: string | null;
    readonly actor: string | null;
    readonly ref: string | null;
    readonly sha: string | null;
    readonly repository: string | null;
    /** Why the guard refused it, or null when it ran. */
    readonly refused: string | null;
}

/** Parse the record, tolerating anything. It is untrusted input: it was written
 *  on a machine a workflow had just been handed. */
export function parseJobFacts(raw: string): JobFacts | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.trim());
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const read = (key: string, limit = 200): string | null => {
        const value = record[key];
        if (typeof value !== "string") return null;
        const trimmed = value.trim().slice(0, limit);
        return trimmed || null;
    };
    const runId = read("runId", 20);
    return {
        workflow: read("workflow"),
        job: read("job"),
        runId: runId && /^\d+$/.test(runId) ? runId : null,
        runNumber: read("runNumber", 20),
        event: read("event", 60),
        actor: read("actor", 60),
        ref: read("ref"),
        sha: read("sha", 60),
        repository: read("repository"),
        refused: read("refused", 500)
    };
}

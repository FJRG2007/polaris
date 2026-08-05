/**
 * Turning something that happened on GitHub into a run.
 *
 * All the trigger logic lives here rather than in the repository's workflow, so
 * changing a rule is a database write instead of a commit, and the rules can
 * never disagree with the screen that configured them.
 *
 * Two trust levels meet in this file and must not be confused. The event payload
 * is written by whoever opened the issue or the comment, so it decides only
 * *whether* a run happens; the instructions folded into the agent's prompt come
 * from the operator's automations and are read from the database. A mention is
 * the one case where a stranger's text reaches the agent as a request, which is
 * why the fork and author checks below exist and why a public repository's shell
 * has secrets filtered out of it by default.
 */

import { prisma } from "@polaris/db";
import { dispatchRun } from "@/lib/agents/agent-dispatch";
import { considerFallback } from "@/lib/agents/agent-fallback";
import { githubAppInstallationToken } from "@/lib/github-service";
import { policyForRepo } from "@/lib/agents/agent-defaults-service";
import { agentRepoByFullName } from "@/lib/agents/agent-repo-service";
import { finishAgentRun, sweepStaleRuns } from "@/lib/agents/agent-run-service";
import {
    AGENT_TRIGGER_LABELS,
    ALWAYS_ON_TRIGGER,
    policyAllowsTrigger,
    policyAllowsVisibility,
    type AgentTrigger
} from "@polaris/core";

/** What a webhook boils down to, once the event's shape is out of the way. */
export interface Incident {
    trigger: AgentTrigger;
    /** The issue or pull request this concerns, when it concerns one. */
    issueNumber: number | null;
    prNumber: number | null;
    /** Who caused it, for the author condition and for ignoring ourselves. */
    actor: string;
    /** Labels currently on the issue, for the label condition. */
    labels: string[];
    /** The branch a pull request targets, for the branch condition. */
    branch: string | null;
    /** Whether the code involved comes from a fork, which decides whether a
     *  mention from a stranger runs at all. */
    fromFork: boolean;
    /** The text that named the app, when a mention is what happened. */
    body: string;
}

/** Everything read out of a payload, all optional: it is untrusted input and a
 *  field missing must not take the webhook down. */
interface Payload {
    action?: string;
    repository?: { full_name?: string; default_branch?: string };
    sender?: { login?: string; type?: string };
    label?: { name?: string };
    issue?: { number?: number; body?: string; labels?: Array<{ name?: string }>; pull_request?: unknown };
    comment?: { body?: string };
    review?: { body?: string; state?: string };
    requested_reviewer?: { login?: string };
    pull_request?: {
        number?: number;
        body?: string;
        base?: { ref?: string };
        head?: { repo?: { full_name?: string } };
        labels?: Array<{ name?: string }>;
    };
    check_suite?: { conclusion?: string; pull_requests?: Array<{ number?: number }> };
    workflow_run?: { id?: number; conclusion?: string; status?: string };
}

/**
 * Which trigger this event is, or null when it is not one.
 *
 * A mention wins over whatever else the event also is: somebody who wrote the
 * app's name in a comment asked for something specific, and running the
 * repository's generic "new pull request" rule instead would answer a different
 * question than the one they asked.
 */
function classify(event: string, payload: Payload, appHandle: string): Incident | null {
    const actor = payload.sender?.login ?? "";
    const labels = (payload.issue?.labels ?? payload.pull_request?.labels ?? [])
        .map((row) => row?.name ?? "")
        .filter(Boolean);
    const prNumber = payload.pull_request?.number ?? null;
    const issueNumber = payload.issue?.number ?? prNumber;
    const branch = payload.pull_request?.base?.ref ?? null;
    const headRepo = payload.pull_request?.head?.repo?.full_name ?? null;
    const fromFork = Boolean(headRepo && payload.repository?.full_name && headRepo !== payload.repository.full_name);
    const base = { issueNumber, prNumber, actor, labels, branch, fromFork };

    // A comment or a review body is newly authored by definition: the event IS
    // somebody writing it. An issue or pull request body is not - it stays on the
    // item for its whole life, so scanning it on every later `edited`, `labeled`,
    // `closed` or `synchronize` would re-run the same mention indefinitely. It is
    // only read on the events that create the item.
    const authored = payload.action === "opened" || payload.action === "reopened";
    const mentionText = [
        payload.comment?.body,
        payload.review?.body,
        ...(authored ? [payload.issue?.body, payload.pull_request?.body] : [])
    ]
        .filter((text): text is string => typeof text === "string")
        .find((text) => mentions(text, appHandle));
    if (mentionText) return { ...base, trigger: ALWAYS_ON_TRIGGER, body: mentionText };

    switch (event) {
        case "issues":
            if (payload.action === "opened") return { ...base, trigger: "issue.opened", body: payload.issue?.body ?? "" };
            if (payload.action === "labeled") {
                const added = payload.label?.name;
                return {
                    ...base,
                    trigger: "issue.labeled",
                    // The label that was just added is the one a rule is about, not
                    // whatever else is on the issue.
                    labels: added ? [added] : labels,
                    body: payload.issue?.body ?? ""
                };
            }
            return null;
        case "pull_request":
            return payload.action === "opened" || payload.action === "reopened"
                ? { ...base, trigger: "pr.opened", body: payload.pull_request?.body ?? "" }
                : payload.action === "review_requested"
                  ? { ...base, trigger: "pr.review_requested", body: "" }
                  : null;
        case "pull_request_review":
            // An approval has nothing to address, so it is not a trigger.
            return payload.action === "submitted" && payload.review?.state !== "approved"
                ? { ...base, trigger: "pr.review_submitted", body: payload.review?.body ?? "" }
                : null;
        case "check_suite":
            return payload.action === "completed" && payload.check_suite?.conclusion === "failure"
                ? {
                      ...base,
                      trigger: "ci.failed",
                      prNumber: payload.check_suite?.pull_requests?.[0]?.number ?? null,
                      issueNumber: payload.check_suite?.pull_requests?.[0]?.number ?? null,
                      body: ""
                  }
                : null;
        default:
            return null;
    }
}

/**
 * Whether this text addresses the app.
 *
 * Matched on a word boundary so `@polaris-agent` does not fire on
 * `@polaris-agent-docs`, and case-insensitively because GitHub logins are.
 */
function mentions(text: string, appHandle: string): boolean {
    if (!appHandle) return false;
    const escaped = appHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`@${escaped}(?![A-Za-z0-9-])`, "i").test(text);
}

/** How much of a body is worth sending. Enough for any issue somebody actually
 *  wrote; the agent reads the rest with its own tools if it needs to. */
const MAX_BODY = 4000;

/**
 * What the agent is told happened.
 *
 * The whole webhook payload used to be the prompt, on the belief that the
 * runtime parsed it as a GitHub event. It does not: without an internal marker
 * it treats the prompt as plain text, so every run fed the model eight kilobytes
 * of JSON - the repository object, every API URL on it, the same user three
 * times - to say "somebody opened an issue called X". A two-line issue exceeded
 * a small model's context and the run died before doing anything.
 *
 * So it is a sentence and the text somebody wrote. Nothing is lost: the run is
 * pointed at the issue or pull request it concerns, and the agent has tools to
 * read the rest of it. This also holds for large models, which were paying for
 * those kilobytes on every run without them ever saying anything.
 */
export function describe(incident: Incident, repoFullName: string): string {
    const at =
        incident.prNumber !== null
            ? `pull request #${incident.prNumber}`
            : incident.issueNumber !== null
              ? `issue #${incident.issueNumber}`
              : "the repository";
    const lines = [
        `${AGENT_TRIGGER_LABELS[incident.trigger]} on ${at} in ${repoFullName}.`,
        incident.actor ? `Opened by @${incident.actor}.` : "",
        incident.branch ? `Targets branch ${incident.branch}.` : "",
        incident.labels.length > 0 ? `Labels: ${incident.labels.join(", ")}.` : ""
    ].filter(Boolean);

    // Untrusted text, and deliberately so: this is the thing the agent is being
    // asked about. It is fenced and labelled rather than blended into the
    // sentences above, so a body claiming to be an instruction reads as what it
    // is - somebody's issue text.
    const body = incident.body.trim();
    if (body) {
        lines.push("", "What it says:", "```", body.slice(0, MAX_BODY), "```");
    }
    return lines.join("\n");
}

/** Whether the operator's conditions let this incident through. */
function matches(condition: { labels: string[]; branches: string[]; authors: string[] }, incident: Incident): boolean {
    // Every list is a narrowing, and an empty one does not narrow. That is what an
    // empty form means, and reading it as "match nothing" would silently disable
    // the rule it belongs to.
    if (condition.labels.length > 0 && !condition.labels.some((label) => incident.labels.includes(label))) return false;
    if (condition.branches.length > 0 && (!incident.branch || !condition.branches.includes(incident.branch))) return false;
    if (condition.authors.length > 0 && !condition.authors.includes(incident.actor)) return false;
    return true;
}

function parseCondition(raw: string): { labels: string[]; branches: string[]; authors: string[] } {
    const empty = { labels: [], branches: [], authors: [] };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return empty;
        const row = parsed as Record<string, unknown>;
        const list = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
        return { labels: list(row.labels), branches: list(row.branches), authors: list(row.authors) };
    } catch {
        return empty;
    }
}

/**
 * Handle one webhook.
 *
 * Returns the runs it started, which is what the route reports back. Anything
 * that does not concern an enabled repository is a no-op rather than an error:
 * the App's webhook carries every event for every repository it is installed on,
 * and most of them are not ours.
 */
export async function handleAgentWebhook(params: {
    event: string;
    payload: unknown;
    /** The App's own login, which is what people write to address it. Read from
     *  the Integration row rather than hardcoded, because every instance names its
     *  own App. */
    appHandle: string;
}): Promise<string[]> {
    // Runs nothing ever reported back on would otherwise sit at `running` with a
    // live callback token. This is the regularly executing server path that
    // already touches the domain, so the sweep rides along rather than needing a
    // scheduler of its own. Deliberately not awaited: it must never delay or fail
    // the webhook it is hitching on.
    void sweepStaleRuns().catch(() => undefined);

    const payload = params.payload as Payload;
    const repoFullName = payload.repository?.full_name;
    if (!repoFullName) return [];

    // A workflow finishing is the one event we send to ourselves that we must
    // read. It is how a run whose job failed, was cancelled or was killed stops
    // saying "running", and its sender is our own App because our own dispatch
    // started it - so it has to be handled before the self-ignore below, which
    // used to swallow it and leave every failed run running until the six-hour
    // sweep while the Actions tab had said "failed" within the minute.
    if (params.event === "workflow_run") return closeOutWorkflowRun(payload);

    // A run's own comments and pushes come back as webhooks. Answering them is how
    // an agent ends up in a conversation with itself.
    if (payload.sender?.type === "Bot" && payload.sender.login?.startsWith(params.appHandle)) return [];

    const repo = await agentRepoByFullName(repoFullName);
    if (!repo) return [];

    const incident = classify(params.event, payload, params.appHandle);
    if (!incident) return [];

    // Code from a fork is written by whoever opened the pull request. Running an
    // agent against it with the repository's own credentials is the case GitHub
    // warns about, and it is refused here rather than left to a per-repository
    // setting nobody would find.
    if (incident.fromFork) return [];

    // What the operator decided above this repository. The visibility switch is
    // checked on every event rather than only when the repository is added: a
    // repository that goes public is exactly the one somebody turned public
    // repositories off for, and it must stop running without anybody having to
    // notice and disable it by hand.
    const policy = await policyForRepo(repo.ownerId, repo);
    if (!policyAllowsVisibility(policy, repo.isPrivate)) return [];
    if (!policyAllowsTrigger(policy, incident.trigger)) return [];

    // A mention needs no rule: it is somebody addressing the app directly, and a
    // repository where that did nothing would look installed and be inert. On a
    // public repository that would also mean any stranger could spend the
    // operator's provider credits by commenting, so there it is limited to people
    // who can already write to the repository. On a private one, everybody who
    // can comment already has that access.
    if (incident.trigger === ALWAYS_ON_TRIGGER) {
        if (!repo.isPrivate && !(await canWriteToRepo(repoFullName, incident.actor))) return [];
        const result = await dispatchRun({
            repo,
            trigger: incident.trigger,
            prompt: describe(incident, repoFullName),
            mode: null,
            issueNumber: incident.issueNumber,
            prNumber: incident.prNumber
        });
        // A run a usage ceiling refused opened no row, so there is nothing for the
        // caller to report or follow.
        return result.runId ? [result.runId] : [];
    }

    const rules = repo.automations.filter((row) => row.trigger === incident.trigger);
    const allowed = rules.filter((row) => matches(parseCondition(row.condition), incident));
    if (allowed.length === 0) return [];

    const started: string[] = [];
    for (const rule of allowed) {
        const result = await dispatchRun({
            repo,
            trigger: incident.trigger,
            // What happened, in a sentence, plus what somebody wrote. The
            // operator's instructions reach the run separately, through
            // run-context.
            prompt: describe(incident, repoFullName),
            mode: rule.mode,
            issueNumber: incident.issueNumber,
            prNumber: incident.prNumber
        });
        if (result.runId) started.push(result.runId);
    }
    return started;
}

/**
 * Whether this person can already write to the repository.
 *
 * Asked of GitHub rather than inferred, and a failure answers no: the whole point
 * is to keep a stranger from starting runs on a public repository, and treating
 * an unreachable API as permission would defeat it on exactly the transient
 * failure somebody could provoke.
 */
async function canWriteToRepo(repoFullName: string, actor: string): Promise<boolean> {
    if (!actor) return false;
    const [owner, repo] = repoFullName.split("/");
    const token = await githubAppInstallationToken(owner).catch(() => null);
    if (!token) return false;
    try {
        const response = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/collaborators/${encodeURIComponent(actor)}/permission`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "polaris",
                    "X-GitHub-Api-Version": "2022-11-28"
                },
                cache: "no-store"
            }
        );
        if (!response.ok) return false;
        const body = (await response.json()) as { permission?: string };
        return body.permission === "write" || body.permission === "admin" || body.permission === "maintain";
    } catch {
        return false;
    }
}

/**
 * Close out a run whose workflow has finished.
 *
 * The runtime reports its own outcome, but a job that was cancelled, killed or
 * never started reports nothing at all. This is the webhook that covers those,
 * and it is why a run does not sit at "running" until the sweep notices it hours
 * later.
 *
 * The id is only recorded once the runtime asks for its run context, which is
 * the *second* thing a job does - it downloads the runtime first. A job that
 * died before that has no id recorded and used to match nothing here, so the run
 * sat at "queued" for the six hours until the stale sweep, while the Actions tab
 * had said "failed" within a minute. The fallback below claims the oldest run on
 * that repository that no job has identified itself as, which is the same rule
 * `runForRepository` uses to hand a job its context.
 */
async function closeOutWorkflowRun(payload: Payload): Promise<string[]> {
    const githubRunId = payload.workflow_run?.id;
    if (!githubRunId || payload.workflow_run?.status !== "completed") return [];

    const open = { state: { in: ["queued", "running"] } };
    const repoFullName = payload.repository?.full_name;
    const run =
        (await prisma.agentRun.findFirst({
            where: { ...open, githubRunId: String(githubRunId) },
            select: { id: true, error: true, failureKind: true }
        })) ??
        (repoFullName
            ? await prisma.agentRun.findFirst({
                  // Only a run that never said which job it was. One that did is
                  // matched above, and claiming it here would close out somebody
                  // else's job.
                  where: { ...open, githubRunId: null, execution: { not: "server" }, repo: { repoFullName } },
                  orderBy: { createdAt: "asc" },
                  select: { id: true, error: true, failureKind: true }
              })
            : null);
    if (!run) return [];

    const conclusion = payload.workflow_run?.conclusion;
    const state = conclusion === "success" ? "succeeded" : conclusion === "cancelled" ? "cancelled" : "failed";
    // A run that got far enough to work out why it failed has already reported
    // it, and that is the reason worth keeping. This webhook only ever knows
    // that the job ended badly, so it fills in for the failures that never got
    // to say anything - a cancelled runner, an image that would not start.
    await finishAgentRun(run.id, {
        state,
        error:
            state !== "failed"
                ? null
                : (run.error ??
                  `The workflow finished as ${conclusion ?? "failed"}. Its log is on the run in GitHub Actions.`),
        // Already recorded by the run's own report, where there was one. Passing
        // it back keeps `finishAgentRun` from clearing it, which would leave the
        // fallback with nothing to decide on.
        failureKind: state === "failed" ? run.failureKind : null
    });

    // Only when the provider refused - `considerFallback` reads the kind and
    // returns immediately for everything else. Best-effort: this is a webhook,
    // and a retry that could not be dispatched must not make GitHub think the
    // delivery failed and send it again.
    if (state === "failed") {
        await considerFallback(run.id).catch((error) =>
            console.error("polaris: fallback dispatch failed:", error)
        );
    }
    return [run.id];
}

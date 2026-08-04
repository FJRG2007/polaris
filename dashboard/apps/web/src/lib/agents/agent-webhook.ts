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
import { finishAgentRun } from "@/lib/agents/agent-run-service";
import { ALWAYS_ON_TRIGGER, type AgentTrigger } from "@polaris/core";
import { agentRepoByFullName } from "@/lib/agents/agent-repo-service";

/** What a webhook boils down to, once the event's shape is out of the way. */
interface Incident {
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

    const mentionText = [payload.comment?.body, payload.review?.body, payload.issue?.body, payload.pull_request?.body]
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
    const payload = params.payload as Payload;
    const repoFullName = payload.repository?.full_name;
    if (!repoFullName) return [];

    // A run's own comments and pushes come back as webhooks. Answering them is how
    // an agent ends up in a conversation with itself.
    if (payload.sender?.type === "Bot" && payload.sender.login?.startsWith(params.appHandle)) return [];

    if (params.event === "workflow_run") return closeOutWorkflowRun(payload);

    const repo = await agentRepoByFullName(repoFullName);
    if (!repo) return [];

    const incident = classify(params.event, payload, params.appHandle);
    if (!incident) return [];

    // Code from a fork is written by whoever opened the pull request. Running an
    // agent against it with the repository's own credentials is the case GitHub
    // warns about, and it is refused here rather than left to a per-repository
    // setting nobody would find.
    if (incident.fromFork) return [];

    const rules = repo.automations.filter((row) => row.trigger === incident.trigger);
    // A mention needs no rule: it is somebody addressing the app directly, and a
    // repository where that did nothing would look installed and be inert.
    const allowed =
        incident.trigger === ALWAYS_ON_TRIGGER
            ? [{ mode: null as string | null }]
            : rules.filter((row) => matches(parseCondition(row.condition), incident));
    if (allowed.length === 0) return [];

    const started: string[] = [];
    for (const rule of allowed) {
        const result = await dispatchRun({
            repo,
            trigger: incident.trigger,
            // The runtime reads a GitHub event payload directly and works out what
            // is being asked from it, so the payload is the prompt. The operator's
            // instructions reach it separately, through run-context.
            prompt: JSON.stringify(params.payload),
            mode: rule.mode,
            issueNumber: incident.issueNumber,
            prNumber: incident.prNumber
        });
        started.push(result.runId);
    }
    return started;
}

/**
 * Close out a run whose workflow has finished.
 *
 * The runtime reports its own outcome, but a job that was cancelled, killed or
 * never started reports nothing at all. This is the webhook that covers those,
 * and it is why a run does not sit at "running" until the sweep notices it hours
 * later.
 */
async function closeOutWorkflowRun(payload: Payload): Promise<string[]> {
    const githubRunId = payload.workflow_run?.id;
    if (!githubRunId || payload.workflow_run?.status !== "completed") return [];
    const run = await prisma.agentRun.findFirst({
        where: { githubRunId: String(githubRunId), state: { in: ["queued", "running"] } },
        select: { id: true }
    });
    if (!run) return [];

    const conclusion = payload.workflow_run?.conclusion;
    const state = conclusion === "success" ? "succeeded" : conclusion === "cancelled" ? "cancelled" : "failed";
    await finishAgentRun(run.id, {
        state,
        error: state === "failed" ? `The workflow finished as ${conclusion ?? "failed"}.` : null
    });
    return [run.id];
}

/**
 * The GitHub App's webhook. Verifies the HMAC signature against the app's webhook
 * secret, then hands the event to whatever it concerns:
 *
 *   - `push` fans out to every application tracking that repository whose branch
 *     and commit-message filters pass (auto-deploy, Vercel-style).
 *   - `workflow_job` tells the runner pools which repository has work waiting, so
 *     a pool serving many repositories puts its next runner where it is needed.
 *
 * Both live here because a GitHub App has exactly one webhook URL - this is not
 * two concerns sharing a route by preference.
 *
 * GitHub must be able to reach this URL, so it only fires for instances with a
 * public domain; LAN-only installs fall back to polling on both counts.
 */

import { z } from "zod";
import { recordWorkflowJob } from "@/lib/runners/runner-demand";
import { handleAgentWebhook } from "@/lib/agents/agent-webhook";
import { branchFromRef, triggerAutoDeploysForPush } from "@/lib/deploy-service";
import { closePullRequestPreview, ensurePullRequestPreview } from "@/lib/deploy/environments";
import { getGithubWebhookSecret, githubAppHandle, verifyWebhookSignature } from "@/lib/github-service";

/** Events that concern the Agents app. Named rather than inferred so an event
 *  GitHub adds later is ignored until somebody decides what it means. */
const AGENT_EVENTS = new Set([
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "check_suite",
    "workflow_run"
]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PushPayload {
    ref?: string;
    deleted?: boolean;
    after?: string;
    repository?: { full_name?: string };
    head_commit?: { id?: string; message?: string };
    /** GitHub carries the file lists inline, capped at 20 commits and 3000 files per
     *  push. Past either cap the payload is truncated, which the watch-path matcher
     *  reads as "could not tell" and deploys on - see `changedPaths`. */
    commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
}

/** Every repository-relative path this push touched, across all of its commits. */
function changedPaths(payload: PushPayload): string[] {
    const paths = (payload.commits ?? []).flatMap((commit) => [
        ...(commit.added ?? []),
        ...(commit.modified ?? []),
        ...(commit.removed ?? [])
    ]);
    return [...new Set(paths)];
}

interface WorkflowJobPayload {
    action?: string;
    repository?: { full_name?: string };
    workflow_job?: { labels?: string[] };
}

/** The fields of a `pull_request` event a preview needs, validated rather than
 *  trusted: a signed payload is GitHub's, but its shape is still its business. */
const pullRequestEvent = z.object({
    action: z.string(),
    number: z.number().int().positive(),
    repository: z.object({ full_name: z.string().min(3).max(200) }),
    pull_request: z.object({
        title: z.string().max(1000).default(""),
        head: z.object({
            ref: z.string().min(1).max(255),
            sha: z.string().regex(/^[0-9a-f]{40}$/i),
            repo: z.object({ full_name: z.string() }).nullable().optional()
        }),
        user: z.object({ login: z.string(), avatar_url: z.string().url() }).partial().nullable().optional()
    })
});

/**
 * Open or close a pull request's preview environments. Opened and reopened
 * create one; closed - merged or not - removes it. A push to the branch is what
 * keeps an open one current, through ordinary auto-deploy, so `synchronize` is
 * deliberately not handled here: it arrives beside the push and would deploy the
 * same commit twice.
 */
async function handlePreviewEvent(payload: unknown): Promise<number> {
    const parsed = pullRequestEvent.safeParse(payload);
    if (!parsed.success) return 0;
    const { action, number, repository, pull_request: pull } = parsed.data;
    if (action === "closed") return closePullRequestPreview(repository.full_name, number);
    if (action !== "opened" && action !== "reopened") return 0;
    return ensurePullRequestPreview({
        repo: repository.full_name,
        number,
        title: pull.title,
        headBranch: pull.head.ref,
        headSha: pull.head.sha,
        headRepo: pull.head.repo?.full_name || null,
        authorName: pull.user?.login ?? null,
        authorAvatarUrl: pull.user?.avatar_url ?? null
    });
}

export async function POST(request: Request): Promise<Response> {
    const event = request.headers.get("x-github-event");
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    const raw = await request.text();

    const secret = await getGithubWebhookSecret();
    if (!secret) return new Response("webhooks are not configured", { status: 503 });
    if (!signature || !verifyWebhookSignature(secret, raw, signature)) {
        return new Response("invalid signature", { status: 401 });
    }

    if (event === "ping") return Response.json({ ok: true });

    // A job queued, started or finished somewhere a pool serves. Only self-hosted
    // jobs matter here, but a pool that carries none of the labels a job asked for
    // is filtered out by the recording itself rather than by guessing here.
    if (event === "workflow_job") {
        let payload: WorkflowJobPayload;
        try {
            payload = JSON.parse(raw) as WorkflowJobPayload;
        } catch {
            return new Response("bad payload", { status: 400 });
        }
        const repoFullName = payload.repository?.full_name;
        if (typeof repoFullName !== "string" || typeof payload.action !== "string") {
            return Response.json({ ok: true });
        }
        const moved = await recordWorkflowJob({
            action: payload.action,
            repoFullName,
            labels: payload.workflow_job?.labels ?? []
        });
        return Response.json({ pools: moved });
    }

    // Everything an agent can be started by, plus the workflow_run that closes a
    // run out when its job was cancelled or killed and reported nothing itself.
    if (event && AGENT_EVENTS.has(event)) {
        let payload: unknown;
        try {
            payload = JSON.parse(raw);
        } catch {
            return new Response("bad payload", { status: 400 });
        }
        // A pull request also opens and closes its preview environments. Both
        // concerns get the event; neither depends on the other going through.
        // Not awaited: cloning and queueing a whole environment can outlast the
        // ten seconds GitHub waits for an answer, and a delivery it gave up on is
        // one it retries.
        if (event === "pull_request") {
            void handlePreviewEvent(payload).catch((error: unknown) => {
                console.error("polaris: a preview environment could not be updated:", error);
            });
        }
        const appHandle = await githubAppHandle();
        if (!appHandle) return Response.json({ ok: true });
        const runs = await handleAgentWebhook({ event, payload, appHandle });
        return Response.json({ runs: runs.length });
    }

    if (event !== "push") return Response.json({ ignored: event });

    let payload: PushPayload;
    try {
        payload = JSON.parse(raw) as PushPayload;
    } catch {
        return new Response("bad payload", { status: 400 });
    }

    const repoFullName = payload.repository?.full_name;
    const ref = payload.ref;
    if (payload.deleted || typeof repoFullName !== "string" || typeof ref !== "string") {
        return Response.json({ ok: true });
    }

    const started = await triggerAutoDeploysForPush({
        repoFullName,
        branch: branchFromRef(ref),
        commitMessage: payload.head_commit?.message ?? "",
        commitSha: payload.head_commit?.id ?? payload.after ?? "",
        changedPaths: changedPaths(payload)
    });
    return Response.json({ deployed: started });
}

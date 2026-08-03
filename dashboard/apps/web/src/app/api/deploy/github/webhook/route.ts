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

import { recordWorkflowJob } from "@/lib/runners/runner-demand";
import { branchFromRef, triggerAutoDeploysForPush } from "@/lib/deploy-service";
import { getGithubWebhookSecret, verifyWebhookSignature } from "@/lib/github-service";

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

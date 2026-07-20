/**
 * GitHub push webhook for auto-deploy (Vercel-style). Verifies the HMAC signature
 * against the GitHub App's webhook secret, then fans a `push` out to every
 * application tracking that repo whose branch and commit-message filters pass.
 *
 * GitHub must be able to reach this URL, so it only fires for instances with a
 * public domain; LAN-only installs use the polling fallback (see the roadmap).
 */

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
        commitSha: payload.head_commit?.id ?? payload.after ?? ""
    });
    return Response.json({ deployed: started });
}

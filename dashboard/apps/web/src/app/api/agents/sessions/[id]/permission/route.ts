/**
 * POST /api/agents/sessions/:id/permission - a Claude session's permission
 * prompt, handed to Polaris to answer.
 *
 * Called by the session's hook script for `PermissionRequest` only, after it
 * has reported the event. Records the prompt, pushes it to the owner's devices
 * with Allow / Deny, and holds the request open until somebody answers or the
 * wait runs out (see session-permissions). The body of the answer is the hook's
 * standard output: a decision, or `{}` for none, which leaves the agent to ask
 * in its own terminal. Same token rule as the events route.
 */

import { sessionForToken } from "@/lib/agents/session-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { isSessionOver } from "@polaris/core";
import { pushPermissionRequest } from "@/lib/agents/agent-notices";
import * as permissions from "@/lib/agents/session-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Held open for the whole wait.
export const maxDuration = 150;

const MAX_BODY = 256 * 1024;

function bearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    return scheme?.toLowerCase() === "bearer" ? rest.join("") : "";
}

function noDecision(): Response {
    return Response.json({}, { status: 200 });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const session = await sessionForToken(bearer(request));
    if (!session || session.id !== id)
        return Response.json(
            { error: (await readerWords("api"))("errors.unauthorized") },
            { status: 401 }
        );
    if (isSessionOver(session.state)) return noDecision();

    const body = await request.text();
    if (body.length > MAX_BODY) return noDecision();
    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        return noDecision();
    }
    const asked = permissions.readPermissionRequest(payload);
    if (!asked) return noDecision();

    try {
        const requestId = await permissions.openPermissionRequest(id, asked);
        void pushPermissionRequest(id, requestId, asked.detail);
        const answer = await permissions.awaitPermission(
            requestId,
            id,
            permissions.PERMISSION_WAIT_MS,
            request.signal
        );
        return Response.json(permissions.hookDecision(answer.status, answer.tool, answer.suggestions));
    } catch (error) {
        console.error(`[agent-session] ${id}: permission prompt could not be relayed:`, error);
        return noDecision();
    }
}

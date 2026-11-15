/**
 * GET / POST /api/agents/sessions/:id/memory - a session carrying its agent's
 * memory of the repository it works in.
 *
 * Called by the script Polaris writes beside a session's checkout
 * (`memorySyncScript`), never by a person: GET before the agent starts, POST
 * after each turn. Authorised by the session's own reporting token, which has
 * to name the same session as the URL. Whose memory and which repository come
 * from the session itself, never from the request, so a session can only ever
 * read and write its own starter's memory of its own repository.
 */

import * as store from "@/lib/agents/repo-memory-store";
import { sessionForToken } from "@/lib/agents/session-service";
import { MEMORY_TOTAL_MAX_BYTES, parseMemoryUpload, restoreBody, uploadAnswer } from "@/lib/agents/session-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The body may be base64 of 2 MB plus the JSON around it. */
const BODY_MAX_BYTES = Math.ceil(MEMORY_TOTAL_MAX_BYTES / 3) * 4 + 64 * 1024;

function bearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    return scheme?.toLowerCase() === "bearer" ? rest.join("") : "";
}

/** Read by a script, not shown to a person. */
function answer(status: number, body = ""): Response {
    return new Response(body, {
        status,
        headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" }
    });
}

async function scopeFor(request: Request, id: string) {
    const session = await sessionForToken(bearer(request));
    if (!session || session.id !== id) return null;
    return store.sessionMemoryScope(id);
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const scope = await scopeFor(request, id);
    if (!scope) return answer(401);
    const { files, updatedAt } = await store.loadRepoMemory(scope.userId, scope.repoFullName);
    return answer(200, restoreBody(files, updatedAt));
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const scope = await scopeFor(request, id);
    if (!scope) return answer(401);

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > BODY_MAX_BYTES) return answer(413);
    const text = await request.text();
    if (text.length > BODY_MAX_BYTES) return answer(413);
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return answer(400);
    }
    const files = parseMemoryUpload(body);
    if (!files) return answer(422);

    try {
        const updatedAt = await store.saveRepoMemory(scope.userId, scope.repoFullName, files);
        return answer(200, uploadAnswer(updatedAt));
    } catch (error) {
        console.error(`[agent-session] ${id}: memory not stored:`, error);
        return answer(500);
    }
}

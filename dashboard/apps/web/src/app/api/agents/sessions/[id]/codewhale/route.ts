/**
 * POST /api/agents/sessions/:id/codewhale - Codewhale's lifecycle webhook.
 *
 * Codewhale reports a session's turns through a webhook named in the managed
 * configuration Polaris writes at boot (`codewhaleSessionConfig`), not through
 * a hook script. Each delivery is checked against its schema and translated
 * into the hook payload the events route takes, then applied the same way.
 *
 * The credential is the session's own reporting token, as on the events route.
 * Codewhale's configuration takes nothing but a URL, so the token arrives in
 * the query string; a bearer header is taken too.
 */

import { readerWords } from "@/lib/i18n/reader-words";
import { sessionForToken } from "@/lib/agents/session-service";
import { hookBearer, ingestHookPayload } from "@/lib/agents/session-hook-ingest";
import { codewhaleHookPayload, codewhaleLifecycleSchema, codewhaleSequence } from "@/lib/agents/codewhale-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A lifecycle envelope is a few hundred bytes; anything near this is not one. */
const MAX_BODY = 64 * 1024;

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const token = hookBearer(request) || (new URL(request.url).searchParams.get("token") ?? "");
    const session = await sessionForToken(token);
    // The token names a session and so does the URL; they have to agree.
    if (!session || session.id !== id || session.cli !== "codewhale")
        return Response.json({ error: (await readerWords("api"))("errors.unauthorized") }, { status: 401 });

    const body = await request.text();
    let raw: unknown = null;
    try {
        raw = body.length <= MAX_BODY ? JSON.parse(body) : null;
    } catch {
        raw = null;
    }
    const parsed = codewhaleLifecycleSchema.safeParse(raw);
    if (!parsed.success) return Response.json({ error: (await readerWords("api"))("errors.invalidRequest") }, { status: 400 });

    const payload = codewhaleHookPayload(parsed.data);
    if (payload) await ingestHookPayload(session, payload, codewhaleSequence(parsed.data));
    return Response.json({ ok: true }, { status: 200 });
}

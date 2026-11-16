/**
 * The person's custom tools inside a Code session (`lib/polar/custom-tools/
 * session-tools.ts`), read by the session's tool server and the native
 * engine with the session's own token.
 *
 * GET lists them. POST `{ name, arguments }` checks one call, asks the person
 * when the tool asks, and answers `{ command }` for the sandbox to run, or
 * `{ refusal }` in words the agent reads. Held open while a prompt waits.
 */

import { z } from "zod";
import { hookBearer } from "@/lib/agents/session-hook-ingest";
import { sessionForToken } from "@/lib/agents/session-service";
import * as sessionTools from "@/lib/polar/custom-tools/session-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Held open for a permission prompt.
export const maxDuration = 150;

const MAX_BODY = 256 * 1024;

const callSchema = z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    arguments: z.record(z.string(), z.unknown()).default({})
});

function json(status: number, body: unknown): Response {
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function sessionOf(request: Request, id: string): Promise<sessionTools.ToolSession | null> {
    const session = await sessionForToken(hookBearer(request));
    if (!session || session.id !== id) return null;
    return sessionTools.toolSession(id);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const session = await sessionOf(request, id);
    if (!session) return json(401, { refusal: "Unauthorized." });
    try {
        return json(200, await sessionTools.listSessionTools(session));
    } catch (error) {
        console.error(`[agent-session] ${id}: custom tools not listed:`, error);
        return json(500, { ok: false, refusal: "Polaris could not list the custom tools. Try again." });
    }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const session = await sessionOf(request, id);
    if (!session) return json(401, { refusal: "Unauthorized." });
    const body = await request.text();
    if (body.length > MAX_BODY) return json(413, { ok: false, refusal: "That input is too large." });
    let raw: unknown;
    try {
        raw = JSON.parse(body);
    } catch {
        return json(400, { ok: false, refusal: "That call could not be read." });
    }
    const call = callSchema.safeParse(raw);
    if (!call.success) return json(400, { ok: false, refusal: "That call could not be read." });
    try {
        return json(200, await sessionTools.prepareSessionCall(session, call.data.name, call.data.arguments, request.signal));
    } catch (error) {
        console.error(`[agent-session] ${id}: custom tool ${call.data.name} not prepared:`, error);
        return json(500, { ok: false, refusal: "Polaris could not prepare that tool. Try again." });
    }
}

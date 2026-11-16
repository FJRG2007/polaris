/**
 * POST /api/polar/voice/realtime/tool - one tool call of a realtime voice call
 * on a Code session, run with the voice delegator's tools
 * (`runRealtimeTool`), which act through the same Code functions and access
 * checks as the screen. Answers `RealtimeToolAnswer`: the output for the
 * model, and the session to show or the work sent, as a delegator turn does.
 */

import { NextResponse } from "next/server";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarCodeThread } from "@/lib/polar/code";
import { delegateDeps } from "@/lib/polar/voice-deps";
import { runRealtimeTool } from "@/lib/polar/voice-realtime";
import { polarCaller } from "@/lib/polar/access";
import { realtimeToolBodySchema } from "@/lib/polar/voice-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The arguments and the call's tail, with room to spare. */
const BODY_MAX = 32 * 1024;

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-voice-realtime-tool:${user.id}`, 60, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = realtimeToolBodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);
    const input = body.data;

    // The session on screen must be the person's to read, as for a delegator turn.
    if (!(await polarCodeThread(user, input.sessionId))) return refuse("not_found", 404);

    try {
        const answer = await runRealtimeTool({
            deps: delegateDeps(user),
            viewed: input.sessionId,
            name: input.name,
            arguments: input.arguments,
            tail: input.tail,
            explained: input.explained,
            signal: request.signal
        });
        return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        console.warn("polar: a realtime tool call failed", error instanceof Error ? error.name : "error");
        return refuse("failed", 502);
    }
}

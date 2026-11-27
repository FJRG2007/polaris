/**
 * POST /api/polar/voice/live/turn - one exchange of a live voice call, what
 * the person said and what Polar answered, saved into the chat as a question
 * and its reply, the way a typed turn is. The thread is made if the call
 * started it; another person's answers as one that does not exist.
 */

import type { UIMessage } from "ai";
import { NextResponse } from "next/server";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarCaller } from "@/lib/polar/access";
import { liveTurnBodySchema } from "@/lib/polar/live-voice";
import { ensurePolarThread, savePolarMessages } from "@/lib/polar/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_MAX = 24 * 1024;

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-voice-live-turn:${user.id}`, 120, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = liveTurnBodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);
    const { threadId, parentId, temporary, projectId, user: said, assistant } = body.data;

    const owned = await ensurePolarThread(user.id, threadId, said.text, null, projectId, temporary);
    if (!owned) return refuse("not_found", 404);
    const messages: UIMessage[] = [
        { id: said.id, role: "user", parts: [{ type: "text", text: said.text }] },
        { id: assistant.id, role: "assistant", parts: [{ type: "text", text: assistant.text }] }
    ];
    try {
        await savePolarMessages(user.id, threadId, messages, (index) => (index === 0 ? parentId : said.id));
    } catch (error) {
        console.error("polar: could not save a live voice turn", error instanceof Error ? error.name : "error");
        return refuse("failed", 500);
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

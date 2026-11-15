/**
 * GET /api/polar/subagents/[id] - one of the caller's subagents with its whole
 * transcript. POST - stop it, or send it a message it reads before its next
 * step. Both answer 404 for a subagent that is not the caller's.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { readCappedBody } from "@/lib/request-body";
import { subagentDetail } from "@/lib/polar/subagents/store";
import { steerSubagent, stopSubagent } from "@/lib/polar/subagents/registry";
import { subagentActionSchema } from "@/lib/polar/subagents/shared";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const BODY_MAX = 16 * 1024;

type Params = { params: Promise<{ id: string }> };

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return refuse("invalid", 400);
    const detail = await subagentDetail(user.id, id.data);
    if (!detail) return refuse("not_found", 404);
    return NextResponse.json({ subagent: detail }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return refuse("invalid", 400);
    const limited = await rateLimit(`polar-subagent:${user.id}`, 60, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);
    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const action = subagentActionSchema.safeParse(raw);
    if (!action.success) return refuse("invalid", 400);
    const done =
        action.data.action === "stop"
            ? stopSubagent(user.id, id.data)
            : steerSubagent(user.id, id.data, action.data.text);
    // Not running (ended, or not the caller's): the screen offers a resume.
    if (!done) return refuse("not_running", 409);
    return NextResponse.json({ ok: true });
}

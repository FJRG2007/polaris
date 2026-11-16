/**
 * POST /api/polar/voice/realtime - opens a realtime voice call on a Code
 * session: a client secret minted on the person's own OpenAI key
 * (`lib/polar/voice-realtime.ts`), answered as `RealtimeGrant`. The key itself
 * never leaves the server. 409 `no_key` means the person holds no OpenAI key
 * of their own (the deployment's is never used for this), 502 `failed` that
 * OpenAI did not mint one.
 */

import { NextResponse } from "next/server";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarCodeThread } from "@/lib/polar/code";
import { mintRealtimeSecret } from "@/lib/polar/voice-realtime";
import { realtimeBodySchema } from "@/lib/polar/voice-call";
import { polarAccessFor, polarCaller, polarCredentialFor, polarKeySources } from "@/lib/polar/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_MAX = 4 * 1024;

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-voice-realtime:${user.id}`, 10, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = realtimeBodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);

    const viewed = await polarCodeThread(user, body.data.sessionId);
    if (!viewed) return refuse("not_found", 404);

    const access = await polarAccessFor(user.id);
    if ((await polarKeySources(user.id, access)).get("openai") !== "own") return refuse("no_key", 409);
    const credential = await polarCredentialFor(user.id, "openai", "own", access);
    if (!credential || credential.source !== "own" || credential.baseUrl) return refuse("no_key", 409);

    const grant = await mintRealtimeSecret({
        apiKey: credential.secret,
        viewed: { id: viewed.session.id, title: viewed.session.title },
        lang: body.data.lang
    });
    if (!grant) return refuse("failed", 502);
    return NextResponse.json(grant, { headers: { "Cache-Control": "no-store" } });
}

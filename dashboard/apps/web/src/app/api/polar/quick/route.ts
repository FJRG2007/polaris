/**
 * POST /api/polar/quick - a Quick AI answer for the search panel, streamed
 * (`lib/polar/quick-ask.ts`): Polar's model, no tools, nothing stored. The
 * request's signal goes to the model call, so closing the panel ends it.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { quickAskRequestSchema } from "@/lib/polar/quick-ask";
import { streamQuickAnswer } from "@/lib/polar/quick-ask-service";

export const dynamic = "force-dynamic";

/** Biggest request accepted: forty turns of text. */
const BODY_MAX = 1024 * 1024;

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    // An administrator looking through somebody else's eyes is not that person.
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-quick:${user.id}`, 30, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);
    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = quickAskRequestSchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);
    const answer = await streamQuickAnswer({ userId: user.id, ...body.data, signal: request.signal });
    if (answer instanceof Response) return answer;
    if (typeof answer === "string") return refuse(answer, 409);
    return NextResponse.json({ error: "usage_limit", ...answer.limit }, { status: 429 });
}

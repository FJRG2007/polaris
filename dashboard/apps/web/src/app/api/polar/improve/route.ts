/**
 * POST /api/polar/improve - a draft rewritten before it is sent: a prompt made
 * clearer, or an email body corrected (`lib/polar/improve-text.ts`). Answers
 * `{ text }`, or `{ error }` naming why nothing came back.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarAccessFor, polarCaller } from "@/lib/polar/access";
import { improveText } from "@/lib/polar/improve-text";
import { IMPROVE_PURPOSES, IMPROVE_TEXT_MAX } from "@/lib/polar/improve-draft";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
    text: z.string().trim().min(1).max(IMPROVE_TEXT_MAX),
    purpose: z.enum(IMPROVE_PURPOSES),
    subject: z.string().trim().max(998).nullish()
});

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-improve:${user.id}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const access = await polarAccessFor(user.id);
    const result = await improveText(user.id, access, parsed.data);
    if ("refusal" in result) {
        const status = result.refusal === "failed" ? 502 : 409;
        return NextResponse.json({ error: result.refusal }, { status });
    }
    return NextResponse.json({ text: result.text }, { headers: { "Cache-Control": "no-store" } });
}

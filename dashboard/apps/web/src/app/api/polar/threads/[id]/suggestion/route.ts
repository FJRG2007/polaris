/**
 * GET /api/polar/threads/:id/suggestion?after=<answer id> - the suggested next
 * message for that answer, once the helper model has written it (or given
 * up). The screen asks once, after the answer has finished, and shows it
 * greyed in the empty composer. `{ suggestion: null }` is the ordinary "none":
 * switched off, an older answer, another person's thread, or a failure.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { settledPolarSuggestion } from "@/lib/polar/suggestions";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const querySchema = z.object({ after: z.string().trim().min(1).max(64) });

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    const query = querySchema.safeParse({
        after: new URL(request.url).searchParams.get("after") ?? undefined
    });
    if (!id.success || !query.success) {
        return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    const limited = await rateLimit(`polar-suggestion:${user.id}`, 60, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const suggestion = await settledPolarSuggestion(user.id, id.data, query.data.after);
    return NextResponse.json({ suggestion }, { headers: { "Cache-Control": "no-store" } });
}

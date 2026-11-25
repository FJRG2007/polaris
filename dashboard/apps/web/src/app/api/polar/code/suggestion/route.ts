/**
 * GET /api/polar/code/suggestion?sessionId=<id>&after=<answer id> - the
 * suggested next message after a Code session's turn (`code-suggestion.ts`).
 * The page asks once the turn has ended; `{ suggestion: null }` is the
 * ordinary "none": switched off, a turn still running or past, a session the
 * caller cannot read, or a failure.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { PLAIN_TURN } from "@/lib/polar/automatic";
import { polarCodeThread } from "@/lib/polar/code";
import { automaticChoice } from "@/lib/polar/shared";
import { rateLimit } from "@/lib/rate-limit-service";
import { resolvePolarModel } from "@/lib/polar/models";
import { polarPreferences } from "@/lib/polar/preferences";
import { polarHelperModel } from "@/lib/polar/helper-model";
import { codePolarSuggestion } from "@/lib/polar/suggestions";
import { codeSuggestionTurn } from "@/lib/polar/code-suggestion";
import { polarAccessFor, polarCaller } from "@/lib/polar/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    sessionId: z.string().trim().uuid(),
    after: z.string().trim().min(1).max(256)
});

const NONE = () => NextResponse.json({ suggestion: null }, { headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    // Someone viewing as another person never spends that person's helper.
    if (user.viewingAs) return NONE();
    const limited = await rateLimit(`polar-code-suggestion:${user.id}`, 60, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const settings = await polarPreferences(user.id).catch(() => null);
    if (!settings?.codeSuggestions) return NONE();
    const thread = await polarCodeThread(user, query.data.sessionId).catch(() => null);
    if (!thread) return NONE();
    const turn = codeSuggestionTurn(thread.entries, thread.session, thread.permission !== null);
    if (!turn || turn.answerId !== query.data.after) return NONE();
    const suggestion = await codePolarSuggestion(user.id, thread.session.id, turn.answerId, turn, async () => {
        const access = await polarAccessFor(user.id);
        const fallback = await resolvePolarModel(user.id, automaticChoice("fast"), PLAIN_TURN, access);
        if (typeof fallback === "string") return null;
        return polarHelperModel(user.id, fallback, settings.helperModel, access);
    });
    return NextResponse.json({ suggestion }, { headers: { "Cache-Control": "no-store" } });
}

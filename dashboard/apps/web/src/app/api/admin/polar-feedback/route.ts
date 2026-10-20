/**
 * GET /api/admin/polar-feedback - how people marked Polar's answers over the
 * last 30 days and the newest bad marks with what they said. Admin-only: it
 * names people. The answers themselves are never part of it.
 */

import { NextResponse } from "next/server";
import { backgroundUser } from "@/lib/session";
import { readerWords } from "@/lib/i18n/reader-words";
import { polarFeedbackSummary } from "@/lib/polar/answer-feedback-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await backgroundUser();
    if (!user?.isAdmin) {
        return NextResponse.json(
            { error: (await readerWords("api"))("errors.forbidden") },
            { status: 403 }
        );
    }
    return NextResponse.json(await polarFeedbackSummary());
}

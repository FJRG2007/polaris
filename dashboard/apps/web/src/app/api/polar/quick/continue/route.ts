/**
 * POST /api/polar/quick/continue - "Continue in chat" from Quick AI: the
 * exchange the search panel holds, saved as a new chat of the caller's
 * (`importThread`, words only), so the conversation goes on in Polar.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { importThread } from "@/lib/polar/import";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { quickContinueSchema } from "@/lib/polar/quick-ask";

export const dynamic = "force-dynamic";

/** Longest title taken from the first question. */
const TITLE_CHARS = 80;

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const limited = await rateLimit(`polar-quick-continue:${user.id}`, 20, 10 * 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = quickContinueSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const turns = body.data.turns.filter((turn) => turn.text.trim().length > 0);
    const first = turns.find((turn) => turn.role === "user")?.text ?? "";
    const t = await getTranslations("polar");
    const id = await importThread(
        user.id,
        {
            title: first.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS),
            messages: turns.map((turn) => ({ role: turn.role, parts: [{ type: "text", text: turn.text }] }))
        },
        t("settings.data.importedTitle")
    );
    return NextResponse.json({ id });
}

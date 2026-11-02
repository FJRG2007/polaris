import { NextResponse } from "next/server";
import { chatLists } from "@/lib/chat/chat-lists";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The rail's lists.
 *
 * A route and not a server action on purpose: the router runs actions one at a
 * time with no timeout, so one that never settled left the rail a skeleton until
 * the page was reloaded. A plain request can be timed out and tried again.
 * See docs/bugs/the-chat-list-stayed-a-skeleton-until-reload.md.
 */
export async function GET(): Promise<Response> {
    const session = await backgroundUser();
    // i18n-ignore: a status body the rail never shows
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "chat.use"))) {
        // i18n-ignore: a status body the rail never shows
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(await chatLists(session), {
        headers: { "Cache-Control": "no-store" }
    });
}

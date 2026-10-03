/**
 * A call this account is already in, on some other device.
 *
 * Asked by a browser that is not in one, so it can offer to take it over rather
 * than leave somebody looking at a phone that says nothing while their computer
 * holds a live microphone in another room. It answers about the account rather
 * than about a conversation, which is what makes it safe to ask from anywhere:
 * the only thing it can tell you is where your own seat is.
 *
 * A route rather than a server action, because it is asked from the frame of
 * every screen the moment that screen is drawn. A server action is a router
 * action: while one is in flight the App Router is waiting on it, and on a
 * first visit that is still hydrating - a screen that redirected inside its
 * loading boundary - the React Next 15 ships commits a half-rendered router and
 * the tab dies with "Rendered more hooks" (#310). A plain request is invisible to
 * the router. It is also a read, and reads are what routes are for.
 *
 * Polled on its own, so it does not count as activity: a tab left open must not
 * keep the inactivity lock from closing.
 */

import { can } from "@polaris/auth";
import { NextResponse } from "next/server";
import * as meetings from "@/lib/chat/meetings";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await backgroundUser();
    // i18n-ignore: a status body the card never shows
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Nothing rather than a refusal for an account that may not call at all,
    // so the card is simply absent instead of every screen having to know why.
    if (!(await sessionCan(user, "chat.use")) || !(await can(user.id, "chat.call")))
        return NextResponse.json({ call: null });
    return NextResponse.json({ call: await meetings.callElsewhere(user.id) });
}

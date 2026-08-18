import { NextResponse } from "next/server";
import { unreadTotal } from "@/lib/chat/chat-service";
import { resolveSession, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How much of Chat is waiting for whoever is asking.
 *
 * Read from every screen in Polaris rather than only from Chat, which is the
 * point of it: the badge on the tab icon and on the Chat entry has to be right
 * for somebody who spends the day in Deploy and never opens the app the count
 * lives in. Asked when the live channel says something moved, not on a timer.
 *
 * Zero rather than an error for an account that may not be in Chat at all, so
 * the badge is simply absent instead of the layout having to know why.
 */
export async function GET(): Promise<Response> {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "chat.use"))) {
        return NextResponse.json({ messages: 0, conversations: 0 });
    }
    return NextResponse.json(await unreadTotal({ id: session.id }));
}

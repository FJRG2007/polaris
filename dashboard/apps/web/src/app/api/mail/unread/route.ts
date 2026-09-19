import { NextResponse } from "next/server";
import { resolveSession, sessionCan } from "@/lib/session";
import { mailWaitingOnShelf, NO_MAIL_WAITING } from "@/lib/shelf-counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How much mail is waiting for whoever is asking.
 *
 * Read from every screen in Polaris rather than only from Mail, which is the
 * point of it: the badge on the tab icon and on the Mail entry has to be right
 * for somebody who spends the day in Deploy and never opens the app the count
 * lives in. Asked when the live channel says a mailbox moved, not on a timer.
 *
 * The open shelf's mailboxes only, as Mail lists them. A company mailbox's
 * unread mail counted on somebody's personal shelf was a badge that opening
 * Mail there could not explain.
 *
 * Zero rather than an error for an account with no mail, so the badge is simply
 * absent instead of the layout having to know why.
 */
export async function GET(): Promise<Response> {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "mail.use"))) return NextResponse.json(NO_MAIL_WAITING);
    return NextResponse.json(await mailWaitingOnShelf(session.id));
}

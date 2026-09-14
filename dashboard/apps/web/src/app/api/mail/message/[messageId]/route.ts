/**
 * One message's words, for the pane that draws them.
 *
 * An endpoint rather than a server action, and the difference is the whole
 * reason this file exists. A server action is a POST the router owns: the client
 * runs them one at a time, so opening a message queued behind whatever else had
 * just been asked for - the prefetch of the row somebody passed over, the flag
 * from the message they read a second ago - and the answer carries a re-render
 * of the whole route with it. None of that is anything to do with reading a
 * message, and all of it was spent between the click and the words.
 *
 * As a GET it is one request that starts immediately, answers with the message
 * and nothing else, and can be asked for early: the same address the reading
 * pane opens is the one the hover prefetch warms, so a message somebody pointed
 * at before pressing is already in this tab when they press.
 *
 * Never cached by anything in between. A message is one person's, and a shared
 * cache in front of this would be one reader's mail served to another.
 */

import { NextResponse } from "next/server";
import { openMessage } from "@/lib/mailbox/open";
import { apiPermission } from "@/lib/api-session";
import { MailAccessError } from "@/lib/mailbox/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ messageId: string }> }
): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const { messageId } = await params;
    try {
        const opened = await openMessage(user.id, messageId);
        if (!opened) {
            return NextResponse.json(
                { error: "That message is no longer here." },
                { status: 404, headers: { "cache-control": "private, no-store" } }
            );
        }
        return NextResponse.json(opened, {
            headers: { "cache-control": "private, no-store" }
        });
    } catch (caught) {
        // A message of somebody else's answers exactly as one that is not there.
        if (caught instanceof MailAccessError) {
            return NextResponse.json(
                { error: "That message is no longer here." },
                { status: 404, headers: { "cache-control": "private, no-store" } }
            );
        }
        // Everything else names a host or a credential, so it is logged and not
        // published: the pane says the message could not be opened.
        console.warn("mail open failed", messageId, caught);
        return NextResponse.json(
            { error: "That message could not be opened." },
            { status: 502, headers: { "cache-control": "private, no-store" } }
        );
    }
}

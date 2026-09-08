/**
 * One conversation, for the pane beside the list.
 *
 * Fetched rather than rendered into the page for the same reason the list is:
 * opening a conversation used to take the whole screen with it, because the
 * address changed and nothing came back until every message of it had been
 * read. Now the row highlights at once, the pane draws its shape, and the
 * messages land in it.
 *
 * A conversation that is not this reader's answers exactly as one that does not
 * exist - see `readThreadView`, which narrows by the reader. The screen shows a
 * list with nothing open beside it either way, and never a not-found page: a
 * link to a conversation that has since been filed deserves the mailbox it was
 * in rather than a dead end.
 */

import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { readThreadView } from "@/lib/mailbox/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ threadId: string }> }
): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const { threadId } = await params;
    const found = await readThreadView(user.id, threadId);
    return NextResponse.json(found, { headers: { "cache-control": "private, no-store" } });
}

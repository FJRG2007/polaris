/**
 * The rail's own data, without re-rendering the screen it sits beside.
 *
 * Mail's layout resolves the mailboxes, their folders and the unread counts on
 * the server, so the only way to move a number in the rail was `router.refresh()`
 * - which re-runs the whole signed-in frame and the page inside it. A mailbox
 * syncing announces itself several times a minute, and while the router is
 * fetching it defers what somebody clicks next: the reported symptom was links
 * and buttons doing nothing, or doing it a second later, for as long as somebody
 * had Mail open.
 *
 * So the live channel asks for this instead. It is three small queries against
 * rows Polaris already holds - no mail server is touched - and it changes nothing
 * outside the rail.
 *
 * Node runtime for Prisma, and never cached.
 */

import { NextResponse } from "next/server";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listAccountViews } from "@/lib/mailbox/accounts";
import { resolveSession, sessionCan } from "@/lib/session";
import { listFolders, unreadCounts } from "@/lib/mailbox/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "mail.use"))) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // The shelf being worked from, exactly as the layout reads it: a rail holds
    // somebody's own mailboxes or an organization's, never the two at once.
    const shelfOrgId = await scopeOrgIdFor(session.id);
    const [accounts, folders, unread] = await Promise.all([
        listAccountViews(session.id, shelfOrgId),
        listFolders(session.id, shelfOrgId),
        unreadCounts(session.id, shelfOrgId)
    ]);
    return NextResponse.json({ accounts, folders, unread });
}

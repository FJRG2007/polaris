/**
 * A page of conversations.
 *
 * Mail's lists are fetched here rather than rendered into the page, which is the
 * whole reason switching between Inbox and Starred is instant. Rendering them on
 * the server meant every one of those presses was a database query standing
 * between the press and the first pixel: nothing at all was on screen - not the
 * toolbar, not the tabs, not the rail - until the last row had been counted. It
 * is also what every mail client does, for the same reason.
 *
 * The narrowing arrives as a query string so the browser can cache the answer
 * against it, and is read back through the one module that writes it. What is
 * allowed is still decided here: `mailPageSchema` checks the shape, and
 * `listThreads` narrows to this reader's own mailboxes whatever the query says.
 *
 * Never cached by anything in between. A mailbox is per-person and changes on
 * its own, and a shared cache in front of this would be one reader's mail served
 * to another.
 */

import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { apiPermission } from "@/lib/api-session";
import { readMailPageParams } from "@/lib/mailbox/page-params";
import { EMPTY_QUERY, listThreads } from "@/lib/mailbox/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const asked = new URL(request.url).searchParams;
    const parsed = core.mailPageSchema.safeParse(readMailPageParams(asked));
    // An address somebody edited into something the schema will not have. The
    // list says it could not be loaded rather than showing an empty mailbox,
    // which reads as "you have no mail".
    if (!parsed.success) {
        return NextResponse.json({ error: "That list could not be loaded." }, { status: 400 });
    }

    const { cursor, query, ...narrow } = parsed.data;
    // The shelf comes from the cookie, never from the query string: the address
    // says which list, and the switch in the header says whose.
    const page = await listThreads(
        user.id,
        { ...EMPTY_QUERY, ...narrow, query, cursor },
        await scopeOrgIdFor(user.id)
    );
    return NextResponse.json(page, {
        headers: { "cache-control": "private, no-store" }
    });
}

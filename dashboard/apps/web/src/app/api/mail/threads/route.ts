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
import { mailShelfFor } from "@/lib/mailbox/shelf";
import { apiPermission } from "@/lib/api-session";
import { readMailPageParams } from "@/lib/mailbox/page-params";
import { olderOnServer, reachForOlder } from "@/lib/mailbox/sync";
import { reachesForOlder } from "@/lib/mailbox/folder-window";
import { EMPTY_QUERY, listThreads } from "@/lib/mailbox/views";
import { everyAccountId, unifiedAccountIds } from "@/lib/mailbox/access";
import { readerWords } from "@/lib/i18n/reader-words";

/**
 * The cursor of a page that ended on what is held here while the server holds
 * more. It reads as no cursor to the list (`mailCursorWhere`), so asking with it
 * lists from the top again - the rows already drawn are dropped by the list -
 * after the server has been asked for the next older batch.
 */
const OLDER_ON_SERVER = "older";

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
        return NextResponse.json(
            { error: (await readerWords("api"))("errors.listLoadFailed") },
            { status: 400 }
        );
    }

    const { cursor, query, ...narrow } = parsed.data;
    // The shelf comes from the cookie, never from the query string: the address
    // says which list, and the switch in the header says whose.
    const shelf = await mailShelfFor(user.id);
    const list = { ...EMPTY_QUERY, ...narrow, query, cursor };
    let page = await listThreads(user.id, list, shelf);
    // The end of what is held here: the sync keeps only a folder's newest
    // messages, so the scroll reaching the bottom is what brings down the next
    // older page from the server - and then the same page again, with it in.
    //
    // Never for the first page. Going to the server waits on the mailbox's own
    // sync pass and then on a connection of its own, and a Trash holding a few
    // rows here sat on its skeleton for twenty seconds every time it was opened.
    // The first page answers with what is held and a cursor saying there is
    // more, and the list's own bottom-of-the-list fetch - already on screen for
    // a short list - is what goes and gets it.
    if (page.cursor === "" && reachesForOlder(list)) {
        const accountIds = narrow.accountId
            ? (await everyAccountId(user.id)).filter((id) => id === narrow.accountId)
            : await unifiedAccountIds(user.id, shelf);
        if (cursor === "") {
            if (await olderOnServer(accountIds, narrow)) page = { ...page, cursor: OLDER_ON_SERVER };
        } else if (await reachForOlder(accountIds, narrow)) {
            page = await listThreads(user.id, list, shelf);
            if (page.cursor === "" && (await olderOnServer(accountIds, narrow)))
                page = { ...page, cursor: OLDER_ON_SERVER };
        }
    }
    return NextResponse.json(page, {
        headers: { "cache-control": "private, no-store" }
    });
}

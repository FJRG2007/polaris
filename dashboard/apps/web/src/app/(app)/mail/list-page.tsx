/**
 * The one server component every list route renders.
 *
 * Seven routes show a list of conversations - the merged views, one mailbox, one
 * folder, one label - and they differ only in how the query is narrowed and what
 * the empty state should say. Writing that seven times would be seven places for
 * the search parameters, the cursor and the open conversation to be handled
 * slightly differently, which is how a back button starts landing on the wrong
 * page.
 *
 * **It reads the address and nothing else.** No conversations are fetched here,
 * and that is the difference between Mail feeling like an application and
 * feeling like a website. Rendering the list on the server meant every press on
 * Starred or Inbox was a database query standing in front of the first pixel:
 * the rail, the toolbar, the tabs and the search box all waited on the last row
 * being counted, and the screen showed the previous one until it was. Now this
 * settles what list is being asked for - which is reading a path and a handful
 * of search parameters - and the browser fetches it, drawing what it already
 * holds while it does. Every mail client that feels fast works this way.
 *
 * What is left here is what the address means, which is genuinely the server's:
 * whether this person has any mailboxes at all, and how they have said they like
 * to read.
 */

import * as core from "@polaris/core";
import { MailOnboarding } from "./onboarding";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { requirePermission } from "@/lib/session";
import { ownedAccountIds } from "@/lib/mailbox/access";
import { readMailPreferences } from "@/lib/mailbox/prefs";
import { MailView, type MailViewContext } from "./mail-view";
import type { MailPageNarrow } from "@/lib/mailbox/page-params";
import { mailConnectOptions } from "@/lib/mailbox/connect-options";
import { EMPTY_QUERY, type MailListQuery } from "@/lib/mailbox/views";

/** What a route knows about itself, beyond the query it narrows to. */
export interface ListRoute {
    readonly narrow: Partial<MailListQuery>;
    readonly context: MailViewContext;
    /** Whether this list is worth sorting into tabs. An inbox is; Sent is not. */
    readonly categorised?: boolean;
}

export type MailSearchParams = Promise<{
    q?: string;
    open?: string;
    before?: string;
    tab?: string;
    /** Which of the list is shown: unread, read, starred, with attachments. */
    filter?: string;
    /** Which way round it is read. */
    sort?: string;
}>;

/** Whether what the address says is one of the tabs. Anything else is somebody
 *  editing a URL, and the answer to that is the whole list. */
function isCategory(value: string | undefined): value is core.MailCategory {
    return Boolean(value) && (core.MAIL_CATEGORIES as readonly string[]).includes(value ?? "");
}

/** The narrowing a route has already done for itself, which the buttons above
 *  the list then leave alone. */
function fixedFilter(narrow: Partial<MailListQuery>): core.MailFilter | "" {
    if (narrow.unreadOnly) return "unread";
    if (narrow.starredOnly) return "starred";
    if (narrow.withAttachments) return "attachments";
    return "";
}

export async function MailListPage({
    route,
    searchParams
}: {
    route: ListRoute;
    searchParams: MailSearchParams;
}) {
    const user = await requirePermission("mail.use");
    // Together rather than one after the other. Both are single indexed reads,
    // and both stand between a press on the rail and this screen rendering at
    // all - which is the whole budget this route has left now that the
    // conversations are fetched by the browser.
    const [params, accounts, preferences] = await Promise.all([
        searchParams,
        ownedAccountIds(user.id, await scopeOrgIdFor(user.id)),
        readMailPreferences(user.id)
    ]);

    // Nothing connected yet. Every list route lands here rather than drawing an
    // empty inbox, because an empty screen with a sentence in it reads as broken
    // and this reads as the first step.
    if (accounts.length === 0) {
        const options = await mailConnectOptions(user.id);
        return (
            <MailOnboarding
                links={options.links}
                googleReady={options.googleReady}
                microsoftReady={options.microsoftReady}
                publicAddress={options.publicAddress}
                canSetDomain={user.isAdmin}
            />
        );
    }

    // The filter and the order are read off the address like everything else
    // here, so a narrowed list is a page somebody can go back to, bookmark, and
    // open in a second tab beside the first. A route that narrows to one of these
    // itself - Starred, Unread - keeps its own narrowing whatever the buttons
    // say: the screen is that list.
    const filter = core.readMailFilter(params.filter);
    // The reader's own order is what a list opens as; the address still wins for
    // the page it names, because a sorted list is a link somebody was sent.
    const sort = core.readMailSort(params.sort, preferences.sort);
    const query: MailListQuery = {
        ...EMPTY_QUERY,
        unreadOnly: filter === "unread",
        readOnly: filter === "read",
        starredOnly: filter === "starred",
        withAttachments: filter === "attachments",
        ...route.narrow,
        sort,
        query: params.q?.trim() ?? "",
        // Only where the route offers tabs at all, which is the inbox. Sent,
        // Drafts and the trash are not a mixture of things to sort.
        category: route.categorised && isCategory(params.tab) ? params.tab : "",
        cursor: ""
    };

    const searched = Boolean(query.query);
    return (
        <MailView
            // What this list IS, which is the whole of what the browser needs to
            // go and get it - and to know that the copy it is already holding is
            // a copy of this list rather than of another one.
            page={narrowOf(query)}
            openThreadId={params.open ?? ""}
            categorised={Boolean(route.categorised) && !searched}
            // How this person reads: when an opened message stops being unread,
            // and where the screen goes after one is filed. Both were constants
            // in the client until there was a screen to answer them on.
            preferences={preferences}
            // A route that IS one of the filters does not offer it again: the
            // Starred screen with a "Starred" button on it reads as a switch that
            // does nothing, because it is one.
            //
            // The tab, the filter and the order are NOT passed: the screen reads
            // them off the address itself, because it changes them there without
            // asking for this page again. What is passed is the list they start
            // from.
            fixedFilter={fixedFilter(route.narrow)}
            context={
                searched
                    ? {
                          ...route.context,
                          title: `Search: ${query.query}`,
                          emptyTitle: "Nothing matched",
                          emptyBody:
                              "Polaris searches the mail it has already fetched, which is the newest few hundred messages of each folder. Anything older is still on the mail server."
                      }
                    : route.context
            }
        />
    );
}

/** The part of a query that identifies the list, which is all of it bar where a
 *  page ended and how the database is asked. */
function narrowOf(query: MailListQuery): MailPageNarrow {
    return {
        accountId: query.accountId,
        folderId: query.folderId,
        role: query.role,
        labelId: query.labelId,
        unreadOnly: query.unreadOnly,
        readOnly: query.readOnly,
        starredOnly: query.starredOnly,
        snoozedOnly: query.snoozedOnly,
        withAttachments: query.withAttachments,
        category: query.category,
        sort: query.sort,
        query: query.query
    };
}

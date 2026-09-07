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
 * Everything a list route can carry is read here: the search box, the cursor for
 * the next page, and which conversation is open beside it.
 */

import * as core from "@polaris/core";
import { MailOnboarding } from "./onboarding";
import { requirePermission } from "@/lib/session";
import { ownedAccountIds } from "@/lib/mailbox/access";
import { MailView, type MailViewContext } from "./mail-view";
import { mailConnectOptions } from "@/lib/mailbox/connect-options";
import { EMPTY_QUERY, listThreads, readThread, type MailListQuery, type MailThreadView } from "@/lib/mailbox/views";

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
    const params = await searchParams;

    // Nothing connected yet. Every list route lands here rather than drawing an
    // empty inbox, because an empty screen with a sentence in it reads as broken
    // and this reads as the first step.
    const accounts = await ownedAccountIds(user.id);
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
    const sort = core.readMailSort(params.sort);
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
        cursor: params.before ?? ""
    };

    const { threads, cursor } = await listThreads(user.id, query);

    // The conversation named in the address, whether or not it is on this page:
    // a link to one is a link somebody was sent, and it has to open even when
    // the list under it has moved on. It is looked up in the page first because
    // that is nearly always where it is.
    //
    // A name that resolves to nothing is a list with nothing open beside it, and
    // never a 404. Archiving or trashing the conversation being read is the
    // ordinary way to arrive here - every move drops the rows and the address is
    // still naming what was moved - and answering that with the not-found page
    // took the whole screen away instead of the one message somebody asked to be
    // rid of. It is also what a link to a conversation that has since been filed
    // deserves: the mailbox it was in, rather than a dead end.
    const wanted = params.open ?? "";
    let openThread: MailThreadView | null = threads.find((thread) => thread.id === wanted) ?? null;
    const openMessages = wanted ? await readThread(user.id, wanted) : [];
    if (wanted && !openThread && openMessages.length > 0) {
        // Not on this page. It still opens, drawn from its own messages, so long
        // as it is on one of this person's mailboxes - `readThread` narrows by
        // the reader, so an empty answer is both "not there" and "not yours".
        const first = openMessages[0]!;
        openThread = {
            id: wanted,
            accountId: first.accountId,
            subject: first.subject,
            snippet: first.snippet,
            participants: first.from,
            messageCount: openMessages.length,
            unreadCount: openMessages.filter((message) => !message.seen).length,
            starred: openMessages.some((message) => message.flagged),
            pinned: false,
            muted: false,
            hasAttachments: openMessages.some((message) => message.attachments.length > 0),
            // Not read: this one was built from its own messages rather than
            // from the list, and their sizes are not part of that shape. It is
            // only ever drawn as the conversation being read, where nothing
            // shows a size.
            size: 0,
            lastMessageAt: openMessages.at(-1)!.sentAt,
            unsubscribe: "",
            labels: [],
            leadMessageId: openMessages.at(-1)!.id
        };
    }

    const searched = Boolean(query.query);
    return (
        <MailView
            threads={threads}
            cursor={cursor}
            // What this list IS, so the scroll can ask for the next page of the
            // same one. Seven routes end up here and a path is a poor thing to
            // reconstruct which from.
            page={{
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
            }}
            openThread={openThread}
            openMessages={openMessages}
            categorised={Boolean(route.categorised) && !searched}
            category={query.category}
            filter={filter}
            sort={sort}
            // A route that IS one of the filters does not offer it again: the
            // Starred screen with a "Starred" button on it reads as a switch that
            // does nothing, because it is one.
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

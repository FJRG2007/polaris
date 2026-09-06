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

import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { MailOnboarding } from "./onboarding";
import { ownedAccountIds } from "@/lib/mailbox/access";
import { mailConnectOptions } from "@/lib/mailbox/connect-options";
import { MailView, type MailViewContext } from "./mail-view";
import { EMPTY_QUERY, listThreads, readThread, type MailListQuery, type MailThreadView } from "@/lib/mailbox/views";

/** What a route knows about itself, beyond the query it narrows to. */
export interface ListRoute {
    readonly narrow: Partial<MailListQuery>;
    readonly context: MailViewContext;
}

export type MailSearchParams = Promise<{
    q?: string;
    open?: string;
    before?: string;
}>;

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
            />
        );
    }

    const query: MailListQuery = {
        ...EMPTY_QUERY,
        ...route.narrow,
        query: params.q?.trim() ?? "",
        cursor: params.before ?? ""
    };

    const { threads, cursor } = await listThreads(user.id, query);

    // The conversation named in the address, whether or not it is on this page:
    // a link to one is a link somebody was sent, and it has to open even when
    // the list under it has moved on. It is looked up in the page first because
    // that is nearly always where it is.
    const wanted = params.open ?? "";
    let openThread: MailThreadView | null = threads.find((thread) => thread.id === wanted) ?? null;
    let openMessages = wanted ? await readThread(user.id, wanted) : [];
    if (wanted && !openThread) {
        // Not on this page. It still opens, drawn from its own messages, so long
        // as it is on one of this person's mailboxes - `readThread` narrows by
        // the reader, so an empty answer is both "not there" and "not yours".
        if (openMessages.length === 0) notFound();
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
            lastMessageAt: openMessages.at(-1)!.sentAt,
            labels: [],
            leadMessageId: openMessages.at(-1)!.id
        };
    }

    const searched = Boolean(query.query);
    return (
        <MailView
            threads={threads}
            cursor={cursor}
            openThread={openThread}
            openMessages={openMessages}
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

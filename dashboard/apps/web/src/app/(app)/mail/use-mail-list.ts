"use client";

/**
 * Where the conversations on screen come from.
 *
 * Every mail client worth using keeps what it has already fetched and draws that
 * first: the mailbox you were looking at a minute ago is still what a mailbox
 * looks like, and asking a server before showing anything is what makes a webmail
 * feel like a website instead of an application. So the list is a fetch, seeded
 * from what this tab already holds, and the request that follows replaces it -
 * which means switching between Inbox and Starred draws instantly the second
 * time and every time after.
 *
 * `useLiveRead` is the machinery, shared with the panels that poll a device.
 * What is special here is only the key: the whole narrowing - which mailbox,
 * which folder, which filter, which order, which search - is the identity of the
 * list, so two lists never read each other's kept copy and a list that is
 * narrowed differently is a different thing to fetch.
 *
 * Nothing is polled. A mailbox announces itself over the live channel, and the
 * shell turns that into a bump of `revision`, which is what asks these to go
 * again. A timer would be asking a server about mail that has not arrived.
 */

import { useCallback } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import { mailPageParams, type MailPageNarrow } from "@/lib/mailbox/page-params";

/** One page of a list, as the endpoint answers it. */
export interface MailListAnswer {
    readonly threads: MailThreadView[];
    /** Where this page ended, or "" when it is the whole list. */
    readonly cursor: string;
}

/** One conversation and its messages, as the endpoint answers it. */
export interface MailThreadAnswer {
    readonly thread: MailThreadView | null;
    readonly messages: MailMessageView[];
}

const NOTHING: MailListAnswer = { threads: [], cursor: "" };

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) throw new Error("That list could not be loaded.");
    return (await response.json()) as T;
}

/**
 * The first page of one list.
 *
 * `loading` is true only when there is nothing at all to draw - a first visit, a
 * tab that has never been here. A revisit paints the kept copy and refreshes
 * behind it, which is why the skeleton is rare rather than something anybody
 * sees on every press.
 */
export function useMailList(
    page: MailPageNarrow,
    revision: number
): {
    threads: MailThreadView[];
    cursor: string;
    loading: boolean;
    refreshing: boolean;
    failed: string | null;
} {
    // Read straight rather than memoised on the object: `page` is built fresh by
    // the render above this one, so memoising on it would produce a new key every
    // render and a fetch behind every one of them. The string is the identity.
    const params = mailPageParams(page).toString();
    const load = useCallback(
        // `revision` is named in the dependencies and not in the body on
        // purpose: it is not part of the request, it is the thing that says the
        // last answer is out of date. A new identity here is what sends this
        // again, and it is the only thing that does.
        (signal: AbortSignal) => readJson<MailListAnswer>(`/api/mail/threads?${params}`, signal),
        [params, revision]
    );

    const read = useLiveRead<MailListAnswer>({ load, cacheKey: `mail.list.${params}` });
    const answer = read.data ?? NOTHING;
    return {
        threads: answer.threads,
        cursor: answer.cursor,
        loading: read.loading,
        refreshing: read.refreshing,
        // Only when there is nothing on screen. A refresh that failed over a list
        // that is still drawn is not something to put a message over: the mail is
        // still the mail, and the live channel will ask again.
        failed: read.error
    };
}

/**
 * The conversation named in the address, if there is one.
 *
 * Kept apart from the list because it is a different question with a different
 * answer: a conversation opens from a link long after the list it was in has
 * moved on, and it has to open anyway.
 */
export function useMailThread(
    threadId: string,
    revision: number
): { answer: MailThreadAnswer | null; loading: boolean } {
    const load = useCallback(
        // See above: named to be depended on, not to be sent.
        (signal: AbortSignal) =>
            readJson<MailThreadAnswer>(`/api/mail/thread/${encodeURIComponent(threadId)}`, signal),
        [threadId, revision]
    );

    const read = useLiveRead<MailThreadAnswer>({
        load,
        cacheKey: `mail.thread.${threadId}`,
        enabled: Boolean(threadId)
    });
    // Nothing asked for is not something being loaded: the pane says "pick a
    // conversation" rather than drawing the shape of one nobody opened.
    if (!threadId) return { answer: null, loading: false };
    return { answer: read.data, loading: read.loading };
}

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
 *
 * Under the tab's own copy sits the device's (`mail-cache`): a new tab, or a
 * browser opened this morning, paints the mailbox it showed last time while the
 * request is in the air, instead of rows-shaped placeholders. And a conversation
 * can be asked for before it is opened (`warmThread`) - on a pointer resting on
 * its row, a key landing on it, or it being the next one down - so the open finds
 * its answer already here.
 */

import { useCallback, useEffect, useState } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import { mailCache, type MailCacheKind } from "@/lib/mailbox/mail-cache";
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

/**
 * What the device kept for `id`, read once per subject and only while there is
 * nothing better on screen. Null until it has been read, and for ever when
 * nothing was kept - which is exactly the screen as it was before this existed.
 */
function useKept<T>(kind: MailCacheKind, id: string, wanted: boolean): T | null {
    const [kept, setKept] = useState<{ id: string; value: T } | null>(null);
    useEffect(() => {
        if (!wanted || !id) return;
        let live = true;
        void mailCache.read<T>(kind, id).then((value) => {
            if (live && value !== null) setKept({ id, value });
        });
        return () => {
            live = false;
        };
    }, [kind, id, wanted]);
    return kept && kept.id === id ? kept.value : null;
}

/**
 * Conversations asked for before anybody opened them, by id.
 *
 * Held for a short while and handed over once: the open that follows a hover
 * takes this answer instead of asking again. Each carries the revision it was
 * asked under, and is handed over only under the same one - anything that has
 * moved a mailbox since (an action, mail arriving) makes it old news, and the
 * open asks the server.
 */
const ahead = new Map<
    string,
    { at: number; revision: number; answer: Promise<MailThreadAnswer> }
>();
const AHEAD_FOR_MS = 15_000;

/**
 * Ask for a conversation now, so opening it is a screen drawing rather than a
 * wait. A database read on the server and nothing more - the bodies are asked for
 * separately, one at a time (see `warmSoon` in `mail-view`) - so it needs no
 * queue of its own, only not to be asked twice.
 */
export function warmThread(threadId: string, revision: number): void {
    if (!threadId) return;
    const now = Date.now();
    for (const [id, entry] of ahead) {
        if (now - entry.at >= AHEAD_FOR_MS || entry.revision !== revision) ahead.delete(id);
    }
    if (ahead.has(threadId)) return;
    const answer = fetchThread(threadId, undefined);
    // A failure is not kept: the open will ask again and say so if it must.
    answer.catch(() => ahead.delete(threadId));
    ahead.set(threadId, { at: now, revision, answer });
}

/** The answer asked for ahead, if it is still fresh - taken, so it is used once. */
function claimThread(threadId: string, revision: number): Promise<MailThreadAnswer> | null {
    const held = ahead.get(threadId);
    ahead.delete(threadId);
    return held && held.revision === revision && Date.now() - held.at < AHEAD_FOR_MS
        ? held.answer
        : null;
}

async function fetchThread(
    threadId: string,
    signal: AbortSignal | undefined
): Promise<MailThreadAnswer> {
    const answer = await readJson<MailThreadAnswer>(
        `/api/mail/thread/${encodeURIComponent(threadId)}`,
        signal
    );
    if (answer.thread) mailCache.write("thread", threadId, answer, answer.thread.accountId);
    return answer;
}

async function readJson<T>(url: string, signal: AbortSignal | undefined): Promise<T> {
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
    revision: number,
    /** The shelf on screen. The same view on two shelves is two lists, so it is
     *  part of the cache key - otherwise switching shelf drew the one left
     *  behind from the cache. */
    shelf: string
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
    const keptId = `${shelf}.${params}`;
    const mailbox = page.accountId ?? "";
    const load = useCallback(
        // `revision` is named in the dependencies and not in the body on
        // purpose: it is not part of the request, it is the thing that says the
        // last answer is out of date. A new identity here is what sends this
        // again, and it is the only thing that does.
        //
        // Every answer this visit got is the copy the next visit starts from,
        // written under the key it was asked for. The tab's own kept copy is
        // not written back: it is older than what the device may already hold.
        async (signal: AbortSignal) => {
            const answer = await readJson<MailListAnswer>(`/api/mail/threads?${params}`, signal);
            mailCache.write("list", keptId, answer, mailbox);
            return answer;
        },
        [params, revision, shelf, keptId, mailbox]
    );

    const read = useLiveRead<MailListAnswer>({ load, cacheKey: `mail.list.${shelf}.${params}` });
    // The device's copy, for a tab that has none of its own yet.
    const kept = useKept<MailListAnswer>("list", keptId, read.data === null);
    const answer = read.data ?? kept ?? NOTHING;
    return {
        threads: answer.threads,
        cursor: answer.cursor,
        loading: read.loading && kept === null,
        refreshing: read.refreshing,
        // Only when there is nothing on screen. A refresh that failed over a list
        // that is still drawn is not something to put a message over: the mail is
        // still the mail, and the live channel will ask again.
        failed: kept === null ? read.error : null
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
        // See above: named to be depended on, not to be sent. The answer asked
        // for ahead is taken first, once - see `claimThread`.
        (signal: AbortSignal) =>
            claimThread(threadId, revision) ?? fetchThread(threadId, signal),
        [threadId, revision]
    );

    const read = useLiveRead<MailThreadAnswer>({
        load,
        cacheKey: `mail.thread.${threadId}`,
        enabled: Boolean(threadId)
    });
    const kept = useKept<MailThreadAnswer>("thread", threadId, read.data === null);
    // Nothing asked for is not something being loaded: the pane says "pick a
    // conversation" rather than drawing the shape of one nobody opened.
    if (!threadId) return { answer: null, loading: false };
    return { answer: read.data ?? kept, loading: read.loading && kept === null };
}

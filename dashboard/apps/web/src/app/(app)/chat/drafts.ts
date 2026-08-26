"use client";

/**
 * What somebody was halfway through saying.
 *
 * A message typed and not sent is not nothing. It is the difficult one - the
 * reply somebody is choosing their words for, the thing they will finish after
 * lunch - and until now closing the tab threw it away. Every messenger people
 * already use keeps it, and keeps it for weeks; this is that.
 *
 * Three decisions, and each of them is the reason it is here rather than on the
 * server:
 *
 * - **Per browser.** A draft is not a message: it has no recipient, nobody else
 *   may see it, and it belongs to the machine somebody was typing on rather than
 *   to their account. Storing it on the server would mean an unfinished, unsent
 *   sentence sitting in a database, which is a promise about privacy nobody
 *   asked us to make and one more thing to have to delete.
 * - **Only where the conversation outlives the sitting.** A room that exists for
 *   the length of a call has nothing to come back to tomorrow, so what was typed
 *   into it is not a draft, it is a message that was not sent. The caller says
 *   which by passing a key or not passing one.
 * - **Blank means gone.** Whitespace is not a message, and a draft that survived
 *   somebody clearing the box would put words back that they had deliberately
 *   taken out - see `isBlankMarkdown`, which is the same rule the send button
 *   uses.
 *
 * Everything lives under one storage key rather than one per conversation: the
 * whole lot is read once when a box mounts, and a browser that has been in four
 * hundred conversations should not have four hundred entries to walk past.
 */

import { isBlankMarkdown } from "@/components/rich-text/markdown";

const KEY = "polaris.chat.drafts";

/**
 * How long a draft is kept.
 *
 * A month, which is well past "I will finish this after lunch" and well short of
 * a browser quietly holding a year of half-sentences. The clock is the last time
 * it was touched, so a draft somebody keeps coming back to never ages out.
 */
const KEEP_DAYS = 30;

/** How many are kept at once. A ceiling rather than a target: the oldest go
 *  first, and nobody has two hundred unfinished messages they mean to send. */
const KEEP_MOST = 200;

interface Draft {
    readonly body: string;
    /** When it was last written, as a moment in time. */
    readonly at: number;
}

type Drafts = Record<string, Draft>;

/** The conversation a box belongs to, as a key. Its own function so the two
 *  callers cannot drift apart and quietly stop finding each other's drafts. */
export function channelDraftKey(channelId: string): string {
    return `channel:${channelId}`;
}

/** A thread is its own box under its own message, so it keeps its own draft. */
export function threadDraftKey(messageId: string): string {
    return `thread:${messageId}`;
}

function readAll(): Drafts {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        // Whatever is in storage was put there by this browser, but it is still
        // outside data: a shape that does not fit is treated as no drafts rather
        // than trusted into the box somebody types in.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const found: Drafts = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== "object") continue;
            const { body, at } = value as { body?: unknown; at?: unknown };
            if (typeof body !== "string" || typeof at !== "number") continue;
            found[key] = { body, at };
        }
        return found;
    } catch {
        // Storage refused, or holds something that is not JSON. Either way there
        // are no drafts, which is the state everything here already handles.
        return {};
    }
}

function writeAll(drafts: Drafts): void {
    if (typeof window === "undefined") return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const kept = Object.entries(drafts)
        .filter(([, draft]) => draft.at > cutoff)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, KEEP_MOST);
    try {
        if (kept.length === 0) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
        // A full quota, or storage switched off. What is on screen is unaffected;
        // it simply will not be there tomorrow.
    }
}

/** What was left in that box, or an empty string. */
export function readDraft(key: string): string {
    return readAll()[key]?.body ?? "";
}

/**
 * Keep what is in the box, or throw it away when there is nothing in it.
 *
 * One function for both because they are one decision: the box is the draft, so
 * emptying it is how a draft is deleted. Anything that is only whitespace counts
 * as empty, which is the same rule that decides whether the send button does
 * anything.
 */
export function keepDraft(key: string, body: string): void {
    const drafts = readAll();
    if (isBlankMarkdown(body)) {
        if (!(key in drafts)) return;
        delete drafts[key];
    } else {
        if (drafts[key]?.body === body) return;
        drafts[key] = { body, at: Date.now() };
    }
    writeAll(drafts);
}

/** The draft is gone: the message was sent, or scheduled, and what was typed is
 *  now somewhere that is not a browser. */
export function dropDraft(key: string): void {
    const drafts = readAll();
    if (!(key in drafts)) return;
    delete drafts[key];
    writeAll(drafts);
}

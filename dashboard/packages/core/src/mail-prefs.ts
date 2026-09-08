/**
 * How one person wants Mail to behave, as opposed to how one mailbox is set up.
 *
 * Everything Mail could be told until now was per mailbox - its signature, its
 * privacy, its out-of-office - because those genuinely differ between a work
 * address and a personal one. The way somebody *reads* does not. Whether a
 * message counts as read the instant it opens, what happens to the screen after
 * one is filed, how long a sent message can be caught back: those are one
 * answer per person, and there was nowhere to give it. They were constants in
 * the code, which is a decision made for everybody by whoever typed it.
 *
 * Stored as one JSON blob on the account, the way display and notification
 * preferences already are. Which makes the rule below the important part:
 * **`parseMailPreferences` returns the whole shape, always**. A stored blob is
 * older than the screen reading it - written by a version of Polaris that had
 * fewer of these - so a field that is missing is not absent, it is a default,
 * and anything that spread the stored object over the defaults key by key would
 * hand a half-built preference to whatever ran next.
 */

import { z } from "zod";
import { DEFAULT_MAIL_SORT, MAIL_SORTS, isMailSort, type MailSort } from "./mailbox-list.js";

/**
 * When an opened message stops being unread.
 *
 * `open` is what every webmail does and what almost everybody expects. `delay`
 * is for somebody who arrows through a list with a reading pane: passing over a
 * message is not reading it, and marking it read is how a message is lost.
 * `never` leaves it to the toolbar, which is the only honest answer for anybody
 * who uses unread as a to-do list.
 */
export const MAIL_MARK_READ = ["open", "delay", "never"] as const;

export type MailMarkRead = (typeof MAIL_MARK_READ)[number];

export const MAIL_MARK_READ_LABELS: Readonly<Record<MailMarkRead, string>> = {
    open: "As soon as I open it",
    delay: "After a few seconds",
    never: "Only when I say so"
};

/** How long "after a few seconds" is. Long enough to pass over a message
 *  without claiming it was read, short enough that reading one does not need
 *  patience. */
export const MAIL_MARK_READ_DELAY_MS = 3_000;

/**
 * Where the screen goes once a conversation is archived, trashed or deleted.
 *
 * `list` is the safe answer and the default: the thing that was open is gone, so
 * the list is what is left. `next` is what somebody clearing four hundred
 * messages wants, because going back to a list to click the row under the one
 * they just cleared is the whole job done twice.
 */
export const MAIL_AFTER_FILING = ["list", "next"] as const;

export type MailAfterFiling = (typeof MAIL_AFTER_FILING)[number];

export const MAIL_AFTER_FILING_LABELS: Readonly<Record<MailAfterFiling, string>> = {
    list: "Go back to the list",
    next: "Open the next conversation"
};

/**
 * How long a sent message waits before it actually goes.
 *
 * Zero is off, and off means Send is final - which is a real preference and a
 * bad default. Thirty is the longest worth offering: past that people stop
 * trusting that anything was sent at all.
 */
export const MAIL_UNDO_SECONDS = [0, 5, 10, 20, 30] as const;

export const DEFAULT_MAIL_UNDO_SECONDS = 10;

export function mailUndoLabel(seconds: number): string {
    return seconds === 0 ? "Send immediately" : `${seconds} seconds`;
}

/** Everything one person has said about how they read mail. */
export interface MailPreferences {
    /** What every list is ordered by before anybody presses a sort button. The
     *  buttons still win for the page they are on - a sort in the address is a
     *  link somebody can send. */
    readonly sort: MailSort;
    readonly markRead: MailMarkRead;
    readonly afterFiling: MailAfterFiling;
    readonly undoSeconds: number;
}

/** What Mail does for somebody who has never opened this screen. */
export const MAIL_PREF_DEFAULTS: MailPreferences = {
    sort: DEFAULT_MAIL_SORT,
    markRead: "open",
    afterFiling: "list",
    undoSeconds: DEFAULT_MAIL_UNDO_SECONDS
};

function isMarkRead(value: unknown): value is MailMarkRead {
    return typeof value === "string" && (MAIL_MARK_READ as readonly string[]).includes(value);
}

function isAfterFiling(value: unknown): value is MailAfterFiling {
    return typeof value === "string" && (MAIL_AFTER_FILING as readonly string[]).includes(value);
}

function isUndoSeconds(value: unknown): value is number {
    return typeof value === "number" && (MAIL_UNDO_SECONDS as readonly number[]).includes(value);
}

/**
 * Read what was stored, filling in everything it does not say.
 *
 * Every field is decided here, from the stored value where it is one of the
 * ones on offer and from the default where it is anything else - a null column,
 * a blob written before the field existed, a value somebody edited in the
 * database, a string where a number belongs. Nothing downstream is handed a
 * partial shape, and nothing downstream re-checks.
 */
export function parseMailPreferences(raw: string | null | undefined): MailPreferences {
    let held: unknown = null;
    try {
        held = raw ? JSON.parse(raw) : null;
    } catch {
        held = null;
    }
    const bag = (held && typeof held === "object" ? held : {}) as Record<string, unknown>;
    return {
        sort: isMailSort(typeof bag.sort === "string" ? bag.sort : null)
            ? (bag.sort as MailSort)
            : MAIL_PREF_DEFAULTS.sort,
        markRead: isMarkRead(bag.markRead) ? bag.markRead : MAIL_PREF_DEFAULTS.markRead,
        afterFiling: isAfterFiling(bag.afterFiling) ? bag.afterFiling : MAIL_PREF_DEFAULTS.afterFiling,
        undoSeconds: isUndoSeconds(bag.undoSeconds) ? bag.undoSeconds : MAIL_PREF_DEFAULTS.undoSeconds
    };
}

/**
 * What the screen is allowed to send.
 *
 * Strict where `parseMailPreferences` is forgiving, and they are not the same
 * job: that one reads a blob this deployment wrote and has to survive it being
 * older than the code, while this one reads a request body, which is somebody
 * else's input until it has been checked. A sort nobody offers, a wait nobody
 * offers, a number where a word belongs: refused here rather than stored and
 * then defaulted away every time it is read.
 */
export const mailPreferencesSchema = z.object({
    sort: z.enum(MAIL_SORTS),
    markRead: z.enum(MAIL_MARK_READ),
    afterFiling: z.enum(MAIL_AFTER_FILING),
    undoSeconds: z
        .number()
        .int()
        .refine((value) => (MAIL_UNDO_SECONDS as readonly number[]).includes(value), {
            message: "That is not one of the waits on offer."
        })
});

/** The whole shape on the way out, so what is read back is what was chosen
 *  rather than what happened to differ from a default at the time. */
export function stringifyMailPreferences(preferences: MailPreferences): string {
    return JSON.stringify({
        sort: preferences.sort,
        markRead: preferences.markRead,
        afterFiling: preferences.afterFiling,
        undoSeconds: preferences.undoSeconds
    });
}

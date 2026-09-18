/**
 * How a message arriving is announced, decided in one place.
 *
 * Three things can happen when somebody says something - a card in the corner,
 * a chime, and a notice from the operating system - and which of them is right
 * depends on two facts about this tab: whether it is showing that conversation,
 * and whether anybody is actually looking at it (see `components/use-attention`).
 *
 * The one case that stays silent is the conversation open in front of a reader
 * who is attending to it: the line is already on their screen. The same
 * conversation left open in a background tab, a minimised window, or behind
 * another program is a message nobody has seen, and it is announced like any
 * other - it used to be skipped because the address matched, which is how a
 * message arrived with no sound and no notice at all.
 */

export interface ArrivalContext {
    /** Whether this tab is showing the conversation the message was posted in. */
    readonly inThatChat: boolean;
    /** Whether the tab is visible and focused. */
    readonly attended: boolean;
    /** Whether the reader has message sounds switched on. */
    readonly soundOn: boolean;
}

export interface ArrivalAlert {
    /** The in-app card. Never for the conversation on screen: the line is there. */
    readonly toast: boolean;
    readonly sound: boolean;
    /** The operating system's notice, for a tab nobody is looking at. */
    readonly desktop: boolean;
}

const QUIET: ArrivalAlert = { toast: false, sound: false, desktop: false };

/** What to do about one arrival. Pure, so every combination can be asserted. */
export function arrivalAlert(context: ArrivalContext): ArrivalAlert {
    if (context.inThatChat && context.attended) return QUIET;
    return {
        toast: !context.inThatChat,
        sound: context.soundOn,
        desktop: !context.attended
    };
}

/** Whether `pathname` is the conversation `channelId`, or a message in it. */
export function showsConversation(pathname: string, channelId: string): boolean {
    const base = `/chat/c/${channelId}`;
    return pathname === base || pathname.startsWith(`${base}/`);
}

const SEEN_PREFIX = "polaris.chat.seen:";

/**
 * How close together a tab reading a conversation and another tab hearing about
 * it have to be for the two to be the same arrival. Every tab is told about a
 * message within moments of the others; a second message a few seconds later is
 * a new arrival and is announced, even though the conversation was being read a
 * moment before it.
 */
export const SEEN_WINDOW_MS = 1500;

/** This document, so a tab never reads its own mark as somebody else reading. */
const TAB = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

/**
 * Say, for every tab of this browser, that a message in `channelId` arrived at a
 * tab that is showing it to somebody.
 *
 * The tab that holds the live connection is often not the one being read, and it
 * cannot tell that somebody is reading the conversation in another window - so
 * it would chime and raise a notice for a line already on screen. Written to
 * `localStorage`, which every tab of the origin shares. A refused write only
 * costs a redundant chime.
 */
export function markSeenOnDevice(
    channelId: string,
    now: number = Date.now(),
    tab: string = TAB
): void {
    try {
        window.localStorage.setItem(`${SEEN_PREFIX}${channelId}`, JSON.stringify({ tab, at: now }));
    } catch {
        // Private browsing, or no window at all.
    }
}

/** Whether another tab of this browser was showing `channelId` when the arrival
 *  this tab heard about at `arrivedAt` reached it. */
export function seenOnDevice(channelId: string, arrivedAt: number, tab: string = TAB): boolean {
    const key = `${SEEN_PREFIX}${channelId}`;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return false;
        const mark = JSON.parse(raw) as { tab?: unknown; at?: unknown };
        if (typeof mark.at !== "number" || typeof mark.tab !== "string") {
            window.localStorage.removeItem(key);
            return false;
        }
        const within = Math.abs(mark.at - arrivedAt) < SEEN_WINDOW_MS;
        // A mark means nothing outside its window, and one per conversation ever
        // opened would sit in this browser for good. Dropped as it is read.
        if (!within) window.localStorage.removeItem(key);
        return within && mark.tab !== tab;
    } catch {
        return false;
    }
}

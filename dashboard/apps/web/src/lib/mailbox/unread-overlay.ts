/**
 * Unread counts this browser has just changed, before the server says so.
 *
 * One ledger for every number that counts unread mail outside the list itself:
 * the folders and mailboxes in Mail's rail, and the Mail badge on the app
 * switcher, the rail and the tab icon. Each used to keep its own overlay and
 * drop it the moment its server figure moved at all - and a figure moves for
 * reasons that have nothing to do with the click: a recount a live frame started
 * a moment before, mail arriving in another folder. The overlay went, the old
 * number came back, and it only settled once the mail server had answered and
 * announced it. That is "the badge goes away after a while".
 *
 * So the rule is the list's (see `pending-changes` in Mail): a count may
 * contradict a change only if it was ASKED FOR after the change was confirmed.
 * A refusal takes the change away at once, so the badge goes back with the row.
 * A confirmed change is forgotten after a while regardless.
 *
 * Client-side and tab-wide, on `globalThis` so the bundles a route is split
 * into share one.
 */

/** One folder's unread count moved by an action. */
export interface UnreadMove {
    /** Null for a change made outside Mail that knows the inbox total and not
     *  the folders - the app menu's "mark read". */
    readonly folderId: string | null;
    readonly accountId: string | null;
    /** Whether the folder is an inbox: the mailbox badges and the app badge
     *  count inboxes and nothing else. */
    readonly inbox: boolean;
    /** Negative for mail that stopped being unread. */
    readonly by: number;
}

interface Entry {
    readonly id: number;
    readonly moves: readonly UnreadMove[];
    readonly settledAt: number | null;
}

/** What the counts owe this browser's changes, by where they are drawn. */
export interface UnreadOverlay {
    readonly folders: Readonly<Record<string, number>>;
    readonly accounts: Readonly<Record<string, number>>;
    /** Across every inbox, for the app badge. */
    readonly inbox: number;
}

export const EMPTY_OVERLAY: UnreadOverlay = { folders: {}, accounts: {}, inbox: 0 };

/** How long a confirmed change is still laid over counts asked for before it. */
export const UNREAD_KEEP_MS = 2 * 60 * 1000;

export type UnreadEvent = "begun" | "settled" | "abandoned";

interface Ledger {
    entries: Entry[];
    next: number;
    version: number;
    readonly listeners: Set<(event: UnreadEvent) => void>;
}

const KEY = Symbol.for("polaris.mail.unread-overlay");

function ledger(): Ledger {
    const slot = globalThis as unknown as Record<symbol, Ledger | undefined>;
    slot[KEY] ??= { entries: [], next: 1, version: 0, listeners: new Set() };
    return slot[KEY]!;
}

function changed(event: UnreadEvent): void {
    const held = ledger();
    const now = Date.now();
    held.entries = held.entries.filter(
        (one) => one.settledAt === null || now - one.settledAt <= UNREAD_KEEP_MS
    );
    held.version += 1;
    for (const listener of held.listeners) listener(event);
}

export interface UnreadHandle {
    /** The server agreed: kept over counts asked for before this moment. */
    readonly settle: () => void;
    /** The server refused: taken away now. */
    readonly abandon: () => void;
}

const NOTHING: UnreadHandle = { settle: () => undefined, abandon: () => undefined };

export function beginUnreadChange(moves: readonly UnreadMove[]): UnreadHandle {
    const wanted = moves.filter((move) => move.by !== 0);
    if (wanted.length === 0) return NOTHING;
    const held = ledger();
    const id = held.next++;
    held.entries = [...held.entries, { id, moves: wanted, settledAt: null }];
    changed("begun");
    // Answered once: a second answer changes nothing.
    const open = () => held.entries.some((one) => one.id === id && one.settledAt === null);
    return {
        settle: () => {
            if (!open()) return;
            const at = Date.now();
            held.entries = held.entries.map((one) =>
                one.id === id ? { ...one, settledAt: at } : one
            );
            changed("settled");
        },
        abandon: () => {
            if (!open()) return;
            held.entries = held.entries.filter((one) => one.id !== id);
            changed("abandoned");
        }
    };
}

/**
 * What a count asked for at `requestedAt` still owes. A count with no stamp -
 * one the server rendered into the page - is 0, older than every change.
 */
export function unreadOverlay(requestedAt: number, now: number = Date.now()): UnreadOverlay {
    const folders: Record<string, number> = {};
    const accounts: Record<string, number> = {};
    let inbox = 0;
    let any = false;
    for (const one of ledger().entries) {
        if (one.settledAt !== null && now - one.settledAt > UNREAD_KEEP_MS) continue;
        if (one.settledAt !== null && requestedAt >= one.settledAt) continue;
        for (const move of one.moves) {
            any = true;
            if (move.folderId) folders[move.folderId] = (folders[move.folderId] ?? 0) + move.by;
            if (!move.inbox) continue;
            if (move.accountId) {
                accounts[move.accountId] = (accounts[move.accountId] ?? 0) + move.by;
            }
            inbox += move.by;
        }
    }
    return any ? { folders, accounts, inbox } : EMPTY_OVERLAY;
}

export function subscribeUnreadOverlay(listener: (event: UnreadEvent) => void): () => void {
    const held = ledger();
    held.listeners.add(listener);
    return () => held.listeners.delete(listener);
}

export function unreadOverlayVersion(): number {
    return ledger().version;
}

/** Forget everything. For tests. */
export function resetUnreadOverlay(): void {
    const held = ledger();
    held.entries = [];
    held.version += 1;
}

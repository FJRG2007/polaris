/**
 * Who has Mail open right now, and what that changes.
 *
 * A mailbox is asked for new mail on its own interval, which defaults to five
 * minutes because that is a sensible rate for a mailbox nobody is looking at.
 * It is a terrible rate for one somebody IS looking at: mail read on a phone,
 * in Thunderbird, or on the provider's own web page took up to five minutes to
 * stop being bold here, and mail that arrived took just as long to appear. That
 * is not what anybody means by their mail being in one place.
 *
 * So while a tab holds the live channel open, that person's mailboxes are asked
 * every twenty seconds, driven from here rather than from the scheduled sweep -
 * the sweep runs once a minute, so it could not be the thing that made a
 * twenty-second interval mean anything.
 *
 * Self-limiting by construction: the fast pass exists only while somebody is
 * watching, one timer per person however many tabs they have open, and it stops
 * the moment the last one closes. A mailbox nobody has open is never asked more
 * often than its owner chose.
 */

/** How often a watched mailbox is asked. Fast enough that reading a message on a
 *  phone is reflected here before somebody wonders why it has not been, slow
 *  enough that a mailbox open all day is a handful of commands a minute. */
export const WATCHED_POLL_SECONDS = 20;

/** Held on `globalThis` for the same reason the live bus is: a dev server
 *  re-evaluates the module on edit, and a fresh map would strand the timers
 *  started against the previous copy. */
const WATCHERS = Symbol.for("polaris.mail.watchers");

interface Watcher {
    /** How many streams this person has open. The timer belongs to the person,
     *  not to the tab: four tabs must not be four passes over one mailbox. */
    count: number;
    timer: ReturnType<typeof setInterval>;
}

function watchers(): Map<string, Watcher> {
    const held = globalThis as { [WATCHERS]?: Map<string, Watcher> };
    held[WATCHERS] ??= new Map();
    return held[WATCHERS];
}

/**
 * Mark somebody as watching, and start asking their mailboxes often.
 *
 * Returns the way to stop. Every caller must call it - the stream does, from the
 * one place it tears down - or a timer outlives the tab that wanted it.
 */
export function watchMailboxes(userId: string): () => void {
    const held = watchers();
    const existing = held.get(userId);
    if (existing) {
        existing.count += 1;
    } else {
        const timer = setInterval(() => {
            void sweepFor(userId);
        }, WATCHED_POLL_SECONDS * 1000);
        // Nothing here should hold the process open on its own account.
        timer.unref?.();
        held.set(userId, { count: 1, timer });
    }

    let released = false;
    return () => {
        // Guarded, because a stream can be torn down twice - the abort signal
        // and the stream's own cancel both fire when a tab goes away - and a
        // second release would take somebody else's tab off the count.
        if (released) return;
        released = true;
        const watcher = watchers().get(userId);
        if (!watcher) return;
        watcher.count -= 1;
        if (watcher.count > 0) return;
        clearInterval(watcher.timer);
        watchers().delete(userId);
    };
}

/** Everybody with Mail open, for the scheduled sweep to read. */
export function watchedReaders(): ReadonlySet<string> {
    return new Set(watchers().keys());
}

/**
 * Ask this person's mailboxes now.
 *
 * The two modules are reached at the moment they are needed rather than at the
 * top of the file, and that is load bearing twice over: the scheduled sweep
 * reads `watchedReaders` from here, so importing the sync from here as well
 * would be a cycle between the two, and it keeps this file - which is a counter
 * and a timer and nothing else - importable without dragging a database
 * connection behind it.
 */
async function sweepFor(userId: string): Promise<void> {
    try {
        const [{ syncAccount }, { everyAccountId }] = await Promise.all([
            import("./sync"),
            import("./access")
        ]);
        // Every mailbox, not one shelf: mail arriving in a company mailbox
        // its owner is not currently looking at is exactly the mail somebody
        // wants to be told about.
        const ids = await everyAccountId(userId);
        // One at a time. A person with four mailboxes opening four IMAP sessions
        // at once every twenty seconds is how a provider starts refusing them,
        // and `syncAccount` already joins a pass that is running.
        for (const id of ids) await syncAccount(id).catch(() => undefined);
    } catch {
        // A transient database error. The next tick tries again, and the
        // scheduled sweep is underneath this the whole time.
    }
}

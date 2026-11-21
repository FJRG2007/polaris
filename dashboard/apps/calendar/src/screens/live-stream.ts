/**
 * One server stream per tab that says "read again".
 *
 * The Time screen and the calendar grid each follow changes made by other
 * clients - a Stream Deck key, Companion, an assistant, another device - over a
 * stream from the server (see `lib/wake-stream`). Each module that imports this
 * may be its own copy in the app's bundle, so the connection is held on the
 * window: however many screens listen, a tab opens one per path.
 *
 * A hidden tab lets its connection go (the browser has only a few per server to
 * share between every tab) and reads once when it is looked at again.
 */

interface LiveHold {
    users: number;
    source: EventSource | null;
    onVisibility: (() => void) | null;
}

function liveHold(path: string): LiveHold {
    const key = Symbol.for(`polaris.calendar.stream:${path}`);
    const holder = window as unknown as Record<symbol, LiveHold | undefined>;
    holder[key] ??= { users: 0, source: null, onVisibility: null };
    return holder[key];
}

/**
 * Hold the tab's one stream at `path` open while anything here needs it and the
 * tab is in view. A frame - and every reconnect, which may have missed one -
 * raises the window event `eventName`, so every listening screen reads again.
 * Answers the release.
 */
export function holdWakeStream(path: string, eventName: string): () => void {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};
    const hold = liveHold(path);
    const wake = () => window.dispatchEvent(new CustomEvent(eventName));
    const open = () => {
        if (hold.source || document.visibilityState === "hidden") return;
        const source = new EventSource(path);
        let opened = false;
        source.onopen = () => {
            // The first open is the read the screen already made; a later one is
            // a reconnect after a gap.
            if (opened) wake();
            opened = true;
        };
        source.onmessage = wake;
        source.onerror = () => {
            // Closed for good (refused, signed out): stop rather than retry. A
            // dropped connection is retried by the browser on its own.
            if (source.readyState === EventSource.CLOSED && hold.source === source)
                hold.source = null;
        };
        hold.source = source;
    };
    const close = () => {
        hold.source?.close();
        hold.source = null;
    };
    hold.users += 1;
    if (hold.users === 1) {
        hold.onVisibility = () => {
            if (document.visibilityState === "hidden") return close();
            if (hold.source) return;
            open();
            wake();
        };
        document.addEventListener("visibilitychange", hold.onVisibility);
        open();
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        hold.users -= 1;
        if (hold.users > 0) return;
        if (hold.onVisibility) document.removeEventListener("visibilitychange", hold.onVisibility);
        hold.onVisibility = null;
        close();
    };
}

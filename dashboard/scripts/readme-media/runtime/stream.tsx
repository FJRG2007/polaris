/**
 * Live streams for a page with no server.
 *
 * Every `EventSource` the dashboard opens is one of these: open and quiet, so a
 * still picture is one moment rather than a feed. An animation speaks on them
 * with `sendFrame`, which is the same frame the real stream would have written,
 * read by the same code that reads the real one.
 */

const open = new Set<SceneEventSource>();

/** A named event a stream writes: `{ type: "lines", data: [...] }`. */
export interface StreamEvent {
    readonly type: string;
    readonly data: unknown;
}

/** What a stream at a path writes as soon as it is opened, by path. */
const scripts = new Map<string, readonly StreamEvent[]>();

/** Have every stream opened at `path` say `events`, in order, once it opens. */
export function scriptStream(path: string, events: readonly StreamEvent[]): void {
    scripts.set(path, events);
}

export class SceneEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;
    constructor(readonly url: string) {
        super();
        open.add(this);
        const script = scripts.get(new URL(url, location.href).pathname);
        if (!script) return;
        // After the caller has attached its listeners, as a real connection
        // answers no sooner than that.
        setTimeout(() => {
            if (!open.has(this)) return;
            const opened = new Event("open");
            this.onopen?.(opened);
            this.dispatchEvent(opened);
            for (const event of script) {
                const message = new MessageEvent(event.type, { data: JSON.stringify(event.data) });
                if (event.type === "message") this.onmessage?.(message);
                this.dispatchEvent(message);
            }
        }, 50);
    }
    close() {
        open.delete(this);
    }
}

/** Write `frame` on every open stream at `path`, as the server would have. */
export function sendFrame(path: string, frame: unknown): void {
    const data = JSON.stringify(frame);
    for (const source of open) {
        if (new URL(source.url, location.href).pathname !== path) continue;
        const event = new MessageEvent("message", { data });
        source.onmessage?.(event);
        source.dispatchEvent(event);
    }
}

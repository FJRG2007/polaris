import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeSharedStream, type SharedFrame } from "@/lib/shared-stream";

/**
 * The browser pieces this leans on, small enough to drive by hand: connections
 * that only open when told to, a channel that delivers synchronously so a test
 * does not race it, and a lock that grants one holder at a time and hands over
 * when that holder lets go.
 */

class FakeEventSource {
    static opened: FakeEventSource[] = [];
    onmessage: ((event: { data: string; }) => void) | null = null;
    closed = false;

    constructor(readonly url: string) {
        FakeEventSource.opened.push(this);
    }

    /** The server pushing a frame down this connection. */
    push(data: string): void {
        this.onmessage?.({ data });
    }

    close(): void {
        this.closed = true;
    }
}

class FakeChannel {
    static live: FakeChannel[] = [];
    /** A frozen tab neither posts nor hears anything. */
    static delivering = true;
    onmessage: ((event: { data: unknown; }) => void) | null = null;
    closed = false;

    constructor(readonly name: string) {
        FakeChannel.live.push(this);
    }

    postMessage(message: unknown): void {
        if (!FakeChannel.delivering) return;
        for (const peer of FakeChannel.live) {
            if (peer !== this && !peer.closed && peer.name === this.name) peer.onmessage?.({ data: message });
        }
    }

    close(): void {
        this.closed = true;
    }
}

class FakeLocks {
    private readonly held = new Set<string>();
    private readonly waiting = new Map<string, Array<() => void>>();

    request(name: string, options: { signal?: AbortSignal; }, callback: () => Promise<void>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const grant = () => {
                this.held.add(name);
                void Promise.resolve(callback()).then(() => {
                    this.held.delete(name);
                    this.waiting.get(name)?.shift()?.();
                    resolve();
                });
            };
            if (!this.held.has(name)) return grant();
            const queue = this.waiting.get(name) ?? [];
            queue.push(grant);
            this.waiting.set(name, queue);
            options.signal?.addEventListener("abort", () => {
                const rest = this.waiting.get(name) ?? [];
                const at = rest.indexOf(grant);
                if (at >= 0) rest.splice(at, 1);
                reject(new Error("AbortError"));
            });
        });
    }
}

const PATH = "/api/notifications/stream";

let stops: Array<() => void> = [];

/** A tab subscribing, and everything it was handed. */
function tab(scope = "user-1"): SharedFrame[] {
    const frames: SharedFrame[] = [];
    stops.push(subscribeSharedStream(PATH, scope, (frame) => frames.push(frame)));
    return frames;
}

/** The connections still open. */
function live(): FakeEventSource[] {
    return FakeEventSource.opened.filter((source) => !source.closed);
}

/** Lets the lock be granted, which happens on a microtask. */
async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    FakeEventSource.opened = [];
    FakeChannel.live = [];
    FakeChannel.delivering = true;
    stops = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.stubGlobal("navigator", { locks: new FakeLocks() });
});

afterEach(() => {
    for (const stop of stops) stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("subscribeSharedStream", () => {
    it("gives two tabs of one account a single connection", async () => {
        tab();
        tab();
        await settle();
        expect(live()).toHaveLength(1);
    });

    it("hands the frame to both, owned by the tab that took it off the wire", async () => {
        const first = tab();
        const second = tab();
        await settle();
        live()[0].push('{"items":[]}');
        expect(first).toEqual([{ data: '{"items":[]}', owner: true }]);
        expect(second).toEqual([{ data: '{"items":[]}', owner: false }]);
    });

    it("keeps a tab signed in as somebody else out of it", async () => {
        const mine = tab("user-1");
        const theirs = tab("user-2");
        await settle();
        expect(live()).toHaveLength(2);
        live()[0].push('{"items":["mine"]}');
        expect(theirs).toHaveLength(0);
        expect(mine).toHaveLength(1);
    });

    it("passes the connection on when the tab holding it is closed", async () => {
        tab();
        const second = tab();
        await settle();
        const first = live()[0];
        stops.shift()?.();
        await settle();
        expect(first.closed).toBe(true);
        expect(live()).toHaveLength(1);
        live()[0].push('{"items":[]}');
        // The tab that took over reads its own connection now.
        expect(second).toEqual([{ data: '{"items":[]}', owner: true }]);
    });

    it("gives every tab its own connection when the browser has no lock to elect with", async () => {
        vi.stubGlobal("navigator", {});
        tab();
        tab();
        await settle();
        expect(live()).toHaveLength(2);
    });

    it("stops waiting on a tab that went quiet and serves itself", async () => {
        vi.useFakeTimers();
        tab();
        const second = tab();
        await vi.advanceTimersByTimeAsync(0);
        expect(live()).toHaveLength(1);

        // The holder is still there as far as the lock is concerned, but nothing
        // it sends arrives any more - which is what a frozen background tab looks
        // like from here.
        FakeChannel.delivering = false;
        await vi.advanceTimersByTimeAsync(40000);
        expect(live()).toHaveLength(2);
        live()[1].push('{"items":[]}');
        expect(second).toEqual([{ data: '{"items":[]}', owner: true }]);
    });

    it("keeps waiting while the tab holding the connection is still beating", async () => {
        vi.useFakeTimers();
        tab();
        tab();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(40000);
        expect(live()).toHaveLength(1);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeSharedStream, type SharedFrame } from "@/lib/shared-stream";

/**
 * The browser pieces this leans on, small enough to drive by hand: connections
 * that only open when told to, a channel that delivers synchronously so a test
 * does not race it, and a lock that grants one holder at a time and hands over
 * when that holder lets go.
 *
 * A tab is a module instance. That distinction is load-bearing here and it was
 * not made before: several of these tests called `subscribeSharedStream` twice and
 * called that "two tabs", when two tabs are two JavaScript contexts with module
 * state of their own and two calls in one context are two things in ONE tab asking
 * for the same stream. Sharing now happens at both scales, so the tests have to
 * tell them apart - `anotherTab()` is the second context.
 */

class FakeEventSource {
    static opened: FakeEventSource[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
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
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;

    constructor(readonly name: string) {
        FakeChannel.live.push(this);
    }

    postMessage(message: unknown): void {
        if (!FakeChannel.delivering) return;
        for (const peer of FakeChannel.live) {
            if (peer !== this && !peer.closed && peer.name === this.name)
                peer.onmessage?.({ data: message });
        }
    }

    close(): void {
        this.closed = true;
    }
}

class FakeLocks {
    private readonly held = new Set<string>();
    private readonly waiting = new Map<string, Array<() => void>>();

    request(
        name: string,
        options: { signal?: AbortSignal },
        callback: () => Promise<void>
    ): Promise<void> {
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

/** Something in THIS tab subscribing, and everything it was handed. */
function here(scope = "user-1"): SharedFrame[] {
    const frames: SharedFrame[] = [];
    stops.push(subscribeSharedStream(PATH, scope, (frame) => frames.push(frame)));
    return frames;
}

/**
 * Another tab: a module instance of its own, which is what a second tab is. Same
 * globals - one browser - separate module state, so nothing inside the module can
 * make the two share anything.
 */
async function anotherTab(): Promise<(scope?: string) => SharedFrame[]> {
    vi.resetModules();
    const elsewhere = await import("@/lib/shared-stream");
    return (scope = "user-1") => {
        const frames: SharedFrame[] = [];
        stops.push(elsewhere.subscribeSharedStream(PATH, scope, (frame) => frames.push(frame)));
        return frames;
    };
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

describe("inside one tab", () => {
    it("shares one connection between everything that asks for the stream", async () => {
        // The bell and the administration waiting count both follow this stream.
        here();
        here();
        await settle();
        expect(live()).toHaveLength(1);
    });

    it("shares it even where there is no lock to elect with", async () => {
        // The regression this was written for. Web Locks do not exist outside a
        // secure context, which is every Polaris reached over plain http at a LAN
        // address, and each subscription used to serve itself: two connections in
        // one tab, two feed polls - and since the server elects exactly one
        // connection of an account to carry the chime, a coin flip over which of
        // them got it. The subscriber that never reads it won about half the time
        // and the device went quiet for the rest of the page's life.
        vi.stubGlobal("navigator", {});
        const bell = here();
        const queue = here();
        await settle();
        expect(live()).toHaveLength(1);
        live()[0].push('{"items":[]}');
        expect(bell).toEqual([{ data: '{"items":[]}', owner: true }]);
        expect(queue).toEqual([{ data: '{"items":[]}', owner: true }]);
    });

    it("holds the connection while anything in the tab still wants it", async () => {
        here();
        here();
        await settle();
        const source = live()[0];
        // One of the two goes away - a screen unmounted, a panel closed.
        stops.shift()?.();
        expect(source.closed).toBe(false);
        expect(live()).toHaveLength(1);
        // The last one closes it.
        stops.shift()?.();
        expect(source.closed).toBe(true);
    });

    it("keeps a tab signed in as somebody else out of it", async () => {
        const mine = here("user-1");
        const theirs = here("user-2");
        await settle();
        expect(live()).toHaveLength(2);
        live()[0].push('{"items":["mine"]}');
        expect(theirs).toHaveLength(0);
        expect(mine).toHaveLength(1);
    });
});

describe("between tabs", () => {
    it("gives two tabs of one account a single connection", async () => {
        const second = await anotherTab();
        here();
        second();
        await settle();
        expect(live()).toHaveLength(1);
    });

    it("hands the frame to both, owned by the tab that took it off the wire", async () => {
        const second = await anotherTab();
        const first = here();
        const other = second();
        await settle();
        live()[0].push('{"items":[]}');
        expect(first).toEqual([{ data: '{"items":[]}', owner: true }]);
        expect(other).toEqual([{ data: '{"items":[]}', owner: false }]);
    });

    it("passes the connection on when the tab holding it is closed", async () => {
        const second = await anotherTab();
        here();
        const other = second();
        await settle();
        const first = live()[0];
        stops.shift()?.();
        await settle();
        expect(first.closed).toBe(true);
        expect(live()).toHaveLength(1);
        live()[0].push('{"items":[]}');
        // The tab that took over reads its own connection now.
        expect(other).toEqual([{ data: '{"items":[]}', owner: true }]);
    });

    it("gives every tab its own connection when the browser has no lock to elect with", async () => {
        const second = await anotherTab();
        vi.stubGlobal("navigator", {});
        here();
        second();
        await settle();
        expect(live()).toHaveLength(2);
    });

    it("stops waiting on a tab that went quiet and serves itself", async () => {
        const second = await anotherTab();
        vi.useFakeTimers();
        here();
        const other = second();
        await vi.advanceTimersByTimeAsync(0);
        expect(live()).toHaveLength(1);

        // The holder is still there as far as the lock is concerned, but nothing
        // it sends arrives any more - which is what a frozen background tab looks
        // like from here.
        FakeChannel.delivering = false;
        await vi.advanceTimersByTimeAsync(40000);
        expect(live()).toHaveLength(2);
        live()[1].push('{"items":[]}');
        expect(other).toEqual([{ data: '{"items":[]}', owner: true }]);
    });

    it("keeps waiting while the tab holding the connection is still beating", async () => {
        const second = await anotherTab();
        vi.useFakeTimers();
        here();
        second();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(40000);
        expect(live()).toHaveLength(1);
    });
});

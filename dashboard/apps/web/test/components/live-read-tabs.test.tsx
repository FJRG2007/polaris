// @vitest-environment jsdom

/**
 * Tabs on the same subject share what the server told them.
 *
 * Two windows on one screen used to poll it twice. `useLiveRead` now hands every
 * answer it is given to the other tabs of the same account and build, and a tab
 * that was just handed one puts its own next request back. Pinned here: the
 * answer crosses, it does not cross accounts, an older one never replaces a
 * newer one, a held screen is left alone, and the poll is skipped while a peer's
 * answer is fresh.
 *
 * Two hooks in one test stand in for two tabs: each opens a channel of its own,
 * and the fake below delivers to every other channel of the same name, which is
 * what a BroadcastChannel does between tabs.
 */

import type { ReactNode } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import { act, cleanup, renderHook } from "@testing-library/react";
import { SessionScopeProvider } from "@/components/session-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChannel {
    static live: FakeChannel[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;

    constructor(readonly name: string) {
        FakeChannel.live.push(this);
    }

    postMessage(message: unknown): void {
        const copy = structuredClone(message);
        for (const peer of FakeChannel.live) {
            if (peer !== this && !peer.closed && peer.name === this.name) peer.onmessage?.({ data: copy });
        }
    }

    close(): void {
        this.closed = true;
    }
}

class MemoryStorage {
    private readonly items = new Map<string, string>();
    get length(): number {
        return this.items.size;
    }
    key(index: number): string | null {
        return [...this.items.keys()][index] ?? null;
    }
    getItem(key: string): string | null {
        return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.items.set(key, value);
    }
    removeItem(key: string): void {
        this.items.delete(key);
    }
    clear(): void {
        this.items.clear();
    }
}

interface Reading {
    readonly cpu: number;
}

/** A read whose answers the test hands out by hand. */
function controlledLoad() {
    const pending: Array<(value: Reading) => void> = [];
    const load = vi.fn(() => new Promise<Reading>((resolve) => pending.push(resolve)));
    return { load, answer: (value: Reading) => pending.shift()?.(value) };
}

function tab(
    load: () => Promise<Reading>,
    { account = "user-1", paused = false, intervalMs }: { account?: string; paused?: boolean; intervalMs?: number } = {}
) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <SessionScopeProvider userId={account}>{children}</SessionScopeProvider>
    );
    return renderHook(() => useLiveRead<Reading>({ load, cacheKey: "servers.usage.h1", paused, intervalMs }), {
        wrapper
    });
}

beforeEach(() => {
    FakeChannel.live = [];
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    // Each tab keeps its own session storage; a shared one would carry the
    // answer across by itself and prove nothing.
    vi.stubGlobal("sessionStorage", new MemoryStorage());
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("useLiveRead across tabs", () => {
    it("puts the answer one tab was given on the other tab's screen", async () => {
        const first = controlledLoad();
        const second = controlledLoad();
        const a = tab(first.load);
        const b = tab(second.load);

        await act(async () => first.answer({ cpu: 42 }));

        expect(a.result.current.data).toEqual({ cpu: 42 });
        expect(b.result.current.data).toEqual({ cpu: 42 });
        expect(b.result.current.loading).toBe(false);
    });

    it("hands a value put on screen by replace to the other tab too", async () => {
        const a = tab(controlledLoad().load);
        const b = tab(controlledLoad().load);

        act(() => a.result.current.replace({ cpu: 7 }));

        expect(b.result.current.data).toEqual({ cpu: 7 });
    });

    it("never feeds a tab signed in as somebody else", async () => {
        const first = controlledLoad();
        tab(first.load, { account: "user-1" });
        const other = tab(controlledLoad().load, { account: "user-2" });

        await act(async () => first.answer({ cpu: 42 }));

        expect(other.result.current.data).toBeNull();
    });

    it("keeps a newer reading over an older one another tab hands round", async () => {
        const a = tab(controlledLoad().load);
        const b = tab(controlledLoad().load);

        act(() => b.result.current.replace({ cpu: 9 }));
        const newer = b.result.current.updatedAt ?? 0;
        // A late answer stamped before what B shows, as a slow tab's would be.
        const late = FakeChannel.live.find((channel) => !channel.closed)!;
        act(() => late.postMessage({ kind: "answer", at: newer - 1000, value: { cpu: 1 } }));

        expect(b.result.current.data).toEqual({ cpu: 9 });
        expect(a.result.current.data).toEqual({ cpu: 9 });
    });

    it("leaves a screen that was told to hold still as it is", async () => {
        const first = controlledLoad();
        tab(first.load);
        const held = tab(controlledLoad().load, { paused: true });

        await act(async () => first.answer({ cpu: 42 }));

        expect(held.result.current.data).toBeNull();
    });

    it("skips its own poll while another tab's answer is fresh", async () => {
        vi.useFakeTimers();
        const first = controlledLoad();
        const second = controlledLoad();
        tab(first.load, { intervalMs: 10_000 });
        tab(second.load, { intervalMs: 10_000 });
        expect(second.load).toHaveBeenCalledTimes(1);

        // A answers its mount read and B hears it.
        await act(async () => first.answer({ cpu: 42 }));
        // Past the latest B's turn can come: B skipped it, A - who heard
        // nobody - asked for both.
        await act(async () => vi.advanceTimersByTime(12_600));

        expect(second.load).toHaveBeenCalledTimes(1);
        expect(first.load).toHaveBeenCalledTimes(2);
    });

    it("asks for itself when nobody else is there", async () => {
        vi.useFakeTimers();
        const only = controlledLoad();
        tab(only.load, { intervalMs: 10_000 });
        await act(async () => only.answer({ cpu: 1 }));

        await act(async () => vi.advanceTimersByTime(12_600));

        expect(only.load).toHaveBeenCalledTimes(2);
    });
});

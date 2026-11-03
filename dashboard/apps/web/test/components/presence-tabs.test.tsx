// @vitest-environment jsdom

/**
 * A face drawn in two tabs is asked about once.
 *
 * The presence store refreshes every face on screen on a beat. Each tab used to
 * run that beat for itself, hidden or not, so ten tabs were ten requests every
 * refresh. Now a tab takes the answers its peers were given for the faces it
 * draws, leaves those out of its own refresh, and a hidden tab refreshes nothing.
 */

import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { SessionScopeProvider } from "@/components/session-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceProvider, usePresence } from "@/components/presence-store";

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

const here = { status: "online", note: "", inCall: null };

function tab(id: string) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <SessionScopeProvider userId="user-1">
            <PresenceProvider>{children}</PresenceProvider>
        </SessionScopeProvider>
    );
    return renderHook(() => usePresence(id), { wrapper });
}

/** Requests to the presence endpoint, by the ids each asked about. */
function asked(fetchMock: ReturnType<typeof vi.fn>): string[][] {
    return fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { ids: string[] }).ids);
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
    vi.useFakeTimers();
    FakeChannel.live = [];
    visibility = "visible";
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function answering() {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
        const { ids } = JSON.parse(init.body) as { ids: string[] };
        return new Response(JSON.stringify({ people: Object.fromEntries(ids.map((id) => [id, here])) }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

describe("presence across tabs", () => {
    it("draws the dot another tab was told about, and leaves it out of its own refresh", async () => {
        const fetchMock = answering();
        const a = tab("u-2");
        await act(async () => vi.advanceTimersByTime(100));
        expect(a.result.current?.status).toBe("online");

        // The second tab mounts later and asks once, on its first draw.
        const b = tab("u-2");
        await act(async () => vi.advanceTimersByTime(100));
        expect(b.result.current?.status).toBe("online");
        const before = asked(fetchMock).length;

        // One full beat, past the latest either tab's turn can come.
        await act(async () => vi.advanceTimersByTime(57_000));

        // Whichever tab went first asked for both; the other heard it and skipped.
        expect(asked(fetchMock).length - before).toBe(1);
    });

    it("refreshes nothing while hidden, and catches up when looked at again", async () => {
        const fetchMock = answering();
        tab("u-3");
        await act(async () => vi.advanceTimersByTime(100));
        const first = asked(fetchMock).length;

        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        await act(async () => vi.advanceTimersByTime(120_000));
        expect(asked(fetchMock).length).toBe(first);

        visibility = "visible";
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
            await vi.advanceTimersByTimeAsync(10);
        });
        expect(asked(fetchMock).length).toBe(first + 1);
    });
});

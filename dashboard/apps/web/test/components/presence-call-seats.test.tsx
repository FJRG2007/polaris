// @vitest-environment jsdom

/**
 * Hanging up takes the call's speaker off a face at once.
 *
 * The presence store only refreshed on its beat, and a call frame names the
 * call, not the person who left it - so after hanging up the speaker stayed
 * beside the face, the hung-up person's own included, until the next refresh.
 * A seat change now asks again for every face on screen.
 */

import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { SessionScopeProvider } from "@/components/session-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceCallSeats, PresenceProvider, usePresence } from "@/components/presence-store";

let inCall: string | null = "channel-1";

function wrapper({ children }: { children: ReactNode }) {
    return (
        <SessionScopeProvider userId="user-1">
            <PresenceProvider>{children}</PresenceProvider>
        </SessionScopeProvider>
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
            const { ids } = JSON.parse(init.body) as { ids: string[] };
            const people = Object.fromEntries(ids.map((id) => [id, { status: "online", note: "", inCall }]));
            return new Response(JSON.stringify({ people }));
        })
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("a call seat changing", () => {
    it("redraws the faces on screen without waiting for the next refresh", async () => {
        const { result } = renderHook(() => usePresence("user-2"), { wrapper });
        await act(async () => vi.advanceTimersByTime(100));
        expect(result.current?.inCall).toBe("channel-1");

        inCall = null;
        await act(async () => {
            announceCallSeats();
            await vi.advanceTimersByTimeAsync(10);
        });
        expect(result.current?.inCall).toBeNull();
    });

    it("asks nothing when no face is drawn", async () => {
        const fetchMock = vi.mocked(fetch);
        announceCallSeats();
        await vi.advanceTimersByTimeAsync(10);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

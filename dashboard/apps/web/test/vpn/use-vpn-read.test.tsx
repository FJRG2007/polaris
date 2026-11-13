// @vitest-environment jsdom

/**
 * A VPN read that loses its request on the way.
 *
 * Connecting from the app brings a tunnel up and moves every route, so the read
 * asked right after it lost its request and the page said "The VPN did not
 * answer" over a connection that was working. Pinned: a request cut once is
 * asked again before anything is said, and a read that never answers still
 * ends in the failure sentence.
 */

import { useVpnRead } from "@/app/(app)/vpn/use-vpn-read";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function settle(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("a VPN read", () => {
    it("asks again when the request was cut, and shows no failure", async () => {
        const load = vi
            .fn<() => Promise<{ value: number }>>()
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValue({ value: 1 });
        const { result } = renderHook(() => useVpnRead("retry-ok", load, "did not answer"));
        await settle();
        expect(result.current.error).toBeNull();
        await settle(1_000);
        expect(load).toHaveBeenCalledTimes(2);
        expect(result.current.error).toBeNull();
        expect(result.current.data).toEqual({ value: 1 });
    });

    it("says it failed once every retry is spent", async () => {
        const load = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
        const { result } = renderHook(() => useVpnRead("retry-spent", load, "did not answer"));
        await settle(1_000);
        await settle(2_000);
        expect(result.current.error).toBeNull();
        await settle(4_000);
        expect(load).toHaveBeenCalledTimes(4);
        expect(result.current.error).toBe("did not answer");
    });
});

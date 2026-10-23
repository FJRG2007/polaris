/**
 * The browser's view of the server's internet line: read from `/api/version`,
 * asked again sooner while offline, and left alone by a failed ask.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let answers: Array<unknown>;

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    answers = [];
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            const next = answers.shift();
            if (next instanceof Error) throw next;
            return new Response(JSON.stringify(next ?? { build: "b" }));
        })
    );
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("host-internet", () => {
    it("reads the flag the version route answers", async () => {
        const { offlineFrom } = await import("@/lib/host-internet");
        expect(offlineFrom({ build: "b", internet: false })).toBe(true);
        expect(offlineFrom({ build: "b", internet: true })).toBe(false);
        expect(offlineFrom({ build: "b" })).toBeNull();
        expect(offlineFrom(null)).toBeNull();
    });

    it("tells subscribers once when the server goes offline and once when it is back", async () => {
        const { hostOffline, subscribeHostOffline } = await import("@/lib/host-internet");
        const told = vi.fn();
        answers.push({ internet: false }, { internet: false }, { internet: true });
        const stop = subscribeHostOffline(told);
        await vi.advanceTimersByTimeAsync(0);
        expect(hostOffline()).toBe(true);
        expect(told).toHaveBeenCalledTimes(1);

        // Asked again within fifteen seconds while offline, not a minute.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(told).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(hostOffline()).toBe(false);
        expect(told).toHaveBeenCalledTimes(2);
        stop();
    });

    it("keeps what it knew when the ask fails, and stops asking with nobody listening", async () => {
        const { hostOffline, subscribeHostOffline } = await import("@/lib/host-internet");
        answers.push({ internet: false }, new TypeError("Failed to fetch"));
        const stop = subscribeHostOffline(() => undefined);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(hostOffline()).toBe(true);
        stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

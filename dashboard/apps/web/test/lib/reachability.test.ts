/**
 * Telling "Polaris is not answering" from "this device is offline", cheaply.
 *
 * Pinned: nothing is asked until something the app was doing fails the way an
 * unreachable server makes it fail; one probe however many things fail at once;
 * a captive portal's 200 is not Polaris answering; the probes back off while it
 * stays down; and a refusal the server made is not mistaken for silence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    isNetworkFailure,
    noteRequestFailure,
    noteResponseStatus,
    probeNow,
    reachability,
    resetReachability
} from "@/lib/reachability";
import { runAction } from "@/lib/run-action";

vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => false }));

let reply: () => Promise<Response> = async () => polaris();
const fetchMock = vi.fn(() => reply());

function polaris(): Response {
    return new Response(JSON.stringify({ build: null }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
    reply = async () => polaris();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { onLine: true });
    resetReachability();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** Let a probe started by a signal settle. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

describe("what counts as a request that got no answer", () => {
    it("is fetch's own failure and a proxy standing in for the server", () => {
        expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
        expect(isNetworkFailure(new Error("An unexpected response was received from the server."))).toBe(true);
    });

    it("is not a refusal, and not a request this page cancelled", () => {
        expect(isNetworkFailure(new Error("You do not have access to this."))).toBe(false);
        const aborted = new Error("The operation was aborted.");
        aborted.name = "AbortError";
        expect(isNetworkFailure(aborted)).toBe(false);
    });
});

describe("asking whether Polaris answers", () => {
    it("asks nothing for a failure the server made", async () => {
        noteRequestFailure(new Error("Name is required"));
        noteResponseStatus(500);
        noteResponseStatus(404);
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("asks once however many requests fail together", async () => {
        reply = async () => Promise.reject(new TypeError("Failed to fetch"));
        noteRequestFailure(new TypeError("Failed to fetch"));
        noteRequestFailure(new TypeError("Failed to fetch"));
        noteResponseStatus(502);
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(reachability().reachable).toBe(false);
    });

    it("does not take a captive portal's page for Polaris", async () => {
        reply = async () => new Response("<html>Sign in to the Wi-Fi</html>", { headers: { "content-type": "text/html" } });
        noteResponseStatus(503);
        await settle();
        expect(reachability().reachable).toBe(false);
    });

    it("backs off while Polaris stays down, and says so once it is back", async () => {
        reply = async () => Promise.reject(new TypeError("Failed to fetch"));
        noteRequestFailure(new TypeError("Failed to fetch"));
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // The next wait is longer than the first.
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        reply = async () => polaris();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(reachability()).toEqual({ reachable: true, recoveries: 1 });
        // And stops asking once it answers.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("leaves an offline device to the offline banner", async () => {
        vi.stubGlobal("navigator", { onLine: false });
        noteRequestFailure(new TypeError("Failed to fetch"));
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is started by an action that got no answer", async () => {
        reply = async () => Promise.reject(new TypeError("Failed to fetch"));
        const failures: string[] = [];
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await runAction(() => Promise.reject(new TypeError("Failed to fetch")), (message) => failures.push(message));
        await settle();
        expect(failures).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/version", expect.objectContaining({ cache: "no-store" }));
        expect(reachability().reachable).toBe(false);
    });

    it("answers a direct question at once", async () => {
        expect(await probeNow()).toBe(true);
        expect(reachability()).toEqual({ reachable: true, recoveries: 0 });
    });
});

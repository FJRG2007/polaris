/**
 * Telling "your domain is down" apart from "this box has no way out".
 *
 * Polaris probes its own address from inside the container, so a silence means
 * one of two completely different things - and confused, the second wears the
 * first one's clothes: somebody is sent to check DNS records for a domain that is
 * fine, on a morning when the router is unplugged.
 *
 * The direction that matters most here is the conservative one. Claiming the line
 * is down when it is not rewrites a real alert into a wrong one, so anything that
 * proves a connection reached something - a certificate this process will not
 * accept, an HTTP error, a protocol complaint - counts as reachable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

const { forgetInternetReach, hasInternet } = await import("../../src/lib/internet-reach");

/** What Node throws when a connection never happened. */
function networkError(code: string): Error {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = { code };
    return error;
}

beforeEach(() => {
    vi.clearAllMocks();
    forgetInternetReach();
    // Stubbed here and taken away again below. A global replaced at module scope
    // stays replaced for every other file sharing this worker - which is a whole
    // suite quietly fetching a mock written for these eight cases.
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    forgetInternetReach();
});

describe("when the line is up", () => {
    it("says so as soon as one landmark answers", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
        expect(await hasInternet()).toBe(true);
    });

    it("says so on a certificate this process will not accept", async () => {
        // The handshake crossed the network to be rejected, which is the whole
        // question - and reporting the line as down over it would be the wrong
        // alert.
        fetchMock.mockRejectedValue(networkError("ERR_TLS_CERT_ALTNAME_INVALID"));
        expect(await hasInternet()).toBe(true);
    });

    it("says so when one is silent and the other is not", async () => {
        // One resolver being unreachable is a fact about that resolver.
        fetchMock
            .mockRejectedValueOnce(networkError("ECONNREFUSED"))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        expect(await hasInternet()).toBe(true);
    });
});

describe("when there is no way out", () => {
    it("needs every landmark to be silent before it says so", async () => {
        fetchMock.mockRejectedValue(networkError("ENETUNREACH"));
        expect(await hasInternet()).toBe(false);
    });

    it("counts a timeout as no route", async () => {
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        fetchMock.mockRejectedValue(timeout);
        expect(await hasInternet()).toBe(false);
    });

    it("counts a name that will not resolve as no route", async () => {
        fetchMock.mockRejectedValue(networkError("EAI_AGAIN"));
        expect(await hasInternet()).toBe(false);
    });
});

describe("asking twice", () => {
    it("remembers the answer for a while", async () => {
        // Every address in a sweep asks this, and "is the line up" does not change
        // minute to minute.
        fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
        const now = Date.now();
        await hasInternet(now);
        await hasInternet(now + 1000);
        expect(fetchMock).toHaveBeenCalledTimes(2); // one pass, two landmarks
    });

    it("asks again once the answer is stale", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
        const now = Date.now();
        await hasInternet(now);
        await hasInternet(now + 120_000);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
});

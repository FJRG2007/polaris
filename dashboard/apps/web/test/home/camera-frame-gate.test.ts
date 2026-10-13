/**
 * A frame request the relay cannot answer is not asked again and again.
 *
 * The relay holds a frame request open until the camera sends a keyframe, and
 * it does not let go of one whose caller gave up. Against a stalled camera every
 * tile refresh added another waiting request - dozens of them - so a stream
 * has one request out at a time, and after one runs out of time the stream is
 * left alone for a short while instead of being asked again at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    FRAME_PAUSE_MS,
    frameOrReason,
    snapshot,
    type RelayEndpoint
} from "@polaris-app/places/src/lib/relay";

let fixture = 0;
let ENDPOINT: RelayEndpoint;

/** A relay that never answers a frame: the request waits until it is aborted. */
function silentRelay() {
    return vi.fn(
        (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                    reject(new DOMException("aborted", "AbortError"))
                );
            })
    );
}

beforeEach(() => {
    // A relay of its own per test, so no pause carries over between them.
    fixture += 1;
    ENDPOINT = {
        installedAppId: "relay-fixture",
        baseUrl: `http://relay-${fixture}.invalid:1984`,
        username: "polaris",
        password: "fixture-password"
    } as unknown as RelayEndpoint;
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("frame requests to the relay", () => {
    it("share one request between callers asking for the same frame at once", async () => {
        const fetched = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
        vi.stubGlobal("fetch", fetched);
        const [a, b] = await Promise.all([
            snapshot(ENDPOINT, "cam1", "sub", { width: 640 }),
            snapshot(ENDPOINT, "cam1", "sub", { width: 640 })
        ]);
        expect(fetched).toHaveBeenCalledTimes(1);
        expect(a?.length).toBe(3);
        expect(b?.length).toBe(3);
    });

    it("leave a stream alone for a while after a request runs out of time", async () => {
        const fetched = silentRelay();
        vi.stubGlobal("fetch", fetched);
        const first = snapshot(ENDPOINT, "cam1", "sub", { width: 640 });
        await vi.advanceTimersByTimeAsync(8000);
        expect(await first).toBeNull();
        expect(fetched).toHaveBeenCalledTimes(1);

        // Asked again at once, by a tile or by the check: answered here.
        expect(await snapshot(ENDPOINT, "cam1", "sub", { width: 320 })).toBeNull();
        expect(await frameOrReason(ENDPOINT, "cam1", "sub")).toEqual({
            reason: "The camera is not sending a picture."
        });
        expect(fetched).toHaveBeenCalledTimes(1);

        // And asked again once the pause is over.
        await vi.advanceTimersByTimeAsync(FRAME_PAUSE_MS);
        void snapshot(ENDPOINT, "cam1", "sub", { width: 640 });
        expect(fetched).toHaveBeenCalledTimes(2);
    });

    it("let a caller who leaves go without cancelling the request for the rest", async () => {
        vi.stubGlobal("fetch", silentRelay());
        const leaving = new AbortController();
        const asked = snapshot(ENDPOINT, "cam1", "sub", { signal: leaving.signal });
        leaving.abort();
        expect(await asked).toBeNull();
        // A viewer closing its tab is not the camera stalling.
        void snapshot(ENDPOINT, "cam1", "sub");
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
});

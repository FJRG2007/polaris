/**
 * Cameras the relay keeps connected with nobody watching.
 *
 * A relay dials a camera when somebody asks to watch it, so every opening paid
 * for a fresh conversation with the camera before there was a frame to send.
 * Keeping the good stream warm takes that off the time to a picture. The rules
 * about which cameras are kept, and about what is sent to the relay, are pinned
 * here: a battery camera held open is a flat battery, and a warm connection
 * left on a stream the relay replaced is a second connection to a camera that
 * nothing can see or close.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    keepsWarm,
    publishCamera,
    streamName,
    unpublishCamera,
    warmPlan,
    warmStreams,
    type RelayEndpoint
} from "@polaris-app/places/src/lib/relay";

const ENDPOINT = {
    installedAppId: "relay-fixture",
    baseUrl: "http://relay.invalid:1984",
    username: "polaris",
    password: "fixture-password"
} as unknown as RelayEndpoint;

const wired = { id: "cam1", enabled: true, power: "mains", vendor: "tapo" };

describe("which cameras are kept warm", () => {
    it("keeps a wired camera that is switched on", () => {
        expect(keepsWarm(wired)).toBe(true);
    });

    it("never keeps one that runs on a battery, whatever its make says", () => {
        expect(keepsWarm({ ...wired, power: "battery" })).toBe(false);
        expect(keepsWarm({ ...wired, power: "battery-solar" })).toBe(false);
        expect(keepsWarm({ ...wired, vendor: "tapo-battery" })).toBe(false);
    });

    it("never keeps one that is switched off", () => {
        expect(keepsWarm({ ...wired, enabled: false })).toBe(false);
    });
});

describe("bringing a relay to the right set", () => {
    const main = streamName("cam1", "main");

    it("warms a wanted camera the relay is serving and is not yet holding", () => {
        expect(warmPlan([wired], [main, streamName("cam1", "sub")], [])).toEqual({
            add: [main],
            drop: []
        });
    });

    it("sends nothing when the relay already holds exactly that", () => {
        // Told again, a relay drops the camera and dials it afresh.
        expect(warmPlan([wired], [main], [main])).toEqual({ add: [], drop: [] });
    });

    it("does not ask a relay to hold a stream it was never given", () => {
        expect(warmPlan([wired], [], [])).toEqual({ add: [], drop: [] });
    });

    it("lets go of a camera switched off, moved to a battery or deleted", () => {
        expect(warmPlan([{ ...wired, enabled: false }], [main], [main]).drop).toEqual([main]);
        expect(warmPlan([{ ...wired, power: "battery" }], [main], [main]).drop).toEqual([main]);
        expect(warmPlan([], [main], [main, "gone-main"]).drop).toEqual([main, "gone-main"]);
    });
});

describe("what is sent to the relay", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** Every call the relay would see, as method and path with its stream. */
    function recordCalls(status = 200): { method: string; path: string; src: string }[] {
        const calls: { method: string; path: string; src: string }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: { method?: string }) => {
                const parsed = new URL(url);
                calls.push({
                    method: init.method ?? "GET",
                    path: parsed.pathname,
                    src: parsed.searchParams.get("name") ?? parsed.searchParams.get("src") ?? ""
                });
                return new Response("{}", { status });
            })
        );
        return calls;
    }

    const target = {
        id: "cam1",
        name: "Door",
        address: "192.0.2.10",
        rtspPort: 554,
        onvifPort: 2020,
        username: "fixture",
        password: "fixture",
        reachVia: "local",
        mainUrl: "rtsp://192.0.2.10:554/stream1",
        subUrl: "rtsp://192.0.2.10:554/stream2"
    };

    it("points the warm connection at the stream again after every publish", async () => {
        const calls = recordCalls();
        await publishCamera(ENDPOINT, target, "tapo", { warm: true });
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
            "PUT /api/streams",
            "PUT /api/streams",
            "PUT /api/preload"
        ]);
        expect(calls[2]!.src).toBe(streamName("cam1", "main"));
    });

    it("lets it go on publish when the camera is not to be kept", async () => {
        const calls = recordCalls();
        await publishCamera(ENDPOINT, target, "tapo", { warm: false });
        expect(calls[2]).toEqual({
            method: "DELETE",
            path: "/api/preload",
            src: streamName("cam1", "main")
        });
    });

    it("lets go of the warm connection before forgetting the stream", async () => {
        const calls = recordCalls();
        await unpublishCamera(ENDPOINT, "cam1");
        expect(calls.map((call) => `${call.method} ${call.path} ${call.src}`)).toEqual([
            `DELETE /api/preload ${streamName("cam1", "main")}`,
            `DELETE /api/streams ${streamName("cam1", "main")}`,
            `DELETE /api/preload ${streamName("cam1", "sub")}`,
            `DELETE /api/streams ${streamName("cam1", "sub")}`
        ]);
    });

    it("reads a relay too old to be asked as unknown, not as holding nothing", async () => {
        recordCalls(403);
        expect(await warmStreams(ENDPOINT)).toBeNull();
    });

    it("reads what a relay holds by stream name", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({ [streamName("cam1", "main")]: { query: "video&audio" } })
            )
        );
        expect(await warmStreams(ENDPOINT)).toEqual([streamName("cam1", "main")]);
    });

    it("does not fail a publish because the relay would not keep it warm", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async (url: string) =>
                    new Response("", { status: url.includes("/api/preload") ? 403 : 200 })
            )
        );
        await expect(
            publishCamera(ENDPOINT, target, "tapo", { warm: true })
        ).resolves.toBeUndefined();
    });
});

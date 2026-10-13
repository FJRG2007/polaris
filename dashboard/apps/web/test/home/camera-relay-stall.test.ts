/**
 * A relay stream that stalls is noticed and the relay restarted.
 *
 * A camera connection the relay holds can stop delivering without closing: the
 * producer stays listed, its byte count stops moving, and every frame and stream
 * asked of it waits forever. Replacing or deleting the stream does not close
 * that connection, and a camera that caps its sessions then refuses a new one -
 * so the relay itself is restarted, which closes them all and reopens every
 * camera from its file.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    RELAY_RESTART_COOLDOWN_MS,
    relayTraffic,
    restartDue,
    restartRelay,
    stalledStreams,
    streamTraffic,
    type RelayEndpoint
} from "@polaris-app/places/src/lib/relay";

const ENDPOINT = {
    installedAppId: "relay-fixture",
    baseUrl: "http://relay.invalid:1984",
    username: "polaris",
    password: "fixture-password"
} as unknown as RelayEndpoint;

/** `GET /api/streams` as go2rtc answers it: a connected producer carries its
 *  byte count, one that is not connected only its address. */
const STREAMS = {
    "cam1-main": {
        producers: [{ url: "rtsp://x", bytes_recv: 1000 }],
        consumers: [{ type: "keyframe" }]
    },
    "cam1-sub": { producers: [{ url: "rtsp://x" }], consumers: [] },
    "cam2-main": { producers: [{ url: "rtsp://y", bytes_recv: 50 }], consumers: [] }
};

afterEach(() => vi.unstubAllGlobals());

describe("what the relay is receiving", () => {
    it("counts only connected producers that somebody is waiting on", () => {
        // An idle stream is not a stalled one: nothing asked it for anything.
        expect(streamTraffic(STREAMS)).toEqual({ "cam1-main": 1000 });
    });

    it("is asked of the relay, and nothing when the relay does not answer", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify(STREAMS)))
        );
        expect(await relayTraffic(ENDPOINT)).toEqual({ "cam1-main": 1000 });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("", { status: 502 }))
        );
        expect(await relayTraffic(ENDPOINT)).toBeNull();
    });
});

describe("a stalled stream", () => {
    it("is one whose byte count did not move between two looks", () => {
        expect(stalledStreams({ a: 10, b: 10 }, { a: 10, b: 20 })).toEqual(["a"]);
    });

    it("needs two looks: the first tells nothing", () => {
        expect(stalledStreams(undefined, { a: 10 })).toEqual([]);
        expect(stalledStreams({}, { a: 10 })).toEqual([]);
    });

    it("restarts the relay at most once per cooldown", () => {
        const now = 1_000_000_000;
        expect(restartDue(["a"], undefined, now)).toBe(true);
        expect(restartDue([], undefined, now)).toBe(false);
        expect(restartDue(["a"], now - 1000, now)).toBe(false);
        expect(restartDue(["a"], now - RELAY_RESTART_COOLDOWN_MS, now)).toBe(true);
    });
});

describe("restarting the relay", () => {
    it("posts the relay's own restart, which the relay's allowlist lets through", async () => {
        const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(""));
        vi.stubGlobal("fetch", fetched);
        expect(await restartRelay(ENDPOINT)).toBe(true);
        expect(fetched.mock.calls[0]?.[0]).toBe("http://relay.invalid:1984/api/restart");
        expect(fetched.mock.calls[0]?.[1]?.method).toBe("POST");

        const entrypoint = readFileSync(
            new URL("../../../../services/camera-relay/entrypoint.sh", import.meta.url),
            "utf8"
        );
        expect(entrypoint).toMatch(/^\s+- \/api\/restart$/m);
    });
});

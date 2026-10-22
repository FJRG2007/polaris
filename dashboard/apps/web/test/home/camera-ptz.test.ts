/**
 * Pointing a camera that answers slowly.
 *
 * A Tapo C200 serves ONVIF one request at a time, so an arrow press waits behind
 * whatever else is open on it. These hold the three things that keep that from
 * becoming a camera left moving: the events pull never gives up before the
 * camera was due to answer, every start carries the camera's own stop timer,
 * and a start that answers after the release is followed by another stop.
 */

import {
    continuousMoveBody,
    MOVE_LIMIT_SECONDS,
    pullTimeoutMs,
    PULL_WAIT_SECONDS,
    ptzMove,
    recentlySteered,
    STEERING_GRACE_MS
} from "@polaris-app/places/src/lib/onvif";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("the events pull", () => {
    it("waits longer for an answer than it asked the camera to wait", () => {
        for (const wait of [1, PULL_WAIT_SECONDS, 20, 60]) {
            expect(pullTimeoutMs(wait)).toBeGreaterThan(wait * 1000);
        }
    });

    it("asks for a short wait, which is how long an arrow can sit behind it", () => {
        expect(PULL_WAIT_SECONDS).toBeLessThanOrEqual(3);
    });
});

describe("the start of a move", () => {
    const vector = { pan: 0.5, tilt: 0, zoom: 0 };

    it("carries the camera's own stop timer after the velocity", () => {
        const body = continuousMoveBody("profile_1", vector, MOVE_LIMIT_SECONDS);
        expect(body).toContain(`<Timeout>PT${MOVE_LIMIT_SECONDS}S</Timeout>`);
        expect(body.indexOf("<Timeout>")).toBeGreaterThan(body.indexOf("</Velocity>"));
    });

    it("leaves the timer out when told to", () => {
        expect(continuousMoveBody("profile_1", vector, null)).not.toContain("Timeout");
    });

    it("clamps the speed and escapes the profile token", () => {
        const body = continuousMoveBody("a<b", { pan: 4, tilt: -4, zoom: 0 }, null);
        expect(body).toContain('x="1.00" y="-1.00"');
        expect(body).toContain("a&lt;b");
    });
});

describe("a camera that refuses the stop timer", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("is sent the move again without it, and remembered", async () => {
        const bodies: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init: { body: string }) => {
                bodies.push(init.body);
                if (init.body.includes("<Timeout>")) {
                    return new Response("<s:Fault><s:Text>Invalid args</s:Text></s:Fault>", {
                        status: 400
                    });
                }
                return new Response("<ok/>", { status: 200 });
            })
        );
        const endpoint = { address: "10.0.9.1", port: 2020 };
        await ptzMove(endpoint, "profile_1", { pan: 0.5, tilt: 0, zoom: 0 });
        const moves = bodies.filter((body) => body.includes("ContinuousMove"));
        expect(moves).toHaveLength(2);
        expect(moves[1]).not.toContain("<Timeout>");
        expect(recentlySteered(endpoint)).toBe(true);
        expect(
            recentlySteered(endpoint, STEERING_GRACE_MS, Date.now() + STEERING_GRACE_MS + 1)
        ).toBe(false);

        bodies.length = 0;
        await ptzMove(endpoint, "profile_1", { pan: -0.5, tilt: 0, zoom: 0 });
        expect(bodies.filter((body) => body.includes("ContinuousMove"))).toHaveLength(1);
    });

    it("is not sent a second move when the first one only went unanswered", async () => {
        const bodies: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init: { body: string }) => {
                bodies.push(init.body);
                if (init.body.includes("ContinuousMove")) {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    throw error;
                }
                return new Response("<ok/>", { status: 200 });
            })
        );
        await expect(
            ptzMove({ address: "10.0.9.2", port: 2020 }, "profile_1", {
                pan: 0.5,
                tilt: 0,
                zoom: 0
            })
        ).rejects.toMatchObject({ failure: "timeout" });
        expect(bodies.filter((body) => body.includes("ContinuousMove"))).toHaveLength(1);
    });
});

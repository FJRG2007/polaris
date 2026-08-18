/**
 * How much picture a call sends.
 *
 * Three things are asserted here and each of them is a bug that shipped once.
 *
 * The first is that every size asked of a camera is `ideal`. An exact width a
 * webcam cannot meet is an `OverconstrainedError`, and a quality setting that
 * can leave somebody with no picture at all is worse than no setting.
 *
 * The second is that the bits and the pixels move together. A rung that raised
 * the resolution and left the allowance behind would send a bigger, softer
 * picture than the rung below it - the setting appearing to do the opposite of
 * what it says.
 *
 * The third is the shape of the automatic walk. It asks for the best rung there
 * is and comes down only on evidence - the encoder naming what is holding it
 * back, or the frames plainly not arriving - then climbs again after a run of
 * clean readings, and takes three times as long to climb back into a rung that
 * has already failed once. Symmetrical hysteresis is how a call oscillates
 * between two qualities for an hour instead of settling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true
});

const quality = await import("@/app/(app)/chat/call-quality");

const {
    CAMERA_LADDER,
    HEALTHY_TO_CLIMB,
    HEALTHY_TO_RETRY,
    LEVELS,
    SCREEN_LADDER,
    cameraConstraints,
    cameraQuality,
    driftAuto,
    encodingFor,
    levelOf,
    screenConstraints,
    screenIsMotion,
    screenQuality,
    setCameraQuality,
    setScreenQuality,
    shift,
    startAuto
} = quality;

beforeEach(() => {
    store.clear();
});

describe("the setting", () => {
    it("lets the connection decide for somebody who has never touched it", () => {
        expect(cameraQuality()).toBe("auto");
        expect(screenQuality()).toBe("auto");
    });

    it("remembers each rung, on each ladder, without the two crossing", () => {
        setCameraQuality("max");
        setScreenQuality("low");
        expect(cameraQuality()).toBe("max");
        expect(screenQuality()).toBe("low");
    });

    it("stores nothing for the default, so it is not a value to migrate later", () => {
        setCameraQuality("high");
        setCameraQuality("auto");
        expect(store.size).toBe(0);
    });

    it("treats anything else as unset", () => {
        // Local storage belongs to whoever owns the browser, and a width chosen
        // by editing it is a width nobody wrote.
        store.set("polaris.call.quality.camera", "4k-please");
        expect(cameraQuality()).toBe("auto");
    });
});

describe("what the camera is asked for", () => {
    it("asks for every size as a preference, never as a requirement", () => {
        for (const level of LEVELS) {
            const want = cameraConstraints(level);
            // The failure this prevents: a laptop camera that tops out at 720p
            // being handed an exact 1080p, refusing, and the call carrying no
            // picture at all rather than a smaller one.
            expect(want.width).toEqual({ ideal: CAMERA_LADDER.rungs[level].width });
            expect(want.height).toEqual({ ideal: CAMERA_LADDER.rungs[level].height });
            expect(want.frameRate).toEqual({ ideal: CAMERA_LADDER.rungs[level].frameRate });
        }
    });

    it("names a chosen device exactly, because opening a different one is worse", () => {
        expect(cameraConstraints("high", "cam-2").deviceId).toEqual({ exact: "cam-2" });
    });

    it("leaves the device out when nobody has picked one", () => {
        expect(cameraConstraints("high").deviceId).toBeUndefined();
    });

    it("asks for a real size at the bottom of the ladder", () => {
        // The rung that exists for a call on tethered data still has to be a
        // picture. A zero here would be a black tile that costs bandwidth.
        expect(CAMERA_LADDER.rungs.low.width).toBeGreaterThan(0);
    });
});

describe("what a screen is asked for", () => {
    it("names no size at all on the top rung", () => {
        // "The display's own resolution" is expressed by asking for nothing.
        // Naming one on Safari caps the capture far below what was asked for,
        // so the top rung would come out smaller than the one beneath it.
        const want = screenConstraints("max");
        expect(want.width).toBeUndefined();
        expect(want.height).toBeUndefined();
        expect(want.frameRate).toEqual({ ideal: 30 });
    });

    it("caps the size on every rung below it", () => {
        for (const level of ["low", "medium", "high"] as const) {
            expect(screenConstraints(level).width).toEqual({
                ideal: SCREEN_LADDER.rungs[level].width
            });
        }
    });

    it("calls the fast rungs motion and the slow ones detail", () => {
        // Which of the two a screen is decides what the encoder gives up first,
        // and the framerate is exactly what somebody was choosing between:
        // nobody asks for five frames a second to watch a video on.
        expect(screenIsMotion("low")).toBe(false);
        expect(screenIsMotion("medium")).toBe(false);
        expect(screenIsMotion("high")).toBe(true);
        expect(screenIsMotion("max")).toBe(true);
    });
});

describe("the ladders themselves", () => {
    it("never gives a bigger picture a smaller allowance", () => {
        for (const ladder of [CAMERA_LADDER, SCREEN_LADDER]) {
            const bitrates = LEVELS.map((level) => ladder.rungs[level].maxBitrate);
            const climbing = [...bitrates].sort((a, b) => a - b);
            expect(bitrates).toEqual(climbing);
        }
    });

    it("hands the encoder the framerate of the rung it is on", () => {
        // The pair has to come from one place. Read separately they drifted: a
        // 5 fps capture with a 30 fps allowance spends the whole budget waiting
        // for frames that never arrive.
        for (const level of LEVELS) {
            expect(encodingFor(SCREEN_LADDER, level)).toEqual({
                maxBitrate: SCREEN_LADDER.rungs[level].maxBitrate,
                maxFramerate: SCREEN_LADDER.rungs[level].frameRate
            });
        }
    });

    it("lets the automatic walk reach the top rung", () => {
        // The whole point of reading the encoder rather than guessing: ask for
        // the best there is and listen for a complaint, rather than settling for
        // the middle and never finding out what the line could have carried.
        expect(CAMERA_LADDER.ceiling).toBe("max");
        expect(SCREEN_LADDER.ceiling).toBe("max");
    });
});

describe("which rung is in force", () => {
    it("is the one chosen, when one was", () => {
        expect(levelOf("low", "high")).toBe("low");
    });

    it("is the connection's answer under automatic", () => {
        expect(levelOf("auto", "medium")).toBe("medium");
    });
});

describe("the automatic walk", () => {
    const camera = () => startAuto(CAMERA_LADDER);
    /** A reading with nothing wrong in it. */
    const clean = { connection: "excellent", limitation: "none", fps: 30 };

    it("starts at the very top", () => {
        // Greedy on purpose. A line is presumed fine until it says otherwise -
        // starting cautiously and working up means every call opens soft, and
        // most calls are short enough that it never gets there.
        expect(camera().level).toBe("max");
    });

    it("drops a rung on the first poor reading", () => {
        expect(driftAuto(camera(), { connection: "poor" }, CAMERA_LADDER).level).toBe("high");
    });

    it("treats a lost connection the same way", () => {
        expect(driftAuto(camera(), { connection: "lost" }, CAMERA_LADDER).level).toBe("high");
    });

    it("drops when the encoder says the line cannot carry it", () => {
        // The reading that makes greed safe: the encoder naming what is holding
        // it back, while it is happening, rather than packets going missing
        // afterwards.
        const after = driftAuto(
            camera(),
            { connection: "excellent", limitation: "bandwidth", fps: 30 },
            CAMERA_LADDER
        );
        expect(after.level).toBe("high");
    });

    it("drops when the encoder says the machine cannot encode it", () => {
        const after = driftAuto(
            camera(),
            { connection: "excellent", limitation: "cpu", fps: 30 },
            CAMERA_LADDER
        );
        expect(after.level).toBe("high");
    });

    it("drops when the frames stop arriving, whatever anything else claims", () => {
        // The freeze somebody actually notices. Half of what the rung asked for
        // is far enough down that a camera in a dim room does not trip it.
        const after = driftAuto(
            camera(),
            { connection: "excellent", limitation: "none", fps: 8 },
            CAMERA_LADDER
        );
        expect(after.level).toBe("high");
    });

    it("does not read a still screen as a stall", () => {
        // A screen nobody is touching encodes almost nothing, because there is
        // no new picture to send. Counting frames there would walk a document
        // down to 720p for doing its job perfectly - so the screen sends none.
        const after = driftAuto(
            startAuto(SCREEN_LADDER),
            { connection: "excellent", limitation: "none" },
            SCREEN_LADDER
        );
        expect(after.level).toBe("max");
    });

    it("will not drop below the floor, however bad it gets", () => {
        let state = { level: CAMERA_LADDER.floor, healthy: 0 };
        for (let attempt = 0; attempt < 5; attempt += 1) {
            state = driftAuto(state, { connection: "poor" }, CAMERA_LADDER);
        }
        expect(state.level).toBe(CAMERA_LADDER.floor);
    });

    it("blames nothing when it is already at the floor", () => {
        // Otherwise the bottom rung is marked as the one that failed, and
        // climbing out of a bad patch takes three times as long as it should.
        const after = driftAuto(
            { level: CAMERA_LADDER.floor, healthy: 0 },
            { connection: "poor" },
            CAMERA_LADDER
        );
        expect(after.blocked).toBeUndefined();
    });

    it("holds while the encoder is trimming something, even on a clean line", () => {
        // Not struggling is not the same as having room to spare. An encoder
        // already holding back is no evidence that a bigger picture would
        // arrive intact.
        const after = driftAuto(
            { level: "medium", healthy: 3 },
            { connection: "excellent", limitation: "other", fps: 24 },
            CAMERA_LADDER
        );
        expect(after.level).toBe("medium");
        expect(after.healthy).toBe(0);
    });

    it("holds on a reading nobody understands", () => {
        const after = driftAuto({ level: "low", healthy: 2 }, { connection: "unknown" }, CAMERA_LADDER);
        expect(after.level).toBe("low");
        expect(after.healthy).toBe(0);
    });

    it("climbs on a merely good line, since nothing is complaining", () => {
        // "Excellent" is rarer than it sounds, and waiting for it on a line that
        // is plainly fine is how the top rung never gets used.
        let state = { level: "low" as const, healthy: HEALTHY_TO_CLIMB - 1 };
        expect(driftAuto(state, { connection: "good", limitation: "none", fps: 20 }, CAMERA_LADDER).level).toBe(
            "medium"
        );
    });

    it("climbs only after a run of clean readings", () => {
        let state = { level: "low" as const, healthy: 0 };
        for (let reading = 1; reading < HEALTHY_TO_CLIMB; reading += 1) {
            state = driftAuto(state, clean, CAMERA_LADDER);
            expect(state.level).toBe("low");
        }
        expect(driftAuto(state, clean, CAMERA_LADDER).level).toBe("medium");
    });

    it("takes far longer to climb back into the rung that already failed", () => {
        // Without this the greedy default is a metronome: a machine that cannot
        // encode 1080p cannot encode it a minute later either, and the call
        // rediscovers that every minute for as long as it lasts.
        let state = driftAuto(camera(), { connection: "excellent", limitation: "cpu" }, CAMERA_LADDER);
        expect(state.level).toBe("high");
        expect(state.blocked).toBe("max");
        for (let reading = 1; reading < HEALTHY_TO_RETRY; reading += 1) {
            state = driftAuto(state, clean, CAMERA_LADDER);
            expect(state.level).toBe("high");
        }
        expect(driftAuto(state, clean, CAMERA_LADDER).level).toBe("max");
    });

    it("still climbs at the ordinary pace below the rung that failed", () => {
        // Only the retry is slow. Everything under it is ordinary ground.
        let state = { level: "low" as const, healthy: HEALTHY_TO_CLIMB - 1, blocked: "max" as const };
        expect(driftAuto(state, clean, CAMERA_LADDER).level).toBe("medium");
    });

    it("will not climb past the ceiling however long the line stays clean", () => {
        let state = camera();
        for (let reading = 0; reading < HEALTHY_TO_CLIMB * 4; reading += 1) {
            state = driftAuto(state, clean, CAMERA_LADDER);
        }
        expect(state.level).toBe("max");
    });

    it("does not oscillate between two rungs on an alternating line", () => {
        // One bad reading costs a rung; one good one buys nothing. A line that
        // flickers therefore settles at the bottom rather than changing the
        // picture every fifteen seconds, which is the thing people notice.
        let state = camera();
        for (let round = 0; round < 8; round += 1) {
            state = driftAuto(state, { connection: "poor" }, CAMERA_LADDER);
            state = driftAuto(state, clean, CAMERA_LADDER);
        }
        expect(state.level).toBe(CAMERA_LADDER.floor);
    });
});

describe("stepping by hand", () => {
    it("stops at both ends of the range the walk is allowed", () => {
        expect(shift(CAMERA_LADDER, "low", -1)).toBe("low");
        expect(shift(CAMERA_LADDER, CAMERA_LADDER.ceiling, 1)).toBe(CAMERA_LADDER.ceiling);
    });

    it("has nowhere left to go from the top", () => {
        expect(shift(CAMERA_LADDER, "max", 1)).toBe("max");
    });
});

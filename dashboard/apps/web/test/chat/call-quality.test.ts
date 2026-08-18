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
 * The third is the shape of the automatic walk: down on the first bad reading,
 * up only after a run of good ones, and never past the rung a person has to ask
 * for. Symmetrical hysteresis is how a call oscillates between two qualities for
 * an hour instead of settling.
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

    it("keeps the top rung out of reach of the automatic walk", () => {
        // Sending a screen at its full size is a decision somebody makes, not
        // somewhere a connection that looked good for a minute should wander.
        expect(CAMERA_LADDER.ceiling).not.toBe("max");
        expect(SCREEN_LADDER.ceiling).not.toBe("max");
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

    it("starts at the best rung it is allowed", () => {
        // A line is presumed fine until it says otherwise. Starting at the
        // bottom would open every call soft and take a minute to sharpen, which
        // reads as a broken camera rather than as caution.
        expect(camera().level).toBe(CAMERA_LADDER.ceiling);
    });

    it("drops a rung on the first poor reading", () => {
        expect(driftAuto(camera(), "poor", CAMERA_LADDER).level).toBe("medium");
    });

    it("treats a lost connection the same way", () => {
        expect(driftAuto(camera(), "lost", CAMERA_LADDER).level).toBe("medium");
    });

    it("will not drop below the floor, however bad it gets", () => {
        let state = { level: CAMERA_LADDER.floor, healthy: 0 } as const;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            state = driftAuto(state, "poor", CAMERA_LADDER);
        }
        expect(state.level).toBe(CAMERA_LADDER.floor);
    });

    it("holds on a merely good reading, and forgets the run of excellent ones", () => {
        const after = driftAuto({ level: "low", healthy: 3 }, "good", CAMERA_LADDER);
        expect(after.level).toBe("low");
        // The reset is the point: three excellent readings, one ordinary one and
        // then a fourth excellent one is not a minute of calm.
        expect(after.healthy).toBe(0);
    });

    it("holds on a reading nobody understands", () => {
        const after = driftAuto({ level: "low", healthy: 2 }, "unknown", CAMERA_LADDER);
        expect(after.level).toBe("low");
    });

    it("climbs only after a run of excellent readings", () => {
        let state = { level: "low" as const, healthy: 0 };
        for (let reading = 1; reading < HEALTHY_TO_CLIMB; reading += 1) {
            state = driftAuto(state, "excellent", CAMERA_LADDER);
            expect(state.level).toBe("low");
        }
        expect(driftAuto(state, "excellent", CAMERA_LADDER).level).toBe("medium");
    });

    it("will not climb past the ceiling however long the line stays clean", () => {
        let state = camera();
        for (let reading = 0; reading < HEALTHY_TO_CLIMB * 4; reading += 1) {
            state = driftAuto(state, "excellent", CAMERA_LADDER);
        }
        expect(state.level).toBe(CAMERA_LADDER.ceiling);
    });

    it("does not oscillate between two rungs on an alternating line", () => {
        // One bad reading costs a rung; one good one buys nothing. A line that
        // flickers therefore settles at the bottom rather than changing the
        // picture every fifteen seconds, which is the thing people notice.
        let state = camera();
        for (let round = 0; round < 6; round += 1) {
            state = driftAuto(state, "poor", CAMERA_LADDER);
            state = driftAuto(state, "excellent", CAMERA_LADDER);
        }
        expect(state.level).toBe(CAMERA_LADDER.floor);
    });
});

describe("stepping by hand", () => {
    it("stops at both ends of the range the walk is allowed", () => {
        expect(shift(CAMERA_LADDER, "low", -1)).toBe("low");
        expect(shift(CAMERA_LADDER, CAMERA_LADDER.ceiling, 1)).toBe(CAMERA_LADDER.ceiling);
    });

    it("brings a hand-picked rung above the ceiling back into range", () => {
        // Somebody chose "Highest" and then turned automatic back on. The walk
        // has to start from somewhere it is allowed to be.
        expect(shift(CAMERA_LADDER, "max", 1)).toBe(CAMERA_LADDER.ceiling);
    });
});

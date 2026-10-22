/**
 * A release that reaches the camera before the press it ends.
 *
 * The press and the release are separate requests. On a camera that answers
 * late the release's stop can land first, and a camera that then takes the
 * start keeps moving with nobody holding the arrow. These hold that a start
 * which comes back after a release is followed by another stop, and that a
 * start nobody heard back from is stopped and said so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let moveAnswer: () => Promise<void> = async () => undefined;

class FakeOnvifError extends Error {
    constructor(
        message: string,
        readonly failure: "refused" | "timeout" | "unreachable"
    ) {
        super(message);
    }
}

vi.mock("@polaris-app/places/src/lib/onvif", () => ({
    OnvifError: FakeOnvifError,
    getProfiles: async () => [{ token: "profile_1", name: "main", width: 1920 }],
    getPresets: async () => [],
    gotoPreset: async () => undefined,
    ptzMove: async () => {
        calls.push("move");
        await moveAnswer();
    },
    ptzStop: async () => {
        calls.push("stop");
    }
}));

vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    cameraTarget: async () => ({
        address: "10.0.9.9",
        onvifPort: 2020,
        username: "viewer",
        password: "fixture-password"
    })
}));

const ptz = await import("@polaris-app/places/src/lib/ptz");

beforeEach(() => {
    calls.length = 0;
    moveAnswer = async () => undefined;
});

describe("a start that answers after the release", () => {
    it("is followed by another stop", async () => {
        let answer: () => void = () => undefined;
        moveAnswer = () => new Promise<void>((resolve) => (answer = resolve));
        const pressing = ptz.move("install", "camera-a", "left");
        await vi.waitFor(() => expect(calls).toContain("move"));
        await ptz.stop("install", "camera-a");
        answer();
        await pressing;
        expect(calls).toEqual(["move", "stop", "stop"]);
    });

    it("is left alone when the arrow is still held", async () => {
        await ptz.move("install", "camera-b", "left");
        expect(calls).toEqual(["move"]);
    });

    it("is not stopped by an older release when a newer press overtook it", async () => {
        let answer: () => void = () => undefined;
        moveAnswer = () => new Promise<void>((resolve) => (answer = resolve));
        const first = ptz.move("install", "camera-c", "left");
        await vi.waitFor(() => expect(calls).toContain("move"));
        await ptz.stop("install", "camera-c");
        moveAnswer = async () => undefined;
        await ptz.move("install", "camera-c", "right");
        answer();
        await first;
        // The first start was overtaken by a press, not by a stop: the camera
        // is meant to be moving right now.
        expect(calls).toEqual(["move", "stop", "move"]);
    });
});

describe("a start nobody heard back from", () => {
    it("is stopped and told to the screen", async () => {
        moveAnswer = async () => {
            throw new FakeOnvifError("The camera did not answer in time", "timeout");
        };
        await expect(ptz.move("install", "camera-d", "up")).rejects.toThrow(
            "The camera did not take that move in time and was told to stop"
        );
        expect(calls).toEqual(["move", "stop"]);
    });

    it("says the camera could not be reached when the connection failed", async () => {
        moveAnswer = async () => {
            throw new FakeOnvifError("Could not reach the camera", "unreachable");
        };
        await expect(ptz.move("install", "camera-e", "up")).rejects.toThrow(
            "Could not reach the camera to move it"
        );
        expect(calls).toEqual(["move", "stop"]);
    });

    it("passes a refusal on without a stop behind it", async () => {
        moveAnswer = async () => {
            throw new FakeOnvifError("Not authorized", "refused");
        };
        await expect(ptz.move("install", "camera-f", "up")).rejects.toThrow("Not authorized");
        expect(calls).toEqual(["move"]);
    });
});

describe("overtakenByStop", () => {
    it("is true only for the same press, stopped since", () => {
        expect(ptz.overtakenByStop(undefined, 1)).toBe(false);
        expect(ptz.overtakenByStop({ press: 1, stopped: false }, 1)).toBe(false);
        expect(ptz.overtakenByStop({ press: 1, stopped: true }, 1)).toBe(true);
        expect(ptz.overtakenByStop({ press: 2, stopped: true }, 1)).toBe(false);
    });
});

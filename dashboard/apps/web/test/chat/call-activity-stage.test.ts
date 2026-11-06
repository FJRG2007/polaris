/**
 * A game played in a call takes the stage the way a shared screen does: the
 * faces become a strip under it instead of being pushed under the game, it can
 * be asked for by name, and it steps aside for a screen or a face asked for by
 * name - out of sight, never closed.
 */

import { describe, expect, it } from "vitest";
import { ACTIVITY_KEY, stagingOf } from "@/app/(app)/chat/call-media";

const stream = (label: string) => ({ label }) as unknown as MediaStream;
const screen = { key: "screen:p2", stream: stream("p2"), name: "Ada - screen" };

describe("a game on the call's stage", () => {
    it("is a picture on the stage with the faces a strip under it", () => {
        const staging = stagingOf([], null, true);
        expect(staging.activity).toBe(true);
        expect(staging.staged).toBe(true);
        expect(staging.enlarged).toBe(false);
    });

    it("shares the stage with a screen until one of them is asked for", () => {
        const staging = stagingOf([screen], null, true);
        expect(staging.activity).toBe(true);
        expect(staging.showing).toEqual([screen]);
        expect(staging.enlarged).toBe(false);
    });

    it("takes the panel whole when asked for, like a screen does", () => {
        const staging = stagingOf([screen], ACTIVITY_KEY, true);
        expect(staging.activity).toBe(true);
        expect(staging.showing).toEqual([]);
        expect(staging.enlarged).toBe(true);
    });

    it("steps aside for a screen asked for by name", () => {
        const staging = stagingOf([screen], screen.key, true);
        expect(staging.activity).toBe(false);
        expect(staging.showing).toEqual([screen]);
        expect(staging.enlarged).toBe(true);
    });

    it("steps aside for a face asked for by name", () => {
        const staging = stagingOf([screen], "camera:p3", true);
        expect(staging.activity).toBe(false);
        expect(staging.showing).toEqual([]);
        expect(staging.staged).toBe(true);
    });

    it("is not there for a reader who is not playing", () => {
        const staging = stagingOf([], null);
        expect(staging.activity).toBe(false);
        expect(staging.staged).toBe(false);
    });
});

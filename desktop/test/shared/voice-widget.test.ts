/**
 * The voice widget's rules: when it is on screen, how tall it is, and what a
 * face with no picture shows.
 */

import { describe, expect, it } from "vitest";
import {
    faceColor,
    initials,
    lockKeys,
    MAX_ROWS,
    voiceActionSchema,
    voiceStateSchema,
    widgetHeight,
    widgetVisible
} from "@/shared/voice-widget";

describe("when the widget is on screen", () => {
    const cases: [boolean, boolean, boolean, boolean, boolean][] = [
        // inCall, enabled, onlyWithGame, gameRunning -> visible
        [true, true, false, false, true],
        [true, true, false, true, true],
        [true, true, true, true, true],
        [true, true, true, false, false],
        [true, false, false, true, false],
        [true, false, true, true, false],
        [false, true, false, true, false],
        [false, true, true, true, false]
    ];
    it.each(cases)("in a call %s, switched on %s, game only %s, game running %s -> %s", (inCall, enabled, onlyWithGame, gameRunning, visible) => {
        expect(widgetVisible({ inCall, enabled, onlyWithGame, gameRunning })).toBe(visible);
    });
});

describe("what the page publishes", () => {
    it("takes the call's people and the reader's own mute and deafen", () => {
        const state = {
            participants: [{ id: "a", name: "  Ada  ", speaking: false, muted: true, deafened: false }],
            selfMuted: true,
            selfDeafened: false
        };
        expect(voiceStateSchema.parse(state)?.participants[0]?.name).toBe("Ada");
    });

    it("refuses a person without an id", () => {
        expect(voiceStateSchema.safeParse({ participants: [{ id: "", name: "x", speaking: false, muted: false, deafened: false }], selfMuted: false, selfDeafened: false }).success).toBe(false);
    });

    it("takes only the three widget presses", () => {
        expect(voiceActionSchema.safeParse("leave").success).toBe(true);
        expect(voiceActionSchema.safeParse("camera").success).toBe(false);
    });
});

describe("the widget's size", () => {
    it("grows with the people up to its row limit, then counts the rest", () => {
        expect(widgetHeight(2, false)).toBeLessThan(widgetHeight(3, false));
        expect(widgetHeight(MAX_ROWS + 5, false)).toBe(widgetHeight(MAX_ROWS + 50, false));
        expect(widgetHeight(MAX_ROWS + 1, false)).toBeGreaterThan(widgetHeight(MAX_ROWS, false));
    });

    it("makes room for the buttons when unlocked", () => {
        expect(widgetHeight(2, true)).toBeGreaterThan(widgetHeight(2, false));
    });
});

describe("a face with no picture", () => {
    it.each([
        ["Ada Lovelace", "AL"],
        ["ada", "AD"],
        ["Jean Luc Picard", "JP"],
        ["", "?"]
    ])("%j shows %s", (name, shown) => {
        expect(initials(name)).toBe(shown);
    });

    it("keeps one color per person", () => {
        expect(faceColor("p1")).toBe(faceColor("p1"));
    });
});

describe("the lock key", () => {
    it("takes Shift+` only while a game runs, so it is never taken from typing", () => {
        expect(lockKeys("win32", true).map(([accelerator]) => accelerator)).toEqual(["Shift+`", "CommandOrControl+Shift+`"]);
        expect(lockKeys("win32", false).map(([accelerator]) => accelerator)).toEqual(["CommandOrControl+Shift+`"]);
        expect(lockKeys("darwin", false)[0]?.[1]).toBe("Cmd+Shift+`");
    });
});

/**
 * The voice widget's rules: when it is on screen, how big it is and where it
 * sits, how it looks as chosen in the settings, and what a face with no
 * picture shows.
 */

import { describe, expect, it } from "vitest";
import {
    cornerPoint,
    DEFAULT_LOOK,
    faceColor,
    initials,
    lockKeys,
    lookChangeSchema,
    MAX_ROWS,
    showsName,
    shownPeople,
    voiceActionSchema,
    voiceStateSchema,
    widgetHeight,
    widgetSize,
    widgetVisible,
    withLookChange,
    type VoicePerson
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

describe("a face's picture", () => {
    const base = { id: "a", name: "Ada", speaking: false, muted: false, deafened: false };

    it("takes a person with a picture, and one without (a guest, an older page)", () => {
        const state = (person: object) => voiceStateSchema.safeParse({ participants: [person], selfMuted: false, selfDeafened: false });
        expect(state({ ...base, picture: "/api/avatar/u1" }).data?.participants[0]?.picture).toBe("/api/avatar/u1");
        expect(state(base).success).toBe(true);
        expect(state({ ...base, picture: "" }).success).toBe(false);
        expect(state({ ...base, picture: "x".repeat(513) }).success).toBe(false);
    });
});

describe("the widget's look", () => {
    it("takes one change from the settings page, and nothing else", () => {
        expect(lookChangeSchema.safeParse({ key: "opacity", value: 60 }).success).toBe(true);
        expect(lookChangeSchema.safeParse({ key: "opacity", value: "60" }).success).toBe(false);
        expect(lookChangeSchema.safeParse({ key: "names", value: "speaking" }).success).toBe(true);
        expect(lookChangeSchema.safeParse({ key: "corner", value: "middle" }).success).toBe(false);
        expect(lookChangeSchema.safeParse({ key: "server", value: "x" }).success).toBe(false);
        expect(withLookChange(DEFAULT_LOOK, { key: "avatars", value: "small" })).toEqual({ ...DEFAULT_LOOK, avatars: "small" });
    });
});

describe("who is drawn, and with a name", () => {
    const person = (id: string, speaking: boolean): VoicePerson => ({ id, name: id, speaking, muted: false, deafened: false });
    const call = [person("a", true), person("b", false), person("c", true)];

    it("draws everybody, or only who is talking", () => {
        expect(shownPeople(call, { people: "always" })).toHaveLength(3);
        expect(shownPeople(call, { people: "speaking" }).map(({ id }) => id)).toEqual(["a", "c"]);
        expect(shownPeople([person("b", false)], { people: "speaking" })).toEqual([]);
    });

    it.each([
        ["always", true, true],
        ["always", false, true],
        ["speaking", true, true],
        ["speaking", false, false],
        ["never", true, false]
    ] as const)("names %s, talking %s -> named %s", (names, speaking, named) => {
        expect(showsName({ speaking }, { names })).toBe(named);
    });
});

describe("the widget's size and corner", () => {
    it("is smaller with small faces", () => {
        const large = widgetSize(5, false, { avatars: "large", names: "always" });
        const small = widgetSize(5, false, { avatars: "small", names: "always" });
        expect(small.height).toBeLessThan(large.height);
    });

    it("is as narrow as a face with no names, and wide enough for its buttons unlocked", () => {
        const named = widgetSize(3, false, { avatars: "large", names: "always" });
        const faces = widgetSize(3, false, { avatars: "large", names: "never" });
        expect(faces.width).toBeLessThan(named.width / 3);
        expect(widgetSize(3, true, { avatars: "large", names: "never" }).width).toBe(named.width);
    });

    const area = { x: 0, y: 40, width: 1920, height: 1000 };
    it.each([
        ["top-left", { x: 16, y: 56 }],
        ["top-right", { x: 1920 - 240 - 16, y: 56 }],
        ["bottom-left", { x: 16, y: 40 + 1000 - 100 - 16 }],
        ["bottom-right", { x: 1920 - 240 - 16, y: 40 + 1000 - 100 - 16 }]
    ] as const)("sits %s of the work area", (corner, point) => {
        expect(cornerPoint(area, { width: 240, height: 100 }, corner, 16)).toEqual(point);
    });
});

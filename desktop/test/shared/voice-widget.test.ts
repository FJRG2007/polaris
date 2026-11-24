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
    insideRegions,
    lockKeys,
    lookChangeSchema,
    MAX_PEOPLE,
    MAX_ROWS,
    rowCap,
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

describe("max users displayed", () => {
    it("caps the rows at the chosen number, Off listing everybody", () => {
        expect(rowCap(DEFAULT_LOOK)).toBe(MAX_ROWS);
        expect(rowCap({ maxUsers: 5 })).toBe(5);
        expect(rowCap({ maxUsers: 0 })).toBe(MAX_PEOPLE);
        expect(rowCap({})).toBe(MAX_ROWS);
    });

    it("sizes the window for the capped rows and the line that counts the rest", () => {
        const five = { ...DEFAULT_LOOK, maxUsers: 5 };
        expect(widgetSize(5, false, five).height).toBe(widgetSize(5, false, DEFAULT_LOOK).height);
        expect(widgetSize(12, false, five).height).toBeLessThan(widgetSize(12, false, DEFAULT_LOOK).height);
        expect(widgetSize(12, false, five).height).toBeGreaterThan(widgetSize(5, false, five).height);
        expect(widgetSize(20, false, { ...DEFAULT_LOOK, maxUsers: 0 }).height).toBeGreaterThan(widgetSize(20, false, DEFAULT_LOOK).height);
    });

    it("is one whole number from Off to 25 when it is changed", () => {
        expect(lookChangeSchema.safeParse({ key: "maxUsers", value: 0 }).success).toBe(true);
        expect(lookChangeSchema.safeParse({ key: "maxUsers", value: 25 }).success).toBe(true);
        expect(lookChangeSchema.safeParse({ key: "maxUsers", value: 26 }).success).toBe(false);
        expect(lookChangeSchema.safeParse({ key: "maxUsers", value: -1 }).success).toBe(false);
        expect(lookChangeSchema.safeParse({ key: "maxUsers", value: 7.5 }).success).toBe(false);
        expect(withLookChange(DEFAULT_LOOK, { key: "maxUsers", value: 12 }).maxUsers).toBe(12);
    });
});

describe("clickable regions", () => {
    const buttons = [
        { x: 8, y: 100, width: 32, height: 32 },
        { x: 44, y: 100, width: 32, height: 32 }
    ];

    it("take a point on a button and let every other one through", () => {
        expect(insideRegions({ x: 10, y: 110 }, buttons)).toBe(true);
        expect(insideRegions({ x: 75, y: 131 }, buttons)).toBe(true);
        expect(insideRegions({ x: 42, y: 110 }, buttons)).toBe(false);
        expect(insideRegions({ x: 10, y: 20 }, buttons)).toBe(false);
        // The far edges belong to what is next to the box.
        expect(insideRegions({ x: 40, y: 110 }, buttons)).toBe(false);
        expect(insideRegions({ x: 10, y: 132 }, buttons)).toBe(false);
    });

    it("never take a click for a hidden (empty) button or with no regions", () => {
        expect(insideRegions({ x: 0, y: 0 }, [{ x: 0, y: 0, width: 0, height: 0 }])).toBe(false);
        expect(insideRegions({ x: 5, y: 5 }, [])).toBe(false);
    });

    it("keep the buttons' row while locked, so the window is sized for it", () => {
        expect(widgetSize(3, false, DEFAULT_LOOK, true).height).toBe(widgetSize(3, true, DEFAULT_LOOK).height);
        expect(widgetSize(3, false, { ...DEFAULT_LOOK, names: "never" }, true).width).toBe(widgetSize(3, true, DEFAULT_LOOK).width);
    });
});

/**
 * The version last restarted into survives a run, beside what is already kept,
 * and a settings file from before it existed still reads.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const folder = vi.hoisted(() => ({ path: "" }));

vi.mock("electron", () => ({ app: { getPath: () => folder.path } }));

const {
    hardwareAcceleration,
    rememberRelaunch,
    takeRelaunch,
    rememberHardwareAcceleration,
    rememberTextSize,
    rememberToggle,
    serverAddress,
    setUpdateAttempted,
    textSize,
    toggle,
    updateAttempted,
    rememberVoiceWidgetLook,
    rememberVoiceWidgetPlace,
    resetVoiceWidgetLayout,
    voiceWidgetLook,
    voiceWidgetPlace
} = await import("@/main/settings");

beforeEach(() => {
    folder.path = mkdtempSync(join(tmpdir(), "polaris-settings-"));
});

describe("hardware acceleration, read at start", () => {
    it("is on when there is no settings file yet", () => {
        expect(hardwareAcceleration()).toBe(true);
    });

    it("is on for a file written before it existed, and the rest still reads", () => {
        const origin = "https://polaris.example.test";
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: origin, servers: [], pushes: {} }));
        expect(hardwareAcceleration()).toBe(true);
        expect(serverAddress()).toBe(origin);
    });

    it("is on when the file is not JSON", () => {
        writeFileSync(join(folder.path, "settings.json"), "{ hardwareAcceleration: fal");
        expect(hardwareAcceleration()).toBe(true);
    });

    it.each([["false"], [0], [null], [{}]])("is on when the value is %j instead of a boolean", (value) => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ hardwareAcceleration: value }));
        expect(hardwareAcceleration()).toBe(true);
    });

    it("stays off once turned off, and the address kept beside it survives", () => {
        const origin = "https://polaris.example.test";
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: origin }));
        rememberHardwareAcceleration(false);
        expect(hardwareAcceleration()).toBe(false);
        expect(serverAddress()).toBe(origin);
        rememberHardwareAcceleration(true);
        expect(hardwareAcceleration()).toBe(true);
    });
});

describe("the tray", () => {
    it("minimizes to it and starts in it by default, from a file written before either existed", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: null, servers: [], pushes: {} }));
        expect(toggle("minimizeToTray")).toBe(true);
        expect(toggle("startMinimized")).toBe(true);
    });

    it("keeps a window at sign-in for a file that already says so", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ startMinimized: false }));
        expect(toggle("startMinimized")).toBe(false);
    });

    it("keeps what was chosen", () => {
        rememberToggle("minimizeToTray", false);
        rememberToggle("startMinimized", false);
        expect(toggle("minimizeToTray")).toBe(false);
        expect(toggle("startMinimized")).toBe(false);
    });
});

describe("the version last restarted into", () => {
    it("reads as none from a file written before it existed, keeping the rest", () => {
        const origin = "https://polaris.example.test";
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: origin, servers: [], pushes: {} }));
        expect(updateAttempted()).toBeNull();
        setUpdateAttempted("0.1.3");
        expect(updateAttempted()).toBe("0.1.3");
        expect(serverAddress()).toBe(origin);
    });

    it("falls back to none when the file holds something else", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ updateAttempted: 3 }));
        expect(updateAttempted()).toBeNull();
    });
});

describe("the account's text size", () => {
    it("is the dashboard default before any was seen, and a file from before it still reads", () => {
        const origin = "https://polaris.example.test";
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ server: origin, servers: [], pushes: {} }));
        expect(textSize()).toBe(16);
        expect(serverAddress()).toBe(origin);
    });

    it("keeps a size once and reports only a change", () => {
        expect(rememberTextSize(20)).toBe(true);
        expect(textSize()).toBe(20);
        expect(rememberTextSize(20)).toBe(false);
        expect(rememberTextSize(14)).toBe(true);
        expect(textSize()).toBe(14);
    });

    it("reads a size stored as the root element carries it, and ignores one not offered", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ textSize: "18px" }));
        expect(textSize()).toBe(18);
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ textSize: 17 }));
        expect(textSize()).toBe(16);
    });
});

describe("the restart the app made itself", () => {
    const mark = { reason: "update" as const, at: 1_000, calls: [{ origin: "https://polaris.example.test", note: "{}" }] };

    it("is read once, on the next start", () => {
        rememberRelaunch(mark);
        expect(takeRelaunch()).toEqual(mark);
        expect(takeRelaunch()).toBeNull();
    });

    it("keeps the rest of the settings", () => {
        setUpdateAttempted("0.1.70");
        rememberRelaunch(mark);
        expect(updateAttempted()).toBe("0.1.70");
        takeRelaunch();
        expect(updateAttempted()).toBe("0.1.70");
    });

    it("is none for a file without it, or with anything else in its place", () => {
        expect(takeRelaunch()).toBeNull();
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ relaunch: { reason: "crash", at: 1_000, calls: [] } }));
        expect(takeRelaunch()).toBeNull();
    });
});

describe("the voice widget's look", () => {
    const defaults = { avatars: "large", names: "always", people: "always", opacity: 100, corner: "top-left", maxUsers: 8 } as const;

    it("is Discord's defaults for a file from before it existed", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ voiceWidget: true }));
        expect(voiceWidgetLook()).toEqual(defaults);
    });

    it("keeps each choice on its own when another is unknown", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ voiceWidgetAvatars: "small", voiceWidgetNames: "huge", voiceWidgetOpacity: "55", voiceWidgetCorner: "bottom-right" }));
        expect(voiceWidgetLook()).toEqual({ ...defaults, avatars: "small", corner: "bottom-right" });
    });

    it("is kept, and a new corner forgets where it was dragged", () => {
        rememberVoiceWidgetPlace({ x: 300, y: 200 });
        rememberVoiceWidgetLook({ avatars: "small", names: "speaking", people: "speaking", opacity: 60, corner: "top-left", maxUsers: 8 });
        expect(voiceWidgetLook()).toEqual({ avatars: "small", names: "speaking", people: "speaking", opacity: 60, corner: "top-left", maxUsers: 8 });
        expect(voiceWidgetPlace()).toEqual({ x: 300, y: 200 });
        rememberVoiceWidgetLook({ avatars: "small", names: "speaking", people: "speaking", opacity: 60, corner: "bottom-right", maxUsers: 8 });
        expect(voiceWidgetPlace()).toBeNull();
    });

    it("keeps how many people it lists, and reads a stored value out of range as the default", () => {
        rememberVoiceWidgetLook({ ...defaults, maxUsers: 0 });
        expect(voiceWidgetLook().maxUsers).toBe(0);
        rememberVoiceWidgetLook({ ...defaults, maxUsers: 25 });
        expect(voiceWidgetLook().maxUsers).toBe(25);
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ voiceWidgetMaxUsers: 99 }));
        expect(voiceWidgetLook().maxUsers).toBe(8);
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ voiceWidgetMaxUsers: 2.5 }));
        expect(voiceWidgetLook().maxUsers).toBe(8);
    });

    it("goes back to its first layout: look, corner, place and every widget", () => {
        rememberVoiceWidgetLook({ avatars: "small", names: "never", people: "speaking", opacity: 40, corner: "bottom-right", maxUsers: 3 });
        rememberVoiceWidgetPlace({ x: 10, y: 20 });
        rememberToggle("overlayQuickActions", false);
        rememberToggle("overlayClickable", true);
        rememberToggle("voiceWidgetGameOnly", true);
        resetVoiceWidgetLayout();
        expect(voiceWidgetLook()).toEqual(defaults);
        expect(voiceWidgetPlace()).toBeNull();
        expect(toggle("overlayQuickActions")).toBe(true);
        expect(toggle("overlayClickable")).toBe(false);
        // Not part of the layout: when it shows is somebody's own choice.
        expect(toggle("voiceWidgetGameOnly")).toBe(true);
    });
});

describe("the overlay's widgets", () => {
    it("have the quick actions on and clickable regions off on a file from before them", () => {
        writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ voiceWidget: true }));
        expect(toggle("overlayQuickActions")).toBe(true);
        expect(toggle("overlayClickable")).toBe(false);
    });
});

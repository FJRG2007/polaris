/**
 * The app's shortcuts wear the season, since the taskbar draws the button from
 * the shortcut carrying the window's app id (BUG-0049).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, shell: {} }));

const { iconChange, shortcutFolders, startsApp } = await import("../../src/main/shortcut-icon");

const STUB = "C:\\Users\\someone\\AppData\\Local\\Polaris\\polaris.exe";
const EXE = "C:\\Users\\someone\\AppData\\Local\\Polaris\\app-1.0.0\\polaris.exe";
const ICO = "C:\\Users\\someone\\AppData\\Roaming\\Polaris\\taskbar-icon.ico";

describe("startsApp", () => {
    it("takes only a shortcut to the stub or the executable, in any casing", () => {
        expect(startsApp(STUB.toUpperCase(), [STUB, EXE])).toBe(true);
        expect(startsApp(EXE, [STUB, EXE])).toBe(true);
        expect(startsApp("C:\\Program Files\\Other\\other.exe", [STUB, EXE])).toBe(false);
        expect(startsApp("", [STUB, EXE])).toBe(false);
    });
});

describe("iconChange", () => {
    it("dresses a shortcut that shows its target's icon", () => {
        expect(iconChange({ icon: "", iconIndex: 0 }, ICO, STUB)).toEqual({ icon: ICO, iconIndex: 0 });
    });

    it("writes nothing to a shortcut that already wears what it should", () => {
        expect(iconChange({ icon: ICO.toLowerCase(), iconIndex: 0 }, ICO, STUB)).toBeNull();
        expect(iconChange({ icon: "", iconIndex: 0 }, null, STUB)).toBeNull();
        expect(iconChange({}, null, STUB)).toBeNull();
        expect(iconChange({ icon: STUB, iconIndex: 0 }, null, STUB)).toBeNull();
    });

    it("puts the app's own icon back once the season ends", () => {
        expect(iconChange({ icon: ICO, iconIndex: 0 }, null, STUB)).toEqual({ icon: STUB, iconIndex: 0 });
    });
});

describe("shortcutFolders", () => {
    it("looks in the Start menu, the desktop and the taskbar's pins", () => {
        const folders = shortcutFolders("C:\\AppData", "C:\\Desktop").map((folder) => folder.replaceAll("\\", "/"));
        expect(folders).toEqual([
            "C:/AppData/Microsoft/Windows/Start Menu/Programs",
            "C:/Desktop",
            "C:/AppData/Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar"
        ]);
    });
});

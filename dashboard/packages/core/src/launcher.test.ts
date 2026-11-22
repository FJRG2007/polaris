import * as keys from "./shortcuts";
import * as launcher from "./launcher";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const press = (key: string, held: Partial<Record<"ctrl" | "meta" | "alt" | "shift", boolean>> = {}, code?: string) => ({
    key,
    code,
    ctrlKey: held.ctrl ?? false,
    metaKey: held.meta ?? false,
    altKey: held.alt ?? false,
    shiftKey: held.shift ?? false
});

describe("launcher shortcuts", () => {
    const resolved = keys.resolveShortcuts();

    it("opens the palette on Alt+Space first and Ctrl/Cmd+K second", () => {
        expect(keys.keysOf(resolved, "general.commandPalette")).toEqual(["Alt+Space", "Mod+k"]);
        expect(keys.isShortcut(resolved, press(" ", { alt: true }, "Space"), "general.commandPalette")).toBe(true);
        expect(keys.isShortcut(resolved, press("k", { ctrl: true }), "general.commandPalette")).toBe(true);
        expect(keys.isShortcut(resolved, press("k", { meta: true }), "general.commandPalette")).toBe(true);
        expect(keys.isShortcut(resolved, press(" "), "general.commandPalette")).toBe(false);
        expect(keys.isShortcut(resolved, press(" ", { ctrl: true }), "general.commandPalette")).toBe(false);
    });

    it("reads a Mac's Option+Space, which types a non-breaking space, as Alt+Space", () => {
        expect(keys.bindingOfEvent(press(" ", { alt: true }, "Space"))).toBe("Alt+Space");
        expect(keys.bindingOfEvent(press(" ", { alt: true }, "Space"))).toBe("Alt+Space");
    });

    it("has no default that collides with Alt+Space", () => {
        expect(keys.shortcutConflicts(resolved).filter((c) => c.binding === "Alt+Space")).toEqual([]);
    });

    it("keeps every default bindable", () => {
        for (const binding of [...launcher.LAUNCHER_SHORTCUTS, ...launcher.PAGE_LAUNCHER_SHORTCUTS])
            expect(keys.isBindable(binding)).toBe(true);
    });

    it("leaves typing alone only where the press would type", () => {
        const field = { editable: true, apple: true };
        expect(launcher.launcherPressAllowed("Alt+Space", field)).toBe(false);
        expect(launcher.launcherPressAllowed("Alt+Shift+k", field)).toBe(false);
        expect(launcher.launcherPressAllowed("Mod+k", field)).toBe(true);
        expect(launcher.launcherPressAllowed("Alt+Space", { editable: true, apple: false })).toBe(true);
        expect(launcher.launcherPressAllowed("Alt+Space", { editable: false, apple: true })).toBe(true);
    });

    it("knows a text field from a button", () => {
        expect(launcher.isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true);
        expect(launcher.isEditableTarget({ tagName: "input", type: "search" })).toBe(true);
        expect(launcher.isEditableTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
        expect(launcher.isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
        expect(launcher.isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
        expect(launcher.isEditableTarget({ tagName: "BUTTON" })).toBe(false);
        expect(launcher.isEditableTarget(null)).toBe(false);
    });

    it("writes Electron accelerators for Desktop", () => {
        expect(launcher.launcherAccelerator("Alt+Space")).toBe("Alt+Space");
        expect(launcher.launcherAccelerator("Mod+k")).toBe("CommandOrControl+K");
        expect(launcher.launcherAccelerator("Alt+Shift+k")).toBe("Alt+Shift+K");
    });
});

describe("launcher sites", () => {
    it("keeps a site as its bare hostname", () => {
        expect(launcher.normalizeLauncherSite("https://www.GitHub.com/x?y#z")).toBe("github.com");
        expect(launcher.normalizeLauncherSite("*.example.org")).toBe("example.org");
        expect(launcher.normalizeLauncherSite("localhost:3000")).toBe("localhost");
        expect(launcher.normalizeLauncherSite("  ")).toBeNull();
        expect(launcher.normalizeLauncherSite("not a site")).toBeNull();
    });

    it("runs everywhere but the excluded sites, subdomains included", () => {
        const settings = { ...launcher.LAUNCHER_DEFAULTS, sites: ["github.com"] };
        expect(launcher.launcherRunsOn("github.com", settings)).toBe(false);
        expect(launcher.launcherRunsOn("gist.github.com", settings)).toBe(false);
        expect(launcher.launcherRunsOn("notgithub.com", settings)).toBe(true);
        expect(launcher.launcherRunsOn("example.com", settings)).toBe(true);
    });

    it("runs only on the listed sites in include-only mode", () => {
        const settings = { ...launcher.LAUNCHER_DEFAULTS, mode: "only" as const, sites: ["example.com"] };
        expect(launcher.launcherRunsOn("app.example.com", settings)).toBe(true);
        expect(launcher.launcherRunsOn("other.com", settings)).toBe(false);
        expect(launcher.launcherRunsOn("other.com", { ...settings, sites: [] })).toBe(false);
    });

    it("runs nowhere when switched off", () => {
        expect(launcher.launcherRunsOn("example.com", { ...launcher.LAUNCHER_DEFAULTS, enabled: false })).toBe(false);
    });
});

describe("launcher settings", () => {
    it("defaults to on, everywhere, on Alt+Space and Alt+Shift+K", () => {
        expect(launcher.readLauncherSettings(undefined)).toEqual({
            enabled: true,
            shortcuts: ["Alt+Space", "Alt+Shift+k"],
            mode: "all",
            sites: []
        });
    });

    it("matches a press against the launcher's keys", () => {
        expect(launcher.launcherPress(press(" ", { alt: true }, "Space"), launcher.PAGE_LAUNCHER_SHORTCUTS)).toBe("Alt+Space");
        expect(launcher.launcherPress(press("K", { alt: true, shift: true }, "KeyK"), launcher.PAGE_LAUNCHER_SHORTCUTS)).toBe("Alt+Shift+k");
        expect(launcher.launcherPress(press("k", { ctrl: true }), launcher.PAGE_LAUNCHER_SHORTCUTS)).toBeNull();
    });

    it("refuses keys that would fire while typing", () => {
        expect(launcher.isLauncherBinding("Alt+Space")).toBe(true);
        expect(launcher.isLauncherBinding("Mod+Shift+p")).toBe(true);
        expect(launcher.isLauncherBinding("k")).toBe(false);
        expect(launcher.isLauncherBinding("Shift+k")).toBe(false);
        expect(launcher.isLauncherBinding("Mod+w")).toBe(false);
    });

    it("falls back field by field and cleans the site list", () => {
        expect(
            launcher.readLauncherSettings({
                enabled: false,
                shortcuts: ["k"],
                mode: "sometimes",
                sites: ["https://www.a.com/", "a.com", "bad site", "b.org"]
            })
        ).toEqual({ enabled: false, shortcuts: ["Alt+Space", "Alt+Shift+k"], mode: "all", sites: ["a.com", "b.org"] });
    });
});

describe("Polaris Desktop", () => {
    // Desktop is outside the dashboard's workspace and cannot import this
    // package, so its own default is held to this one here.
    const desktop = fileURLToPath(new URL("../../../../desktop/src/shared/launcher-hotkey.ts", import.meta.url));

    it.runIf(existsSync(desktop))("defaults to the same global key", () => {
        const found = /DEFAULT_LAUNCHER_BINDING\s*=\s*"([^"]+)"/.exec(readFileSync(desktop, "utf8"))?.[1];
        expect(found).toBe(launcher.DESKTOP_LAUNCHER_SHORTCUT);
    });
});

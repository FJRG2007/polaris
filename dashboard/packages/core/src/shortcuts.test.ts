import { describe, expect, it } from "vitest";
import * as keys from "./shortcuts";

const press = (key: string, held: Partial<Record<"ctrl" | "meta" | "alt" | "shift", boolean>> = {}, code?: string) => ({
    key,
    code,
    ctrlKey: held.ctrl ?? false,
    metaKey: held.meta ?? false,
    altKey: held.alt ?? false,
    shiftKey: held.shift ?? false
});

describe("writing a binding", () => {
    it("has one form whatever order or spelling it came in", () => {
        expect(keys.normalizeBinding("Shift+Ctrl+K")).toBe("Mod+Shift+k");
        expect(keys.normalizeBinding("cmd+enter")).toBe("Mod+Enter");
        expect(keys.normalizeBinding("Esc")).toBe("Escape");
        expect(keys.normalizeBinding("f2")).toBe("F2");
        expect(keys.normalizeBinding("Mod++")).toBe("Mod++");
        expect(keys.normalizeBinding(" ")).toBeNull();
        expect(keys.normalizeBinding("Space")).toBe("Space");
        expect(keys.normalizeBinding("Hyper+k")).toBeNull();
    });

    it("drops Shift from a symbol, which Shift already typed", () => {
        expect(keys.normalizeBinding("Shift+?")).toBe("?");
        expect(keys.normalizeBinding("Shift+u")).toBe("Shift+u");
    });

    it("refuses what the browser keeps and the key that moves focus", () => {
        expect(keys.isBindable("Mod+w")).toBe(false);
        expect(keys.isBindable("Tab")).toBe(false);
        expect(keys.isBindable("Mod+Shift+k")).toBe(true);
    });

    it("splits into key caps", () => {
        expect(keys.bindingParts("Mod+Shift+k")).toEqual(["Mod", "Shift", "k"]);
        expect(keys.bindingParts("Mod++")).toEqual(["Mod", "+"]);
    });
});

describe("reading a press", () => {
    it("reads a letter the same with Caps Lock on", () => {
        expect(keys.bindingOfEvent(press("D"))).toBe("d");
        expect(keys.bindingOfEvent(press("D", { shift: true }))).toBe("Shift+d");
    });

    it("reads a shifted symbol as the symbol", () => {
        expect(keys.bindingOfEvent(press("?", { shift: true }))).toBe("?");
        expect(keys.bindingOfEvent(press("#", { shift: true }))).toBe("#");
    });

    it("takes Ctrl and Cmd alike as Mod", () => {
        expect(keys.bindingOfEvent(press("k", { ctrl: true }))).toBe("Mod+k");
        expect(keys.bindingOfEvent(press("k", { meta: true }))).toBe("Mod+k");
    });

    it("reads the physical key under Alt, where a Mac types another character", () => {
        expect(keys.bindingOfEvent(press("∂", { alt: true }, "KeyD"))).toBe("Alt+d");
    });

    it("keeps AltGr apart from Ctrl, so a character typed with it is not a copy", () => {
        // AltGr arrives as Ctrl+Alt on Windows.
        const resolved = keys.resolveShortcuts();
        expect(keys.shortcutMatching(resolved, press("c", { ctrl: true, alt: true }), ["chat.copy"])).toBeNull();
        expect(keys.shortcutMatching(resolved, press("c", { ctrl: true }), ["chat.copy"])).toBe("chat.copy");
    });

    it("is nothing for a modifier going down, or a press with no key", () => {
        expect(keys.bindingOfEvent(press("Shift", { shift: true }))).toBeNull();
        // What an autofill sends.
        expect(keys.bindingOfEvent(press(undefined as unknown as string))).toBeNull();
        expect(keys.bindingOfEvent(press("constructor"))).toBeNull();
    });
});

describe("the table", () => {
    it("has one entry per id and no two actions sharing a key out of the box", () => {
        expect(new Set(keys.SHORTCUTS.map((definition) => definition.id)).size).toBe(keys.SHORTCUTS.length);
        expect(keys.shortcutConflicts(keys.resolveShortcuts())).toEqual([]);
    });

    it("writes every default and fixed key in its one form", () => {
        for (const definition of keys.SHORTCUTS) {
            for (const binding of [...definition.defaults, ...(definition.fixed ?? [])])
                expect(keys.normalizeBinding(binding), `${definition.id} ${binding}`).toBe(binding);
        }
    });

    it("answers a fixed key whatever the movable ones are", () => {
        const resolved = keys.resolveShortcuts({ "mail.next": ["n"] });
        expect(keys.keysOf(resolved, "mail.next")).toEqual(["n", "ArrowDown"]);
        expect(keys.shortcutMatching(resolved, press("ArrowDown"), ["mail.next"])).toBe("mail.next");
        expect(keys.shortcutMatching(resolved, press("j"), ["mail.next"])).toBeNull();
    });
});

describe("moving keys", () => {
    it("lays the device over the account over the defaults", () => {
        const resolved = keys.resolveShortcuts({ "tasks.new": ["Shift+n"] }, { "tasks.new": ["q"] });
        expect(resolved.get("tasks.new")).toEqual(["q"]);
        expect(keys.resolveShortcuts({ "tasks.new": ["Shift+n"] }).get("tasks.new")).toEqual(["Shift+n"]);
        expect(keys.resolveShortcuts().get("tasks.new")).toEqual(["n"]);
    });

    it("finds who already has a key, only among actions listening at the same time", () => {
        const resolved = keys.resolveShortcuts();
        expect(keys.conflictsFor(resolved, "tasks.calendar.day", "t")).toEqual(["tasks.calendar.today"]);
        // Drive's N and the calendar's D are never listening together.
        expect(keys.conflictsFor(resolved, "drive.newFolder", "d")).toEqual([]);
        // The list-level keys are listening while the calendar is drawn.
        expect(keys.conflictsFor(resolved, "tasks.calendar.day", "n")).toEqual(["tasks.new"]);
        // A fixed key cannot be taken.
        expect(keys.conflictsFor(resolved, "mail.archive", "Escape")).toEqual(["mail.back"]);
        // The palette is listening everywhere.
        expect(keys.conflictsFor(resolved, "drive.newFile", "Mod+k")).toEqual(["general.commandPalette"]);
    });

    it("puts an action back when its keys are its defaults again", () => {
        const moved = keys.withBindings({}, "drive.newFolder", ["Shift+n"]);
        expect(moved).toEqual({ "drive.newFolder": ["Shift+n"] });
        expect(keys.withBindings(moved, "drive.newFolder", ["n"])).toEqual({});
        expect(keys.withoutOverride(moved, "drive.newFolder")).toEqual({});
    });

    it("keeps from a stored set only what is real, and nothing from a set that collides", () => {
        expect(
            keys.cleanShortcutOverrides({
                "drive.newFolder": ["Shift+N", "Shift+N", "Mod+w"],
                "drive.open": ["o"],
                "nope.nothing": ["z"],
                "tasks.new": ["n"]
            })
        ).toEqual({ "drive.newFolder": ["Shift+n"] });
        expect(keys.cleanShortcutOverrides({ "tasks.calendar.day": ["t"] })).toEqual({});
        expect(keys.cleanShortcutOverrides("garbage")).toEqual({});
    });

    it("checks a device's set over the account's it is laid on", () => {
        const device = { "drive.newFolder": ["n", "u"] };
        expect(keys.cleanShortcutOverrides(device)).toEqual({});
        expect(keys.cleanShortcutOverrides(device, { "drive.uploadFiles": ["Alt+u"] })).toEqual(device);
    });

    it("refuses a save that would collide or name what is not a shortcut", () => {
        expect(keys.shortcutOverridesSchema.safeParse({ "tasks.calendar.day": ["t"] }).success).toBe(false);
        expect(keys.shortcutOverridesSchema.safeParse({ "drive.open": ["o"] }).success).toBe(false);
        expect(keys.shortcutOverridesSchema.safeParse({ "drive.newFolder": ["Mod+w"] }).success).toBe(false);
        expect(keys.shortcutOverridesSchema.safeParse({ "drive.newFolder": [] }).success).toBe(true);
    });

    it("carries over the keys somebody moved in Mail before the table was shared", () => {
        expect(keys.overridesFromMailKeymap({ archive: "y", reply: "r", nope: "z" })).toEqual({
            "mail.archive": ["y"]
        });
        expect(keys.overridesFromMailKeymap({ star: "A", archive: "#" })).toEqual({
            "mail.star": ["Shift+a"],
            "mail.archive": ["#"]
        });
    });
});

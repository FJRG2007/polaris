import { describe, expect, it } from "vitest";
import { callAccelerators, callHotkeysSchema, toAccelerator } from "@/shared/call-hotkeys";

describe("a call's keys held system-wide", () => {
    it("turns the dashboard's spelling into an accelerator", () => {
        expect(toAccelerator("F9")).toBe("F9");
        expect(toAccelerator("Mod+Shift+m")).toBe("CommandOrControl+Shift+M");
        expect(toAccelerator("Alt+ArrowUp")).toBe("Alt+Up");
        expect(toAccelerator("Mod++")).toBe("CommandOrControl+Plus");
        expect(toAccelerator("Shift+F10")).toBe("Shift+F10");
    });

    it("never takes a key somebody types in another program", () => {
        expect(toAccelerator("m")).toBeNull();
        expect(toAccelerator("Shift+m")).toBeNull();
        expect(toAccelerator("Space")).toBeNull();
        expect(toAccelerator("Ctrl+m")).toBeNull();
        expect(toAccelerator("")).toBeNull();
    });

    it("drops a key both controls would answer to, and keeps a repeat once", () => {
        const held = callAccelerators({ mic: ["F9", "F9", "Mod+m"], deafen: ["F10", "Mod+m"] });
        expect([...held]).toEqual([
            ["F9", "mic"],
            ["F10", "deafen"]
        ]);
    });

    it("takes only the two lists, or null to let go", () => {
        expect(callHotkeysSchema.safeParse(null).success).toBe(true);
        expect(callHotkeysSchema.safeParse({ mic: ["F9"], deafen: [] }).success).toBe(true);
        expect(callHotkeysSchema.safeParse({ mic: ["F9"], deafen: [], camera: [] }).success).toBe(false);
        expect(callHotkeysSchema.safeParse({ mic: Array(5).fill("F9"), deafen: [] }).success).toBe(false);
    });
});

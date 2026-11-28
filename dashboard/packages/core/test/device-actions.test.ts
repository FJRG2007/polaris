import { describe, expect, it } from "vitest";
import { deviceActionRequestSchema, deviceActionSchema, MAX_DEVICE_ACTION_TOTAL_DELAY_MS, pluginActionRefSchema, readActionRef } from "../src/device-plugins";

const action = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ id: "a1", name: "Open notes", steps, ...extra });

describe("custom device actions", () => {
    it("takes every step kind and fills the defaults", () => {
        const parsed = deviceActionSchema.parse(
            action([
                { kind: "open", path: "C:\\Users\\me\\notes.txt" },
                { kind: "website", url: "https://example.com/a" },
                { kind: "run", file: "/usr/bin/obs" },
                { kind: "hotkey", key: "m", ctrl: true },
                { kind: "polaris", action: "call.mic" },
                { kind: "launcher", entry: "system:lock" },
                { kind: "delay", ms: 200 }
            ])
        );
        expect(parsed.steps[2]).toEqual({ kind: "run", file: "/usr/bin/obs", args: [] });
        expect(parsed.steps[3]).toEqual({ kind: "hotkey", key: "m", ctrl: true, alt: false, shift: false, meta: false });
    });

    it("refuses a relative path, a non-web address, a control character and an unknown key", () => {
        for (const step of [
            { kind: "open", path: "notes.txt" },
            { kind: "run", file: "obs.exe", args: [] },
            { kind: "website", url: "file:///etc/passwd" },
            { kind: "website", url: "javascript:alert(1)" },
            { kind: "run", file: "C:\\a.exe", args: ["ok", "bad\nline"] },
            { kind: "hotkey", key: "launchRockets" },
            { kind: "delay", ms: 10_001 }
        ]) {
            expect(deviceActionSchema.safeParse(action([step])).success, JSON.stringify(step)).toBe(false);
        }
    });

    it("caps the total delay, needs one real step and keeps a second state", () => {
        const long = Array.from({ length: 7 }, () => ({ kind: "delay", ms: 10_000 }));
        expect(7 * 10_000).toBeGreaterThan(MAX_DEVICE_ACTION_TOTAL_DELAY_MS);
        expect(deviceActionSchema.safeParse(action([...long, { kind: "website", url: "https://a.b" }])).success).toBe(false);
        expect(deviceActionSchema.safeParse(action([{ kind: "delay", ms: 5 }])).success).toBe(false);
        const toggle = deviceActionSchema.parse(action([{ kind: "hotkey", key: "f9" }], { off: [{ kind: "hotkey", key: "f10" }] }));
        expect(toggle.off).toHaveLength(1);
        expect(deviceActionSchema.safeParse(action([{ kind: "hotkey", key: "f9" }], { name: "   " })).success).toBe(false);
    });

    it("reads what a button's value names", () => {
        expect(readActionRef("call.mic")).toEqual({ kind: "call", action: "call.mic" });
        expect(readActionRef("custom:a1")).toEqual({ kind: "custom", id: "a1" });
        expect(readActionRef("launcher:page:/chat")).toEqual({ kind: "launcher", entry: "page:/chat" });
        for (const bad of ["custom:", "custom:../x", "launcher:page:chat", "launcher:url:https://x", "rm -rf"]) expect(readActionRef(bad), bad).toBeNull();
        expect(pluginActionRefSchema.safeParse("custom:a1").success).toBe(true);
        expect(pluginActionRefSchema.safeParse("call.record").success).toBe(false);
    });

    it("checks each request the page sends", () => {
        expect(deviceActionRequestSchema.safeParse({ kind: "pick", what: "program" }).success).toBe(true);
        expect(deviceActionRequestSchema.safeParse({ kind: "pick", what: "anything" }).success).toBe(false);
        expect(deviceActionRequestSchema.safeParse({ kind: "run", id: "A B" }).success).toBe(false);
    });
});

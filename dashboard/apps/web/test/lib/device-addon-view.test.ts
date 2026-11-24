import { describe, expect, it } from "vitest";
import { addonViewHeight, addonViewTokens, addonViewUrl, readAddonViewMessage, readAddonViewReply, ADDON_VIEW_HEIGHT } from "@/lib/device-addon-view";

describe("an add-on view's frame", () => {
    it("loads the view's file from the root of the add-on's address", () => {
        expect(addonViewUrl("hercules-stream100", "view/index.html")).toBe("polaris-addon://hercules-stream100/index.html");
        expect(addonViewUrl("pedal", "editor page.html")).toBe("polaris-addon://pedal/editor%20page.html");
    });

    it("reads only the messages a view may send", () => {
        expect(readAddonViewMessage({ type: "ready" })).toEqual({ type: "ready" });
        expect(readAddonViewMessage({ type: "call", id: 3, method: "settings.set", params: { key: "knob1", value: "music" } })).toEqual({
            type: "call",
            id: 3,
            method: "settings.set",
            params: { key: "knob1", value: "music" }
        });
        expect(readAddonViewMessage({ type: "call", id: -1, method: "x" })).toBeNull();
        expect(readAddonViewMessage({ type: "call", id: 1, method: "m".repeat(65) })).toBeNull();
        expect(readAddonViewMessage({ type: "navigate", url: "https://example.test" })).toBeNull();
        expect(readAddonViewMessage("ready")).toBeNull();
    });

    it("holds the height it asks for between the bounds", () => {
        expect(addonViewHeight(10)).toBe(ADDON_VIEW_HEIGHT.min);
        expect(addonViewHeight(1e9)).toBe(ADDON_VIEW_HEIGHT.max);
        expect(addonViewHeight(300.4)).toBe(300);
        expect(readAddonViewMessage({ type: "resize", height: Number.POSITIVE_INFINITY })).toBeNull();
    });

    it("reads the app's answer, and anything else as a failure", () => {
        expect(readAddonViewReply({ ok: true, value: { knob1: "music" } })).toEqual({ ok: true, value: { knob1: "music" } });
        expect(readAddonViewReply({ ok: false, error: "permission" })).toEqual({ ok: false, error: "permission" });
        expect(readAddonViewReply({ ok: false, error: "secret path C:/x" })).toEqual({ ok: false, error: "failed" });
        expect(readAddonViewReply(null)).toEqual({ ok: false, error: "failed" });
    });

    it("hands over the page's tokens that are set, and only those", () => {
        const values: Record<string, string> = { "--background": " 220 13% 9% ", "--primary": "210 90% 60%", "--secret": "x" };
        const tokens = addonViewTokens({ getPropertyValue: (name: string) => values[name] ?? "" });
        expect(tokens).toEqual({ "--background": "220 13% 9%", "--primary": "210 90% 60%" });
    });
});

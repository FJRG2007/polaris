import { describe, expect, it } from "vitest";
import { pluginViewHeight, pluginViewTokens, pluginViewUrl, readPluginViewMessage, readPluginViewReply, PLUGIN_VIEW_HEIGHT } from "@/lib/device-plugin-view";

describe("a plugin view's frame", () => {
    it("loads the view's file from the root of the plugin's address", () => {
        expect(pluginViewUrl("hercules-stream100", "view/index.html")).toBe("polaris-addon://hercules-stream100/index.html");
        expect(pluginViewUrl("pedal", "editor page.html")).toBe("polaris-addon://pedal/editor%20page.html");
    });

    it("reads only the messages a view may send", () => {
        expect(readPluginViewMessage({ type: "ready" })).toEqual({ type: "ready" });
        expect(readPluginViewMessage({ type: "call", id: 3, method: "settings.set", params: { key: "knob1", value: "music" } })).toEqual({
            type: "call",
            id: 3,
            method: "settings.set",
            params: { key: "knob1", value: "music" }
        });
        expect(readPluginViewMessage({ type: "call", id: -1, method: "x" })).toBeNull();
        expect(readPluginViewMessage({ type: "call", id: 1, method: "m".repeat(65) })).toBeNull();
        expect(readPluginViewMessage({ type: "navigate", url: "https://example.test" })).toBeNull();
        expect(readPluginViewMessage("ready")).toBeNull();
    });

    it("holds the height it asks for between the bounds", () => {
        expect(pluginViewHeight(10)).toBe(PLUGIN_VIEW_HEIGHT.min);
        expect(pluginViewHeight(1e9)).toBe(PLUGIN_VIEW_HEIGHT.max);
        expect(pluginViewHeight(300.4)).toBe(300);
        expect(readPluginViewMessage({ type: "resize", height: Number.POSITIVE_INFINITY })).toBeNull();
    });

    it("reads the app's answer, and anything else as a failure", () => {
        expect(readPluginViewReply({ ok: true, value: { knob1: "music" } })).toEqual({ ok: true, value: { knob1: "music" } });
        expect(readPluginViewReply({ ok: false, error: "permission" })).toEqual({ ok: false, error: "permission" });
        expect(readPluginViewReply({ ok: false, error: "secret path C:/x" })).toEqual({ ok: false, error: "failed" });
        expect(readPluginViewReply(null)).toEqual({ ok: false, error: "failed" });
    });

    it("hands over the page's tokens that are set, and only those", () => {
        const values: Record<string, string> = { "--background": " 220 13% 9% ", "--primary": "210 90% 60%", "--secret": "x" };
        const tokens = pluginViewTokens({ getPropertyValue: (name: string) => values[name] ?? "" });
        expect(tokens).toEqual({ "--background": "220 13% 9%", "--primary": "210 90% 60%" });
    });
});

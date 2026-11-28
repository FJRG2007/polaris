import { describe, expect, it } from "vitest";
import * as plugins from "../src/device-plugins.js";

const SETTINGS: plugins.PluginSetting[] = [
    { kind: "toggle", key: "enabled", label: { "en-US": "On" }, default: true },
    { kind: "choice", key: "knob1", group: "knobs", label: { "en-US": "Knob 1" }, default: "calls", options: ["calls", "music", "games"].map((value) => ({ value, label: { "en-US": value } })) },
    { kind: "range", key: "brightness", group: "screen", label: { "en-US": "Brightness" }, default: 80, min: 0, max: 100, step: 1 }
];
const NONE: plugins.PluginProfileSignals = { call: false, meeting: null, games: [], front: null };
const rules = (over: Partial<typeof plugins.NO_PLUGIN_PROFILE_RULES>) => ({ ...plugins.NO_PLUGIN_PROFILE_RULES, ...over });

function profiles(manual: string | null = null): plugins.PluginProfiles {
    return {
        manual,
        list: [
            { id: "work", name: "Work", rules: rules({ meeting: true, apps: ["excel"] }), values: { knob1: "music", brightness: 40 } },
            { id: "play", name: "Play", rules: rules({ game: true, call: true, apps: ["excel"] }), values: { knob1: "games", brightness: 100 } }
        ]
    };
}

describe("stored profiles", () => {
    it("reads nothing stored (an install from before profiles) as Default alone", () => {
        expect(plugins.readPluginProfiles(SETTINGS, undefined)).toEqual({ manual: null, list: [] });
        expect(plugins.readPluginProfiles(SETTINGS, "broken")).toEqual({ manual: null, list: [] });
    });

    it("keeps whole profiles, drops broken ones, and refits values that no longer fit", () => {
        const read = plugins.readPluginProfiles(SETTINGS, {
            manual: "gone",
            list: [
                { id: "a", name: "A", rules: { game: true }, values: { knob1: "radio", brightness: 30, enabled: false } },
                { id: "a", name: "Twice", values: {} },
                { id: "default", name: "Default", values: {} },
                { id: "BAD ID", name: "x" },
                { id: "b", name: "  " }
            ]
        });
        expect(read).toEqual({ manual: null, list: [{ id: "a", name: "A", rules: rules({ game: true }), values: { knob1: "calls", brightness: 30 } }] });
    });

    it("runs a profile over the settings file, ungrouped settings shared", () => {
        expect(plugins.pluginProfileValues({ enabled: false, knob1: "calls", brightness: 80 }, profiles(), "work")).toEqual({ enabled: false, knob1: "music", brightness: 40 });
        expect(plugins.pluginProfileValues({ enabled: true, knob1: "calls", brightness: 80 }, profiles(), "default")).toEqual({ enabled: true, knob1: "calls", brightness: 80 });
    });
});

describe("which profile is in use", () => {
    it("follows manual > call > meeting > game > app > Default", () => {
        const all: plugins.PluginProfileSignals = { call: true, meeting: "zoom", games: ["valorant"], front: "C:\\Office\\EXCEL.EXE" };
        expect(plugins.choosePluginProfile(profiles("work"), all)).toEqual({ id: "work", reason: "manual", subject: null });
        expect(plugins.choosePluginProfile(profiles(), all)).toEqual({ id: "play", reason: "call", subject: null });
        expect(plugins.choosePluginProfile(profiles(), { ...all, call: false })).toEqual({ id: "work", reason: "meeting", subject: "zoom" });
        expect(plugins.choosePluginProfile(profiles(), { ...all, call: false, meeting: null })).toEqual({ id: "play", reason: "game", subject: "valorant" });
        // Both list excel: the first profile wins.
        expect(plugins.choosePluginProfile(profiles(), { ...NONE, front: "C:\\Office\\EXCEL.EXE" })).toEqual({ id: "work", reason: "app", subject: "C:\\Office\\EXCEL.EXE" });
        expect(plugins.choosePluginProfile(profiles(), NONE)).toEqual({ id: "default", reason: "default", subject: null });
    });

    it("waits 2 s before an automatic switch, and switches at once for a hand pick", () => {
        const game = { id: "play", reason: "game", subject: "x" } as const;
        const base = { id: "default", reason: "default", subject: null } as const;
        let hold = plugins.holdPluginProfile(plugins.NO_PLUGIN_PROFILE_HOLD, base, 0);
        hold = plugins.holdPluginProfile(hold, game, 1_000);
        expect(hold.active?.id).toBe("default");
        hold = plugins.holdPluginProfile(hold, game, 2_999);
        expect(hold.active?.id).toBe("default");
        hold = plugins.holdPluginProfile(hold, game, 3_000);
        expect(hold.active?.id).toBe("play");
        // A blip back resets the wait.
        hold = plugins.holdPluginProfile(hold, base, 3_500);
        hold = plugins.holdPluginProfile(hold, game, 4_000);
        hold = plugins.holdPluginProfile(hold, base, 4_500);
        expect(hold.active?.id).toBe("play");
        expect(plugins.holdPluginProfile(hold, { id: "work", reason: "manual", subject: null }, 4_600).active?.id).toBe("work");
    });
});

describe("profile requests", () => {
    const flat = { enabled: true, knob1: "music", brightness: 50 };
    const id = () => "new1";

    it("creates from the defaults or as a copy, with unique names and a cap", () => {
        const blank = plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "create", name: "Stream" }, id);
        expect(blank).toMatchObject({ ok: true, id: "new1" });
        if (blank.ok) expect(blank.profiles.list.at(-1)?.values).toEqual({ knob1: "calls", brightness: 80 });
        const copy = plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "create", name: "Copy", from: "default" }, id);
        if (copy.ok) expect(copy.profiles.list.at(-1)?.values).toEqual({ knob1: "music", brightness: 50 });
        expect(plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "create", name: " work " }, id)).toEqual({ ok: false, error: "name-taken" });
        expect(plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "create", name: "DEFAULT" }, id)).toEqual({ ok: false, error: "name-taken" });
        const many: plugins.PluginProfiles = { manual: null, list: Array.from({ length: 16 }, (_, n) => ({ id: `p${n}`, name: `P${n}`, rules: plugins.NO_PLUGIN_PROFILE_RULES, values: {} })) };
        expect(plugins.applyPluginProfileRequest(SETTINGS, flat, many, { op: "create", name: "One more" }, id)).toEqual({ ok: false, error: "full" });
    });

    it("renames, sets rules, deletes (clearing its hand pick) and never touches Default", () => {
        const renamed = plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "rename", profile: "work", name: "Office" }, id);
        if (renamed.ok) expect(renamed.profiles.list[0]?.name).toBe("Office");
        expect(plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "rename", profile: "work", name: "play" }, id)).toEqual({ ok: false, error: "name-taken" });
        const ruled = plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "rules", profile: "work", rules: rules({ call: true }) }, id);
        if (ruled.ok) expect(ruled.profiles.list[0]?.rules.call).toBe(true);
        const gone = plugins.applyPluginProfileRequest(SETTINGS, flat, profiles("work"), { op: "delete", profile: "work" }, id);
        expect(gone).toMatchObject({ ok: true, profiles: { manual: null } });
        expect(plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "delete", profile: "default" }, id)).toEqual({ ok: false, error: "default" });
        expect(plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "pick", profile: "nope" }, id)).toEqual({ ok: false, error: "not-found" });
        expect(plugins.applyPluginProfileRequest(SETTINGS, flat, profiles(), { op: "pick", profile: "default" }, id)).toMatchObject({ ok: true, profiles: { manual: "default" } });
    });
});

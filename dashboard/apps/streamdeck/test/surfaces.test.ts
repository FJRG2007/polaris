/**
 * The call, soundboard and Places actions are the same key and dial offering
 * only their part of the catalogue, and a key draws the icon its state names.
 */

import { ICONS } from "../src/icons";
import { faceFor } from "../src/face";
import { wordsFor } from "../src/words";
import { describe, expect, it } from "vitest";
import type { DeckAction } from "../src/polaris";
import { offered, surfaceOf, PLUGIN_UUID } from "../src/surfaces";

const words = wordsFor("en");

function entry(id: string, area: string, kind: DeckAction["kind"], icon = "power"): DeckAction {
    return { id, kind, area, label: id, icon, options: [], live: true };
}

const CATALOGUE: DeckAction[] = [
    entry("chat.send", "chat", "run"),
    entry("call.mic", "call", "toggle", "mic"),
    entry("call.hangup", "call", "run", "phone-off"),
    entry("call.sound", "call", "run", "volume-2"),
    entry("places.device", "places", "toggle", "house"),
    entry("places.brightness", "places", "dial"),
    entry("places.climate", "places", "dial"),
    entry("deploy.redeploy", "deploy", "run")
];

const ids = (surface: Parameters<typeof offered>[1]) =>
    offered(CATALOGUE, surface).map((action) => action.id);

describe("surfaceOf", () => {
    it("names the surface of every action that takes the catalogue", () => {
        expect(surfaceOf(`${PLUGIN_UUID}.key`)).toBe("key");
        expect(surfaceOf(`${PLUGIN_UUID}.dial`)).toBe("dial");
        expect(surfaceOf(`${PLUGIN_UUID}.call`)).toBe("call");
        expect(surfaceOf(`${PLUGIN_UUID}.sound`)).toBe("sound");
        expect(surfaceOf(`${PLUGIN_UUID}.places`)).toBe("places");
        expect(surfaceOf(`${PLUGIN_UUID}.places-dial`)).toBe("places-dial");
    });

    it("gives the timer only Calendar's timers, and has none for an id it does not know", () => {
        expect(surfaceOf(`${PLUGIN_UUID}.timer`)).toBe("timer");
        expect(
            offered(
                [
                    { id: "calendar.timer", kind: "toggle", area: "tools" },
                    { id: "tool.clock_timer_start", kind: "run", area: "tools" }
                ] as never,
                "timer"
            ).map((action) => action.id)
        ).toEqual(["calendar.timer"]);
        expect(surfaceOf("")).toBeNull();
        expect(surfaceOf("com.example.other.key")).toBeNull();
    });
});

describe("offered", () => {
    it("gives the general key everything but dials, and the dial only dials", () => {
        expect(ids("key")).toEqual([
            "chat.send",
            "call.mic",
            "call.hangup",
            "call.sound",
            "places.device",
            "deploy.redeploy"
        ]);
        expect(ids("dial")).toEqual(["places.brightness", "places.climate"]);
    });

    it("gives the call key the call's switches, and the soundboard only its sound", () => {
        expect(ids("call")).toEqual(["call.mic", "call.hangup"]);
        expect(ids("sound")).toEqual(["call.sound"]);
    });

    it("gives the Places key and dial only what is in Places, of their kind", () => {
        expect(ids("places")).toEqual(["places.device"]);
        expect(ids("places-dial")).toEqual(["places.brightness", "places.climate"]);
    });
});

describe("a key's icon", () => {
    const mic = entry("call.mic", "call", "toggle", "mic");

    it("is the one its state names, when the plugin can draw it", () => {
        const face = faceFor(
            "online",
            { action: "call.mic" },
            mic,
            { tone: "warn", on: true, icon: "mic-off", detail: "Muted" },
            words
        );
        expect(face).toMatchObject({ icon: "mic-off", tone: "warn", on: true, label: "Muted" });
    });

    it("stays the action's for a name this plugin does not know, or none", () => {
        const unknown = faceFor(
            "online",
            { action: "call.mic" },
            mic,
            { tone: "idle", icon: "not-an-icon" },
            words
        );
        expect(unknown.icon).toBe("mic");
        expect(faceFor("online", { action: "call.mic" }, mic, { tone: "idle" }, words).icon).toBe(
            "mic"
        );
    });

    it("can draw every icon the call and Places keys name", () => {
        for (const name of [
            "mic",
            "mic-off",
            "headphones",
            "headphone-off",
            "video",
            "video-off",
            "circle-dot",
            "phone-off",
            "volume-2",
            "screen-share",
            "house",
            "lightbulb",
            "zap",
            "plug",
            "snowflake",
            "fan",
            "lock",
            "lock-open",
            "door-open",
            "power"
        ])
            expect(ICONS[name], name).toBeTruthy();
    });
});

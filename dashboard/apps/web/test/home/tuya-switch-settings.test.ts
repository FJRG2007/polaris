/**
 * A Tuya wall switch's settings beside on and off - power-on state, indicator,
 * child lock, a timer per gang - and how each row says it was reached: read
 * from what the device reports, written back in its own spelling, and checked
 * before anything is sent.
 */

import { describe, expect, it } from "vitest";
import * as kinds from "@polaris-app/places/src/lib/device-kinds";
import {
    tuyaActionFor,
    tuyaReachWord,
    tuyaSnapshots,
    tuyaSwitchCommands,
    tuyaSwitchSettings,
    type TuyaDeviceShape
} from "@polaris-app/places/src/lib/drivers/tuya-vocabulary";

const plate: TuyaDeviceShape = {
    id: "bf3a1c0d2e4f5a6b7c8d9e",
    name: "Kitchen",
    category: "kg",
    online: true,
    status: [
        { code: "switch_1", value: true },
        { code: "switch_2", value: false },
        { code: "countdown_1", value: 0 },
        { code: "countdown_2", value: 120 },
        { code: "relay_status", value: "last" },
        { code: "light_mode", value: "relay" },
        { code: "child_lock", value: false }
    ]
};

const bare: TuyaDeviceShape = {
    id: "bf9e8d7c6b5a4f3e2d1c0b",
    name: "Hall",
    category: "kg",
    online: true,
    status: [{ code: "switch_1", value: true }]
};

const noSpec = () => Promise.reject(new Error("no specification in this test"));

describe("what a switch reports", () => {
    it("reads every setting the plate has, and each gang's own timer", () => {
        const [first, second] = tuyaSnapshots([plate]);
        expect(first!.switchSettings).toEqual({
            powerOn: "last",
            indicator: "status",
            indicators: ["off", "status", "position"],
            childLock: false,
            countdown: 0
        });
        expect(second!.switchSettings?.countdown).toBe(120);
    });

    it("offers nothing a switch does not report", () => {
        const [only] = tuyaSnapshots([bare]);
        expect(only!.switchSettings).toBeNull();
    });

    it("reads a backlight as on or off", () => {
        const byCode = new Map<string, unknown>([
            ["switch", true],
            ["switch_backlight", true]
        ]);
        expect(tuyaSwitchSettings(byCode, "switch")).toMatchObject({
            indicator: "on",
            indicators: ["off", "on"],
            powerOn: null,
            childLock: null,
            countdown: null
        });
    });

    it("understands each spelling of the power-on state", () => {
        for (const [word, state] of [
            ["power_on", "on"],
            ["memory", "last"],
            ["0", "off"]
        ] as const) {
            const byCode = new Map<string, unknown>([["relay_status", word]]);
            expect(tuyaSwitchSettings(byCode, "switch_1")?.powerOn).toBe(state);
        }
    });

    it("is never handed a setting for a light or an air conditioner", () => {
        const light: TuyaDeviceShape = {
            id: "light-1",
            name: "Lamp",
            category: "dj",
            online: true,
            status: [
                { code: "switch_led", value: true },
                { code: "child_lock", value: true }
            ]
        };
        expect(tuyaSnapshots([light])[0]!.switchSettings).toBeNull();
    });
});

describe("how it was reached", () => {
    it("says local, cloud, refused key or cloud only, in a word", () => {
        expect(tuyaReachWord({ route: "local", reason: null })).toBe("local");
        expect(tuyaReachWord({ route: "cloud", reason: "not-found" })).toBe("cloud");
        expect(tuyaReachWord({ route: "cloud", reason: "key" })).toBe("cloud-key");
        expect(tuyaReachWord({ route: "cloud", reason: "no-key" })).toBe("cloud-only");
        expect(tuyaReachWord(undefined)).toBeNull();
    });

    it("puts it on every gang of the device", () => {
        const rows = tuyaSnapshots(
            [plate, bare],
            new Map(),
            new Map([[plate.id, { route: "local", reason: null }]])
        );
        expect(rows.map((row) => row.reach)).toEqual(["local", "local", null]);
    });
});

describe("what is sent", () => {
    const reported = new Map(plate.status.map((point) => [point.code, point.value] as const));

    it("answers the power-on state in the device's own spelling", () => {
        const command = { action: "set-option", setting: "power-on", value: "on" } as const;
        expect(tuyaSwitchCommands("switch_1", command, reported, null)).toEqual([
            { code: "relay_status", value: "power_on" }
        ]);
        const digits = new Map<string, unknown>([["relay_status", "2"]]);
        expect(tuyaSwitchCommands("switch_1", command, digits, null)).toEqual([
            { code: "relay_status", value: "1" }
        ]);
    });

    it("sets the status light, or a backlight where that is what it has", () => {
        expect(
            tuyaSwitchCommands(
                "switch_1",
                { action: "set-option", setting: "indicator", value: "position" },
                reported,
                null
            )
        ).toEqual([{ code: "light_mode", value: "pos" }]);
        const backlit = new Map<string, unknown>([["switch_backlight", false]]);
        expect(
            tuyaSwitchCommands(
                "switch",
                { action: "set-option", setting: "indicator", value: "on" },
                backlit,
                null
            )
        ).toEqual([{ code: "switch_backlight", value: true }]);
    });

    it("sets the timer of the gang the row stands for", () => {
        expect(
            tuyaSwitchCommands(
                "switch_2",
                { action: "set-option", setting: "countdown", seconds: 300 },
                reported,
                null
            )
        ).toEqual([{ code: "countdown_2", value: 300 }]);
    });

    it("addresses the device, not the gang, through the action path", async () => {
        const sent = await tuyaActionFor(
            { externalId: `${plate.id}#switch_2`, kind: "switch" },
            "set-option",
            { action: "set-option", setting: "child-lock", on: true },
            noSpec,
            (id) => (id === plate.id ? plate.status : null)
        );
        expect(sent).toEqual({
            deviceId: plate.id,
            commands: [{ code: "child_lock", value: true }]
        });
    });

    it("refuses a setting that is not a switch's", async () => {
        await expect(
            tuyaActionFor(
                { externalId: `${plate.id}#switch_1`, kind: "switch" },
                "set-option",
                { action: "set-option", option: "swing", on: true },
                noSpec
            )
        ).rejects.toThrow("Say what to set it to");
    });
});

describe("what Places accepts", () => {
    const view = kinds.switchSettingsView({
        powerOn: "off",
        indicator: "off",
        indicators: ["off", "on"],
        childLock: null,
        countdown: 0
    });

    it("reads an older row, missing fields and all, without failing", () => {
        expect(kinds.switchSettingsView({ powerOn: "on" })).toEqual({
            powerOn: "on",
            indicator: null,
            indicators: [],
            childLock: null,
            countdown: null
        });
        expect(kinds.switchSettingsView({ powerOn: "sideways", countdown: -4 })).toBeNull();
        expect(kinds.switchSettingsView(null)).toBeNull();
        expect(kinds.switchSettingsView([1, 2])).toBeNull();
        expect(kinds.deviceReach("somewhere")).toBeNull();
        expect(kinds.deviceReach("cloud-only")).toBe("cloud-only");
    });

    it("checks a setting against what the switch has", () => {
        const target = { kind: "switch", climate: null, air: null, switchSettings: view };
        const lock = { action: "set-option", setting: "child-lock", on: true } as const;
        expect(kinds.commandIssue(target, lock)).toBe("That device does not have that setting");
        const status = { action: "set-option", setting: "indicator", value: "status" } as const;
        expect(kinds.commandIssue(target, status)).toBe("That device does not have that setting");
        const on = { action: "set-option", setting: "indicator", value: "on" } as const;
        expect(kinds.commandIssue(target, on)).toBeNull();
        expect(kinds.applyCommand(target, on)).toEqual({
            switchSettings: { ...view, indicator: "on" }
        });
    });

    it("refuses a timer out of range before it reaches the device", () => {
        const parsed = kinds.deviceCommandSchema.safeParse({
            action: "set-option",
            setting: "countdown",
            seconds: 90_000
        });
        expect(parsed.success).toBe(false);
    });

    it("keeps a switch a switch: no settings button on its rows", () => {
        expect(kinds.isSwitchable("switch")).toBe(true);
        expect(kinds.actionsFor("switch")).toEqual(["turn-on", "turn-off"]);
        expect(kinds.acceptsAction("switch", "set-option")).toBe(true);
        expect(kinds.acceptsAction("outlet", "set-option")).toBe(true);
        expect(kinds.acceptsAction("sensor", "set-option")).toBe(false);
    });

    it("says a timer's length in words", () => {
        expect(kinds.countdownText(0)).toBe("No timer");
        expect(kinds.countdownText(300)).toBe("5 min");
        expect(kinds.countdownText(7200)).toBe("2 h");
        expect(kinds.countdownText(5400)).toBe("1 h 30 min");
        expect(kinds.reachText("cloud")).toBe("Not found on this network, using the cloud");
    });
});

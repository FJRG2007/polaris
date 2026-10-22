/**
 * Places on a deck: what a device key shows is in its reader's language.
 */

import { describe, expect, it } from "vitest";

const { placesDeckActions, clampTarget, commandPress, naturalAction, naturalState, targetPress } =
    await import("@polaris-app/places/src/lib/deck-actions");

const toggle = placesDeckActions().find((action) => action.id === "places.device-toggle")!;
const device = (online: boolean, state = "on") => ({
    devices: [{ id: "d1", name: "Lamp", state, online, operable: true, actions: [] }]
});

describe("places device state", () => {
    it("names an offline device in the reader's language", () => {
        expect(toggle.read!.pick(device(false), "en-US")).toEqual({
            tone: "bad",
            detail: "Offline"
        });
        expect(toggle.read!.pick(device(false), "es-ES")).toEqual({
            tone: "bad",
            detail: "Sin conexión"
        });
    });

    it("shows an online device as on or off with no words", () => {
        expect(toggle.read!.pick(device(true), "es-ES")).toEqual({ tone: "ok", on: true });
        expect(toggle.read!.pick(device(true, "off"), "en-US")).toEqual({
            tone: "idle",
            on: false
        });
    });
});
const action = (id: string) => placesDeckActions().find((entry) => entry.id === id)!;
const DEVICE = "22222222-2222-4222-8222-222222222222";
const air = (state: string, target: number | null) => ({
    devices: [
        {
            id: "a1",
            name: "Air",
            state,
            online: true,
            operable: true,
            actions: [],
            climate: { target, min: 16, max: 30, step: 0.5 }
        }
    ]
});

describe("places doors", () => {
    const door = action("places.door");

    it("opens by default and sends the command picked, through the device tool", () => {
        const options = door.options.safeParse({ deviceId: DEVICE });
        expect(options.success && options.data).toEqual({ deviceId: DEVICE, command: "open" });
        expect(door.run.tool).toBe("places_device_control");
        expect(door.run.input({ deviceId: DEVICE, command: "lock" }, {})).toEqual({
            deviceId: DEVICE,
            action: "lock"
        });
        expect(door.options.safeParse({ deviceId: DEVICE, command: "dump" }).success).toBe(false);
        expect(door.scope).toBe("home.control");
    });

    it("lists only devices that lock, and names the bolt in the reader's language", () => {
        const pick = door.fields[0]!.choices!.pick;
        expect(
            pick({
                devices: [
                    { id: "l", name: "Front", online: true, operable: true, actions: ["lock"] },
                    { id: "p", name: "Plug", online: true, operable: true, actions: ["turn-on"] }
                ]
            })
        ).toEqual([{ value: "l", label: "Front" }]);
        expect(door.fields[1]!.fixed!.map((choice) => choice.label["es-ES"])).toEqual([
            "Abrir",
            "Desbloquear",
            "Bloquear"
        ]);
        expect(door.read!.pick(device(true, "locked"), "es-ES")).toEqual({
            tone: "ok",
            on: true,
            detail: "Cerrada"
        });
    });
});

describe("places air conditioners", () => {
    it("turns the dial to a temperature and pushes it on or off", () => {
        const dial = action("places.climate");
        expect(dial.dial).toEqual({ min: 16, max: 30, step: 0.5 });
        expect(dial.run.input({ deviceId: DEVICE, level: 31 }, { read: air("on", 22) })).toEqual({
            deviceId: DEVICE,
            action: "set-temperature",
            target: 30
        });
        expect(
            dial.run.input(
                { deviceId: DEVICE, level: 22 },
                { push: true, current: { tone: "ok", on: true } }
            )
        ).toEqual({ deviceId: DEVICE, action: "turn-off" });
        expect(dial.read!.pick(air("on", 22.5), "en-US")).toEqual({
            tone: "ok",
            on: true,
            value: "22.5°"
        });
    });

    it("steps from the temperature it is set to, and sends nothing without one", () => {
        const step = action("places.temperature-step");
        expect(step.run.input({ deviceId: DEVICE, change: -1 }, { read: air("on", 22) })).toEqual({
            deviceId: DEVICE,
            action: "set-temperature",
            target: 21
        });
        expect(
            step.run.input({ deviceId: DEVICE, change: 1 }, { read: air("on", null) })
        ).toBeNull();
        expect(clampTarget(22.3, { min: 16, max: 30, step: 0.5 })).toBe(22.5);
    });

    it("leaves dumping a litter box off the deck", () => {
        const command = action("places.device-command");
        expect(command.options.safeParse({ deviceId: DEVICE, command: "dump" }).success).toBe(
            false
        );
        expect(command.options.safeParse({ deviceId: DEVICE, command: "turn-on" }).success).toBe(
            true
        );
    });
});

describe("a device on its own key", () => {
    const own = action("places.device");
    const one = (fields: Record<string, unknown>) => ({
        devices: [{ id: "d1", name: "Thing", online: true, operable: true, actions: [], ...fields }]
    });

    it("does what its owner means: flips on and off, opens a door, locks a lock", () => {
        expect(naturalAction({ state: "on", actions: ["turn-on", "turn-off"] })).toBe("turn-off");
        expect(naturalAction({ state: "off", actions: ["turn-on", "turn-off"] })).toBe("turn-on");
        expect(naturalAction({ state: null, actions: ["turn-on", "turn-off"] })).toBe("turn-on");
        // A door with a latch opens - unlocked and pulled - rather than locking.
        expect(naturalAction({ state: "locked", actions: ["lock", "unlock", "open"] })).toBe(
            "open"
        );
        expect(naturalAction({ state: "locked", actions: ["lock", "unlock"] })).toBe("unlock");
        expect(naturalAction({ state: "unlocked", actions: ["lock", "unlock"] })).toBe("lock");
        expect(naturalAction({ state: "on", actions: ["turn-on"] })).toBeNull();
        expect(naturalAction({ state: null, actions: [] })).toBeNull();
    });

    it("reads the device on the press and sends nothing it has no natural thing for", () => {
        expect(own.kind).toBe("toggle");
        expect(own.scope).toBe("home.control");
        expect(own.run.tool).toBe("places_device_control");
        expect(
            own.run.input(
                { deviceId: DEVICE },
                { read: one({ state: "on", actions: ["turn-on", "turn-off"] }) }
            )
        ).toEqual({ deviceId: DEVICE, action: "turn-off" });
        expect(
            own.run.input({ deviceId: DEVICE }, { read: one({ actions: ["dump"] }) })
        ).toBeNull();
        expect(own.run.input({ deviceId: DEVICE }, {})).toBeNull();
        expect(own.options.safeParse({ deviceId: "not-a-device" }).success).toBe(false);
    });

    it("draws its kind, its bolt and the temperature it is set to", () => {
        expect(naturalState(one({ kind: "light", state: "on", actions: [] }), "en-US")).toEqual({
            tone: "ok",
            on: true,
            icon: "lightbulb"
        });
        expect(naturalState(one({ kind: "unknown", state: "off", actions: [] }), "en-US")).toEqual({
            tone: "idle",
            on: false,
            icon: "power"
        });
        expect(
            naturalState(
                one({ kind: "climate", state: "on", actions: [], climate: { target: 22.5 } }),
                "en-US"
            )
        ).toEqual({ tone: "ok", on: true, icon: "snowflake", value: "22.5°" });
        expect(
            naturalState(one({ kind: "lock", state: "unlocked", actions: [] }), "es-ES")
        ).toEqual({ tone: "warn", on: false, icon: "lock-open", detail: "Abierta" });
        expect(naturalState(one({ kind: "lock", state: "locked", actions: [] }), "en-US")).toEqual({
            tone: "ok",
            on: true,
            icon: "lock",
            detail: "Locked"
        });
    });

    it("says an offline device is offline, still in its kind's icon", () => {
        expect(
            naturalState(one({ kind: "air", state: "on", online: false, actions: [] }), "es-ES")
        ).toEqual({ tone: "bad", icon: "fan", detail: "Sin conexión" });
        expect(naturalState({ devices: [] }, "en-US")).toEqual({ tone: "idle" });
    });
});

describe("every device kind has a key", () => {
    // What places_devices lists for each kind, by the actions' spoken names.
    const KINDS: Record<string, string[]> = {
        lock: ["lock", "unlock", "open"],
        opener: ["open"],
        climate: ["turn-on", "turn-off", "set-mode", "set-temperature", "set-fan", "set-option"],
        air: ["turn-on", "turn-off", "set-mode", "set-fan", "set-option", "set-humidity"],
        switch: ["turn-on", "turn-off"],
        outlet: ["turn-on", "turn-off"],
        light: ["turn-on", "turn-off", "set-brightness", "set-color-temp", "set-color"],
        appliance: ["stop"],
        litter: ["clean", "pause", "resume", "dump", "reset-deodorizer", "set-option"]
    };
    const listing = {
        devices: [
            ...Object.entries(KINDS).map(([kind, actions]) => ({
                id: kind,
                name: kind,
                kind,
                online: true,
                operable: true,
                actions
            })),
            {
                id: "sensor",
                name: "sensor",
                kind: "sensor",
                online: true,
                operable: false,
                actions: [],
                reading: { value: "21.5", unit: "°C" }
            }
        ]
    };
    const listed = (id: string, field = 0) =>
        action(id)
            .fields[field]!.choices!.pick(listing)
            .map((choice) => choice.value);

    it("lists each kind in the pickers of the keys that work it", () => {
        expect(listed("places.door")).toEqual(["lock", "opener"]);
        expect(listed("places.device")).toEqual(Object.keys(KINDS));
        expect(listed("places.device-toggle")).toEqual([
            "climate",
            "air",
            "switch",
            "outlet",
            "light"
        ]);
        expect(listed("places.brightness")).toEqual(["light"]);
        expect(listed("places.light-white")).toEqual(["light"]);
        expect(listed("places.light-color")).toEqual(["light"]);
        expect(listed("places.climate")).toEqual(["climate"]);
        expect(listed("places.device-setting")).toEqual(["climate", "air"]);
        expect(listed("places.reading")).toEqual(["sensor"]);
    });

    it("opens an opener with the one command it takes", () => {
        expect(action("places.door").run.input({ deviceId: DEVICE, command: "open" }, {})).toEqual({
            deviceId: DEVICE,
            action: "open"
        });
    });

    it("sends a light's warmth and colour, and a mode or fan by name", () => {
        expect(
            action("places.light-white").run.input({ deviceId: DEVICE, kelvin: 2700 }, {})
        ).toEqual({
            deviceId: DEVICE,
            action: "set-color-temp",
            kelvin: 2700
        });
        expect(
            action("places.light-color").run.input(
                { deviceId: DEVICE, hue: 120, saturation: 80 },
                {}
            )
        ).toEqual({ deviceId: DEVICE, action: "set-color", hue: 120, saturation: 80 });
        const setting = action("places.device-setting");
        expect(
            setting.run.input({ deviceId: DEVICE, command: "set-fan", value: "high" }, {})
        ).toEqual({ deviceId: DEVICE, action: "set-fan", fan: "high" });
        expect(
            setting.run.input({ deviceId: DEVICE, command: "set-mode", value: "cool" }, {})
        ).toEqual({ deviceId: DEVICE, action: "set-mode", mode: "cool" });
        expect(
            setting.options.safeParse({ deviceId: DEVICE, command: "dump", value: "x" }).success
        ).toBe(false);
    });

    it("shows a sensor's reading, only shown", () => {
        const reading = action("places.reading");
        expect(reading.kind).toBe("state");
        expect(reading.scope).toBe("home.read");
        expect(reading.read!.pick({ devices: [listing.devices.at(-1)] }, "en-US")).toEqual({
            tone: "ok",
            value: "21.5°C"
        });
    });
});

describe("what a press shows before Polaris answers", () => {
    const locked = { tone: "ok" as const, on: true, detail: "Locked" };
    const unlocked = { tone: "warn" as const, on: false, detail: "Unlocked" };

    it("says a door is locking, opening or unlocking", () => {
        expect(commandPress(unlocked, "lock", "en-US")).toEqual({
            face: { tone: "warn", on: true, icon: "lock", detail: "Locking" }
        });
        expect(commandPress(locked, "open", "es-ES")?.face?.detail).toBe("Abriendo");
        expect(commandPress(locked, "unlock", "en-US")?.face?.icon).toBe("lock-open");
    });

    it("skips a lock pressed to lock while locked, never an open", () => {
        expect(commandPress(locked, "lock", "en-US")).toEqual({ noop: true });
        expect(commandPress(unlocked, "unlock", "en-US")).toEqual({ noop: true });
        expect(commandPress(locked, "open", "en-US")?.noop).toBeUndefined();
    });

    it("flips a switch, and skips one already there", () => {
        expect(commandPress({ tone: "idle", on: false }, "turn-on", "en-US")).toEqual({
            face: { tone: "ok", on: true }
        });
        expect(commandPress({ tone: "ok", on: true }, "turn-on", "en-US")).toEqual({ noop: true });
    });

    it("never skips turning off a device whose state is not known", () => {
        const command = action("places.device-command");
        for (const state of ["unknown", "moving"]) {
            const shown = command.read!.pick(device(true, state), "en-US");
            expect(shown.on).toBeUndefined();
            expect(commandPress(shown, "turn-off", "en-US")?.noop).toBeUndefined();
        }
    });

    it("draws nothing ahead for an offline device or a command it cannot draw", () => {
        expect(commandPress({ tone: "bad", detail: "Offline" }, "lock", "en-US")).toBeUndefined();
        expect(commandPress({ tone: "ok", on: true }, "clean", "en-US")).toBeUndefined();
    });

    it("shows a new set point at once, and skips the one already set", () => {
        expect(targetPress({ tone: "ok", on: true, value: "22°" }, 23)).toEqual({
            face: { tone: "ok", on: true, value: "23°" }
        });
        expect(targetPress({ tone: "ok", on: true, value: "22°" }, 22)).toEqual({ noop: true });
    });

    it("reads the press from the device for its own key, and from the door's command", () => {
        const own = action("places.device");
        const light = {
            devices: [
                { kind: "light", state: "on", online: true, actions: ["turn-on", "turn-off"] }
            ]
        };
        const state = own.read!.pick(light, "en-US");
        expect(own.read!.press!(state, { deviceId: DEVICE }, light, "en-US")).toEqual({
            face: { tone: "idle", on: false, icon: "lightbulb" }
        });
        const door = action("places.door");
        expect(
            door.read!.press!(locked, { deviceId: DEVICE, command: "lock" }, {}, "en-US")
        ).toEqual({
            noop: true
        });
    });
});

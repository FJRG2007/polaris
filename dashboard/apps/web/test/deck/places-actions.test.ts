/**
 * Places on a deck: what a device key shows is in its reader's language.
 */

import { describe, expect, it } from "vitest";

const { placesDeckActions, clampTarget, naturalAction, naturalState } = await import(
    "@polaris-app/places/src/lib/deck-actions"
);

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

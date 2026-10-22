/**
 * Places on a Stream Deck: switch a device, open or lock a door, set an air
 * conditioner, run a routine, dim a light.
 *
 * Each one is bound to the Places MCP tool an assistant would call for it, so a
 * deck reaches exactly the devices and routines its owner does - a device that
 * was not lent to them, or a routine only the house's managers may start, is
 * refused by the tool exactly as it is on the screen. Nothing here reads or
 * writes a device itself.
 *
 * Server-only.
 */

import { z } from "zod";
import type { Locale } from "@polaris/core";
import type { AppHostTypes } from "@polaris/app-host";

type AppDeckAction = AppHostTypes["AppDeckAction"];

const OFFLINE: Readonly<Record<Locale, string>> = {
    "en-US": "Offline",
    "es-ES": "Sin conexión"
};

const deviceRows = z.object({
    devices: z.array(
        z
            .object({
                id: z.string(),
                name: z.string(),
                state: z.string().nullish(),
                online: z.boolean(),
                operable: z.boolean(),
                actions: z.array(z.string())
            })
            .passthrough()
    )
});

const routineRows = z.object({
    routines: z.array(z.object({ id: z.string(), name: z.string() }).passthrough())
});

/** The devices that take an action, for a picker. */
function devicesTaking(action: string) {
    return (structured: unknown) => {
        const parsed = deviceRows.safeParse(structured);
        if (!parsed.success) return [];
        return parsed.data.devices
            .filter((device) => device.actions.includes(action))
            .map((device) => ({ value: device.id, label: device.name }));
    };
}

/** One device's state as a key draws it. */
function deviceState(structured: unknown, locale: Locale) {
    const parsed = deviceRows.safeParse(structured);
    const device = parsed.success ? parsed.data.devices[0] : undefined;
    if (!device) return { tone: "idle" as const };
    if (!device.online) return { tone: "bad" as const, detail: OFFLINE[locale] };
    const on = device.state === "on";
    return { tone: on ? ("ok" as const) : ("idle" as const), on };
}

/** What a lock's bolt is, in the reader's language. */
const BOLT: Readonly<Record<"locked" | "unlocked", Readonly<Record<Locale, string>>>> = {
    locked: { "en-US": "Locked", "es-ES": "Cerrada" },
    unlocked: { "en-US": "Unlocked", "es-ES": "Abierta" }
};

/** A lock's state as a key draws it: the bolt, never whether the door is open,
 *  which only a door sensor knows. */
export function lockState(structured: unknown, locale: Locale) {
    const parsed = deviceRows.safeParse(structured);
    const device = parsed.success ? parsed.data.devices[0] : undefined;
    if (!device) return { tone: "idle" as const };
    if (!device.online) return { tone: "bad" as const, detail: OFFLINE[locale] };
    if (device.state === "locked")
        return { tone: "ok" as const, on: true, detail: BOLT.locked[locale] };
    if (device.state === "unlocked")
        return { tone: "warn" as const, on: false, detail: BOLT.unlocked[locale] };
    return { tone: "idle" as const };
}

const climateRows = z.object({
    devices: z.array(
        z
            .object({
                state: z.string().nullish(),
                online: z.boolean(),
                climate: z
                    .object({
                        target: z.number().nullable(),
                        min: z.number(),
                        max: z.number(),
                        step: z.number().positive()
                    })
                    .passthrough()
                    .nullish()
            })
            .passthrough()
    )
});

function climateOf(structured: unknown) {
    const parsed = climateRows.safeParse(structured);
    return parsed.success ? parsed.data.devices[0] : undefined;
}

/** An air conditioner as a key draws it: on or off, and the temperature it is
 *  set to. */
export function climateState(structured: unknown, locale: Locale) {
    const device = climateOf(structured);
    if (!device) return { tone: "idle" as const };
    if (!device.online) return { tone: "bad" as const, detail: OFFLINE[locale] };
    const on = device.state === "on";
    const target = device.climate?.target;
    return {
        tone: on ? ("ok" as const) : ("idle" as const),
        on,
        ...(typeof target === "number" ? { value: `${target}°` } : {})
    };
}

/** A temperature held inside the device's own range, on its own step. */
export function clampTarget(
    value: number,
    climate: { min: number; max: number; step: number } | null | undefined
): number {
    if (!climate) return value;
    const stepped = Math.round(value / climate.step) * climate.step;
    return Number(Math.min(climate.max, Math.max(climate.min, stepped)).toFixed(1));
}

/** The plain commands a device takes with nothing more to say. `dump` - all
 *  the litter out of a litter box - is not one: it is the device's own button
 *  or an assistant's, not something to be bumped on a deck. */
const PLAIN_COMMANDS = [
    "turn-on",
    "turn-off",
    "open",
    "unlock",
    "lock",
    "stop",
    "clean",
    "pause",
    "resume"
] as const;

const COMMAND_WORDS: Readonly<
    Record<(typeof PLAIN_COMMANDS)[number], Readonly<Record<Locale, string>>>
> = {
    "turn-on": { "en-US": "Turn on", "es-ES": "Encender" },
    "turn-off": { "en-US": "Turn off", "es-ES": "Apagar" },
    open: { "en-US": "Open", "es-ES": "Abrir" },
    unlock: { "en-US": "Unlock", "es-ES": "Desbloquear" },
    lock: { "en-US": "Lock", "es-ES": "Bloquear" },
    stop: { "en-US": "Stop", "es-ES": "Parar" },
    clean: { "en-US": "Clean now", "es-ES": "Limpiar ya" },
    pause: { "en-US": "Pause", "es-ES": "Pausar" },
    resume: { "en-US": "Resume", "es-ES": "Reanudar" }
};

const DOOR_COMMANDS = ["open", "unlock", "lock"] as const;

const commandField = (commands: readonly (typeof PLAIN_COMMANDS)[number][]) => ({
    name: "command",
    type: "choice" as const,
    label: { "en-US": "Command", "es-ES": "Orden" },
    required: true,
    fixed: commands.map((value) => ({ value, label: COMMAND_WORDS[value] }))
});

/** Any device that takes a command at all. */
function operableDevices(structured: unknown) {
    const parsed = deviceRows.safeParse(structured);
    if (!parsed.success) return [];
    return parsed.data.devices
        .filter((device) => device.actions.length > 0)
        .map((device) => ({ value: device.id, label: device.name }));
}

const deviceField = (action: string) => ({
    name: "deviceId",
    type: "choice" as const,
    label: { "en-US": "Device", "es-ES": "Dispositivo" },
    required: true,
    choices: { tool: "places_devices", input: {}, pick: devicesTaking(action) }
});

const readDevice = {
    tool: "places_devices",
    input: (options: Record<string, unknown>) => ({ deviceId: options.deviceId })
};

const naturalRows = z.object({
    devices: z.array(
        z
            .object({
                kind: z.string().nullish(),
                state: z.string().nullish(),
                online: z.boolean(),
                actions: z.array(z.string()),
                climate: z.object({ target: z.number().nullable() }).passthrough().nullish()
            })
            .passthrough()
    )
});

/** The icon a device kind is drawn with on a key. */
const KIND_ICONS: Readonly<Record<string, string>> = {
    light: "lightbulb",
    switch: "zap",
    outlet: "plug",
    climate: "snowflake",
    air: "fan",
    lock: "lock",
    opener: "door-open",
    appliance: "power"
};

/**
 * What pressing a device's own key does: what its owner would mean by it. On
 * and off flips; a door opens - the Open button, which unlocks and pulls the
 * latch; a lock with no latch to pull locks or unlocks. Null for a device that
 * takes none of those, which a key has nothing natural to do with.
 */
export function naturalAction(device: {
    readonly state?: string | null;
    readonly actions: readonly string[];
}): string | null {
    const takes = (action: string) => device.actions.includes(action);
    if (takes("turn-on") && takes("turn-off")) return device.state === "on" ? "turn-off" : "turn-on";
    if (takes("open")) return "open";
    if (takes("lock") && takes("unlock")) return device.state === "locked" ? "unlock" : "lock";
    return null;
}

/** A device on its own key: its kind's icon, on or off, the bolt of a lock and
 *  the temperature an air conditioner is set to. */
export function naturalState(structured: unknown, locale: Locale) {
    const parsed = naturalRows.safeParse(structured);
    const device = parsed.success ? parsed.data.devices[0] : undefined;
    if (!device) return { tone: "idle" as const };
    const icon = KIND_ICONS[device.kind ?? ""] ?? "power";
    if (!device.online) return { tone: "bad" as const, icon, detail: OFFLINE[locale] };
    if (device.state === "locked" || device.state === "unlocked") {
        const locked = device.state === "locked";
        return {
            tone: locked ? ("ok" as const) : ("warn" as const),
            on: locked,
            icon: locked ? "lock" : "lock-open",
            detail: BOLT[device.state][locale]
        };
    }
    const on = device.state === "on";
    const target = device.climate?.target;
    return {
        tone: on ? ("ok" as const) : ("idle" as const),
        on,
        icon,
        ...(on && typeof target === "number" ? { value: `${target}°` } : {})
    };
}

export function placesDeckActions(): readonly AppDeckAction[] {
    return [
        {
            id: "places.device",
            kind: "toggle",
            area: "places",
            icon: "house",
            label: { "en-US": "A device, its own key", "es-ES": "Un aparato, su tecla" },
            scope: "home.control",
            options: z.object({ deviceId: z.string().uuid() }),
            fields: [
                {
                    name: "deviceId",
                    type: "choice",
                    label: { "en-US": "Device", "es-ES": "Dispositivo" },
                    required: true,
                    choices: { tool: "places_devices", input: {}, pick: operableDevices }
                }
            ],
            // What it does is read from the device on every press, so a light
            // turns off when it is on and a door opens, whatever the key last
            // showed. The tool checks the person may work it, as the panel does.
            run: {
                tool: "places_device_control",
                input: (options, press) => {
                    const parsed = naturalRows.safeParse(press.read);
                    const device = parsed.success ? parsed.data.devices[0] : undefined;
                    const action = device ? naturalAction(device) : null;
                    return action ? { deviceId: options.deviceId, action } : null;
                }
            },
            read: { ...readDevice, pick: naturalState }
        },
        {
            id: "places.door",
            kind: "run",
            area: "places",
            icon: "door-open",
            label: { "en-US": "Open or lock a door", "es-ES": "Abrir o cerrar puerta" },
            scope: "home.control",
            options: z.object({
                deviceId: z.string().uuid(),
                command: z.enum(DOOR_COMMANDS).default("open")
            }),
            // The doors this person may work: the tool checks it again, as the
            // device panel does, on every press.
            fields: [deviceField("lock"), commandField(DOOR_COMMANDS)],
            run: {
                tool: "places_device_control",
                input: (options) => ({ deviceId: options.deviceId, action: options.command })
            },
            read: { ...readDevice, pick: lockState }
        },
        {
            id: "places.device-command",
            kind: "run",
            area: "places",
            icon: "power",
            label: { "en-US": "Send a device command", "es-ES": "Dar orden a un aparato" },
            scope: "home.control",
            options: z.object({
                deviceId: z.string().uuid(),
                command: z.enum(PLAIN_COMMANDS)
            }),
            fields: [
                {
                    name: "deviceId",
                    type: "choice",
                    label: { "en-US": "Device", "es-ES": "Dispositivo" },
                    required: true,
                    choices: { tool: "places_devices", input: {}, pick: operableDevices }
                },
                commandField(PLAIN_COMMANDS)
            ],
            run: {
                tool: "places_device_control",
                input: (options) => ({ deviceId: options.deviceId, action: options.command })
            },
            read: { ...readDevice, pick: deviceState }
        },
        {
            id: "places.temperature-step",
            kind: "run",
            area: "places",
            icon: "thermometer",
            label: { "en-US": "Temperature up or down", "es-ES": "Subir o bajar grados" },
            scope: "home.control",
            options: z.object({
                deviceId: z.string().uuid(),
                change: z.number().min(-10).max(10).default(1)
            }),
            fields: [
                deviceField("set-temperature"),
                {
                    name: "change",
                    type: "number",
                    label: { "en-US": "Degrees (+/-)", "es-ES": "Grados (+/-)" },
                    required: true,
                    min: -10,
                    max: 10
                }
            ],
            // From the temperature it is set to now, which the press reads
            // first; one that has never reported one has nothing to move from.
            run: {
                tool: "places_device_control",
                input: (options, press) => {
                    const climate = climateOf(press.read)?.climate;
                    if (typeof climate?.target !== "number") return null;
                    return {
                        deviceId: options.deviceId,
                        action: "set-temperature",
                        target: clampTarget(climate.target + Number(options.change), climate)
                    };
                }
            },
            read: { ...readDevice, pick: climateState }
        },
        {
            id: "places.temperature-set",
            kind: "run",
            area: "places",
            icon: "thermometer",
            label: { "en-US": "Set a temperature", "es-ES": "Fijar temperatura" },
            scope: "home.control",
            options: z.object({
                deviceId: z.string().uuid(),
                target: z.number().min(-50).max(150)
            }),
            fields: [
                deviceField("set-temperature"),
                {
                    name: "target",
                    type: "number",
                    label: { "en-US": "Temperature", "es-ES": "Temperatura" },
                    required: true,
                    min: -50,
                    max: 150
                }
            ],
            run: {
                tool: "places_device_control",
                input: (options, press) => ({
                    deviceId: options.deviceId,
                    action: "set-temperature",
                    target: clampTarget(Number(options.target), climateOf(press.read)?.climate)
                })
            },
            read: { ...readDevice, pick: climateState }
        },
        {
            id: "places.climate",
            kind: "dial",
            area: "places",
            icon: "thermometer",
            label: { "en-US": "Air conditioner", "es-ES": "Aire acondicionado" },
            scope: "home.control",
            // Turned, the temperature, half a degree a tick; pushed, on or off.
            dial: { min: 16, max: 30, step: 0.5 },
            options: z.object({
                deviceId: z.string().uuid(),
                level: z.number().min(-50).max(150).default(22)
            }),
            fields: [deviceField("set-temperature")],
            run: {
                tool: "places_device_control",
                input: (options, press) =>
                    press.push
                        ? {
                              deviceId: options.deviceId,
                              action: press.current?.on ? "turn-off" : "turn-on"
                          }
                        : {
                              deviceId: options.deviceId,
                              action: "set-temperature",
                              target: clampTarget(
                                  Number(options.level),
                                  climateOf(press.read)?.climate
                              )
                          }
            },
            read: { ...readDevice, pick: climateState }
        },
        {
            id: "places.device-toggle",
            kind: "toggle",
            area: "places",
            icon: "lightbulb",
            label: { "en-US": "Switch a device", "es-ES": "Encender o apagar" },
            scope: "home.control",
            options: z.object({ deviceId: z.string().uuid() }),
            fields: [deviceField("turn-on")],
            run: {
                tool: "places_device_control",
                input: (options, press) => ({
                    deviceId: options.deviceId,
                    action: press.current?.on ? "turn-off" : "turn-on"
                })
            },
            read: {
                tool: "places_devices",
                input: (options) => ({ deviceId: options.deviceId }),
                pick: deviceState
            }
        },
        {
            id: "places.brightness",
            kind: "dial",
            area: "places",
            icon: "sun",
            label: { "en-US": "Light brightness", "es-ES": "Brillo de una luz" },
            scope: "home.control",
            // The level is the dial's own: the plugin turns it and sends where
            // it landed, so a burst of ticks is one command, not twenty.
            options: z.object({
                deviceId: z.string().uuid(),
                level: z.number().int().min(1).max(100).default(50)
            }),
            fields: [deviceField("set-brightness")],
            run: {
                tool: "places_device_control",
                input: (options) => ({
                    deviceId: options.deviceId,
                    action: "set-brightness",
                    level: options.level
                })
            },
            read: {
                tool: "places_devices",
                input: (options) => ({ deviceId: options.deviceId }),
                pick: deviceState
            }
        },
        {
            id: "places.routine-run",
            kind: "run",
            area: "places",
            icon: "play",
            label: { "en-US": "Run a routine", "es-ES": "Ejecutar una rutina" },
            scope: "home.manage",
            options: z.object({ routineId: z.string().uuid() }),
            fields: [
                {
                    name: "routineId",
                    type: "choice",
                    label: { "en-US": "Routine", "es-ES": "Rutina" },
                    required: true,
                    choices: {
                        tool: "places_routines",
                        input: {},
                        pick: (structured) => {
                            const parsed = routineRows.safeParse(structured);
                            return parsed.success
                                ? parsed.data.routines.map((row) => ({
                                      value: row.id,
                                      label: row.name
                                  }))
                                : [];
                        }
                    }
                }
            ],
            run: {
                tool: "places_routine_run",
                input: (options) => ({ routineId: options.routineId })
            }
        }
    ];
}

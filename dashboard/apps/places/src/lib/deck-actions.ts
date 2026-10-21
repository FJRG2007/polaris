/**
 * Places on a Stream Deck: switch a device, run a routine, dim a light.
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
import type { AppHostTypes } from "@polaris/app-host";

type AppDeckAction = AppHostTypes["AppDeckAction"];

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
function deviceState(structured: unknown) {
    const parsed = deviceRows.safeParse(structured);
    const device = parsed.success ? parsed.data.devices[0] : undefined;
    if (!device) return { tone: "idle" as const };
    if (!device.online) return { tone: "bad" as const, detail: "offline" };
    const on = device.state === "on";
    return { tone: on ? ("ok" as const) : ("idle" as const), on };
}

const deviceField = (action: string) => ({
    name: "deviceId",
    type: "choice" as const,
    label: { "en-US": "Device", "es-ES": "Dispositivo" },
    required: true,
    choices: { tool: "places_devices", input: {}, pick: devicesTaking(action) }
});

export function placesDeckActions(): readonly AppDeckAction[] {
    return [
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

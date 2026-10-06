/**
 * Places, as tools a connected assistant can call.
 *
 * Offered through the `mcpTools` hook, so they exist only while Places is
 * installed. They act as the person the call is for, through the same checks
 * the Places screens use: `placesReach` and `onlyReachable` for what they may
 * see, `operateDevice` - the device panel's own path - to switch, lock or set
 * something, with its count of a lent grant and its audit line, and the
 * automation engine's own manual run. A device somebody was not lent, or a
 * routine only the house's managers may start, is out of an assistant's reach
 * exactly as it is out of theirs.
 *
 * Three scopes, by risk: seeing devices (`places.read`), operating them
 * (`places.control`), and listing and running routines (`places.routines`,
 * which needs what the routines screen needs: managing the house).
 *
 * Deliberately not offered: cameras, footage and the people Places knows.
 *
 * Server-only.
 */

import { z } from "zod";
import * as places from "./places";
import * as devices from "./devices";
import { homeInstall } from "./access";
import { randomUUID } from "node:crypto";
import { host } from "@polaris/app-host";
import { HomeError } from "./home-error";
import * as automations from "./automations";
import { operateDevice } from "./device-operation";
import type { AppHostTypes } from "@polaris/app-host";
import { onlyReachable, placesReach } from "./sharing";
import { matchForModel, type SearchField } from "@polaris/core";
import {
    DEVICE_ACTIONS,
    DEVICE_KIND_LABELS,
    deviceKind,
    actionsFor,
    deviceCommandSchema,
    needsCommand,
    type DeviceView
} from "./device-kinds";

type McpTool = AppHostTypes["McpTool"];
type McpCaller = AppHostTypes["McpCaller"];

/** A refusal the model reads as written. A class from the host, so it is
 *  only reached for once a call is running. */
function refuse(message: string): never {
    throw new host.mcp.McpRefusal(message);
}

/** Run Places' own work, turning its refusals - one sentence for the person,
 *  naming nothing internal - into ones the model reads. */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof HomeError) refuse(caught.message);
        throw caught;
    }
}

/** The person a call acts for, and the install their places are in. */
async function contextFor(caller: McpCaller) {
    const [user, install] = await Promise.all([host.mcp.actingUser(caller.userId), homeInstall()]);
    if (!user) refuse("This account cannot use Places.");
    if (!install) refuse("Places is not set up on this Polaris yet.");
    return { user, install };
}

/** A device as a model reads it: what it is, where, and what it is doing. */
function deviceRow(device: DeviceView, placeNames: ReadonlyMap<string, string>) {
    return {
        id: device.id,
        name: device.name,
        kind: device.kind,
        place: device.placeId ? (placeNames.get(device.placeId) ?? null) : null,
        zone: device.zone,
        state: device.state,
        door: device.doorState === "none" ? null : device.doorState,
        online: device.online,
        operable: device.controllable && device.online,
        actions: device.controllable ? actionsFor(device.kind) : [],
        battery: device.batteryPercent,
        reading: device.reading,
        climate: device.climate ?? null,
        air: device.air ?? null,
        stateAt: device.stateAt
    };
}

function deviceLine(row: ReturnType<typeof deviceRow>): string {
    const where = [row.place, row.zone].filter(Boolean).join(" / ");
    const reading = row.reading ? ` ${row.reading.value}${row.reading.unit}` : "";
    return `${row.id}  ${row.name} (${row.kind}${where ? `, ${where}` : ""}): ${row.online ? row.state : "offline"}${reading}`;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

const devicesInput = z.object({
    deviceId: z
        .string()
        .uuid()
        .optional()
        .describe("One device, as this tool returned it. Absent lists them all."),
    query: z
        .string()
        .trim()
        .max(100)
        .default("")
        .describe(
            'Words for the device: its name, what it is or where ("door", "luz del salon"), in any language. The best matches come first; when nothing matches, every device is listed.'
        )
});

/** Where a device search reads: the name first, then what it is, then where. */
const DEVICE_FIELDS: readonly SearchField<ReturnType<typeof deviceRow>>[] = [
    { text: (row) => row.name, weight: 1 },
    { text: (row) => [row.kind, DEVICE_KIND_LABELS[deviceKind(row.kind)]], weight: 0.9 },
    { text: (row) => row.zone, weight: 0.7 },
    { text: (row) => row.place, weight: 0.6 }
];

/** The most rows one answer carries. */
const DEVICE_LIMIT = 100;

const devicesTool = () =>
    host.mcp.defineTool({
        name: "places_devices",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Devices and their state",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The devices in this account's places - locks, lights, switches, air conditioners, sensors - with their last known state and the actions each accepts. Read-only.",
        input: devicesInput,
        category: "home",
        scope: "places.read",
        readOnly: true,
        async run(input, caller) {
            const { user, install } = await contextFor(caller);
            const reach = await placesReach(user);
            const [list, placeList] = await Promise.all([
                input.deviceId
                    ? attempt(async () => [await devices.getDevice(install.id, input.deviceId!)])
                    : devices.listDevices(install.id),
                places.listPlaces(install.id)
            ]);
            const names = new Map(placeList.map((place) => [place.id, place.name]));
            const visible = onlyReachable(list, reach.everything || reach.devices).map((device) =>
                deviceRow(device, names)
            );
            if (input.deviceId && visible.length === 0)
                refuse("That device is not shared with you");
            if (visible.length === 0) {
                return { text: "No devices.", structured: { devices: [] } };
            }
            // Never "No devices." for a query: a model told that gives up on a
            // door it was asked to open. The closest, or all, said as such.
            const found = matchForModel(
                visible,
                input.query,
                DEVICE_FIELDS,
                { one: "device", other: "devices" },
                DEVICE_LIMIT
            );
            const lines = found.items.map(deviceLine).join("\n");
            return {
                text: found.note ? `${found.note}\n${lines}` : lines,
                structured: { devices: found.items, matched: found.matched }
            };
        }
    });

const controlInput = z.object({
    deviceId: z.string().uuid().describe("The device, as places_devices returned it."),
    action: z
        .enum(DEVICE_ACTIONS)
        .describe("What to do. places_devices lists the actions each device accepts."),
    mode: z.string().trim().max(40).optional().describe("For set-mode: the mode."),
    fan: z.string().trim().max(40).optional().describe("For set-fan: the fan speed."),
    target: z
        .number()
        .finite()
        .min(-50)
        .max(150)
        .optional()
        .describe("For set-temperature and set-humidity: the value to reach."),
    option: z.string().trim().max(40).optional().describe("For set-option: which option."),
    on: z.boolean().optional().describe("For set-option: on or off.")
});

const controlTool = () =>
    host.mcp.defineTool({
        name: "places_device_control",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Operate a device",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Lock or unlock a door, switch something on or off, or set an air conditioner or purifier. Acts in the real world at once: confirm with the person before opening a door.",
        input: controlInput,
        category: "home",
        scope: "places.control",
        readOnly: false,
        async run(input, caller) {
            const { user, install } = await contextFor(caller);
            // The setting, in the shape the device's own kind takes: the panel sends
            // one per kind, and the two kinds call the fan speed by different names.
            let setting: z.infer<typeof deviceCommandSchema> | undefined;
            if (needsCommand(input.action)) {
                const target = await attempt(() => devices.getDevice(install.id, input.deviceId));
                const fan = target.kind === "air" ? { speed: input.fan } : { fan: input.fan };
                const parsed = deviceCommandSchema.safeParse({
                    action: input.action,
                    ...(input.action === "set-mode" ? { mode: input.mode } : {}),
                    ...(input.action === "set-fan" ? fan : {}),
                    ...(input.action === "set-temperature" || input.action === "set-humidity"
                        ? { target: input.target }
                        : {}),
                    ...(input.action === "set-option" ? { option: input.option, on: input.on } : {})
                });
                if (!parsed.success)
                    refuse(
                        `Say what to set it to: ${input.action} needs a value this device accepts.`
                    );
                setting = parsed.data;
            }
            const device = await attempt(() =>
                operateDevice(user, install.id, input.deviceId, input.action, setting)
            );
            return {
                text: `${device.name}: ${device.state}.`,
                structured: { device: deviceRow(device, new Map()) }
            };
        }
    });

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

/** Routines are the house's managers' to start, on the screen and here. */
async function managerContext(caller: McpCaller) {
    const context = await contextFor(caller);
    if (!(await host.session.sessionCan(context.user, "home.manage")))
        refuse("Only somebody who manages the house can run its routines.");
    return context;
}

const routinesTool = () =>
    host.mcp.defineTool({
        name: "places_routines",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "List routines",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The routines (automations) set up in this account's places, whether each is switched on, and how its last run went. Read-only; places_routine_run starts one.",
        input: z.object({}),
        category: "home",
        scope: "places.routines",
        readOnly: true,
        async run(_input, caller) {
            const { install } = await managerContext(caller);
            const placeList = await places.listPlaces(install.id);
            const lists = await Promise.all(
                placeList.map(async (place) =>
                    (await automations.listAutomations(install.id, place.id)).map((routine) => ({
                        id: routine.id,
                        name: routine.name,
                        place: place.name,
                        enabled: routine.enabled,
                        lastRunAt: routine.lastRunAt,
                        lastStatus: routine.lastStatus
                    }))
                )
            );
            const rows = lists.flat();
            if (rows.length === 0) return { text: "No routines.", structured: { routines: [] } };
            return {
                text: rows
                    .map(
                        (row) =>
                            `${row.id}  ${row.name} (${row.place})${row.enabled ? "" : " - switched off"}${row.lastStatus ? `, last ${row.lastStatus}` : ""}`
                    )
                    .join("\n"),
                structured: { routines: rows }
            };
        }
    });

const runInput = z.object({
    routineId: z.string().uuid().describe("The routine, as places_routines returned it.")
});

const runTool = () =>
    host.mcp.defineTool({
        name: "places_routine_run",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Run a routine",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Start a routine now, as its Run button does. Its steps act on real devices; its own conditions still apply, and a switched-off routine does not run.",
        input: runInput,
        category: "home",
        scope: "places.routines",
        readOnly: false,
        destructive: false,
        async run(input, caller) {
            const { user, install } = await managerContext(caller);
            await attempt(() =>
                automations.runAutomationNow(install.id, input.routineId, user.name, randomUUID())
            );
            await host.auditService.recordAudit({
                actorId: user.id,
                action: "places.automation.run",
                targetType: "placeAutomation",
                targetId: input.routineId
            });
            return {
                text: "Started. Its run log in Places shows each step.",
                structured: { routineId: input.routineId }
            };
        }
    });

/** Built when the app is first asked for its tools, not when this module
 *  loads: `defineTool` is the host's, and a module of this app can be loaded
 *  before the dashboard has provided it (test/home/cold-start). */
let built: readonly McpTool[] | undefined;

export function placesMcpTools(): readonly McpTool[] {
    built ??= [devicesTool, controlTool, routinesTool, runTool].map((tool) => tool());
    return built;
}

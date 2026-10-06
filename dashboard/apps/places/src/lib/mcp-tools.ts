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
 * Four scopes, by risk: seeing devices (`places.read`), operating them
 * (`places.control`), listing and running routines (`places.routines`, which
 * needs what the routines screen needs: managing the house), and a still from a
 * camera (`places.cameras`, its own grant because a camera's picture is the
 * inside of somebody's home). A camera is watched through the snapshot route's
 * own check (`requireCameraView`) and its own relay call (`cameraStill`).
 *
 * Deliberately not offered: live video, recorded footage, and the people
 * Places knows.
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
import { onlyReachable, placesReach, requireCameraView } from "./sharing";
import { matchForModel, type SearchField } from "@polaris/core";
import {
    DEVICE_ACTIONS,
    DEVICE_KIND_LABELS,
    deviceKind,
    actionsFor,
    deviceCommandSchema,
    needsCommand,
    type DeviceAction,
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

/** Kinds whose state is a bolt: locked or not says nothing about whether the
 *  door is open, which only a door sensor knows. */
const BOLTS = new Set(["lock", "opener"]);

/** How long ago something was read, in a few words. */
export function readAgo(stateAt: string | null, now: number): string {
    if (!stateAt) return "never read";
    const seconds = Math.max(0, Math.round((now - Date.parse(stateAt)) / 1000));
    if (seconds < 90) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** A device as a model reads it: what it is, where, and what it is doing. */
function deviceRow(
    device: DeviceView,
    placeNames: ReadonlyMap<string, string>,
    now: number = Date.now()
) {
    const bolt = BOLTS.has(device.kind);
    return {
        id: device.id,
        name: device.name,
        kind: device.kind,
        place: device.placeId ? (placeNames.get(device.placeId) ?? null) : null,
        zone: device.zone,
        state: device.state,
        door: device.doorState === "none" ? null : device.doorState,
        /** The bolt, for a lock: never whether the door is open. */
        lock: bolt ? device.state : null,
        /** The door's own sensor, for a lock: "none" when it has no sensor. */
        doorSensor: bolt ? device.doorState : null,
        online: device.online,
        operable: device.controllable && device.online,
        actions: device.controllable ? actionsFor(device.kind).map(spokenAction) : [],
        battery: device.batteryPercent,
        reading: device.reading,
        climate: device.climate ?? null,
        air: device.air ?? null,
        stateAt: device.stateAt,
        ageSeconds: device.stateAt
            ? Math.max(0, Math.round((now - Date.parse(device.stateAt)) / 1000))
            : null
    };
}

/** What a device is doing, said so that a lock's bolt and its door cannot be
 *  read as one another. */
function statusOf(row: ReturnType<typeof deviceRow>): string {
    if (!row.online) return "offline";
    if (row.lock === null) return `state: ${row.state}`;
    const door =
        row.doorSensor === "none" || row.doorSensor === null
            ? "door sensor: none"
            : `door: ${row.doorSensor}`;
    return `lock: ${row.lock}, ${door}`;
}

function deviceLine(row: ReturnType<typeof deviceRow>, now: number = Date.now()): string {
    const where = [row.place, row.zone].filter(Boolean).join(" / ");
    const reading = row.reading ? ` ${row.reading.value}${row.reading.unit}` : "";
    return `${row.id}  ${row.name} (${row.kind}${where ? `, ${where}` : ""}): ${statusOf(row)}${reading} (as of ${readAgo(row.stateAt, now)})`;
}

/** How long a read of the accounts is waited for before answering with what
 *  was last read. */
const FRESH_WAIT_MS = 4000;

/** How long a command is waited for to be confirmed by a read of the device. */
const CONFIRM_WAIT_MS = 8000;

/**
 * Read again, now, the accounts of devices whose last reading is older than
 * their account's turn - or that are still moving - within `FRESH_WAIT_MS`.
 * The same quiet read the background makes, shared with it; never a probe.
 * Answers whether everything asked for was read; false is the reader's cue to
 * say how old what it shows is.
 */
async function freshen(installedAppId: string, list: readonly DeviceView[]): Promise<boolean> {
    // A device connected to nothing has no account to read again.
    if (!list.some((device) => device.accountId)) return true;
    try {
        const [watch, accounts] = await Promise.all([
            import("./device-watch"),
            import("./device-accounts")
        ]);
        const connections = new Map(
            (await accounts.listAccounts(installedAppId)).map((account) => [
                account.id,
                account.connection
            ])
        );
        const now = Date.now();
        const stale = new Set<string>();
        for (const device of list) {
            const connection = device.accountId ? connections.get(device.accountId) : undefined;
            if (!device.accountId || !connection || !accounts.isConnectable(connection)) continue;
            const at = device.stateAt ? Date.parse(device.stateAt) : 0;
            if (
                device.state === "moving" ||
                now - at > watch.currentInterval(installedAppId, connection)
            )
                stale.add(device.accountId);
        }
        if (stale.size === 0) return true;
        return (await watch.refreshAccounts(installedAppId, [...stale], FRESH_WAIT_MS)) === "read";
    } catch (caught) {
        console.error("places: devices could not be read again for an assistant:", caught);
        return false;
    }
}

/**
 * The device as its account reports it after a command, or null when no read
 * after the command found it settled within `CONFIRM_WAIT_MS`. The command
 * itself already asked for the follow-up reads (`requestFollowUps`); this only
 * waits for them.
 */
async function confirmed(
    installedAppId: string,
    device: DeviceView,
    actedAt: number
): Promise<DeviceView | null> {
    if (!device.accountId) return null;
    const watch = await import("./device-watch");
    const deadline = actedAt + CONFIRM_WAIT_MS;
    let after = actedAt;
    while (Date.now() < deadline) {
        const read = await watch.waitForRead(device.accountId, after, deadline - Date.now());
        if (!read) return null;
        after = Date.now();
        const now = await devices.getDevice(installedAppId, device.id).catch(() => null);
        if (now && now.state !== "moving") return now;
    }
    return null;
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
            "The devices in this account's places - locks, lights, switches, air conditioners, sensors - with their state, how long ago it was read, and the actions each accepts. A lock's state is its bolt (locked or unlocked), never whether the door is open: only a door sensor says that, and \"door sensor: none\" means there is none. Reads an account again first when its devices are older than its usual turn. Read-only.",
        input: devicesInput,
        category: "home",
        scope: "places.read",
        readOnly: true,
        async run(input, caller) {
            const { user, install } = await contextFor(caller);
            const reach = await placesReach(user);
            const read = () =>
                input.deviceId
                    ? attempt(async () => [await devices.getDevice(install.id, input.deviceId!)])
                    : devices.listDevices(install.id);
            const [first, placeList] = await Promise.all([read(), places.listPlaces(install.id)]);
            let list = onlyReachable(first, reach.everything || reach.devices);
            // Only for somebody who reaches the house, as the devices screen
            // only reads the accounts for them: a visitor is told what is known.
            let fresh = true;
            if (reach.everything && list.length > 0) {
                fresh = await freshen(install.id, list);
                if (fresh) list = onlyReachable(await read(), true);
            }
            const now = Date.now();
            const names = new Map(placeList.map((place) => [place.id, place.name]));
            const visible = list.map((device) => deviceRow(device, names, now));
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
            const lines = found.items.map((row) => deviceLine(row, now)).join("\n");
            const stale = fresh
                ? ""
                : "\n(Could not read them again just now: each shows its last reading, as of the time given.)";
            return {
                text: `${found.note ? `${found.note}\n` : ""}${lines}${stale}`,
                structured: { devices: found.items, matched: found.matched, fresh }
            };
        }
    });

/**
 * Every device action as a model is offered it: the word on the device panel's
 * button, and what it does in the world.
 *
 * Inside Places the panel's Open button is `unlatch`, a word nobody says.
 * Offered under it, a model asked to open a door unlocked it instead - twice -
 * which leaves the door shut. So the name here is the button's, and the hint
 * says what tells it from its neighbours. A `Record` over every action, so one
 * added to Places without a name and a hint here does not compile. The
 * internal name is still accepted, for a client that learned it.
 */
const ACTION_WORDS: Readonly<Record<DeviceAction, { name: string; hint: string }>> = {
    lock: { name: "lock", hint: "locks a door" },
    unlock: { name: "unlock", hint: "only unlocks a door; it stays shut" },
    unlatch: {
        name: "open",
        hint: 'unlocks AND pulls the latch so the door opens - what "open the door" means'
    },
    "turn-on": { name: "turn-on", hint: "switches it on" },
    "turn-off": { name: "turn-off", hint: "switches it off" },
    "set-mode": { name: "set-mode", hint: "with mode" },
    "set-temperature": { name: "set-temperature", hint: "with target" },
    "set-fan": { name: "set-fan", hint: "with fan" },
    "set-option": { name: "set-option", hint: "with option and on" },
    "set-humidity": { name: "set-humidity", hint: "with target" },
    stop: { name: "stop", hint: "stops a moving device" }
};

const BY_WORD = new Map<string, DeviceAction>(
    DEVICE_ACTIONS.flatMap((action) => [
        [ACTION_WORDS[action].name, action],
        [action, action]
    ])
);

const SPOKEN_ACTIONS = [...BY_WORD.keys()] as [string, ...string[]];

function spokenAction(action: DeviceAction): string {
    return ACTION_WORDS[action].name;
}

function deviceAction(word: string): DeviceAction {
    return BY_WORD.get(word)!;
}

const controlInput = z.object({
    deviceId: z.string().uuid().describe("The device, as places_devices returned it."),
    action: z
        .enum(SPOKEN_ACTIONS)
        .transform(deviceAction)
        .describe(
            `What to do; places_devices lists the actions each device accepts. ${DEVICE_ACTIONS.map(
                (action) => `${ACTION_WORDS[action].name}: ${ACTION_WORDS[action].hint}`
            ).join("; ")}.`
        ),
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
            "Open, unlock or lock a door, switch something on or off, or set an air conditioner or purifier. To open a door use action open, not unlock: unlock leaves it shut. Acts in the real world at once: confirm with the person before opening or unlocking a door. Answers with the state the device reports a few seconds later, or says the command was sent and not yet confirmed.",
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
            const actedAt = Date.now();
            const device = await attempt(() =>
                operateDevice(user, install.id, input.deviceId, input.action, setting)
            );
            // What the device reports once it has done it, when its account says
            // so within a few seconds; otherwise the command was sent and that is
            // all that is known.
            const settled = await confirmed(install.id, device, actedAt).catch(() => null);
            const row = deviceRow(settled ?? device, new Map());
            return {
                text: settled
                    ? `${device.name}: ${statusOf(row)} - confirmed by the device.`
                    : `${device.name}: sent, not yet confirmed (last known ${statusOf(row)}).`,
                structured: { device: row, confirmed: settled !== null }
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

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

/** The width asked of the relay unless the model asks for another. Enough to
 *  tell who is at a door; a fraction of what a camera's own frame weighs. */
const SNAPSHOT_WIDTH = 640;

/** The width asked for when the first picture came back over the cap. */
const SNAPSHOT_SMALLEST = 320;

/** The most one picture may weigh. It goes into a model's context as base64,
 *  where every kilobyte is read. */
const SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** How long the relay is given, both streams together, before the call gives
 *  up. A sleeping camera takes a moment; a model should not wait on one for
 *  ever. */
const SNAPSHOT_TIMEOUT_MS = 12_000;

const snapshotInput = z.object({
    cameraId: z
        .string()
        .uuid()
        .optional()
        .describe(
            "The camera, as this tool listed it. Absent lists the cameras this account can watch, with no picture."
        ),
    width: z
        .number()
        .int()
        .min(SNAPSHOT_SMALLEST)
        .max(1280)
        .default(SNAPSHOT_WIDTH)
        .describe("How wide the picture is, in pixels. Smaller is cheaper to read.")
});

const snapshotTool = () =>
    host.mcp.defineTool({
        name: "places_camera_snapshot",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Camera picture",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "A still picture from one camera in this account's places, as it is right now. Without cameraId, lists the cameras this account can watch. No video and no recordings. Read-only.",
        input: snapshotInput,
        scope: "places.cameras",
        category: "home",
        readOnly: true,
        async run(input, caller) {
            const { user, install } = await contextFor(caller);
            const cameras = await import("./cameras");
            if (!input.cameraId) {
                const reach = await placesReach(user);
                const [list, placeList] = await Promise.all([
                    cameras.listCameras(install.id),
                    places.listPlaces(install.id)
                ]);
                const names = new Map(placeList.map((place) => [place.id, place.name]));
                // Named, placed and whether it answers - never its address or
                // the login it is reached with.
                const rows = onlyReachable(list, reach.everything || reach.cameras).map(
                    (camera) => ({
                        id: camera.id,
                        name: camera.name,
                        place: names.get(camera.placeId) ?? null,
                        zone: camera.zone,
                        enabled: camera.enabled,
                        online: camera.enabled && camera.offlineSince === null,
                        lastSeenAt: camera.lastSeenAt
                    })
                );
                if (rows.length === 0) return { text: "No cameras.", structured: { cameras: [] } };
                return {
                    text: rows
                        .map(
                            (row) =>
                                `${row.id}  ${row.name} (${[row.place, row.zone].filter(Boolean).join(" / ")}): ${row.enabled ? (row.online ? "online" : "offline") : "switched off"}`
                        )
                        .join("\n"),
                    structured: { cameras: rows }
                };
            }

            const cameraId = input.cameraId;
            // The snapshot route's own question, asked before the relay is.
            await attempt(() => requireCameraView(user, cameraId));
            const camera = await cameras.getCamera(install.id, cameraId);
            if (!camera) refuse("That camera is not shared with you");
            const { cameraStill, CameraOfflineError } = await import("./live");
            const still = async (width: number) => {
                try {
                    return await cameraStill(install.id, cameraId, {
                        width,
                        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)
                    });
                } catch (caught) {
                    // Asleep, starting or switched off: the tile's own sentence.
                    if (caught instanceof CameraOfflineError) refuse(caught.message);
                    if (caught instanceof Error && caught.name === "TimeoutError")
                        refuse("The camera did not send a picture in time.");
                    throw caught;
                }
            };
            let image = await still(input.width);
            if (image.length > SNAPSHOT_MAX_BYTES && input.width > SNAPSHOT_SMALLEST)
                image = await still(SNAPSHOT_SMALLEST);
            if (image.length > SNAPSHOT_MAX_BYTES)
                refuse("The camera's picture is too large to send, even at its smallest size.");
            const takenAt = new Date().toISOString();
            return {
                text: `${camera.name}, ${takenAt}.`,
                images: [{ data: image.toString("base64"), mimeType: "image/jpeg" }],
                structured: { cameraId, name: camera.name, takenAt, bytes: image.length }
            };
        }
    });

/** Built when the app is first asked for its tools, not when this module
 *  loads: `defineTool` is the host's, and a module of this app can be loaded
 *  before the dashboard has provided it (test/home/cold-start). */
let built: readonly McpTool[] | undefined;

export function placesMcpTools(): readonly McpTool[] {
    built ??= [devicesTool, controlTool, routinesTool, runTool, snapshotTool].map((tool) => tool());
    return built;
}

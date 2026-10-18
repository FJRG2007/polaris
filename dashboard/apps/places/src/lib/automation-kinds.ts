/**
 * What an automation is: the shape the editor draws, the server stores and the
 * engine runs.
 *
 * WHEN one of its triggers happens, IF its conditions hold, THEN its steps run in
 * order. One schema and one normalizer, imported by the editor and by the action
 * that saves, so the form cannot call something fine that the server refuses and
 * the server cannot store something the engine cannot read.
 *
 * Pure and client-safe, like `device-kinds`: the editor imports it, and anything
 * reaching for the database from here would drag Prisma into the browser.
 *
 * The messages in the schema are catalog keys under `automations.errors`, not
 * sentences: the editor and the action translate them for whoever is reading.
 */

import { z } from "zod";
import * as kinds from "./device-kinds";
import {
    automationsListHref,
    automationNodeId,
    behaviourSchema,
    blockBaseShape,
    isTimeZone,
    offsetSchema,
    durationSeconds,
    quantifierSchema,
    SUN_EVENTS,
    targetRefSchema,
    type Behaviour,
    type Quantifier
} from "@polaris/core";
import type { DeviceAction, DeviceKind, DeviceView } from "./device-kinds";

/** What about a device a trigger, a condition or a wait looks at. A lock has a
 *  bolt and often a door sensor beside it, and "the door opened" is not "the
 *  lock opened"; a sensor has neither and is its reading. An air conditioner
 *  is on or off, and separately cooling or heating - its mode. A purifier has a
 *  mode too, and filters that wear: `filter` is the most worn one's state. */
export const AUTOMATION_ATTRIBUTES = [
    "state",
    "door",
    "reading",
    "mode",
    "filter",
    "online",
    "battery"
] as const;
export type AutomationAttribute = (typeof AUTOMATION_ATTRIBUTES)[number];

/** Whether a device is answering. Every device has this, whatever it does. */
export const AVAILABILITY_WORDS = ["online", "offline"] as const;

/** A battery as a trigger or a condition reads it: running low, or not. */
export const BATTERY_WORDS = ["low", "ok"] as const;

/** At or under this share a battery reads as low, unless its own maker says
 *  so first. */
export const BATTERY_LOW_PERCENT = 20;

/** What a device says about its battery, where it has one. */
export interface BatteryReport {
    readonly batteryPercent?: number | null;
    readonly batteryCritical?: boolean;
}

/** A battery's word - low or ok - or empty for a device that reports none. */
export function batteryWord(device: BatteryReport): string {
    if (device.batteryCritical) return "low";
    const percent = device.batteryPercent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return "";
    return percent <= BATTERY_LOW_PERCENT ? "low" : "ok";
}

export function hasBattery(device: BatteryReport): boolean {
    return batteryWord(device) !== "";
}

/** The door sensor's words that can be waited for. `unknown` and `none` are not
 *  something a door does. */
export const DOOR_WORDS = ["open", "closed"] as const;

/** The states worth reacting to, per kind. `moving` is a lock on its way
 *  somewhere and never where anybody wants it to be; `unknown` is silence. */
const WATCHED_STATES: Readonly<Record<DeviceKind, readonly kinds.DeviceState[]>> = {
    lock: ["locked", "unlocked", "unlatched", "jammed"],
    opener: ["locked", "unlatched"],
    climate: ["on", "off"],
    air: ["on", "off"],
    switch: ["on", "off"],
    outlet: ["on", "off"],
    light: ["on", "off"],
    sensor: [],
    // On while it is cooking, set or paused; off in standby.
    appliance: ["on", "off"]
};

export function watchedStates(kind: string): readonly kinds.DeviceState[] {
    return WATCHED_STATES[kinds.deviceKind(kind)];
}

/** What a kind of device does, before whether it answers and its battery. */
function ownAttributes(kind: string): readonly AutomationAttribute[] {
    const which = kinds.deviceKind(kind);
    if (which === "sensor") return ["reading"];
    if (which === "lock" || which === "opener") return ["state", "door"];
    if (which === "climate") return ["state", "mode"];
    if (which === "air") return ["state", "mode", "filter"];
    return ["state"];
}

/**
 * Which attributes a device has to watch: what its kind does, then whether it
 * is answering, which every device has, then its battery. Given the device, the
 * battery is there only when it reports one; without it, the battery is allowed,
 * so a block saved on one is never refused for a reading the screen lacks.
 */
export function attributesFor(
    kind: string,
    device?: BatteryReport
): readonly AutomationAttribute[] {
    const battery = device === undefined || hasBattery(device);
    return [...ownAttributes(kind), "online", ...(battery ? (["battery"] as const) : [])];
}

/**
 * The figures a threshold or a reading condition can compare on a device that
 * reports more than one. A purifier has the dust, the allergen index, the
 * humidity and the room's temperature, `filter` - the least life left in any
 * of its filters, as a share - and `quality`, how good the air is as a rank from
 * 1 (Good) to 6 (Extremely poor), so "Poor or worse" is "at least 4". Anything
 * else has its one reading and no choice to make.
 */
export const READING_MEASURES = [...kinds.AIR_MEASURES, "filter", "quality"] as const;
export type ReadingMeasure = (typeof READING_MEASURES)[number];

export function measuresFor(kind: string): readonly ReadingMeasure[] {
    return kinds.deviceKind(kind) === "air" ? READING_MEASURES : [];
}

/**
 * The figures a device has to compare as numbers, which the editor offers
 * beside its attributes: each of a purifier's, the room temperature an air
 * conditioner reads, and a sensor's one reading while that reading is a number.
 * `undefined` is "the device's one reading". A sensor whose reading is a word
 * ("Open") has none: its reading is an attribute, compared as a word.
 */
export function figuresFor(
    kind: string,
    reading?: string | null
): readonly (ReadingMeasure | undefined)[] {
    const which = kinds.deviceKind(kind);
    if (which === "air") return READING_MEASURES;
    if (which === "climate") return [undefined];
    // The engine reads the first number in the text, so "21.5" and "21,5" are
    // both a figure; a word is not.
    if (which === "sensor" && reading && /-?\d+(?:[.,]\d+)?/.test(reading)) return [undefined];
    return [];
}

/** The words a mode can be, whichever kind of device it is on. */
const MODE_WORDS: readonly string[] = [
    ...new Set<string>([...kinds.CLIMATE_MODES, ...kinds.AIR_MODES])
];

/** Whether a kind of device has a number to compare - a sensor's reading, the
 *  room temperature an air conditioner reads, or a purifier's figures. What a
 *  threshold trigger and a reading condition can watch. */
export function measures(kind: string): boolean {
    const which = kinds.deviceKind(kind);
    return which === "sensor" || which === "climate" || which === "air";
}

/** A step may flip something rather than name where it should end up. Only for
 *  the things with two ends: a lock that is jammed has no "other" state. */
export const TOGGLE = "toggle";
export const STEP_DEVICE_ACTIONS = [...kinds.DEVICE_ACTIONS, TOGGLE] as const;
export type StepDeviceAction = (typeof STEP_DEVICE_ACTIONS)[number];

export function stepActionsFor(kind: string): readonly StepDeviceAction[] {
    const own = kinds.actionsFor(kind).filter((action) => !kinds.LIGHT_ACTIONS.includes(action));
    return own.includes("turn-on") && own.includes("turn-off") ? [...own, TOGGLE] : own;
}

/** What a door or window sensor reads, and a motion sensor: open first, then
 *  movement first. */
export const OPEN_PAIR = ["Open", "Closed"] as const;
export const MOTION_PAIR = ["Movement", "Still"] as const;

/** The two-state words sensors send, in pairs, so a picker can offer the other
 *  half of whatever one is reading now. */
export const READING_PAIRS: readonly (readonly [string, string])[] = [
    OPEN_PAIR,
    ["Locked", "Unlocked"],
    MOTION_PAIR,
    ["Somebody there", "Empty"],
    ["Home", "Away"],
    ["Wet", "Dry"],
    ["Smoke", "Clear"],
    ["Gas", "Clear"],
    ["Problem", "Fine"],
    ["Connected", "Disconnected"],
    ["Tampered", "Clear"]
];

/** The words worth offering for a sensor reading this now, or none when it is a
 *  number or a word nobody paired. */
export function readingWordsFor(reading: string): readonly string[] {
    const found = READING_PAIRS.filter((pair) => pair.includes(reading));
    return [...new Set(found.flat())];
}

export const LIMITS = {
    name: 80,
    triggers: 8,
    groups: 6,
    conditionsPerGroup: 10,
    steps: 30,
    message: 280,
    /** A week. Longer than that is a calendar, not a delay. */
    delaySeconds: 7 * 24 * 60 * 60,
    /** Minutes an interval or a "for" can span: a week. */
    minutes: 7 * 24 * 60,
    /** How long a step may wait for a device, in minutes: a day. */
    waitMinutes: 24 * 60,
    word: 60,
    /** Devices one trigger or condition can be about. */
    targets: 20,
    /** How far before or after a sun event something can be set: half a day,
     *  past which "before sunset" is the morning. */
    sunOffsetSeconds: 12 * 60 * 60
} as const;

export type { Behaviour, Quantifier };

/** What a block's set can name: a device, or every device in a room or on a
 *  floor that answers what the block asks. */
export const TARGET_KINDS = ["device", "room", "floor"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

const targetsSchema = z
    .array(targetRefSchema.extend({ kind: z.enum(TARGET_KINDS) }))
    .max(LIMITS.targets, "automations.errors.tooMany")
    .optional();

/**
 * The devices a trigger or a condition is about. `deviceId` is the one every
 * block has had, and every one stored before sets existed is read by it alone;
 * a set lists the rest in `targets`, with `deviceId` kept as its first so an
 * older build reading the block still finds a device in it. Each device once.
 */
export function deviceTargets(block: {
    readonly deviceId: string;
    readonly targets?: readonly { readonly kind: string; readonly id: string }[];
}): string[] {
    const ids = [
        block.deviceId,
        ...(block.targets ?? []).filter((ref) => ref.kind === "device").map((ref) => ref.id)
    ].filter((id) => id.length > 0);
    return [...new Set(ids)];
}

/** The rooms and floors a block names, in the order it names them. */
export function placeTargets(block: {
    readonly targets?: readonly { readonly kind: string; readonly id: string }[];
}): { kind: "room" | "floor"; id: string }[] {
    return (block.targets ?? []).flatMap((ref) =>
        ref.kind === "room" || ref.kind === "floor" ? [{ kind: ref.kind, id: ref.id }] : []
    );
}

/** What a room or a floor is resolved against: the devices at the place with
 *  the room each is in, and the floor each room is on. */
export interface TargetScope {
    readonly devices: readonly {
        readonly id: string;
        readonly kind: string;
        readonly controllable?: boolean;
        readonly roomId?: string | null;
    }[];
    readonly rooms: readonly { readonly id: string; readonly floorId?: string }[];
}

type TargetBlock = {
    readonly kind: string;
    readonly deviceId: string;
    readonly targets?: readonly { readonly kind: string; readonly id: string }[];
};

/** Whether a device answers what a block asks of it: the attribute it watches,
 *  the figure it compares, or the step it takes. */
function answersBlock(block: TargetBlock, device: TargetScope["devices"][number]): boolean {
    const asked = block as TargetBlock & {
        attribute?: AutomationAttribute;
        measure?: ReadingMeasure;
        do?: StepDeviceAction;
    };
    if (block.kind === "threshold" || block.kind === "reading") {
        return (
            measures(device.kind) &&
            (asked.measure === undefined || measuresFor(device.kind).includes(asked.measure))
        );
    }
    if (asked.do !== undefined) {
        return device.controllable !== false && stepActionsFor(device.kind).includes(asked.do);
    }
    return attributesFor(device.kind).includes(asked.attribute ?? "state");
}

/**
 * The devices a block is about once its rooms and floors are read: the devices
 * it names, then each device in a room or on a floor it names that answers what
 * it asks, each once. A block naming no room nor floor is `deviceTargets`. One
 * that does keeps `deviceId` only for a build from before rooms could be named,
 * so a device that has since left the room is not counted for it.
 */
export function resolvedTargets(block: TargetBlock, scope: TargetScope): string[] {
    const places = placeTargets(block);
    if (places.length === 0) return deviceTargets(block);
    const floorOf = new Map(scope.rooms.map((room) => [room.id, room.floorId ?? ""]));
    const ids = (block.targets ?? []).filter((ref) => ref.kind === "device").map((ref) => ref.id);
    for (const place of places) {
        for (const device of scope.devices) {
            const roomId = device.roomId ?? "";
            if (!roomId) continue;
            const inside =
                place.kind === "room" ? roomId === place.id : floorOf.get(roomId) === place.id;
            if (inside && answersBlock(block, device)) ids.push(device.id);
        }
    }
    return [...new Set(ids.filter((id) => id.length > 0))];
}

/** A block with its rooms and floors read into the devices they hold, as the
 *  engine runs it: its first as its device, the rest as its set. A room with
 *  nothing in it that answers leaves the block about no device at all. */
export function resolveTargets<T extends TargetBlock>(block: T, scope: TargetScope): T {
    if (placeTargets(block).length === 0) return block;
    const ids = resolvedTargets(block, scope);
    const { targets: _was, ...rest } = block;
    return {
        ...rest,
        deviceId: ids[0] ?? "",
        ...(ids.length > 1 ? { targets: ids.map((id) => ({ kind: "device" as const, id })) } : {})
    } as unknown as T;
}

/** The rooms and floors an automation names, anywhere in it. */
export function namedPlaces(
    definition: AutomationDefinition
): { kind: "room" | "floor"; id: string }[] {
    const blocks: unknown[] = [
        ...definition.triggers,
        ...definition.conditions.groups.flatMap((group) => group.items),
        ...definition.actions
    ];
    return blocks.flatMap((block) =>
        placeTargets(block as { targets?: { kind: string; id: string }[] })
    );
}

/** Whether anything in an automation names a room or a floor. */
export function namesPlaces(definition: AutomationDefinition): boolean {
    return namedPlaces(definition).length > 0;
}

/** An automation with every room and floor it names read into devices. */
export function resolveDefinition(
    definition: AutomationDefinition,
    scope: TargetScope
): AutomationDefinition {
    if (!namesPlaces(definition)) return definition;
    const each = <T>(block: T): T =>
        block && typeof block === "object" && "deviceId" in block
            ? (resolveTargets(block as unknown as TargetBlock, scope) as unknown as T)
            : block;
    return {
        ...definition,
        triggers: definition.triggers.map(each),
        conditions: {
            ...definition.conditions,
            groups: definition.conditions.groups.map((group) => ({
                ...group,
                items: group.items.map(each)
            }))
        },
        actions: definition.actions.map(each)
    };
}

/** A block pointed at `ids`: the first as its device, all of them as its set
 *  once there is more than one, and no set at all for one. */
export function withTargets<T extends { deviceId: string; targets?: unknown }>(
    block: T,
    ids: readonly string[]
): T {
    const unique = [...new Set(ids.filter((id) => id.length > 0))];
    const { targets: _was, ...rest } = block;
    const first = unique[0] ?? block.deviceId;
    if (unique.length < 2) return { ...rest, deviceId: first } as T;
    return {
        ...rest,
        deviceId: first,
        targets: unique.map((id) => ({ kind: "device" as const, id }))
    } as T;
}

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** How a reading condition tests a figure: against one line, or inside or
 *  outside a range (both ends inside). */
export const COMPARISONS = ["gt", "gte", "lt", "lte", "eq", "ne", "between", "outside"] as const;
export type Comparison = (typeof COMPARISONS)[number];

/** Whether a reading condition's test needs a range rather than a line. */
export function isRangeTest(op: Comparison): boolean {
    return op === "between" || op === "outside";
}

// --- the schema -------------------------------------------------------------

const nodeId = z.string().regex(/^[a-z0-9]{4,24}$/, "automations.errors.broken");
const clock = z
    .string({ required_error: "automations.errors.time" })
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "automations.errors.time");
const days = z
    .array(z.number().int().min(0).max(6), { required_error: "automations.errors.days" })
    .min(1, "automations.errors.days")
    .max(7);
const deviceRef = z
    .string({ required_error: "automations.errors.device" })
    .min(1, "automations.errors.device")
    .max(64);
const attribute = z.enum(AUTOMATION_ATTRIBUTES);
const word = z.string().max(LIMITS.word, "automations.errors.tooLong");
const needed = word.min(1, "automations.errors.state");

/** A whole number within bounds, where an empty field (NaN) is "fill this in"
 *  rather than a type error nobody can read. */
function count(min: number, max: number, tooSmall = "automations.errors.tooSmall") {
    return z
        .number({
            required_error: "automations.errors.number",
            invalid_type_error: "automations.errors.number"
        })
        .int("automations.errors.whole")
        .min(min, tooSmall)
        .max(max, "automations.errors.tooBig");
}

const amount = z
    .number({
        required_error: "automations.errors.number",
        invalid_type_error: "automations.errors.number"
    })
    .finite("automations.errors.number")
    .min(-1e9, "automations.errors.tooSmall")
    .max(1e9, "automations.errors.tooBig");

/**
 * What a step that sets something sets it to. The same shapes as a device
 * command (`climateCommandSchema`, `airCommandSchema`), with this editor's own
 * messages; whether the unit has it - and whether it is that unit's kind's - is
 * for `deviceIssues` to say, against the unit itself.
 */
const settingError = { errorMap: () => ({ message: "automations.errors.setting" }) };
const climateSettingSchema = z.discriminatedUnion(
    "action",
    [
        z.object({
            action: z.literal("set-mode"),
            mode: z.enum(kinds.CLIMATE_MODES, settingError)
        }),
        z.object({ action: z.literal("set-temperature"), target: amount }),
        z.object({ action: z.literal("set-fan"), fan: z.enum(kinds.CLIMATE_FANS, settingError) }),
        z.object({
            action: z.literal("set-option"),
            option: z.enum(kinds.CLIMATE_OPTIONS, settingError),
            on: z.boolean(settingError)
        })
    ],
    settingError
);
const airSettingSchema = z.discriminatedUnion(
    "action",
    [
        z.object({ action: z.literal("set-mode"), mode: z.enum(kinds.AIR_MODES, settingError) }),
        z.object({ action: z.literal("set-fan"), speed: z.enum(kinds.AIR_SPEEDS, settingError) }),
        z.object({
            action: z.literal("set-option"),
            option: z.enum(kinds.AIR_OPTIONS, settingError),
            on: z.boolean(settingError)
        }),
        z.object({ action: z.literal("set-humidity"), target: amount })
    ],
    settingError
);
type ClimateSetting = z.infer<typeof climateSettingSchema>;
type AirSetting = z.infer<typeof airSettingSchema>;

/** Whether a setting is shaped as a purifier's: it carries what only a purifier
 *  has. A mode both kinds share reads as an air conditioner's here and is
 *  checked as the device's own kind's by `deviceIssues`. */
function airShaped(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const setting = value as Record<string, unknown>;
    if ("speed" in setting || setting.action === "set-humidity") return true;
    if (setting.action === "set-option")
        return (kinds.AIR_OPTIONS as readonly unknown[]).includes(setting.option);
    if (setting.action === "set-mode") {
        return (
            (kinds.AIR_MODES as readonly unknown[]).includes(setting.mode) &&
            !(kinds.CLIMATE_MODES as readonly unknown[]).includes(setting.mode)
        );
    }
    return false;
}

/** Either kind's setting, checked by the one it is shaped as - so a complaint
 *  is about the field that is wrong rather than "neither kind". */
const settingSchema = z.unknown().transform((value, context): ClimateSetting | AirSetting => {
    const parsed = (airShaped(value) ? airSettingSchema : climateSettingSchema).safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues)
        context.addIssue({ ...issue, message: issue.message } as z.IssueData);
    return z.NEVER;
});

export type StepSetting = ClimateSetting | AirSetting;

/** The field of a setting its value is in, which is where a complaint about it
 *  is drawn. */
export function settingField(setting: StepSetting): string {
    if ("mode" in setting) return "mode";
    if ("fan" in setting) return "fan";
    if ("speed" in setting) return "speed";
    if ("option" in setting) return "option";
    return "target";
}

/** A block's own name and note, kept through a save. Places runs every block,
 *  so the switch that skips one is not taken here yet. */
const blockBase = { alias: blockBaseShape.alias, note: blockBaseShape.note };

/** The sun events a condition compares with: the sun is up or it is not. */
export const SUN_EDGES = ["sunrise", "sunset"] as const;
export type SunEdgeEvent = (typeof SUN_EDGES)[number];

/** How far before or after a sun event: the shared offset, in whole units and
 *  within half a day. Absent is the moment itself. */
const sunOffset = offsetSchema
    .extend({ amount: count(0, 100_000) })
    .refine(
        (offset) => durationSeconds(offset) <= LIMITS.sunOffsetSeconds,
        "automations.errors.tooBig"
    );

/** One side of a sun condition: after (or before) this event, moved by this. */
const sunEdge = z.object({
    event: z.enum(SUN_EDGES, { errorMap: () => ({ message: "automations.errors.state" }) }),
    offset: sunOffset.optional()
});

/** How a threshold trigger watches a figure: across a line, or into or out of a range. */
export const THRESHOLD_DIRECTIONS = ["above", "below", "between", "outside"] as const;
export type ThresholdDirection = (typeof THRESHOLD_DIRECTIONS)[number];

/** Whether a threshold direction needs a range rather than a line. */
export function isRange(direction: ThresholdDirection): boolean {
    return direction === "between" || direction === "outside";
}

export const triggerSchema = z.discriminatedUnion("kind", [
    z.object({ id: nodeId, ...blockBase, kind: z.literal("time"), at: clock, days }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("interval"),
        minutes: count(1, LIMITS.minutes)
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("change"),
        deviceId: deviceRef,
        targets: targetsSchema,
        /** For a set: each device's change, the first one's, or the last one's. */
        behaviour: behaviourSchema.optional(),
        attribute,
        from: word,
        to: word,
        /** Fires only once the change has lasted this long, not the moment it happens. */
        forMinutes: count(1, LIMITS.minutes).optional()
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("stays"),
        deviceId: deviceRef,
        targets: targetsSchema,
        behaviour: behaviourSchema.optional(),
        attribute,
        is: needed,
        // Zero is "the moment it happens", which is what "A device changes"
        // is for - so the complaint says so instead of only "too small".
        minutes: count(1, LIMITS.minutes, "automations.errors.staysRightAway")
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("threshold"),
        deviceId: deviceRef,
        targets: targetsSchema,
        behaviour: behaviourSchema.optional(),
        /** "between" fires on coming into `value`..`upper`, "outside" on leaving it. */
        direction: z.enum(THRESHOLD_DIRECTIONS),
        value: amount,
        /** The top of the range, for "between" and "outside" only. */
        upper: amount.optional(),
        /** Which of a purifier's figures; absent for a device's one reading. */
        measure: z.enum(READING_MEASURES).optional(),
        /** Fires only once the figure has stayed past the line this long. */
        forMinutes: count(1, LIMITS.minutes).optional()
    }),
    z.object({ id: nodeId, ...blockBase, kind: z.literal("manual") }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("sun"),
        event: z.enum(SUN_EVENTS, { errorMap: () => ({ message: "automations.errors.state" }) }),
        offset: sunOffset.optional()
    })
]);

export const conditionSchema = z.discriminatedUnion("kind", [
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("device"),
        deviceId: deviceRef,
        targets: targetsSchema,
        /** For a set: any of its devices, or all of them. */
        quantifier: quantifierSchema.optional(),
        attribute,
        is: needed,
        negate: z.boolean(),
        /** Passes only once the device has been that way for this long. */
        forMinutes: count(1, LIMITS.minutes).optional()
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("reading"),
        deviceId: deviceRef,
        targets: targetsSchema,
        quantifier: quantifierSchema.optional(),
        op: z.enum(COMPARISONS),
        value: amount,
        /** The top of the range, for "between" and "outside" only. */
        upper: amount.optional(),
        measure: z.enum(READING_MEASURES).optional(),
        /** Passes only once the figure has passed the test for this long. */
        forMinutes: count(1, LIMITS.minutes).optional()
    }),
    z.object({ id: nodeId, ...blockBase, kind: z.literal("time"), from: clock, to: clock }),
    z.object({ id: nodeId, ...blockBase, kind: z.literal("weekday"), days }),
    /** After one sun event, before one, or both. After sunset and before
     *  sunrise is the night, across midnight; any other pair is one day. */
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("sun"),
        after: sunEdge.optional(),
        before: sunEdge.optional()
    }),
    /** Passes when the run was started by one of these triggers, by id. */
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("triggeredBy"),
        triggerIds: z
            .array(nodeId)
            .min(1, "automations.errors.noTriggerPicked")
            .max(LIMITS.triggers, "automations.errors.tooMany")
    })
]);

const match = z.enum(["all", "any"]);

export const conditionGroupSchema = z.object({
    id: nodeId,
    ...blockBase,
    match,
    items: z
        .array(conditionSchema)
        .min(1, "automations.errors.emptyGroup")
        .max(LIMITS.conditionsPerGroup, "automations.errors.tooMany")
});

export const actionSchema = z.discriminatedUnion("kind", [
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("device"),
        deviceId: deviceRef,
        /** More devices, a room or a floor, each told the same. */
        targets: targetsSchema,
        do: z.enum(STEP_DEVICE_ACTIONS, {
            errorMap: () => ({ message: "automations.errors.action" })
        }),
        /** What to set, for the actions that set something. */
        setting: settingSchema.optional()
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("delay"),
        seconds: count(1, LIMITS.delaySeconds)
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("wait"),
        deviceId: deviceRef,
        targets: targetsSchema,
        /** For a set: until any of its devices is that way, or all of them. */
        quantifier: quantifierSchema.optional(),
        attribute,
        is: needed,
        timeoutMinutes: count(1, LIMITS.waitMinutes),
        onTimeout: z.enum(["stop", "continue"])
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("notify"),
        message: z
            .string()
            .min(1, "automations.errors.message")
            .max(LIMITS.message, "automations.errors.tooLong")
    }),
    z.object({
        id: nodeId,
        ...blockBase,
        kind: z.literal("run"),
        automationId: z
            .string({ required_error: "automations.errors.automation" })
            .min(1, "automations.errors.automation")
            .max(64)
    })
]);

export const definitionSchema = z
    .object({
        /** The zone its times are read in. Never `auto`: that is whatever device
         *  is looking, and the server running this at 07:00 is not looking. */
        timeZone: z
            .string()
            .min(1, "automations.errors.timeZone")
            .refine((zone) => zone !== "auto" && isTimeZone(zone), "automations.errors.timeZone"),
        triggers: z
            .array(triggerSchema)
            .min(1, "automations.errors.noTrigger")
            .max(LIMITS.triggers, "automations.errors.tooMany"),
        conditions: z.object({
            match,
            groups: z.array(conditionGroupSchema).max(LIMITS.groups, "automations.errors.tooMany")
        }),
        actions: z
            .array(actionSchema)
            .min(1, "automations.errors.noStep")
            .max(LIMITS.steps, "automations.errors.tooMany")
    })
    .superRefine((definition, context) => {
        const seen = new Set<string>();
        const nodes: { id: string; path: (string | number)[] }[] = [
            ...definition.triggers.map((node, index) => ({
                id: node.id,
                path: ["triggers", index]
            })),
            ...definition.conditions.groups.flatMap((group, index) => [
                { id: group.id, path: ["conditions", "groups", index] },
                ...group.items.map((node, item) => ({
                    id: node.id,
                    path: ["conditions", "groups", index, "items", item]
                }))
            ]),
            ...definition.actions.map((node, index) => ({ id: node.id, path: ["actions", index] }))
        ];
        for (const node of nodes) {
            if (seen.has(node.id)) {
                context.addIssue({
                    code: "custom",
                    path: node.path,
                    message: "automations.errors.broken"
                });
            }
            seen.add(node.id);
        }

        definition.triggers.forEach((trigger, index) => {
            const at = ["triggers", index];
            if (trigger.kind === "change") {
                checkWord(context, trigger.attribute, trigger.from, [...at, "from"], true);
                checkWord(context, trigger.attribute, trigger.to, [...at, "to"], true);
                if (trigger.from && trigger.from === trigger.to) {
                    context.addIssue({
                        code: "custom",
                        path: [...at, "to"],
                        message: "automations.errors.sameState"
                    });
                }
            }
            if (trigger.kind === "stays") {
                checkWord(context, trigger.attribute, trigger.is, [...at, "is"], false);
            }
            if (trigger.kind === "threshold") {
                checkFigure(context, trigger, at);
                checkRange(context, isRange(trigger.direction), trigger, at);
            }
        });

        definition.conditions.groups.forEach((group, index) =>
            group.items.forEach((condition, item) => {
                const at = ["conditions", "groups", index, "items", item];
                if (condition.kind === "device") {
                    checkWord(context, condition.attribute, condition.is, [...at, "is"], false);
                }
                if (condition.kind === "reading") {
                    checkFigure(context, condition, at);
                    checkRange(context, isRangeTest(condition.op), condition, at);
                }
                if (condition.kind === "sun" && !condition.after && !condition.before) {
                    context.addIssue({
                        code: "custom",
                        path: [...at, "after"],
                        message: "automations.errors.sunEdge"
                    });
                }
                if (
                    condition.kind === "triggeredBy" &&
                    condition.triggerIds.some(
                        (id) => !definition.triggers.some((trigger) => trigger.id === id)
                    )
                ) {
                    // A trigger since removed: the editor offers to uncheck it.
                    context.addIssue({
                        code: "custom",
                        path: [...at, "triggerIds"],
                        message: "automations.errors.triggerGone"
                    });
                }
                if (condition.kind === "time" && condition.from === condition.to) {
                    context.addIssue({
                        code: "custom",
                        path: [...at, "to"],
                        message: "automations.errors.sameTime"
                    });
                }
            })
        );

        definition.actions.forEach((action, index) => {
            if (action.kind === "wait") {
                checkWord(context, action.attribute, action.is, ["actions", index, "is"], false);
            }
            if (action.kind === "device") {
                const needs = action.do !== TOGGLE && kinds.needsCommand(action.do);
                // A setting goes with the action that sets it, and only there:
                // "set the mode" with no mode, or a temperature riding on "turn
                // off", is a step that cannot say what it does.
                if (needs ? action.setting?.action !== action.do : action.setting !== undefined) {
                    context.addIssue({
                        code: "custom",
                        path: ["actions", index, "setting"],
                        message: "automations.errors.setting"
                    });
                }
            }
        });
    });

/** Air quality is compared as a level's rank, so it has to be one: a 3.5 is
 *  no level at all. */
function checkFigure(
    context: z.RefinementCtx,
    node: { readonly measure?: ReadingMeasure; readonly value: number },
    path: (string | number)[]
): void {
    if (node.measure === "quality" && kinds.airQualityAt(node.value) === null) {
        context.addIssue({
            code: "custom",
            path: [...path, "value"],
            message: "automations.errors.state"
        });
    }
}

/** A range needs its top, above its bottom; a line has none. */
function checkRange(
    context: z.RefinementCtx,
    ranged: boolean,
    node: { readonly value: number; readonly upper?: number },
    path: (string | number)[]
): void {
    if (!ranged) return;
    if (node.upper === undefined || !Number.isFinite(node.upper)) {
        context.addIssue({
            code: "custom",
            path: [...path, "upper"],
            message: "automations.errors.upper"
        });
    } else if (node.upper <= node.value) {
        context.addIssue({
            code: "custom",
            path: [...path, "upper"],
            message: "automations.errors.upperBelow"
        });
    }
}

/** A state or door word has to be one this app knows; a reading is whatever the
 *  sensor sends. Empty is allowed where "any" is meant. */
function checkWord(
    context: z.RefinementCtx,
    attribute: AutomationAttribute,
    value: string,
    path: (string | number)[],
    emptyIsAny: boolean
): void {
    if (!value) {
        if (!emptyIsAny)
            context.addIssue({ code: "custom", path, message: "automations.errors.state" });
        return;
    }
    const known =
        attribute === "state"
            ? (kinds.DEVICE_STATES as readonly string[]).includes(value)
            : attribute === "door"
              ? (DOOR_WORDS as readonly string[]).includes(value)
              : attribute === "mode"
                ? MODE_WORDS.includes(value)
                : attribute === "filter"
                  ? (kinds.FILTER_STATES as readonly string[]).includes(value)
                  : attribute === "online"
                    ? (AVAILABILITY_WORDS as readonly string[]).includes(value)
                    : attribute === "battery"
                      ? (BATTERY_WORDS as readonly string[]).includes(value)
                      : true;
    if (!known) context.addIssue({ code: "custom", path, message: "automations.errors.state" });
}

export const automationInputSchema = z.object({
    name: z
        .string({ required_error: "automations.errors.name" })
        .min(1, "automations.errors.name")
        .max(LIMITS.name, "automations.errors.tooLong"),
    enabled: z.boolean(),
    placeId: z.string().min(1, "automations.errors.place").max(64),
    definition: definitionSchema
});

export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationDefinition = z.infer<typeof definitionSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type TriggerKind = Trigger["kind"];
export type Condition = z.infer<typeof conditionSchema>;
export type ConditionKind = Condition["kind"];
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;
export type Step = z.infer<typeof actionSchema>;
export type StepKind = Step["kind"];

export const TRIGGER_KINDS: readonly TriggerKind[] = [
    "change",
    "stays",
    "threshold",
    "time",
    "sun",
    "interval",
    "manual"
];
export const CONDITION_KINDS: readonly ConditionKind[] = [
    "device",
    "reading",
    "time",
    "weekday",
    "sun",
    "triggeredBy"
];
export const STEP_KINDS: readonly StepKind[] = ["device", "delay", "wait", "notify", "run"];

// --- normalizing ------------------------------------------------------------

/** "7:5", " 07:05 " and "0705" are the same time, written one way. */
export function normalizeClock(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    const parts = /^(\d{1,2})[:.h]?(\d{2})$/.exec(trimmed) ?? /^(\d{1,2}):(\d{1,2})$/.exec(trimmed);
    if (!parts) return trimmed;
    return `${parts[1]!.padStart(2, "0")}:${parts[2]!.padStart(2, "0")}`;
}

/** A number from a field or from JSON: a numeric string becomes the number, an
 *  empty one is left missing so the schema can say "fill this in". */
function normalizeNumber(value: unknown): unknown {
    if (typeof value === "string") {
        const trimmed = value.trim().replace(",", ".");
        if (!trimmed) return Number.NaN;
        const parsed = Number(trimmed);
        return Number.isNaN(parsed) ? Number.NaN : parsed;
    }
    return value;
}

function normalizeDays(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    const numbers = value.map((day) => normalizeNumber(day));
    if (!numbers.every((day) => typeof day === "number")) return value;
    return [...new Set(numbers as number[])].sort((a, b) => a - b);
}

function trimmed(value: unknown): unknown {
    return typeof value === "string" ? value.trim() : value;
}

const NUMBER_FIELDS = ["minutes", "value", "upper", "seconds", "timeoutMinutes", "forMinutes"];
const WORD_FIELDS = ["deviceId", "from", "to", "is", "message", "automationId"];
const CLOCK_FIELDS = ["at", "from", "to"];

function normalizeNode(node: unknown, clocks: boolean): unknown {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const value = { ...(node as Record<string, unknown>) };
    for (const field of WORD_FIELDS) if (field in value) value[field] = trimmed(value[field]);
    if (clocks)
        for (const field of CLOCK_FIELDS)
            if (field in value) value[field] = normalizeClock(value[field]);
    for (const field of NUMBER_FIELDS)
        if (field in value) value[field] = normalizeNumber(value[field]);
    if ("days" in value) value.days = normalizeDays(value.days);
    const setting = value.setting;
    if (setting && typeof setting === "object" && !Array.isArray(setting) && "target" in setting) {
        value.setting = {
            ...setting,
            target: normalizeNumber((setting as { target: unknown }).target)
        };
    }
    return value;
}

/**
 * Everything an automation is put through before it is checked, in the editor as
 * it is typed and in the action as it arrives. Trims every string, writes times
 * one way, turns numeric text into numbers, sorts the weekdays. Never fills in a
 * missing value: a check that cannot fail is not a check.
 */
export function normalizeAutomationInput(input: unknown): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const value = { ...(input as Record<string, unknown>) };
    value.name = trimmed(value.name);
    value.placeId = trimmed(value.placeId);
    const definition = value.definition;
    if (definition && typeof definition === "object" && !Array.isArray(definition)) {
        const next = { ...(definition as Record<string, unknown>) };
        next.timeZone = trimmed(next.timeZone);
        if (Array.isArray(next.triggers)) {
            next.triggers = next.triggers.map((node) => {
                const kind = (node as { kind?: unknown } | null)?.kind;
                // A change's from/to are states, not times.
                return normalizeNode(node, kind === "time");
            });
        }
        const conditions = next.conditions as { groups?: unknown } | undefined;
        if (conditions && typeof conditions === "object" && Array.isArray(conditions.groups)) {
            next.conditions = {
                ...conditions,
                groups: conditions.groups.map((group) =>
                    group &&
                    typeof group === "object" &&
                    Array.isArray((group as { items?: unknown }).items)
                        ? {
                              ...(group as Record<string, unknown>),
                              items: (group as { items: unknown[] }).items.map((node) =>
                                  normalizeNode(
                                      node,
                                      (node as { kind?: unknown } | null)?.kind === "time"
                                  )
                              )
                          }
                        : group
                )
            };
        }
        if (Array.isArray(next.actions))
            next.actions = next.actions.map((node) => normalizeNode(node, false));
        value.definition = next;
    }
    return value;
}

// --- checks against the devices of the place ---------------------------------

/** One complaint, with where in the input it belongs. */
export interface AutomationIssue {
    readonly path: readonly (string | number)[];
    readonly message: string;
}

/** What the device checks need to know about a device. */
export type AutomationDevice = Pick<DeviceView, "id" | "kind" | "name" | "controllable"> & {
    /** The room it is in, which a block naming a room or a floor reads. */
    readonly roomId?: string | null;
    /** What an air conditioner accepts, where it is known. */
    readonly climate?: kinds.ClimateSettings | null;
    /** What a purifier accepts, where it is known. */
    readonly air?: kinds.AirSettings | null;
};

/**
 * What the schema cannot know: whether the devices named are here, and whether
 * each can do what it is asked. The editor runs it on the devices it drew, the
 * server on the devices the place has - so a device removed while the editor was
 * open is caught at the save.
 */
export function deviceIssues(
    definition: AutomationDefinition,
    devices: readonly AutomationDevice[],
    context: {
        readonly automationIds: readonly string[];
        readonly selfId: string | null;
        /** The place's rooms, which a room or a floor is checked against.
         *  Absent leaves rooms and floors unchecked. */
        readonly rooms?: TargetScope["rooms"];
        /** The place's floors, which a floor is checked against; absent reads a
         *  floor as there only while a room is on it. */
        readonly floors?: readonly { readonly id: string }[];
    }
): AutomationIssue[] {
    const byId = new Map(devices.map((device) => [device.id, device]));
    const issues: AutomationIssue[] = [];

    /** The devices of a block that are its own to check: the ones it names. A
     *  block naming a room keeps its first device only for older builds. */
    const named = (block: TargetBlock): string[] =>
        placeTargets(block).length > 0
            ? (block.targets ?? []).filter((ref) => ref.kind === "device").map((ref) => ref.id)
            : deviceTargets(block);
    /** A room or a floor that is gone, or that holds nothing answering the block. */
    const places = (block: TargetBlock, path: (string | number)[]) => {
        const rooms = context.rooms;
        if (!rooms || placeTargets(block).length === 0) return;
        const scope: TargetScope = { devices, rooms };
        (block.targets ?? []).forEach((ref, index) => {
            if (ref.kind !== "room" && ref.kind !== "floor") return;
            const field = [...path, "targets", index, "id"];
            const known =
                ref.kind === "room"
                    ? rooms.some((room) => room.id === ref.id)
                    : context.floors
                      ? context.floors.some((floor) => floor.id === ref.id)
                      : rooms.some((room) => room.floorId === ref.id);
            if (!known) {
                issues.push({ path: field, message: "automations.errors.placeGone" });
                return;
            }
            const alone = { ...block, targets: [{ kind: ref.kind, id: ref.id }] };
            if (resolvedTargets(alone, scope).length === 0)
                issues.push({ path: field, message: "automations.errors.placeEmpty" });
        });
    };

    /** Where a complaint about one device of a block goes: its own field for the
     *  first, its place in the set for the rest. */
    const fieldOf = (
        block: { deviceId: string; targets?: readonly { id: string }[] },
        deviceId: string,
        path: (string | number)[]
    ): (string | number)[] => {
        if (deviceId === block.deviceId) return [...path, "deviceId"];
        const index = (block.targets ?? []).findIndex((ref) => ref.id === deviceId);
        return [...path, "targets", Math.max(0, index), "id"];
    };
    const watchedOne = (
        block: { deviceId: string; targets?: readonly { id: string }[] },
        deviceId: string,
        which: AutomationAttribute,
        path: (string | number)[]
    ) => {
        const device = byId.get(deviceId);
        if (!device) {
            issues.push({
                path: fieldOf(block, deviceId, path),
                message: "automations.errors.deviceGone"
            });
            return;
        }
        if (!attributesFor(device.kind).includes(which)) {
            issues.push({ path: [...path, "attribute"], message: "automations.errors.attribute" });
        }
    };
    const watched = (block: TargetBlock, which: AutomationAttribute, path: (string | number)[]) => {
        for (const deviceId of named(block)) watchedOne(block, deviceId, which, path);
        places(block, path);
    };
    const sensor = (block: TargetBlock, path: (string | number)[], measure?: ReadingMeasure) => {
        places(block, path);
        for (const deviceId of named(block)) {
            const device = byId.get(deviceId);
            const field = fieldOf(block, deviceId, path);
            if (!device) issues.push({ path: field, message: "automations.errors.deviceGone" });
            else if (!measures(device.kind)) {
                issues.push({ path: field, message: "automations.errors.notSensor" });
            } else if (measure !== undefined && !measuresFor(device.kind).includes(measure)) {
                // A figure only a purifier has, named on something that is not one.
                issues.push({ path: [...path, "measure"], message: "automations.errors.measure" });
            }
        }
    };

    definition.triggers.forEach((trigger, index) => {
        const at = ["definition", "triggers", index];
        if (trigger.kind === "change" || trigger.kind === "stays") {
            watched(trigger, trigger.attribute, at);
        }
        if (trigger.kind === "threshold") sensor(trigger, at, trigger.measure);
    });
    definition.conditions.groups.forEach((group, index) =>
        group.items.forEach((condition, item) => {
            const at = ["definition", "conditions", "groups", index, "items", item];
            if (condition.kind === "device") watched(condition, condition.attribute, at);
            if (condition.kind === "reading") sensor(condition, at, condition.measure);
        })
    );
    definition.actions.forEach((step, index) => {
        const at = ["definition", "actions", index];
        if (step.kind === "wait") watched(step, step.attribute, at);
        if (step.kind === "device") places(step, at);
        for (const deviceId of step.kind === "device" ? named(step) : []) {
            if (step.kind !== "device") break;
            const device = byId.get(deviceId);
            const field = fieldOf(step, deviceId, at);
            if (!device) {
                issues.push({ path: field, message: "automations.errors.deviceGone" });
            } else if (!device.controllable) {
                issues.push({ path: field, message: "automations.errors.watchOnly" });
            } else if (!stepActionsFor(device.kind).includes(step.do)) {
                issues.push({ path: [...at, "do"], message: "automations.errors.cannotDo" });
            } else if (step.setting) {
                // Checked against the unit as it was last read: a mode it does
                // not have, a target past its range, or a setting of the other
                // kind's, is refused at the save rather than at seven in the
                // morning. A unit that has not said yet is checked for its kind.
                const target = {
                    kind: device.kind,
                    climate: device.climate ?? null,
                    air: device.air ?? null
                };
                const read = kinds.commandFor(device.kind, step.setting);
                const known = read && (read.kind === "climate" ? target.climate : target.air);
                if (!read || (known && kinds.commandIssue(target, step.setting))) {
                    issues.push({
                        path: [...at, "setting", settingField(step.setting)],
                        message: "automations.errors.setting"
                    });
                }
            }
        }
        if (step.kind === "run") {
            if (step.automationId === context.selfId) {
                issues.push({
                    path: [...at, "automationId"],
                    message: "automations.errors.runSelf"
                });
            } else if (!context.automationIds.includes(step.automationId)) {
                issues.push({
                    path: [...at, "automationId"],
                    message: "automations.errors.automationGone"
                });
            }
        }
    });
    return issues;
}

/** Whether any step acts on a device, which is what needs the right to operate
 *  them as well as the right to write automations. */
export function actsOnDevices(definition: AutomationDefinition): boolean {
    return definition.actions.some((step) => step.kind === "device");
}

/** Whether an automation reads what any device is doing - a change, a state
 *  held for a while, a reading, a condition or a wait - which is what makes the
 *  tick ask the devices before it looks. One that only acts at a time of day
 *  costs no call to anybody's account. */
export function readsDevices(definition: AutomationDefinition): boolean {
    return (
        definition.triggers.some((trigger) => "deviceId" in trigger) ||
        definition.conditions.groups.some((group) =>
            group.items.some((item) => "deviceId" in item)
        ) ||
        definition.actions.some((step) => step.kind === "wait")
    );
}

/**
 * The devices an automation reads, or "all" when one of its steps waits - a
 * wait can be on any device, and is answered by reading whatever it names
 * when it gets there. What decides which accounts are read at the watched pace
 * with no screen open (`device-watch.ts`).
 */
export function devicesReadBy(definition: AutomationDefinition): string[] | "all" {
    if (definition.actions.some((step) => step.kind === "wait")) return "all";
    // A room is whatever is in it when it is read, which the watch cannot know.
    if (namesPlaces(definition)) return "all";
    const ids = new Set<string>();
    for (const trigger of definition.triggers) if ("deviceId" in trigger) ids.add(trigger.deviceId);
    for (const group of definition.conditions.groups) {
        for (const item of group.items) if ("deviceId" in item) ids.add(item.deviceId);
    }
    return [...ids];
}

// --- building blocks ---------------------------------------------------------

/** A short random id for a node, unique within one automation. */
export const nodeIdOf = automationNodeId;

/** A trigger of a kind, with blanks where somebody has to choose. */
export function blankTrigger(kind: TriggerKind): Trigger {
    const id = nodeIdOf();
    switch (kind) {
        case "time":
            return { id, kind, at: "08:00", days: [...WEEKDAYS] };
        case "interval":
            return { id, kind, minutes: 15 };
        case "change":
            return { id, kind, deviceId: "", attribute: "state", from: "", to: "" };
        case "stays":
            return { id, kind, deviceId: "", attribute: "state", is: "", minutes: 30 };
        case "threshold":
            return { id, kind, deviceId: "", direction: "above", value: Number.NaN };
        case "manual":
            return { id, kind };
        case "sun":
            return { id, kind, event: "sunset" };
    }
}

export function blankCondition(kind: ConditionKind): Condition {
    const id = nodeIdOf();
    switch (kind) {
        case "device":
            return { id, kind, deviceId: "", attribute: "state", is: "", negate: false };
        case "reading":
            return { id, kind, deviceId: "", op: "gt", value: Number.NaN };
        case "time":
            return { id, kind, from: "22:00", to: "07:00" };
        case "weekday":
            return { id, kind, days: [1, 2, 3, 4, 5] };
        case "sun":
            // While it is dark: the pair somebody reaches for first.
            return { id, kind, after: { event: "sunset" }, before: { event: "sunrise" } };
        case "triggeredBy":
            return { id, kind, triggerIds: [] };
    }
}

/** What a step that sets something starts as, for this unit: where it is now,
 *  which is a value it is known to accept. */
export function blankSetting(
    action: StepDeviceAction,
    climate: kinds.ClimateSettings | null | undefined,
    air?: { readonly kind: string; readonly settings: kinds.AirSettings | null | undefined }
): StepSetting | undefined {
    if (air && kinds.deviceKind(air.kind) === "air") return blankAirSetting(action, air.settings);
    switch (action) {
        case "set-mode":
            return { action, mode: climate?.mode ?? climate?.modes[0] ?? "cool" };
        case "set-temperature":
            return { action, target: climate?.target ?? climate?.min ?? Number.NaN };
        case "set-fan":
            return { action, fan: climate?.fan ?? climate?.fans[0] ?? "auto" };
        case "set-option": {
            const option =
                kinds.CLIMATE_OPTIONS.find((entry) => climate?.options[entry] !== undefined) ??
                "swing";
            return { action, option, on: true };
        }
        default:
            return undefined;
    }
}

/** The same for a purifier. */
function blankAirSetting(
    action: StepDeviceAction,
    air: kinds.AirSettings | null | undefined
): StepSetting | undefined {
    switch (action) {
        case "set-mode":
            return { action, mode: air?.mode ?? air?.modes[0] ?? "auto" };
        case "set-fan":
            return { action, speed: air?.speed ?? air?.speeds[0] ?? "speed_1" };
        case "set-humidity":
            return { action, target: air?.humidity?.target ?? air?.humidity?.min ?? Number.NaN };
        case "set-option": {
            const option =
                kinds.AIR_OPTIONS.find((entry) => air?.options[entry] !== undefined) ?? "childLock";
            return { action, option, on: true };
        }
        default:
            return undefined;
    }
}

export function blankStep(kind: StepKind): Step {
    const id = nodeIdOf();
    switch (kind) {
        case "device":
            return { id, kind, deviceId: "", do: "turn-off" };
        case "delay":
            return { id, kind, seconds: 300 };
        case "wait":
            return {
                id,
                kind,
                deviceId: "",
                attribute: "state",
                is: "",
                timeoutMinutes: 10,
                onTimeout: "stop"
            };
        case "notify":
            return { id, kind, message: "" };
        case "run":
            return { id, kind, automationId: "" };
    }
}

/** A block with its set dropped: pointed at another device, it starts over. */
function single<T extends object>(block: T): T {
    if (!("targets" in block)) return block;
    const { targets: _was, ...rest } = block as T & { targets?: unknown };
    // A room or a floor stays: it is read again for whatever the new device asks.
    const places = placeTargets(block as { targets?: { kind: string; id: string }[] });
    return (places.length > 0 ? { ...rest, targets: places } : rest) as T;
}

/** A trigger pointed at `device`, with what it looks at reset to what that device has. */
export function triggerOn(given: Trigger, device: DeviceView): Trigger {
    const trigger = single(given);
    if (trigger.kind === "change" || trigger.kind === "stays") {
        const attribute = attributesFor(device.kind)[0] ?? "state";
        return trigger.kind === "change"
            ? { ...trigger, deviceId: device.id, attribute, from: "", to: "" }
            : { ...trigger, deviceId: device.id, attribute, is: "" };
    }
    if (trigger.kind === "threshold") {
        const { measure: _was, ...rest } = trigger;
        const measure = measuresFor(device.kind)[0];
        return { ...rest, deviceId: device.id, ...(measure ? { measure } : {}) };
    }
    return trigger;
}

/** The same for a condition. */
export function conditionOn(given: Condition, device: DeviceView): Condition {
    const condition = single(given);
    if (condition.kind === "device") {
        const attribute = attributesFor(device.kind)[0] ?? "state";
        return { ...condition, deviceId: device.id, attribute, is: "" };
    }
    if (condition.kind === "reading") {
        const { measure: _was, ...rest } = condition;
        const measure = measuresFor(device.kind)[0];
        return { ...rest, deviceId: device.id, ...(measure ? { measure } : {}) };
    }
    return condition;
}

/** The same for a step: an action the device does not offer becomes its first one. */
export function stepOn(given: Step, device: DeviceView): Step {
    const step = single(given);
    if (step.kind === "device") {
        const offered = stepActionsFor(device.kind);
        const action = offered.includes(step.do) ? step.do : (offered[0] ?? step.do);
        return {
            ...step,
            deviceId: device.id,
            do: action,
            setting: blankSetting(action, device.climate, {
                kind: device.kind,
                settings: device.air
            })
        };
    }
    if (step.kind === "wait") {
        const attribute = attributesFor(device.kind)[0] ?? "state";
        return { ...step, deviceId: device.id, attribute, is: "" };
    }
    return step;
}

export function blankDefinition(timeZone: string): AutomationDefinition {
    return {
        timeZone,
        triggers: [],
        conditions: { match: "all", groups: [] },
        actions: []
    };
}

/** The zone a new automation's times are read in: the reader's own, since
 *  "07:00" means seven where the person writing it is. A preference of "auto"
 *  is this browser's clock, asked here rather than stored as "auto". */
export function readerZone(chosen: string): string {
    if (chosen && chosen !== "auto") return chosen;
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

// --- templates ---------------------------------------------------------------

export const TEMPLATES = ["autoOff", "schedule", "follow"] as const;
export type TemplateId = (typeof TEMPLATES)[number];

/** Where a device that can be left "on" is left, and what puts it back: a
 *  light left on is switched off, a door left unlocked is locked. */
export function autoOffPlan(kind: string): { is: kinds.DeviceState; do: DeviceAction } | null {
    const which = kinds.deviceKind(kind);
    if (
        which === "switch" ||
        which === "outlet" ||
        which === "light" ||
        which === "climate" ||
        which === "air"
    )
        return { is: "on", do: "turn-off" };
    if (which === "lock") return { is: "unlocked", do: "lock" };
    return null;
}

/** "Turn off after X minutes on": the thing somebody asked for in so many words,
 *  as one trigger and one step. */
export function autoOffDefinition(
    device: Pick<DeviceView, "id" | "kind">,
    minutes: number,
    timeZone: string
): AutomationDefinition | null {
    const plan = autoOffPlan(device.kind);
    if (!plan) return null;
    return {
        timeZone,
        triggers: [
            {
                id: nodeIdOf(),
                kind: "stays",
                deviceId: device.id,
                attribute: "state",
                is: plan.is,
                minutes
            }
        ],
        conditions: { match: "all", groups: [] },
        actions: [{ id: nodeIdOf(), kind: "device", deviceId: device.id, do: plan.do }]
    };
}

/** "On at 07:00, off at 23:00": one time, on, a delay of the difference, off. The
 *  delay is stored, so the "off" still happens if Polaris restarts in between. */
export function scheduleDefinition(
    deviceId: string,
    on: string,
    off: string,
    days: readonly number[],
    timeZone: string
): AutomationDefinition {
    return {
        timeZone,
        triggers: [{ id: nodeIdOf(), kind: "time", at: on, days: [...days] }],
        conditions: { match: "all", groups: [] },
        actions: [
            { id: nodeIdOf(), kind: "device", deviceId, do: "turn-on" },
            { id: nodeIdOf(), kind: "delay", seconds: clockGapSeconds(on, off) },
            { id: nodeIdOf(), kind: "device", deviceId, do: "turn-off" }
        ]
    };
}

/** Seconds from one time of day to the next time the other comes round. */
export function clockGapSeconds(from: string, to: string): number {
    const minutes = (value: string) => {
        const [hours, mins] = value.split(":").map(Number);
        return (hours ?? 0) * 60 + (mins ?? 0);
    };
    const gap = (minutes(to) - minutes(from) + 24 * 60) % (24 * 60);
    return (gap === 0 ? 24 * 60 : gap) * 60;
}

/** "When A changes, set B": a change of one device and a step on another. */
export function followDefinition(timeZone: string): AutomationDefinition {
    return {
        timeZone,
        triggers: [blankTrigger("change")],
        conditions: { match: "all", groups: [] },
        actions: [blankStep("device")]
    };
}

// --- runs as a screen reads them ----------------------------------------------

export const RUN_STATUSES = [
    "queued",
    "waiting",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "stopped",
    "refused",
    "limited"
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** What made a run fire, as stored beside it. */
export interface RunCause {
    readonly kind: TriggerKind | "automation";
    readonly triggerId?: string;
    readonly deviceId?: string;
    readonly attribute?: AutomationAttribute;
    /** Which of a purifier's figures crossed, for a threshold on one. */
    readonly measure?: ReadingMeasure;
    readonly from?: string;
    readonly to?: string;
    readonly minutes?: number;
    readonly value?: string;
    /** The automation that started this one, for a run started by a step. */
    readonly byAutomationId?: string;
    readonly byName?: string;
    /** Who pressed Run now. */
    readonly byUser?: string;
    /** Which sun event, for a sun trigger. */
    readonly event?: string;
    readonly at: string;
}

export const STEP_OUTCOMES = ["ok", "failed", "refused", "timedOut", "waiting", "skipped"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** One step reached in one run. `code` is a key under `automations.notes`;
 *  `said` is a refusal Places wrote, in English, for `placesRefusalText`. */
export interface StepLog {
    readonly stepId: string;
    readonly kind: StepKind | "conditions";
    readonly outcome: StepOutcome;
    readonly code?: string;
    readonly said?: string;
    readonly at: string;
}

export interface RunView {
    readonly id: string;
    readonly automationId: string;
    readonly status: RunStatus;
    readonly cause: RunCause;
    readonly steps: readonly StepLog[];
    readonly reason: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly dueAt: string | null;
}

export interface AutomationView {
    readonly id: string;
    readonly placeId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly ownerName: string;
    readonly definition: AutomationDefinition;
    readonly lastRunAt: string | null;
    readonly lastStatus: RunStatus | null;
    readonly updatedAt: string;
    /** The automation it became on the central engine, once moved; its screen is there. */
    readonly movedTo?: string | null;
}

/** The automations list, narrowed to Places' and - given one - to one place. */
export function placesAutomationsHref(placeId?: string | null): string {
    // "home" is Places' app id, the origin its automations carry centrally.
    return automationsListHref("home", placeId);
}

/** A new automation, at a place when the screen it was started from names one. */
export function newAutomationHref(placeId?: string | null, template?: string): string {
    const query = new URLSearchParams();
    if (template) query.set("template", template);
    if (placeId) query.set("place", placeId);
    const rest = query.toString();
    return `/places/devices/automations/new${rest ? `?${rest}` : ""}`;
}

/** Where an automation's screen is: the central one once it moved, else here. */
export function automationHref(
    automation: { readonly id: string; readonly movedTo?: string | null },
    tab?: "runs"
): string {
    if (automation.movedTo) {
        return tab === "runs"
            ? `/automations/runs?automation=${automation.movedTo}`
            : `/automations/${automation.movedTo}`;
    }
    return `/places/devices/automations/${automation.id}${tab === "runs" ? "?tab=runs" : ""}`;
}

export function runStatus(value: string | null | undefined): RunStatus | null {
    return value && (RUN_STATUSES as readonly string[]).includes(value)
        ? (value as RunStatus)
        : null;
}

/** Whether a run has finished, one way or another. */
export function runFinished(status: RunStatus): boolean {
    return status !== "queued" && status !== "waiting" && status !== "running";
}

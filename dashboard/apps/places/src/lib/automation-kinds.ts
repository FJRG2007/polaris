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
import { isTimeZone } from "@polaris/core";
import type { DeviceAction, DeviceKind, DeviceView } from "./device-kinds";

/** What about a device a trigger, a condition or a wait looks at. A lock has a
 *  bolt and often a door sensor beside it, and "the door opened" is not "the
 *  lock opened"; a sensor has neither and is its reading. */
export const AUTOMATION_ATTRIBUTES = ["state", "door", "reading"] as const;
export type AutomationAttribute = (typeof AUTOMATION_ATTRIBUTES)[number];

/** The door sensor's words that can be waited for. `unknown` and `none` are not
 *  something a door does. */
export const DOOR_WORDS = ["open", "closed"] as const;

/** The states worth reacting to, per kind. `moving` is a lock on its way
 *  somewhere and never where anybody wants it to be; `unknown` is silence. */
const WATCHED_STATES: Readonly<Record<DeviceKind, readonly kinds.DeviceState[]>> = {
    lock: ["locked", "unlocked", "unlatched", "jammed"],
    opener: ["locked", "unlatched"],
    climate: ["on", "off"],
    switch: ["on", "off"],
    outlet: ["on", "off"],
    light: ["on", "off"],
    sensor: []
};

export function watchedStates(kind: string): readonly kinds.DeviceState[] {
    return WATCHED_STATES[kinds.deviceKind(kind)];
}

/** Which attributes a kind of device has to watch. */
export function attributesFor(kind: string): readonly AutomationAttribute[] {
    const which = kinds.deviceKind(kind);
    if (which === "sensor") return ["reading"];
    if (which === "lock" || which === "opener") return ["state", "door"];
    return ["state"];
}

/** A step may flip something rather than name where it should end up. Only for
 *  the things with two ends: a lock that is jammed has no "other" state. */
export const TOGGLE = "toggle";
export const STEP_DEVICE_ACTIONS = [...kinds.DEVICE_ACTIONS, TOGGLE] as const;
export type StepDeviceAction = (typeof STEP_DEVICE_ACTIONS)[number];

export function stepActionsFor(kind: string): readonly StepDeviceAction[] {
    const own = kinds.actionsFor(kind);
    return own.includes("turn-on") && own.includes("turn-off") ? [...own, TOGGLE] : own;
}

/** The two-state words sensors send, in pairs, so a picker can offer the other
 *  half of whatever one is reading now. */
export const READING_PAIRS: readonly (readonly [string, string])[] = [
    ["Open", "Closed"],
    ["Locked", "Unlocked"],
    ["Movement", "Still"],
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
    word: 60
} as const;

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export const COMPARISONS = ["gt", "gte", "lt", "lte", "eq", "ne"] as const;
export type Comparison = (typeof COMPARISONS)[number];

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
function count(min: number, max: number) {
    return z
        .number({
            required_error: "automations.errors.number",
            invalid_type_error: "automations.errors.number"
        })
        .int("automations.errors.whole")
        .min(min, "automations.errors.tooSmall")
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

export const triggerSchema = z.discriminatedUnion("kind", [
    z.object({ id: nodeId, kind: z.literal("time"), at: clock, days }),
    z.object({ id: nodeId, kind: z.literal("interval"), minutes: count(1, LIMITS.minutes) }),
    z.object({
        id: nodeId,
        kind: z.literal("change"),
        deviceId: deviceRef,
        attribute,
        from: word,
        to: word
    }),
    z.object({
        id: nodeId,
        kind: z.literal("stays"),
        deviceId: deviceRef,
        attribute,
        is: needed,
        minutes: count(1, LIMITS.minutes)
    }),
    z.object({
        id: nodeId,
        kind: z.literal("threshold"),
        deviceId: deviceRef,
        direction: z.enum(["above", "below"]),
        value: amount
    }),
    z.object({ id: nodeId, kind: z.literal("manual") })
]);

export const conditionSchema = z.discriminatedUnion("kind", [
    z.object({
        id: nodeId,
        kind: z.literal("device"),
        deviceId: deviceRef,
        attribute,
        is: needed,
        negate: z.boolean()
    }),
    z.object({
        id: nodeId,
        kind: z.literal("reading"),
        deviceId: deviceRef,
        op: z.enum(COMPARISONS),
        value: amount
    }),
    z.object({ id: nodeId, kind: z.literal("time"), from: clock, to: clock }),
    z.object({ id: nodeId, kind: z.literal("weekday"), days })
]);

const match = z.enum(["all", "any"]);

export const conditionGroupSchema = z.object({
    id: nodeId,
    match,
    items: z
        .array(conditionSchema)
        .min(1, "automations.errors.emptyGroup")
        .max(LIMITS.conditionsPerGroup, "automations.errors.tooMany")
});

export const actionSchema = z.discriminatedUnion("kind", [
    z.object({
        id: nodeId,
        kind: z.literal("device"),
        deviceId: deviceRef,
        do: z.enum(STEP_DEVICE_ACTIONS, {
            errorMap: () => ({ message: "automations.errors.action" })
        })
    }),
    z.object({ id: nodeId, kind: z.literal("delay"), seconds: count(1, LIMITS.delaySeconds) }),
    z.object({
        id: nodeId,
        kind: z.literal("wait"),
        deviceId: deviceRef,
        attribute,
        is: needed,
        timeoutMinutes: count(1, LIMITS.waitMinutes),
        onTimeout: z.enum(["stop", "continue"])
    }),
    z.object({
        id: nodeId,
        kind: z.literal("notify"),
        message: z
            .string()
            .min(1, "automations.errors.message")
            .max(LIMITS.message, "automations.errors.tooLong")
    }),
    z.object({
        id: nodeId,
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
        });

        definition.conditions.groups.forEach((group, index) =>
            group.items.forEach((condition, item) => {
                const at = ["conditions", "groups", index, "items", item];
                if (condition.kind === "device") {
                    checkWord(context, condition.attribute, condition.is, [...at, "is"], false);
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
        });
    });

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
    "interval",
    "manual"
];
export const CONDITION_KINDS: readonly ConditionKind[] = ["device", "reading", "time", "weekday"];
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

const NUMBER_FIELDS = ["minutes", "value", "seconds", "timeoutMinutes"];
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
export type AutomationDevice = Pick<DeviceView, "id" | "kind" | "name" | "controllable">;

/**
 * What the schema cannot know: whether the devices named are here, and whether
 * each can do what it is asked. The editor runs it on the devices it drew, the
 * server on the devices the place has - so a device removed while the editor was
 * open is caught at the save.
 */
export function deviceIssues(
    definition: AutomationDefinition,
    devices: readonly AutomationDevice[],
    context: { readonly automationIds: readonly string[]; readonly selfId: string | null }
): AutomationIssue[] {
    const byId = new Map(devices.map((device) => [device.id, device]));
    const issues: AutomationIssue[] = [];

    const watched = (deviceId: string, which: AutomationAttribute, path: (string | number)[]) => {
        const device = byId.get(deviceId);
        if (!device) {
            issues.push({ path: [...path, "deviceId"], message: "automations.errors.deviceGone" });
            return;
        }
        if (!attributesFor(device.kind).includes(which)) {
            issues.push({ path: [...path, "attribute"], message: "automations.errors.attribute" });
        }
    };
    const sensor = (deviceId: string, path: (string | number)[]) => {
        const device = byId.get(deviceId);
        if (!device)
            issues.push({ path: [...path, "deviceId"], message: "automations.errors.deviceGone" });
        else if (kinds.deviceKind(device.kind) !== "sensor") {
            issues.push({ path: [...path, "deviceId"], message: "automations.errors.notSensor" });
        }
    };

    definition.triggers.forEach((trigger, index) => {
        const at = ["definition", "triggers", index];
        if (trigger.kind === "change" || trigger.kind === "stays") {
            watched(trigger.deviceId, trigger.attribute, at);
        }
        if (trigger.kind === "threshold") sensor(trigger.deviceId, at);
    });
    definition.conditions.groups.forEach((group, index) =>
        group.items.forEach((condition, item) => {
            const at = ["definition", "conditions", "groups", index, "items", item];
            if (condition.kind === "device") watched(condition.deviceId, condition.attribute, at);
            if (condition.kind === "reading") sensor(condition.deviceId, at);
        })
    );
    definition.actions.forEach((step, index) => {
        const at = ["definition", "actions", index];
        if (step.kind === "wait") watched(step.deviceId, step.attribute, at);
        if (step.kind === "device") {
            const device = byId.get(step.deviceId);
            if (!device) {
                issues.push({
                    path: [...at, "deviceId"],
                    message: "automations.errors.deviceGone"
                });
            } else if (!device.controllable) {
                issues.push({ path: [...at, "deviceId"], message: "automations.errors.watchOnly" });
            } else if (!stepActionsFor(device.kind).includes(step.do)) {
                issues.push({ path: [...at, "do"], message: "automations.errors.cannotDo" });
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

// --- building blocks ---------------------------------------------------------

/** A short random id for a node, unique within one automation. Not a uuid: the
 *  editor may run on a plain-http address where `crypto.randomUUID` does not
 *  exist, and nothing outside one automation compares these. */
export function nodeIdOf(): string {
    return Math.random().toString(36).slice(2, 12).padEnd(6, "0");
}

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
    if (which === "switch" || which === "outlet" || which === "light")
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
    readonly from?: string;
    readonly to?: string;
    readonly minutes?: number;
    readonly value?: string;
    /** The automation that started this one, for a run started by a step. */
    readonly byAutomationId?: string;
    readonly byName?: string;
    /** Who pressed Run now. */
    readonly byUser?: string;
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

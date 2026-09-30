/**
 * What an automation has to look like, as the editor and the server both check it.
 *
 * One schema and one normalizer on both sides of the wire, so these hold the
 * editor to exactly what the server stores: times written one way, numbers that
 * arrive as text, the states a kind of device can actually be in, and the
 * device checks the schema cannot make on its own.
 */

import { describe, expect, it } from "vitest";
import { placesCatalogs } from "@polaris-app/places/messages";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import * as words from "@polaris-app/places/src/lib/automation-words";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";

function device(id: string, kind: string, extra: Partial<DeviceView> = {}): DeviceView {
    return {
        id,
        vendor: "fixture",
        kind,
        name: `Fixture ${kind} ${id}`,
        zone: "",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...extra
    };
}

const DEVICES = [
    device("plug", "outlet"),
    device("lock", "lock", { state: "locked", doorState: "closed" }),
    device("temp", "sensor", { reading: { value: "21.5", unit: "C" } }),
    device("watched", "switch", { controllable: false })
];

function input(definition: Partial<auto.AutomationDefinition>): unknown {
    return {
        name: "  Fixture automation  ",
        enabled: true,
        placeId: "place-1",
        definition: {
            timeZone: "Europe/Madrid",
            triggers: [{ id: "trig01", kind: "manual" }],
            conditions: { match: "all", groups: [] },
            actions: [{ id: "step01", kind: "device", deviceId: "plug", do: "turn-off" }],
            ...definition
        }
    };
}

function parse(value: unknown) {
    return auto.automationInputSchema.safeParse(auto.normalizeAutomationInput(value));
}

function messages(value: unknown): string[] {
    const parsed = parse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("normalizing an automation", () => {
    it("trims, writes times one way, turns numeric text into numbers and sorts days", () => {
        const parsed = parse(
            input({
                triggers: [
                    { id: "trig01", kind: "time", at: " 7:05 ", days: [5, 1, 1, "3"] as unknown as number[] },
                    { id: "trig02", kind: "interval", minutes: "15" as unknown as number }
                ]
            })
        );
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.name).toBe("Fixture automation");
        expect(parsed.data.definition.triggers[0]).toMatchObject({ at: "07:05", days: [1, 3, 5] });
        expect(parsed.data.definition.triggers[1]).toMatchObject({ minutes: 15 });
    });

    it("leaves an emptied number missing rather than zero", () => {
        expect(messages(input({ triggers: [{ id: "trig01", kind: "interval", minutes: "" as unknown as number }] }))).toEqual([
            "automations.errors.number"
        ]);
    });

    it("does not read a change's from and to as times", () => {
        const parsed = parse(
            input({
                triggers: [{ id: "trig01", kind: "change", deviceId: "plug", attribute: "state", from: " off ", to: "on" }]
            })
        );
        expect(parsed.success && parsed.data.definition.triggers[0]).toMatchObject({ from: "off", to: "on" });
    });
});

describe("the schema", () => {
    it("takes a whole automation", () => {
        expect(messages(input({}))).toEqual([]);
    });

    it("needs a name, a trigger and a step, each said by key", () => {
        expect(messages({ ...(input({ triggers: [], actions: [] }) as object), name: " " })).toEqual(
            expect.arrayContaining(["automations.errors.name", "automations.errors.noTrigger", "automations.errors.noStep"])
        );
    });

    it("refuses a time that is not a time, and a time with no days", () => {
        expect(messages(input({ triggers: [{ id: "trig01", kind: "time", at: "25:00", days: [1] }] }))).toEqual([
            "automations.errors.time"
        ]);
        expect(messages(input({ triggers: [{ id: "trig01", kind: "time", at: "07:00", days: [] }] }))).toEqual([
            "automations.errors.days"
        ]);
    });

    it("never takes 'auto' as the zone, since the server has no browser to ask", () => {
        expect(messages(input({ timeZone: "auto" }))).toEqual(["automations.errors.timeZone"]);
        expect(messages(input({ timeZone: "Mars/Olympus" }))).toEqual(["automations.errors.timeZone"]);
    });

    it("only takes the states this app knows for a state or a door", () => {
        expect(
            messages(input({ triggers: [{ id: "trig01", kind: "stays", deviceId: "plug", attribute: "state", is: "glowing", minutes: 30 }] }))
        ).toEqual(["automations.errors.state"]);
        expect(
            messages(input({ triggers: [{ id: "trig01", kind: "change", deviceId: "lock", attribute: "door", from: "", to: "ajar" }] }))
        ).toEqual(["automations.errors.state"]);
    });

    it("takes any word for a sensor's reading", () => {
        expect(
            messages(input({ triggers: [{ id: "trig01", kind: "change", deviceId: "temp", attribute: "reading", from: "", to: "Somebody there" }] }))
        ).toEqual([]);
    });

    it("refuses a change from a state to the same state", () => {
        expect(
            messages(input({ triggers: [{ id: "trig01", kind: "change", deviceId: "plug", attribute: "state", from: "on", to: "on" }] }))
        ).toEqual(["automations.errors.sameState"]);
    });

    it("refuses two cards with the same id", () => {
        expect(
            messages(input({ actions: [
                { id: "same01", kind: "delay", seconds: 5 },
                { id: "same01", kind: "delay", seconds: 5 }
            ] }))
        ).toEqual(["automations.errors.broken"]);
    });

    it("bounds a delay to a week and a wait to a day", () => {
        expect(messages(input({ actions: [{ id: "step01", kind: "delay", seconds: 8 * 24 * 3600 }] }))).toEqual([
            "automations.errors.tooBig"
        ]);
        expect(
            messages(
                input({
                    actions: [
                        {
                            id: "step01",
                            kind: "wait",
                            deviceId: "lock",
                            attribute: "door",
                            is: "closed",
                            timeoutMinutes: 2000,
                            onTimeout: "stop"
                        }
                    ]
                })
            )
        ).toEqual(["automations.errors.tooBig"]);
    });

    it("refuses a condition window that starts when it ends", () => {
        expect(
            messages(
                input({
                    conditions: {
                        match: "all",
                        groups: [{ id: "group1", match: "all", items: [{ id: "cond01", kind: "time", from: "22:00", to: "22:00" }] }]
                    }
                })
            )
        ).toEqual(["automations.errors.sameTime"]);
    });

    it("refuses an empty condition group", () => {
        expect(messages(input({ conditions: { match: "any", groups: [{ id: "group1", match: "all", items: [] }] } }))).toEqual([
            "automations.errors.emptyGroup"
        ]);
    });
});

describe("the checks against the place's devices", () => {
    function issues(definition: Partial<auto.AutomationDefinition>, selfId: string | null = null) {
        const parsed = parse(input(definition));
        if (!parsed.success) throw new Error(parsed.error.message);
        return auto.deviceIssues(parsed.data.definition, DEVICES, { automationIds: ["other"], selfId }).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
        }));
    }

    it("names a device that is not at the place, where it is named", () => {
        expect(issues({ actions: [{ id: "step01", kind: "device", deviceId: "gone", do: "turn-on" }] })).toEqual([
            { path: "definition.actions.0.deviceId", message: "automations.errors.deviceGone" }
        ]);
    });

    it("refuses a step a device cannot do, and one on a device off the controls", () => {
        expect(issues({ actions: [{ id: "step01", kind: "device", deviceId: "lock", do: "turn-on" }] })).toEqual([
            { path: "definition.actions.0.do", message: "automations.errors.cannotDo" }
        ]);
        expect(issues({ actions: [{ id: "step01", kind: "device", deviceId: "watched", do: "turn-on" }] })).toEqual([
            { path: "definition.actions.0.deviceId", message: "automations.errors.watchOnly" }
        ]);
    });

    it("offers toggle only on the things with two ends", () => {
        expect(auto.stepActionsFor("outlet")).toContain("toggle");
        expect(auto.stepActionsFor("lock")).not.toContain("toggle");
        expect(issues({ actions: [{ id: "step01", kind: "device", deviceId: "lock", do: "toggle" }] })).toHaveLength(1);
    });

    it("keeps a threshold to sensors, and a door to devices that have one", () => {
        expect(issues({ triggers: [{ id: "trig01", kind: "threshold", deviceId: "plug", direction: "above", value: 3 }] })).toEqual([
            { path: "definition.triggers.0.deviceId", message: "automations.errors.notSensor" }
        ]);
        expect(
            issues({ triggers: [{ id: "trig01", kind: "change", deviceId: "plug", attribute: "door", from: "", to: "open" }] })
        ).toEqual([{ path: "definition.triggers.0.attribute", message: "automations.errors.attribute" }]);
    });

    it("refuses a step that runs the automation itself or one that is gone", () => {
        expect(issues({ actions: [{ id: "step01", kind: "run", automationId: "self" }] }, "self")).toEqual([
            { path: "definition.actions.0.automationId", message: "automations.errors.runSelf" }
        ]);
        expect(issues({ actions: [{ id: "step01", kind: "run", automationId: "missing" }] })).toEqual([
            { path: "definition.actions.0.automationId", message: "automations.errors.automationGone" }
        ]);
        expect(issues({ actions: [{ id: "step01", kind: "run", automationId: "other" }] })).toEqual([]);
    });
});

describe("the templates", () => {
    it("writes 'turn off after X minutes on' as one trigger and one step", () => {
        const definition = auto.autoOffDefinition({ id: "plug", kind: "outlet" }, 30, "Europe/Madrid");
        expect(definition?.triggers).toEqual([
            expect.objectContaining({ kind: "stays", deviceId: "plug", attribute: "state", is: "on", minutes: 30 })
        ]);
        expect(definition?.actions).toEqual([expect.objectContaining({ kind: "device", deviceId: "plug", do: "turn-off" })]);
        expect(parse(input(definition ?? {})).success).toBe(true);
    });

    it("locks a lock left unlocked, and has nothing for a sensor", () => {
        expect(auto.autoOffPlan("lock")).toEqual({ is: "unlocked", do: "lock" });
        expect(auto.autoOffDefinition({ id: "temp", kind: "sensor" }, 30, "UTC")).toBeNull();
    });

    it("schedules on and off as on, a delay of the gap, and off - across midnight too", () => {
        const definition = auto.scheduleDefinition("plug", "22:00", "06:30", [1, 2, 3, 4, 5], "UTC");
        expect(definition.actions.map((step) => step.kind)).toEqual(["device", "delay", "device"]);
        expect(definition.actions[1]).toMatchObject({ seconds: (8 * 60 + 30) * 60 });
        expect(parse(input(definition)).success).toBe(true);
    });

    it("says 'every day', 'weekdays' and the names of the rest", () => {
        const en = placesCatalogs.translator("en-US", "places");
        expect(words.daysText([0, 1, 2, 3, 4, 5, 6], en)).toBe("every day");
        expect(words.daysText([1, 2, 3, 4, 5], en)).toBe("weekdays");
        expect(words.daysText([0, 1], en)).toBe("Mon, Sun");
    });

    it("words each node in both languages", () => {
        const lookup: words.DeviceLookup = (id) => DEVICES.find((entry) => entry.id === id);
        const en = placesCatalogs.translator("en-US", "places");
        const es = placesCatalogs.translator("es-ES", "places");
        const trigger: auto.Trigger = { id: "trig01", kind: "stays", deviceId: "plug", attribute: "state", is: "on", minutes: 30 };
        expect(words.describeTrigger(trigger, lookup, en)).toBe("Fixture outlet plug is On for 30 minutes");
        expect(words.describeTrigger(trigger, lookup, es)).toContain("30 minutos");
        expect(words.issueText("automations.errors.device", es)).toBe("Elige un dispositivo.");
        // Zod's own English never reaches a screen.
        expect(words.issueText("Expected string, received number", en)).toBe(en("automations.errors.broken"));
    });
});

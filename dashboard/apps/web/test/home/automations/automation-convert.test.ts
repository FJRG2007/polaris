/**
 * A Places automation as a central graph: every block of the Places
 * vocabulary converts, keeps its id and its meaning, and the graph it makes is
 * one the central engine would publish.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as nodes from "@polaris-app/places/src/lib/automation-nodes";
import * as convert from "@polaris-app/places/src/lib/automation-convert";

const PLACE = "11111111-1111-4111-8111-111111111111";

interface Parts {
    triggers?: unknown[];
    groups?: unknown[];
    match?: string;
    actions?: unknown[];
}

function definition(parts: Parts) {
    return {
        timeZone: "Europe/Madrid",
        triggers: parts.triggers ?? [{ id: "trig01", kind: "manual" }],
        conditions: { match: parts.match ?? "all", groups: parts.groups ?? [] },
        actions: parts.actions ?? [
            { id: "step01", kind: "device", deviceId: "plug", do: "turn-off" }
        ]
    };
}

function converted(parts: Parts) {
    const result = convert.convertPlaceAutomation({
        id: "legacy",
        placeId: PLACE,
        definition: definition(parts)
    });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(core.graphProblems(result.graph, { forPublish: true })).toEqual([]);
    return result.graph;
}

const ROOM_SET = [
    { kind: "device", id: "plug" },
    { kind: "room", id: "room-1" },
    { kind: "floor", id: "floor-1" }
];

const TRIGGERS: { name: string; trigger: Record<string, unknown> }[] = [
    { name: "time", trigger: { id: "trig01", kind: "time", at: "07:30", days: [1, 2, 3, 4, 5] } },
    { name: "interval", trigger: { id: "trig01", kind: "interval", minutes: 15 } },
    {
        name: "change",
        trigger: {
            id: "trig01",
            kind: "change",
            deviceId: "plug",
            attribute: "state",
            from: "off",
            to: "on"
        }
    },
    {
        name: "change any to any",
        trigger: {
            id: "trig01",
            kind: "change",
            deviceId: "plug",
            attribute: "state",
            from: "",
            to: ""
        }
    },
    {
        name: "change held for, on rooms and floors, first",
        trigger: {
            id: "trig01",
            kind: "change",
            deviceId: "plug",
            targets: ROOM_SET,
            behaviour: "first",
            attribute: "door",
            from: "closed",
            to: "open",
            forMinutes: 5
        }
    },
    {
        name: "stays",
        trigger: {
            id: "trig01",
            kind: "stays",
            deviceId: "plug",
            targets: ROOM_SET,
            behaviour: "all",
            attribute: "state",
            is: "on",
            minutes: 30
        }
    },
    ...(["above", "below"] as const).map((direction) => ({
        name: `threshold ${direction}`,
        trigger: { id: "trig01", kind: "threshold", deviceId: "temp", direction, value: 25 }
    })),
    ...(["between", "outside"] as const).map((direction) => ({
        name: `threshold ${direction}`,
        trigger: {
            id: "trig01",
            kind: "threshold",
            deviceId: "temp",
            behaviour: "each",
            direction,
            value: 18,
            upper: 24,
            forMinutes: 10
        }
    })),
    {
        name: "threshold with a measure",
        trigger: {
            id: "trig01",
            kind: "threshold",
            deviceId: "air",
            direction: "above",
            value: 50,
            measure: "pm25"
        }
    },
    { name: "sun", trigger: { id: "trig01", kind: "sun", event: "sunset" } },
    {
        name: "sun with an offset",
        trigger: {
            id: "trig01",
            kind: "sun",
            event: "dawn",
            offset: { amount: 20, unit: "minutes", direction: "before" }
        }
    }
];

describe("convertPlaceAutomation: triggers", () => {
    it.each(TRIGGERS)("$name keeps its id and its whole block", ({ trigger }) => {
        const graph = converted({ triggers: [trigger] });
        const node = graph.nodes.find((each) => each.id === "trig01")!;
        const kind = trigger.kind as nodes.TriggerNodeKind;
        expect(node.type).toBe(nodes.triggerNodeType(kind));
        const { id: _id, ...rest } = trigger;
        expect(node.config).toEqual({ ...rest, placeId: PLACE });
        expect(nodes.triggerOfNode(node.id, node.config)).toEqual(trigger);
        expect(nodes.triggerNodeConfig(kind).safeParse(node.config).success).toBe(true);
        expect(core.nodeRole(node.type)).toBe("trigger");
    });

    it("manual becomes the central manual trigger", () => {
        const graph = converted({});
        expect(graph.nodes[0]).toMatchObject({ id: "trig01", type: "core.manual" });
    });

    it("keeps an alias and a note on the node, not in its config", () => {
        const graph = converted({
            triggers: [
                { id: "trig01", kind: "interval", minutes: 5, alias: "Every five", note: "Why" }
            ]
        });
        expect(graph.nodes[0]).toMatchObject({ alias: "Every five", note: "Why" });
        expect(graph.nodes[0]!.config).toEqual({ kind: "interval", minutes: 5, placeId: PLACE });
    });

    it("wires every trigger to the first block", () => {
        const graph = converted({
            triggers: [
                { id: "trig01", kind: "manual" },
                { id: "trig02", kind: "interval", minutes: 5 }
            ]
        });
        const into = graph.edges
            .filter((edge) => edge.to.node === "step01")
            .map((edge) => edge.from.node);
        expect(into.sort()).toEqual(["trig01", "trig02"]);
    });
});

const CONDITIONS: Record<string, unknown>[] = [
    { id: "cond01", kind: "device", deviceId: "plug", attribute: "state", is: "on", negate: false },
    {
        id: "cond02",
        kind: "device",
        deviceId: "plug",
        targets: ROOM_SET,
        quantifier: "all",
        attribute: "state",
        is: "off",
        negate: true,
        forMinutes: 3
    },
    { id: "cond03", kind: "reading", deviceId: "temp", op: "gt", value: 20 },
    {
        id: "cond04",
        kind: "reading",
        deviceId: "temp",
        targets: [{ kind: "room", id: "room-1" }],
        quantifier: "any",
        op: "between",
        value: 18,
        upper: 24,
        forMinutes: 2
    },
    { id: "cond05", kind: "reading", deviceId: "air", op: "lte", value: 30, measure: "pm25" },
    { id: "cond06", kind: "time", from: "22:00", to: "06:00" },
    { id: "cond07", kind: "weekday", days: [0, 6] },
    {
        id: "cond08",
        kind: "sun",
        after: { event: "sunset" },
        before: { event: "sunrise", offset: { amount: 1, unit: "hours", direction: "after" } }
    },
    { id: "cond09", kind: "triggeredBy", triggerIds: ["trig01"] }
];

describe("convertPlaceAutomation: conditions", () => {
    it("puts every condition kind, groups and all, into one node in front of the steps", () => {
        const groups = [
            { id: "grp001", match: "any", items: CONDITIONS.slice(0, 5) },
            { id: "grp002", match: "all", alias: "Night", items: CONDITIONS.slice(5) }
        ];
        const graph = converted({ groups, match: "any" });
        const node = graph.nodes.find((each) => each.type === nodes.CONDITION_NODE_TYPE)!;
        expect(node.id).toBe("grp001");
        expect(node.config).toEqual({ placeId: PLACE, match: "any", groups });
        expect(nodes.conditionNodeConfig.safeParse(node.config).success).toBe(true);
        expect(core.nodeRole(node.type)).toBe("condition");
        expect(graph.edges).toContainEqual({
            from: { node: "trig01", port: "next" },
            to: { node: "grp001" }
        });
        expect(graph.edges).toContainEqual({
            from: { node: "grp001", port: "then" },
            to: { node: "step01" }
        });
        expect(graph.edges.some((edge) => edge.from.port === "else")).toBe(false);
    });

    it("a definition with no conditions goes straight to the steps", () => {
        const graph = converted({});
        expect(graph.nodes.some((each) => each.type === nodes.CONDITION_NODE_TYPE)).toBe(false);
        expect(graph.edges).toEqual([
            { from: { node: "trig01", port: "next" }, to: { node: "step01" } }
        ]);
    });
});

const STEPS: { name: string; step: Record<string, unknown> }[] = [
    ...["lock", "unlock", "unlatch", "turn-on", "turn-off", "stop", "toggle"].map((action) => ({
        name: `device ${action}`,
        step: { id: "step01", kind: "device", deviceId: "plug", do: action }
    })),
    {
        name: "device on a set",
        step: { id: "step01", kind: "device", deviceId: "plug", targets: ROOM_SET, do: "turn-on" }
    },
    {
        name: "set the mode",
        step: {
            id: "step01",
            kind: "device",
            deviceId: "ac",
            do: "set-mode",
            setting: { action: "set-mode", mode: "cool" }
        }
    },
    {
        name: "set the temperature",
        step: {
            id: "step01",
            kind: "device",
            deviceId: "ac",
            do: "set-temperature",
            setting: { action: "set-temperature", target: 22 }
        }
    },
    {
        name: "set the fan",
        step: {
            id: "step01",
            kind: "device",
            deviceId: "ac",
            do: "set-fan",
            setting: { action: "set-fan", fan: "auto" }
        }
    },
    {
        name: "set an option",
        step: {
            id: "step01",
            kind: "device",
            deviceId: "ac",
            do: "set-option",
            setting: { action: "set-option", option: "eco", on: true }
        }
    },
    {
        name: "set the humidity",
        step: {
            id: "step01",
            kind: "device",
            deviceId: "air",
            do: "set-humidity",
            setting: { action: "set-humidity", target: 45 }
        }
    },
    {
        name: "wait, stop on timeout",
        step: {
            id: "step01",
            kind: "wait",
            deviceId: "plug",
            attribute: "state",
            is: "on",
            timeoutMinutes: 10,
            onTimeout: "stop"
        }
    },
    {
        name: "wait any, continue on timeout",
        step: {
            id: "step01",
            kind: "wait",
            deviceId: "plug",
            targets: ROOM_SET,
            quantifier: "any",
            attribute: "state",
            is: "off",
            timeoutMinutes: 10,
            onTimeout: "continue"
        }
    },
    {
        name: "wait all",
        step: {
            id: "step01",
            kind: "wait",
            deviceId: "plug",
            targets: ROOM_SET,
            quantifier: "all",
            attribute: "door",
            is: "closed",
            timeoutMinutes: 60,
            onTimeout: "stop"
        }
    },
    { name: "notify", step: { id: "step01", kind: "notify", message: "The door is open" } },
    {
        name: "run another",
        step: { id: "step01", kind: "run", automationId: "22222222-2222-4222-8222-222222222222" }
    }
];

describe("convertPlaceAutomation: steps", () => {
    it.each(STEPS)("$name keeps its id and its whole block", ({ step }) => {
        const graph = converted({ actions: [step] });
        const node = graph.nodes.find((each) => each.id === "step01")!;
        const kind = step.kind as nodes.StepNodeKind;
        expect(node.type).toBe(nodes.stepNodeType(kind));
        const { id: _id, ...rest } = step;
        expect(node.config).toEqual({ ...rest, placeId: PLACE });
        expect(nodes.stepOfNode(node.id, node.config)).toEqual(step);
        expect(nodes.stepNodeConfig(kind).safeParse(node.config).success).toBe(true);
        expect(core.nodeRole(node.type)).toBe("action");
    });

    it("a delay becomes the central wait for the same time", () => {
        const graph = converted({ actions: [{ id: "step01", kind: "delay", seconds: 7200 }] });
        expect(graph.nodes[1]).toMatchObject({
            id: "step01",
            type: "core.wait",
            config: { kind: "duration", duration: { amount: 2, unit: "hours" } }
        });
    });

    it("chains the steps in their order", () => {
        const graph = converted({
            actions: [
                { id: "step01", kind: "notify", message: "One" },
                { id: "step02", kind: "delay", seconds: 30 },
                { id: "step03", kind: "notify", message: "Two" }
            ]
        });
        expect(graph.edges).toEqual([
            { from: { node: "trig01", port: "next" }, to: { node: "step01" } },
            { from: { node: "step01", port: "next" }, to: { node: "step02" } },
            { from: { node: "step02", port: "next" }, to: { node: "step03" } }
        ]);
    });
});

describe("convertPlaceAutomation: refusals and older shapes", () => {
    it("reads a block stored before sets existed (no targets)", () => {
        const graph = converted({
            triggers: [
                {
                    id: "trig01",
                    kind: "change",
                    deviceId: "plug",
                    attribute: "state",
                    from: "",
                    to: "on"
                }
            ]
        });
        expect(graph.nodes[0]!.config).not.toHaveProperty("targets");
    });

    it("refuses a definition the Places engine could not have run", () => {
        expect(
            convert.convertPlaceAutomation({
                id: "x",
                placeId: PLACE,
                definition: { triggers: [] }
            })
        ).toEqual({
            ok: false,
            reason: "unreadable"
        });
        expect(
            convert.convertPlaceAutomation({ id: "x", placeId: PLACE, definition: null })
        ).toEqual({
            ok: false,
            reason: "unreadable"
        });
    });
});

describe("draftGraph", () => {
    it("lays out a template whose blocks are not filled in yet, for the central editor to finish", () => {
        const graph = convert.draftGraph(
            PLACE,
            definition({
                triggers: [{ id: "trig01", kind: "stays", is: "on" }],
                actions: [{ id: "step01", kind: "device" }]
            })
        );
        expect(graph).not.toBeNull();
        expect(graph!.nodes.map((entry) => entry.id)).toEqual(["trig01", "step01"]);
        expect(graph!.edges).toEqual([
            { from: { node: "trig01", port: "next" }, to: { node: "step01" } }
        ]);
        expect(graph!.nodes[1]!.config).toMatchObject({ placeId: PLACE });
    });

    it("lays out a finished one exactly as a saved one converts", () => {
        const parts = {};
        expect(convert.draftGraph(PLACE, definition(parts))).toEqual(converted(parts));
    });

    it("answers null for what is not a Places definition, or names a kind it does not have", () => {
        expect(convert.draftGraph(PLACE, null)).toBeNull();
        expect(convert.draftGraph(PLACE, { triggers: "x" })).toBeNull();
        expect(
            convert.draftGraph(PLACE, definition({ triggers: [{ id: "t", kind: "explode" }] }))
        ).toBeNull();
    });
});

/**
 * An automation drawn as a graph and read back.
 *
 * The canvas edits the stored definition through this and nothing else, so the
 * one thing it may never do is change an automation nobody touched: every kind
 * of trigger, condition and step has to come back as the very JSON it went in
 * as. What a drag does change - the order of a list - is read from where the
 * nodes stand, top to bottom, and nothing more.
 */

import { describe, expect, it } from "vitest";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import * as graphs from "@polaris-app/places/src/lib/automation-graph";

/** One of everything the schema has, with the optional fields both ways. */
const EVERYTHING: auto.AutomationDefinition = {
    timeZone: "Europe/Madrid",
    triggers: [
        { id: "trtime01", kind: "time", at: "07:30", days: [1, 2, 3, 4, 5] },
        { id: "trintv01", kind: "interval", minutes: 15 },
        {
            id: "trchng01",
            kind: "change",
            deviceId: "lock",
            attribute: "door",
            from: "closed",
            to: "open"
        },
        {
            id: "trstay01",
            kind: "stays",
            deviceId: "plug",
            attribute: "state",
            is: "on",
            minutes: 30
        },
        {
            id: "trthrs01",
            kind: "threshold",
            deviceId: "air",
            direction: "above",
            value: 35,
            measure: "pm25"
        },
        { id: "trthrs02", kind: "threshold", deviceId: "sensor", direction: "below", value: -4.5 },
        { id: "trmanu01", kind: "manual" }
    ],
    conditions: {
        match: "any",
        groups: [
            {
                id: "group001",
                match: "any",
                items: [
                    {
                        id: "cndev001",
                        kind: "device",
                        deviceId: "lock",
                        attribute: "state",
                        is: "locked",
                        negate: true
                    },
                    {
                        id: "cnread01",
                        kind: "reading",
                        deviceId: "air",
                        op: "gte",
                        value: 4,
                        measure: "quality"
                    },
                    { id: "cntime01", kind: "time", from: "22:00", to: "07:00" }
                ]
            },
            {
                id: "group002",
                match: "all",
                items: [
                    { id: "cnweek01", kind: "weekday", days: [0, 6] },
                    { id: "cnread02", kind: "reading", deviceId: "sensor", op: "lt", value: 18 }
                ]
            }
        ]
    },
    actions: [
        { id: "stdev001", kind: "device", deviceId: "plug", do: "turn-on" },
        { id: "stdev002", kind: "device", deviceId: "plug", do: "toggle" },
        {
            id: "stdev003",
            kind: "device",
            deviceId: "ac",
            do: "set-temperature",
            setting: { action: "set-temperature", target: 22 }
        },
        {
            id: "stdev004",
            kind: "device",
            deviceId: "ac",
            do: "set-option",
            setting: { action: "set-option", option: "swing", on: false }
        },
        {
            id: "stdev005",
            kind: "device",
            deviceId: "air",
            do: "set-fan",
            setting: { action: "set-fan", speed: "speed_2" }
        },
        {
            id: "stdev006",
            kind: "device",
            deviceId: "air",
            do: "set-humidity",
            setting: { action: "set-humidity", target: 50 }
        },
        { id: "stdelay1", kind: "delay", seconds: 300 },
        {
            id: "stwait01",
            kind: "wait",
            deviceId: "lock",
            attribute: "door",
            is: "closed",
            timeoutMinutes: 10,
            onTimeout: "continue"
        },
        {
            id: "stnote01",
            kind: "notify",
            message: "A message long enough to wrap onto more than one line of a node card, "
                .repeat(3)
                .trim()
        },
        { id: "strun001", kind: "run", automationId: "00000000-0000-4000-8000-000000000001" }
    ]
};

function roundTrip(definition: auto.AutomationDefinition): auto.AutomationDefinition {
    return graphs.graphToAutomation(graphs.automationToGraph(definition), definition);
}

function nodeOf(graph: graphs.AutomationGraph, id: string): graphs.GraphNode {
    const node = graph.nodes.find((entry) => entry.id === id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
}

/** The graph with one node dropped somewhere else, read back. */
function dropped(
    definition: auto.AutomationDefinition,
    id: string,
    position: graphs.Position
): auto.AutomationDefinition {
    const graph = graphs.automationToGraph(definition);
    return graphs.graphToAutomation(graphs.moveNode(graph, id, position), definition);
}

describe("the fixture", () => {
    it("is an automation the schema accepts", () => {
        expect(auto.definitionSchema.safeParse(EVERYTHING).success).toBe(true);
    });

    it("has every kind of trigger, condition and step", () => {
        expect(new Set(EVERYTHING.triggers.map((node) => node.kind))).toEqual(
            new Set(auto.TRIGGER_KINDS)
        );
        expect(
            new Set(
                EVERYTHING.conditions.groups.flatMap((group) =>
                    group.items.map((node) => node.kind)
                )
            )
        ).toEqual(new Set(auto.CONDITION_KINDS));
        expect(new Set(EVERYTHING.actions.map((node) => node.kind))).toEqual(
            new Set(auto.STEP_KINDS)
        );
    });
});

describe("drawing an automation and reading it back", () => {
    it("gives back exactly what went in, to the byte", () => {
        const back = roundTrip(EVERYTHING);
        expect(back).toEqual(EVERYTHING);
        expect(JSON.stringify(back)).toBe(JSON.stringify(EVERYTHING));
    });

    it("keeps the key order of a definition as the server sent it", () => {
        // JSON from the database need not list keys in the schema's order; the
        // editor's dirty check compares text, so the order has to survive.
        const stored = JSON.parse(
            JSON.stringify({
                actions: EVERYTHING.actions,
                conditions: { groups: EVERYTHING.conditions.groups, match: "any" },
                triggers: EVERYTHING.triggers,
                timeZone: EVERYTHING.timeZone
            })
        ) as auto.AutomationDefinition;
        expect(JSON.stringify(roundTrip(stored))).toBe(JSON.stringify(stored));
    });

    it.each(auto.TRIGGER_KINDS)("keeps a %s trigger whole", (kind) => {
        const definition = { ...auto.blankDefinition("UTC"), triggers: [auto.blankTrigger(kind)] };
        expect(JSON.stringify(roundTrip(definition))).toBe(JSON.stringify(definition));
    });

    it.each(auto.CONDITION_KINDS)("keeps a %s condition whole", (kind) => {
        const definition: auto.AutomationDefinition = {
            ...auto.blankDefinition("UTC"),
            conditions: {
                match: "all",
                groups: [{ id: "group001", match: "all", items: [auto.blankCondition(kind)] }]
            }
        };
        expect(JSON.stringify(roundTrip(definition))).toBe(JSON.stringify(definition));
    });

    it.each(auto.STEP_KINDS)("keeps a %s step whole", (kind) => {
        const definition = { ...auto.blankDefinition("UTC"), actions: [auto.blankStep(kind)] };
        expect(JSON.stringify(roundTrip(definition))).toBe(JSON.stringify(definition));
    });

    it("keeps an empty automation empty, with the gate alone", () => {
        const empty = auto.blankDefinition("UTC");
        const graph = graphs.automationToGraph(empty);
        expect(graph.nodes.map((node) => node.type)).toEqual(["gate"]);
        expect(graph.edges).toEqual([]);
        expect(roundTrip(empty)).toEqual(empty);
    });

    it("keeps an empty group, which the form can also leave", () => {
        const definition: auto.AutomationDefinition = {
            ...auto.blankDefinition("UTC"),
            conditions: { match: "all", groups: [{ id: "group001", match: "any", items: [] }] }
        };
        expect(JSON.stringify(roundTrip(definition))).toBe(JSON.stringify(definition));
    });

    it("keeps as many conditions as an automation can hold, in their groups", () => {
        const full: auto.AutomationDefinition = {
            ...auto.blankDefinition("UTC"),
            conditions: {
                match: "all",
                groups: Array.from({ length: auto.LIMITS.groups }, (_, group) => ({
                    id: `group${group}aa`,
                    match: group % 2 ? ("any" as const) : ("all" as const),
                    items: Array.from({ length: auto.LIMITS.conditionsPerGroup }, (_, item) => ({
                        ...auto.blankCondition("weekday"),
                        id: `cond${group}x${item}`
                    }))
                }))
            }
        };
        expect(JSON.stringify(roundTrip(full))).toBe(JSON.stringify(full));

        // And no group is drawn over another.
        const groups = graphs
            .automationToGraph(full)
            .nodes.filter((node) => node.type === "group")
            .map((node) =>
                node.type === "group" ? [node.position.y, node.position.y + node.height] : []
            );
        for (let at = 1; at < groups.length; at += 1) {
            expect(groups[at]![0]!).toBeGreaterThan(groups[at - 1]![1]!);
        }
    });
});

describe("the drawing", () => {
    const graph = graphs.automationToGraph(EVERYTHING);

    it("has a node for every trigger, group, condition and step, and one gate", () => {
        const count = (type: graphs.GraphNodeType) =>
            graph.nodes.filter((node) => node.type === type).length;
        expect(count("trigger")).toBe(EVERYTHING.triggers.length);
        expect(count("gate")).toBe(1);
        expect(count("group")).toBe(2);
        expect(count("condition")).toBe(5);
        expect(count("step")).toBe(EVERYTHING.actions.length);
        expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    });

    it("joins every trigger to the gate, every group to the gate, and the steps in order", () => {
        const pairs = graph.edges.map((edge) => `${edge.source}>${edge.target}:${edge.kind}`);
        for (const trigger of EVERYTHING.triggers)
            expect(pairs).toContain(`${trigger.id}>${graphs.GATE_ID}:flow`);
        for (const group of EVERYTHING.conditions.groups)
            expect(pairs).toContain(`${group.id}>${graphs.GATE_ID}:feeds`);
        const chain = [graphs.GATE_ID, ...EVERYTHING.actions.map((step) => step.id)];
        for (let at = 1; at < chain.length; at += 1)
            expect(pairs).toContain(`${chain[at - 1]}>${chain[at]}:flow`);
        expect(graph.edges).toHaveLength(
            EVERYTHING.triggers.length +
                EVERYTHING.conditions.groups.length +
                EVERYTHING.actions.length
        );
    });

    it("puts each condition inside its group, and gives every node the path its checks use", () => {
        const condition = nodeOf(graph, "cnread02");
        expect(condition.type === "condition" && condition.parentId).toBe("group002");
        expect(condition.type === "condition" && condition.data.path).toEqual([
            "definition",
            "conditions",
            "groups",
            1,
            "items",
            1
        ]);
        const step = nodeOf(graph, "stwait01");
        expect(step.type === "step" && step.data.path).toEqual(["definition", "actions", 7]);
    });

    it("is drawn the same way every time", () => {
        expect(graphs.automationToGraph(EVERYTHING)).toEqual(graph);
    });

    it("has a gate whose id no node of an automation can have", () => {
        const probe = { ...auto.blankTrigger("manual"), id: graphs.GATE_ID };
        expect(auto.triggerSchema.safeParse(probe).success).toBe(false);
    });
});

describe("a drag", () => {
    it("puts a step dropped below another after it", () => {
        const second = nodeOf(graphs.automationToGraph(EVERYTHING), "stdev002");
        const next = dropped(EVERYTHING, "stdev001", {
            x: second.position.x,
            y: second.position.y + 10
        });
        expect(next.actions.slice(0, 3).map((step) => step.id)).toEqual([
            "stdev002",
            "stdev001",
            "stdev003"
        ]);
        expect(next.actions).toHaveLength(EVERYTHING.actions.length);
        expect(next.triggers).toEqual(EVERYTHING.triggers);
    });

    it("puts a trigger dropped above the first one first", () => {
        const next = dropped(EVERYTHING, "trmanu01", { x: 0, y: -50 });
        expect(next.triggers[0]!.id).toBe("trmanu01");
        expect(next.triggers.slice(1).map((node) => node.id)).toEqual(
            EVERYTHING.triggers.slice(0, -1).map((node) => node.id)
        );
    });

    it("reorders a condition within its group only", () => {
        const next = dropped(EVERYTHING, "cntime01", { x: 12, y: 0 });
        expect(next.conditions.groups[0]!.items.map((node) => node.id)).toEqual([
            "cntime01",
            "cndev001",
            "cnread01"
        ]);
        expect(next.conditions.groups[1]).toEqual(EVERYTHING.conditions.groups[1]);
    });

    it("moves a group with its conditions", () => {
        const next = dropped(EVERYTHING, "group002", { x: 0, y: -1000 });
        expect(next.conditions.groups.map((group) => group.id)).toEqual(["group002", "group001"]);
        expect(next.conditions.groups[0]).toEqual(EVERYTHING.conditions.groups[1]);
    });

    it("changes nothing when a node only moves sideways", () => {
        const node = nodeOf(graphs.automationToGraph(EVERYTHING), "stdelay1");
        const next = dropped(EVERYTHING, "stdelay1", {
            x: node.position.x + 400,
            y: node.position.y
        });
        expect(JSON.stringify(next)).toBe(JSON.stringify(EVERYTHING));
    });
});

describe("shifting a node one place", () => {
    it.each([
        ["trintv01", "triggers"],
        ["stdelay1", "actions"]
    ] as const)("moves %s within its %s", (id, list) => {
        const before = EVERYTHING[list].map((node) => node.id);
        const at = before.indexOf(id);
        const up = graphs.shiftNode(EVERYTHING, id, -1)[list].map((node) => node.id);
        expect(up.indexOf(id)).toBe(at - 1);
        const down = graphs.shiftNode(EVERYTHING, id, 1)[list].map((node) => node.id);
        expect(down.indexOf(id)).toBe(at + 1);
    });

    it("moves a condition within its group and a group among the groups", () => {
        expect(
            graphs
                .shiftNode(EVERYTHING, "cnread02", -1)
                .conditions.groups[1]!.items.map((node) => node.id)
        ).toEqual(["cnread02", "cnweek01"]);
        expect(
            graphs.shiftNode(EVERYTHING, "group001", 1).conditions.groups.map((group) => group.id)
        ).toEqual(["group002", "group001"]);
    });

    it("leaves the first one where it is when asked to go higher, and the last when lower", () => {
        expect(graphs.shiftNode(EVERYTHING, "trtime01", -1)).toEqual(EVERYTHING);
        expect(graphs.shiftNode(EVERYTHING, "strun001", 1)).toEqual(EVERYTHING);
        expect(graphs.shiftNode(EVERYTHING, graphs.GATE_ID, 1)).toEqual(EVERYTHING);
    });
});

describe("removing a node", () => {
    it("takes out a trigger, a condition or a step, and nothing else", () => {
        const next = graphs.removeNode(
            graphs.removeNode(graphs.removeNode(EVERYTHING, "trintv01"), "cnread01"),
            "stdelay1"
        );
        expect(next.triggers.map((node) => node.id)).not.toContain("trintv01");
        expect(next.conditions.groups[0]!.items.map((node) => node.id)).toEqual([
            "cndev001",
            "cntime01"
        ]);
        expect(next.actions.map((node) => node.id)).not.toContain("stdelay1");
        expect(next.triggers).toHaveLength(EVERYTHING.triggers.length - 1);
        expect(next.actions).toHaveLength(EVERYTHING.actions.length - 1);
    });

    it("takes a group with its conditions", () => {
        const next = graphs.removeNode(EVERYTHING, "group001");
        expect(next.conditions.groups.map((group) => group.id)).toEqual(["group002"]);
    });

    it("never takes the gate", () => {
        expect(graphs.removeNode(EVERYTHING, graphs.GATE_ID)).toBe(EVERYTHING);
    });
});

describe("whether a complaint is about a node", () => {
    it("counts a field of the node and the node itself, not a neighbour", () => {
        const node = ["definition", "actions", 2];
        expect(graphs.within(["definition", "actions", 2, "setting", "target"], node)).toBe(true);
        expect(graphs.within(node, node)).toBe(true);
        expect(graphs.within(["definition", "actions", 3], node)).toBe(false);
        expect(graphs.within(["definition", "actions"], node)).toBe(false);
    });
});

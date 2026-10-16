import { describe, expect, it } from "vitest";
import * as graph from "./automation-graph.js";
import * as canvas from "./automation-canvas.js";

const node = (id: string, type: string, config: unknown = {}): graph.GraphNode => ({ id, type, typeVersion: 1, config });
const edge = (from: string, to: string, port = "next"): graph.GraphEdge => ({ from: { node: from, port }, to: { node: to } });
const ifConfig = { condition: { kind: "group", join: "all", items: [{ kind: "compare", left: "a", op: "eq", right: "a" }] } };

function sample(): graph.AutomationGraph {
    return {
        ...graph.emptyGraph(),
        nodes: [
            node("t1", "core.manual"),
            node("if1", "core.if", ifConfig),
            node("a", "core.notify", { title: "A", body: "" }),
            node("b", "core.notify", { title: "B", body: "" }),
            node("z", "core.http", { method: "POST", url: "https://example.test", urlSecretId: "s1", auth: { kind: "bearer", secretId: "s2" } })
        ],
        edges: [edge("t1", "if1"), edge("if1", "a", "then"), edge("if1", "b", "else")],
        finally: { entry: "z", onCancel: false }
    };
}

let counter = 0;
const fresh = () => `n${++counter}`;

describe("lanes and layout", () => {
    it("puts each node in its lane", () => {
        const lanes = canvas.lanesOf({ ...sample(), nodes: [...sample().nodes, node("loose", "core.notify")] });
        expect(lanes.get("a")).toBe("main");
        expect(lanes.get("z")).toBe("finally");
        expect(lanes.get("loose")).toBe("loose");
    });

    it("lays out unplaced nodes left to right and the Always lane below the main flow", () => {
        const laid = canvas.layoutGraph(sample());
        const at = (id: string) => laid.nodes.find((entry) => entry.id === id)!.position!;
        expect(at("t1").x).toBeLessThan(at("if1").x);
        expect(at("if1").x).toBeLessThan(at("a").x);
        expect(at("a").x).toBe(at("b").x);
        expect(at("z").y).toBeGreaterThan(Math.max(at("a").y, at("b").y));
    });

    it("keeps stored positions unless asked to tidy", () => {
        const placed = { ...sample(), nodes: sample().nodes.map((entry) => ({ ...entry, position: { x: 7, y: 9 } })) };
        expect(canvas.layoutGraph(placed)).toBe(placed);
        expect(canvas.layoutGraph(placed, { tidy: true }).nodes[1]!.position).not.toEqual({ x: 7, y: 9 });
    });

    it("frames every node and note", () => {
        const laid = { ...canvas.layoutGraph(sample()), notes: [{ id: "n", text: "", position: { x: -100, y: -50 }, size: { width: 200, height: 100 } }] };
        const bounds = canvas.graphBounds(laid)!;
        expect(bounds.x).toBe(-100);
        expect(bounds.y).toBe(-50);
        expect(canvas.graphBounds(graph.emptyGraph())).toBeNull();
    });
});

describe("connections", () => {
    it("refuses what would make the graph run differently from how it reads", () => {
        const g = sample();
        expect(canvas.connectRefusal(g, { node: "a", port: "next" }, "t1")).toBe("intoTrigger");
        expect(canvas.connectRefusal(g, { node: "a", port: "next" }, "a")).toBe("self");
        expect(canvas.connectRefusal(g, { node: "if1", port: "next" }, "b")).toBe("unknownPort");
        expect(canvas.connectRefusal(g, { node: "if1", port: "then" }, "a")).toBe("duplicate");
        expect(canvas.connectRefusal(g, { node: "a", port: "next" }, "if1")).toBe("cycle");
        expect(canvas.connectRefusal(g, { node: "a", port: "next" }, "z")).toBe("intoLaneStart");
        expect(canvas.connectRefusal(g, { node: "a", port: "next" }, "b")).toBeNull();
    });

    it("never wires the main flow into the Always lane", () => {
        const g = { ...sample(), nodes: [...sample().nodes, node("y", "core.notify", { title: "Y", body: "" })], edges: [...sample().edges, edge("z", "y")] };
        expect(canvas.connectRefusal(g, { node: "a", port: "next" }, "y")).toBe("crossesLane");
    });

    it("starts the Always lane from its own edge, once", () => {
        const g = { ...sample(), finally: { entry: null, onCancel: false } };
        const started = canvas.connect(g, { node: canvas.FINALLY_SOURCE, port: "next" }, "z");
        expect(started.finally.entry).toBe("z");
        expect(canvas.connectRefusal(started, { node: canvas.FINALLY_SOURCE, port: "next" }, "z")).toBe("laneTaken");
        expect(canvas.disconnect(started, `${canvas.FINALLY_SOURCE}>z`).finally.entry).toBeNull();
    });

    it("a connected graph still passes the graph checks", () => {
        const g = canvas.connect(sample(), { node: "a", port: "next" }, "b");
        expect(g.edges).toHaveLength(4);
        expect(graph.graphProblems(g).filter((problem) => problem.code !== "badConfig")).toEqual([]);
        expect(canvas.disconnect(g, "a:next>b").edges).toHaveLength(3);
    });
});

describe("removing, moving, copying", () => {
    it("removes nodes with their connections and hands the Always lane on", () => {
        const g = { ...sample(), nodes: [...sample().nodes, node("y", "core.notify", { title: "Y", body: "" })], edges: [...sample().edges, edge("z", "y")] };
        const left = canvas.removeFromGraph(g, ["if1", "z"]);
        expect(left.edges).toEqual([]);
        expect(left.finally.entry).toBe("y");
        expect(graph.graphProblems(left)).toEqual([]);
    });

    it("moves a selection by the same distance", () => {
        const laid = canvas.layoutGraph(sample());
        const moved = canvas.moveInGraph(laid, new Set(["a", "b"]), new Set(), 10, 20);
        expect(moved.nodes[2]!.position!.x).toBe(laid.nodes[2]!.position!.x + 10);
        expect(moved.nodes[0]!.position).toEqual(laid.nodes[0]!.position);
    });

    it("copies inner connections only, without pins or secrets, and pastes with fresh ids", () => {
        const g = { ...canvas.layoutGraph(sample()), nodes: canvas.layoutGraph(sample()).nodes.map((entry) => (entry.id === "z" ? { ...entry, pinned: { status: 200 } } : entry)) };
        const fragment = canvas.copyFragment(g, new Set(["if1", "a", "z"]));
        expect(fragment.edges).toEqual([edge("if1", "a", "then")]);
        const copied = fragment.nodes.find((entry) => entry.id === "z")!;
        expect(copied.pinned).toBeUndefined();
        expect((copied.config as { urlSecretId: string }).urlSecretId).toBe("");
        expect((copied.config as { auth: { secretId: string } }).auth.secretId).toBe("");

        const parsed = canvas.parseFragment(canvas.fragmentText(fragment))!;
        expect(parsed).not.toBeNull();
        const pasted = canvas.pasteFragment(g, parsed, { x: 40, y: 40 }, fresh)!;
        expect(pasted.nodeIds).toHaveLength(3);
        expect(pasted.graph.nodes).toHaveLength(8);
        expect(new Set(pasted.graph.nodes.map((entry) => entry.id)).size).toBe(8);
        expect(pasted.graph.edges.at(-1)!.from.node).toBe(pasted.nodeIds[0]);
    });

    it("rejects clipboard text that is not a fragment", () => {
        expect(canvas.parseFragment("hello")).toBeNull();
        expect(canvas.parseFragment(JSON.stringify({ kind: "other" }))).toBeNull();
    });

    it("refuses a paste past the node limit", () => {
        const full = { ...graph.emptyGraph(), nodes: Array.from({ length: graph.AUTOMATION_LIMITS.nodes }, (_, index) => node(`x${index}`, "core.notify")) };
        const fragment = canvas.copyFragment(sample(), new Set(["a"]));
        expect(canvas.pasteFragment(full, fragment, { x: 0, y: 0 }, fresh)).toBeNull();
    });
});

describe("pins and versions", () => {
    it("never publishes a pin", () => {
        const g = { ...sample(), nodes: sample().nodes.map((entry) => (entry.id === "t1" ? { ...entry, pinned: { by: "x" } } : entry)) };
        expect(canvas.withoutPins(g).nodes[0]!.pinned).toBeUndefined();
        expect(canvas.draftDiffers(g, canvas.withoutPins(g))).toBe(false);
        expect(canvas.draftDiffers(g, null)).toBe(true);
    });

    it("refuses a pin on a condition and a pin that is too large", () => {
        const onIf = { ...sample(), nodes: sample().nodes.map((entry) => (entry.id === "if1" ? { ...entry, pinned: {} } : entry)) };
        expect(graph.graphProblems(onIf)).toContainEqual({ code: "pinNotAllowed", node: "if1" });
        const big = { ...sample(), nodes: sample().nodes.map((entry) => (entry.id === "t1" ? { ...entry, pinned: "x".repeat(graph.AUTOMATION_LIMITS.pinBytes + 1) } : entry)) };
        expect(graph.graphProblems(big)).toContainEqual({ code: "pinTooLarge", node: "t1" });
    });

    it("reads graphs saved before notes existed", () => {
        const parsed = graph.automationGraphSchema.parse({ schema: 1, timeZone: "UTC", nodes: [], edges: [] });
        expect(parsed.notes).toEqual([]);
    });
});

describe("data mapping", () => {
    it("offers the trigger and earlier steps, nearest first, from samples when present", () => {
        const g = { ...sample(), nodes: sample().nodes.map((entry) => (entry.id === "t1" ? { ...entry, pinned: { body: { name: "Ada", items: [{ id: 1 }] } } } : entry)) };
        const groups = canvas.referenceOptions(g, "a", { if1: { matched: true } });
        expect(groups.map((group) => group.root)).toEqual(["steps.if1", "trigger"]);
        expect(groups[0]!.options).toEqual([{ path: "steps.if1.matched", preview: "true" }]);
        expect(groups[1]!.options.map((option) => option.path)).toEqual(["trigger.body.name", "trigger.body.items.0.id"]);
    });

    it("falls back to what a node type is known to give", () => {
        const groups = canvas.referenceOptions(sample(), "if1", {});
        expect(groups[0]!.options.map((option) => option.path)).toContain("trigger.by");
        expect(groups[0]!.fromSample).toBe(false);
    });

    it("gives the Always lane the run and the whole main flow", () => {
        const roots = canvas.referenceOptions(sample(), "z", {}).map((group) => group.root);
        expect(roots).toContain("run");
        expect(roots).toContain("steps.a");
        expect(roots).toContain("trigger");
    });

    it("inserts a reference at the caret, replacing a selection", () => {
        expect(canvas.insertReference("Hello !", 6, 6, "trigger.name")).toEqual({ text: "Hello {{trigger.name}}!", caret: 22 });
        expect(canvas.insertReference("abc", 0, 3, "x")).toEqual({ text: "{{x}}", caret: 5 });
    });

    it("bounds what a huge sample offers", () => {
        const wide = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index]));
        expect(canvas.samplePaths(wide, "trigger")).toHaveLength(80);
        expect(canvas.samplePaths({ __proto__x: 1, "bad key": 2 }, "t").map((option) => option.path)).toEqual(["t.__proto__x"]);
    });
});

describe("placing nodes added in the list view", () => {
    it("puts a new step next to the one it follows, on a free spot, and keeps every stored position", () => {
        const laid = canvas.layoutGraph(sample());
        const added = { ...laid, nodes: [...laid.nodes, node("c", "core.notify")], edges: [...laid.edges, edge("a", "c")] };
        const placed = canvas.placeNew(added);
        for (const before of laid.nodes) expect(placed.nodes.find((entry) => entry.id === before.id)!.position).toEqual(before.position);
        const a = placed.nodes.find((entry) => entry.id === "a")!.position!;
        const c = placed.nodes.find((entry) => entry.id === "c")!.position!;
        expect(c.x).toBe(a.x + canvas.CANVAS_NODE.width + canvas.CANVAS_GAP.x);
        const boxes = placed.nodes.map((entry) => entry.position!);
        for (const box of boxes) if (box !== c) expect(Math.abs(box.x - c.x) >= canvas.CANVAS_NODE.width || Math.abs(box.y - c.y) >= canvas.CANVAS_NODE.height).toBe(true);
    });

    it("puts a step with no neighbour under everything, and lays out a graph with no positions at all", () => {
        const laid = canvas.layoutGraph(sample());
        const placed = canvas.placeNew({ ...laid, nodes: [...laid.nodes, node("lonely", "core.notify")] });
        const bottom = Math.max(...laid.nodes.map((entry) => entry.position!.y + canvas.CANVAS_NODE.height));
        expect(placed.nodes.find((entry) => entry.id === "lonely")!.position!.y).toBeGreaterThan(bottom);
        expect(canvas.placeNew(sample())).toEqual(canvas.layoutGraph(sample()));
    });
});

describe("inserting on a connection", () => {
    it("puts the node between the two ends, keeps the port, and makes room downstream", () => {
        const laid = canvas.layoutGraph(sample());
        const key = canvas.edgeKey(laid.edges.find((entry) => entry.to.node === "a")!);
        const before = laid.nodes.find((entry) => entry.id === "a")!.position!;
        const inserted = canvas.insertOnEdge(laid, key, node("mid", "core.notify", { title: "M", body: "" }))!;
        expect(inserted.edges).toContainEqual(edge("if1", "mid", "then"));
        expect(inserted.edges).toContainEqual(edge("mid", "a"));
        expect(inserted.edges.some((entry) => canvas.edgeKey(entry) === key)).toBe(false);
        const mid = inserted.nodes.find((entry) => entry.id === "mid")!.position!;
        const after = inserted.nodes.find((entry) => entry.id === "a")!.position!;
        expect(mid.x).toBeGreaterThan(laid.nodes.find((entry) => entry.id === "if1")!.position!.x);
        expect(after.x).toBeGreaterThanOrEqual(mid.x + canvas.CANVAS_NODE.width + canvas.CANVAS_GAP.x);
        expect(after.x).toBeGreaterThan(before.x);
        expect(graph.graphProblems(inserted)).toEqual(graph.graphProblems(laid));
    });

    it("inserts at the start of the Always lane, and refuses a trigger or a connection that is gone", () => {
        const laid = canvas.layoutGraph(sample());
        const inserted = canvas.insertOnEdge(laid, `${canvas.FINALLY_SOURCE}>z`, node("first", "core.notify", { title: "F", body: "" }))!;
        expect(inserted.finally.entry).toBe("first");
        expect(inserted.edges).toContainEqual(edge("first", "z"));
        expect(canvas.lanesOf(inserted).get("z")).toBe("finally");
        expect(canvas.insertOnEdge(laid, "nope", node("x", "core.notify"))).toBeNull();
        expect(canvas.insertOnEdge(laid, canvas.edgeKey(laid.edges[0]!), node("x", "core.manual"))).toBeNull();
    });
});

describe("tidy up", () => {
    it("lays out every node again, stored positions or not, without touching notes", () => {
        const laid = canvas.layoutGraph(sample());
        const messy = { ...laid, nodes: laid.nodes.map((entry, index) => ({ ...entry, position: { x: index * 7, y: 3 } })), notes: [{ id: "note", text: "", position: { x: 5, y: 5 }, size: { width: 100, height: 80 } }] };
        const tidy = canvas.layoutGraph(messy, { tidy: true });
        expect(tidy.nodes.map((entry) => entry.position)).toEqual(laid.nodes.map((entry) => entry.position));
        expect(tidy.notes).toEqual(messy.notes);
    });
});

describe("run from here", () => {
    const flow = (): graph.AutomationGraph => ({
        ...graph.emptyGraph(),
        nodes: [
            node("t1", "core.manual"),
            node("t2", "core.webhook"),
            node("h", "core.http", { method: "GET", url: "https://example.test", urlSecretId: null }),
            node("side", "core.notify", { title: "S", body: "" }),
            node("x", "core.notify", { title: "X", body: "" }),
            node("after", "core.notify", { title: "A", body: "" }),
            node("z", "core.notify", { title: "Z", body: "" })
        ],
        edges: [edge("t1", "h"), edge("t2", "h"), edge("h", "x"), edge("h", "side"), edge("x", "after")],
        finally: { entry: "z", onCancel: false }
    });

    it("keeps the trigger with data, pins the steps before, and leaves out side branches and the Always lane", () => {
        const answer = canvas.partialRunGraph(flow(), "x", { t2: { body: { a: 1 } }, h: { status: 200 } });
        expect("graph" in answer).toBe(true);
        const run = answer as Extract<canvas.PartialRun, { graph: unknown }>;
        expect(run.triggerId).toBe("t2");
        expect(run.cause).toEqual({ body: { a: 1 } });
        expect(run.graph.nodes.map((entry) => entry.id).sort()).toEqual(["after", "h", "t2", "x"]);
        expect(run.graph.nodes.find((entry) => entry.id === "h")!.pinned).toEqual({ status: 200 });
        expect(run.graph.nodes.find((entry) => entry.id === "after")!.pinned).toBeUndefined();
        expect(run.graph.finally.entry).toBeNull();
        expect(run.graph.edges.map(canvas.edgeKey).sort()).toEqual(["h:next>x", "t2:next>h", "x:next>after"]);
    });

    it("prefers a pin, drops the node's own pin, and names the steps that have no data", () => {
        const pinned = { ...flow(), nodes: flow().nodes.map((entry) => (entry.id === "t1" ? { ...entry, pinned: { by: "pin" } } : entry.id === "x" ? { ...entry, pinned: { sent: true } } : entry)) };
        const run = canvas.partialRunGraph(pinned, "x", { h: { status: 200 } }) as Extract<canvas.PartialRun, { graph: unknown }>;
        expect(run.triggerId).toBe("t1");
        expect(run.graph.nodes.find((entry) => entry.id === "x")!.pinned).toBeUndefined();
        expect(canvas.partialRunGraph(pinned, "x", {})).toEqual({ refusal: "missingData", nodes: ["h"] });
        expect(canvas.partialRunGraph(flow(), "x", { h: {} })).toEqual({ refusal: "noTriggerData", nodes: ["t1", "t2"] });
        expect(canvas.partialRunGraph(flow(), "z", {})).toEqual({ refusal: "notMainFlow", nodes: ["z"] });
        expect(canvas.partialRunGraph(flow(), "t1", {})).toEqual({ refusal: "notFound", nodes: [] });
    });

    it("needs no data for a switched-off step or a condition before the node", () => {
        const g = canvas.layoutGraph(sample());
        const run = canvas.partialRunGraph(g, "a", { t1: { kind: "test" } });
        expect("graph" in run).toBe(true);
        expect((run as Extract<canvas.PartialRun, { graph: unknown }>).graph.nodes.map((entry) => entry.id).sort()).toEqual(["a", "if1", "t1"]);
    });
});

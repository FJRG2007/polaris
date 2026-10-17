import { describe, expect, it } from "vitest";
import * as ag from "./automation-graph.js";

const node = (id: string, type: string, config: unknown = {}, extra: Partial<ag.GraphNode> = {}) =>
    ({ id, type, typeVersion: 1, config, ...extra }) as ag.GraphNode;
const edge = (from: string, port: string, to: string) => ({
    from: { node: from, port },
    to: { node: to }
});
const build = (nodes: ag.GraphNode[], edges: ag.AutomationGraph["edges"]): ag.AutomationGraph =>
    ag.automationGraphSchema.parse({ nodes, edges });
const always = { kind: "group", join: "all", items: [] };

describe("flow ports", () => {
    it("gives a Choose one port per case and Otherwise when it falls back", () => {
        const config = { kind: "rules", cases: [{ condition: always }, { condition: always }] };
        expect(ag.nodePorts("core.switch", { config })).toEqual(["case1", "case2", "otherwise"]);
        expect(ag.nodePorts("core.switch", { config: { ...config, fallback: false } })).toEqual([
            "case1",
            "case2"
        ]);
    });

    it("gives At the same time one port per lane", () => {
        expect(ag.nodePorts("core.parallel", { config: { lanes: 3 } })).toEqual([
            "lane1",
            "lane2",
            "lane3"
        ]);
    });

    it("adds the error port only to nodes that can fail and ask for it", () => {
        expect(ag.nodePorts("core.http", { onError: "port" })).toEqual(["next", "error"]);
        expect(ag.nodePorts("core.http", { onError: "continue" })).toEqual(["next"]);
        expect(ag.nodePorts("core.join", { onError: "port" })).toEqual(["next"]);
        expect(ag.nodePorts("app.thing.do", { onError: "port" })).toEqual(["next", "error"]);
        expect(ag.nodePorts("core.waitEvent")).toEqual(["next", "timeout"]);
    });

    it("passes a switched-off loop through done and a Stop nowhere", () => {
        expect(ag.passPort("core.forEach")).toBe("done");
        expect(ag.passPort("core.stop")).toBeNull();
        expect(ag.passPort("core.http")).toBe("next");
    });

    it("refuses an edge from a port the config does not have", () => {
        const config = { kind: "value", value: "{{trigger.x}}", cases: [{ equals: "a" }] };
        const flow = build(
            [
                node("t", "core.manual"),
                node("s", "core.switch", config),
                node("a", "core.notify", { title: "a" })
            ],
            [edge("t", "next", "s"), edge("s", "case2", "a")]
        );
        expect(ag.graphProblems(flow)).toContainEqual({
            code: "unknownPort",
            node: "s",
            port: "case2"
        });
    });
});

describe("loops", () => {
    it("refuses a body that is also reached from outside the loop", () => {
        const flow = build(
            [
                node("t", "core.manual"),
                node("l", "core.forEach", { items: "{{trigger.list}}" }),
                node("a", "core.notify", { title: "a" }),
                node("b", "core.notify", { title: "b" })
            ],
            [
                edge("t", "next", "l"),
                edge("l", "each", "a"),
                edge("l", "done", "b"),
                edge("b", "next", "a")
            ]
        );
        expect(ag.graphProblems(flow)).toContainEqual({ code: "loopBodyLeaks", node: "a" });
    });

    it("accepts a closed body", () => {
        const flow = build(
            [
                node("t", "core.manual"),
                node("l", "core.repeat", { kind: "times", count: 3 }),
                node("a", "core.notify", { title: "a" }),
                node("b", "core.notify", { title: "b" })
            ],
            [edge("t", "next", "l"), edge("l", "each", "a"), edge("l", "done", "b")]
        );
        expect(ag.graphProblems(flow, { forPublish: true })).toEqual([]);
    });

    it("bounds repeat passes and batches", () => {
        expect(
            ag.CORE_NODE_CONFIGS["core.repeat"].safeParse({
                kind: "times",
                count: ag.AUTOMATION_LIMITS.repeatPasses + 1
            }).success
        ).toBe(false);
        expect(
            ag.CORE_NODE_CONFIGS["core.forEach"].safeParse({ items: "{{x}}", batch: 101 }).success
        ).toBe(false);
    });
});

describe("conditions and combinators", () => {
    it("checks Triggered by against the firing trigger", () => {
        const tree = {
            kind: "group" as const,
            join: "all" as const,
            items: [{ kind: "triggeredBy" as const, triggers: ["t2"] }]
        };
        expect(ag.checkCondition(tree, { trigger: { id: "t2" } })).toBe(true);
        expect(ag.checkCondition(tree, { trigger: { id: "t1" } })).toBe(false);
        expect(ag.checkCondition({ ...tree, negate: true }, { trigger: { id: "t1" } })).toBe(true);
    });

    it("parses an older graph as any-of-N", () => {
        expect(ag.automationGraphSchema.parse({}).when).toEqual({ kind: "any" });
    });

    it("counts what a combination needs", () => {
        expect(ag.combineNeeds({ kind: "any" }, 3)).toBe(1);
        expect(ag.combineNeeds({ kind: "all", windowSeconds: 60 }, 3)).toBe(3);
        expect(ag.combineNeeds({ kind: "count", count: 2, windowSeconds: 60 }, 3)).toBe(2);
        expect(ag.combineNeeds({ kind: "count", count: 5, windowSeconds: 60 }, 3)).toBe(3);
    });

    it("doubles retry waits within the ceiling", () => {
        expect(ag.retryDelayMs({ waitSeconds: 10, backoff: "fixed" }, 4)).toBe(10_000);
        expect(ag.retryDelayMs({ waitSeconds: 10, backoff: "double" }, 2)).toBe(10_000);
        expect(ag.retryDelayMs({ waitSeconds: 10, backoff: "double" }, 4)).toBe(40_000);
        expect(ag.retryDelayMs({ waitSeconds: 3000, backoff: "double" }, 5)).toBe(3_600_000);
    });

    it("bounds retry tries and validates event names", () => {
        const base = { id: "a", type: "core.http" };
        expect(
            ag.automationGraphSchema.safeParse({
                nodes: [{ ...base, retry: { tries: 9, waitSeconds: 1 } }]
            }).success
        ).toBe(false);
        expect(ag.CORE_NODE_CONFIGS["core.onEvent"].safeParse({ name: "Door Open" }).success).toBe(
            false
        );
        expect(ag.CORE_NODE_CONFIGS["core.onEvent"].safeParse({ name: "door.open" }).success).toBe(
            true
        );
    });
});

describe("the list view of flow control", () => {
    const n = (id: string, type: string, config: unknown = {}): ag.GraphNode => ({
        id,
        type,
        typeVersion: 1,
        config
    });
    it("round-trips Choose, At the same time and loops", () => {
        const flow: ag.ListFlow = {
            timeZone: "UTC",
            triggers: [n("t1", "core.manual")],
            steps: [
                {
                    node: n("sw", "core.switch", {
                        kind: "value",
                        value: "{{trigger.a}}",
                        cases: [{ equals: "x" }]
                    }),
                    branches: [[{ node: n("a", "core.notify", { title: "a" }) }], []]
                },
                {
                    node: n("par", "core.parallel", { lanes: 2 }),
                    branches: [
                        [{ node: n("b", "core.notify", { title: "b" }) }],
                        [{ node: n("c", "core.notify", { title: "c" }) }]
                    ]
                },
                { node: n("join", "core.join", {}) },
                {
                    node: n("each", "core.forEach", { items: "{{trigger.list}}" }),
                    body: [{ node: n("d", "core.notify", { title: "d" }) }]
                },
                { node: n("stop", "core.stop", {}) }
            ],
            finally: [],
            finallyOnCancel: false
        };
        const graph = ag.graphFromList(flow);
        expect(ag.graphProblems(graph, { forPublish: true })).toEqual([]);
        const back = ag.listFromGraph(graph);
        expect(back).not.toBeNull();
        expect(ag.graphFromList(back!)).toEqual(graph);
        expect(ag.listStepFor(n("x", "core.parallel", { lanes: 3 })).branches).toHaveLength(3);
    });
});

describe("ports that follow a change of settings", () => {
    const first = { label: "a", condition: always };
    const second = { label: "b", condition: always };
    const third = { label: "c", condition: always };
    const choose = (cases: unknown[], fallback = true) =>
        node("sw", "core.switch", { kind: "rules", cases, fallback });

    it("keeps a case's wires when a case before it is removed", () => {
        const moves = ag.portMoves(choose([first, second, third]), choose([first, third]));
        expect(Object.fromEntries(moves)).toEqual({
            case1: "case1",
            case2: null,
            case3: "case2",
            otherwise: "otherwise"
        });
    });

    it("keeps wires by position when a case is only edited, and drops Otherwise when it goes", () => {
        const edited = { ...second, label: "renamed" };
        const moves = ag.portMoves(choose([first, second]), choose([first, edited], false));
        expect(Object.fromEntries(moves)).toEqual({
            case1: "case1",
            case2: "case2",
            otherwise: null
        });
    });

    it("drops the lanes a parallel no longer has and the error port once it is off", () => {
        const lanes = (count: number) => node("par", "core.parallel", { lanes: count });
        expect(Object.fromEntries(ag.portMoves(lanes(3), lanes(2)))).toEqual({
            lane1: "lane1",
            lane2: "lane2",
            lane3: null
        });
        const http = node("h", "core.http", {}, { onError: "port" });
        expect(ag.portMoves(http, { ...http, onError: "stop" }).get("error")).toBeNull();
    });
});

describe("node height on the canvas", () => {
    it("grows a node with many ports and lays the next one below it", async () => {
        const canvas = await import("./automation-canvas.js");
        const many = node("sw", "core.switch", {
            kind: "rules",
            cases: Array.from({ length: 8 }, (_, at) => ({ label: `c${at}`, condition: always }))
        });
        expect(canvas.canvasNodeHeight(node("n", "core.notify", { title: "x" }))).toBe(
            canvas.CANVAS_NODE.height
        );
        expect(canvas.canvasNodeHeight(many)).toBeGreaterThan(canvas.CANVAS_NODE.height);
        const graph = canvas.layoutGraph(
            build(
                [node("t", "core.manual"), many, node("a", "core.manual")],
                [edge("t", "next", "sw")]
            )
        );
        const [top, , below] = graph.nodes;
        expect(below!.position!.y).toBeGreaterThanOrEqual(
            top!.position!.y + canvas.canvasNodeHeight(top!)
        );
        const sw = graph.nodes[1]!;
        const bounds = canvas.graphBounds(graph)!;
        expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(
            sw.position!.y + canvas.canvasNodeHeight(sw)
        );
    });
});

describe("Try and Wait for a condition", () => {
    it("gives a Try its four ports and passes a switched-off one by Then and Always", () => {
        expect(ag.nodePorts("core.try")).toEqual(["body", "then", "catch", "always"]);
        expect(ag.passPort("core.try")).toBe("then,always");
        expect(ag.nodePorts("core.waitCondition")).toEqual(["next", "timeout"]);
        expect(ag.isScopeNode("core.try")).toBe(true);
        expect(ag.bodyPort("core.try")).toBe("body");
    });

    it("refuses a Try body reached from outside it, and from its own Then", () => {
        const nodes = [
            node("t1", "core.manual"),
            node("try", "core.try"),
            node("a", "core.notify", { title: "a" }),
            node("b", "core.notify", { title: "b" })
        ];
        const closed = build(nodes, [
            edge("t1", "next", "try"),
            edge("try", "body", "a"),
            edge("try", "then", "b")
        ]);
        expect(ag.graphProblems(closed)).toEqual([]);
        const leaky = build(nodes, [
            edge("t1", "next", "try"),
            edge("try", "body", "a"),
            edge("try", "then", "a")
        ]);
        expect(ag.graphProblems(leaky)).toContainEqual({ code: "tryBodyLeaks", node: "a" });
        expect(ag.tryBodyLeaks(leaky)).toEqual(["a"]);
    });

    it("bounds how deep Try blocks and loops nest", () => {
        const depth = ag.AUTOMATION_LIMITS.scopeDepth + 1;
        const nodes = [node("t1", "core.manual")];
        const edges = [edge("t1", "next", "s0")];
        for (let at = 0; at < depth; at++) {
            nodes.push(node(`s${at}`, "core.try"));
            if (at > 0) edges.push(edge(`s${at - 1}`, "body", `s${at}`));
        }
        const problems = ag.graphProblems(build(nodes, edges));
        expect(problems).toContainEqual({ code: "scopeTooDeep", node: "s0" });
        expect(problems.filter((problem) => problem.code === "scopeTooDeep")).toHaveLength(1);
        const fits = build(nodes.slice(0, -1), edges.slice(0, -1));
        expect(ag.graphProblems(fits)).toEqual([]);
    });

    it("validates a Try and a Wait for a condition", () => {
        const C = ag.CORE_NODE_CONFIGS;
        expect(C["core.try"].parse({})).toEqual({ recover: false });
        expect(C["core.try"].safeParse({ recover: "yes" }).success).toBe(false);
        const condition = { kind: "group", join: "all", items: [] };
        const wait = C["core.waitCondition"].parse({
            condition,
            timeout: { amount: 1, unit: "hours" }
        });
        expect(wait.every).toEqual({ amount: 5, unit: "minutes" });
        expect(
            C["core.waitCondition"].safeParse({
                condition,
                timeout: { amount: 1, unit: "hours" },
                every: { amount: 10, unit: "seconds" }
            }).success
        ).toBe(false);
        expect(
            C["core.waitCondition"].safeParse({
                condition,
                timeout: { amount: 31, unit: "days" }
            }).success
        ).toBe(false);
    });

    it("keeps the names Polaris sends for itself out of Announce", () => {
        const announce = ag.CORE_NODE_CONFIGS["core.announce"];
        expect(announce.safeParse({ name: ag.AUTOMATION_FINISHED_EVENT }).success).toBe(false);
        expect(announce.safeParse({ name: "automation.anything" }).success).toBe(false);
        expect(announce.safeParse({ name: "automations-done" }).success).toBe(true);
        expect(
            ag.CORE_NODE_CONFIGS["core.onEvent"].safeParse({ name: ag.AUTOMATION_FINISHED_EVENT })
                .success
        ).toBe(true);
    });

    it("round-trips a Try in the list view", () => {
        const flow: ag.ListFlow = {
            timeZone: "UTC",
            triggers: [node("t1", "core.manual")],
            steps: [
                {
                    node: node("try", "core.try", { recover: true }),
                    body: [{ node: node("a", "core.notify", { title: "a" }) }],
                    onError: [{ node: node("b", "core.notify", { title: "b" }) }],
                    always: [{ node: node("c", "core.notify", { title: "c" }) }]
                },
                { node: node("d", "core.notify", { title: "d" }) }
            ],
            finally: [],
            finallyOnCancel: false
        };
        const graph = ag.graphFromList(flow);
        expect(graph.edges).toContainEqual(edge("try", "then", "d"));
        expect(graph.edges).toContainEqual(edge("try", "catch", "b"));
        expect(ag.graphProblems(graph, { forPublish: true })).toEqual([]);
        const back = ag.listFromGraph(graph);
        expect(back).not.toBeNull();
        expect(ag.graphFromList(back!)).toEqual(graph);
        expect(ag.listStepFor(node("x", "core.try"))).toMatchObject({
            body: [],
            onError: [],
            always: []
        });
    });
});

import { describe, expect, it } from "vitest";
import * as graph from "./automation-graph.js";

const node = (id: string, type: string, config: unknown = {}): graph.GraphNode => ({ id, type, typeVersion: 1, config });
const manual = node("t1", "core.manual");
const notify = (id: string) => node(id, "core.notify", { title: "Hi", body: "" });
const cond = (left: string, op: graph.CompareOperator, right = ""): graph.ConditionGroup => ({
    kind: "group",
    join: "all",
    items: [{ kind: "compare", left, op, right }]
});

describe("admitRun", () => {
    const base = { maxRuns: 2, rateLimit: 20, active: 0, queued: 0, recent: 0 };
    it("starts single runs only when idle and skips otherwise", () => {
        expect(graph.admitRun({ ...base, mode: "single" })).toBe("start");
        expect(graph.admitRun({ ...base, mode: "single", active: 1 })).toBe("skip");
    });
    it("restarts, queues up to the cap, and runs in parallel up to the cap", () => {
        expect(graph.admitRun({ ...base, mode: "restart", active: 1 })).toBe("restart");
        expect(graph.admitRun({ ...base, mode: "queued", active: 1, queued: 1 })).toBe("queue");
        expect(graph.admitRun({ ...base, mode: "queued", active: 1, queued: 2 })).toBe("skip");
        expect(graph.admitRun({ ...base, mode: "parallel", active: 1 })).toBe("start");
        expect(graph.admitRun({ ...base, mode: "parallel", active: 2 })).toBe("skip");
    });
    it("holds back every mode past the rate limit", () => {
        for (const mode of graph.AUTOMATION_MODES) expect(graph.admitRun({ ...base, mode, recent: 20 })).toBe("limit");
    });
    it("defaults new automations to single", () => expect(graph.DEFAULT_AUTOMATION_MODE).toBe("single"));
});

describe("references", () => {
    const context = { trigger: { body: { n: 3, name: "Ana", list: ["a"] } }, steps: {} };
    it("fills text and keeps a whole reference's type", () => {
        expect(graph.interpolate("Hi {{trigger.body.name}}!", context)).toBe("Hi Ana!");
        expect(graph.referenceValue("{{ trigger.body.n }}", context)).toBe(3);
        expect(graph.interpolate("{{missing.path}}", context)).toBe("");
        expect(graph.automationReferencesIn("{{a.b}} and {{c}}")).toEqual(["a.b", "c"]);
    });
    it("never walks the prototype chain", () => {
        expect(graph.resolvePath(context, "trigger.constructor")).toBeUndefined();
        expect(graph.resolvePath(context, "trigger.body.toString")).toBeUndefined();
    });
    it("inserts references into JSON as values, not text", () => {
        expect(graph.jsonWithReferences({ a: "{{trigger.body.n}}", b: ["x {{trigger.body.name}}"] }, context)).toEqual({
            a: 3,
            b: ["x Ana"]
        });
    });
});

describe("conditions", () => {
    const context = { trigger: { n: "5", tags: ["red"], text: "Hello World" } };
    it("compares numbers as numbers and text as text", () => {
        expect(graph.checkCondition(cond("{{trigger.n}}", "gt", "4"), context)).toBe(true);
        expect(graph.checkCondition(cond("{{trigger.n}}", "eq", "5.0"), context)).toBe(true);
        expect(graph.checkCondition(cond("{{trigger.text}}", "contains", "world"), context)).toBe(true);
        expect(graph.checkCondition(cond("{{trigger.tags}}", "contains", "red"), context)).toBe(true);
        expect(graph.checkCondition(cond("{{trigger.none}}", "empty"), context)).toBe(true);
        expect(graph.checkCondition(cond("abc", "lt", "4"), context)).toBe(false);
    });
    it("joins any/all and negates", () => {
        const tree: graph.ConditionGroup = {
            kind: "group",
            join: "any",
            negate: true,
            items: [cond("1", "eq", "2"), cond("1", "eq", "1")]
        };
        expect(graph.checkCondition(tree, {})).toBe(false);
    });
    it("refuses trees deeper than four levels", () => {
        let tree: graph.ConditionGroup = cond("1", "eq", "1");
        for (let i = 0; i < 4; i++) tree = { kind: "group", join: "all", items: [tree] };
        expect(graph.conditionTreeSchema.safeParse(tree).success).toBe(false);
    });
});

describe("graph checks", () => {
    it("accepts a straight line and a Finally lane", () => {
        const g = graph.automationGraphSchema.parse({
            nodes: [manual, notify("a"), notify("z")],
            edges: [{ from: { node: "t1", port: "next" }, to: { node: "a" } }],
            finally: { entry: "z" }
        });
        expect(graph.graphProblems(g, { forPublish: true })).toEqual([]);
    });
    it("names cycles, unknown ports, edges into triggers and a lane shared with the main flow", () => {
        const g = graph.automationGraphSchema.parse({
            nodes: [manual, notify("a"), notify("b")],
            edges: [
                { from: { node: "t1", port: "next" }, to: { node: "a" } },
                { from: { node: "a", port: "next" }, to: { node: "b" } },
                { from: { node: "b", port: "next" }, to: { node: "a" } },
                { from: { node: "a", port: "then" }, to: { node: "t1" } }
            ]
        });
        const codes = graph.graphProblems(g).map((problem) => problem.code);
        expect(codes).toEqual(expect.arrayContaining(["cycle", "unknownPort", "intoTrigger"]));
        const shared = graph.automationGraphSchema.parse({
            nodes: [manual, notify("a")],
            edges: [{ from: { node: "t1", port: "next" }, to: { node: "a" } }],
            finally: { entry: "a" }
        });
        expect(graph.graphProblems(shared).map((problem) => problem.code)).toContain("finallyShared");
    });
    it("checks each core node's config and asks for a trigger before publishing", () => {
        const g = graph.automationGraphSchema.parse({ nodes: [node("h", "core.http", { url: "" })] });
        const codes = graph.graphProblems(g, { forPublish: true }).map((problem) => problem.code);
        expect(codes).toEqual(expect.arrayContaining(["badConfig", "noTrigger"]));
    });
});

describe("list view", () => {
    const flow: graph.ListFlow = {
        timeZone: "Europe/Madrid",
        triggers: [manual, node("t2", "core.schedule", { kind: "every", amount: 5, unit: "minutes" })],
        steps: [
            {
                node: node("if1", "core.if", { condition: cond("1", "eq", "1") }),
                then: [{ node: notify("a") }],
                else: [{ node: notify("b") }, { node: notify("c") }]
            },
            { node: notify("d") }
        ],
        finally: [{ node: notify("z") }],
        finallyOnCancel: false
    };
    it("round-trips through the graph", () => {
        const built = graph.graphFromList(flow);
        expect(graph.graphProblems(built, { forPublish: true })).toEqual([]);
        const back = graph.listFromGraph(built);
        expect(back?.steps.map((step) => step.node.id)).toEqual(["if1", "d"]);
        expect(back?.steps[0]?.else?.map((step) => step.node.id)).toEqual(["b", "c"]);
        expect(back?.finally.map((step) => step.node.id)).toEqual(["z"]);
        expect(back?.triggers).toHaveLength(2);
    });
    it("keeps an empty branch and an If at the end", () => {
        const built = graph.graphFromList({
            ...flow,
            steps: [{ node: node("if1", "core.if", { condition: cond("1", "eq", "1") }), then: [], else: [{ node: notify("b") }] }]
        });
        expect(graph.listFromGraph(built)?.steps[0]?.else?.[0]?.node.id).toBe("b");
    });
    it("refuses a graph the list cannot draw", () => {
        const g = graph.automationGraphSchema.parse({
            nodes: [manual, notify("a"), notify("b")],
            edges: [
                { from: { node: "t1", port: "next" }, to: { node: "a" } },
                { from: { node: "t1", port: "next" }, to: { node: "b" } }
            ]
        });
        expect(graph.listFromGraph(g)).toBeNull();
    });
});

describe("schedules", () => {
    it("finds the next daily time in the automation's zone", () => {
        const after = new Date("2026-03-28T10:00:00Z");
        const next = graph.nextScheduleDue({ kind: "daily", times: ["08:30", "12:00"], days: [] }, after, "Europe/Madrid");
        expect(next?.toISOString()).toBe("2026-03-28T11:00:00.000Z");
    });
    it("steps an interval and reads cron", () => {
        const after = new Date("2026-01-01T00:00:00Z");
        expect(graph.nextScheduleDue({ kind: "every", amount: 2, unit: "hours" }, after, "UTC")?.toISOString()).toBe(
            "2026-01-01T02:00:00.000Z"
        );
        expect(graph.nextScheduleDue({ kind: "cron", expression: "15 * * * *" }, after, "UTC")?.toISOString()).toBe(
            "2026-01-01T00:15:00.000Z"
        );
    });
});

describe("stored data", () => {
    it("truncates oversized values with a marker", () => {
        const big = graph.capStored({ text: "x".repeat(5000) }, 1000) as Record<string, unknown>;
        expect(big[graph.TRUNCATED_MARKER]).toBe(true);
        expect(graph.capStored({ a: 1 }, 1000)).toEqual({ a: 1 });
    });
    it("redacts secrets anywhere in a value", () => {
        expect(graph.redactSecrets({ url: "https://h/hook/SECRETVALUE", list: ["Bearer SECRETVALUE"] }, ["SECRETVALUE"])).toEqual({
            url: "https://h/hook/[secret]",
            list: ["Bearer [secret]"]
        });
        expect(graph.maskSecretUrl("https://hooks.slack.com/services/T0/B0/abcd1234")).toBe("https://hooks.slack.com/...1234");
    });
    it("normalizes names and validates secret values", () => {
        expect(graph.automationCreateSchema.parse({ name: "  Door   alert " }).name).toBe("Door alert");
        expect(graph.secretCreateSchema.safeParse({ name: "x", kind: "url", value: "not a url" }).success).toBe(false);
        expect(graph.secretCreateSchema.safeParse({ name: "x", kind: "basic", value: "user:pass" }).success).toBe(true);
    });
});

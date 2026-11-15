/**
 * The checks the editor shows and the server applies before a save, a
 * publish and a call.
 *
 * Pinned: loops of connections, calls that come back (to itself, or through
 * other saved automations), a trigger the automation's own steps fire again
 * with no condition between, steps nothing reaches, references to steps that
 * are not there or run later, unfinished settings, and conditions that can
 * never hold - graded so errors block and warnings do not. At run time a call
 * back into its own chain is refused before the depth limit.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";

const runs = vi.hoisted(
    () => new Map<string, { automationId: string; parentRunId: string | null }>()
);
vi.mock("@polaris/db", () => ({
    prisma: {
        automationRun: {
            findUnique: async ({ where }: { where: { id: string } }) => runs.get(where.id) ?? null
        }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));

const { callCycle } = await import("@/lib/automations/calls");
const { callsBackIntoChain } = await import("@/lib/automations/calls");

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

type N = { id: string; type: string; config?: unknown };
function graph(nodes: N[], edges: [string, string, string?][]): core.AutomationGraph {
    return core.automationGraphSchema.parse({
        ...core.emptyGraph(),
        nodes: nodes.map((node) => ({ config: {}, ...node })),
        edges: edges.map(([from, to, port]) => ({
            from: { node: from, port: port ?? "next" },
            to: { node: to }
        }))
    });
}
const codes = (issues: core.AutomationIssue[]) =>
    issues.map((issue) => `${issue.severity}:${issue.code}:${issue.node ?? ""}`);
const notify = (id: string, body = "") => ({
    id,
    type: "core.notify",
    config: { title: "T", body }
});
const run = (id: string, target: string) => ({
    id,
    type: "core.run",
    config: { automationId: target, inputs: [], wait: true }
});

describe("automationIssues", () => {
    it("finds a loop of connections", () => {
        const g = graph(
            [{ id: "t", type: "core.manual" }, notify("a"), notify("b")],
            [
                ["t", "a"],
                ["a", "b"],
                ["b", "a"]
            ]
        );
        expect(codes(core.automationIssues(g))).toContain("error:cycle:a");
    });

    it("flags a call to itself", () => {
        const g = graph([{ id: "t", type: "core.manual" }, run("r", A)], [["t", "r"]]);
        expect(codes(core.automationIssues(g, { automationId: A }))).toContain("error:selfCall:r");
        expect(codes(core.automationIssues(g, { automationId: B }))).not.toContain("error:selfCall:r");
    });

    it("flags a step that fires the automation's own trigger, unless a condition guards it", () => {
        const on = { id: "t", type: "core.onEvent", config: { name: "crm.updated", outcomes: [] } };
        const announce = {
            id: "s",
            type: "core.announce",
            config: { name: "crm.updated", payload: [] }
        };
        const bare = graph([on, announce], [["t", "s"]]);
        expect(codes(core.automationIssues(bare))).toContain("error:selfTrigger:s");

        const guard = {
            id: "g",
            type: "core.if",
            config: {
                condition: {
                    kind: "group",
                    join: "all",
                    items: [{ kind: "compare", left: "{{trigger.payload.by}}", op: "ne", right: "me" }]
                }
            }
        };
        const guarded = graph(
            [on, guard, announce],
            [
                ["t", "g"],
                ["g", "s", "then"]
            ]
        );
        expect(codes(core.automationIssues(guarded))).not.toContain("error:selfTrigger:s");

        const other = graph(
            [on, { ...announce, config: { name: "crm.created", payload: [] } }],
            [["t", "s"]]
        );
        expect(codes(core.automationIssues(other))).not.toContain("error:selfTrigger:s");
    });

    it("warns about steps no trigger reaches, without blocking", () => {
        const g = graph([{ id: "t", type: "core.manual" }, notify("a"), notify("loose")], [["t", "a"]]);
        const issues = core.automationIssues(g);
        expect(codes(issues)).toContain("warning:unreachable:loose");
        expect(core.blockingIssues(issues)).toEqual([]);
    });

    it("finds unfinished settings, as an error", () => {
        const g = graph(
            [
                { id: "t", type: "core.manual" },
                { id: "d", type: "core.aiDecide", config: { input: "", cases: [] } }
            ],
            [["t", "d"]]
        );
        expect(codes(core.automationIssues(g))).toContain("error:badConfig:d");
    });

    it("finds references to a step that is missing or runs later", () => {
        const g = graph(
            [
                { id: "t", type: "core.manual" },
                notify("a", "{{steps.b.sent}} {{steps.ghost.text}}"),
                notify("b", "{{steps.a.nope}}")
            ],
            [
                ["t", "a"],
                ["a", "b"]
            ]
        );
        const found = codes(core.automationIssues(g));
        expect(found).toContain("error:laterReference:a");
        expect(found).toContain("error:missingReference:a");
        expect(found).toContain("warning:unknownOutput:b");
    });

    it("warns about conditions that can never all hold", () => {
        const condition = (items: unknown[]) => ({
            id: "c",
            type: "core.if",
            config: { condition: { kind: "group", join: "all", items } }
        });
        const leaf = (op: string, right: string) => ({
            kind: "compare",
            left: "{{trigger.payload.n}}",
            op,
            right
        });
        const check = (items: unknown[]) =>
            codes(core.automationIssues(graph([{ id: "t", type: "core.manual" }, condition(items)], [["t", "c"]])));
        expect(check([leaf("gt", "10"), leaf("lt", "5")])).toContain("warning:contradiction:c");
        expect(check([leaf("eq", "a"), leaf("eq", "b")])).toContain("warning:contradiction:c");
        expect(check([leaf("empty", ""), leaf("notEmpty", "")])).toContain("warning:contradiction:c");
        expect(check([leaf("gt", "5"), leaf("lt", "10")])).not.toContain("warning:contradiction:c");
    });
});

describe("callCycle", () => {
    const saved = new Map<string, core.AutomationGraph>();
    const published = async (id: string) => saved.get(id) ?? null;
    const caller = (target: string) =>
        graph([{ id: "t", type: "core.called" }, run("r", target)], [["t", "r"]]);

    it("finds a direct loop A -> B -> A", async () => {
        saved.clear();
        saved.set(B, caller(A));
        expect(await callCycle(A, caller(B), published)).toEqual({ node: "r" });
    });

    it("finds an indirect loop A -> B -> C -> A", async () => {
        saved.clear();
        saved.set(B, caller(C));
        saved.set(C, caller(A));
        expect(await callCycle(A, caller(B), published)).toEqual({ node: "r" });
    });

    it("lets a chain that ends through", async () => {
        saved.clear();
        saved.set(B, caller(C));
        expect(await callCycle(A, caller(B), published)).toBeNull();
    });
});

describe("callsBackIntoChain", () => {
    it("refuses a call to an automation already running up the chain", async () => {
        runs.clear();
        runs.set("r1", { automationId: A, parentRunId: null });
        runs.set("r2", { automationId: B, parentRunId: "r1" });
        runs.set("r3", { automationId: C, parentRunId: "r2" });
        const at = { id: "r3", automation: { id: C } };
        expect(await callsBackIntoChain(at, A)).toBe(true);
        expect(await callsBackIntoChain(at, B)).toBe(true);
        expect(await callsBackIntoChain(at, C)).toBe(true);
        expect(await callsBackIntoChain(at, "00000000-0000-4000-8000-00000000000d")).toBe(false);
    });

    it("stops walking at the depth limit", async () => {
        runs.clear();
        for (let index = 0; index < 20; index++)
            runs.set(`r${index}`, {
                automationId: `x${index}`,
                parentRunId: index === 0 ? null : `r${index - 1}`
            });
        expect(await callsBackIntoChain({ id: "r19", automation: { id: "x19" } }, "x0")).toBe(false);
    });
});

/**
 * A CRM workflow read as a central automation: one node per action, checks
 * branching on "then" and "else", and nothing lost on the way.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as nodes from "@polaris-app/crm/src/model/automation-nodes";

const ORG = "11111111-1111-4111-8111-111111111111";
const LIST = "22222222-2222-4222-8222-222222222222";
const WHEN = { conjunction: "and", rules: [] };

function row(trigger: unknown, actions: unknown[], orgId: string | null = ORG) {
    return {
        id: "33333333-3333-4333-8333-333333333333",
        orgId,
        object: "companies",
        trigger: JSON.stringify(trigger),
        actions: JSON.stringify(actions)
    };
}

function converted(trigger: unknown, actions: unknown[]) {
    const result = nodes.convertWorkflow(row(trigger, actions));
    if (!result.ok) throw new Error(`not converted: ${result.reason}`);
    return result.graph;
}

const types = (graph: core.AutomationGraph) => graph.nodes.map((node) => node.type);

describe("convertWorkflow", () => {
    it("keeps the trigger, the shelf and the kind of record on every node", () => {
        const graph = converted({ kind: "created" }, [
            { kind: "updateRecord", values: { city: "Madrid" } }
        ]);
        expect(types(graph)).toEqual([nodes.TRIGGER_NODE_TYPE, "crm.action.updateRecord"]);
        expect(graph.nodes[0]!.config).toEqual({
            orgId: ORG,
            object: "companies",
            trigger: { kind: "created" }
        });
        expect(graph.nodes[1]!.config).toMatchObject({
            orgId: ORG,
            object: "companies",
            action: { kind: "updateRecord", values: { city: "Madrid" } }
        });
        expect(graph.edges).toEqual([
            { from: { node: graph.nodes[0]!.id, port: "next" }, to: { node: graph.nodes[1]!.id } }
        ]);
        expect(core.graphProblems(graph, { forPublish: true })).toEqual([]);
    });

    it("turns a filter into a check with nothing on else", () => {
        const graph = converted({ kind: "updated" }, [
            { kind: "filter", when: WHEN },
            { kind: "createTask", listId: LIST, name: "Call", dueInDays: 2 }
        ]);
        const check = graph.nodes[1]!;
        expect(check.type).toBe(nodes.CONDITION_NODE_TYPE);
        expect(graph.edges.filter((edge) => edge.from.node === check.id)).toEqual([
            { from: { node: check.id, port: "then" }, to: { node: graph.nodes[2]!.id } }
        ]);
    });

    it("joins both ways of an if/else at the action after it", () => {
        const graph = converted({ kind: "fieldChanged", field: "stage", to: null }, [
            {
                kind: "ifElse",
                when: WHEN,
                then: [{ kind: "httpRequest", url: "https://example.test/a" }],
                otherwise: []
            },
            { kind: "delay", minutes: 90 },
            {
                kind: "waitFor",
                when: WHEN,
                days: 3,
                onTimeout: "continue"
            }
        ]);
        const [, check, http, wait, waitFor] = graph.nodes;
        expect(types(graph)).toEqual([
            nodes.TRIGGER_NODE_TYPE,
            nodes.CONDITION_NODE_TYPE,
            "crm.action.httpRequest",
            "core.wait",
            nodes.WAIT_NODE_TYPE
        ]);
        expect(wait!.config).toEqual({
            kind: "duration",
            duration: { amount: 90, unit: "minutes" }
        });
        expect(waitFor!.config).toMatchObject({ days: 3, onTimeout: "continue" });
        const into = (id: string) =>
            graph.edges.filter((edge) => edge.to.node === id).map((edge) => edge.from);
        expect(into(wait!.id)).toEqual([
            { node: http!.id, port: "next" },
            { node: check!.id, port: "else" }
        ]);
        expect(core.graphProblems(graph, { forPublish: true })).toEqual([]);
    });

    it("keeps a schedule's time zone on the automation", () => {
        const graph = converted(
            { kind: "schedule", cron: "0 9 * * 1", timeZone: "Europe/Madrid" },
            [{ kind: "notify", to: ["field:owner"], title: "Monday", body: "" }]
        );
        expect(graph.timeZone).toBe("Europe/Madrid");
    });

    it("leaves a workflow it cannot read where it is", () => {
        expect(nodes.convertWorkflow({ ...row({ kind: "created" }, []), trigger: "{" })).toEqual({
            ok: false,
            reason: "unreadable"
        });
        expect(nodes.convertWorkflow({ ...row({ kind: "created" }, []), object: "pets" }).ok).toBe(
            false
        );
        expect(
            nodes.convertWorkflow(row({ kind: "created" }, [{ kind: "teleport" }])).ok
        ).toBe(false);
    });
});

describe("node configs", () => {
    it("refuses a step whose action is of another kind", () => {
        const config = nodes.stepNodeConfig("notify");
        expect(
            config.safeParse({
                orgId: null,
                object: "people",
                action: { kind: "httpRequest", url: "https://example.test" }
            }).success
        ).toBe(false);
        expect(nodes.stepKindOf("crm.action.notify")).toBe("notify");
        expect(nodes.stepKindOf("crm.action.delay")).toBeNull();
    });

    it("reads the CRM cause of a run and nothing else", () => {
        expect(nodes.causeOf({ crm: { object: "people", recordId: "x", event: null } })).toEqual({
            object: "people",
            recordId: "x",
            event: null
        });
        expect(nodes.causeOf({ kind: "schedule" })).toBeNull();
        expect(nodes.causeOf({ crm: { object: "pets" } })).toBeNull();
    });
});

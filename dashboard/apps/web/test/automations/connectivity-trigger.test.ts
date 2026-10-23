/**
 * The connectivity triggers: armed by the event they name, the ready-made
 * "Tell me when the internet comes back" graph is publishable, and what each
 * event carries matches the fields the editor offers as `trigger.*`.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import { connectivityPayloadSchemas } from "@/lib/connectivity/line-samples";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("@/lib/automations/engine", () => ({
    loadGraph: async () => null,
    startRun: async () => null
}));
vi.mock("@/lib/automations/runner", () => ({ automationRunner: async () => null }));

const triggers = await import("@/lib/automations/triggers");

const WORDS = { title: "The internet is back", body: "It was down for {{trigger.durationSeconds}} seconds." };

describe("connectivity triggers", () => {
    it("arms on the event it names", () => {
        const graph = core.emptyGraph("UTC");
        graph.nodes.push({
            id: "conn1",
            type: "core.connectivity",
            typeVersion: 1,
            config: { event: "ipChanged" }
        });
        const armed = triggers.armedTriggers("a1", graph, [], new Date());
        expect(armed).toEqual([
            expect.objectContaining({
                nodeId: "conn1",
                eventType: "core.connectivity",
                subjectKey: "ipChanged"
            })
        ]);
    });

    it("refuses an event that does not exist", () => {
        expect(
            core.connectivityTriggerConfigSchema.safeParse({ event: "sideways" }).success
        ).toBe(false);
    });

    it("builds a publishable 'internet comes back' automation", () => {
        const graph = core.internetBackGraph("Europe/Madrid", WORDS);
        expect(core.automationGraphSchema.safeParse(graph).success).toBe(true);
        expect(core.graphProblems(graph, { forPublish: true })).toEqual([]);
        expect(graph.nodes.map((node) => node.type)).toEqual(["core.connectivity", "core.notify"]);
        expect(graph.nodes[0]!.config).toEqual({ event: "up" });
    });

    it("hands every payload field to the editor's trigger fields", () => {
        const offered = new Set(core.CORE_NODE_OUTPUT_PATHS["core.connectivity"]);
        for (const schema of Object.values(connectivityPayloadSchemas))
            for (const key of Object.keys(schema.shape)) expect(offered.has(key)).toBe(true);
    });
});

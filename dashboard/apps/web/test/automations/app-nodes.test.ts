/**
 * An app's nodes in the central engine: the bridge an app moves its own
 * automations through (once, by `legacyRef`), its triggers armed and handed
 * back to it, a firing it decides starting a run, a step that rechecks until
 * the app wakes it, a check that fails with nowhere to go ending the run
 * skipped, a stop ending it stopped - and an app that is not installed
 * refusing the run instead of failing it.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { createFakeDb } from "./fixtures/fake-prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));
const app = vi.hoisted(() => ({
    installed: true,
    holds: false,
    reached: false,
    onTimeout: "stop" as "stop" | "continue",
    timedOut: false
}));

vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({
    automationRunner: async () => ({ id: "u1", isAdmin: false }),
    mayAllowLocalNetwork: async () => false
}));
vi.mock("@/lib/automations/secrets", () => ({ readSecretForRun: async () => "" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));
vi.mock("@/lib/app-extensions/registry", () => ({
    appAutomationNodes: async () => {
        if (!app.installed) return [];
        const meta = { role: "action", ports: [], idempotent: true } as never;
        return [
            { type: "fixture.trigger.ping", meta, config: z.object({ every: z.number() }) },
            {
                type: "fixture.condition.check",
                meta,
                config: z.object({}),
                run: async (_config: unknown, _context: unknown, io: { leads: (port: string) => boolean }) => {
                    if (!app.holds && !io.leads("else"))
                        return { stop: { as: "skipped", reason: "conditions" } };
                    return { output: { holds: app.holds }, port: app.holds ? "then" : "else" };
                }
            },
            {
                type: "fixture.action.wait",
                meta,
                config: z.object({}),
                run: async () => {
                    if (app.reached) return { output: { reached: true } };
                    if (!app.timedOut)
                        return { wait: { until: new Date(Date.now() + 60_000), recheck: "recheck:fixture" } };
                    return app.onTimeout === "stop"
                        ? { stop: { as: "succeeded", reason: "timedOut" } }
                        : { output: { reached: false, timedOut: true } };
                }
            },
            { type: "fixture.action.say", meta, config: z.object({}), run: async () => ({ output: { said: true } }) }
        ];
    }
}));

const engine = await import("@/lib/automations/engine");
const bridge = await import("@/lib/automations/app-bridge");

const fake = () => db.current!;
const node = (id: string, type: string, config: unknown = {}): core.GraphNode => ({
    id,
    type,
    typeVersion: 1,
    config
});

function graphOf(nodes: core.GraphNode[], edges: [string, string, string][]): core.AutomationGraph {
    const graph = core.emptyGraph("UTC");
    graph.nodes = nodes;
    graph.edges = edges.map(([from, port, to]) => ({ from: { node: from, port }, to: { node: to } }));
    return graph;
}

const OWNER = "00000000-0000-4000-8000-000000000001";

function imported(graph: core.AutomationGraph, legacyRef = "fixture:one") {
    return bridge.importLegacyAutomation({
        legacyRef,
        name: "Moved",
        enabled: true,
        ownerId: OWNER,
        origin: "fixture",
        originRef: "place-1",
        mode: "parallel",
        graph
    });
}

const run = (id: string) => fake().tables.automationRun!.find((row) => row.id === id)!;
const runs = () => fake().tables.automationRun ?? [];
const step = (runId: string, nodeId: string) =>
    (fake().tables.automationStep ?? []).find((row) => row.runId === runId && row.nodeId === nodeId);
const settle = async () => {
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const CHECKED = graphOf(
    [node("t1", "fixture.trigger.ping", { every: 5 }), node("c1", "fixture.condition.check"), node("s1", "fixture.action.say")],
    [
        ["t1", "next", "c1"],
        ["c1", "then", "s1"]
    ]
);

beforeEach(() => {
    fake().reset();
    engine.resumeClaiming();
    Object.assign(app, { installed: true, holds: false, reached: false, onTimeout: "stop", timedOut: false });
});

describe("importLegacyAutomation", () => {
    it("publishes version 1, arms the app trigger, and answers the same id the second time", async () => {
        const id = await imported(CHECKED);
        const automation = fake().tables.automation!.find((row) => row.id === id)!;
        expect(automation).toMatchObject({ mode: "parallel", origin: "fixture", legacyRef: "fixture:one", enabled: true, userId: OWNER, runAsId: OWNER });
        expect(automation.publishedVersionId).toBeTruthy();
        expect(fake().tables.automationVersion).toHaveLength(1);
        expect(fake().tables.automationTrigger).toEqual([
            expect.objectContaining({ automationId: id, nodeId: "t1", eventType: "fixture.trigger.ping", subjectKey: null })
        ]);
        expect(await imported(CHECKED)).toBe(id);
        expect(fake().tables.automation).toHaveLength(1);
        expect(fake().tables.automationVersion).toHaveLength(1);
        expect(await bridge.automationForLegacy("fixture:one")).toBe(id);
        expect(await bridge.automationsForLegacy(["fixture:one", "fixture:none"])).toEqual({ "fixture:one": id });
        expect(await bridge.legacySummaries(["fixture:one", "fixture:none"])).toEqual({
            "fixture:one": { id, name: "Moved", enabled: true, lastRunAt: null, lastStatus: null }
        });
        expect(await bridge.legacySummaries([])).toEqual({});
    });

    it("refuses a graph that is not one", async () => {
        await expect(imported({ nope: true } as never)).rejects.toThrow();
        expect(fake().tables.automation ?? []).toHaveLength(0);
    });
});

describe("appTriggers and fireAppTrigger", () => {
    it("lists the app's armed triggers with their config, and only while enabled", async () => {
        const id = await imported(CHECKED);
        const rows = await bridge.appTriggers("fixture");
        expect(rows).toEqual([
            expect.objectContaining({ automationId: id, nodeId: "t1", type: "fixture.trigger.ping", config: { every: 5 }, timeZone: "UTC", legacyRef: "fixture:one" })
        ]);
        expect(await bridge.appTriggers("other")).toEqual([]);
        await fake().prisma.automation.update({ where: { id }, data: { enabled: false } });
        expect(await bridge.appTriggers("fixture")).toEqual([]);
    });

    it("starts one run per firing key", async () => {
        const id = await imported(CHECKED);
        app.holds = true;
        expect(await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: { kind: "ping" }, depth: 0 })).toBe(true);
        // The same firing again answers the run it already started.
        expect(await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: { kind: "ping" }, depth: 0 })).toBe(true);
        await settle();
        expect(runs()).toHaveLength(1);
        expect(run(runs()[0]!.id as string)).toMatchObject({ status: "succeeded" });
        expect(step(runs()[0]!.id as string, "s1")).toMatchObject({ status: "ok" });
    });
});

describe("outcomes an app node asks for", () => {
    it("a check that fails with nothing on else ends the run skipped", async () => {
        const id = await imported(CHECKED);
        await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: {}, depth: 0 });
        await settle();
        const only = runs()[0]!;
        expect(run(only.id as string).status).toBe("skipped");
        expect(step(only.id as string, "s1")).toBeUndefined();
    });

    it("a check that fails with something on else goes there and succeeds", async () => {
        const graph = graphOf(
            [...CHECKED.nodes, node("e1", "fixture.action.say")],
            [
                ["t1", "next", "c1"],
                ["c1", "then", "s1"],
                ["c1", "else", "e1"]
            ]
        );
        const id = await imported(graph);
        await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: {}, depth: 0 });
        await settle();
        const only = runs()[0]!;
        expect(run(only.id as string).status).toBe("succeeded");
        expect(step(only.id as string, "e1")).toMatchObject({ status: "ok" });
    });

    const WAITING = graphOf(
        [node("t1", "fixture.trigger.ping", { every: 5 }), node("w1", "fixture.action.wait"), node("s1", "fixture.action.say")],
        [
            ["t1", "next", "w1"],
            ["w1", "next", "s1"]
        ]
    );

    it("a recheck wait holds until the app wakes it, then carries on", async () => {
        const id = await imported(WAITING);
        await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: {}, depth: 0 });
        await settle();
        const runId = runs()[0]!.id as string;
        expect(step(runId, "w1")).toMatchObject({ status: "waiting", waitKey: "recheck:fixture" });
        expect(run(runId).status).toBe("waiting");
        await bridge.wakeAppWaits("other");
        await settle();
        expect(step(runId, "w1")).toMatchObject({ status: "waiting" });
        app.reached = true;
        await bridge.wakeAppWaits("fixture");
        await settle();
        expect(run(runId).status).toBe("succeeded");
        expect(step(runId, "s1")).toMatchObject({ status: "ok" });
    });

    it("a wait that times out with stop ends the run stopped, nothing after it done", async () => {
        const id = await imported(WAITING);
        app.timedOut = true;
        await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: {}, depth: 0 });
        await settle();
        const runId = runs()[0]!.id as string;
        expect(run(runId).status).toBe("stopped");
        expect(step(runId, "s1")).toBeUndefined();
    });

    it("a wait that times out with continue goes on", async () => {
        const id = await imported(WAITING);
        Object.assign(app, { timedOut: true, onTimeout: "continue" });
        await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: {}, depth: 0 });
        await settle();
        const runId = runs()[0]!.id as string;
        expect(run(runId).status).toBe("succeeded");
        expect(step(runId, "s1")).toMatchObject({ status: "ok" });
    });

    it("an app that is not installed refuses the run at its first node", async () => {
        const id = await imported(CHECKED);
        app.installed = false;
        await bridge.fireAppTrigger({ automationId: id, nodeId: "t1", firingKey: "k1", cause: {}, depth: 0 });
        await settle();
        const runId = runs()[0]!.id as string;
        expect(run(runId)).toMatchObject({ status: "refused", error: "appMissing" });
        expect(step(runId, "c1")).toMatchObject({ status: "refused", error: "appMissing" });
    });
});

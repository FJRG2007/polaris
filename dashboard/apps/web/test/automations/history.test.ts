/**
 * Test runs, running again, the paged runs list, one run's steps and the
 * version history, against the in-memory database the engine tests use.
 */

import * as core from "@polaris/core";
import { createFakeDb } from "./fixtures/fake-prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));
const sent = vi.hoisted(() => ({ requests: [] as string[] }));
const access = vi.hoisted(() => ({ edit: true }));

vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({
    automationRunner: async () => ({ id: "u1", isAdmin: false }),
    mayReadShelf: async () => true,
    mayEditShelf: async () => access.edit,
    mayAllowLocalNetwork: async () => false
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/automations/secrets", () => ({ readSecretForRun: async () => "https://hooks.example.test/SECRET" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));
vi.mock("@/lib/safe-fetch", () => ({
    RefusedAddressError: class extends Error {},
    resolveName: async () => [],
    safeUrl: (value: string) => new URL(value),
    readCapped: async (response: Response) => new Uint8Array(await response.arrayBuffer()),
    configuredRequest: async (url: string) => {
        sent.requests.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
}));

const engine = await import("@/lib/automations/engine");
const history = await import("@/lib/automations/history");
const service = await import("@/lib/automations/service");

const fake = () => db.current!;
const actor = { id: "u1", isAdmin: false };
const node = (id: string, type: string, config: unknown = {}, extra: Partial<core.GraphNode> = {}): core.GraphNode => ({ id, type, typeVersion: 1, config, ...extra });
const http = (id: string, extra: Partial<core.GraphNode> = {}) =>
    node(id, "core.http", { method: "POST", url: "https://api.example.test/{{trigger.name}}", urlSecretId: null }, extra);
const say = (id: string) => node(id, "core.notify", { title: "Hi {{steps.h.body.id}}", body: "" });

function graphOf(nodes: core.GraphNode[], edges: [string, string][]): core.AutomationGraph {
    return {
        ...core.emptyGraph("UTC"),
        nodes,
        edges: edges.map(([from, to]) => ({ from: { node: from, port: "next" }, to: { node: to } }))
    };
}

async function seed(draft: core.AutomationGraph, extra: Record<string, unknown> = {}) {
    const row = await fake().prisma.automation.create({ data: { name: "Test", draft, enabled: false, userId: "u1", mode: "single", ...extra } });
    return row.id as string;
}

/** Step a run until it ends: the editor's kick and this loop share the lease, so whichever holds it steps it. */
async function settle(runId: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
        await engine.advanceRun(runId);
        const row = fake().tables.automationRun!.find((entry) => entry.id === runId)!;
        if (core.runFinished(row.status as string)) return row;
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("run never ended");
}

beforeEach(() => {
    fake().reset();
    sent.requests = [];
    access.edit = true;
    engine.resumeClaiming();
});

describe("test runs of the draft", () => {
    it("starts from the trigger's pinned sample and uses a pinned node instead of running it", async () => {
        const id = await seed(
            graphOf(
                [node("t1", "core.manual", {}, { pinned: { name: "ada" } }), http("h", { pinned: { status: 201, body: { id: 7 } } }), say("n")],
                [
                    ["t1", "h"],
                    ["h", "n"]
                ]
            )
        );
        const answer = await history.startTestRun(actor, id);
        expect("runId" in answer).toBe(true);
        const runId = (answer as { runId: string }).runId;
        const run = await settle(runId);
        expect(run.status).toBe("succeeded");
        expect(run.test).toBe(true);
        expect(sent.requests).toEqual([]);

        const detail = await history.getRun(actor, runId);
        const out = (nodeId: string) => detail.steps.find((step) => step.nodeId === nodeId)?.output as Record<string, unknown>;
        expect(out("t1").name).toBe("ada");
        expect(out("h")).toEqual({ status: 201, body: { id: 7 } });
        expect(detail.steps.find((step) => step.nodeId === "n")?.input).toEqual({ title: "Hi 7", body: "" });
        expect(detail.versionNumber).toBeNull();
        // A test run is not the automation's last run.
        expect(fake().tables.automation![0]!.lastRunAt ?? null).toBeNull();
    });

    it("really runs a node that has no pin, with the trigger's sample filled in", async () => {
        const id = await seed(graphOf([node("t1", "core.manual", {}, { pinned: { name: "ada" } }), http("h")], [["t1", "h"]]));
        const { runId } = (await history.startTestRun(actor, id)) as { runId: string };
        await settle(runId);
        expect(sent.requests).toEqual(["https://api.example.test/ada"]);
    });

    it("refuses a draft that could not be published, and a reader", async () => {
        const id = await seed(graphOf([say("n")], []));
        const answer = await history.startTestRun(actor, id);
        expect(answer).toEqual({ problems: [{ code: "noTrigger" }] });
        access.edit = false;
        await expect(history.startTestRun(actor, id)).rejects.toMatchObject({ code: "forbidden" });
    });

    it("never counts against the mode: a live single run still starts", async () => {
        const draft = graphOf([node("t1", "core.manual"), node("w", "core.wait", { kind: "duration", duration: { amount: 1, unit: "hours" } })], [["t1", "w"]]);
        const id = await seed(draft);
        const { runId } = (await history.startTestRun(actor, id)) as { runId: string };
        for (let attempt = 0; attempt < 20; attempt++) await engine.advanceRun(runId);
        const version = await fake().prisma.automationVersion.create({ data: { automationId: id, number: 1, graph: draft } });
        const live = await engine.startRun({ automationId: id, versionId: version.id, triggerNodeId: "t1", firingKey: "live", cause: {}, depth: 0 });
        expect(live?.status).toBe("running");
    });

    it("numbers snapshots below zero, keeps the newest twenty, and publishing still numbers from one", async () => {
        const id = await seed(graphOf([node("t1", "core.manual", {}, { pinned: { a: 1 } })], []));
        for (let index = 0; index < 22; index++) await history.startTestRun(actor, id);
        const tests = fake().tables.automationRun!.filter((row) => row.test);
        expect(tests).toHaveLength(core.AUTOMATION_LIMITS.keepTestRuns);
        const snapshots = fake().tables.automationVersion!.filter((row) => (row.number as number) < 0);
        expect(snapshots.length).toBeLessThanOrEqual(core.AUTOMATION_LIMITS.keepTestRuns);

        expect(await service.publishAutomation(actor, id)).toEqual([]);
        const versions = await history.listVersions(actor, id);
        expect(versions.map((version) => version.number)).toEqual([1]);
        expect(versions[0]!.live).toBe(true);
        const published = fake().tables.automationVersion!.find((row) => row.number === 1)!;
        expect((published.graph as core.AutomationGraph).nodes[0]!.pinned).toBeUndefined();
    });
});

describe("runs list, one run, running again", () => {
    it("pages newest first with no repeats and leaves test runs out", async () => {
        const draft = graphOf([node("t1", "core.manual")], []);
        const id = await seed(draft, { enabled: true });
        const version = await fake().prisma.automationVersion.create({ data: { automationId: id, number: 1, graph: draft } });
        const base = Date.UTC(2026, 9, 1);
        for (let index = 0; index < 55; index++)
            await fake().prisma.automationRun.create({
                data: { automationId: id, versionId: version.id, status: "succeeded", triggerNodeId: "t1", cause: {}, firingKey: `k${index}`, queuedAt: new Date(base + index * 1000), test: index === 54 }
            });
        const shelf = { orgId: null, userId: "u1" };
        const first = await history.listRuns(actor, shelf);
        expect(first.rows).toHaveLength(core.AUTOMATION_LIMITS.runsPage);
        expect(first.next).not.toBeNull();
        const second = await history.listRuns(actor, shelf, undefined, { cursor: first.next! });
        expect(second.rows).toHaveLength(4);
        expect(second.next).toBeNull();
        const ids = [...first.rows, ...second.rows].map((row) => row.id);
        expect(new Set(ids).size).toBe(54);
        expect(first.rows[0]!.queuedAt > first.rows[1]!.queuedAt).toBe(true);
        const failed = await history.listRuns(actor, shelf, undefined, { filter: "failed" });
        expect(failed.rows).toEqual([]);
    });

    it("hides step data from a reader who may not edit, and test runs entirely", async () => {
        const id = await seed(graphOf([node("t1", "core.manual", {}, { pinned: { secret: "x" } })], []));
        const { runId } = (await history.startTestRun(actor, id)) as { runId: string };
        await settle(runId);
        access.edit = false;
        await expect(history.getRun(actor, runId)).rejects.toMatchObject({ code: "notFound" });
    });

    it("runs a run again with its trigger data, on the version it ran or the live one", async () => {
        const draft = graphOf([node("t1", "core.manual"), say("n")], [["t1", "n"]]);
        const id = await seed(draft, { enabled: true });
        const v1 = await fake().prisma.automationVersion.create({ data: { automationId: id, number: 1, graph: draft } });
        await fake().prisma.automation.update({ where: { id }, data: { publishedVersionId: v1.id } });
        const first = await engine.startRun({ automationId: id, versionId: v1.id, triggerNodeId: "t1", firingKey: "one", cause: { id: "t1", name: "ada" }, depth: 0 });
        await settle(first!.id);

        const again = await history.rerun(actor, first!.id, "same");
        const row = await settle(again);
        expect((row.cause as Record<string, unknown>).name).toBe("ada");
        expect(row.versionId).toBe(v1.id);

        const reader = await history.getRun({ id: "u1", isAdmin: false }, again);
        expect(reader.canRerun).toBe(true);
        access.edit = false;
        const hidden = await history.getRun(actor, again);
        expect(hidden.canSeeData).toBe(false);
        expect(hidden.steps.every((step) => step.output === null && step.input === null)).toBe(true);
        await expect(history.rerun(actor, first!.id, "published")).rejects.toMatchObject({ code: "forbidden" });
    });

    it("refuses to run again on a version that lost the trigger", async () => {
        const draft = graphOf([node("t1", "core.manual")], []);
        const id = await seed(draft, { enabled: true });
        const v1 = await fake().prisma.automationVersion.create({ data: { automationId: id, number: 1, graph: draft } });
        const v2 = await fake().prisma.automationVersion.create({ data: { automationId: id, number: 2, graph: graphOf([node("t2", "core.manual")], []) } });
        await fake().prisma.automation.update({ where: { id }, data: { publishedVersionId: v2.id } });
        const first = await engine.startRun({ automationId: id, versionId: v1.id, triggerNodeId: "t1", firingKey: "one", cause: {}, depth: 0 });
        await expect(history.rerun(actor, first!.id, "published")).rejects.toMatchObject({ code: "triggerGone" });
    });
});

describe("versions", () => {
    it("restores a published version into the draft and never a test snapshot", async () => {
        const id = await seed(graphOf([node("t1", "core.manual")], []));
        const old = graphOf([node("t9", "core.schedule", { kind: "every", amount: 5, unit: "minutes" })], []);
        const v1 = await fake().prisma.automationVersion.create({ data: { automationId: id, number: 1, graph: old } });
        const snapshot = await fake().prisma.automationVersion.create({ data: { automationId: id, number: -1, graph: old } });
        const restored = await history.restoreVersion(actor, id, v1.id);
        expect(restored.nodes[0]!.id).toBe("t9");
        expect((fake().tables.automation![0]!.draft as core.AutomationGraph).nodes[0]!.id).toBe("t9");
        await expect(history.restoreVersion(actor, id, snapshot.id)).rejects.toMatchObject({ code: "notFound" });
        access.edit = false;
        await expect(history.restoreVersion(actor, id, v1.id)).rejects.toMatchObject({ code: "forbidden" });
    });
});

describe("cursor", () => {
    it("reads only what it wrote", () => {
        const id = "0b6f5c1e-7d1a-4c8e-9a51-3f2b8f0d6c11";
        expect(history.readCursor(`2026-10-01T00:00:00.000Z|${id}`)).toEqual({ at: new Date("2026-10-01T00:00:00.000Z"), id });
        expect(history.readCursor("2026-10-01T00:00:00.000Z|abc")).toBeNull();
        expect(history.readCursor("nonsense")).toBeNull();
        expect(history.readCursor(undefined)).toBeNull();
    });
});

describe("run from here", () => {
    const draft = () =>
        graphOf(
            [node("t1", "core.manual", {}, { pinned: { name: "ada" } }), http("h"), say("n")],
            [
                ["t1", "h"],
                ["h", "n"]
            ]
        );

    it("runs the node and what follows with the last test's data standing in for the steps before", async () => {
        const id = await seed(draft());
        const first = (await history.startTestRun(actor, id)) as { runId: string };
        await settle(first.runId);
        expect(sent.requests).toEqual(["https://api.example.test/ada"]);

        const answer = await history.startPartialRun(actor, id, "n");
        expect("runId" in answer).toBe(true);
        const runId = (answer as { runId: string }).runId;
        const run = await settle(runId);
        expect(run.status).toBe("succeeded");
        expect(run.test).toBe(true);
        // The HTTP step before it was not sent again.
        expect(sent.requests).toEqual(["https://api.example.test/ada"]);
        const detail = await history.getRun(actor, runId);
        const earlier = await history.getRun(actor, first.runId);
        expect(detail.steps.find((step) => step.nodeId === "h")?.output).toEqual(earlier.steps.find((step) => step.nodeId === "h")?.output);
        expect(detail.steps.find((step) => step.nodeId === "n")?.input).toEqual(earlier.steps.find((step) => step.nodeId === "n")?.input);
        expect(detail.steps.find((step) => step.nodeId === "n")?.status).toBe("ok");
        // The draft itself keeps no pin the partial run added.
        const stored = fake().tables.automation!.find((entry) => entry.id === id)!.draft as core.AutomationGraph;
        expect(stored.nodes.find((entry) => entry.id === "h")!.pinned).toBeUndefined();
    });

    it("names the steps before that have no data, and does not send anything", async () => {
        const id = await seed(draft());
        expect(await history.startPartialRun(actor, id, "n")).toEqual({ refusal: "missingData", nodes: ["h"] });
        expect(sent.requests).toEqual([]);
        expect(fake().tables.automationRun ?? []).toHaveLength(0);
    });

    it("runs an ordinary test from a trigger, and refuses a reader", async () => {
        const id = await seed(draft());
        const answer = (await history.startPartialRun(actor, id, "t1")) as { runId: string };
        await settle(answer.runId);
        expect(sent.requests).toEqual(["https://api.example.test/ada"]);
        access.edit = false;
        await expect(history.startPartialRun(actor, id, "n")).rejects.toThrow();
    });
});

describe("open in editor with this data", () => {
    it("pins the run's trigger data on that trigger in the draft, without its id and time", async () => {
        const id = await seed(graphOf([node("t1", "core.manual"), say("n")], [["t1", "n"]]));
        const { runId } = (await history.startTestRun(actor, id)) as { runId: string };
        await settle(runId);
        const row = fake().tables.automationRun!.find((entry) => entry.id === runId)!;
        row.cause = { ...(row.cause as object), body: { name: "ada" } };
        expect(await history.pinRunData(actor, runId)).toEqual({ automationId: id, triggerNodeId: "t1" });
        const draft = fake().tables.automation!.find((entry) => entry.id === id)!.draft as core.AutomationGraph;
        const pinned = draft.nodes.find((entry) => entry.id === "t1")!.pinned as Record<string, unknown>;
        expect(pinned.body).toEqual({ name: "ada" });
        expect(pinned.id).toBeUndefined();
        expect(pinned.at).toBeUndefined();
    });

    it("refuses a reader, a trigger that left the draft, and data too large to pin", async () => {
        const id = await seed(graphOf([node("t1", "core.manual"), say("n")], [["t1", "n"]]));
        const { runId } = (await history.startTestRun(actor, id)) as { runId: string };
        await settle(runId);
        const row = fake().tables.automationRun!.find((entry) => entry.id === runId)!;
        row.cause = { body: "x".repeat(core.AUTOMATION_LIMITS.pinBytes + 1) };
        await expect(history.pinRunData(actor, runId)).rejects.toMatchObject({ code: "tooLarge" });
        row.triggerNodeId = "gone";
        await expect(history.pinRunData(actor, runId)).rejects.toMatchObject({ code: "triggerGone" });
        access.edit = false;
        await expect(history.pinRunData(actor, runId)).rejects.toThrow();
    });
});

describe("naming and comparing versions", () => {
    it("names a version, takes the name away, and compares it with the draft and another version", async () => {
        const id = await seed(graphOf([node("t1", "core.manual"), say("n")], [["t1", "n"]]));
        await service.publishAutomation(actor, id);
        const draft = graphOf([node("t1", "core.manual"), say("m")], [["t1", "m"]]);
        await service.saveDraft(actor, id, draft);
        await service.publishAutomation(actor, id);
        const [second, first] = await history.listVersions(actor, id);
        await history.renameVersion(actor, id, first!.id, "Before the move");
        expect((await history.listVersions(actor, id))[1]!.name).toBe("Before the move");
        await history.renameVersion(actor, id, first!.id, null);
        expect((await history.listVersions(actor, id))[1]!.name).toBeNull();

        const diff = await history.compareVersions(actor, id, first!.id, second!.id);
        expect(diff.added.map((entry) => entry.id)).toEqual(["m"]);
        expect(diff.removed.map((entry) => entry.id)).toEqual(["n"]);
        expect(diff.rewired).toBe(true);
        const same = await history.compareVersions(actor, id, second!.id, "draft");
        expect(same).toEqual({ added: [], removed: [], changed: [], rewired: false });
    });

    it("refuses a reader renaming, and a version of another automation", async () => {
        const id = await seed(graphOf([node("t1", "core.manual"), say("n")], [["t1", "n"]]));
        const other = await seed(graphOf([node("t1", "core.manual"), say("n")], [["t1", "n"]]));
        await service.publishAutomation(actor, other);
        const [version] = await history.listVersions(actor, other);
        await expect(history.renameVersion(actor, id, version!.id, "x")).rejects.toMatchObject({ code: "notFound" });
        await expect(history.compareVersions(actor, id, version!.id, "draft")).rejects.toMatchObject({ code: "notFound" });
        access.edit = false;
        await expect(history.renameVersion(actor, other, version!.id, "x")).rejects.toThrow();
    });
});

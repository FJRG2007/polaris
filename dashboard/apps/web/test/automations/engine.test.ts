/**
 * The durable engine against an in-memory database: runs go to the end, the
 * Finally lane always runs once, modes hold, and a run cut off part-way (the
 * container replaced by an Update) neither loses nor doubles a step.
 */

import * as core from "@polaris/core";
import { createFakeDb } from "./fixtures/fake-prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));
const sent = vi.hoisted(() => ({ requests: [] as { url: string; init: RequestInit }[], status: 200 }));
const notify = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({ automationRunner: async () => ({ id: "u1", isAdmin: false }) }));
vi.mock("@/lib/automations/secrets", () => ({ readSecretForRun: async () => "https://hooks.example.test/SECRETVALUE" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));
vi.mock("@/lib/safe-fetch", () => ({
    RefusedAddressError: class extends Error {},
    resolveName: async () => [],
    safeUrl: (value: string) => new URL(value),
    readCapped: async (response: Response) => new Uint8Array(await response.arrayBuffer()),
    configuredRequest: async (url: string, init: RequestInit) => {
        sent.requests.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: sent.status, headers: { "content-type": "application/json" } });
    }
}));

const engine = await import("@/lib/automations/engine");
const outbox = await import("@/lib/automations/outbox");
const triggers = await import("@/lib/automations/triggers");

const fake = () => db.current!;
const node = (id: string, type: string, config: unknown = {}, extra: Partial<core.GraphNode> = {}): core.GraphNode => ({
    id,
    type,
    typeVersion: 1,
    config,
    ...extra
});
const say = (id: string) => node(id, "core.notify", { title: `step ${id}`, body: "" });
const http = (id: string, extra: Partial<core.GraphNode> = {}) =>
    node(id, "core.http", { method: "POST", url: "", urlSecretId: "00000000-0000-7000-8000-000000009999" }, extra);
const wait = (id: string) => node(id, "core.wait", { kind: "duration", duration: { amount: 1, unit: "hours" } });
const ifBig = (id: string) =>
    node(id, "core.if", {
        condition: { kind: "group", join: "all", items: [{ kind: "compare", left: "{{trigger.n}}", op: "gt", right: "2" }] }
    });

async function seed(flow: Omit<core.ListFlow, "timeZone" | "triggers" | "finallyOnCancel"> & { onCancel?: boolean }, automation: Record<string, unknown> = {}) {
    const graph = core.graphFromList({
        timeZone: "UTC",
        triggers: [node("t1", "core.manual")],
        steps: flow.steps,
        finally: flow.finally,
        finallyOnCancel: flow.onCancel ?? false
    });
    expect(core.graphProblems(graph, { forPublish: true })).toEqual([]);
    const row = await fake().prisma.automation.create({
        data: { name: "Test", draft: graph, enabled: true, runAsId: "u1", userId: "u1", ...automation }
    });
    const version = await fake().prisma.automationVersion.create({ data: { automationId: row.id, number: 1, graph } });
    await fake().prisma.automation.update({ where: { id: row.id }, data: { publishedVersionId: version.id } });
    return { automationId: row.id as string, versionId: version.id as string, graph };
}

const fire = (seeded: { automationId: string; versionId: string }, key: string, cause: Record<string, unknown> = {}) =>
    engine.startRun({ ...seeded, triggerNodeId: "t1", firingKey: key, cause: { id: "t1", ...cause }, depth: 0 });

const run = (id: string) => fake().tables.automationRun!.find((row) => row.id === id)!;
const steps = (id: string) => fake().tables.automationStep!.filter((row) => row.runId === id);
const step = (id: string, nodeId: string) => steps(id).find((row) => row.nodeId === nodeId);

beforeEach(() => {
    fake().reset();
    sent.requests = [];
    sent.status = 200;
    notify.mockClear();
    engine.resumeClaiming();
});

describe("a run to the end", () => {
    it("takes the If branch the trigger data picks and runs the Finally lane once", async () => {
        const seeded = await seed({
            steps: [{ node: ifBig("if1"), then: [{ node: say("a") }], else: [{ node: say("b") }] }, { node: say("c") }],
            finally: [{ node: say("z") }]
        });
        const started = await fire(seeded, "k1", { n: 5 });
        await engine.advanceRun(started!.id);
        expect(run(started!.id)).toMatchObject({ status: "succeeded", finally: "done", lockToken: null });
        expect(step(started!.id, "if1")).toMatchObject({ status: "ok", port: "then" });
        expect(step(started!.id, "b")).toBeUndefined();
        expect(steps(started!.id).filter((row) => row.status === "ok").map((row) => row.nodeId)).toEqual(["t1", "if1", "a", "c", "z"]);
        expect(notify).toHaveBeenCalledTimes(3);
    });

    it("runs the Finally lane after a failure, keeps the failure, and never stores the secret", async () => {
        sent.status = 500;
        const seeded = await seed({ steps: [{ node: http("h") }, { node: say("after") }], finally: [{ node: say("z") }] });
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started!.id);
        expect(run(started!.id)).toMatchObject({ status: "failed", finally: "done", error: "httpStatus:500" });
        expect(step(started!.id, "after")).toBeUndefined();
        expect(step(started!.id, "z")).toMatchObject({ status: "ok" });
        expect(JSON.stringify(steps(started!.id))).not.toContain("SECRETVALUE");
        expect(sent.requests[0]!.url).toContain("SECRETVALUE");
        expect(new Headers(sent.requests[0]!.init.headers).get("idempotency-key")).toBe(`${started!.id}:h:0`);
    });

    it("carries on past a failing step that says so", async () => {
        sent.status = 500;
        const seeded = await seed({ steps: [{ node: http("h", { onError: "continue" }) }, { node: say("after") }], finally: [] });
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started!.id);
        expect(run(started!.id).status).toBe("succeeded");
        expect(step(started!.id, "after")).toMatchObject({ status: "ok" });
    });
});

describe("firings and modes", () => {
    it("starts one run per firing key", async () => {
        const seeded = await seed({ steps: [{ node: say("a") }], finally: [] });
        const first = await fire(seeded, "same");
        const again = await fire(seeded, "same");
        expect(again!.id).toBe(first!.id);
        expect(fake().tables.automationRun).toHaveLength(1);
    });

    it("skips a second firing while a single run waits, and holds back past the rate limit", async () => {
        const seeded = await seed({ steps: [{ node: wait("w") }], finally: [] }, { rateLimit: 3 });
        const first = await fire(seeded, "k1");
        await engine.advanceRun(first!.id);
        expect(run(first!.id).status).toBe("waiting");
        expect(await fire(seeded, "k2")).toMatchObject({ status: "skipped" });
        expect(run((await fire(seeded, "k3"))!.id).error).toBe("alreadyRunning");
        await fake().prisma.automation.updateMany({ where: {}, data: { mode: "parallel" } });
        await fire(seeded, "k4");
        await fire(seeded, "k5");
        expect(await fire(seeded, "k6")).toMatchObject({ status: "limited" });
    });

    it("restart cancels the active run; queued starts the next when the first ends", async () => {
        const restart = await seed({ steps: [{ node: wait("w") }], finally: [] }, { mode: "restart" });
        const old = await fire(restart, "k1");
        await engine.advanceRun(old!.id);
        const fresh = await fire(restart, "k2");
        expect(run(old!.id).status).toBe("cancelled");
        expect(fresh!.status).toBe("running");

        const queued = await seed({ steps: [{ node: say("a") }], finally: [] }, { mode: "queued" });
        const one = await fire(queued, "q1");
        const two = await fire(queued, "q2");
        expect(two!.status).toBe("queued");
        await engine.advanceRun(one!.id);
        expect(run(one!.id).status).toBe("succeeded");
        await vi.waitFor(() => expect(run(two!.id).status).toBe("succeeded"));
    });
});

describe("waits and cancelling", () => {
    it("resumes a due wait from the rows alone", async () => {
        const seeded = await seed({ steps: [{ node: wait("w") }, { node: say("a") }], finally: [] });
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started!.id);
        expect(run(started!.id)).toMatchObject({ status: "waiting", lockToken: null });
        expect(await engine.resumeDueWaits()).toEqual([]);
        step(started!.id, "w")!.waitUntil = new Date(Date.now() - 1000);
        const resumed = await engine.resumeDueWaits();
        expect(resumed).toEqual([started!.id]);
        await engine.advanceRun(started!.id);
        expect(run(started!.id).status).toBe("succeeded");
    });

    it("does not run the Finally lane on cancel unless asked to", async () => {
        const plain = await seed({ steps: [{ node: wait("w") }], finally: [{ node: say("z") }] });
        const a = await fire(plain, "k1");
        await engine.advanceRun(a!.id);
        await engine.cancelRun(a!.id);
        expect(run(a!.id)).toMatchObject({ status: "cancelled", finally: "none" });
        expect(step(a!.id, "z")).toBeUndefined();

        const asked = await seed({ steps: [{ node: wait("w") }], finally: [{ node: say("z") }], onCancel: true });
        const b = await fire(asked, "k1");
        await engine.advanceRun(b!.id);
        await engine.cancelRun(b!.id);
        await engine.advanceRun(b!.id);
        expect(run(b!.id)).toMatchObject({ status: "cancelled", finally: "done" });
        expect(step(b!.id, "z")).toMatchObject({ status: "ok" });
    });
});

describe("a run cut off part-way", () => {
    async function cutOffAt(nodeToCut: core.GraphNode) {
        const seeded = await seed({ steps: [{ node: nodeToCut }, { node: say("after") }], finally: [{ node: say("z") }] });
        const started = await fire(seeded, "k1");
        // What a process that died inside the step leaves: the step running, the lease expired.
        const row = step(started!.id, nodeToCut.id)!;
        row.status = "running";
        Object.assign(run(started!.id), { lockedUntil: new Date(Date.now() - 1000), lockToken: "dead" });
        return started!.id;
    }

    it("never sends a non-idempotent request twice: the step is interrupted and the Finally lane runs", async () => {
        const id = await cutOffAt(http("h"));
        await engine.advanceRun(id);
        expect(sent.requests).toHaveLength(0);
        expect(step(id, "h")).toMatchObject({ status: "interrupted" });
        expect(run(id)).toMatchObject({ status: "failed", error: "interrupted", finally: "done" });
    });

    it("runs an idempotent step again and finishes the run", async () => {
        const id = await cutOffAt(ifBig("if1"));
        await engine.advanceRun(id);
        expect(run(id).status).toBe("succeeded");
        expect(steps(id).filter((row) => row.nodeId === "if1")).toHaveLength(1);
    });

    it("leaves a run alone while another process holds a live lease, and claims nothing after SIGTERM", async () => {
        const seeded = await seed({ steps: [{ node: say("a") }], finally: [] });
        const started = await fire(seeded, "k1");
        Object.assign(run(started!.id), { lockedUntil: new Date(Date.now() + 60_000), lockToken: "other" });
        await engine.advanceRun(started!.id);
        expect(run(started!.id).status).toBe("running");
        Object.assign(run(started!.id), { lockedUntil: null, lockToken: null });
        engine.stopClaiming();
        await engine.advanceRun(started!.id);
        expect(run(started!.id).status).toBe("running");
    });
});

describe("the outbox and the clock", () => {
    it("drops a duplicate event and starts one run per match", async () => {
        const seeded = await seed({ steps: [{ node: say("a") }], finally: [] });
        await triggers.armVersion(seeded.automationId, seeded.versionId, seeded.graph);
        const subjectKey = triggers.manualSubject(seeded.automationId, "t1");
        expect(await outbox.emitAutomationEvent("core.manual", { subjectKey, payload: { by: "u1" }, dedupeKey: "d1" })).not.toBeNull();
        expect(await outbox.emitAutomationEvent("core.manual", { subjectKey, payload: { by: "u1" }, dedupeKey: "d1" })).toBeNull();
        const started = await outbox.processAutomationEvents();
        expect(started).toHaveLength(1);
        expect(await outbox.processAutomationEvents()).toHaveLength(0);
        expect(run(started[0]!.id).cause).toMatchObject({ by: "u1", id: "t1" });
    });

    it("fires a due schedule once and skips an occurrence missed by more than the catch-up window", async () => {
        const graph = core.automationGraphSchema.parse({
            nodes: [node("s1", "core.schedule", { kind: "every", amount: 5, unit: "minutes" }), say("a")],
            edges: [{ from: { node: "s1", port: "next" }, to: { node: "a" } }]
        });
        const row = await fake().prisma.automation.create({ data: { name: "S", draft: graph, enabled: true, runAsId: "u1", userId: "u1" } });
        const version = await fake().prisma.automationVersion.create({ data: { automationId: row.id, number: 1, graph } });
        await triggers.armVersion(row.id, version.id, graph);
        const armed = fake().tables.automationTrigger![0]!;
        armed.nextDueAt = new Date(Date.now() - 1000);
        expect(await triggers.fireDueSchedules()).toHaveLength(1);
        expect(await triggers.fireDueSchedules()).toHaveLength(0);
        expect((armed.nextDueAt as Date).getTime()).toBeGreaterThan(Date.now());
        armed.nextDueAt = new Date(Date.now() - 20 * 60_000);
        expect(await triggers.fireDueSchedules()).toHaveLength(0);
        expect((armed.nextDueAt as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it("keeps a schedule's due time when a re-publish did not change it", () => {
        const graph = core.automationGraphSchema.parse({ nodes: [node("s1", "core.schedule", { kind: "every", amount: 1, unit: "days" })] });
        const due = new Date("2030-01-01T00:00:00Z");
        const first = triggers.armedTriggers("a1", graph, [], new Date());
        const kept = triggers.armedTriggers("a1", graph, [{ nodeId: "s1", nextDueAt: due, state: first[0]!.state }], new Date());
        expect(kept[0]!.nextDueAt).toEqual(due);
    });

    it("derives a webhook address that changes with its rotation and stores only a hash", () => {
        const one = triggers.hookToken("a1", "w1", 0);
        expect(triggers.hookToken("a1", "w1", 0)).toBe(one);
        expect(triggers.hookToken("a1", "w1", 1)).not.toBe(one);
        expect(triggers.hookHash(one)).toMatch(/^[0-9a-f]{64}$/);
    });
});

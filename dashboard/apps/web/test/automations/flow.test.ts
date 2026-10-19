/**
 * Flow control in the durable engine: Choose, At the same time, Join, loops,
 * Stop, retries and error ports, waits for an event, automation events and
 * sub-automations - and a process that dies in the middle of a join, a wait
 * for an event, a retry wait or a sub-run loses nothing and does nothing twice.
 */

import * as core from "@polaris/core";
import { createFakeDb } from "./fixtures/fake-prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));
const sent = vi.hoisted(() => ({
    requests: [] as { url: string; init: RequestInit }[],
    statuses: [] as number[]
}));
const notify = vi.hoisted(() => vi.fn(async (_input: { title: string }) => ({ inapp: "sent" })));

vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({
    automationRunner: async () => ({ id: "u1", isAdmin: false }),
    mayAllowLocalNetwork: async () => false
}));
vi.mock("@/lib/automations/secrets", () => ({
    readSecretForRun: async () => "https://hooks.example.test/SECRETVALUE"
}));
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
        return new Response(JSON.stringify({ ok: true }), {
            status: sent.statuses.shift() ?? 200,
            headers: { "content-type": "application/json" }
        });
    }
}));

const engine = await import("@/lib/automations/engine");
const outbox = await import("@/lib/automations/outbox");
const triggers = await import("@/lib/automations/triggers");
const calls = await import("@/lib/automations/calls");

const fake = () => db.current!;
type Extra = Partial<core.GraphNode>;
const node = (
    id: string,
    type: string,
    config: unknown = {},
    extra: Extra = {}
): core.GraphNode => ({
    id,
    type,
    typeVersion: 1,
    config,
    ...extra
});
const say = (id: string, title = `step ${id}`) => node(id, "core.notify", { title, body: "" });
const http = (id: string, extra: Extra = {}) =>
    node(
        id,
        "core.http",
        { method: "POST", url: "", urlSecretId: "00000000-0000-7000-8000-000000009999" },
        extra
    );
const pause = (id: string) =>
    node(id, "core.wait", { kind: "duration", duration: { amount: 1, unit: "hours" } });
const compare = (left: string, op: string, right: string) => ({
    kind: "group" as const,
    join: "all" as const,
    items: [{ kind: "compare" as const, left, op, right }]
});

type Wire = [string, string, string];

async function seed(
    nodes: core.GraphNode[],
    wires: Wire[],
    options: {
        finally?: string;
        onCancel?: boolean;
        trigger?: core.GraphNode;
        userId?: string;
    } = {}
) {
    const trigger = options.trigger ?? node("t1", "core.manual");
    const graph = core.automationGraphSchema.parse({
        timeZone: "UTC",
        nodes: [trigger, ...nodes],
        edges: wires.map(([from, port, to]) => ({ from: { node: from, port }, to: { node: to } })),
        finally: { entry: options.finally ?? null, onCancel: options.onCancel ?? false }
    });
    expect(core.graphProblems(graph, { forPublish: true })).toEqual([]);
    const row = await fake().prisma.automation.create({
        data: {
            name: "Test",
            draft: graph,
            enabled: true,
            runAsId: "u1",
            userId: options.userId ?? "u1",
            mode: "parallel"
        }
    });
    const version = await fake().prisma.automationVersion.create({
        data: { automationId: row.id, number: 1, graph }
    });
    await fake().prisma.automation.update({
        where: { id: row.id },
        data: { publishedVersionId: version.id }
    });
    return { automationId: row.id as string, versionId: version.id as string, graph, trigger };
}

const fire = async (
    seeded: Awaited<ReturnType<typeof seed>>,
    key: string,
    cause: Record<string, unknown> = {}
) =>
    (await engine.startRun({
        automationId: seeded.automationId,
        versionId: seeded.versionId,
        triggerNodeId: seeded.trigger.id,
        firingKey: key,
        cause: { id: seeded.trigger.id, ...cause },
        depth: 0
    }))!;

const runRow = (id: string) => fake().tables.automationRun!.find((row) => row.id === id)!;
const steps = (id: string) => fake().tables.automationStep!.filter((row) => row.runId === id);
const stepsOf = (id: string, nodeId: string) => steps(id).filter((row) => row.nodeId === nodeId);
const step = (id: string, nodeId: string) => stepsOf(id, nodeId)[0];
const titles = () => notify.mock.calls.map((call) => call[0].title);

/** Make every timed wait due now, as if the clock had moved on. */
function timePasses() {
    for (const row of fake().tables.automationStep ?? [])
        if (row.status === "waiting" && row.waitUntil) row.waitUntil = new Date(Date.now() - 1000);
}

/** What the job does on each pass, until nothing is left to step. */
async function drain() {
    for (let pass = 0; pass < 20; pass++) {
        const started = await outbox.processAutomationEvents();
        const resumed = await engine.resumeDueWaits();
        const runnable = await engine.runnableRuns(50);
        for (const id of runnable) await engine.advanceRun(id);
        if (!started.length && !resumed.length && !runnable.length) return;
    }
}

/** A process that died while holding a run: its lease ran out, its step stays "running". */
function dieWhileRunning(runId: string, nodeId: string) {
    const row = stepsOf(runId, nodeId).at(-1)!;
    row.status = "running";
    const held = runRow(runId);
    held.status = "running";
    held.lockToken = "dead-process";
    held.lockedUntil = new Date(Date.now() - 1000);
}

beforeEach(() => {
    fake().reset();
    sent.requests = [];
    sent.statuses = [];
    notify.mockClear();
    engine.resumeClaiming();
});

describe("Choose", () => {
    const cases = (every: boolean, fallback = true) =>
        node("sw", "core.switch", {
            kind: "rules",
            every,
            fallback,
            cases: [
                { label: "big", condition: compare("{{trigger.n}}", "gt", "10") },
                { label: "positive", condition: compare("{{trigger.n}}", "gt", "0") }
            ]
        });
    const wires: Wire[] = [
        ["t1", "next", "sw"],
        ["sw", "case1", "a"],
        ["sw", "case2", "b"],
        ["sw", "otherwise", "c"]
    ];

    it("leaves by the first case that holds, every one with every match, or Otherwise", async () => {
        const first = await seed([cases(false), say("a"), say("b"), say("c")], wires);
        await engine.advanceRun((await fire(first, "k1", { n: 50 })).id);
        expect(titles()).toEqual(["step a"]);
        notify.mockClear();
        const every = await seed([cases(true), say("a"), say("b"), say("c")], wires);
        const both = await fire(every, "k2", { n: 50 });
        await engine.advanceRun(both.id);
        expect(titles()).toEqual(["step a", "step b"]);
        expect(step(both.id, "sw")).toMatchObject({
            port: "case1,case2",
            output: { matched: [1, 2] }
        });
        notify.mockClear();
        await engine.advanceRun((await fire(first, "k3", { n: -1 })).id);
        expect(titles()).toEqual(["step c"]);
    });

    it("ends the token when nothing matches and there is no Otherwise", async () => {
        const seeded = await seed([cases(false, false), say("a"), say("b")], wires.slice(0, 3));
        const started = await fire(seeded, "k1", { n: -5 });
        await engine.advanceRun(started.id);
        expect(runRow(started.id).status).toBe("succeeded");
        expect(notify).not.toHaveBeenCalled();
    });

    it("matches a value against cases, ignoring case", async () => {
        const seeded = await seed(
            [
                node("sw", "core.switch", {
                    kind: "value",
                    value: "{{trigger.state}}",
                    cases: [{ equals: "open" }, { equals: "closed" }]
                }),
                say("a"),
                say("b"),
                say("c")
            ],
            wires
        );
        await engine.advanceRun((await fire(seeded, "k1", { state: "CLOSED" })).id);
        expect(titles()).toEqual(["step b"]);
    });
});

describe("At the same time and Join", () => {
    const lanes = (wait: unknown, second: core.GraphNode[] = [pause("w"), say("b")]) =>
        seed(
            [
                node("par", "core.parallel", { lanes: 2 }),
                say("a"),
                ...second,
                node("join", "core.join", wait),
                say("z")
            ],
            [
                ["t1", "next", "par"],
                ["par", "lane1", "a"],
                ["par", "lane2", second[0]!.id],
                ...(second.length > 1 ? ([[second[0]!.id, "next", second[1]!.id]] as Wire[]) : []),
                ["a", "next", "join"],
                [second.at(-1)!.id, "next", "join"],
                ["join", "next", "z"]
            ]
        );

    it("waits for every lane that can still arrive, then goes on once", async () => {
        const seeded = await lanes({ wait: "all" });
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(runRow(started.id).status).toBe("waiting");
        expect(titles()).toEqual(["step a"]);
        expect(step(started.id, "join")!.status).toBe("ready");
        timePasses();
        await drain();
        expect(titles()).toEqual(["step a", "step b", "step z"]);
        expect(stepsOf(started.id, "join")).toHaveLength(1);
        expect(step(started.id, "join")!.output).toMatchObject({
            arrived: ["a", "b"],
            missing: [],
            inputs: { a: { sent: true }, b: { sent: true } }
        });
        expect(runRow(started.id).status).toBe("succeeded");
    });

    it("goes on at the first arrival with any, and drops the later ones", async () => {
        const seeded = await lanes({ wait: "any", output: "append" });
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["step a", "step z"]);
        timePasses();
        await drain();
        expect(titles()).toEqual(["step a", "step z", "step b"]);
        expect(stepsOf(started.id, "z")).toHaveLength(1);
        expect(step(started.id, "join")!.output).toMatchObject({
            items: [{ sent: true }],
            missing: ["b"]
        });
    });

    it("goes on once N have arrived", async () => {
        const seeded = await seed(
            [
                node("par", "core.parallel", { lanes: 3 }),
                say("a"),
                say("b"),
                pause("w"),
                node("join", "core.join", { wait: "count", count: 2 }),
                say("z")
            ],
            [
                ["t1", "next", "par"],
                ["par", "lane1", "a"],
                ["par", "lane2", "b"],
                ["par", "lane3", "w"],
                ["a", "next", "join"],
                ["b", "next", "join"],
                ["w", "next", "join"],
                ["join", "next", "z"]
            ]
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["step a", "step b", "step z"]);
        expect(runRow(started.id).status).toBe("waiting");
    });

    it("survives a process that dies while the join runs: the tail is sent once", async () => {
        const seeded = await lanes({ wait: "all" });
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        timePasses();
        await engine.resumeDueWaits();
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["step a", "step b", "step z"]);
        // The same moment again, as a dead process would have left it.
        dieWhileRunning(started.id, "join");
        const z = step(started.id, "z")!;
        fake().tables.automationStep = fake().tables.automationStep!.filter((row) => row !== z);
        runRow(started.id).finishedAt = null;
        runRow(started.id).status = "running";
        await engine.advanceRun(started.id);
        expect(stepsOf(started.id, "join")).toHaveLength(1);
        expect(titles().filter((title) => title === "step z")).toHaveLength(2);
    });

    it("puts back a successor a crash kept from being written", async () => {
        const seeded = await lanes({ wait: "all" }, [say("b")]);
        const started = await fire(seeded, "k1");
        // Lane a ran, then the process died before writing the join row.
        await engine.advanceRun(started.id);
        const before = titles().length;
        fake().tables.automationStep = fake().tables.automationStep!.filter(
            (row) => !(row.runId === started.id && ["join", "z"].includes(row.nodeId as string))
        );
        runRow(started.id).status = "running";
        runRow(started.id).finishedAt = null;
        runRow(started.id).finally = "none";
        await engine.advanceRun(started.id);
        expect(stepsOf(started.id, "join")).toHaveLength(1);
        expect(titles().slice(before)).toEqual(["step z"]);
    });
});

describe("loops", () => {
    it("walks every item, one pass at a time, then leaves by done", async () => {
        const seeded = await seed(
            [
                node("each", "core.forEach", { items: "{{trigger.items}}" }),
                say("x", "item {{item}} at {{index}}"),
                say("end")
            ],
            [
                ["t1", "next", "each"],
                ["each", "each", "x"],
                ["each", "done", "end"]
            ]
        );
        const started = await fire(seeded, "k1", { items: ["a", "b", "c"] });
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["item a at 0", "item b at 1", "item c at 2", "step end"]);
        expect(step(started.id, "each")).toMatchObject({
            status: "ok",
            port: "done",
            output: { count: 3, passes: 3 }
        });
        expect(
            steps(started.id)
                .filter((row) => row.nodeId === "x")
                .map((row) => row.iteration)
        ).toEqual(["0/each:0", "0/each:1", "0/each:2"]);
    });

    it("hands batches, waits inside a pass, and refuses an unbounded list", async () => {
        const seeded = await seed(
            [
                node("each", "core.forEach", { items: "{{trigger.items}}", batch: 2 }),
                pause("w"),
                say("x", "{{item}}")
            ],
            [
                ["t1", "next", "each"],
                ["each", "each", "w"],
                ["w", "next", "x"]
            ]
        );
        const started = await fire(seeded, "k1", { items: [1, 2, 3] });
        await drain();
        expect(runRow(started.id).status).toBe("waiting");
        timePasses();
        await drain();
        timePasses();
        await drain();
        expect(titles()).toEqual(["[1,2]", "[3]"]);
        expect(runRow(started.id).status).toBe("succeeded");
        const big = await fire(seeded, "k2", { items: Array.from({ length: 1001 }, (_, i) => i) });
        await engine.advanceRun(big.id);
        expect(runRow(big.id)).toMatchObject({ status: "failed", error: "tooManyItems" });
    });

    it("repeats a count of times, or until a condition holds", async () => {
        const times = await seed(
            [node("rep", "core.repeat", { kind: "times", count: 3 }), say("x", "pass {{index}}")],
            [
                ["t1", "next", "rep"],
                ["rep", "each", "x"]
            ]
        );
        await engine.advanceRun((await fire(times, "k1")).id);
        expect(titles()).toEqual(["pass 0", "pass 1", "pass 2"]);
        notify.mockClear();
        const until = await seed(
            [
                node("rep", "core.repeat", {
                    kind: "until",
                    max: 10,
                    condition: compare("{{index}}", "gte", "2")
                }),
                say("x", "pass {{index}}")
            ],
            [
                ["t1", "next", "rep"],
                ["rep", "each", "x"]
            ]
        );
        const started = await fire(until, "k1");
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["pass 0", "pass 1"]);
        expect(step(started.id, "rep")!.output).toMatchObject({ passes: 2 });
    });

    it("checks the until condition against what the pass just did", async () => {
        sent.statuses = [202, 202, 200, 200];
        const polling = await seed(
            [
                node("rep", "core.repeat", {
                    kind: "until",
                    max: 10,
                    condition: compare("{{steps.h.status}}", "eq", "200")
                }),
                http("h")
            ],
            [
                ["t1", "next", "rep"],
                ["rep", "each", "h"]
            ]
        );
        const started = await fire(polling, "k1");
        await engine.advanceRun(started.id);
        expect(sent.requests).toHaveLength(3);
        expect(step(started.id, "rep")!.output).toMatchObject({ passes: 3 });
    });
});

describe("Stop, retries and the error port", () => {
    it("stops as failed and still runs the Finally lane once", async () => {
        const seeded = await seed(
            [
                node("stop", "core.stop", { as: "failed", reason: "no stock" }),
                say("after"),
                say("z")
            ],
            [["t1", "next", "stop"]],
            { finally: "z" }
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(runRow(started.id)).toMatchObject({
            status: "failed",
            finally: "done",
            error: "stoppedAsFailed"
        });
        expect(titles()).toEqual(["step z"]);
        const ok = await seed([node("stop", "core.stop", {})], [["t1", "next", "stop"]]);
        const stopped = await fire(ok, "k2");
        await engine.advanceRun(stopped.id);
        expect(runRow(stopped.id).status).toBe("stopped");
    });

    it("tries again after a wait, and a restart during the wait loses nothing and sends nothing twice", async () => {
        sent.statuses = [503, 200];
        const seeded = await seed(
            [
                http("h", { retry: { tries: 3, waitSeconds: 30, backoff: "fixed" } }),
                say("after"),
                say("z")
            ],
            [
                ["t1", "next", "h"],
                ["h", "next", "after"]
            ],
            { finally: "z" }
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(runRow(started.id).status).toBe("waiting");
        expect(
            stepsOf(started.id, "h").map((row) => [row.attempt, row.status, row.waitKey ?? null])
        ).toEqual([
            [1, "retried", null],
            [2, "waiting", "retry"]
        ]);
        expect(sent.requests).toHaveLength(1);
        // Nothing lives in memory: the next process finds the wait in the rows.
        engine.stopClaiming();
        engine.resumeClaiming();
        await drain();
        expect(sent.requests).toHaveLength(1);
        timePasses();
        await drain();
        expect(sent.requests).toHaveLength(2);
        expect(runRow(started.id)).toMatchObject({ status: "succeeded", finally: "done" });
        expect(titles()).toEqual(["step after", "step z"]);
    });

    it("never resends a try a dead process may have sent", async () => {
        sent.statuses = [503, 200];
        const seeded = await seed(
            [http("h", { retry: { tries: 3, waitSeconds: 30, backoff: "double" } }), say("z")],
            [["t1", "next", "h"]],
            { finally: "z" }
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        timePasses();
        await engine.resumeDueWaits();
        dieWhileRunning(started.id, "h");
        await engine.advanceRun(started.id);
        expect(sent.requests).toHaveLength(1);
        expect(stepsOf(started.id, "h").at(-1)).toMatchObject({ status: "interrupted" });
        expect(runRow(started.id)).toMatchObject({ status: "failed", finally: "done" });
        expect(titles()).toEqual(["step z"]);
    });

    it("leaves by the error port after the last try, and the Finally lane runs once", async () => {
        sent.statuses = [500, 500];
        const seeded = await seed(
            [
                http("h", {
                    onError: "port",
                    retry: { tries: 2, waitSeconds: 1, backoff: "fixed" }
                }),
                say("ok"),
                say("bad", "failed with {{steps.h.error}}"),
                say("z")
            ],
            [
                ["t1", "next", "h"],
                ["h", "next", "ok"],
                ["h", "error", "bad"]
            ],
            { finally: "z" }
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        timePasses();
        await drain();
        expect(titles()).toEqual(["failed with httpStatus:500", "step z"]);
        expect(runRow(started.id)).toMatchObject({ status: "succeeded", finally: "done" });
    });
});

describe("events between automations", () => {
    async function listener(
        name: string,
        extra: core.GraphNode[] = [say("heard", "heard {{trigger.payload.door}}")]
    ) {
        const seeded = await seed(extra, [["on", "next", extra[0]!.id]], {
            trigger: node("on", "core.onEvent", { name })
        });
        await triggers.armVersion(seeded.automationId, seeded.versionId, seeded.graph);
        return seeded;
    }

    it("starts the automations on the shelf that listen, but never the announcer itself", async () => {
        await listener("door.closed");
        const speaker = await seed(
            [
                node("say", "core.announce", {
                    name: "door.closed",
                    payload: [{ name: "door", value: "{{trigger.door}}" }]
                })
            ],
            [["on", "next", "say"]],
            { trigger: node("on", "core.onEvent", { name: "door.closed" }) }
        );
        await triggers.armVersion(speaker.automationId, speaker.versionId, speaker.graph);
        const other = await listener("door.closed");
        fake().tables.automation!.find((row) => row.id === other.automationId)!.userId =
            "someone-else";
        const started = await engine.startRun({
            automationId: speaker.automationId,
            versionId: speaker.versionId,
            triggerNodeId: "on",
            firingKey: "k1",
            cause: { id: "on", door: "front" },
            depth: 0
        });
        await engine.advanceRun(started!.id);
        await drain();
        expect(titles()).toEqual(["heard front"]);
        const runs = fake().tables.automationRun!;
        expect(runs.filter((row) => row.automationId === speaker.automationId)).toHaveLength(1);
        expect(
            runs.find((row) => row.automationId !== speaker.automationId && row.depth === 1)
        ).toBeTruthy();
    });

    it("refuses a chain deeper than the limit", async () => {
        const seeded = await listener("ping");
        await outbox.emitAutomationEvent("core.event", {
            userId: "u1",
            subjectKey: "ping",
            payload: { name: "ping", payload: {} },
            depth: core.AUTOMATION_LIMITS.depth + 1
        });
        await drain();
        expect(
            fake().tables.automationRun!.find((row) => row.automationId === seeded.automationId)
        ).toMatchObject({
            status: "refused",
            error: "loop"
        });
        expect(notify).not.toHaveBeenCalled();
    });

    it("waits for an event, matches its filter, and a restart mid-wait neither loses nor doubles it", async () => {
        const seeded = await seed(
            [
                node("wait", "core.waitEvent", {
                    name: "door.closed",
                    timeout: { amount: 1, unit: "hours" },
                    filter: compare("{{event.door}}", "eq", "back")
                }),
                say("closed", "closed {{steps.wait.payload.door}}"),
                say("late")
            ],
            [
                ["t1", "next", "wait"],
                ["wait", "next", "closed"],
                ["wait", "timeout", "late"]
            ]
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(runRow(started.id).status).toBe("waiting");
        await outbox.emitAutomationEvent("core.event", {
            userId: "u1",
            subjectKey: "door.closed",
            payload: { name: "door.closed", payload: { door: "front" } }
        });
        await drain();
        expect(runRow(started.id).status).toBe("waiting");
        const id = await outbox.emitAutomationEvent("core.event", {
            userId: "u1",
            subjectKey: "door.closed",
            payload: { name: "door.closed", payload: { door: "back" } }
        });
        await outbox.processAutomationEvents();
        // The process died before it marked the event processed: it is matched again.
        fake().tables.automationEvent!.find((row) => row.id === id)!.processedAt = null;
        fake().tables.automationEvent!.find((row) => row.id === id)!.claimedUntil = null;
        await drain();
        expect(titles()).toEqual(["closed back"]);
        expect(runRow(started.id).status).toBe("succeeded");
    });

    it("wakes every waiter under the name, past one page", async () => {
        const seeded = await seed(
            [
                node("wait", "core.waitEvent", {
                    name: "bell",
                    timeout: { amount: 1, unit: "hours" }
                }),
                say("rang")
            ],
            [
                ["t1", "next", "wait"],
                ["wait", "next", "rang"]
            ]
        );
        const runs = [];
        for (let at = 0; at < 5; at++) runs.push(await fire(seeded, `k${at}`));
        for (const run of runs) await engine.advanceRun(run.id);
        const resumed = await engine.resumeEventWaits({ orgId: null, userId: "u1" }, "bell", {}, 2);
        expect(resumed.sort()).toEqual(runs.map((run) => run.id).sort());
    });

    it("takes the timeout path when nothing comes", async () => {
        const seeded = await seed(
            [
                node("wait", "core.waitEvent", {
                    name: "door.closed",
                    timeout: { amount: 5, unit: "minutes" }
                }),
                say("late")
            ],
            [
                ["t1", "next", "wait"],
                ["wait", "timeout", "late"]
            ]
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        timePasses();
        await drain();
        expect(titles()).toEqual(["step late"]);
        expect(step(started.id, "wait")).toMatchObject({
            port: "timeout",
            output: { timedOut: true }
        });
    });

    it('starts "An automation failed" for another automation\'s failure only', async () => {
        sent.statuses = [500];
        const watcher = await seed(
            [say("alarm", "{{trigger.automationName}} {{trigger.status}}")],
            [["f", "next", "alarm"]],
            {
                trigger: node("f", "core.failed", {})
            }
        );
        await triggers.armVersion(watcher.automationId, watcher.versionId, watcher.graph);
        const failing = await seed([http("h")], [["t1", "next", "h"]]);
        const started = await fire(failing, "k1");
        await engine.advanceRun(started.id);
        await drain();
        expect(titles()).toEqual(["Test failed"]);
        expect(
            fake().tables.automationRun!.filter((row) => row.automationId === watcher.automationId)
        ).toHaveLength(1);
    });
});

describe("Run another automation", () => {
    async function callee(
        nodes: core.GraphNode[] = [
            node("ans", "core.answer", { outputs: [{ name: "got", value: "{{inputs.n}}" }] })
        ],
        wires: Wire[] = [["c", "next", "ans"]]
    ) {
        return seed(nodes, wires, {
            trigger: node("c", "core.called", {
                inputs: [{ name: "n", kind: "number", required: true }]
            })
        });
    }
    const caller = (target: string, wait = true, extra: Extra = {}) =>
        seed(
            [
                node(
                    "call",
                    "core.run",
                    { automationId: target, inputs: [{ name: "n", value: "{{trigger.n}}" }], wait },
                    extra
                ),
                say("after", "got {{steps.call.outputs.got}}"),
                say("bad", "call failed")
            ],
            [
                ["t1", "next", "call"],
                ["call", "next", "after"],
                ...(extra.onError === "port" ? ([["call", "error", "bad"]] as Wire[]) : [])
            ]
        );

    it("passes typed inputs, waits, and takes the answer", async () => {
        const child = await callee();
        const parent = await caller(child.automationId);
        const started = await fire(parent, "k1", { n: "7" });
        await engine.advanceRun(started.id);
        expect(runRow(started.id).status).toBe("waiting");
        await drain();
        expect(titles()).toEqual(["got 7"]);
        const childRun = fake().tables.automationRun!.find(
            (row) => row.automationId === child.automationId
        )!;
        expect(childRun).toMatchObject({ parentRunId: started.id, depth: 1, status: "succeeded" });
        expect(step(started.id, "call")!.output).toMatchObject({
            status: "succeeded",
            outputs: { got: 7 }
        });
    });

    it("survives a restart mid sub-run: one child run, one answer", async () => {
        const child = await callee(
            [
                pause("w"),
                node("ans", "core.answer", { outputs: [{ name: "got", value: "{{inputs.n}}" }] })
            ],
            [
                ["c", "next", "w"],
                ["w", "next", "ans"]
            ]
        );
        const parent = await caller(child.automationId);
        const started = await fire(parent, "k1", { n: 3 });
        await drain();
        expect(runRow(started.id).status).toBe("waiting");
        dieWhileRunning(started.id, "call");
        await drain();
        timePasses();
        await drain();
        expect(
            fake().tables.automationRun!.filter((row) => row.automationId === child.automationId)
        ).toHaveLength(1);
        expect(titles()).toEqual(["got 3"]);
        expect(stepsOf(started.id, "after")).toHaveLength(1);
    });

    it("goes on when the child ended before the wait was written, or its end never reached the caller", async () => {
        const child = await callee(
            [
                pause("w"),
                node("ans", "core.answer", { outputs: [{ name: "got", value: "{{inputs.n}}" }] })
            ],
            [
                ["c", "next", "w"],
                ["w", "next", "ans"]
            ]
        );
        const parent = await caller(child.automationId);
        const started = await fire(parent, "k1", { n: 4 });
        await drain();
        expect(runRow(started.id).status).toBe("waiting");
        const childRun = fake().tables.automationRun!.find(
            (row) => row.automationId === child.automationId
        )!;
        // The child ends but the process dies before it tells the caller.
        const waiting = step(started.id, "call")!;
        waiting.waitKey = null;
        timePasses();
        await engine.resumeDueWaits();
        await engine.advanceRun(childRun.id);
        expect(childRun.status).toBe("succeeded");
        waiting.waitKey = `run:${childRun.id}`;
        expect(runRow(started.id).status).toBe("waiting");
        expect(await engine.resumeEndedCalls()).toEqual([started.id]);
        await drain();
        expect(titles()).toEqual(["got 4"]);
        expect(runRow(started.id).status).toBe("succeeded");

        // The child ends before the caller's wait is written: the stepper finds it.
        notify.mockClear();
        const again = await fire(parent, "k2", { n: 5 });
        await drain();
        const second = fake().tables.automationRun!.find((row) => row.parentRunId === again.id)!;
        const held = step(again.id, "call")!;
        held.waitKey = null;
        timePasses();
        await drain();
        expect(second.status).toBe("succeeded");
        held.waitKey = `run:${second.id}`;
        runRow(again.id).status = "running";
        await engine.advanceRun(again.id);
        expect(titles()).toEqual(["got 5"]);
        expect(runRow(again.id).status).toBe("succeeded");
    });

    it("leaves by the error port when the child fails, refuses a missing input, and cancels the child with the caller", async () => {
        sent.statuses = [500];
        const child = await callee([http("h")], [["c", "next", "h"]]);
        const parent = await caller(child.automationId, true, { onError: "port" });
        await fire(parent, "k1", { n: 1 });
        await drain();
        expect(titles()).toEqual(["call failed"]);
        const missing = await fire(parent, "k2", {});
        await drain();
        expect(step(missing.id, "call")).toMatchObject({ error: "callInputMissing" });
        const slow = await callee([pause("w")], [["c", "next", "w"]]);
        const waiting = await caller(slow.automationId);
        const started = await fire(waiting, "k3", { n: 1 });
        await drain();
        await engine.cancelRun(started.id);
        expect(
            fake().tables.automationRun!.find((row) => row.automationId === slow.automationId)!
                .status
        ).toBe("cancelled");
    });

    it("starts and carries on without waiting, and refuses another shelf's automation", async () => {
        const child = await callee([pause("w")], [["c", "next", "w"]]);
        const parent = await caller(child.automationId, false);
        const started = await fire(parent, "k1", { n: 1 });
        await drain();
        expect(runRow(started.id).status).toBe("succeeded");
        const foreign = await callee();
        fake().tables.automation!.find((row) => row.id === foreign.automationId)!.userId =
            "someone-else";
        const refused = await fire(await caller(foreign.automationId), "k2", { n: 1 });
        await drain();
        expect(runRow(refused.id)).toMatchObject({ status: "refused", error: "callForbidden" });
    });

    it("finds a cycle of calls before it is published", async () => {
        const graphs = new Map<string, core.AutomationGraph>();
        const call = (target: string) =>
            core.automationGraphSchema.parse({
                nodes: [
                    node("t1", "core.manual"),
                    node(`call-${target}`, "core.run", { automationId: target })
                ],
                edges: []
            });
        const a = "00000000-0000-7000-8000-00000000000a";
        const b = "00000000-0000-7000-8000-00000000000b";
        graphs.set(b, call(a));
        expect(await calls.callCycle(a, call(b), async (id) => graphs.get(id) ?? null)).toEqual({
            node: `call-${b}`
        });
        graphs.set(b, call("00000000-0000-7000-8000-00000000000c"));
        expect(await calls.callCycle(a, call(b), async (id) => graphs.get(id) ?? null)).toBeNull();
    });
});

describe("trigger combinators", () => {
    async function together(when: unknown, names: string[]) {
        const triggersOf = names.map((name, index) =>
            node(`on${index + 1}`, "core.onEvent", { name })
        );
        const graph = core.automationGraphSchema.parse({
            nodes: [...triggersOf, say("go", "go {{trigger.members.on1.payload.v}}")],
            edges: triggersOf.map((entry) => ({
                from: { node: entry.id, port: "next" },
                to: { node: "go" }
            })),
            when
        });
        const row = await fake().prisma.automation.create({
            data: {
                name: "Both",
                draft: graph,
                enabled: true,
                runAsId: "u1",
                userId: "u1",
                mode: "parallel"
            }
        });
        const version = await fake().prisma.automationVersion.create({
            data: { automationId: row.id, number: 1, graph }
        });
        await fake().prisma.automation.update({
            where: { id: row.id },
            data: { publishedVersionId: version.id }
        });
        await triggers.armVersion(row.id as string, version.id as string, graph);
        return row.id as string;
    }
    const announce = (name: string, v = 1) =>
        outbox.emitAutomationEvent("core.event", {
            userId: "u1",
            subjectKey: name,
            payload: { name, payload: { v } }
        });
    const runsOf = (id: string) =>
        fake().tables.automationRun!.filter((row) => row.automationId === id);

    it("starts once every member has fired inside the window, with each member's data", async () => {
        const id = await together({ kind: "all", windowSeconds: 300 }, ["a", "b"]);
        await announce("a", 7);
        await drain();
        expect(runsOf(id)).toHaveLength(0);
        const second = await announce("b");
        await outbox.processAutomationEvents();
        // Matched again after a crash: the same combination starts nothing more.
        const row = fake().tables.automationEvent!.find((entry) => entry.id === second)!;
        row.processedAt = null;
        row.claimedUntil = null;
        await drain();
        expect(runsOf(id)).toHaveLength(1);
        expect(titles()).toEqual(["go 7"]);
        await announce("b");
        await drain();
        expect(runsOf(id)).toHaveLength(1);
    });

    it("forgets a member that fired before the window", async () => {
        const id = await together({ kind: "all", windowSeconds: 60 }, ["a", "b"]);
        await announce("a");
        await drain();
        const memory = fake().tables.automationTrigger!.find(
            (row) => row.automationId === id && row.nodeId === "__when"
        )!;
        const members = (memory.state as { members: Record<string, { at: string }> }).members;
        members.on1!.at = new Date(Date.now() - 120_000).toISOString();
        await announce("b");
        await drain();
        expect(runsOf(id)).toHaveLength(0);
    });

    it("starts at N of M", async () => {
        const id = await together({ kind: "count", count: 2, windowSeconds: 300 }, ["a", "b", "c"]);
        await announce("c");
        await drain();
        expect(runsOf(id)).toHaveLength(0);
        await announce("a", 3);
        await drain();
        expect(runsOf(id)).toHaveLength(1);
        expect(titles()).toEqual(["go 3"]);
    });
});
describe("Try", () => {
    const attempt = (recover = false) => node("try", "core.try", { recover });
    const wires: Wire[] = [
        ["t1", "next", "try"],
        ["try", "body", "h"],
        ["h", "next", "b2"],
        ["try", "then", "ok"],
        ["try", "catch", "oops"],
        ["try", "always", "end"]
    ];
    const parts = () => [http("h"), say("b2"), say("ok"), say("oops"), say("end")];

    it("leaves by Then and Always when the body succeeds", async () => {
        const seeded = await seed([attempt(), ...parts()], wires);
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(titles().sort()).toEqual(["step b2", "step end", "step ok"]);
        expect(step(started.id, "try")).toMatchObject({
            status: "ok",
            port: "then,always",
            output: { failed: false }
        });
        expect(runRow(started.id).status).toBe("succeeded");
    });

    it("lets the steps after a Try read what its body did", async () => {
        const seeded = await seed(
            [
                attempt(),
                node("inner", "core.try", {}),
                http("h"),
                say("ok", "then {{steps.h.status}}"),
                say("end", "always {{steps.h.status}}"),
                say("after", "after {{steps.h.status}}")
            ],
            [
                ["t1", "next", "try"],
                ["try", "body", "inner"],
                ["inner", "body", "h"],
                ["try", "then", "ok"],
                ["try", "always", "end"],
                ["end", "next", "after"]
            ]
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(titles().sort()).toEqual(["after 200", "always 200", "then 200"]);
    });

    it("leaves by On error and Always when the body fails, skips the rest, and the run still fails", async () => {
        sent.statuses = [500];
        const seeded = await seed([attempt(), ...parts()], wires);
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(titles().sort()).toEqual(["step end", "step oops"]);
        expect(step(started.id, "try")).toMatchObject({
            status: "failed",
            port: "catch,always",
            output: { failed: true, error: "httpStatus:500", node: "h", recovered: false }
        });
        expect(runRow(started.id)).toMatchObject({ status: "failed", error: "httpStatus:500" });
    });

    it("marks the run recovered when asked, unless the On error path itself fails", async () => {
        sent.statuses = [500];
        const seeded = await seed([attempt(true), ...parts()], wires);
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(runRow(started.id).status).toBe("succeeded");
        expect(step(started.id, "try")).toMatchObject({
            status: "ok",
            output: { recovered: true }
        });

        sent.statuses = [500, 500];
        const broken = await seed(
            [attempt(true), http("h"), http("fix"), say("end")],
            [
                ["t1", "next", "try"],
                ["try", "body", "h"],
                ["try", "catch", "fix"],
                ["try", "always", "end"]
            ]
        );
        const again = await fire(broken, "k2");
        await engine.advanceRun(again.id);
        expect(runRow(again.id)).toMatchObject({ status: "failed", error: "httpStatus:500" });
    });

    it("passes an unrecovered failure to the Try around it, like nested try and catch", async () => {
        sent.statuses = [500];
        const seeded = await seed(
            [
                node("outer", "core.try", { recover: true }),
                node("inner", "core.try", {}),
                http("h"),
                say("innerCatch"),
                say("innerAlways"),
                say("afterInner"),
                say("outerCatch")
            ],
            [
                ["t1", "next", "outer"],
                ["outer", "body", "inner"],
                ["inner", "body", "h"],
                ["inner", "catch", "innerCatch"],
                ["inner", "always", "innerAlways"],
                ["inner", "then", "afterInner"],
                ["outer", "catch", "outerCatch"]
            ]
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["step innerCatch", "step innerAlways", "step outerCatch"]);
        expect(step(started.id, "outer")).toMatchObject({
            port: "catch,always",
            output: { error: "httpStatus:500", node: "inner", recovered: true }
        });
        expect(runRow(started.id).status).toBe("succeeded");
    });

    it("survives a restart mid-body: the failure after the wait is caught once", async () => {
        sent.statuses = [500];
        const seeded = await seed(
            [attempt(), pause("p"), http("h"), say("oops"), say("end")],
            [
                ["t1", "next", "try"],
                ["try", "body", "p"],
                ["p", "next", "h"],
                ["try", "catch", "oops"],
                ["try", "always", "end"]
            ]
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(runRow(started.id).status).toBe("waiting");
        expect(step(started.id, "try")).toMatchObject({ status: "waiting", waitKey: "try" });
        engine.stopClaiming();
        engine.resumeClaiming();
        await drain();
        expect(titles()).toEqual([]);
        timePasses();
        await drain();
        await drain();
        expect(titles().sort()).toEqual(["step end", "step oops"]);
        expect(sent.requests).toHaveLength(1);
        expect(runRow(started.id).status).toBe("failed");
    });

    it("skips what its body still holds after a crash between leaving and skipping", async () => {
        const seeded = await seed(
            [attempt(true), pause("p"), say("never"), say("oops")],
            [
                ["t1", "next", "try"],
                ["try", "body", "p"],
                ["p", "next", "never"],
                ["try", "catch", "oops"]
            ]
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        // The Try left by On error, then the process died before skipping the wait in its body.
        Object.assign(step(started.id, "try")!, {
            status: "ok",
            port: "catch,always",
            output: { failed: true, error: "failed", node: "p", recovered: true }
        });
        runRow(started.id).status = "running";
        await drain();
        timePasses();
        await drain();
        expect(step(started.id, "p")!.status).toBe("skipped");
        expect(titles()).toEqual(["step oops"]);
        expect(runRow(started.id).status).toBe("succeeded");
    });

    it("keeps the loop item visible inside a Try within a For each, and catches in the Finally lane", async () => {
        const seeded = await seed(
            [
                node("each", "core.forEach", { items: "{{trigger.items}}" }),
                attempt(),
                say("x", "item {{item}}"),
                node("fin", "core.try", { recover: true }),
                http("h"),
                say("z")
            ],
            [
                ["t1", "next", "each"],
                ["each", "each", "try"],
                ["try", "body", "x"],
                ["fin", "body", "h"],
                ["fin", "always", "z"]
            ],
            { finally: "fin" }
        );
        sent.statuses = [500];
        const started = await fire(seeded, "k1", { items: ["a", "b"] });
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["item a", "item b", "step z"]);
        expect(runRow(started.id)).toMatchObject({ status: "succeeded", finally: "done" });
    });
});

describe("Wait for a condition", () => {
    const waiter = (condition: unknown) =>
        node("wait", "core.waitCondition", {
            condition,
            timeout: { amount: 1, unit: "hours" },
            every: { amount: 5, unit: "minutes" }
        });
    const wires: Wire[] = [
        ["t1", "next", "wait"],
        ["wait", "next", "yes"],
        ["wait", "timeout", "late"]
    ];

    it("goes on at once when the condition already holds", async () => {
        const seeded = await seed(
            [waiter(compare("{{trigger.door}}", "eq", "open")), say("yes"), say("late")],
            wires
        );
        const started = await fire(seeded, "k1", { door: "open" });
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["step yes"]);
        expect(step(started.id, "wait")).toMatchObject({ output: { matched: true, checks: 1 } });
    });

    it("checks again on every event on the shelf, and a restart mid-wait loses nothing", async () => {
        const seeded = await seed(
            [waiter(compare("{{event.payload.door}}", "eq", "open")), say("yes"), say("late")],
            wires
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        expect(step(started.id, "wait")).toMatchObject({
            status: "waiting",
            waitKey: "condition:user:u1"
        });
        engine.stopClaiming();
        engine.resumeClaiming();
        const shout = (door: string, userId = "u1") =>
            outbox.emitAutomationEvent("core.event", {
                userId,
                subjectKey: "door",
                payload: { name: "door", payload: { door } }
            });
        await shout("shut");
        await shout("open", "someone-else");
        await drain();
        expect(runRow(started.id).status).toBe("waiting");
        expect(step(started.id, "wait")!.output).toMatchObject({ checks: 2 });
        await shout("open");
        await drain();
        expect(titles()).toEqual(["step yes"]);
        expect(step(started.id, "wait")).toMatchObject({ port: "next", output: { matched: true } });
    });

    it("past the bound per event, the next event checks the waits the last one left", async () => {
        const seeded = await seed(
            [waiter(compare("{{event.payload.door}}", "eq", "open")), say("yes"), say("late")],
            wires
        );
        const started = await fire(seeded, "k1");
        await engine.advanceRun(started.id);
        for (let at = 0; at < core.AUTOMATION_LIMITS.conditionWaitsPerEvent; at++)
            fake().tables.automationStep!.push({
                id: `00000000-0000-0000-0000-${String(at).padStart(12, "0")}`,
                runId: "gone",
                nodeId: "wait",
                iteration: "0",
                status: "waiting",
                waitKey: "condition:user:u1"
            });
        const shout = () =>
            outbox.emitAutomationEvent("core.event", {
                userId: "u1",
                subjectKey: "door",
                payload: { name: "door", payload: { door: "shut" } }
            });
        await shout();
        await drain();
        expect(step(started.id, "wait")!.output).toMatchObject({ checks: 1 });
        await shout();
        await drain();
        expect(step(started.id, "wait")!.output).toMatchObject({ checks: 2 });
    });

    it("checks again on the clock, then times out", async () => {
        const seeded = await seed(
            [waiter(compare("{{trigger.door}}", "eq", "open")), say("yes"), say("late")],
            wires
        );
        const started = await fire(seeded, "k1", { door: "shut" });
        await engine.advanceRun(started.id);
        const first = step(started.id, "wait")!.waitUntil as Date;
        expect(first.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
        timePasses();
        await drain();
        expect(step(started.id, "wait")).toMatchObject({
            status: "waiting",
            output: { checks: 2 }
        });
        expect((step(started.id, "wait")!.waitUntil as Date).getTime()).toBeGreaterThan(Date.now());
        (step(started.id, "wait")!.input as { deadline: string }).deadline = new Date(
            Date.now() - 1000
        ).toISOString();
        timePasses();
        await drain();
        expect(titles()).toEqual(["step late"]);
        expect(step(started.id, "wait")).toMatchObject({
            port: "timeout",
            output: { matched: false, timedOut: true, checks: 3 }
        });
    });
});

describe("automation.finished", () => {
    async function watcher() {
        const seeded = await seed(
            [say("heard", "{{trigger.payload.automationName}} {{trigger.payload.outcome}}")],
            [["on", "next", "heard"]],
            { trigger: node("on", "core.onEvent", { name: core.AUTOMATION_FINISHED_EVENT }) }
        );
        await triggers.armVersion(seeded.automationId, seeded.versionId, seeded.graph);
        return seeded;
    }

    it("is sent for every live run's end, and never starts the automation it came from", async () => {
        const seen = await watcher();
        sent.statuses = [500];
        const ok = await seed([say("a")], [["t1", "next", "a"]]);
        const failing = await seed([http("h")], [["t1", "next", "h"]]);
        await engine.advanceRun((await fire(ok, "k1")).id);
        await engine.advanceRun((await fire(failing, "k2")).id);
        await drain();
        expect(titles().filter((title) => title.startsWith("Test"))).toEqual([
            "Test succeeded",
            "Test failed"
        ]);
        // The watcher's own runs announced their end too, and started nothing more.
        const own = fake().tables.automationRun!.filter(
            (row) => row.automationId === seen.automationId
        );
        expect(own).toHaveLength(2);
        expect(own.every((row) => row.depth === 1)).toBe(true);
        const events = fake().tables.automationEvent!.filter(
            (row) => row.subjectKey === core.AUTOMATION_FINISHED_EVENT
        );
        expect(events).toHaveLength(4);
        expect(events[0]).toMatchObject({
            type: "core.event",
            userId: "u1",
            depth: 1,
            payload: { name: "automation.finished", payload: { outcome: "succeeded" } }
        });
    });

    it("is not sent for a test run, a cancelled run says so, and the shelf's rate holds it", async () => {
        const seeded = await seed([pause("p")], [["t1", "next", "p"]]);
        const test = await engine.startRun({
            automationId: seeded.automationId,
            versionId: seeded.versionId,
            triggerNodeId: "t1",
            firingKey: "test",
            cause: { id: "t1" },
            depth: 0,
            test: true
        });
        await engine.advanceRun(test!.id);
        await engine.cancelRun(test!.id);
        const live = await fire(seeded, "k1");
        await engine.advanceRun(live.id);
        await engine.cancelRun(live.id);
        const finished = () =>
            fake().tables.automationEvent!.filter(
                (row) => row.subjectKey === core.AUTOMATION_FINISHED_EVENT
            );
        expect(finished()).toHaveLength(1);
        expect(finished()[0]!.payload).toMatchObject({ payload: { outcome: "cancelled" } });
        for (let at = 0; at < core.AUTOMATION_LIMITS.announceRate; at++)
            await outbox.emitAutomationEvent("core.event", {
                userId: "u1",
                subjectKey: "noise",
                payload: { name: "noise", payload: {} },
                dedupeKey: `noise${at}`
            });
        const more = await fire(seeded, "k2");
        await engine.advanceRun(more.id);
        await engine.cancelRun(more.id);
        expect(finished()).toHaveLength(1);
    });

    it("wakes a Wait for an event under its name", async () => {
        const seeded = await seed(
            [
                node("wait", "core.waitEvent", {
                    name: core.AUTOMATION_FINISHED_EVENT,
                    timeout: { amount: 1, unit: "hours" }
                }),
                say("done", "{{steps.wait.payload.outcome}}")
            ],
            [
                ["t1", "next", "wait"],
                ["wait", "next", "done"]
            ]
        );
        const waiting = await fire(seeded, "k1");
        await engine.advanceRun(waiting.id);
        const other = await seed([say("a")], [["t1", "next", "a"]]);
        await engine.advanceRun((await fire(other, "k2")).id);
        await drain();
        expect(titles()).toEqual(["step a", "succeeded"]);
    });

    it("takes only the endings ticked, on a trigger and on a wait", async () => {
        const seeded = await seed(
            [say("heard", "{{trigger.payload.outcome}}")],
            [["on", "next", "heard"]],
            {
                trigger: node("on", "core.onEvent", {
                    name: core.AUTOMATION_FINISHED_EVENT,
                    outcomes: ["failed"]
                })
            }
        );
        await triggers.armVersion(seeded.automationId, seeded.versionId, seeded.graph);
        const waiter = await seed(
            [
                node("wait", "core.waitEvent", {
                    name: core.AUTOMATION_FINISHED_EVENT,
                    outcomes: ["failed"],
                    timeout: { amount: 1, unit: "hours" }
                }),
                say("woke", "{{steps.wait.payload.outcome}}")
            ],
            [
                ["t1", "next", "wait"],
                ["wait", "next", "woke"]
            ]
        );
        await engine.advanceRun((await fire(waiter, "w1")).id);
        sent.statuses = [500];
        const ok = await seed([say("a")], [["t1", "next", "a"]]);
        await engine.advanceRun((await fire(ok, "k1")).id);
        await drain();
        expect(titles()).toEqual(["step a"]);
        const failing = await seed([http("h")], [["t1", "next", "h"]]);
        await engine.advanceRun((await fire(failing, "k2")).id);
        await drain();
        expect(
            titles()
                .filter((title) => title !== "step a")
                .sort()
        ).toEqual(["failed", "failed"]);
    });
});

describe("Set values", () => {
    it("works named values out once, typed, for later steps to read", async () => {
        const automation = await seed(
            [
                node("v", "core.set", {
                    values: [
                        { name: "who", value: "{{trigger.name}}" },
                        { name: "count", value: "{{trigger.n}}" },
                        { name: "line", value: "{{trigger.name}} x{{trigger.n}}" }
                    ]
                }),
                say("a", "{{steps.v.values.line}} / {{steps.v.values.who}}")
            ],
            [
                ["t1", "next", "v"],
                ["v", "next", "a"]
            ]
        );
        const started = await fire(automation, "k1", { name: "Ana", n: 3 });
        await engine.advanceRun(started.id);
        expect(titles()).toEqual(["Ana x3 / Ana"]);
        expect(step(started.id, "v")).toMatchObject({
            output: { values: { who: "Ana", count: 3, line: "Ana x3" } }
        });
    });

    it("is a node the graph accepts with its names checked", () => {
        const config = core.CORE_NODE_CONFIGS["core.set"];
        expect(config.safeParse({ values: [{ name: "ok_1", value: "x" }] }).success).toBe(true);
        expect(config.safeParse({ values: [{ name: "1bad", value: "x" }] }).success).toBe(false);
        expect(core.nodeRole("core.set")).toBe("action");
    });
});

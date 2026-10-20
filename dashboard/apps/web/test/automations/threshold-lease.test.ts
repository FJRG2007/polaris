/**
 * Two dashboard processes - the old and the new container during an update -
 * never both announce the same crossing: the pass runs under a lease that one
 * of them holds at a time and that expires on its own, and each row's due time
 * is compare-and-swapped, so even two passes at once read a row once.
 */

import * as core from "@polaris/core";
import { createFakeDb } from "./fixtures/fake-prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));
const reading = vi.hoisted(() => ({ value: 0, at: new Date(0) }));

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
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => ({ inapp: "sent" }) }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));
vi.mock("@/lib/automations/threshold-sources", () => {
    const source = { id: "host.cpu", unit: "%", read: async () => ({ ...reading }) };
    const kind = { kind: "host", subjects: async () => [], mayRead: async () => true, sources: [source] };
    return { thresholdSource: (id: string) => (id === "host.cpu" ? { kind, source } : null) };
});

const thresholds = await import("@/lib/automations/thresholds");
const triggers = await import("@/lib/automations/triggers");
const { withLease } = await import("@/lib/cron/lease");

const fake = () => db.current!;
const SUBJECT = "0192f6a0-0000-7000-8000-0000000000aa";

async function seed() {
    const graph = core.automationGraphSchema.parse({
        nodes: [
            {
                id: "t1",
                type: "core.threshold",
                position: { x: 0, y: 0 },
                config: { source: "host.cpu", subjectId: SUBJECT, value: 90, streak: 2, recovery: true }
            },
            { id: "a", type: "core.notify", position: { x: 0, y: 0 }, config: { title: "hot", body: "" } }
        ],
        edges: [{ from: { node: "t1", port: "next" }, to: { node: "a" } }]
    });
    const row = await fake().prisma.automation.create({
        data: { name: "Hot", draft: graph, enabled: true, runAsId: "u1", userId: "u1", mode: "parallel" }
    });
    const version = await fake().prisma.automationVersion.create({
        data: { automationId: row.id, number: 1, graph }
    });
    await fake().prisma.automation.update({
        where: { id: row.id },
        data: { publishedVersionId: version.id }
    });
    await triggers.armVersion(row.id, version.id, graph);
    return row.id;
}

/** A new sample, and the trigger due again - as a minute passing would leave it. */
function sample(value: number, minute: number) {
    reading.value = value;
    reading.at = new Date(Date.now() - 10 * 60_000 + minute * 60_000);
    for (const row of fake().tables.automationTrigger ?? [])
        row.nextDueAt = new Date(Date.now() - 1000);
}

beforeEach(() => {
    for (const key of Object.keys(fake().tables)) fake().tables[key] = [];
});

describe("the threshold pass", () => {
    it("starts one run per crossing when two processes check at the same moment", async () => {
        const automationId = await seed();
        const values = [95, 96, 97, 40, 41];
        for (const [minute, value] of values.entries()) {
            sample(value, minute);
            await Promise.all([thresholds.evaluateThresholds(), thresholds.evaluateThresholds()]);
        }
        const runs = (fake().tables.automationRun ?? []).filter(
            (run) => run.automationId === automationId
        );
        expect(runs.map((run) => (run.cause as { state: string }).state).sort()).toEqual([
            "alarm",
            "ok"
        ]);
    });

    it("does not start a run again for a crossing it already announced", async () => {
        await seed();
        sample(95, 0);
        await thresholds.evaluateThresholds();
        sample(96, 1);
        await thresholds.evaluateThresholds();
        // A pass that died after starting the run, before saving what it saw.
        const row = fake().tables.automationTrigger![0]!;
        row.state = { ...(row.state as object), state: "ok", streak: 1, sampledAt: null };
        row.nextDueAt = new Date(Date.now() - 1000);
        await thresholds.evaluateThresholds();
        expect(fake().tables.automationRun ?? []).toHaveLength(1);
    });

    it("runs under a lease only one process holds, which a dead holder gives up", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const first = withLease(thresholds.THRESHOLD_LEASE, 60_000, () => held.then(() => "first"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await withLease(thresholds.THRESHOLD_LEASE, 60_000, async () => "second")).toBeNull();
        release();
        expect(await first).toBe("first");
        expect(await withLease(thresholds.THRESHOLD_LEASE, 60_000, async () => "third")).toBe("third");
        // A holder that died: its expiry passes and the next process takes over.
        const lease = fake().tables.setting!.find((row) => String(row.key).endsWith(thresholds.THRESHOLD_LEASE))!;
        lease.value = `${new Date(Date.now() - 1000).toISOString()} dead`;
        expect(await withLease(thresholds.THRESHOLD_LEASE, 60_000, async () => "after")).toBe("after");
    });
});

/**
 * A threshold trigger keeps a history of its alarms: one episode per stretch in
 * alarm, opened on the crossing and closed on the way back with how long it
 * lasted and the worst value; the run it starts names the episode. Recording
 * the same crossing twice finds the same row, and pruning keeps an alarm still
 * going on while it drops old resolved ones and anything past the cap.
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
    const kind = {
        kind: "host",
        subjects: async () => [],
        mayRead: async () => true,
        sources: [source]
    };
    return { thresholdSource: (id: string) => (id === "host.cpu" ? { kind, source } : null) };
});

const thresholds = await import("@/lib/automations/thresholds");
const triggers = await import("@/lib/automations/triggers");
const episodes = await import("@/lib/automations/alarm-episodes");

const fake = () => db.current!;
const SUBJECT = "0192f6a0-0000-7000-8000-0000000000aa";
const DAY = 86_400_000;

async function seed(): Promise<string> {
    const graph = core.automationGraphSchema.parse({
        nodes: [
            {
                id: "t1",
                type: "core.threshold",
                position: { x: 0, y: 0 },
                config: {
                    source: "host.cpu",
                    subjectId: SUBJECT,
                    value: 90,
                    streak: 2,
                    recovery: true
                }
            },
            {
                id: "a",
                type: "core.notify",
                position: { x: 0, y: 0 },
                config: { title: "hot", body: "" }
            }
        ],
        edges: [{ from: { node: "t1", port: "next" }, to: { node: "a" } }]
    });
    const row = await fake().prisma.automation.create({
        data: {
            name: "Hot",
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
    await triggers.armVersion(row.id, version.id, graph);
    return row.id as string;
}

/** A new sample, the trigger due again, and one pass. */
async function check(value: number, minute: number) {
    reading.value = value;
    reading.at = new Date(Date.now() - 10 * 60_000 + minute * 60_000);
    for (const row of fake().tables.automationTrigger ?? [])
        row.nextDueAt = new Date(Date.now() - 1000);
    await thresholds.evaluateThresholds(100, episodes.recordEpisode);
}

beforeEach(() => {
    for (const key of Object.keys(fake().tables)) fake().tables[key] = [];
});

describe("alarm episodes", () => {
    it("opens one on the crossing and closes it on recovery, with its duration and worst value", async () => {
        const automationId = await seed();
        for (const [minute, value] of [95, 96, 99, 97, 40].entries()) await check(value, minute);
        const [episode, ...more] = await episodes.listEpisodes(automationId);
        expect(more).toHaveLength(0);
        expect(episode).toMatchObject({
            nodeId: "t1",
            source: "host.cpu",
            comparator: "gt",
            threshold: 90,
            startValue: 96,
            peakValue: 99,
            endValue: 40,
            durationSeconds: 180
        });
        const causes = (fake().tables.automationRun ?? []).map(
            (run) => run.cause as { state: string; episodeId: string }
        );
        expect(causes.map((cause) => cause.state).sort()).toEqual(["alarm", "ok"]);
        expect(new Set(causes.map((cause) => cause.episodeId))).toEqual(new Set([episode!.id]));
    });

    it("lists an alarm still going on with no end", async () => {
        const automationId = await seed();
        await check(95, 0);
        await check(96, 1);
        const [episode] = await episodes.listEpisodes(automationId);
        expect(episode).toMatchObject({ resolvedAt: null, durationSeconds: null });
    });

    it("finds the same row when a crossing is recorded twice", async () => {
        const automationId = await seed();
        const config = core.thresholdConfigSchema.parse({
            source: "host.cpu",
            subjectId: SUBJECT,
            value: 90
        });
        const at = new Date();
        const crossing = {
            state: "alarm" as const,
            at,
            value: 95,
            startedAt: at.toISOString(),
            startValue: 95,
            peak: 95,
            durationSeconds: null
        };
        const trigger = { automationId, nodeId: "t1" };
        const first = await episodes.recordEpisode(trigger, config, crossing);
        expect(await episodes.recordEpisode(trigger, config, crossing)).toBe(first);
        expect(fake().tables.automationAlarmEpisode).toHaveLength(1);
    });

    it("prunes old resolved episodes and the oldest past the cap, never an open one", async () => {
        const now = new Date();
        const old = new Date(now.getTime() - 100 * DAY);
        const base = {
            nodeId: "t1",
            source: "host.cpu",
            subjectId: SUBJECT,
            comparator: "gt",
            threshold: 90,
            startValue: 95,
            peakValue: 95,
            endValue: 40
        };
        const table: Record<string, unknown>[] = [];
        fake().tables.automationAlarmEpisode = table;
        table.push({ ...base, id: "old-resolved", automationId: "a1", startedAt: old, resolvedAt: old });
        table.push({
            ...base,
            id: "old-open",
            automationId: "a1",
            startedAt: old,
            resolvedAt: null,
            endValue: null
        });
        for (let index = 0; index < episodes.EPISODE_KEEP_PER_AUTOMATION + 3; index++)
            table.push({
                ...base,
                id: `b${index}`,
                automationId: "a2",
                startedAt: new Date(now.getTime() - index * 60_000),
                resolvedAt: now
            });
        expect(await episodes.pruneEpisodes(now)).toBe(4);
        const left = new Set(fake().tables.automationAlarmEpisode!.map((row) => row.id));
        expect(left.has("old-open")).toBe(true);
        expect(left.has("old-resolved")).toBe(false);
        expect(left.has("b0")).toBe(true);
        expect(left.has(`b${episodes.EPISODE_KEEP_PER_AUTOMATION + 2}`)).toBe(false);
        expect(left.size).toBe(1 + episodes.EPISODE_KEEP_PER_AUTOMATION);
    });
});

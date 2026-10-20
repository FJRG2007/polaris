/**
 * Carrying Watch alarms into Automations on boot: an alarm on a reading becomes
 * an automation that can be published as it is, says what Watch said where Watch
 * said it, is made once however many boots run, and is then no longer evaluated
 * by Watch. Reachability alarms have no reading and stay on Watch.
 */

import * as core from "@polaris/core";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-0000000000d1";
const HOST = "00000000-0000-4000-8000-0000000000d2";
const CHANNEL = "00000000-0000-4000-8000-0000000000d3";
const DESTINATION = "00000000-0000-4000-8000-0000000000d4";

interface Row {
    id: string;
    ownerId: string;
    name: string;
    targetType: string;
    targetId: string;
    metric: string;
    operator: string;
    threshold: number | null;
    forPeriods: number;
    enabled: boolean;
    notifyChannelId: string | null;
    notifyPeerId: string | null;
    carriedToId: string | null;
}

const store = vi.hoisted(() => ({
    rows: [] as Row[],
    /** legacyRef -> automation id, as the unique column keeps them. */
    automations: new Map<string, string>(),
    imports: [] as { legacyRef: string; graph: unknown; origin: string | null }[],
    ownsChannel: true
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        alarm: {
            findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
                store.rows
                    .filter(
                        (row) =>
                            row.enabled === where.enabled &&
                            row.carriedToId === null &&
                            (where.metric as { in: string[] }).in.includes(row.metric) &&
                            row.threshold !== null &&
                            (!where.id || row.id > (where.id as { gt: string }).gt)
                    )
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .slice(0, take),
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string; carriedToId: null };
                data: { carriedToId: string };
            }) => {
                const row = store.rows.find((entry) => entry.id === where.id);
                if (row && row.carriedToId === null) row.carriedToId = data.carriedToId;
            }
        }
    }
}));
vi.mock("@/lib/automations/app-bridge", () => ({
    importAutomation: async (given: { legacyRef: string; graph: unknown; origin: string | null }) => {
        store.imports.push(given);
        const known = store.automations.get(given.legacyRef);
        if (known) return known;
        const id = `00000000-0000-4000-8000-00000000a${String(store.automations.size).padStart(3, "0")}`;
        store.automations.set(given.legacyRef, id);
        return id;
    }
}));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string, params: Record<string, string> = {}) =>
        `${key}(${Object.values(params).join("|")})`
}));
vi.mock("@/lib/notifications/preferences", () => ({
    ruleFor: async (_user: string, event: string) =>
        event === "watch.alarm"
            ? { inapp: true, email: true, destinations: [DESTINATION] }
            : { inapp: false, email: false, destinations: [] }
}));
vi.mock("@/lib/automations/notice-targets", () => ({
    mayUseMessagingChannel: async () => store.ownsChannel
}));

const carry = await import("../../src/lib/watch/alarm-carry");

function alarm(overrides: Partial<Row> = {}): Row {
    return {
        id: "00000000-0000-4000-8000-000000000101",
        ownerId: OWNER,
        name: "API CPU high",
        targetType: "host",
        targetId: HOST,
        metric: "cpu",
        operator: "gt",
        threshold: 90,
        forPeriods: 2,
        enabled: true,
        notifyChannelId: CHANNEL,
        notifyPeerId: "12345",
        carriedToId: null,
        ...overrides
    };
}

const WORDS = { alarmTitle: "Alarm", alarmBody: "b", recoveredTitle: "Recovered", recoveredBody: "b" };
const DELIVERY = { alarm: core.DEFAULT_NOTICE_DELIVERY, recovered: core.DEFAULT_NOTICE_DELIVERY };

beforeEach(() => {
    store.rows = [];
    store.automations.clear();
    store.imports = [];
    store.ownsChannel = true;
});

describe("the automation an alarm becomes", () => {
    it("is a threshold on the same reading that can be published as it is", () => {
        const result = carry.watchAlarmGraph(alarm({ operator: "lt", forPeriods: 4 }), WORDS, DELIVERY);
        if (!result.ok) throw new Error(result.reason);
        expect(core.graphProblems(result.graph, { forPublish: true })).toEqual([]);
        const trigger = result.graph.nodes.find((node) => node.type === "core.threshold");
        expect(trigger?.config).toEqual({
            source: "host.cpu",
            subjectId: HOST,
            comparator: "lt",
            value: 90,
            streak: 4,
            recovery: true
        });
    });

    it("reads a service's figures as the app source", () => {
        expect(carry.carrySource({ targetType: "application", metric: "disk" })).toBe("app.disk");
    });

    it("leaves reachability alarms on Watch", () => {
        expect(carry.watchAlarmGraph(alarm({ metric: "http", targetType: "domain" }), WORDS, DELIVERY)).toEqual({
            ok: false,
            reason: "reachability"
        });
        expect(
            carry.watchAlarmGraph(alarm({ metric: "service", targetType: "application" }), WORDS, DELIVERY)
        ).toEqual({ ok: false, reason: "reachability" });
    });

    it("keeps Watch's bell when the owner's rule sends the event nowhere", () => {
        expect(carry.deliveryFromRule({ inapp: false, email: false, destinations: [] }, null).bell).toBe(true);
    });
});

describe("carrying on boot", () => {
    it("carries an alarm once, however many boots run, and marks it", async () => {
        store.rows = [alarm()];
        expect(await carry.carryWatchAlarms()).toBe(1);
        expect(await carry.carryWatchAlarms()).toBe(0);
        expect(store.automations.size).toBe(1);
        expect(store.imports).toHaveLength(1);
        expect(store.imports[0]).toMatchObject({ legacyRef: `watch-alarm:${alarm().id}`, origin: null });
        expect(store.rows[0]!.carriedToId).toBe([...store.automations.values()][0]);
    });

    it("finds the twin a crashed boot made and only marks the alarm", async () => {
        store.automations.set(`watch-alarm:${alarm().id}`, "00000000-0000-4000-8000-00000000beef");
        store.rows = [alarm()];
        await carry.carryWatchAlarms();
        expect(store.rows[0]!.carriedToId).toBe("00000000-0000-4000-8000-00000000beef");
    });

    it("tells the same places: the owner's rule, and the alarm's messaging peer", async () => {
        store.rows = [alarm()];
        await carry.carryWatchAlarms();
        const graph = core.automationGraphSchema.parse(store.imports[0]!.graph);
        const fired = graph.nodes.find((node) => node.id === "fired")!.config as {
            title: string;
            delivery: core.NoticeDelivery;
        };
        expect(fired.title).toBe("notices.alarm(API CPU high)");
        expect(fired.delivery).toMatchObject({
            bell: true,
            email: true,
            destinations: [DESTINATION],
            messaging: { channelId: CHANNEL, peerId: "12345" }
        });
        const cleared = graph.nodes.find((node) => node.id === "cleared")!.config as {
            delivery: core.NoticeDelivery;
        };
        // The owner's rule sends a recovery nowhere, as Watch did: only the peer is told.
        expect(cleared.delivery).toMatchObject({ bell: false, messaging: { peerId: "12345" } });
    });

    it("drops a messaging channel the owner no longer has", async () => {
        store.ownsChannel = false;
        store.rows = [alarm()];
        await carry.carryWatchAlarms();
        const graph = core.automationGraphSchema.parse(store.imports[0]!.graph);
        const fired = graph.nodes.find((node) => node.id === "fired")!.config as {
            delivery: core.NoticeDelivery;
        };
        expect(fired.delivery.messaging).toBeNull();
    });

    it("leaves disabled and reachability alarms alone", async () => {
        store.rows = [
            alarm({ id: "00000000-0000-4000-8000-000000000201", enabled: false }),
            alarm({ id: "00000000-0000-4000-8000-000000000202", metric: "http", threshold: null })
        ];
        expect(await carry.carryWatchAlarms()).toBe(0);
        expect(store.rows.every((row) => row.carriedToId === null)).toBe(true);
    });
});

describe("Watch after the carry", () => {
    it("no longer evaluates a carried alarm", async () => {
        const source = await readFile(new URL("../../src/lib/watch/alarm-evaluator.ts", import.meta.url), "utf8");
        expect(source).toContain("where: { enabled: true, carriedToId: null }");
    });
});

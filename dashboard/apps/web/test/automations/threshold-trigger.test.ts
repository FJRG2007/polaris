/**
 * "When a reading crosses a threshold" fires on the transition, never on every
 * sample: a streak of breaching samples moves it into alarm once, a clean
 * sample brings it back, one sample is never counted twice, and missing data
 * holds the state instead of resolving an alarm nobody can see.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import { compare, stepAlarm, worse } from "@/lib/alarm-state";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("@/lib/automations/engine", () => ({
    loadGraph: async () => null,
    startRun: async () => null
}));
vi.mock("@/lib/automations/runner", () => ({ automationRunner: async () => null }));
vi.mock("@/lib/automations/threshold-sources", () => ({ thresholdSource: () => null }));

const thresholds = await import("@/lib/automations/thresholds");
const triggers = await import("@/lib/automations/triggers");

const SUBJECT = "0192f6a0-0000-7000-8000-0000000000aa";
const config = core.thresholdConfigSchema.parse({
    source: "host.cpu",
    subjectId: SUBJECT,
    comparator: "gt",
    value: 90,
    streak: 3
});
const t0 = Date.parse("2030-01-01T00:00:00Z");
const at = (minute: number) => new Date(t0 + minute * 60_000);

/** Feed one value per minute and say which minutes crossed, and how. */
function feed(values: (number | string)[], sameSampleTwice = false) {
    let memory = thresholds.readMemory(null, "c");
    const crossings: { minute: number; state: string; peak: number; duration: number | null }[] =
        [];
    values.forEach((value, minute) => {
        const reading = typeof value === "string" ? value : { value, at: at(minute) };
        const passes = sameSampleTwice ? 2 : 1;
        for (let pass = 0; pass < passes; pass++) {
            const result = thresholds.judge(memory, config, reading, at(minute + pass * 0.5));
            memory = result.memory;
            if (result.crossing)
                crossings.push({
                    minute,
                    state: result.crossing.state,
                    peak: result.crossing.peak,
                    duration: result.crossing.durationSeconds
                });
        }
    });
    return { memory, crossings };
}

describe("the shared alarm state machine", () => {
    it("compares with every comparator and knows which way is worse", () => {
        expect([compare(91, "gt", 90), compare(90, "gt", 90), compare(90, "gte", 90)]).toEqual([
            true,
            false,
            true
        ]);
        expect([compare(29, "lt", 30), compare(30, "lt", 30), compare(30, "lte", 30)]).toEqual([
            true,
            false,
            true
        ]);
        expect(worse("gt", 91, 95)).toBe(95);
        expect(worse("lt", 20, 25)).toBe(20);
    });

    it("fires once the streak is reached and resolves on the first clean sample", () => {
        let prior = { state: "ok", streak: 0 };
        const transitions: (string | null)[] = [];
        for (const breach of [true, true, true, true, false]) {
            const step = stepAlarm(prior, { breach, insufficient: false }, 3);
            transitions.push(step.transition);
            prior = step;
        }
        expect(transitions).toEqual([null, null, "triggered", null, "resolved"]);
    });

    it("keeps the streak through a sample with no data, as Watch always did", () => {
        const step = stepAlarm(
            { state: "ok", streak: 2 },
            { breach: false, insufficient: true },
            3
        );
        expect(step).toEqual({ state: "insufficient", streak: 2, transition: null });
    });
});

describe("a threshold trigger", () => {
    it("crosses into alarm once after the streak, not on every breaching sample", () => {
        const { crossings, memory } = feed([95, 96, 97, 99, 98, 97]);
        expect(crossings).toEqual([{ minute: 2, state: "alarm", peak: 97, duration: null }]);
        expect(memory.state).toBe("alarm");
        expect(memory.episode?.peak).toBe(99);
    });

    it("does not fire on a blip shorter than the streak", () => {
        expect(feed([95, 96, 50, 95, 50]).crossings).toEqual([]);
    });

    it("recovers once, with how long it lasted and the worst value", () => {
        const { crossings, memory } = feed([95, 96, 97, 99, 40, 30]);
        expect(crossings[1]).toEqual({ minute: 4, state: "ok", peak: 99, duration: 120 });
        expect(crossings).toHaveLength(2);
        expect(memory.episode).toBeNull();
    });

    it("never counts the same sample twice when it is checked again before the next one", () => {
        expect(feed([95, 96, 97], true).crossings.map((entry) => entry.minute)).toEqual([2]);
    });

    it("holds an alarm through missing data instead of resolving it", () => {
        const { crossings, memory } = feed([95, 96, 97, "no recent metrics", "no recent metrics"]);
        expect(crossings).toHaveLength(1);
        expect(memory.state).toBe("alarm");
        expect(memory.missing).toBe("no recent metrics");
    });

    it("starts over when its config changes", () => {
        const { memory } = feed([95, 96, 97]);
        expect(thresholds.readMemory(memory, "c").state).toBe("alarm");
        expect(thresholds.readMemory(memory, "other").state).toBe("ok");
    });

    it("tells the run what crossed", () => {
        const { crossings } = feed([95, 96, 97, 40]);
        expect(crossings).toHaveLength(2);
        const judged = thresholds.judge(
            thresholds.readMemory(null, "c"),
            { ...config, streak: 1 },
            { value: 93, at: at(0) },
            at(0)
        );
        expect(thresholds.crossingCause("t1", config, judged.crossing!, "e1")).toMatchObject({
            id: "t1",
            kind: "threshold",
            state: "alarm",
            value: 93,
            threshold: 90,
            comparator: "gt",
            source: "host.cpu",
            subjectId: SUBJECT,
            episodeId: "e1"
        });
    });

    it("rejects a config without a subject or with a malformed source", () => {
        expect(core.thresholdConfigSchema.safeParse({ ...config, subjectId: "" }).success).toBe(
            false
        );
        expect(core.thresholdConfigSchema.safeParse({ ...config, source: "CPU" }).success).toBe(
            false
        );
    });

    it("is armed due now, and keeps its memory through a publish that left it alone", () => {
        const graph = core.automationGraphSchema.parse({
            nodes: [
                {
                    id: "t1",
                    type: "core.threshold",
                    position: { x: 0, y: 0 },
                    config
                }
            ]
        });
        const now = new Date();
        const [first] = triggers.armedTriggers("a1", graph, [], now);
        expect(first).toMatchObject({
            eventType: "core.threshold",
            subjectKey: `host.cpu:${SUBJECT}`,
            nextDueAt: now
        });
        const remembered = { ...first!.state, state: "alarm", streak: 4 };
        const due = new Date(now.getTime() + 30_000);
        const [kept] = triggers.armedTriggers(
            "a1",
            graph,
            [{ nodeId: "t1", nextDueAt: due, state: remembered }],
            now
        );
        expect(kept!.nextDueAt).toEqual(due);
        expect(kept!.state).toMatchObject({ state: "alarm", streak: 4 });
    });
});

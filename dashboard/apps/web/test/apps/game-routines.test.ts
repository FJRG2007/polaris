/**
 * Errands on a schedule: when one is due, and when it has already happened.
 *
 * The two failures worth guarding are opposite and both are bad. A rule that only
 * fires on an exact match misses the errand whenever the sweep lands a few seconds
 * into the next minute, which is most of the time - so the schedule appears to work
 * and silently does not. A rule with no memory fires again on the next pass, which
 * is a server restarted twice in a row with people on it.
 */

import { describe, expect, it } from "vitest";
import { readRoutineRuns, readSchedule, routinesDue, type GameSchedule } from "@/lib/apps/minecraft/schedule";

/** A schedule with one nightly restart at 04:00 UTC. */
function nightly(over: Partial<GameSchedule> = {}): GameSchedule {
    return {
        ...readSchedule({}),
        enabled: true,
        timezone: "UTC",
        routines: [
            {
                id: "r1",
                name: "Nightly restart",
                enabled: true,
                days: [],
                at: "04:00",
                actions: [{ kind: "restart", value: "" }]
            }
        ],
        ...over
    };
}

const at = (iso: string) => new Date(iso);

describe("when a routine is due", () => {
    it("fires on the minute it asks for", () => {
        expect(routinesDue(nightly(), at("2026-08-13T04:00:10.000Z"), {}).map((r) => r.id)).toEqual(["r1"]);
    });

    it("still fires when the sweep was a few minutes late", () => {
        // Nothing runs exactly on the minute. A rule that insisted would work on a
        // quiet box and quietly stop working on a busy one.
        expect(routinesDue(nightly(), at("2026-08-13T04:03:00.000Z"), {})).toHaveLength(1);
    });

    it("does not fire hours later for a moment that has passed", () => {
        // Somebody's box was asleep. An errand suddenly happening at lunchtime
        // because it was owed from four in the morning is worse than a missed one.
        expect(routinesDue(nightly(), at("2026-08-13T11:00:00.000Z"), {})).toEqual([]);
    });

    it("does not fire before its time", () => {
        expect(routinesDue(nightly(), at("2026-08-13T03:59:00.000Z"), {})).toEqual([]);
    });

    it("does not fire twice for the same occurrence", () => {
        const runs = { r1: { at: "2026-08-13T04:00:12.000Z", ok: true, detail: "" } };
        expect(routinesDue(nightly(), at("2026-08-13T04:01:00.000Z"), runs)).toEqual([]);
    });

    it("fires again the next day", () => {
        const runs = { r1: { at: "2026-08-12T04:00:12.000Z", ok: true, detail: "" } };
        expect(routinesDue(nightly(), at("2026-08-13T04:00:30.000Z"), runs)).toHaveLength(1);
    });

    it("respects the days it was given", () => {
        // 2026-08-13 is a Thursday.
        const thursday = nightly({
            routines: [{ ...nightly().routines[0]!, days: [1, 2] }]
        });
        expect(routinesDue(thursday, at("2026-08-13T04:00:10.000Z"), {})).toEqual([]);
    });

    it("runs nothing while the schedule itself is off", () => {
        expect(routinesDue(nightly({ enabled: false }), at("2026-08-13T04:00:10.000Z"), {})).toEqual([]);
        expect(
            routinesDue(nightly({ routines: [{ ...nightly().routines[0]!, enabled: false }] }), at("2026-08-13T04:00:10.000Z"), {})
        ).toEqual([]);
    });

    it("reads the time in the schedule's own zone, not the server's", () => {
        // 04:00 in Madrid is 02:00 UTC in August.
        const madrid = nightly({ timezone: "Europe/Madrid" });
        expect(routinesDue(madrid, at("2026-08-13T02:00:10.000Z"), {})).toHaveLength(1);
        expect(routinesDue(madrid, at("2026-08-13T04:00:10.000Z"), {})).toEqual([]);
    });
});

describe("what comes back out of the settings blob", () => {
    it("drops a routine with no actions rather than keeping an empty one", () => {
        const schedule = readSchedule({
            schedule: { enabled: true, routines: [{ id: "x", at: "04:00", actions: [] }] }
        });
        expect(schedule.routines).toEqual([]);
    });

    it("drops a step that needs words and was given none", () => {
        // An empty broadcast is a message nobody sees, in the middle of a sequence
        // that assumed it was sent.
        const schedule = readSchedule({
            schedule: {
                enabled: true,
                routines: [
                    {
                        id: "x",
                        at: "04:00",
                        actions: [{ kind: "broadcast", value: "  " }, { kind: "restart" }]
                    }
                ]
            }
        });
        expect(schedule.routines[0]?.actions).toEqual([{ kind: "restart", value: "" }]);
    });

    it("survives a blob written by hand", () => {
        expect(readSchedule({ schedule: { enabled: true, routines: "nonsense" } }).routines).toEqual([]);
        expect(readRoutineRuns({ routineRuns: 7 })).toEqual({});
    });
});

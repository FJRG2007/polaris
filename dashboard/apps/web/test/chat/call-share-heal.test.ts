/**
 * A shared screen that puts itself back together.
 *
 * The outage: a sharer reconnected, the client republished the screen, the
 * server refused a layer of it, and viewers saw nothing until the sharer
 * stopped and shared again by hand. The sharer now republishes on a bounded
 * backoff; a viewer whose subscription never decodes a frame takes it again a
 * few times and only then says so. A still document - frames that stopped
 * after they started - is never judged, because nothing is wrong with it.
 */

import { describe, expect, it } from "vitest";
import {
    SHARE_REPUBLISH_DELAYS_MS,
    SHARE_RESUBSCRIBE_TRIES,
    SHARE_STALL_MS,
    republishDelay,
    watchShare,
    type ShareWatch
} from "@/app/(app)/chat/call-share-heal";

describe("republishing a shared screen", () => {
    it("waits longer each try and stops once the tries are spent", () => {
        const waits = SHARE_REPUBLISH_DELAYS_MS.map((_, attempt) => republishDelay(attempt));
        expect(waits).toEqual([...SHARE_REPUBLISH_DELAYS_MS]);
        for (let i = 1; i < waits.length; i += 1) {
            expect(waits[i]!).toBeGreaterThan(waits[i - 1]!);
        }
        expect(republishDelay(SHARE_REPUBLISH_DELAYS_MS.length)).toBeNull();
    });

    it("refuses an attempt that is not a count", () => {
        expect(republishDelay(-1)).toBeNull();
        expect(republishDelay(0.5)).toBeNull();
    });
});

/** Feed one sid a run of readings, returning every verdict and the last watch. */
function run(readings: readonly { frames: number | undefined; at: number }[], sid = "TR_1") {
    let watch: ShareWatch | undefined;
    const verdicts: string[] = [];
    for (const reading of readings) {
        const step = watchShare(watch, { sid, ...reading });
        watch = step.watch;
        verdicts.push(step.verdict);
    }
    return { watch: watch!, verdicts };
}

describe("a viewer watching a shared screen", () => {
    it("leaves a screen that is delivering alone", () => {
        const { verdicts } = run([
            { frames: 0, at: 0 },
            { frames: 30, at: 2_500 },
            { frames: 60, at: 5_000 },
            { frames: 90, at: 7_500 }
        ]);
        expect(verdicts.every((verdict) => verdict === "wait")).toBe(true);
    });

    it("never judges a still screen - frames that stopped after they started", () => {
        const readings = [
            { frames: 0, at: 0 },
            { frames: 4, at: 2_500 }
        ];
        for (let at = 5_000; at <= 120_000; at += 2_500) readings.push({ frames: 4, at });
        expect(run(readings).verdicts.every((verdict) => verdict === "wait")).toBe(true);
    });

    it("takes a screen again when it has decoded nothing for the stall time", () => {
        const { verdicts, watch } = run([
            { frames: undefined, at: 0 },
            { frames: 0, at: SHARE_STALL_MS - 1 },
            { frames: 0, at: SHARE_STALL_MS }
        ]);
        expect(verdicts).toEqual(["wait", "wait", "resubscribe"]);
        expect(watch.tries).toBe(1);
    });

    it("waits longer after each try, then says so once, and only once", () => {
        let watch: ShareWatch | undefined;
        const verdicts: string[] = [];
        for (let at = 0; at <= 200_000; at += 2_500) {
            const step = watchShare(watch, { sid: "TR_1", frames: 0, at });
            watch = step.watch;
            if (step.verdict !== "wait") verdicts.push(`${step.verdict}@${at}`);
        }
        const tries = verdicts.filter((verdict) => verdict.startsWith("resubscribe"));
        expect(tries).toHaveLength(SHARE_RESUBSCRIBE_TRIES);
        expect(verdicts.filter((verdict) => verdict.startsWith("give-up"))).toHaveLength(1);
        const times = tries.map((verdict) => Number(verdict.split("@")[1]));
        for (let i = 1; i < times.length; i += 1) {
            expect(times[i]! - times[i - 1]!).toBeGreaterThan(times[0]!);
        }
    });

    it("counts a mended screen as mended, with its tries back", () => {
        const { watch, verdicts } = run([
            { frames: 0, at: 0 },
            { frames: 0, at: SHARE_STALL_MS },
            { frames: 12, at: SHARE_STALL_MS + 2_500 }
        ]);
        expect(verdicts).toEqual(["wait", "resubscribe", "wait"]);
        expect(watch).toMatchObject({ decoded: true, tries: 0, gaveUp: false });
    });

    it("times a new receiver from its own start", () => {
        // Decoding, then a resubscription hands over a receiver at zero.
        const { watch, verdicts } = run([
            { frames: 50, at: 0 },
            { frames: 0, at: 2_500 },
            { frames: 0, at: 2_500 + SHARE_STALL_MS - 1 }
        ]);
        expect(verdicts).toEqual(["wait", "wait", "wait"]);
        expect(watch).toMatchObject({ decoded: false, since: 2_500 });
    });

    it("starts over for a new publication", () => {
        const first = run([
            { frames: 0, at: 0 },
            { frames: 0, at: SHARE_STALL_MS }
        ]).watch;
        const step = watchShare(first, { sid: "TR_2", frames: 0, at: SHARE_STALL_MS + 1 });
        expect(step.verdict).toBe("wait");
        expect(step.watch).toMatchObject({ sid: "TR_2", tries: 0 });
    });
});

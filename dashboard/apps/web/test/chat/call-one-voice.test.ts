/**
 * A person is heard once in a call.
 *
 * Reported as "some people sound like they are in a bigger room than before":
 * two microphone publications from one browser - the raw one and the filtered
 * one a few milliseconds behind - both played by the one element that plays that
 * person. What is pinned: a listener plays one microphone per person; publishes
 * of one source take turns, so two callers cannot both find none up and both put
 * one up; and what a raced publish left behind is found to take down.
 */

import { describe, expect, it, vi } from "vitest";
import { extraPublications, oneVoice, serialized } from "@/app/(app)/chat/call-tracks";

const MIC = "microphone";

describe("what a listener plays for one person", () => {
    it("is one microphone, the newest, and everything else they send", () => {
        const tracks = [
            { source: MIC, kind: "audio", track: "raw mic" },
            { source: "camera", kind: "video", track: "camera" },
            { source: MIC, kind: "audio", track: "filtered mic" }
        ];
        expect(oneVoice(tracks, MIC)).toEqual(["camera", "filtered mic"]);
    });

    it("leaves somebody with a single microphone exactly as they were", () => {
        const tracks = [
            { source: MIC, kind: "audio", track: "mic" },
            { source: "camera", kind: "video", track: "camera" }
        ];
        expect(oneVoice(tracks, MIC)).toEqual(["mic", "camera"]);
        expect(oneVoice([], MIC)).toEqual([]);
    });
});

describe("what a publish leaves behind", () => {
    it("is every other publication of that source", () => {
        const kept = { source: MIC, id: "b" };
        const all = [{ source: MIC, id: "a" }, kept, { source: "camera", id: "c" }];
        expect(extraPublications(all, MIC, kept)).toEqual([{ source: MIC, id: "a" }]);
        // Taking the source down entirely leaves nothing of it up.
        expect(extraPublications(all, MIC, undefined).map((one) => one.id)).toEqual(["a", "b"]);
    });
});

describe("publishing one source at a time", () => {
    /** A connection that, like the real one, only shows a publication once the
     *  publish that made it has finished. */
    function connection() {
        const up: string[] = [];
        const publish = async (name: string) => {
            const already = up.length > 0;
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (!already) up.push(name);
        };
        return { up, publish };
    }

    it("puts up one microphone when two callers ask at the same moment", async () => {
        const turn = serialized();
        const { up, publish } = connection();
        await Promise.all([turn(MIC, () => publish("joining")), turn(MIC, () => publish("filter changed"))]);
        expect(up).toEqual(["joining"]);
    });

    it("without taking turns, the same two put up two - the fault this closes", async () => {
        const { up, publish } = connection();
        await Promise.all([publish("joining"), publish("filter changed")]);
        expect(up).toEqual(["joining", "filter changed"]);
    });

    it("carries on after a publish that failed, and keeps sources apart", async () => {
        const turn = serialized();
        const order: string[] = [];
        const failed = turn(MIC, async () => {
            order.push("first");
            throw new Error("timed out");
        });
        const camera = turn("camera", async () => order.push("camera"));
        const second = turn(MIC, async () => order.push("second"));
        await expect(failed).rejects.toThrow("timed out");
        await Promise.all([camera, second]);
        expect(order).toEqual(["first", "camera", "second"]);
    });

    it("never waits for ever behind a publish that does not finish", async () => {
        vi.useFakeTimers();
        try {
            const turn = serialized(1000);
            void turn(MIC, () => new Promise(() => undefined));
            let ran = false;
            const next = turn(MIC, async () => {
                ran = true;
            });
            await vi.advanceTimersByTimeAsync(999);
            expect(ran).toBe(false);
            await vi.advanceTimersByTimeAsync(2);
            await next;
            expect(ran).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

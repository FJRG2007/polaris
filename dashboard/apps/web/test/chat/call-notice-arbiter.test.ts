/**
 * Which of a call's notices is said, and which wait behind it.
 *
 * Reported as a call whose notices stacked up when the call server went away -
 * the server lost, the microphone not being sent, rejoin, the microphone silent -
 * and took the height the pictures and the controls needed. What is pinned: a
 * root cause folds its consequences, the most serious notice is the one line,
 * the microphone button is marked with the notice that belongs there, and
 * nothing that was found is thrown away.
 */

import { describe, expect, it } from "vitest";
import {
    arbitrateNotices,
    type CallNotice,
    type NoticeCause,
    type NoticeSeverity
} from "@/app/(app)/chat/call-notices";

function notice(id: string, cause: NoticeCause, severity: NoticeSeverity = "warning"): CallNotice {
    return { id, cause, severity };
}

const ids = (list: readonly CallNotice[]) => list.map((item) => item.id);

/** Every notice handed in comes back exactly once, in one of the three places. */
function expectNothingLost(active: readonly CallNotice[]) {
    const order = arbitrateNotices(active);
    const out = [
        ...(order.top ? [order.top] : []),
        ...order.rest,
        ...order.consequences
    ];
    expect(ids(out).sort()).toEqual(ids(active).sort());
}

describe("the call notice arbiter", () => {
    it("says nothing when there is nothing", () => {
        expect(arbitrateNotices([])).toEqual({ top: null, rest: [], consequences: [], mic: null });
    });

    it("folds everything the lost call server explains behind it - the reported case", () => {
        const active = [
            notice("mic-not-sent", "mic-fault", "error"),
            notice("no-audio", "mic-silent"),
            notice("quiet", "mic-quiet"),
            notice("slow", "line"),
            notice("server", "server", "error")
        ];
        const order = arbitrateNotices(active);
        expect(order.top?.id).toBe("server");
        expect(order.rest).toEqual([]);
        expect(ids(order.consequences).sort()).toEqual(["mic-not-sent", "no-audio", "quiet", "slow"]);
        // A microphone cannot be faulted through a connection that is not there.
        expect(order.mic).toBeNull();
        expectNothingLost(active);
    });

    it.each<NoticeCause>(["line", "mic-fault", "mic-silent", "mic-quiet", "sound", "far-end"])(
        "the call server explains %s",
        (cause) => {
            const order = arbitrateNotices([notice("x", cause, "error"), notice("s", "server", "warning")]);
            expect(order.top?.id).toBe("s");
            expect(ids(order.consequences)).toEqual(["x"]);
        }
    );

    it.each<NoticeCause>(["share", "other"])("the call server never explains %s", (cause) => {
        const order = arbitrateNotices([notice("x", cause, "info"), notice("s", "server", "error")]);
        expect(order.top?.id).toBe("s");
        expect(ids(order.rest)).toEqual(["x"]);
        expect(order.consequences).toEqual([]);
    });

    it("a microphone not being sent explains it being silent and quiet", () => {
        const order = arbitrateNotices([
            notice("quiet", "mic-quiet"),
            notice("silent", "mic-silent"),
            notice("fault", "mic-fault", "error")
        ]);
        expect(order.top?.id).toBe("fault");
        expect(ids(order.consequences).sort()).toEqual(["quiet", "silent"]);
        expect(order.mic?.id).toBe("fault");
    });

    it("a silent microphone explains it being quiet", () => {
        const order = arbitrateNotices([notice("quiet", "mic-quiet"), notice("silent", "mic-silent")]);
        expect(order.top?.id).toBe("silent");
        expect(ids(order.consequences)).toEqual(["quiet"]);
        expect(order.mic?.id).toBe("silent");
    });

    it("causes that explain nothing leave each other standing", () => {
        const active = [
            notice("line", "line"),
            notice("sound", "sound"),
            notice("far", "far-end"),
            notice("quiet", "mic-quiet"),
            notice("share", "share", "info")
        ];
        const order = arbitrateNotices(active);
        expect(order.consequences).toEqual([]);
        expect(1 + order.rest.length).toBe(active.length);
        expect(order.mic?.id).toBe("quiet");
    });

    it("the same cause said twice is one standing notice and one consequence", () => {
        const order = arbitrateNotices([
            notice("server", "server", "error"),
            notice("diagnosis", "server", "error")
        ]);
        expect(order.top?.id).toBe("server");
        expect(order.rest).toEqual([]);
        expect(ids(order.consequences)).toEqual(["diagnosis"]);
    });

    it("between two the same, the more serious is said", () => {
        const order = arbitrateNotices([
            notice("reconnecting", "server", "warning"),
            notice("lost", "server", "error")
        ]);
        expect(order.top?.id).toBe("lost");
        expect(ids(order.consequences)).toEqual(["reconnecting"]);
    });

    it("orders by severity first, then by how near the root the cause is", () => {
        const order = arbitrateNotices([
            notice("share", "share", "info"),
            notice("far", "far-end", "warning"),
            notice("other", "other", "error"),
            notice("line", "line", "warning"),
            notice("sound", "sound", "warning"),
            notice("quiet", "mic-quiet", "warning")
        ]);
        expect(order.top?.id).toBe("other");
        expect(ids(order.rest)).toEqual(["line", "quiet", "sound", "far", "share"]);
    });

    it("an error about the microphone goes before a warning about the line", () => {
        const order = arbitrateNotices([notice("line", "line"), notice("mic", "mic-fault", "error")]);
        expect(ids([order.top!, ...order.rest])).toEqual(["mic", "line"]);
    });

    it("marks the microphone with the first standing microphone notice, never a consequence", () => {
        const order = arbitrateNotices([
            notice("other", "other", "error"),
            notice("quiet", "mic-quiet"),
            notice("silent", "mic-silent")
        ]);
        expect(order.top?.id).toBe("other");
        expect(order.mic?.id).toBe("silent");
    });

    it("does not change the list it was given", () => {
        const active = [notice("b", "line"), notice("a", "server", "error")];
        arbitrateNotices(active);
        expect(ids(active)).toEqual(["b", "a"]);
    });

    it("loses nothing whatever arrives together", () => {
        const causes: NoticeCause[] = [
            "server",
            "line",
            "mic-fault",
            "mic-silent",
            "mic-quiet",
            "sound",
            "far-end",
            "share",
            "other"
        ];
        // Every subset of the causes, each at a severity that varies with it.
        const severities: NoticeSeverity[] = ["error", "warning", "info"];
        for (let mask = 1; mask < 1 << causes.length; mask++) {
            const active = causes
                .filter((_, index) => mask & (1 << index))
                .map((cause, index) => notice(cause, cause, severities[(mask + index) % 3]));
            expectNothingLost(active);
            const order = arbitrateNotices(active);
            // Something stands whenever anything was found.
            expect(order.top).not.toBeNull();
        }
    });
});

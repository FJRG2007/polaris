/**
 * What the call stage in a conversation shows: ringing, a call in progress, or
 * nothing - and which frames start and stop the ringing.
 */

import { describe, expect, it } from "vitest";
import {
    cardRingIn,
    cardRingsKey,
    publishCardRings,
    ringAfter,
    ringExpired,
    showStage,
    shownStages,
    stageMode,
    stageShown,
    subscribeStages,
    type StageRing
} from "@/lib/chat/call-stage";

const frame = (over: Partial<Parameters<typeof ringAfter>[1]> = {}) => ({
    channelId: "c1",
    meetingId: "m1",
    state: "ringing",
    count: 1,
    userId: "grace",
    name: "Grace",
    ...over
});

const ringing: StageRing = { meetingId: "m1", callerId: "grace", name: "Grace", at: 100 };
const live = { meetingId: "m1", people: [{ id: "seat-grace" }] };

describe("ringAfter", () => {
    it("starts ringing when somebody else calls this conversation", () => {
        expect(ringAfter(null, frame(), "ada", "c1", 100)).toEqual(ringing);
    });

    it("does not ring at the person who started the call", () => {
        expect(ringAfter(null, frame({ userId: "ada" }), "ada", "c1", 100)).toBeNull();
    });

    it("ignores calls in other conversations", () => {
        expect(ringAfter(null, frame({ channelId: "c2" }), "ada", "c1", 100)).toBeNull();
        expect(
            ringAfter(ringing, frame({ channelId: "c2", state: "ended" }), "ada", "c1", 200)
        ).toBe(ringing);
    });

    it("keeps the first ring when the same call rings again", () => {
        expect(ringAfter(ringing, frame(), "ada", "c1", 500)).toBe(ringing);
    });

    it("stops when the call ends or empties", () => {
        expect(
            ringAfter(ringing, frame({ state: "ended", count: 0 }), "ada", "c1", 200)
        ).toBeNull();
        expect(
            ringAfter(ringing, frame({ state: "moved", count: 0 }), "ada", "c1", 200)
        ).toBeNull();
    });

    it("stops when this reader answered it somewhere", () => {
        expect(
            ringAfter(ringing, frame({ state: "moved", count: 2, userId: "ada" }), "ada", "c1", 200)
        ).toBeNull();
    });

    it("keeps ringing when somebody else joins", () => {
        expect(
            ringAfter(ringing, frame({ state: "moved", count: 3, userId: "bo" }), "ada", "c1", 200)
        ).toBe(ringing);
    });

    it("leaves a different call's ring alone", () => {
        expect(
            ringAfter(
                ringing,
                frame({ meetingId: "m0", state: "ended", count: 0 }),
                "ada",
                "c1",
                200
            )
        ).toBe(ringing);
    });
});

describe("ringExpired", () => {
    it("runs out after the ring time", () => {
        expect(ringExpired(ringing, 100 + 44_999, 45_000)).toBe(false);
        expect(ringExpired(ringing, 100 + 45_000, 45_000)).toBe(true);
    });
});

describe("stageMode", () => {
    const base = { kind: "dm", mayCall: true, inCall: false, ring: null, live: null } as const;

    it("shows nothing without a call", () => {
        expect(stageMode(base)).toBe("none");
    });

    it("rings in a one-to-one and in a group", () => {
        expect(stageMode({ ...base, ring: ringing, live })).toBe("ringing");
        expect(stageMode({ ...base, kind: "group", ring: ringing, live })).toBe("ringing");
        // Before the roster has been read.
        expect(stageMode({ ...base, ring: ringing })).toBe("ringing");
    });

    it("shows a call in progress, without ringing", () => {
        expect(stageMode({ ...base, live })).toBe("live");
    });

    it("shows nothing for a call nobody is sitting in", () => {
        expect(stageMode({ ...base, live: { meetingId: "m1", people: [] } })).toBe("none");
    });

    it("drops a ring for a call that was replaced", () => {
        expect(stageMode({ ...base, ring: ringing, live: { ...live, meetingId: "m2" } })).toBe(
            "live"
        );
    });

    it("shows nothing once this reader is in the call", () => {
        expect(stageMode({ ...base, inCall: true, ring: ringing, live })).toBe("none");
    });

    it("shows nothing to somebody who may not take calls", () => {
        expect(stageMode({ ...base, mayCall: false, ring: ringing, live })).toBe("none");
    });

    it("leaves named channels and voice rooms to their own views", () => {
        expect(stageMode({ ...base, kind: "text", ring: ringing, live })).toBe("none");
        expect(stageMode({ ...base, kind: "voice", live })).toBe("none");
    });
});

describe("showStage", () => {
    it("says which stages are on screen, and tells whoever listens", () => {
        let heard = 0;
        const stop = subscribeStages(() => heard++);
        const first = showStage("m1");
        const second = showStage("m1");
        expect(stageShown("m1")).toBe(true);
        expect(shownStages()).toBe("m1");
        first();
        expect(stageShown("m1")).toBe(true);
        second();
        expect(stageShown("m1")).toBe(false);
        expect(shownStages()).toBe("");
        expect(heard).toBe(4);
        stop();
    });
});

describe("publishCardRings", () => {
    it("says what the card rings about, per conversation, and only when it changes", () => {
        let heard = 0;
        const stop = subscribeStages(() => heard++);
        const card = { ...ringing, channelId: "c1", silenced: false };
        publishCardRings([card]);
        publishCardRings([{ ...card }]);
        expect(heard).toBe(1);
        expect(cardRingIn("c1")).toEqual(card);
        expect(cardRingIn("c2")).toBeNull();

        publishCardRings([{ ...card, silenced: true }]);
        expect(heard).toBe(2);
        expect(cardRingIn("c1")?.silenced).toBe(true);

        publishCardRings([]);
        expect(cardRingIn("c1")).toBeNull();
        expect(cardRingsKey()).toBe("");
        stop();
    });
});

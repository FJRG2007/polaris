// @vitest-environment jsdom

/**
 * The tone the caller hears while the other side is rung.
 *
 * Reported as a call that rang the other person and left the caller in
 * silence. What is pinned: the tone plays from placing a call that rang
 * somebody until somebody else is in it, the call ends, the caller leaves or
 * deafens, or the ring gives up; never for a call that rang nobody from here;
 * never again once answered, through a reconnect; and never where this tab
 * cannot be heard.
 */

import type { CallSession } from "@/app/(app)/chat/call-hold";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({
    heard: true,
    started: [] as { name: string; forMs: number }[],
    stopped: 0
}));
vi.mock("@/lib/call-sounds", async (real) => ({
    ...(await real<typeof import("@/lib/call-sounds")>()),
    willBeHeard: async () => sounds.heard,
    startRinging: (name: string, forMs: number) => {
        sounds.started.push({ name, forMs });
        return () => void (sounds.stopped += 1);
    }
}));

const { RING_FOR_MS, ringPasses, RING_EVERY_MS } = await import("@/lib/call-sounds");
const { placed, ringBackLeft, somebodyElseIn, useRingBack } = await import(
    "@/app/(app)/chat/ring-back"
);
type RingBackCall = import("@/app/(app)/chat/ring-back").RingBackCall;

const NOW = new Date("2026-10-17T12:00:00Z").getTime();

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    sounds.heard = true;
    sounds.started = [];
    sounds.stopped = 0;
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const me = { id: "p-ana", userId: "ana", admission: "admitted" as const };
const ben = { id: "p-ben", userId: "ben", admission: "admitted" as const };

function callWith(patch: Partial<RingBackCall> = {}): RingBackCall {
    return {
        participantId: "p-ana",
        meeting: { participants: [me] },
        ended: false,
        deafened: false,
        ...patch
    };
}

function session(placedAt?: number): CallSession {
    return { meetingId: "m1", channelId: "c1", title: "Ben", placedAt };
}

/** The hook mounted, and a way to move it on. */
function mount(call: RingBackCall, held: CallSession | null) {
    return renderHook(
        ({ call, held }: { call: RingBackCall; held: CallSession | null }) =>
            useRingBack(call, held, "ana"),
        { initialProps: { call, held } }
    );
}

/** Lets `willBeHeard` answer. */
const settle = () => act(async () => undefined);

describe("how long the tone has left", () => {
    const base = { placedAt: NOW, now: NOW, answered: false, ended: false, deafened: false };

    it("is the whole ring when the call has just been placed", () => {
        expect(ringBackLeft(base)).toBe(RING_FOR_MS);
    });

    it("counts down, and is silence once the ring gives up", () => {
        expect(ringBackLeft({ ...base, now: NOW + 10_000 })).toBe(RING_FOR_MS - 10_000);
        expect(ringBackLeft({ ...base, now: NOW + RING_FOR_MS })).toBe(0);
        expect(ringBackLeft({ ...base, now: NOW + RING_FOR_MS + 1 })).toBe(0);
    });

    it.each([
        ["nobody was rung", { placedAt: undefined }],
        ["somebody answered", { answered: true }],
        ["the call ended", { ended: true }],
        ["the caller deafened", { deafened: true }]
    ])("is silence when %s", (_, patch) => {
        expect(ringBackLeft({ ...base, ...patch })).toBe(0);
    });

    it("comes only from a placing that rang somebody", () => {
        expect(placed({ rang: true })).toEqual({ placedAt: NOW });
        expect(placed({ rang: false })).toEqual({});
        expect(placed({})).toEqual({});
    });

    it("schedules only the passes the time left needs", () => {
        expect(ringPasses("ringBack", RING_EVERY_MS.ringBack * 2)).toBe(2);
        expect(ringPasses("ringBack", 1)).toBe(1);
        expect(ringPasses("ringBack")).toBe(Math.ceil(RING_FOR_MS / RING_EVERY_MS.ringBack));
    });
});

describe("who answers", () => {
    it("is anybody admitted who is not this seat or this account", () => {
        expect(somebodyElseIn([me], "p-ana", "ana")).toBe(false);
        expect(somebodyElseIn([me, ben], "p-ana", "ana")).toBe(true);
        expect(somebodyElseIn([me, { ...ben, admission: "waiting" }], "p-ana", "ana")).toBe(false);
        // The caller's own second tab is not somebody answering.
        expect(somebodyElseIn([me, { id: "p-ana-2", userId: "ana", admission: "admitted" }], "p-ana", "ana")).toBe(false);
        // A guest has no account and still answers.
        expect(somebodyElseIn([me, { id: "p-guest", userId: null, admission: "admitted" }], "p-ana", "ana")).toBe(true);
    });
});

describe("the caller's tone", () => {
    it("plays from placing a call that rang somebody, for the whole ring", async () => {
        mount(callWith(), session(NOW));
        await settle();
        expect(sounds.started).toEqual([{ name: "ringBack", forMs: RING_FOR_MS }]);
    });

    it("plays only for the time left when it starts late", async () => {
        mount(callWith(), session(NOW - 20_000));
        await settle();
        expect(sounds.started).toEqual([{ name: "ringBack", forMs: RING_FOR_MS - 20_000 }]);
    });

    it("never plays for a call joined rather than placed", async () => {
        mount(callWith(), session(undefined));
        await settle();
        expect(sounds.started).toEqual([]);
    });

    it("never plays once the ring has given up", async () => {
        mount(callWith(), session(NOW - RING_FOR_MS - 1));
        await settle();
        expect(sounds.started).toEqual([]);
    });

    it("never plays where this tab cannot be heard", async () => {
        sounds.heard = false;
        mount(callWith(), session(NOW));
        await settle();
        expect(sounds.started).toEqual([]);
    });

    it("stops when somebody answers, and never comes back through a reconnect", async () => {
        const hook = mount(callWith(), session(NOW));
        await settle();
        hook.rerender({ call: callWith({ meeting: { participants: [me, ben] } }), held: session(NOW) });
        await settle();
        expect(sounds.stopped).toBe(1);
        // The connection dropped and came back: for a moment nobody is listed.
        hook.rerender({ call: callWith({ meeting: null }), held: session(NOW) });
        hook.rerender({ call: callWith(), held: session(NOW) });
        await settle();
        expect(sounds.started).toHaveLength(1);
    });

    it.each([
        ["the call ends", { ended: true }],
        ["the caller deafens", { deafened: true }]
    ])("stops when %s", async (_, patch) => {
        const hook = mount(callWith(), session(NOW));
        await settle();
        hook.rerender({ call: callWith(patch), held: session(NOW) });
        expect(sounds.stopped).toBe(1);
    });

    it("stops when the caller leaves", async () => {
        const hook = mount(callWith(), session(NOW));
        await settle();
        hook.rerender({ call: callWith(), held: null });
        expect(sounds.stopped).toBe(1);
    });

    it("does not start if the caller left before the tab answered whether it can be heard", async () => {
        const hook = mount(callWith(), session(NOW));
        hook.rerender({ call: callWith(), held: null });
        await settle();
        expect(sounds.started).toEqual([]);
    });

    it("plays once, however often the call re-renders", async () => {
        const hook = mount(callWith(), session(NOW));
        await settle();
        for (let i = 0; i < 5; i++) {
            vi.setSystemTime(NOW + i * 1000);
            hook.rerender({ call: callWith(), held: session(NOW) });
        }
        await settle();
        expect(sounds.started).toHaveLength(1);
        expect(sounds.stopped).toBe(0);
    });
});

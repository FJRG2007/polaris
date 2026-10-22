/**
 * Who hears a deck's command for a call: the person's own seat, once it is in
 * the room. A mute meant for one tab reaching another would mute somebody who
 * never pressed anything, and a seat still at the door is not on the call yet.
 * Exercised through the route handler, because the filtering between the bus
 * and the browser is the subject.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

interface Seat {
    meetingId: string;
    participantId: string;
    admission: "admitted" | "waiting" | "denied";
}

const ADA: Seat = { meetingId: "m1", participantId: "p-ada", admission: "admitted" };
const GRACE: Seat = { meetingId: "m1", participantId: "p-grace", admission: "admitted" };
const ADA_AT_THE_DOOR: Seat = { ...ADA, admission: "waiting" };

const resolveSeat = vi.fn(async () => ADA as Seat | null);

vi.mock("../../src/lib/chat/meeting-seat", () => ({ resolveSeat }));

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingParticipant: {
            findFirst: async () => ({ admission: "waiting" })
        }
    }
}));

const { GET } = await import("../../src/app/api/chat/meetings/[meetingId]/stream/route");
const { publishMeetingEvent } = await import("../../src/lib/chat/meeting-events");

const SETTLE_MS = 100;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open a stream as one seat and collect the frames it is sent. */
async function listen(seat: Seat): Promise<{ frames: () => unknown[]; close: () => void }> {
    resolveSeat.mockResolvedValue(seat);
    const controller = new AbortController();
    const response = await GET(
        new Request("http://polaris.test/api/chat/meetings/m1/stream", {
            signal: controller.signal
        }),
        { params: Promise.resolve({ meetingId: seat.meetingId }) }
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: unknown[] = [];

    void (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                for (const line of decoder.decode(value).split("\n")) {
                    if (!line.startsWith("data: ")) continue;
                    seen.push(JSON.parse(line.slice(6)));
                }
            }
        } catch {
            // Aborting the request is how the test ends.
        }
    })();

    await wait(SETTLE_MS);
    seen.length = 0;
    return { frames: () => seen, close: () => controller.abort() };
}

const mute = (participantId: string) =>
    publishMeetingEvent({
        meetingId: "m1",
        kind: "remote",
        participantId,
        remote: { command: "mic", on: false }
    });

describe("a deck's command for a call", () => {
    afterEach(() => vi.clearAllMocks());

    it("reaches the person's own admitted seat, with the command", async () => {
        const ada = await listen(ADA);
        mute("p-ada");
        await wait(SETTLE_MS);
        ada.close();

        expect(ada.frames()).toEqual([{ kind: "remote", remote: { command: "mic", on: false } }]);
    });

    it("does not reach anybody else in the call", async () => {
        const grace = await listen(GRACE);
        mute("p-ada");
        await wait(SETTLE_MS);
        grace.close();

        expect(grace.frames()).toEqual([]);
    });

    it("does not reach the person's own seat while it waits at the door", async () => {
        const ada = await listen(ADA_AT_THE_DOOR);
        mute("p-ada");
        await wait(SETTLE_MS);
        ada.close();

        expect(ada.frames()).toEqual([]);
    });

    it("never carries a command on any other kind of event", async () => {
        const ada = await listen(ADA);
        publishMeetingEvent({
            meetingId: "m1",
            kind: "said",
            remote: { command: "hangup" }
        } as never);
        await wait(SETTLE_MS);
        ada.close();

        expect(ada.frames()).toEqual([{ kind: "said" }]);
    });
});

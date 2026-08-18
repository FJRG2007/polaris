/**
 * Who a claim is addressed to.
 *
 * An account has one seat in a call, so when a second device of that account
 * takes the call the first one has to be told to hang up. The claim that says so
 * was published to the whole room, and every browser in it compared the device
 * id with its own - which is a test that everybody else fails, because nobody
 * else has ever seen that device. So one person joining a call ended it for
 * everybody already in it: the second to arrive knocked the first out, the
 * first's rejoin knocked the second out, and a two-person call could not be held
 * at all.
 *
 * The fix is that a claim names the seat it is about and the stream drops the
 * ones that are not its own, so these are the assertions that hold it down:
 * a claim reaches the seat it names and no other, and the events that really are
 * about the whole room still reach everybody.
 *
 * Exercised through the route handler rather than the bus, because the filtering
 * between them is the entire subject.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Seat {
    meetingId: string;
    participantId: string;
    admission: "admitted" | "waiting" | "denied";
}

const DESK: Seat = { meetingId: "m1", participantId: "p-ada", admission: "admitted" };
const GRACE: Seat = { meetingId: "m1", participantId: "p-grace", admission: "admitted" };

const resolveSeat = vi.fn(async () => DESK as Seat | null);

vi.mock("../../src/lib/chat/meeting-seat", () => ({ resolveSeat }));

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingParticipant: {
            findFirst: async () => ({ admission: "admitted" })
        }
    }
}));

const { GET } = await import("../../src/app/api/chat/meetings/[meetingId]/stream/route");
const { publishMeetingEvent } = await import("../../src/lib/chat/meeting-events");

/** Long enough for a published event to have been written, or to have had its
 *  chance and not been. */
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
            // Aborting the request is how the test ends; the read rejecting is
            // that, not a failure.
        }
    })();

    // Let the opening frames - the comment and the seat - land, so what each
    // test counts is only what it published.
    await wait(SETTLE_MS);
    seen.length = 0;
    return { frames: () => seen, close: () => controller.abort() };
}

describe("a claim on a seat", () => {
    beforeEach(() => resolveSeat.mockResolvedValue(DESK));

    afterEach(() => vi.clearAllMocks());

    it("reaches the browsers sitting in that seat", async () => {
        const phone = await listen(DESK);

        publishMeetingEvent({
            meetingId: "m1",
            kind: "claimed",
            participantId: "p-ada",
            deviceId: "the-phone"
        });
        await wait(SETTLE_MS);
        phone.close();

        expect(phone.frames()).toEqual([{ kind: "claimed", deviceId: "the-phone" }]);
    });

    it("does not reach anybody else in the call", async () => {
        // The bug, stated: Grace is on the call and Ada's browser announces
        // itself. Told about it, Grace's browser reads a device it cannot
        // recognise and hangs up on a call it was never asked to leave.
        const grace = await listen(GRACE);

        publishMeetingEvent({
            meetingId: "m1",
            kind: "claimed",
            participantId: "p-ada",
            deviceId: "the-phone"
        });
        await wait(SETTLE_MS);
        grace.close();

        expect(grace.frames()).toEqual([]);
    });

    it("does not reach a call it is not about", async () => {
        const desk = await listen(DESK);

        publishMeetingEvent({
            meetingId: "m2",
            kind: "claimed",
            participantId: "p-ada",
            deviceId: "the-phone"
        });
        await wait(SETTLE_MS);
        desk.close();

        expect(desk.frames()).toEqual([]);
    });
});

describe("what is about the whole room", () => {
    afterEach(() => vi.clearAllMocks());

    it("still reaches everybody in it", async () => {
        const ada = await listen(DESK);
        const grace = await listen(GRACE);

        publishMeetingEvent({ meetingId: "m1", kind: "roster" });
        publishMeetingEvent({ meetingId: "m1", kind: "ended" });
        await wait(SETTLE_MS);
        ada.close();
        grace.close();

        expect(ada.frames()).toEqual([{ kind: "roster" }, { kind: "ended" }]);
        expect(grace.frames()).toEqual([{ kind: "roster" }, { kind: "ended" }]);
    });
});

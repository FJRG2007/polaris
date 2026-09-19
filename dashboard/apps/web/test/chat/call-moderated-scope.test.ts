/**
 * Who hears that a moderator muted, deafened or disconnected somebody.
 *
 * The seat it happened to, and nobody else: the rest of the room sees it on the
 * roster, and a note about somebody else popping up on every screen would read
 * as having happened to the reader. Exercised through the route handler, because
 * the filtering between the bus and the browser is the subject.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("what a moderator did to a seat", () => {
    afterEach(() => vi.clearAllMocks());

    it("reaches that seat, with what was done", async () => {
        const grace = await listen(GRACE);

        publishMeetingEvent({
            meetingId: "m1",
            kind: "moderated",
            participantId: "p-grace",
            action: "mute"
        });
        await wait(SETTLE_MS);
        grace.close();

        expect(grace.frames()).toEqual([{ kind: "moderated", action: "mute" }]);
    });

    it("does not reach anybody else in the call", async () => {
        const ada = await listen(DESK);

        publishMeetingEvent({
            meetingId: "m1",
            kind: "moderated",
            participantId: "p-grace",
            action: "disconnect"
        });
        await wait(SETTLE_MS);
        ada.close();

        expect(ada.frames()).toEqual([]);
    });
});

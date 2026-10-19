/**
 * Join, reload, rejoin - and still be in the call a minute later.
 *
 * Seen in production twice in a row: somebody alone in a call was told "This
 * call lost the call server" forty-five seconds after joining, and again
 * forty-five seconds after the reload that was supposed to fix it. The media
 * server logged the browser asking to leave both times. Two things were wrong:
 *
 * - the room a lone caller lets go of on purpose (resting, after
 *   `REST_AFTER_MS`) closed with the client's own reason, and every reason but
 *   a moderator's was reported as the server being lost;
 * - the reload's departure closed the seat row under the new page, and the
 *   heartbeat was answered 410 and gave up, so the roster said the person had
 *   left while they were still in the call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdSeat } from "@/app/(app)/chat/call-seat";
import { roomClosed } from "@/app/(app)/chat/call-diagnosis";

const MEETING = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const VOICE = { muted: false, deafened: false, streaming: false };
const BEAT_MS = 10_000;

/** The seat route, as a row with a `leftAt`. */
function seatServer() {
    const row = { open: true, rejoins: 0 };
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
            row.open = false;
            return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { rejoin?: boolean };
        if (!row.open && body.rejoin) {
            row.open = true;
            row.rejoins += 1;
        }
        return new Response(null, { status: row.open ? 204 : 410 });
    });
    return { row, fetch };
}

describe("a reload in the middle of a call", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("is still in the call sixty seconds after rejoining", async () => {
        const server = seatServer();
        vi.stubGlobal("fetch", server.fetch);

        // Joined, then the old page's departure lands after the new page is up.
        await holdSeat(MEETING, VOICE, () => true);
        await fetch(`/api/chat/meetings/${MEETING}/seat`, { method: "DELETE" });
        expect(server.row.open).toBe(false);

        // The new page beats for a minute.
        let failures = 0;
        for (let elapsed = 0; elapsed <= 60_000; elapsed += BEAT_MS) {
            await holdSeat(MEETING, VOICE, () => true).catch(() => (failures += 1));
            await vi.advanceTimersByTimeAsync(BEAT_MS);
        }
        expect(failures).toBe(0);
        expect(server.row.open).toBe(true);
        expect(server.row.rejoins).toBe(1);

        // Alone, the page rests at 45 s and closes its own room: never "lost".
        expect(roomClosed(1, true)).toBe("ours");
        expect(roomClosed(1, false)).toBe("ours");
    });

    it("does not take the seat back once the call is no longer this tab's", async () => {
        const server = seatServer();
        server.row.open = false;
        vi.stubGlobal("fetch", server.fetch);
        await expect(holdSeat(MEETING, VOICE, () => false)).rejects.toThrow("seat 410");
        expect(server.row.open).toBe(false);
    });

    it("does not retry an answer other than gone", async () => {
        const fetch = vi.fn(async () => new Response(null, { status: 500 }));
        vi.stubGlobal("fetch", fetch);
        await expect(holdSeat(MEETING, VOICE, () => true)).rejects.toThrow("seat 500");
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe("why a room closed", () => {
    it("names a moderator, another device, and a real loss apart", () => {
        expect(roomClosed(4, false)).toBe("removed");
        expect(roomClosed(2, false)).toBe("elsewhere");
        expect(roomClosed(0, false)).toBe("lost");
        expect(roomClosed(undefined, false)).toBe("lost");
        expect(roomClosed(3, false)).toBe("lost");
    });
});

/**
 * The heartbeat a call runs on, as a route.
 *
 * It is a route so that a Polaris update does not change its address under an
 * open call. What is pinned here is what the browser relies on: a seat is kept
 * or given back only by the request that holds it, and a request without one is
 * told to stop.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MEETING = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const SEAT = { meetingId: MEETING, participantId: "p1", admission: "admitted" };

const resolveSeat = vi.fn();
const keepSeat = vi.fn(async () => undefined);
const leave = vi.fn(async () => undefined);
const join = vi.fn(async () => SEAT);
const backgroundUser = vi.fn(async () => ({ id: "u1", name: "Ada" }) as { id: string; name: string } | null);
const sessionCan = vi.fn(async () => true);

vi.mock("@/lib/chat/meeting-seat", () => ({ resolveSeat }));
vi.mock("@/lib/chat/meetings", () => ({ keepSeat, leave, join }));
vi.mock("@/lib/session", () => ({ backgroundUser, sessionCan }));
vi.mock("@/lib/chat/call-server", () => ({ callsUnavailable: async () => null }));

const route = await import("../../src/app/api/chat/meetings/[meetingId]/seat/route");
const params = (meetingId: string) => ({ params: Promise.resolve({ meetingId }) });
const request = (method: string, body?: string) =>
    new Request("https://polaris.example/x", { method, body });

beforeEach(() => {
    vi.clearAllMocks();
    resolveSeat.mockResolvedValue(SEAT);
});

describe("keeping a seat", () => {
    it("keeps the seat the request holds", async () => {
        const response = await route.POST(request("POST"), params(MEETING));
        expect(response.status).toBe(204);
        expect(resolveSeat).toHaveBeenCalledWith(MEETING);
        expect(keepSeat).toHaveBeenCalledWith(SEAT, undefined);
    });

    it("passes on whether the person is muted or deafened", async () => {
        const body = JSON.stringify({ muted: true, deafened: false });
        const response = await route.POST(request("POST", body), params(MEETING));
        expect(response.status).toBe(204);
        expect(keepSeat).toHaveBeenCalledWith(SEAT, { muted: true, deafened: false });
    });

    it("refuses a state that is not the expected shape", async () => {
        for (const body of [
            "{",
            JSON.stringify({ muted: "yes", deafened: false }),
            JSON.stringify({ muted: true, deafened: false, admin: true })
        ]) {
            const response = await route.POST(request("POST", body), params(MEETING));
            expect(response.status).toBe(400);
        }
        expect(keepSeat).not.toHaveBeenCalled();
    });

    it("tells a request with no seat to stop", async () => {
        resolveSeat.mockResolvedValue(null);
        const response = await route.POST(request("POST"), params(MEETING));
        expect(response.status).toBe(410);
        expect(keepSeat).not.toHaveBeenCalled();
    });

    it("does not look up what is not a meeting id", async () => {
        const response = await route.POST(request("POST"), params("../../admin"));
        expect(response.status).toBe(410);
        expect(resolveSeat).not.toHaveBeenCalled();
    });
});

/**
 * A reload's departure can land after the new page has joined, which closed the
 * row under a tab that was still carrying the call: the roster said it had left
 * and its heartbeat was told to stop. A beat that says it is still in the call
 * takes the seat again through the ordinary join.
 */
describe("taking a closed seat back", () => {
    const beat = JSON.stringify({ muted: false, deafened: false, rejoin: true });

    it("re-seats a browser still in the call", async () => {
        resolveSeat.mockResolvedValueOnce(null).mockResolvedValueOnce(SEAT);
        const response = await route.POST(request("POST", beat), params(MEETING));
        expect(response.status).toBe(204);
        expect(join).toHaveBeenCalledWith({ id: "u1", name: "Ada" }, MEETING);
        expect(keepSeat).toHaveBeenCalledWith(SEAT, { muted: false, deafened: false });
    });

    it("does not re-seat a plain beat", async () => {
        resolveSeat.mockResolvedValue(null);
        const body = JSON.stringify({ muted: false, deafened: false });
        const response = await route.POST(request("POST", body), params(MEETING));
        expect(response.status).toBe(410);
        expect(join).not.toHaveBeenCalled();
    });

    it("still says gone when the join is refused", async () => {
        resolveSeat.mockResolvedValue(null);
        join.mockRejectedValueOnce(new Error("callEnded"));
        const response = await route.POST(request("POST", beat), params(MEETING));
        expect(response.status).toBe(410);
        expect(keepSeat).not.toHaveBeenCalled();
    });

    it("never re-seats without an account", async () => {
        resolveSeat.mockResolvedValue(null);
        backgroundUser.mockResolvedValueOnce(null);
        const response = await route.POST(request("POST", beat), params(MEETING));
        expect(response.status).toBe(410);
        expect(join).not.toHaveBeenCalled();
    });
});

describe("giving a seat back", () => {
    it("leaves the seat the request holds", async () => {
        const response = await route.DELETE(request("DELETE"), params(MEETING));
        expect(response.status).toBe(204);
        expect(leave).toHaveBeenCalledWith(SEAT);
    });

    it("does nothing for a request with no seat", async () => {
        resolveSeat.mockResolvedValue(null);
        await route.DELETE(request("DELETE"), params(MEETING));
        expect(leave).not.toHaveBeenCalled();
    });
});

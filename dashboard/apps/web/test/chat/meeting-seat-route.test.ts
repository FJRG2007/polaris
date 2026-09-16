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

vi.mock("@/lib/chat/meeting-seat", () => ({ resolveSeat }));
vi.mock("@/lib/chat/meetings", () => ({ keepSeat, leave }));

const route = await import("../../src/app/api/chat/meetings/[meetingId]/seat/route");
const params = (meetingId: string) => ({ params: Promise.resolve({ meetingId }) });
const request = (method: string) => new Request("https://polaris.example/x", { method });

beforeEach(() => {
    vi.clearAllMocks();
    resolveSeat.mockResolvedValue(SEAT);
});

describe("keeping a seat", () => {
    it("keeps the seat the request holds", async () => {
        const response = await route.POST(request("POST"), params(MEETING));
        expect(response.status).toBe(204);
        expect(resolveSeat).toHaveBeenCalledWith(MEETING);
        expect(keepSeat).toHaveBeenCalledWith(SEAT);
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

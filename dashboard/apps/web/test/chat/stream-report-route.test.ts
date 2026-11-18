/**
 * Reporting a problem with a shared screen: what reaches Polaris' own
 * Telemetry project, and what is refused before it gets there.
 */

import type { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => [] as { error: Error; where: Record<string, unknown> }[]);

vi.mock("@/lib/telemetry/capture", () => ({
    captureInternal: async (error: Error, where: Record<string, unknown>) => {
        captured.push({ error, where });
    }
}));
// The origin and session checks are `poll-route`'s own and tested there; this
// is the body and what is done with it.
vi.mock("@/lib/poll-route", () => ({
    actionRoute:
        (body: z.ZodTypeAny, run: (input: unknown) => Promise<unknown>) =>
        async (request: Request) => {
            const parsed = body.safeParse(await request.json());
            if (!parsed.success) return new Response(null, { status: 400 });
            return Response.json(await run(parsed.data));
        }
}));

const { POST } = await import("@/app/api/chat/stream-report/route");

const send = (body: unknown) =>
    POST(new Request("https://polaris.example/api/chat/stream-report", { method: "POST", body: JSON.stringify(body) }));

const settings = { mode: "gaming", frameRate: 30, resolution: "720", sound: true, platform: "desktop" };

beforeEach(() => {
    captured.length = 0;
});

describe("a stream problem report", () => {
    it("is recorded as a warning, tagged with the stream's settings", async () => {
        const response = await send({ problem: "choppy", note: "  froze\nevery minute ", settings });
        expect(response.status).toBe(200);
        expect(captured).toHaveLength(1);
        expect(captured[0]?.error.name).toBe("StreamReport");
        expect(captured[0]?.error.message).toBe("Stream problem reported: choppy");
        expect(captured[0]?.where).toMatchObject({
            level: "warning",
            transaction: "chat/stream",
            tags: {
                problem: "choppy",
                mode: "gaming",
                frameRate: "30",
                resolution: "720",
                sound: "on",
                platform: "desktop",
                note: "froze every minute"
            }
        });
    });

    it("says auto for a stream left to the quality ladder, and carries no empty note", async () => {
        await send({
            problem: "black",
            note: "",
            settings: { ...settings, mode: "auto", frameRate: null, resolution: null }
        });
        expect(captured[0]?.where.tags).toEqual({
            problem: "black",
            mode: "auto",
            frameRate: "auto",
            resolution: "auto",
            sound: "on",
            platform: "desktop"
        });
    });

    it("refuses a problem it does not know, a long note, or anything extra", async () => {
        expect((await send({ problem: "hacked", note: "", settings })).status).toBe(400);
        expect((await send({ problem: "other", note: "x".repeat(501), settings })).status).toBe(400);
        expect(
            (await send({ problem: "other", note: "", settings: { ...settings, user: "someone" } })).status
        ).toBe(400);
        expect(captured).toHaveLength(0);
    });
});

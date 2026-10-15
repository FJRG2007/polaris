import { beforeEach, describe, expect, it, vi } from "vitest";

const upserts: Record<string, any>[] = [];
const deletes: Record<string, any>[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        apiKeyCallHour: {
            upsert: async (args: Record<string, any>) => {
                upserts.push(args);
                return { calls: 1 };
            },
            deleteMany: async (args: Record<string, any>) => {
                deletes.push(args);
                return { count: 0 };
            }
        }
    }
}));

import * as recorder from "@/lib/api-usage/recorder";

const KEY = "00000000-0000-4000-8000-000000000001";

beforeEach(async () => {
    await recorder.flushKeyCalls(new Date("2026-10-15T10:00:00Z"));
    upserts.length = 0;
    deletes.length = 0;
});

describe("recording a key's calls", () => {
    it("folds calls to one route, hour and status into one tally, filed under the template", () => {
        const at = new Date("2026-10-15T10:20:00Z");
        recorder.recordKeyCall({
            keyId: KEY,
            method: "get",
            pathname: "/api/v1/deploy/services/a1",
            status: 200,
            ms: 12,
            at
        });
        recorder.recordKeyCall({
            keyId: KEY,
            method: "GET",
            pathname: "/api/v1/deploy/services/b2",
            status: 200,
            ms: 300,
            at
        });
        recorder.recordKeyCall({
            keyId: KEY,
            method: "GET",
            pathname: "/api/v1/deploy/services/b2",
            status: 404,
            ms: 7,
            at
        });
        recorder.recordKeyCall({
            keyId: KEY,
            method: "GET",
            pathname: "/secret/path/123",
            status: 200,
            ms: 7,
            at
        });
        const tallies = recorder.pendingKeyCalls();
        expect(tallies).toHaveLength(3);
        const ok = tallies.find(
            (tally) => tally.status === 200 && tally.route !== recorder.OTHER_ROUTE
        )!;
        expect(ok).toMatchObject({
            route: "/api/v1/deploy/services/{id}",
            method: "GET",
            calls: 2,
            totalMs: 312
        });
        expect(ok.hour.toISOString()).toBe("2026-10-15T10:00:00.000Z");
        expect(ok.latency.ms25).toBe(1);
        expect(ok.latency.ms500).toBe(1);
        expect(tallies.some((tally) => tally.route === recorder.OTHER_ROUTE)).toBe(true);
    });

    it("writes one increment per tally and nothing per call, then trims past the retention window once an hour", async () => {
        const at = new Date("2026-10-15T11:05:00Z");
        for (let i = 0; i < 50; i++) {
            recorder.recordKeyCall({
                keyId: KEY,
                method: "GET",
                pathname: "/api/v1/me",
                status: 200,
                ms: 40,
                at
            });
        }
        expect(upserts).toHaveLength(0);
        await recorder.flushKeyCalls(at);
        expect(upserts).toHaveLength(1);
        expect(upserts[0]!.update.calls).toEqual({ increment: 50 });
        expect(upserts[0]!.update.ms50).toEqual({ increment: 50 });
        expect(upserts[0]!.create.totalMs).toBe(2000n);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.where.hour.lt.toISOString()).toBe("2026-07-17T11:00:00.000Z");
        await recorder.flushKeyCalls(new Date("2026-10-15T11:40:00Z"));
        expect(deletes).toHaveLength(1);
        expect(recorder.pendingKeyCalls()).toHaveLength(0);
    });

    it("counts only calls a key was accepted for, with the status the handler answered", async () => {
        const handler = recorder.withKeyUsage(async (request: Request) => {
            if (request.headers.get("authorization")) recorder.noteKeyCall(KEY);
            return new Response(null, { status: 403 });
        });
        await handler(new Request("https://polaris.example.test/api/v1/me"));
        expect(recorder.pendingKeyCalls()).toHaveLength(0);
        await handler(
            new Request("https://polaris.example.test/api/v1/me", {
                headers: { authorization: "Bearer x" }
            })
        );
        expect(recorder.pendingKeyCalls()).toMatchObject([
            { keyId: KEY, route: "/api/v1/me", status: 403, calls: 1 }
        ]);
    });

    it("counts a call whose handler threw as a 500", async () => {
        const handler = recorder.withKeyUsage(async (_request: Request) => {
            recorder.noteKeyCall(KEY);
            throw new Error("boom");
        });
        await expect(
            handler(new Request("https://polaris.example.test/api/v1/me"))
        ).rejects.toThrow("boom");
        expect(recorder.pendingKeyCalls()).toMatchObject([{ status: 500 }]);
    });
});

/**
 * The record a stopped session is started again on: itself, back in the
 * queue, with this run's clock. Sessions that stopped before reopening existed
 * carry the old machine's last report, probe and hook sequence; left in place,
 * the silence sweep would fail the new run on the old report and the new
 * machine's first hooks would be dropped as older than the old one's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn());

vi.mock("@polaris/db", () => ({ prisma: { agentSession: { updateMany } } }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { reopenSessionRecord } = await import("@/lib/agents/session-service");

beforeEach(() => updateMany.mockReset());

describe("reopenSessionRecord", () => {
    it("queues a stopped or failed session again and starts its clock over", async () => {
        updateMany.mockResolvedValue({ count: 1 });
        const before = Date.now();
        expect(await reopenSessionRecord("old-session")).toBe(true);
        const call = updateMany.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> };
        expect(call.where).toEqual({ id: "old-session", state: { in: ["stopped", "failed"] } });
        expect(call.data).toMatchObject({
            state: "queued",
            error: null,
            finishedAt: null,
            containerId: null,
            lastEventAt: null,
            lastEventSeq: null,
            lastAliveAt: null,
            lastProbedAt: null
        });
        expect((call.data.startedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it("is false when the session had not ended, so a double send starts one machine", async () => {
        updateMany.mockResolvedValue({ count: 0 });
        expect(await reopenSessionRecord("old-session")).toBe(false);
    });
});

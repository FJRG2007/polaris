/**
 * Two passes that read the same due check probe and count it once: the second
 * finds `nextRunAt` already moved and leaves the check alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const due = new Date("2026-03-10T12:00:00Z");
const state = vi.hoisted(() => ({ nextRunAt: new Date(0) }));
const prisma = vi.hoisted(() => ({
    statusCheck: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    statusSample: { create: vi.fn() },
    statusDay: { upsert: vi.fn() },
    $transaction: vi.fn()
}));
vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@polaris-app/status-pages/src/lib/probe", () => ({
    probe: vi.fn(async () => ({ ok: true, latencyMs: 5, status: 200, body: "" }))
}));

import { runDueChecks } from "@polaris-app/status-pages/src/lib/runner";

const row = {
    id: "c1",
    kind: "http",
    target: "https://example.test",
    port: null,
    expectStatus: 200,
    keyword: "",
    dnsType: null,
    dnsExpect: "",
    intervalSec: 60,
    timeoutMs: 5000,
    nextRunAt: due
};

beforeEach(() => {
    vi.clearAllMocks();
    state.nextRunAt = due;
    prisma.statusCheck.findMany.mockResolvedValue([row]);
    prisma.statusCheck.updateMany.mockImplementation(
        async ({ where, data }: { where: { nextRunAt: Date }; data: { nextRunAt: Date } }) => {
            if (where.nextRunAt.getTime() !== state.nextRunAt.getTime()) return { count: 0 };
            state.nextRunAt = data.nextRunAt;
            return { count: 1 };
        }
    );
    prisma.$transaction.mockResolvedValue([]);
});

describe("runDueChecks", () => {
    it("records a check read by two overlapping passes once", async () => {
        await Promise.all([runDueChecks(due), runDueChecks(due)]);

        expect(prisma.statusCheck.updateMany).toHaveBeenCalledTimes(2);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("records nothing for a check another pass already took", async () => {
        state.nextRunAt = new Date(due.getTime() + 60_000);

        await runDueChecks(due);

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});

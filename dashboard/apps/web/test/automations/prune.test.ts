/**
 * Pruning run history: every automation is reached in turn however many there
 * are, turned-away and test runs are held to their counts, and real runs keep
 * their 100 or their 30 days, whichever keeps more.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fixtures/fake-prisma";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));

vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({ automationRunner: async () => null, mayAllowLocalNetwork: async () => false }));
vi.mock("@/lib/automations/secrets", () => ({ readSecretForRun: async () => "" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));

const { pruneAutomationHistory } = await import("@/lib/automations/job");

const L = core.AUTOMATION_LIMITS;
const DAY = 24 * 60 * 60 * 1000;

async function runs(automationId: string, count: number, daysAgo: number, extra: Record<string, unknown> = {}) {
    const at = new Date(Date.now() - daysAgo * DAY);
    for (let index = 0; index < count; index++)
        await db.current!.prisma.automationRun!.create!({
            data: { automationId, status: "succeeded", queuedAt: new Date(at.getTime() - index * 1000), finishedAt: at, ...extra }
        });
}

const left = (automationId: string, where: Record<string, unknown> = {}) =>
    db.current!.tables.automationRun!.filter((row) => row.automationId === automationId && Object.entries(where).every(([key, value]) => row[key] === value)).length;

describe("pruning automation history", () => {
    it("reaches every automation across passes, and holds each kind of run to its limit", async () => {
        const ids: string[] = [];
        for (let index = 0; index < 60; index++) {
            const row = await db.current!.prisma.automation!.create!({ data: { name: `a${index}` } });
            ids.push(row.id as string);
            await runs(row.id as string, 3, 40);
        }
        const last = ids[ids.length - 1]!;
        await runs(last, L.keepRuns + 10, 40);
        await runs(last, L.keepRuns + 50, 1, { status: "limited" });
        await runs(last, L.keepTestRuns + 5, 1, { test: true });

        await pruneAutomationHistory();
        expect(left(last)).toBe(3 + L.keepRuns + 10 + L.keepRuns + 50 + L.keepTestRuns + 5);
        await pruneAutomationHistory();

        expect(left(last, { status: "limited" })).toBe(L.keepRuns);
        expect(left(last, { test: true })).toBe(L.keepTestRuns);
        expect(left(last, { test: false })).toBe(L.keepRuns + L.keepRuns);
        expect(left(ids[0]!)).toBe(3);
    });
});

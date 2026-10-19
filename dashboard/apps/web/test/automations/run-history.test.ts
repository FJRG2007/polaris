/**
 * Run history past the first page, and one run's steps: every run is reachable
 * page by page, and what a step sent and got back is shown to editors only.
 */

import { describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fixtures/fake-prisma";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));
const access = vi.hoisted(() => ({ edit: true }));

vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({
    automationRunner: async () => null,
    mayAllowLocalNetwork: async () => false,
    mayReadShelf: async () => true,
    mayEditShelf: async () => access.edit
}));
vi.mock("@/lib/automations/secrets", () => ({ readSecretForRun: async () => "" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => ({ inapp: "sent" }) }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));

const history = await import("@/lib/automations/history");
const actor = { id: "u1", isAdmin: false };
const shelf = { orgId: null, userId: "u1" };

describe("run history", () => {
    it("reaches every run page by page, newest first, with no run twice", async () => {
        const automation = await db.current!.prisma.automation!.create!({
            data: { name: "A", userId: "u1", orgId: null }
        });
        const at = Date.now();
        for (let index = 0; index < 120; index++)
            await db.current!.prisma.automationRun!.create!({
                // Pairs share a queuedAt, so the id has to break the tie.
                data: {
                    automationId: automation.id,
                    status: "succeeded",
                    queuedAt: new Date(at - Math.floor(index / 2) * 1000)
                }
            });
        const seen: string[] = [];
        let next: string | null | undefined;
        let pages = 0;
        do {
            const page = await history.listRuns(actor, shelf, automation.id as string, {
                cursor: next ?? undefined
            });
            seen.push(...page.rows.map((row) => row.id));
            next = page.next;
            pages += 1;
        } while (next && pages < 10);
        expect(pages).toBe(3);
        expect(new Set(seen).size).toBe(120);
        const times = seen.map((id) =>
            (
                db.current!.tables.automationRun!.find((row) => row.id === id)!.queuedAt as Date
            ).getTime()
        );
        expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it("shows a step's data to editors only", async () => {
        const automation = await db.current!.prisma.automation!.create!({
            data: { name: "B", userId: "u1", orgId: null }
        });
        const version = await db.current!.prisma.automationVersion!.create!({
            data: { automationId: automation.id, number: 1, graph: {} }
        });
        const run = await db.current!.prisma.automationRun!.create!({
            data: { automationId: automation.id, versionId: version.id, status: "succeeded" }
        });
        await db.current!.prisma.automationStep!.create!({
            data: {
                runId: run.id,
                nodeId: "n1",
                status: "ok",
                input: { url: "https://x.test" },
                output: { status: 200 }
            }
        });
        access.edit = true;
        const editor = await history.getRun(actor, run.id as string);
        expect(editor.steps[0]).toMatchObject({
            nodeId: "n1",
            status: "ok",
            input: { url: "https://x.test" },
            output: { status: 200 }
        });
        access.edit = false;
        const reader = await history.getRun(actor, run.id as string);
        expect(reader.canSeeData).toBe(false);
        expect(reader.steps[0]).toMatchObject({ input: null, output: null });
    });
});

/**
 * Workflows on the server: saved per kind of record on the reader's shelf by
 * somebody who may edit it, set off by the changes the timeline records, run as
 * whoever saved them last, and never set off again by what they do themselves.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const RECORD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FLOW = "99999999-9999-4999-8999-999999999999";

const db = vi.hoisted(() => ({
    crmWorkflow: {
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
        count: vi.fn(async () => 0),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "99999999-9999-4999-8999-999999999999",
            runCount: 0,
            lastRunAt: null,
            lastError: null,
            ...data
        })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 }))
    },
    records: {
        findFirst: vi.fn(
            async (): Promise<Record<string, unknown> | null> => ({
                id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                name: "Acme",
                position: 0,
                deletedAt: null
            })
        )
    }
}));

const crmHost = vi.hoisted(() => ({
    crmRunner: vi.fn(
        async (id: string): Promise<unknown> => ({
            id,
            name: "Test User",
            email: "test@example.invalid",
            isAdmin: false,
            sessionId: ""
        })
    ),
    crmOrgPermissions: vi.fn(async (): Promise<string[] | null> => ["*"])
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        crmWorkflow: db.crmWorkflow,
        crmCompany: db.records,
        crmPerson: db.records,
        crmOpportunity: db.records
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost, i18nRequest: { getLocale: async () => "en-US" } }
}));
vi.mock("@polaris-app/crm/src/lib/fields", () => ({ loadFields: async () => [] }));

import * as workflows from "@polaris-app/crm/src/lib/workflows";

const allowed = { read: true, edit: true, delete: true };
const reader = { read: true, edit: false, delete: false };
const actorWith = (can: typeof allowed) =>
    ({
        user: { id: "u1", name: "Test User", isAdmin: false },
        shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Org" },
        can: { companies: can, people: can, opportunities: can }
    }) as never;

const stored = (trigger: unknown, extra: Record<string, unknown> = {}) => ({
    id: FLOW,
    orgId: "o1",
    userId: null,
    object: "companies",
    name: "On create",
    trigger: JSON.stringify(trigger),
    actions: "[]",
    enabled: true,
    runAsId: "u2",
    runCount: 0,
    lastRunAt: null,
    lastError: null,
    ...extra
});

beforeEach(() => vi.clearAllMocks());

describe("saving a workflow", () => {
    it("keeps it on the reader's shelf, running as them", async () => {
        const saved = await workflows.saveWorkflow(actorWith(allowed), "companies", {
            name: "On create",
            trigger: { kind: "created" },
            actions: [],
            enabled: true
        });
        expect(saved.workflow.id).toBe(FLOW);
        expect(db.crmWorkflow.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                orgId: "o1",
                userId: null,
                object: "companies",
                name: "On create",
                trigger: JSON.stringify({ kind: "created" }),
                actions: "[]",
                runAsId: "u1"
            })
        });
    });

    it("refuses somebody who may not edit that kind of record", async () => {
        await expect(
            workflows.saveWorkflow(actorWith(reader), "companies", {
                name: "x",
                trigger: { kind: "created" },
                actions: [],
                enabled: true
            })
        ).rejects.toThrow();
        await expect(workflows.listWorkflows(actorWith(reader), "companies")).rejects.toThrow();
        expect(db.crmWorkflow.create).not.toHaveBeenCalled();
    });

    it("changes and deletes only a workflow on the reader's shelf", async () => {
        await workflows.deleteWorkflow(actorWith(allowed), "companies", FLOW);
        expect(db.crmWorkflow.deleteMany).toHaveBeenCalledWith({
            where: { id: FLOW, orgId: "o1", object: "companies" }
        });
        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                id: FLOW,
                name: "x",
                trigger: { kind: "created" },
                actions: [],
                enabled: true
            })
        ).rejects.toThrow();
    });
});

describe("running on record changes", () => {
    it("runs the enabled workflows of the shelf whose trigger matches, as their runner", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored({ kind: "created" }),
            stored({ kind: "deleted" }, { id: "other" })
        ]);
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "created", changes: [] }
        ]);
        expect(db.crmWorkflow.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { orgId: "o1", object: "companies", enabled: true }
            })
        );
        expect(crmHost.crmRunner).toHaveBeenCalledWith("u2");
        expect(db.crmWorkflow.update).toHaveBeenCalledTimes(1);
        expect(db.crmWorkflow.update).toHaveBeenCalledWith({
            where: { id: FLOW },
            data: expect.objectContaining({ runCount: { increment: 1 }, lastError: null })
        });
    });

    it("records why a workflow could not run when its runner is gone", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([stored({ kind: "created" })]);
        crmHost.crmRunner.mockResolvedValueOnce(null);
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "created", changes: [] }
        ]);
        const [[call]] = db.crmWorkflow.update.mock.calls as unknown as [
            [{ data: { lastError: string } }]
        ];
        expect(call.data.lastError).toMatch(/.+/);
    });

    it("reads nothing for a change no trigger can match, and nothing from inside a run", async () => {
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "restored" }
        ]);
        expect(db.crmWorkflow.findMany).not.toHaveBeenCalled();
        await workflows.withinWorkflow(() =>
            workflows.onRecordEvents(actorWith(allowed), "companies", [
                { recordId: RECORD, kind: "created", changes: [] }
            ])
        );
        expect(db.crmWorkflow.findMany).not.toHaveBeenCalled();
    });
});

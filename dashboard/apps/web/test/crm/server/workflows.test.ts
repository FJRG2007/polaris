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
        count: vi.fn(async () => 1),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            position: 0,
            deletedAt: null,
            ...data
        })),
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

vi.mock("@polaris/db", () => {
    const client: Record<string, unknown> = {
        crmWorkflow: db.crmWorkflow,
        crmCompany: db.records,
        crmPerson: db.records,
        crmOpportunity: db.records,
        crmEvent: { createMany: vi.fn(async () => ({ count: 1 })) }
    };
    client.$transaction = async (run: (tx: unknown) => unknown) => run(client);
    return { prisma: client, Prisma: { Decimal: class {} } };
});
vi.mock("@polaris/app-host", () => ({
    host: { crmHost, i18nRequest: { getLocale: async () => "en-US" } }
}));
vi.mock("@polaris-app/crm/src/lib/fields", () => ({ loadFields: async () => [] }));

import * as workflows from "@polaris-app/crm/src/lib/workflows";

const stamp = {
    updatedAt: new Date("2026-10-01T10:00:00Z"),
    createdAt: new Date("2026-10-01T10:00:00Z")
};

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

describe("record actions", () => {
    const runOn = async (actions: unknown[], trigger: unknown = { kind: "created" }) => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored(trigger, { actions: JSON.stringify(actions) })
        ]);
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "created", changes: [] }
        ]);
        const [[done]] = db.crmWorkflow.update.mock.calls as unknown as [
            [{ data: { lastError: string | null } }]
        ];
        return done.data.lastError;
    };

    it("changes the record that set it off, filled from that record", async () => {
        db.records.findFirst.mockResolvedValue({
            id: RECORD,
            name: "Acme",
            city: "",
            position: 0,
            deletedAt: null,
            ...stamp
        });
        db.records.findMany.mockResolvedValue([
            { id: RECORD, name: "Acme", city: "Acme town", position: 0, deletedAt: null, ...stamp }
        ]);
        expect(
            await runOn([{ kind: "updateRecord", values: { city: "{{name}} town" } }])
        ).toBeNull();
        expect(db.records.updateMany).toHaveBeenCalledWith({
            where: { id: { in: [RECORD] }, orgId: "o1", deletedAt: null },
            data: { city: "Acme town" }
        });
    });

    it("makes a record, logged as created, and stops at a value that does not pass", async () => {
        db.records.findFirst.mockResolvedValue({
            id: RECORD,
            name: "Acme",
            position: 0,
            deletedAt: null,
            ...stamp
        });
        expect(
            await runOn([
                {
                    kind: "createRecord",
                    object: "opportunities",
                    values: { name: "Deal with {{name}}" }
                }
            ])
        ).toBeNull();
        expect(db.records.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "Deal with Acme",
                    orgId: "o1",
                    createdById: "u2"
                })
            })
        );

        vi.clearAllMocks();
        const error = await runOn([
            {
                kind: "createRecord",
                object: "companies",
                values: { name: "x", domain: "not a domain" }
            },
            { kind: "updateRecord", values: { city: "never" } }
        ]);
        expect(error).toMatch(/domain/i);
        expect(db.records.create).not.toHaveBeenCalled();
        expect(db.records.updateMany).not.toHaveBeenCalled();
    });

    it("refuses to save an action on a field that is not there", async () => {
        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                name: "x",
                trigger: { kind: "created" },
                actions: [{ kind: "updateRecord", values: { nope: "1" } }],
                enabled: true
            })
        ).rejects.toThrow();
        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                name: "x",
                trigger: { kind: "deleted" },
                actions: [{ kind: "updateRecord", values: { city: "1" } }],
                enabled: true
            })
        ).rejects.toThrow();
        expect(db.crmWorkflow.create).not.toHaveBeenCalled();
    });
});

describe("a field changing", () => {
    it("runs on the change the timeline logged, and refuses a field that is not there", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored({ kind: "fieldChanged", field: "city", to: "madrid" }),
            stored({ kind: "fieldChanged", field: "city", to: "Paris" }, { id: "other" })
        ]);
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            {
                recordId: RECORD,
                kind: "updated",
                changes: [{ key: "city", before: "", after: "Madrid" }]
            }
        ]);
        expect(db.crmWorkflow.update).toHaveBeenCalledTimes(1);
        expect(db.crmWorkflow.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: FLOW } })
        );

        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                name: "x",
                trigger: { kind: "fieldChanged", field: "nope", to: null },
                actions: [],
                enabled: true
            })
        ).rejects.toThrow();
    });
});

describe("run by hand", () => {
    it("lists the enabled manual workflows to somebody who may edit", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored({ kind: "manual" }, { name: "Qualify" }),
            stored({ kind: "created" }, { id: "other" })
        ]);
        expect(await workflows.listManualWorkflows(actorWith(allowed), "companies")).toEqual([
            { id: FLOW, name: "Qualify" }
        ]);
        await expect(
            workflows.listManualWorkflows(actorWith(reader), "companies")
        ).rejects.toThrow();
    });

    it("runs one on a record and says how it went", async () => {
        db.crmWorkflow.findFirst.mockResolvedValueOnce(stored({ kind: "manual" }));
        db.records.findFirst.mockResolvedValue({
            id: RECORD,
            name: "Acme",
            position: 0,
            deletedAt: null,
            ...stamp
        });
        expect(
            await workflows.runManualWorkflow(actorWith(allowed), "companies", RECORD, FLOW)
        ).toEqual({
            error: null
        });
        expect(db.crmWorkflow.findFirst).toHaveBeenCalledWith({
            where: { id: FLOW, orgId: "o1", object: "companies", enabled: true }
        });
        expect(db.crmWorkflow.update).toHaveBeenCalledTimes(1);
    });

    it("refuses a workflow that is not manual, and a record in the trash", async () => {
        db.crmWorkflow.findFirst.mockResolvedValueOnce(stored({ kind: "created" }));
        await expect(
            workflows.runManualWorkflow(actorWith(allowed), "companies", RECORD, FLOW)
        ).rejects.toThrow();
        db.crmWorkflow.findFirst.mockResolvedValueOnce(stored({ kind: "manual" }));
        db.records.findFirst.mockResolvedValueOnce({
            id: RECORD,
            name: "Acme",
            position: 0,
            deletedAt: new Date(),
            ...stamp
        });
        await expect(
            workflows.runManualWorkflow(actorWith(allowed), "companies", RECORD, FLOW)
        ).rejects.toThrow();
        expect(db.crmWorkflow.update).not.toHaveBeenCalled();
    });
});

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
    crmLink: { createMany: vi.fn(async () => ({ count: 1 })) },
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
    crmOrgPermissions: vi.fn(async (): Promise<string[] | null> => ["*"]),
    crmOrgPeople: vi.fn(async () => [
        { id: "u1", name: "Test User", contact: "" },
        { id: "u3", name: "Other User", contact: "" }
    ]),
    taskListsFor: vi.fn(async () => [
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Sales", spaceName: "Team" }
    ]),
    createTask: vi.fn(
        async (): Promise<unknown> => ({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            reference: "T-1"
        })
    )
}));

const notifications = vi.hoisted(() => ({ createNotification: vi.fn(async () => undefined) }));

const limits = vi.hoisted(() => ({ ok: true }));

vi.mock("@polaris/db", () => {
    const client: Record<string, unknown> = {
        crmWorkflow: db.crmWorkflow,
        crmCompany: db.records,
        crmPerson: db.records,
        crmOpportunity: db.records,
        crmEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
        crmLink: db.crmLink
    };
    client.$transaction = async (run: (tx: unknown) => unknown) => run(client);
    return { prisma: client, Prisma: { Decimal: class {} } };
});
vi.mock("@polaris/app-host", () => ({
    host: {
        crmHost,
        i18nRequest: { getLocale: async () => "en-US" },
        rateLimitService: { rateLimit: async () => ({ ok: limits.ok }) },
        requestContext: { clientIp: async () => "203.0.113.9" },
        notificationService: notifications
    }
}));
vi.mock("@polaris-app/crm/src/lib/fields", () => ({ loadFields: async () => [] }));

import * as workflows from "@polaris-app/crm/src/lib/workflows";
import { createHash } from "node:crypto";
import { POST as hook } from "@polaris-app/crm/src/routes/api/crm/hooks/[secret]/route";

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

beforeEach(() => {
    vi.clearAllMocks();
    limits.ok = true;
});

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

describe("on a schedule", () => {
    it("is saved with when it next runs, and a record trigger with none", async () => {
        await workflows.saveWorkflow(actorWith(allowed), "companies", {
            name: "Weekly",
            trigger: { kind: "schedule", cron: "0 9 * * 1", timeZone: "UTC" },
            actions: [],
            enabled: true
        });
        const [[made]] = db.crmWorkflow.create.mock.calls as unknown as [
            [{ data: { nextRunAt: Date | null } }]
        ];
        expect(made.data.nextRunAt).toBeInstanceOf(Date);
        expect(made.data.nextRunAt!.getUTCDay()).toBe(1);
        expect(made.data.nextRunAt!.getUTCHours()).toBe(9);
    });

    it("runs what is due once, claiming the run before it starts", async () => {
        const due = new Date("2026-10-13T09:00:00Z");
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored({ kind: "schedule", cron: "0 9 * * *", timeZone: "UTC" }, { nextRunAt: due }),
            stored(
                { kind: "schedule", cron: "0 9 * * *", timeZone: "UTC" },
                { id: "taken", nextRunAt: due }
            )
        ]);
        db.crmWorkflow.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        expect(await workflows.runDueSchedules(new Date("2026-10-13T09:00:30Z"))).toBe(1);
        expect(db.crmWorkflow.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { enabled: true, nextRunAt: { lte: new Date("2026-10-13T09:00:30Z") } }
            })
        );
        expect(db.crmWorkflow.updateMany).toHaveBeenCalledWith({
            where: { id: FLOW, nextRunAt: due },
            data: { nextRunAt: new Date("2026-10-14T09:00:00Z") }
        });
        expect(db.crmWorkflow.update).toHaveBeenCalledTimes(1);
        expect(db.crmWorkflow.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: FLOW } })
        );
    });

    it("stops a schedule that is no longer one", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored({ kind: "created" }, { nextRunAt: new Date("2026-10-13T09:00:00Z") })
        ]);
        expect(await workflows.runDueSchedules(new Date("2026-10-13T09:01:00Z"))).toBe(0);
        expect(db.crmWorkflow.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { nextRunAt: null } })
        );
        expect(db.crmWorkflow.update).not.toHaveBeenCalled();
    });
});

describe("an outside call", () => {
    const save = (extra: Record<string, unknown> = {}) =>
        workflows.saveWorkflow(actorWith(allowed), "companies", {
            name: "Leads",
            trigger: { kind: "webhook" },
            actions: [],
            enabled: true,
            ...extra
        });

    it("gets a secret address once, keeping only its hash", async () => {
        const saved = await save();
        expect(saved.hookPath).toMatch(/^\/api\/crm\/hooks\/[\w-]{32,}$/);
        const secret = saved.hookPath!.split("/").at(-1)!;
        const [[made]] = db.crmWorkflow.create.mock.calls as unknown as [
            [{ data: { hookHash: string } }]
        ];
        expect(made.data.hookHash).toBe(createHash("sha256").update(secret).digest("hex"));
        expect(JSON.stringify(made.data)).not.toContain(secret);
    });

    it("keeps the address on a later save, and changes it only when asked", async () => {
        db.crmWorkflow.findFirst.mockResolvedValue(
            stored({ kind: "webhook" }, { hookHash: "kept" })
        );
        expect((await save({ id: FLOW })).hookPath).toBeUndefined();
        expect(db.crmWorkflow.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.not.objectContaining({ hookHash: expect.anything() })
            })
        );
        expect((await save({ id: FLOW, newHookSecret: true })).hookPath).toMatch(
            /^\/api\/crm\/hooks\//
        );
        db.crmWorkflow.findFirst.mockReset();
    });

    const call = (secret: string, body: string) =>
        hook(
            new Request(`https://polaris.example.invalid/api/crm/hooks/${secret}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body
            }) as never,
            { params: Promise.resolve({ secret }) }
        );

    it("runs the workflow its address names with the call's body", async () => {
        const secret = "s".repeat(32);
        db.crmWorkflow.findFirst.mockResolvedValueOnce(
            stored(
                { kind: "webhook" },
                {
                    actions: JSON.stringify([
                        {
                            kind: "createRecord",
                            object: "companies",
                            values: { name: "{{body.company}}" }
                        }
                    ])
                }
            )
        );
        const answer = await call(secret, JSON.stringify({ company: "Initech" }));
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ ok: true });
        expect(db.crmWorkflow.findFirst).toHaveBeenCalledWith({
            where: { hookHash: createHash("sha256").update(secret).digest("hex"), enabled: true }
        });
        expect(db.records.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ name: "Initech" }) })
        );
    });

    it("answers 404 to an unknown address, 400 to a body that is not JSON, 429 past the limit", async () => {
        const secret = "s".repeat(32);
        expect((await call(secret, "{}")).status).toBe(404);
        db.crmWorkflow.findFirst.mockResolvedValueOnce(stored({ kind: "webhook" }));
        expect((await call(secret, "not json")).status).toBe(400);
        expect((await call("short", "{}")).status).toBe(404);
        limits.ok = false;
        expect((await call(secret, "{}")).status).toBe(429);
        expect(db.crmWorkflow.update).not.toHaveBeenCalled();
    });
});

describe("a task or a notification", () => {
    const LIST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const runOn = async (actions: unknown[]) => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored({ kind: "created" }, { actions: JSON.stringify(actions) })
        ]);
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "created", changes: [] }
        ]);
        const [[done]] = db.crmWorkflow.update.mock.calls as unknown as [
            [{ data: { lastError: string | null } }]
        ];
        return done.data.lastError;
    };

    beforeEach(() => {
        db.records.findFirst.mockResolvedValue({
            id: RECORD,
            name: "Acme",
            accountOwnerId: "u3",
            accountOwner: { id: "u3", name: "Other User" },
            position: 0,
            deletedAt: null,
            ...stamp
        });
    });

    it("makes a task in Tasks as the runner, due in the days set, linked to the record", async () => {
        vi.useFakeTimers({ now: new Date("2026-10-13T10:00:00Z"), toFake: ["Date"] });
        expect(
            await runOn([{ kind: "createTask", listId: LIST, name: "Call {{name}}", dueInDays: 2 }])
        ).toBeNull();
        vi.useRealTimers();
        expect(crmHost.createTask).toHaveBeenCalledWith(
            { id: "u2", isAdmin: false },
            {
                listId: LIST,
                name: "Call Acme",
                due: { at: "2026-10-15T00:00:00.000Z", timed: false }
            }
        );
        expect(db.crmLink.createMany).toHaveBeenCalledWith({
            data: [expect.objectContaining({ kind: "task", targetId: TASK, recordId: RECORD })],
            skipDuplicates: true
        });
    });

    it("says why when Tasks refuses", async () => {
        crmHost.createTask.mockResolvedValueOnce({ refused: "That list is gone." });
        expect(
            await runOn([{ kind: "createTask", listId: LIST, name: "x", dueInDays: null }])
        ).toBe("That list is gone.");
    });

    it("notifies the people named and whoever the field names, once each, only on the shelf", async () => {
        expect(
            await runOn([
                {
                    kind: "notify",
                    to: ["u1", "field:accountOwner", "u3", "gone"],
                    title: "New company {{name}}",
                    body: "Owner {{accountOwner}}"
                }
            ])
        ).toBeNull();
        const sent = notifications.createNotification.mock.calls.map(
            (call) =>
                (
                    call as unknown as [
                        { userId: string; title: string; body: string; href: string }
                    ]
                )[0]
        );
        expect(sent.map((one) => one.userId).sort()).toEqual(["u1", "u3"]);
        expect(sent[0]).toMatchObject({
            title: "New company Acme",
            body: "Owner Other User",
            href: `/crm/companies/${RECORD}`,
            shelf: "o1"
        });
    });

    it("refuses to save a list the runner cannot use, or somebody not on the shelf", async () => {
        const save = (action: unknown) =>
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                name: "x",
                trigger: { kind: "created" },
                actions: [action as never],
                enabled: true
            });
        await expect(
            save({
                kind: "createTask",
                listId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                name: "x",
                dueInDays: null
            })
        ).rejects.toThrow();
        await expect(
            save({ kind: "notify", to: ["stranger"], title: "x", body: "" })
        ).rejects.toThrow();
        await expect(
            save({ kind: "notify", to: ["field:city"], title: "x", body: "" })
        ).rejects.toThrow();
        expect(db.crmWorkflow.create).not.toHaveBeenCalled();
    });

    it("offers the editor the lists it may add tasks to and the people on the shelf", async () => {
        expect(await workflows.workflowOptions(actorWith(allowed))).toEqual({
            taskLists: [{ id: LIST, name: "Sales", spaceName: "Team" }],
            people: [
                { id: "u1", name: "Test User" },
                { id: "u3", name: "Other User" }
            ]
        });
    });
});

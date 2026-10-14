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
    crmWorkflowRun: {
        create: vi.fn(async () => ({ id: "77777777-7777-4777-8777-777777777777" })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        deleteMany: vi.fn(async () => ({ count: 0 }))
    },
    crmWorkflowVersion: {
        findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        create: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({ count: 0 }))
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
    crmOrgAccess: vi.fn(async (): Promise<unknown> => ({ role: null, permissions: ["*"] })),
    crmOrgPeople: vi.fn(async () => [
        { id: "u1", name: "Test User", contact: "" },
        { id: "u3", name: "Other User", contact: "" }
    ]),
    taskListsFor: vi.fn(async () => [
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Sales", spaceName: "Team" }
    ]),
    crmPostJson: vi.fn(async (): Promise<unknown> => ({ status: 200 })),
    crmCanSendMail: vi.fn(async () => true),
    crmSendMail: vi.fn(async (): Promise<unknown> => ({ sent: true })),
    crmChatChannels: vi.fn(async () => [
        { id: "33333333-3333-4333-8333-333333333333", name: "sales" }
    ]),
    crmSendChat: vi.fn(async (): Promise<unknown> => ({ sent: true })),
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
        crmWorkflowRun: db.crmWorkflowRun,
        crmWorkflowVersion: db.crmWorkflowVersion,
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
import * as model from "@polaris-app/crm/src/model/workflows";
import type { ViewFilter } from "@polaris-app/crm/src/model/filters";
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

describe("versions", () => {
    const input = {
        name: "On create",
        trigger: { kind: "created" as const },
        actions: [],
        enabled: true
    };

    it("keeps each save as a version, by whoever saved it", async () => {
        await workflows.saveWorkflow(actorWith(allowed), "companies", input);
        expect(db.crmWorkflowVersion.create).toHaveBeenCalledWith({
            data: {
                workflowId: FLOW,
                name: "On create",
                trigger: JSON.stringify({ kind: "created" }),
                actions: "[]",
                savedById: "u1"
            }
        });
    });

    it("keeps no new version when nothing changed, and drops the oldest past the cap", async () => {
        db.crmWorkflowVersion.findFirst.mockResolvedValueOnce({
            name: "On create",
            trigger: JSON.stringify({ kind: "created" }),
            actions: "[]"
        });
        await workflows.saveWorkflow(actorWith(allowed), "companies", input);
        expect(db.crmWorkflowVersion.create).not.toHaveBeenCalled();

        db.crmWorkflowVersion.findFirst
            .mockResolvedValueOnce({ name: "Before", trigger: "{}", actions: "[]" })
            .mockResolvedValueOnce({ createdAt: stamp.createdAt });
        await workflows.saveWorkflow(actorWith(allowed), "companies", input);
        expect(db.crmWorkflowVersion.create).toHaveBeenCalledTimes(1);
        expect(db.crmWorkflowVersion.deleteMany).toHaveBeenCalledWith({
            where: { workflowId: FLOW, createdAt: { lte: stamp.createdAt } }
        });
    });

    it("saves nothing at all when the workflow is not on the shelf", async () => {
        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", { ...input, id: FLOW })
        ).rejects.toThrow();
        expect(db.crmWorkflowVersion.create).not.toHaveBeenCalled();
    });

    it("lists versions only to an editor on its shelf, leaving out unreadable ones", async () => {
        await expect(
            workflows.listWorkflowVersions(actorWith(allowed), "companies", FLOW)
        ).rejects.toThrow();
        await expect(
            workflows.listWorkflowVersions(actorWith(reader), "companies", FLOW)
        ).rejects.toThrow();
        db.crmWorkflow.findFirst.mockResolvedValueOnce({ id: FLOW });
        db.crmWorkflowVersion.findMany.mockResolvedValueOnce([
            {
                id: "v2",
                name: "On create",
                trigger: JSON.stringify({ kind: "created" }),
                actions: JSON.stringify([{ kind: "delay", minutes: 60 }]),
                savedById: "u1",
                createdAt: stamp.createdAt
            },
            {
                id: "v1",
                name: "Old",
                trigger: "not json",
                actions: "[]",
                savedById: null,
                createdAt: stamp.createdAt
            }
        ]);
        expect(await workflows.listWorkflowVersions(actorWith(allowed), "companies", FLOW)).toEqual(
            [
                {
                    id: "v2",
                    name: "On create",
                    trigger: { kind: "created" },
                    actions: [{ kind: "delay", minutes: 60 }],
                    savedById: "u1",
                    createdAt: stamp.createdAt.toISOString()
                }
            ]
        );
        expect(db.crmWorkflowVersion.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { workflowId: FLOW }, take: 20 })
        );
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

    it("reads nothing for a change no trigger can match", async () => {
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "restored" }
        ]);
        expect(db.crmWorkflow.findMany).not.toHaveBeenCalled();
    });

    it("sets nothing off from inside a run, but wakes the runs waiting for the record", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([stored({ kind: "created" })]);
        await workflows.withinWorkflow(() =>
            workflows.onRecordEvents(actorWith(allowed), "companies", [
                { recordId: RECORD, kind: "created", changes: [] }
            ])
        );
        expect(crmHost.crmRunner).not.toHaveBeenCalled();
        expect(db.crmWorkflowRun.create).not.toHaveBeenCalled();
        expect(db.crmWorkflowRun.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ recordId: { in: [RECORD] }, status: "waiting" })
            })
        );
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
            data: { city: "Acme town", updatedById: expect.any(String) }
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

describe("branches and loops", () => {
    const when: ViewFilter = {
        conjunction: "and",
        rules: [{ id: "r1", key: "city", operator: "contains", value: "Paris" }]
    };
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
    const record = { id: RECORD, name: "Acme", city: "", position: 0, deletedAt: null, ...stamp };

    it("ends the run quietly where the record does not pass a filter", async () => {
        db.records.findFirst.mockResolvedValue(record);
        db.records.count.mockResolvedValueOnce(0);
        expect(
            await runOn([
                { kind: "filter", when },
                { kind: "updateRecord", values: { city: "never" } }
            ])
        ).toBeNull();
        expect(db.records.count).toHaveBeenCalledWith({
            where: {
                AND: [expect.objectContaining({ orgId: "o1", deletedAt: null }), { id: RECORD }]
            }
        });
        expect(db.records.updateMany).not.toHaveBeenCalled();
    });

    it("runs one branch or the other by whether the record matches", async () => {
        db.records.findFirst.mockResolvedValue(record);
        db.records.findMany.mockResolvedValue([record]);
        const branch = {
            kind: "ifElse",
            when,
            then: [{ kind: "updateRecord", values: { city: "matched" } }],
            otherwise: [{ kind: "updateRecord", values: { city: "missed" } }]
        };
        db.records.count.mockResolvedValueOnce(1);
        expect(await runOn([branch])).toBeNull();
        expect(db.records.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ city: "matched" }) })
        );

        vi.clearAllMocks();
        db.records.count.mockResolvedValueOnce(0);
        expect(await runOn([branch])).toBeNull();
        expect(db.records.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ city: "missed" }) })
        );
    });

    it("runs a loop's actions on each record found, filled from that record", async () => {
        const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        db.records.findMany.mockResolvedValue([
            { ...record, name: "Acme" },
            { ...record, id: other, name: "Globex" }
        ]);
        db.records.count.mockResolvedValue(2);
        db.records.findFirst.mockImplementation(
            async (query?: { where?: { id?: string } }) =>
                (query?.where?.id === other
                    ? { ...record, id: other, name: "Globex" }
                    : record) as never
        );
        const loop = {
            kind: "forEach",
            where: when,
            limit: 5,
            actions: [{ kind: "updateRecord", values: { city: "{{name}} city" } }]
        };
        expect(
            await workflows.runWorkflow(
                stored(
                    { kind: "schedule", cron: "0 9 * * 1", timeZone: "UTC" },
                    { actions: JSON.stringify([loop]) }
                ),
                { object: "companies", recordId: null, event: null }
            )
        ).toBeNull();
        expect(db.records.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
        const written = (
            db.records.updateMany.mock.calls as unknown as [
                { where: { id: { in: string[] } }; data: { city: string } }
            ][]
        ).map(([call]) => [call.where.id.in[0], call.data.city]);
        expect(written).toEqual([
            [RECORD, "Acme city"],
            [other, "Globex city"]
        ]);
        db.records.findFirst.mockReset();
        db.records.count.mockReset();
        db.records.count.mockResolvedValue(1);
    });

    it("refuses to save a check on the record under a trigger about none", async () => {
        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                name: "x",
                trigger: { kind: "schedule", cron: "0 9 * * 1", timeZone: "UTC" },
                actions: [{ kind: "filter", when }],
                enabled: true
            })
        ).rejects.toThrow();
        expect(db.crmWorkflow.create).not.toHaveBeenCalled();
    });
});

describe("delays and the run log", () => {
    const RUN = "77777777-7777-4777-8777-777777777777";
    const record = { id: RECORD, name: "Acme", city: "", position: 0, deletedAt: null, ...stamp };
    const flow = [
        { kind: "updateRecord", values: { city: "first" } },
        { kind: "delay", minutes: 60 },
        { kind: "updateRecord", values: { city: "after" } }
    ];

    it("logs a run, and one that reaches a delay waits with what it needs to go on", async () => {
        db.records.findFirst.mockResolvedValue(record);
        db.records.findMany.mockResolvedValue([record]);
        const before = Date.now();
        expect(
            await workflows.runWorkflow(
                stored({ kind: "webhook" }, { actions: JSON.stringify(flow) }),
                { object: "companies", recordId: RECORD, event: null, body: { a: 1 } }
            )
        ).toBeNull();
        expect(db.crmWorkflowRun.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                workflowId: FLOW,
                status: "running",
                cause: "webhook",
                recordId: RECORD,
                resumeAt: expect.any(Date)
            }),
            select: { id: true }
        });
        const [[waiting]] = db.crmWorkflowRun.updateMany.mock.calls as unknown as [
            [{ data: { status: string; step: number; resumeAt: Date; body: string } }]
        ];
        expect(waiting.data).toMatchObject({
            status: "waiting",
            step: 2,
            body: '{"a":1}',
            actions: JSON.stringify(flow)
        });
        expect(waiting.data.resumeAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
        expect(db.records.updateMany).toHaveBeenCalledTimes(1);
        expect(db.crmWorkflow.update).not.toHaveBeenCalled();
    });

    it("picks a waiting run up after its delay, once, and ends it", async () => {
        db.records.findFirst.mockResolvedValue(record);
        db.records.findMany.mockResolvedValue([record]);
        const due = new Date(Date.now() - 1_000);
        const now = new Date();
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([
            {
                id: RUN,
                status: "waiting",
                resumeAt: due,
                recordId: RECORD,
                step: 2,
                body: null,
                workflow: stored({ kind: "created" }, { actions: JSON.stringify(flow) })
            }
        ]);
        expect(await workflows.resumeWaitingRuns(now)).toBe(1);
        expect(db.crmWorkflowRun.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    OR: [
                        { status: { in: ["waiting", "running"] }, resumeAt: { lte: now } },
                        {
                            status: "running",
                            resumeAt: null,
                            startedAt: { lte: new Date(now.getTime() - 30 * 60_000) }
                        }
                    ]
                }
            })
        );
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "waiting", resumeAt: due },
            data: { status: "running", resumeAt: new Date(now.getTime() + 30 * 60_000) }
        });
        expect(db.crmWorkflowRun.create).not.toHaveBeenCalled();
        expect(db.records.updateMany).toHaveBeenCalledTimes(1);
        expect(db.records.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ city: "after" }) })
        );
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "running" },
            data: expect.objectContaining({ status: "done", error: null })
        });
        expect(db.crmWorkflow.update).toHaveBeenCalledTimes(1);
    });

    it("fails a run cut short once its lease is up instead of running it again", async () => {
        const lapsed = new Date(Date.now() - 1_000);
        const now = new Date();
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([
            {
                id: RUN,
                status: "running",
                resumeAt: lapsed,
                recordId: RECORD,
                step: 0,
                body: null,
                actions: null,
                workflow: stored({ kind: "created" }, { actions: JSON.stringify(flow) })
            }
        ]);
        expect(await workflows.resumeWaitingRuns(now)).toBe(0);
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "running", resumeAt: lapsed },
            data: expect.objectContaining({ status: "failed", finishedAt: now, resumeAt: null })
        });
        expect(db.records.updateMany).not.toHaveBeenCalled();
        expect(db.crmWorkflow.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ lastError: expect.any(String), lastRunAt: now })
            })
        );
    });

    it("fails a run left running with no lease once it is older than the lease", async () => {
        const now = new Date();
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([
            {
                id: RUN,
                status: "running",
                resumeAt: null,
                recordId: RECORD,
                step: 0,
                body: null,
                actions: null,
                workflow: stored({ kind: "created" }, { actions: JSON.stringify(flow) })
            }
        ]);
        expect(await workflows.resumeWaitingRuns(now)).toBe(0);
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "running", resumeAt: null },
            data: expect.objectContaining({ status: "failed", finishedAt: now })
        });
        expect(db.crmWorkflow.update).toHaveBeenCalledTimes(1);
    });

    it("leaves a run failed as cut short as it is when it ends after all", async () => {
        db.crmWorkflowRun.updateMany.mockResolvedValueOnce({ count: 0 });
        await workflows.runWorkflow(stored({ kind: "manual" }, { runAsId: null }), {
            object: "companies",
            recordId: null,
            event: null
        });
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: RUN, status: "running" } })
        );
        expect(db.crmWorkflowRun.update).not.toHaveBeenCalled();
        expect(db.crmWorkflow.update).not.toHaveBeenCalled();
        expect(db.crmWorkflowRun.deleteMany).not.toHaveBeenCalled();
    });

    it("gives a run started directly the same lease", async () => {
        const before = Date.now();
        await workflows.runWorkflow(stored({ kind: "manual" }, { runAsId: null }), {
            object: "companies",
            recordId: null,
            event: null
        });
        const [[created]] = db.crmWorkflowRun.create.mock.calls as unknown as [
            [{ data: { status: string; resumeAt: Date } }]
        ];
        expect(created.data.status).toBe("running");
        expect(created.data.resumeAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    });

    it("goes on with the actions it started with when the workflow is edited while it waits", async () => {
        db.records.findFirst.mockResolvedValue(record);
        db.records.findMany.mockResolvedValue([record]);
        const edited = [
            { kind: "delay", minutes: 5 },
            { kind: "updateRecord", values: { city: "edited" } },
            { kind: "updateRecord", values: { city: "edited too" } }
        ];
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([
            {
                id: RUN,
                recordId: RECORD,
                step: 2,
                body: null,
                actions: JSON.stringify(flow),
                workflow: stored({ kind: "created" }, { actions: JSON.stringify(edited) })
            }
        ]);
        expect(await workflows.resumeWaitingRuns(new Date())).toBe(1);
        expect(db.records.updateMany).toHaveBeenCalledTimes(1);
        expect(db.records.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ city: "after" }) })
        );
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "running" },
            data: expect.objectContaining({ status: "done", actions: null })
        });
    });

    it("keeps its snapshot through a second delay", async () => {
        db.records.findFirst.mockResolvedValue(record);
        db.records.findMany.mockResolvedValue([record]);
        const twice = [
            ...flow,
            { kind: "delay", minutes: 1 },
            { kind: "updateRecord", values: { city: "last" } }
        ];
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([
            {
                id: RUN,
                recordId: RECORD,
                step: 2,
                body: null,
                actions: JSON.stringify(twice),
                workflow: stored({ kind: "created" }, { actions: JSON.stringify([]) })
            }
        ]);
        expect(await workflows.resumeWaitingRuns(new Date())).toBe(1);
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "running" },
            data: expect.objectContaining({
                status: "waiting",
                step: 4,
                actions: JSON.stringify(twice)
            })
        });
    });

    it("cancels a waiting run of a workflow switched off, and skips one claimed elsewhere", async () => {
        const waiting = (enabled: boolean) => ({
            id: RUN,
            recordId: RECORD,
            step: 2,
            body: null,
            workflow: stored({ kind: "created" }, { actions: JSON.stringify(flow), enabled })
        });
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([waiting(false)]);
        expect(await workflows.resumeWaitingRuns(new Date())).toBe(0);
        expect(db.crmWorkflowRun.update).toHaveBeenCalledWith({
            where: { id: RUN },
            data: expect.objectContaining({ status: "cancelled" })
        });

        vi.clearAllMocks();
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([waiting(true)]);
        db.crmWorkflowRun.updateMany.mockResolvedValueOnce({ count: 0 });
        expect(await workflows.resumeWaitingRuns(new Date())).toBe(0);
        expect(db.records.updateMany).not.toHaveBeenCalled();
    });

    it("notes a failure on the run and keeps only the latest runs", async () => {
        db.crmWorkflowRun.findFirst.mockResolvedValueOnce({ startedAt: stamp.createdAt });
        expect(
            await workflows.runWorkflow(stored({ kind: "manual" }, { runAsId: null }), {
                object: "companies",
                recordId: null,
                event: null
            })
        ).not.toBeNull();
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "running" },
            data: expect.objectContaining({ status: "failed", error: expect.any(String) })
        });
        expect(db.crmWorkflowRun.deleteMany).toHaveBeenCalledWith({
            where: {
                workflowId: FLOW,
                startedAt: { lte: stamp.createdAt },
                status: { not: "waiting" }
            }
        });
    });

    it("shows a workflow's runs only to an editor on its shelf", async () => {
        await expect(
            workflows.listWorkflowRuns(actorWith(allowed), "companies", FLOW)
        ).rejects.toThrow();
        await expect(
            workflows.listWorkflowRuns(actorWith(reader), "companies", FLOW)
        ).rejects.toThrow();
        db.crmWorkflow.findFirst.mockResolvedValueOnce({ id: FLOW });
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([
            {
                id: RUN,
                status: "stopped",
                cause: "created",
                recordId: RECORD,
                error: null,
                startedAt: stamp.createdAt,
                finishedAt: stamp.createdAt,
                resumeAt: null
            }
        ]);
        expect(await workflows.listWorkflowRuns(actorWith(allowed), "companies", FLOW)).toEqual([
            expect.objectContaining({ id: RUN, status: "stopped", recordId: RECORD })
        ]);
        expect(db.crmWorkflow.findFirst).toHaveBeenLastCalledWith({
            where: { id: FLOW, orgId: "o1", object: "companies" },
            select: { id: true }
        });
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
            ],
            chatChannels: [{ id: "33333333-3333-4333-8333-333333333333", name: "sales" }],
            mail: true
        });
    });

    it("posts a chat message as the runner, filled from the record", async () => {
        const channelId = "33333333-3333-4333-8333-333333333333";
        expect(await runOn([{ kind: "sendChat", channelId, body: "Won {{name}}" }])).toBeNull();
        expect(crmHost.crmSendChat).toHaveBeenCalledWith(
            { id: "u2", isAdmin: false },
            { channelId, body: "Won Acme" }
        );
        db.crmWorkflow.update.mockClear();
        crmHost.crmSendChat.mockResolvedValueOnce({ refused: "archived" });
        expect(await runOn([{ kind: "sendChat", channelId, body: "x" }])).toMatch(/archived/);
    });

    it("refuses to save a chat message to a channel the owner cannot post in", async () => {
        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                name: "x",
                trigger: { kind: "created" },
                actions: [
                    {
                        kind: "sendChat",
                        channelId: "44444444-4444-4444-8444-444444444444",
                        body: "x"
                    }
                ],
                enabled: true
            })
        ).rejects.toThrow(/channel/);
        expect(db.crmWorkflow.create).not.toHaveBeenCalled();
    });

    it("emails from the runner's mailbox, filled from the record, each address once", async () => {
        expect(
            await runOn([
                {
                    kind: "sendEmail",
                    to: "Sales@Example.test; sales@example.test, {{city}}",
                    subject: "About {{name}}",
                    body: "Hello {{name}}"
                }
            ])
        ).toBeNull();
        expect(crmHost.crmSendMail).toHaveBeenCalledWith(
            { id: "u2", isAdmin: false },
            { to: ["sales@example.test"], subject: "About Acme", body: "Hello Acme" }
        );
    });

    it("says why an email could not go", async () => {
        const email = (to: string) => [{ kind: "sendEmail", to, subject: "x", body: "" }];
        expect(await runOn(email("not-an-address"))).toContain("not-an-address");
        db.crmWorkflow.update.mockClear();
        expect(await runOn(email("{{city}}"))).toBeTruthy();
        db.crmWorkflow.update.mockClear();
        crmHost.crmSendMail.mockResolvedValueOnce({ refused: "mail" });
        expect(await runOn(email("sales@example.test"))).toMatch(/mailbox/);
    });

    it("refuses to save an email for somebody with no mailbox", async () => {
        crmHost.crmCanSendMail.mockResolvedValueOnce(false);
        await expect(
            workflows.saveWorkflow(actorWith(allowed), "companies", {
                name: "x",
                trigger: { kind: "created" },
                actions: [{ kind: "sendEmail", to: "sales@example.test", subject: "x", body: "" }],
                enabled: true
            })
        ).rejects.toThrow(/mailbox/);
        expect(db.crmWorkflow.create).not.toHaveBeenCalled();
    });
});

describe("a call out", () => {
    const URL = "https://hooks.example.invalid/crm";
    const runOn = async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            stored(
                { kind: "created" },
                { actions: JSON.stringify([{ kind: "httpRequest", url: URL }]) }
            )
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
            position: 0,
            deletedAt: null,
            ...stamp
        });
    });

    it("posts the record that set it off as JSON, through the checked fetch", async () => {
        expect(await runOn()).toBeNull();
        expect(crmHost.crmPostJson).toHaveBeenCalledTimes(1);
        const [[url, body]] = crmHost.crmPostJson.mock.calls as unknown as [[string, string]];
        expect(url).toBe(URL);
        expect(JSON.parse(body)).toEqual({
            workflow: expect.objectContaining({ id: expect.any(String) }),
            object: "companies",
            event: "created",
            record: expect.objectContaining({
                id: RECORD,
                fields: expect.objectContaining({ name: "Acme" })
            })
        });
    });

    it("says what went wrong when the other end refuses or cannot be reached", async () => {
        crmHost.crmPostJson.mockResolvedValueOnce({ status: 500 });
        expect(await runOn()).toContain("500");
        db.crmWorkflow.update.mockClear();
        crmHost.crmPostJson.mockResolvedValueOnce({ failed: "address" });
        expect(await runOn()).toBeTruthy();
        db.crmWorkflow.update.mockClear();
        crmHost.crmPostJson.mockResolvedValueOnce({ failed: "unreachable" });
        expect(await runOn()).toBeTruthy();
    });
});

describe("waiting for the record to match", () => {
    const RUN = "77777777-7777-4777-8777-777777777777";
    const record = { id: RECORD, name: "Acme", city: "", position: 0, deletedAt: null, ...stamp };
    const when = {
        conjunction: "and",
        rules: [{ id: "r1", key: "city", operator: "is", value: "Madrid" }]
    };
    const cityChange = { key: "city", before: "", after: "Madrid" };
    const flow = (onTimeout: "stop" | "continue" = "stop") => [
        { kind: "waitFor", when, days: 7, onTimeout },
        { kind: "updateRecord", values: { city: "after" } }
    ];
    const waitingRun = (waitUntil: Date, onTimeout: "stop" | "continue" = "stop") => ({
        id: RUN,
        status: "waiting",
        resumeAt: waitUntil,
        waitUntil,
        recordId: RECORD,
        step: 0,
        body: null,
        actions: JSON.stringify(flow(onTimeout)),
        workflow: stored({ kind: "updated" }, { actions: JSON.stringify(flow(onTimeout)) })
    });
    const ended = () =>
        (
            db.crmWorkflowRun.updateMany.mock.calls as unknown as [
                { where: { status: string }; data: Record<string, unknown> }
            ][]
        )
            .map(([call]) => call)
            .filter((call) => call.where.status === "running");

    beforeEach(() => {
        db.records.findFirst.mockResolvedValue(record);
        db.records.findMany.mockResolvedValue([record]);
    });

    it("waits at that action, for up to its days, when the record does not match yet", async () => {
        db.records.count.mockResolvedValue(0);
        const before = Date.now();
        await workflows.runWorkflow(
            stored({ kind: "updated" }, { actions: JSON.stringify(flow()) }),
            {
                object: "companies",
                recordId: RECORD,
                event: null
            }
        );
        const [waiting] = ended();
        expect(waiting!.data).toMatchObject({ status: "waiting", step: 0 });
        const until = (waiting!.data.waitUntil as Date).getTime();
        expect(until).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
        expect((waiting!.data.resumeAt as Date).getTime()).toBe(until);
        expect(db.records.updateMany).not.toHaveBeenCalled();
    });

    it("goes straight on when the record already matches", async () => {
        db.records.count.mockResolvedValue(1);
        await workflows.runWorkflow(
            stored({ kind: "updated" }, { actions: JSON.stringify(flow()) }),
            {
                object: "companies",
                recordId: RECORD,
                event: null
            }
        );
        expect(ended()[0]!.data).toMatchObject({ status: "done", waitUntil: null });
        expect(db.records.updateMany).toHaveBeenCalledTimes(1);
    });

    it("goes on as soon as a change makes the record match", async () => {
        db.records.count.mockResolvedValue(1);
        const until = new Date(Date.now() + 86_400_000);
        db.crmWorkflow.findMany.mockResolvedValueOnce([stored({ kind: "deleted" })]);
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([waitingRun(until)]);
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "updated", changes: [cityChange] }
        ]);
        expect(db.crmWorkflowRun.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    workflowId: { in: [FLOW] },
                    recordId: { in: [RECORD] },
                    status: "waiting",
                    waitUntil: { not: null }
                }
            })
        );
        expect(db.crmWorkflowRun.updateMany).toHaveBeenCalledWith({
            where: { id: RUN, status: "waiting", resumeAt: until },
            data: expect.objectContaining({ status: "running" })
        });
        expect(db.records.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ city: "after" }) })
        );
        expect(ended().at(-1)!.data).toMatchObject({ status: "done" });
    });

    it("waits on until the same time when a change leaves it not matching", async () => {
        db.records.count.mockResolvedValue(0);
        const until = new Date(Date.now() + 86_400_000);
        db.crmWorkflow.findMany.mockResolvedValueOnce([stored({ kind: "deleted" })]);
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([waitingRun(until)]);
        await workflows.onRecordEvents(actorWith(allowed), "companies", [
            { recordId: RECORD, kind: "updated", changes: [cityChange] }
        ]);
        expect(ended().at(-1)!.data).toMatchObject({
            status: "waiting",
            step: 0,
            resumeAt: until,
            waitUntil: until
        });
        expect(db.records.updateMany).not.toHaveBeenCalled();
    });

    it("ends the run once the wait is up, or goes on when told to", async () => {
        db.records.count.mockResolvedValue(0);
        const lapsed = new Date(Date.now() - 1_000);
        db.crmWorkflowRun.findMany.mockResolvedValueOnce([waitingRun(lapsed)]);
        expect(await workflows.resumeWaitingRuns(new Date())).toBe(1);
        expect(ended().at(-1)!.data).toMatchObject({ status: "stopped" });
        expect(db.records.updateMany).not.toHaveBeenCalled();

        db.crmWorkflowRun.findMany.mockResolvedValueOnce([waitingRun(lapsed, "continue")]);
        expect(await workflows.resumeWaitingRuns(new Date())).toBe(1);
        expect(ended().at(-1)!.data).toMatchObject({ status: "done" });
        expect(db.records.updateMany).toHaveBeenCalledTimes(1);
    });

    it("is offered only under a trigger about one record", () => {
        expect(model.actionFits("waitFor", "updated")).toBe(true);
        expect(model.actionFits("waitFor", "schedule")).toBe(false);
    });
});

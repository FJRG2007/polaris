/**
 * CRM workflows in the central automations engine: a workflow moves once and
 * keeps its id, a moved one is no longer run by the CRM's own engine, and a
 * record change, a schedule, a webhook call or "Run on this record" starts its
 * automation exactly once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const RECORD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FLOW = "99999999-9999-4999-8999-999999999999";
const CENTRAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const db = vi.hoisted(() => ({
    crmWorkflow: {
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({}))
    },
    crmWorkflowRun: {
        create: vi.fn(async () => ({ id: "77777777-7777-4777-8777-777777777777" })),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        updateMany: vi.fn(async () => ({ count: 0 }))
    }
}));
const automations = vi.hoisted(() => ({
    appTriggers: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    fireAppTrigger: vi.fn(async () => true),
    wakeAppWaits: vi.fn(async () => undefined),
    importLegacyAutomation: vi.fn(async () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}));

vi.mock("@polaris/db", () => ({ prisma: db, Prisma: { Decimal: class {} } }));
vi.mock("@polaris/app-host", () => ({
    host: {
        automations,
        crmHost: {},
        i18nRequest: { getClient: async () => "browser", getLocale: async () => "en-US" }
    }
}));
vi.mock("@polaris-app/crm/src/lib/fields", () => ({ loadFields: async () => [] }));

import * as workflows from "@polaris-app/crm/src/lib/workflows";
import * as central from "@polaris-app/crm/src/lib/automation-central";
import { moveCrmWorkflows } from "@polaris-app/crm/src/lib/automation-move";
import { TRIGGER_NODE_TYPE } from "@polaris-app/crm/src/model/automation-nodes";

const actor = {
    user: { id: OWNER, name: "Test User", isAdmin: false },
    shelf: { orgId: "11111111-1111-4111-8111-111111111111", userId: null, key: "org:o1", orgName: "Org" },
    can: {
        companies: { read: true, edit: true, delete: true },
        people: { read: true, edit: true, delete: true },
        opportunities: { read: true, edit: true, delete: true }
    }
} as never;

const ORG = "11111111-1111-4111-8111-111111111111";

function armed(trigger: unknown, overrides: Record<string, unknown> = {}) {
    return {
        automationId: CENTRAL,
        versionId: "v1",
        nodeId: "n1",
        type: TRIGGER_NODE_TYPE,
        config: { orgId: ORG, object: "companies", trigger },
        name: "New company",
        timeZone: "UTC",
        armedAt: new Date("2026-01-01T00:00:00Z"),
        runAsId: OWNER,
        legacyRef: null,
        ...overrides
    };
}

const workflowRow = {
    id: FLOW,
    orgId: ORG,
    userId: null,
    object: "companies",
    name: "New company",
    trigger: JSON.stringify({ kind: "created" }),
    actions: JSON.stringify([{ kind: "updateRecord", values: { city: "Madrid" } }]),
    enabled: true,
    runAsId: OWNER,
    runCount: 0,
    lastRunAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00Z")
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("moving workflows", () => {
    it("imports each workflow once under its own key and marks it moved", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([workflowRow]);
        expect(await moveCrmWorkflows()).toBe(1);
        expect(automations.importLegacyAutomation).toHaveBeenCalledWith(
            expect.objectContaining({
                legacyRef: `crm-workflow:${FLOW}`,
                ownerId: OWNER,
                origin: "crm",
                originRef: "companies",
                enabled: true
            })
        );
        // Only a row not yet marked is marked, and its schedule is the automation's now.
        expect(db.crmWorkflow.updateMany).toHaveBeenCalledWith({
            where: { id: FLOW, movedToId: null },
            data: { movedToId: CENTRAL, nextRunAt: null }
        });
        // Asked again, the next pass reads only rows that have not moved.
        await moveCrmWorkflows();
        expect(db.crmWorkflow.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ movedToId: null }) })
        );
    });

    it("leaves a workflow nobody runs as, or one it cannot read, where it is", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([
            { ...workflowRow, runAsId: null },
            { ...workflowRow, id: "88888888-8888-4888-8888-888888888888", trigger: "{" }
        ]);
        expect(await moveCrmWorkflows()).toBe(0);
        expect(automations.importLegacyAutomation).not.toHaveBeenCalled();
        expect(db.crmWorkflow.updateMany).not.toHaveBeenCalled();
    });
});

describe("record changes", () => {
    it("starts the automation of a moved workflow once, and not the workflow", async () => {
        db.crmWorkflow.findMany.mockResolvedValueOnce([{ ...workflowRow, movedToId: CENTRAL }]);
        automations.appTriggers.mockResolvedValueOnce([armed({ kind: "created" })]);
        await workflows.onRecordEvents(actor, "companies", [
            { recordId: RECORD, kind: "created", changes: [] }
        ]);
        expect(db.crmWorkflowRun.create).not.toHaveBeenCalled();
        expect(automations.fireAppTrigger).toHaveBeenCalledTimes(1);
        expect(automations.fireAppTrigger).toHaveBeenCalledWith(
            expect.objectContaining({
                automationId: CENTRAL,
                nodeId: "n1",
                depth: 0,
                cause: expect.objectContaining({
                    crm: expect.objectContaining({ object: "companies", recordId: RECORD })
                })
            })
        );
        expect(automations.wakeAppWaits).toHaveBeenCalledWith("crm");
    });

    it("starts nothing for another shelf, another kind of record or a trigger that does not match", async () => {
        automations.appTriggers.mockResolvedValueOnce([
            armed({ kind: "created" }, { config: { orgId: null, object: "companies", trigger: { kind: "created" } } }),
            armed({ kind: "created" }, { config: { orgId: ORG, object: "people", trigger: { kind: "created" } } }),
            armed({ kind: "deleted" })
        ]);
        await workflows.onRecordEvents(actor, "companies", [
            { recordId: RECORD, kind: "created", changes: [] }
        ]);
        expect(automations.fireAppTrigger).not.toHaveBeenCalled();
    });

    it("starts nothing from a change a run made, but wakes the steps waiting on records", async () => {
        automations.appTriggers.mockResolvedValue([armed({ kind: "created" })]);
        await workflows.withinWorkflow(() =>
            workflows.onRecordEvents(actor, "companies", [
                { recordId: RECORD, kind: "created", changes: [] }
            ])
        );
        expect(automations.fireAppTrigger).not.toHaveBeenCalled();
        expect(automations.wakeAppWaits).toHaveBeenCalledWith("crm");
        automations.appTriggers.mockReset();
        automations.appTriggers.mockResolvedValue([]);
    });
});

describe("schedules", () => {
    it("fires a schedule due this minute under one key, so a second pass starts nothing new", async () => {
        const trigger = { kind: "schedule", cron: "0 9 * * *", timeZone: "UTC" };
        automations.appTriggers.mockResolvedValue([armed(trigger)]);
        const now = new Date("2026-10-13T09:00:30Z");
        await central.fireDueSchedules(now);
        await central.fireDueSchedules(new Date("2026-10-13T09:00:50Z"));
        const keys = automations.fireAppTrigger.mock.calls.map(
            (call) => (call as unknown as [{ firingKey: string }])[0].firingKey
        );
        expect(keys).toEqual(["schedule:2026-10-13T09:00:00.000Z", "schedule:2026-10-13T09:00:00.000Z"]);
        await central.fireDueSchedules(new Date("2026-10-13T09:01:10Z"));
        expect(automations.fireAppTrigger).toHaveBeenCalledTimes(2);
        automations.appTriggers.mockReset();
        automations.appTriggers.mockResolvedValue([]);
    });
});

describe("webhook and by hand", () => {
    it("hands a call to a moved workflow's address to its automation", async () => {
        db.crmWorkflow.findFirst.mockResolvedValueOnce({
            ...workflowRow,
            trigger: JSON.stringify({ kind: "webhook" }),
            movedToId: CENTRAL
        });
        automations.appTriggers.mockResolvedValueOnce([armed({ kind: "webhook" })]);
        expect(await workflows.runHook("secret", '{"a":1}')).toEqual({ error: null });
        expect(db.crmWorkflowRun.create).not.toHaveBeenCalled();
        expect(automations.fireAppTrigger).toHaveBeenCalledWith(
            expect.objectContaining({
                cause: expect.objectContaining({ crm: expect.objectContaining({ body: { a: 1 } }) })
            })
        );
    });

    it("offers and runs the manual automations of the shelf", async () => {
        automations.appTriggers.mockResolvedValue([armed({ kind: "manual" })]);
        expect(await central.manualAutomations(actor, "companies")).toEqual([
            { id: CENTRAL, name: "New company" }
        ]);
        expect(await central.manualAutomations(actor, "people")).toEqual([]);
        expect(await central.runManualAutomation(actor, "companies", RECORD, CENTRAL)).toBe(true);
        expect(await central.runManualAutomation(actor, "people", RECORD, CENTRAL)).toBeNull();
        expect(automations.fireAppTrigger).toHaveBeenCalledTimes(1);
        automations.appTriggers.mockReset();
        automations.appTriggers.mockResolvedValue([]);
    });
});

describe("node types", () => {
    it("brings a trigger, a check, every step and a wait, each checked by its own schema", () => {
        const types = central.crmAutomationNodes().map((node) => node.type);
        expect(types).toContain(TRIGGER_NODE_TYPE);
        expect(types).toContain("crm.condition.match");
        expect(types).toContain("crm.action.waitFor");
        expect(types).toContain("crm.action.forEach");
        expect(new Set(types).size).toBe(types.length);
    });
});

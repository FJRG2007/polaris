import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADDRESS = "0190b6a2-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
    user: { id: "runner" } as { id: string } | null,
    allowed: true,
    editable: true,
    address: { id: "", automationId: "target", nodeId: "alert", name: "Ops" } as Record<string, string> | null,
    fired: [] as Array<{ alert: Record<string, unknown>; source: string; depth: number }>,
    fireOk: true,
    notified: [] as Array<Record<string, unknown>>,
    recipients: ["runner"] as string[]
}));

vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: async () => state.user }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => state.allowed }));
vi.mock("@/lib/automations/service", () => ({
    load: async () => {
        if (!state.editable) throw new Error("forbidden");
        return {};
    }
}));
vi.mock("@/lib/alerts/addresses", () => ({
    addressById: async () => state.address,
    fireAlert: async (_address: unknown, alert: Record<string, unknown>, source: string, depth: number) => {
        state.fired.push({ alert, source, depth });
        return state.fireOk ? { ok: true, runId: "run-2", priority: 4 } : { ok: false, reason: "off" };
    },
    alertRecipients: async () => state.recipients,
    levelOf: (priority: number) => (priority === 5 ? "danger" : priority === 4 ? "warning" : "info")
}));
vi.mock("@polaris/db", () => ({
    prisma: { automation: { findUnique: async () => ({ name: "Disk monitor" }) } }
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: Record<string, unknown>) => {
        state.notified.push(input);
        return { inapp: "sent" };
    }
}));

const { alertNode, alertNotifyNode } = await import("@/lib/automations/nodes/alert-node");

const io = () => ({
    actor: { id: "runner", isAdmin: false },
    automationId: "a",
    runId: "r",
    depth: 0,
    shelf: { orgId: null },
    recordInput: vi.fn()
});
const context = { trigger: { count: 7, title: "Disk almost full", message: "5% left", priority: 5 }, steps: {} };
const config = core.CORE_NODE_CONFIGS["core.alert"].parse({
    topicId: ADDRESS,
    title: "Queue backed up",
    body: "{{trigger.count}} jobs waiting",
    priority: 4,
    tags: "queue,ops",
    click: "https://example.com/queue",
    dedupKey: "queue"
});
const run = (value = config) => alertNode.run(value, context as never, io() as never);

beforeEach(() => {
    state.user = { id: "runner" };
    state.allowed = true;
    state.editable = true;
    state.address = { id: ADDRESS, automationId: "target", nodeId: "alert", name: "Ops" };
    state.fired = [];
    state.fireOk = true;
    state.notified = [];
    state.recipients = ["runner"];
});

describe("send an alert to an automation", () => {
    it("posts to the address as an automation, one level deeper", async () => {
        const result = await run();
        expect(result).toEqual({ output: { started: true } });
        expect(state.fired[0]!.source).toBe("automation");
        expect(state.fired[0]!.depth).toBe(1);
        expect(state.fired[0]!.alert).toMatchObject({
            title: "Queue backed up",
            message: "7 jobs waiting",
            priority: 4,
            tags: ["queue", "ops"],
            click: "https://example.com/queue",
            dedupKey: "queue"
        });
    });

    it("refuses when the run-as account lost the permission or the automation", async () => {
        state.allowed = false;
        await expect(run()).rejects.toMatchObject({ code: "alertForbidden" });
        state.allowed = true;
        state.editable = false;
        await expect(run()).rejects.toMatchObject({ code: "alertTopicGone" });
        state.editable = true;
        state.address = null;
        await expect(run()).rejects.toMatchObject({ code: "alertTopicGone" });
        state.user = null;
        await expect(run()).rejects.toMatchObject({ code: "runAsGone" });
        expect(state.fired).toHaveLength(0);
    });

    it("fails when the automation behind the address is off", async () => {
        state.fireOk = false;
        await expect(run()).rejects.toMatchObject({ code: "alertTopicOff" });
    });

    it("has a config that refuses a missing address and an empty message", () => {
        const schema = core.CORE_NODE_CONFIGS["core.alert"];
        expect(schema.safeParse({ topicId: "", body: "x" }).success).toBe(false);
        expect(schema.safeParse({ topicId: ADDRESS, body: "" }).success).toBe(false);
        expect(schema.safeParse({ topicId: ADDRESS, body: "x", priority: 7 }).success).toBe(false);
    });
});

describe("notify about the alert", () => {
    const notifyConfig = core.CORE_NODE_CONFIGS["core.alertNotify"].parse({});
    const notifyRun = (value = notifyConfig) => alertNotifyNode.run(value, context as never, io() as never);

    it("notifies each recipient with the alert's severity and opens the run", async () => {
        state.recipients = ["runner", "second"];
        const result = await notifyRun();
        expect(result).toEqual({ output: { recipients: 2, priority: 5 } });
        expect(state.notified).toHaveLength(2);
        expect(state.notified[0]).toMatchObject({
            userId: "runner",
            event: core.alertEventId(5),
            title: "Disk almost full",
            body: "5% left",
            href: "/automations/runs/r",
            level: "danger",
            push: { requireInteraction: true }
        });
    });

    it("keeps a severity under its push floor on the bell", async () => {
        const quiet = { ...notifyConfig, priority: "2", pushFrom: 3 };
        await notifyRun(quiet);
        expect(state.notified[0]!.push).toBeUndefined();
    });

    it("titles an untitled alert with the automation's name", async () => {
        await notifyRun({ ...notifyConfig, title: "" });
        expect(state.notified[0]!.title).toBe("Disk monitor");
    });
});

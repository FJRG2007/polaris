import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    user: { id: "runner" } as { id: string } | null,
    allowed: true,
    manages: true,
    delivered: [] as Array<{ alert: Record<string, unknown>; source: string }>
}));

vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: async () => state.user }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => state.allowed }));
vi.mock("@/lib/alerts/topics", () => ({
    managedTopic: async () => {
        if (!state.manages) throw new Error("forbidden");
        return { id: "topic-1" };
    },
    deliverAlert: async (_topic: unknown, alert: Record<string, unknown>, source: string) => {
        state.delivered.push({ alert, source });
        return { id: "delivery-9", recipients: 3, priority: 4 };
    }
}));

const { alertNode } = await import("@/lib/automations/nodes/alert-node");

const io = () => ({ actor: { id: "runner", isAdmin: false }, automationId: "a", runId: "r", recordInput: vi.fn() });
const config = core.CORE_NODE_CONFIGS["core.alert"].parse({
    topicId: "0190b6a2-0000-7000-8000-000000000001",
    title: "Queue backed up",
    body: "{{trigger.count}} jobs waiting",
    priority: 4,
    tags: "queue,ops",
    click: "https://example.com/queue",
    dedupKey: "queue"
});
const run = (value = config) => alertNode.run(value, { trigger: {}, steps: {} } as never, io() as never);

beforeEach(() => {
    state.user = { id: "runner" };
    state.allowed = true;
    state.manages = true;
    state.delivered = [];
});

describe("send an alert to a topic", () => {
    it("delivers through the topic as an automation's alert", async () => {
        const result = await run();
        expect(result).toEqual({ output: { deliveryId: "delivery-9", recipients: 3 } });
        expect(state.delivered[0]!.source).toBe("automation");
        expect(state.delivered[0]!.alert).toMatchObject({
            title: "Queue backed up",
            priority: 4,
            tags: ["queue", "ops"],
            click: "https://example.com/queue",
            dedupKey: "queue"
        });
    });

    it("refuses when the run-as account lost the permission or the topic", async () => {
        state.allowed = false;
        await expect(run()).rejects.toMatchObject({ code: "alertForbidden" });
        state.allowed = true;
        state.manages = false;
        await expect(run()).rejects.toMatchObject({ code: "alertTopicGone" });
        state.user = null;
        await expect(run()).rejects.toMatchObject({ code: "runAsGone" });
        expect(state.delivered).toHaveLength(0);
    });

    it("has a config that refuses a missing topic and an empty message", () => {
        const schema = core.CORE_NODE_CONFIGS["core.alert"];
        expect(schema.safeParse({ topicId: "", body: "x" }).success).toBe(false);
        expect(schema.safeParse({ topicId: "0190b6a2-0000-7000-8000-000000000001", body: "" }).success).toBe(false);
        expect(schema.safeParse({ topicId: "0190b6a2-0000-7000-8000-000000000001", body: "x", priority: 7 }).success).toBe(false);
    });
});

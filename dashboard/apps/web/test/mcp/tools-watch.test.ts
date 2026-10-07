/**
 * Watch's monitoring alarms over MCP.
 *
 * The service is the Watch screens' own; what is pinned here is the boundary:
 * a target is found by the name a person calls it, an alarm is checked against
 * what that kind of target can watch before anything is written, a key held to
 * one deploy project is refused, and an alarm named twice is never guessed at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    listAlarms: vi.fn(),
    listAlarmTargets: vi.fn(),
    listRecentAlarmEvents: vi.fn(),
    createAlarm: vi.fn(),
    setAlarmEnabled: vi.fn(),
    deleteAlarm: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
// The rest of the catalogue loads with these tools; its operations are not under test here.
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/tasks/access", () => ({}));
vi.mock("@/lib/tasks/task-service", () => ({}));
vi.mock("@/lib/tasks/task-detail-service", () => ({}));
vi.mock("@/lib/watch-service", () => mocks);

const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };
const APP = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";
const DOMAIN = "33333333-3333-4333-8333-333333333333";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(
    name: string,
    args: Record<string, unknown>,
    extra: { scopes?: string[]; projectId?: string } = {}
) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        {
            userId: "user-1",
            isAdmin: false,
            scopes: (extra.scopes ?? ["deploy.read", "deploy.manage"]) as never,
            ...(extra.projectId ? { projectId: extra.projectId } : {})
        },
        SERVER
    );
    return (reply?.result ?? reply?.error) as ToolResult & { message?: string };
}

function alarm(id: string, name: string) {
    return {
        id,
        name,
        targetType: "host",
        targetId: HOST,
        metric: "cpu",
        operator: "gt",
        threshold: 90,
        forPeriods: 2,
        enabled: true,
        state: "ok",
        lastEvaluatedAt: null
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAlarmTargets.mockResolvedValue({
        apps: [{ id: APP, name: "Blog" }],
        hosts: [{ id: HOST, name: "Home server", measuresDisk: true }],
        domains: [{ id: DOMAIN, hostname: "blog.example.test" }]
    });
    mocks.listAlarms.mockResolvedValue([alarm("a1", "Hot CPU"), alarm("a2", "Disk full")]);
    mocks.listRecentAlarmEvents.mockResolvedValue([]);
    mocks.createAlarm.mockResolvedValue("new-alarm");
});

describe("the watch tools", () => {
    it("create an alarm on a target found by its name", async () => {
        const result = await call("watch_alarm_create", {
            name: "Server hot",
            target: "home SERVER",
            metric: "cpu",
            threshold: 85
        });
        expect(result.isError).toBeUndefined();
        expect(mocks.createAlarm).toHaveBeenCalledWith("user-1", {
            name: "Server hot",
            targetType: "host",
            targetId: HOST,
            metric: "cpu",
            operator: "gt",
            threshold: 85,
            forPeriods: 2
        });
    });

    it("refuse a metric the target cannot watch, naming the ones it can", async () => {
        const result = await call("watch_alarm_create", {
            name: "Blog CPU",
            target: "blog.example.test",
            metric: "cpu",
            threshold: 50
        });
        expect(result.content[0]?.text).toContain("can watch: http");
        expect(mocks.createAlarm).not.toHaveBeenCalled();
    });

    it("refuse a threshold metric without its threshold", async () => {
        const result = await call("watch_alarm_create", {
            name: "Blog memory",
            target: "Blog",
            metric: "memory"
        });
        expect(result.content[0]?.text).toContain("threshold");
        expect(mocks.createAlarm).not.toHaveBeenCalled();
    });

    it("turn an alarm off or delete it by its name", async () => {
        await call("watch_alarm_change", { alarm: "hot cpu", action: "disable" });
        expect(mocks.setAlarmEnabled).toHaveBeenCalledWith("user-1", "a1", false);
        await call("watch_alarm_change", { alarm: "a2", action: "delete" });
        expect(mocks.deleteAlarm).toHaveBeenCalledWith("user-1", "a2");
    });

    it("never guess between two alarms of one name", async () => {
        mocks.listAlarms.mockResolvedValue([alarm("a1", "CPU"), alarm("a2", "CPU")]);
        const result = await call("watch_alarm_change", { alarm: "CPU", action: "delete" });
        expect(result.content[0]?.text).toContain("More than one alarm");
        expect(mocks.deleteAlarm).not.toHaveBeenCalled();
    });

    it("refuse a key held to one deploy project, and changes to a reading key", async () => {
        const held = await call("watch_alarms", {}, { projectId: "project-1" });
        expect(held.content[0]?.text).toContain("held to one deploy project");
        const reading = await call(
            "watch_alarm_change",
            { alarm: "a1", action: "delete" },
            { scopes: ["deploy.read"] }
        );
        expect(reading.content[0]?.text).toContain("deploy.manage");
        expect(mocks.deleteAlarm).not.toHaveBeenCalled();
    });

    it("list alarms with their target's name and what they watch for", async () => {
        const result = await call("watch_alarms", {}, { scopes: ["deploy.read"] });
        expect(result.structuredContent.alarms[0]).toMatchObject({
            name: "Hot CPU",
            target: "Home server",
            condition: "cpu over 90 % for 2 checks"
        });
    });
});

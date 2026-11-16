import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/safe-fetch", () => ({ follow: vi.fn() }));

import * as shared from "@/lib/polar/custom-tools/shared";
import { dispatchPluginEvent, type PluginPorts } from "@/lib/polar/custom-tools/plugins";

function tool(permission: shared.ToolPermission, withEvent = false) {
    return {
        id: "t1",
        ...shared.customToolSchema.parse({
            name: "notify",
            description: "Notify",
            input: withEvent ? { properties: { event: { type: "string" } } } : {},
            script: "echo",
            permission
        })
    };
}

function ports(overrides: Partial<PluginPorts>): PluginPorts {
    return {
        plugins: async () => [],
        tools: async () => [],
        post: vi.fn(async () => undefined),
        runTool: vi.fn(async () => ({ ok: true, text: "" })),
        sandbox: vi.fn(async () => ({ sessionId: "s1", repository: null })),
        ...overrides
    };
}

describe("dispatchPluginEvent", () => {
    it("posts the event to a webhook that hears it, and skips the ones that do not", async () => {
        const post = vi.fn(async () => undefined);
        const ran = await dispatchPluginEvent(
            "u1",
            "tool.after",
            { sessionId: "s1", tool: "Bash" },
            ports({
                post,
                plugins: async () => [
                    { id: "p1", name: "Hook", enabled: true, events: ["tool.after"], action: { kind: "webhook", url: "https://example.test/h" } },
                    { id: "p2", name: "Other", enabled: true, events: ["session.end"], action: { kind: "webhook", url: "https://example.test/o" } }
                ]
            })
        );
        expect(ran).toBe(1);
        expect(post).toHaveBeenCalledTimes(1);
        const [url, body] = post.mock.calls[0] as unknown as [string, string];
        expect(url).toBe("https://example.test/h");
        expect(JSON.parse(body)).toMatchObject({ event: "tool.after", sessionId: "s1", tool: "Bash" });
    });

    it("runs a tool only when it is set to allow, with the event as its input", async () => {
        const runTool = vi.fn(async () => ({ ok: true, text: "" }));
        const plugins = async () => [
            { id: "p1", name: "Run", enabled: true, events: ["session.end" as const], action: { kind: "tool" as const, tool: "notify" } }
        ];
        expect(await dispatchPluginEvent("u1", "session.end", {}, ports({ plugins, runTool, tools: async () => [tool("ask")] }))).toBe(0);
        expect(await dispatchPluginEvent("u1", "session.end", {}, ports({ plugins, runTool, tools: async () => [tool("deny")] }))).toBe(0);
        expect(runTool).not.toHaveBeenCalled();
        expect(await dispatchPluginEvent("u1", "session.end", {}, ports({ plugins, runTool, tools: async () => [tool("allow", true)] }))).toBe(1);
        const input = (runTool.mock.calls[0] as unknown as [unknown, unknown, { event: string }])[2];
        expect(JSON.parse(input.event)).toMatchObject({ event: "session.end" });
    });

    it("never throws when a webhook fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const post = vi.fn(async () => {
            throw new Error("refused");
        });
        const plugins = async () => [
            { id: "p1", name: "Hook", enabled: true, events: ["message.sent" as const], action: { kind: "webhook" as const, url: "https://example.test/h" } }
        ];
        await expect(dispatchPluginEvent("u1", "message.sent", {}, ports({ plugins, post }))).resolves.toBe(0);
    });
});

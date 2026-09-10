/**
 * The deploy tools, called the way an MCP client calls them.
 *
 * The surface underneath is tested on its own; what is pinned here is the
 * boundary with the protocol: a key without the scope is refused before the
 * arguments are read, a refusal from the surface reaches the model as written,
 * anything else is logged and replaced, and no tool hands out a secret value.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const deploy = vi.fn();
const listVariables = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({
    deploy: (...args: unknown[]) => deploy(...args),
    listVariables: (...args: unknown[]) => listVariables(...args),
    listProjects: vi.fn(),
    getService: vi.fn(),
    listDeployments: vi.fn(),
    deploymentLog: vi.fn(),
    runtimeLog: vi.fn(),
    setVariable: vi.fn(),
    listDomains: vi.fn(),
    addDomain: vi.fn(),
    power: vi.fn(),
    rollback: vi.fn()
}));

const { DEPLOY_TOOLS } = await import("@/lib/mcp/tools/deploy");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");
const { DeployApiRefusal } = await import("@/lib/deploy/api/refusal");

const SERVER = { name: "polaris", version: "1", instructions: "" };

function call(
    name: string,
    args: Record<string, unknown>,
    scopes: string[],
    projectId: string | null = null
) {
    return handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, keyId: "key-1", projectId },
        SERVER
    );
}

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };

beforeEach(() => {
    vi.clearAllMocks();
});

describe("the deploy tools", () => {
    it("are all in the catalogue a client lists", () => {
        const names = MCP_TOOLS.map((tool) => tool.name);
        for (const tool of DEPLOY_TOOLS) expect(names).toContain(tool.name);
    });

    it("ask for deploy.manage to change anything and deploy.read to look", () => {
        for (const tool of DEPLOY_TOOLS) {
            expect(tool.scope, tool.name).toBe(tool.readOnly ? "deploy.read" : "deploy.manage");
        }
    });

    it("offer no way to read a secret's value", () => {
        expect(DEPLOY_TOOLS.some((tool) => /reveal|secret_value|value/.test(tool.name))).toBe(
            false
        );
    });

    it("refuse a key without the scope before reading its arguments", async () => {
        const answer = await call("deploy_start", {}, ["deploy.read"]);
        const result = answer?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("deploy.manage");
        expect(deploy).not.toHaveBeenCalled();
    });

    it("hand the surface a caller that carries the key and its project", async () => {
        deploy.mockResolvedValue({ deploymentId: "dep-1" });
        const answer = await call(
            "deploy_start",
            { service: "shop/api" },
            ["deploy.manage"],
            "project-1"
        );
        expect(deploy).toHaveBeenCalledWith(
            {
                userId: "user-1",
                scopes: ["deploy.manage"],
                keyId: "key-1",
                projectId: "project-1",
                via: "mcp"
            },
            "shop/api"
        );
        expect((answer?.result as ToolResult).structuredContent).toEqual({ deploymentId: "dep-1" });
    });

    it("pass a refusal to the model as written", async () => {
        deploy.mockRejectedValue(
            new DeployApiRefusal(409, "shop/api names more than one service.")
        );
        const result = (await call("deploy_start", { service: "shop/api" }, ["deploy.manage"]))
            ?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe("shop/api names more than one service.");
    });

    it("keep anything from beneath the service layer out of the answer", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        deploy.mockRejectedValue(
            new Error("hostd docker proxy failed (502): /var/run/docker.sock")
        );
        const result = (await call("deploy_start", { service: "shop/api" }, ["deploy.manage"]))
            ?.result as ToolResult;
        quiet.mockRestore();
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).not.toContain("docker.sock");
    });

    it("list variables with every secret withheld", async () => {
        listVariables.mockResolvedValue([
            { id: "v1", key: "PUBLIC_URL", isSecret: false, value: "https://shop.test" },
            { id: "v2", key: "API_TOKEN", isSecret: true, value: null }
        ]);
        const result = (await call("deploy_variables", { service: "shop/api" }, ["deploy.read"]))
            ?.result as ToolResult;
        expect(result.content[0]?.text).toBe("PUBLIC_URL=https://shop.test\nAPI_TOKEN=(secret)");
    });

    it("refuse a service reference of the wrong shape as bad arguments", async () => {
        const answer = await call("deploy_start", { service: "a/b/c/d" }, ["deploy.manage"]);
        expect(answer?.error?.code).toBe(-32602);
        expect(deploy).not.toHaveBeenCalled();
    });
});

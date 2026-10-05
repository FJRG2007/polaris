/**
 * The tools installable apps offer over MCP, as the catalogue exposes them.
 *
 * What is pinned is the promise to whoever connects an assistant: an app that
 * is not installed has no tools on the list, a call to one is a call to a tool
 * that does not exist, and its scopes are offered to nobody. Installed, its
 * tools are listed and called like core's - refused without their scope - and
 * a tool that breaks the catalogue's rules, or an app whose hook fails, never
 * takes the rest of the list down with it.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    installed: new Set<string>(),
    extensions: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/app-extensions/installed", () => ({
    installedExtensions: () => state.extensions
}));
vi.mock("@/lib/apps/install-presence", () => ({
    isAppInstalled: async (id: string) => state.installed.has(id)
}));

const { mcpTools, scopesOf } = await import("@/lib/mcp/catalog");
const { mcpScopes } = await import("@/lib/mcp/oauth/scopes");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { defineMcpTool, handleMcpMessage, McpRefusal } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };

const ran = vi.fn();

const lookTool = defineMcpTool({
    name: "garden_beds",
    title: "Beds",
    description: "Lists the garden's beds and what is planted in each.",
    input: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
    scope: "places.read",
    readOnly: true,
    async run(input, caller) {
        ran(input, caller.userId);
        return { text: "two beds", structured: { beds: 2 } };
    }
});

const waterTool = defineMcpTool({
    name: "garden_water",
    title: "Water",
    description: "Turns the garden's sprinklers on for a few minutes.",
    input: z.object({}),
    scope: "places.control",
    readOnly: false,
    destructive: false,
    async run() {
        throw new McpRefusal("The sprinklers are not answering.");
    }
});

function extension(id: string, tools: () => Promise<readonly unknown[]>) {
    return { id, mcpTools: tools };
}

function call(name: string, scopes: string[], tools: Awaited<ReturnType<typeof mcpTools>>) {
    return handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } },
        tools,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    state.installed = new Set();
    state.extensions = [extension("garden", async () => [lookTool, waterTool])];
});

describe("an app's MCP tools", () => {
    it("are absent, with their scopes, while the app is not installed", async () => {
        const tools = await mcpTools();
        expect(tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
        expect(await mcpScopes()).not.toContain("places.read");
        const reply = await call("garden_beds", ["places.read"], tools);
        expect(reply?.error?.message).toBe("There is no tool called garden_beds");
        expect(ran).not.toHaveBeenCalled();
    });

    it("are listed after core's, and their scopes offered, once it is installed", async () => {
        state.installed.add("garden");
        const tools = await mcpTools();
        const names = tools.map((tool) => tool.name);
        expect(names.slice(-2)).toEqual(["garden_beds", "garden_water"]);
        expect(names.slice(0, MCP_TOOLS.length)).toEqual(MCP_TOOLS.map((tool) => tool.name));
        expect(await mcpScopes()).toEqual(
            expect.arrayContaining(["places.read", "places.control"])
        );
        const listed = await handleMcpMessage(
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            tools,
            { userId: "user-1", isAdmin: false, scopes: [] },
            SERVER
        );
        const described = (listed?.result as { tools: { name: string; annotations: any }[] }).tools;
        expect(described.find((tool) => tool.name === "garden_water")?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false
        });
    });

    it("are refused without their scope, before their arguments are read", async () => {
        state.installed.add("garden");
        const tools = await mcpTools();
        const refused = (await call("garden_beds", ["places.control", "tasks.read"], tools))
            ?.result as { isError: boolean; content: { text: string }[] };
        expect(refused.isError).toBe(true);
        expect(refused.content[0]?.text).toContain("places.read");
        expect(ran).not.toHaveBeenCalled();

        const allowed = (await call("garden_beds", ["places.read"], tools))?.result as {
            structuredContent: unknown;
        };
        expect(allowed.structuredContent).toEqual({ beds: 2 });
        expect(ran).toHaveBeenCalledWith({ limit: 5 }, "user-1");
    });

    it("hand an app's refusal to the model as written", async () => {
        state.installed.add("garden");
        const result = (await call("garden_water", ["places.control"], await mcpTools()))
            ?.result as { isError: boolean; content: { text: string }[] };
        expect(result).toMatchObject({ isError: true });
        expect(result.content[0]?.text).toBe("The sprinklers are not answering.");
    });

    it("leave out a tool that breaks the catalogue's rules, and keep the rest", async () => {
        state.installed.add("garden");
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        state.extensions = [
            extension("garden", async () => [
                lookTool,
                { ...lookTool, name: "polaris_whoami" },
                { ...lookTool, name: "garden_beds" },
                { ...lookTool, name: "Garden Beds" },
                { ...lookTool, name: "garden_open", scope: null },
                { ...lookTool, name: "garden_secret", scope: "garden.everything" },
                { ...lookTool, name: "garden_empty", scope: [] }
            ])
        ];
        const names = (await mcpTools()).map((tool) => tool.name);
        expect(names.filter((name) => name.startsWith("garden") || name === "Garden Beds")).toEqual(
            ["garden_beds"]
        );
        expect(names.filter((name) => name === "polaris_whoami")).toHaveLength(1);
        expect(errors).toHaveBeenCalledTimes(6);
        errors.mockRestore();
    });

    it("never let one app's failure take another's tools or core's away", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        state.installed = new Set(["garden", "broken"]);
        state.extensions = [
            extension("broken", async () => {
                throw new Error("bundle missing");
            }),
            extension("garden", async () => [lookTool])
        ];
        const names = (await mcpTools()).map((tool) => tool.name);
        expect(names).toContain("garden_beds");
        expect(names).toContain("polaris_whoami");
        errors.mockRestore();
    });

    it("offer no scope that is kept only for old grants", () => {
        const legacy = defineMcpTool({ ...lookTool, scope: ["calendar.read", "calendar.use"] });
        expect(scopesOf([legacy])).toEqual(["calendar.read"]);
    });
});

/**
 * The MCP handler: what an agent's client gets back for each thing it can send.
 *
 * The cases worth holding are the ones a real client will hit and a reading will
 * not catch. A notification must produce no response at all, or the client waits
 * for one that never comes. A tool refusing on permissions must come back as a
 * successful call with an error result, so the MODEL sees it and can say so -
 * reported as a protocol error it disappears into the client. And a tool that
 * throws must never leak what it threw.
 */

import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
    MCP_PROTOCOL_VERSION,
    RPC_INVALID_PARAMS,
    RPC_INVALID_REQUEST,
    RPC_METHOD_NOT_FOUND,
    handleMcpMessage,
    type McpCaller,
    type McpServerInfo,
    type McpTool
} from "@/lib/mcp/protocol";

const SERVER: McpServerInfo = { name: "polaris", version: "1", instructions: "Do the thing." };

const caller: McpCaller = { userId: "u1", isAdmin: false, scopes: ["tasks.read"] };

const echo: McpTool<{ what: string }> = {
    name: "echo",
    description: "Says it back.",
    input: z.object({ what: z.string().min(1) }),
    scope: "tasks.read",
    readOnly: true,
    async run(input) {
        return { text: input.what, structured: { what: input.what } };
    }
};

const forbidden: McpTool<Record<string, never>> = {
    name: "forbidden",
    description: "Needs a scope this caller does not hold.",
    input: z.object({}),
    scope: "system.manage",
    readOnly: false,
    async run() {
        throw new Error("should never run");
    }
};

const explodes: McpTool<Record<string, never>> = {
    name: "explodes",
    description: "Throws.",
    input: z.object({}),
    scope: null,
    readOnly: true,
    async run() {
        throw new Error("connect ECONNREFUSED 10.0.0.4:5432");
    }
};

const TOOLS = [echo, forbidden, explodes] as unknown as McpTool<never>[];

const send = (message: unknown) => handleMcpMessage(message, TOOLS, caller, SERVER);

describe("initialize", () => {
    it("answers in the version the client asked for, when it is one we speak", async () => {
        const answer = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
        expect((answer?.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
    });

    it("answers in ours when it asked for something we do not", async () => {
        const answer = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
        expect((answer?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    });

    it("advertises tools and says what the server is", async () => {
        const result = (await send({ jsonrpc: "2.0", id: 1, method: "initialize" }))?.result as Record<string, unknown>;
        expect(result.capabilities).toEqual({ tools: { listChanged: false } });
        expect(result.serverInfo).toEqual({ name: "polaris", version: "1" });
        expect(result.instructions).toBe("Do the thing.");
    });
});

describe("notifications", () => {
    it("gets no response at all, so a client is never left waiting for one", async () => {
        expect(await send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    });

    it("gets none for a method that would otherwise have answered, which is the same rule", async () => {
        expect(await send({ jsonrpc: "2.0", method: "ping" })).toBeNull();
        expect(await send({ jsonrpc: "2.0", method: "tools/list" })).toBeNull();
        expect(await send({ jsonrpc: "2.0", method: "initialize" })).toBeNull();
    });

    it("still answers a request for a method that does not exist", async () => {
        const answer = await send({ jsonrpc: "2.0", id: 7, method: "resources/list" });
        expect(answer?.error?.code).toBe(RPC_METHOD_NOT_FOUND);
    });
});

describe("tools/list", () => {
    it("describes each tool with a schema derived from its validator", async () => {
        const { tools } = (await send({ jsonrpc: "2.0", id: 1, method: "tools/list" }))?.result as {
            tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[];
        };
        expect(tools.map((tool) => tool.name)).toEqual(["echo", "forbidden", "explodes"]);
        expect(tools[0]?.inputSchema.properties.what).toEqual({ type: "string", minLength: 1 });
        expect(tools[0]?.inputSchema.required).toEqual(["what"]);
    });

    it("says which tools cannot change anything", async () => {
        const { tools } = (await send({ jsonrpc: "2.0", id: 1, method: "tools/list" }))?.result as {
            tools: { name: string; annotations: { readOnlyHint: boolean } }[];
        };
        expect(tools.find((tool) => tool.name === "forbidden")?.annotations.readOnlyHint).toBe(false);
    });
});

describe("tools/call", () => {
    it("returns the text and the structured answer together", async () => {
        const result = (
            await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { what: "hi" } } })
        )?.result as { content: { text: string }[]; structuredContent: unknown };
        expect(result.content[0]?.text).toBe("hi");
        expect(result.structuredContent).toEqual({ what: "hi" });
    });

    it("reports a missing scope to the model rather than to the client alone", async () => {
        const answer = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "forbidden" } });
        expect(answer?.error).toBeUndefined();
        const result = answer?.result as { isError: boolean; content: { text: string }[] };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("system.manage");
    });

    it("checks the scope before the arguments, so a refused caller learns nothing about the tool", async () => {
        const answer = await send({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "forbidden", arguments: { nonsense: 1 } }
        });
        expect((answer?.result as { isError: boolean }).isError).toBe(true);
    });

    it("names the argument that was wrong", async () => {
        const answer = await send({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "echo", arguments: { what: "" } }
        });
        expect(answer?.error?.code).toBe(RPC_INVALID_PARAMS);
        expect(answer?.error?.message).toContain("what");
    });

    it("refuses a tool nobody has", async () => {
        const answer = await send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } });
        expect(answer?.error?.code).toBe(RPC_INVALID_PARAMS);
    });

    it("turns a thrown error into a refusal and does not repeat what it said", async () => {
        const answer = await send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "explodes" } });
        const result = answer?.result as { isError: boolean; content: { text: string }[] };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).not.toContain("10.0.0.4");
    });
});

describe("malformed input", () => {
    it("refuses something that is not a JSON-RPC request", async () => {
        expect((await send({ hello: "there" }))?.error?.code).toBe(RPC_INVALID_REQUEST);
        expect((await send(null))?.error?.code).toBe(RPC_INVALID_REQUEST);
    });
});

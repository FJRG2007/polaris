/**
 * The automations tools Polar builds and runs automations with, called the way
 * a client calls them.
 *
 * The service is tested on its own; what is pinned here is the boundary: the
 * input is checked before anything runs, the service is asked as the caller
 * (so somebody else's automation is refused in its words), a created graph is
 * one the core schema and its problem check accept, a graph with problems is
 * never saved, every tool that changes something waits for the person's
 * approval in Polar, and the open automation is what "this" reads.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class AutomationAccessError extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    }
    return {
        AutomationAccessError,
        listAutomations: vi.fn(),
        getAutomation: vi.fn(),
        load: vi.fn(),
        createAutomation: vi.fn(),
        saveDraft: vi.fn(),
        deleteAutomation: vi.fn(),
        publishAutomation: vi.fn(),
        setEnabled: vi.fn(),
        runNow: vi.fn()
    };
});

// The catalogue reaches the auth module, which reads configuration as it is imported.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/automations/service", () => mocks);
vi.mock("@/lib/automations/node-registry", async () => {
    const real = await import("@polaris/core");
    return {
        graphProblems: async (graph: never, options: never) => real.graphProblems(graph, options)
    };
});
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => null }));
vi.mock("@/lib/app-extensions/registry", () => ({
    appAutomationNodes: async () => [],
    appMcpTools: async () => [],
    appMcpSearchProviders: async () => []
}));

const { AUTOMATION_TOOLS, editedGraph } = await import("@/lib/mcp/tools/automations");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");
const { needsApproval } = await import("@/lib/polar/tools");
const { currentViewTool } = await import("@/lib/polar/tool-relevance");

const SERVER = { name: "polaris", version: "1", instructions: "" };
const AUTOMATION = "11111111-1111-4111-8111-111111111111";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(name: string, args: Record<string, unknown>, scopes = ["automations.use"]) {
    const answer = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, keyId: "key-1" },
        SERVER
    );
    const reply = answer as unknown as { result?: ToolResult; error?: { message: string } };
    // Input the schema refuses is a protocol error, not a tool result: refused all the same.
    return reply.result ?? { isError: true, content: [{ text: reply.error?.message ?? "" }] };
}

const GOOD = {
    name: "Site down notice",
    nodes: [
        { id: "start", type: "core.manual", config: {} },
        { id: "tell", type: "core.notify", config: { title: "It is down" } }
    ],
    edges: [{ from: "start", port: "next", to: "tell" }]
};

function draftOf(): core.AutomationGraph {
    return {
        ...core.emptyGraph(),
        nodes: [
            {
                id: "start",
                type: "core.manual",
                typeVersion: 1,
                config: {},
                position: { x: 0, y: 0 }
            },
            {
                id: "tell",
                type: "core.notify",
                typeVersion: 1,
                config: { title: "Hi" },
                position: { x: 300, y: 0 }
            }
        ],
        edges: [{ from: { node: "start", port: "next" }, to: { node: "tell" } }]
    };
}

beforeEach(() => {
    for (const mock of Object.values(mocks))
        if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    mocks.createAutomation.mockResolvedValue(AUTOMATION);
    mocks.saveDraft.mockResolvedValue([]);
});

describe("automations tools", () => {
    it("are on the catalogue under automations.use, and every one that writes waits for approval", () => {
        const names = AUTOMATION_TOOLS.map((tool) => tool.name);
        for (const name of names) expect(MCP_TOOLS.map((tool) => tool.name)).toContain(name);
        const writes = AUTOMATION_TOOLS.filter((tool) => needsApproval(tool)).map(
            (tool) => tool.name
        );
        expect(writes.sort()).toEqual(
            [
                "automations_create",
                "automations_publish",
                "automations_run",
                "automations_set_enabled",
                "automations_update"
            ].sort()
        );
        for (const tool of AUTOMATION_TOOLS) expect(tool.scope).toBe("automations.use");
    });

    it("refuses a caller without the scope before anything is read", async () => {
        const result = await call("automations_list", {}, []);
        expect(result.isError).toBe(true);
        expect(mocks.listAutomations).not.toHaveBeenCalled();
    });

    it("refuses input the tool does not take", async () => {
        const result = await call("automations_get", { automation: "not-an-id" });
        expect(result.isError).toBe(true);
        expect(mocks.getAutomation).not.toHaveBeenCalled();
        const bad = await call("automations_create", {
            ...GOOD,
            nodes: [{ id: "a b", type: "core.manual" }]
        });
        expect(bad.isError).toBe(true);
        expect(mocks.createAutomation).not.toHaveBeenCalled();
    });

    it("refuses somebody else's automation in the service's words, asked as the caller", async () => {
        mocks.getAutomation.mockRejectedValue(new mocks.AutomationAccessError("notFound"));
        const result = await call("automations_get", { automation: AUTOMATION });
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toMatch(/not there/i);
        expect(mocks.getAutomation).toHaveBeenCalledWith(
            { id: "user-1", isAdmin: false },
            AUTOMATION
        );
    });

    it("never changes one the caller may only look at", async () => {
        mocks.getAutomation.mockResolvedValue({
            id: AUTOMATION,
            name: "Theirs",
            canEdit: false,
            draft: draftOf()
        });
        const result = await call("automations_update", {
            automation: AUTOMATION,
            removeNodes: ["tell"]
        });
        expect(result.isError).toBe(true);
        expect(mocks.saveDraft).not.toHaveBeenCalled();
    });

    it("creates a draft whose graph the core schema and its problem check accept", async () => {
        const result = await call("automations_create", GOOD);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent.automationId).toBe(AUTOMATION);
        expect(mocks.createAutomation.mock.calls[0]![1]).toMatchObject({
            name: "Site down notice",
            orgId: null
        });
        const saved = mocks.saveDraft.mock.calls[0]![2] as core.AutomationGraph;
        const parsed = core.automationGraphSchema.parse(saved);
        expect(core.graphProblems(parsed, { forPublish: true })).toEqual([]);
        expect(saved.nodes.every((node) => node.position)).toBe(true);
    });

    it("saves nothing for a graph the editor would refuse, and says what to fix", async () => {
        const noTrigger = await call("automations_create", {
            ...GOOD,
            nodes: [GOOD.nodes[1]],
            edges: []
        });
        expect(noTrigger.isError).toBe(true);
        expect(noTrigger.content[0]!.text).toMatch(/trigger/i);
        const badConfig = await call("automations_create", {
            ...GOOD,
            nodes: [GOOD.nodes[0], { id: "tell", type: "core.notify", config: {} }]
        });
        expect(badConfig.isError).toBe(true);
        expect(badConfig.content[0]!.text).toContain("node tell");
        expect(mocks.createAutomation).not.toHaveBeenCalled();
        expect(mocks.saveDraft).not.toHaveBeenCalled();
    });

    it("adds steps on a connection and saves the draft", async () => {
        mocks.getAutomation.mockResolvedValue({
            id: AUTOMATION,
            name: "Mine",
            canEdit: true,
            published: false,
            draft: draftOf()
        });
        const result = await call("automations_update", {
            automation: AUTOMATION,
            nodes: [{ id: "pause", type: "core.notify", config: { title: "First" } }],
            removeEdges: [{ from: "start", port: "next", to: "tell" }],
            edges: [
                { from: "start", port: "next", to: "pause" },
                { from: "pause", port: "next", to: "tell" }
            ]
        });
        const saved = mocks.saveDraft.mock.calls[0]?.[2] as core.AutomationGraph | undefined;
        expect(result.isError).toBeFalsy();
        expect(core.graphProblems(saved!)).toEqual([]);
        expect(saved!.edges.map(core.edgeKey).sort()).toEqual([
            "pause:next>tell",
            "start:next>pause"
        ]);
        expect(saved!.nodes.find((node) => node.id === "pause")?.position).toBeTruthy();
    });

    it("edits a draft without touching the nodes it was not asked about", () => {
        const { graph, wrote } = editedGraph(draftOf(), {
            nodes: [{ id: "tell", type: "core.notify", config: { title: "Changed" } }],
            edges: [],
            removeNodes: [],
            removeEdges: []
        });
        expect([...wrote]).toEqual(["tell"]);
        expect(graph.nodes[0]).toEqual(draftOf().nodes[0]);
        expect(graph.nodes[1]).toMatchObject({
            config: { title: "Changed" },
            position: { x: 300, y: 0 }
        });
        const removed = editedGraph(draftOf(), {
            nodes: [],
            edges: [],
            removeNodes: ["tell"],
            removeEdges: []
        });
        expect(removed.graph.nodes).toHaveLength(1);
        expect(removed.graph.edges).toEqual([]);
    });

    it("reads the automation open on the screen for 'this'", async () => {
        const reader = vi.fn(async () => ({ ok: true, text: "Mine (id) is on." }));
        const view = currentViewTool(
            {
                route: `/automations/${AUTOMATION}`,
                title: "Mine",
                record: { kind: "automation", id: AUTOMATION }
            } as never,
            reader
        );
        const answer = (await (view.read_current_view as any).execute({}, {})) as { text: string };
        expect(reader).toHaveBeenCalledWith("automations_get", { automation: AUTOMATION });
        expect(answer.text).toContain("Mine (id) is on.");
    });
});

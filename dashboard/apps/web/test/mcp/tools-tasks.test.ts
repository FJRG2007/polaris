/**
 * `tasks_list`, searched the way an assistant searches.
 *
 * The task layer's reach is tested on its own; what is pinned here is what a
 * query does to the answer: a word finds a task in another language or
 * misspelt, the best match comes first, a query that matches nothing still
 * lists what the key can reach - said as such - and a space asked for by a name
 * it does not have is refused with the names it does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    visibleScope: vi.fn(),
    scopeSpaceIds: vi.fn(),
    listTasks: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    listFindFirst: vi.fn(),
    listFindMany: vi.fn(),
    requireList: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        taskSpace: { findFirst: mocks.findFirst, findMany: mocks.findMany },
        taskList: { findFirst: mocks.listFindFirst, findMany: mocks.listFindMany }
    }
}));
// The rest of the catalogue loads with these tools; its operations are not under test here.
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/tasks/access", () => ({
    visibleScope: mocks.visibleScope,
    scopeSpaceIds: mocks.scopeSpaceIds,
    scopeTaskWhere: () => ({}),
    requireList: mocks.requireList
}));
vi.mock("@/lib/tasks/task-service", () => ({ listTasks: mocks.listTasks }));
vi.mock("@/lib/tasks/task-detail-service", () => ({ addComment: vi.fn() }));

const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(args: Record<string, unknown>, name = "tasks_list") {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        {
            userId: "user-1",
            isAdmin: false,
            scopes: ["tasks.read", "tasks.manage"],
            keyId: "key-1"
        },
        SERVER
    );
    return reply?.result as ToolResult;
}

function task(number: number, name: string) {
    return {
        id: `task-${number}`,
        reference: `ENG-${number}`,
        name,
        description: "",
        spaceId: "space-1",
        spaceName: "Engineering",
        listId: "list-1",
        listName: "Backlog",
        folderName: null,
        parentId: null,
        statusId: null,
        statusName: "Open",
        statusColor: "#888",
        statusType: "open",
        priority: "none",
        assignees: [],
        tags: [],
        createdById: null,
        startDate: null,
        dueDate: null,
        timed: false,
        subtaskCount: 0,
        commentCount: 0
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.visibleScope.mockResolvedValue({ listIds: null });
    mocks.scopeSpaceIds.mockReturnValue(["space-1"]);
    mocks.listTasks.mockResolvedValue([
        task(1, "Arreglar la factura de octubre"),
        task(2, "Renovar el certificado"),
        task(3, "Preparar la reunión de equipo")
    ]);
});

describe("tasks_list", () => {
    it("finds a task by a word in another language, best match first", async () => {
        const result = await call({ query: "meeting" });
        expect(result.structuredContent.tasks[0]).toMatchObject({ reference: "ENG-3" });
        expect(result.structuredContent.matched).toBe(true);
    });

    it("forgives a typo, and finds by reference", async () => {
        expect((await call({ query: "certifcado" })).structuredContent.tasks[0]).toMatchObject({
            reference: "ENG-2"
        });
        expect((await call({ query: "ENG-1" })).structuredContent.tasks[0]).toMatchObject({
            reference: "ENG-1"
        });
    });

    it("lists what the key reaches, said as such, when nothing matches", async () => {
        const result = await call({ query: "zebra" });
        expect(result.structuredContent.tasks).toHaveLength(3);
        expect(result.structuredContent.matched).toBe(false);
        expect(result.content[0]?.text).toContain('No match for "zebra"; these are all 3 tasks.');
    });

    it("refuses a space it does not have, naming the ones it does", async () => {
        mocks.findFirst.mockResolvedValue(null);
        mocks.findMany.mockResolvedValue([{ name: "Engineering" }, { name: "Diseño" }]);
        const result = await call({ space: "Marketing" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe(
            'No space called "Marketing" that this key can reach. It can reach: Engineering, Diseño.'
        );
        expect(mocks.listTasks).not.toHaveBeenCalled();
    });

    it("finds a space whatever the accents", async () => {
        mocks.findFirst.mockResolvedValue(null);
        mocks.findMany.mockResolvedValue([
            { id: "space-1", name: "Engineering" },
            { id: "space-2", name: "Diseño" }
        ]);
        const result = await call({ space: "diseno" });
        expect(result.isError).toBeUndefined();
        expect(mocks.listTasks).toHaveBeenCalledWith(
            expect.objectContaining({ spaceIds: ["space-2"] }),
            expect.anything()
        );
    });

    it("creates in a list named without its accents, and names the lists when there is none", async () => {
        mocks.listFindFirst.mockResolvedValue(null);
        mocks.listFindMany.mockResolvedValue([
            { id: "list-2", name: "Diseño", spaceId: "space-1", space: { name: "Engineering" } }
        ]);
        mocks.requireList.mockRejectedValue(new Error("stop here"));
        await call({ list: "diseno", name: "Logo" }, "tasks_create");
        expect(mocks.requireList).toHaveBeenCalledWith(expect.anything(), "list-2", "member");

        const refused = await call({ list: "Marketing", name: "Logo" }, "tasks_create");
        expect(refused.isError).toBe(true);
        expect(refused.content[0]?.text).toBe(
            'No list called "Marketing" that this key can reach. It can reach: Diseño (Engineering).'
        );
    });
});

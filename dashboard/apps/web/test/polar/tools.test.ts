/**
 * Polaris's MCP tools as Polar's: offered by the person's own permissions,
 * changes held for approval, and the permission checked again when a tool
 * finally runs - an approval can sit for a while.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const held = new Set<string>();
const ran: string[] = [];

vi.mock("@/lib/session", () => ({
    sessionCan: async (_user: unknown, permission: string) => held.has(permission)
}));

vi.mock("@/lib/mcp/catalog", () => ({
    mcpTools: async () => [
        {
            name: "tasks_list",
            title: "List tasks",
            description: "Lists tasks",
            input: z.object({}),
            scope: "tasks.read",
            readOnly: true,
            run: async () => {
                ran.push("tasks_list");
                return { text: "none" };
            }
        },
        {
            name: "tasks_delete",
            title: "Delete a task",
            description: "Deletes a task",
            input: z.object({ id: z.string() }),
            scope: "tasks.manage",
            readOnly: false,
            run: async () => {
                ran.push("tasks_delete");
                return { text: "deleted" };
            }
        },
        {
            name: "tasks_rename",
            title: "Rename a task",
            description: "Renames a task",
            input: z.object({ id: z.string() }),
            scope: "tasks.manage",
            readOnly: false,
            destructive: false,
            run: async () => ({ text: "renamed" })
        },
        {
            name: "admin_users",
            description: "Lists users",
            input: z.object({}),
            scope: "users.manage",
            readOnly: true,
            run: async () => ({ text: "users" })
        }
    ]
}));

const { polarTools } = await import("@/lib/polar/tools");

const USER = { id: "u1", isAdmin: false, viewingAs: null } as never;

beforeEach(() => {
    held.clear();
    ran.length = 0;
});

async function run(name: string, toolset: Awaited<ReturnType<typeof polarTools>>, input: object) {
    const entry = toolset.tools[name] as {
        execute: (input: object, options: object) => Promise<unknown>;
    };
    return entry.execute(input, { toolCallId: "c1", messages: [] });
}

describe("polarTools", () => {
    it("offers only the tools the person holds a permission for", async () => {
        held.add("tasks.read");
        const toolset = await polarTools(USER);
        expect(Object.keys(toolset.tools)).toEqual(["tasks_list"]);
    });

    it("holds every tool that changes something for approval, and none that only reads", async () => {
        held.add("tasks.read").add("tasks.manage");
        const toolset = await polarTools(USER);
        expect(toolset.approval).toEqual({
            tasks_delete: "user-approval",
            tasks_rename: "user-approval"
        });
        expect(toolset.described.tasks_list).toEqual({
            title: "List tasks",
            writes: false,
            destructive: false
        });
        expect(toolset.described.tasks_delete).toMatchObject({ writes: true, destructive: true });
        expect(toolset.described.tasks_rename).toMatchObject({ writes: true, destructive: false });
    });

    it("runs a tool as the person and hands back its answer as data", async () => {
        held.add("tasks.read");
        const toolset = await polarTools(USER);
        expect(await run("tasks_list", toolset, {})).toEqual({
            ok: true,
            text: "none",
            data: null
        });
        expect(ran).toEqual(["tasks_list"]);
    });

    it("refuses at run time a tool whose permission was taken away after it was offered", async () => {
        held.add("tasks.read").add("tasks.manage");
        const toolset = await polarTools(USER);
        held.delete("tasks.manage");
        const answer = await run("tasks_delete", toolset, { id: "ENG-1" });
        expect(answer).toMatchObject({ ok: false });
        expect(ran).toEqual([]);
    });
});

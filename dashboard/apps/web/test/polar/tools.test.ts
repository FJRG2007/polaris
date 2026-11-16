/**
 * Polaris's MCP tools as Polar's: offered by the person's own permissions,
 * changes held for approval, and the permission checked again when a tool
 * finally runs - an approval can sit for a while.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const held = new Set<string>();
const ran: string[] = [];
/** The person's stored "Always allow" rows, as the database holds them. */
const grants: { tool: string; target: string }[] = [];
/** The input each agent_session_start actually ran with. */
const started: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        polarToolGrant: {
            findMany: async ({ where }: { where: { ownerId: string } }) =>
                where.ownerId === "u1" ? grants : []
        }
    }
}));

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
            target: async (input: { id: string }) => ({ id: input.id, name: `Task ${input.id}` }),
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
            name: "agent_session_start",
            title: "Start an agent session",
            description: "Starts a session",
            input: z.object({
                repo: z.string().default(""),
                prompt: z.string().min(1),
                baseRef: z.string().default("")
            }),
            scope: "agents.manage",
            readOnly: false,
            destructive: false,
            run: async (input: unknown) => {
                started.push(input);
                return { text: "started" };
            }
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
    grants.length = 0;
    started.length = 0;
});

type Approve = (input: unknown) => Promise<string>;

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
        expect(Object.keys(toolset.approval).sort()).toEqual(["tasks_delete", "tasks_rename"]);
        expect(await (toolset.approval.tasks_delete as Approve)({ id: "ENG-1" })).toBe(
            "user-approval"
        );
        expect(await (toolset.approval.tasks_rename as Approve)({ id: "ENG-1" })).toBe(
            "user-approval"
        );
        expect(toolset.described.tasks_list).toEqual({
            title: "List tasks",
            category: "productivity",
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

    it("skips the card for a tool the person always allows, from the stored grant", async () => {
        held.add("tasks.manage");
        grants.push({ tool: "tasks_rename", target: "" });
        const toolset = await polarTools(USER);
        expect(await (toolset.approval.tasks_rename as Approve)({ id: "ENG-1" })).toBe("approved");
        expect(await (toolset.approval.tasks_delete as Approve)({ id: "ENG-1" })).toBe(
            "user-approval"
        );
    });

    it("scopes a destructive tool's grant to the one target it was given for", async () => {
        held.add("tasks.manage");
        grants.push({ tool: "tasks_delete", target: "ENG-1" });
        const toolset = await polarTools(USER);
        expect(await (toolset.approval.tasks_delete as Approve)({ id: "ENG-1" })).toBe("approved");
        expect(await (toolset.approval.tasks_delete as Approve)({ id: "ENG-2" })).toBe(
            "user-approval"
        );
    });

    it("never reads an empty-scope grant as covering a destructive call whose target is unknown", async () => {
        held.add("tasks.manage");
        grants.push({ tool: "tasks_delete", target: "" });
        const toolset = await polarTools(USER);
        expect(await (toolset.approval.tasks_delete as Approve)({})).toBe("user-approval");
    });

    it("still refuses at run time an always-allowed tool whose permission is gone", async () => {
        held.add("tasks.manage");
        grants.push({ tool: "tasks_rename", target: "" });
        const toolset = await polarTools(USER);
        held.delete("tasks.manage");
        expect(await run("tasks_rename", toolset, { id: "ENG-1" })).toMatchObject({ ok: false });
    });
});

/** What the chat's check turns a written call into: the input the card shows. */
async function checked(
    toolset: Awaited<ReturnType<typeof polarTools>>,
    name: string,
    input: unknown
) {
    const schema = (
        toolset.tools[name] as { inputSchema: { validate: (value: unknown) => unknown } }
    ).inputSchema;
    return (await schema.validate(input)) as { success: boolean; value?: unknown };
}

describe("polarTools on a Code task", () => {
    const picked = { repo: "FJRG2007/experiments", prompt: "Fix the build", baseRef: "" };

    it("starts a No repository task's session in an empty workspace, whatever the model named", async () => {
        held.add("agents.manage");
        const toolset = await polarTools(USER, { repo: null, branch: "" });
        expect(await checked(toolset, "agent_session_start", picked)).toEqual({
            success: true,
            value: { repo: "", prompt: "Fix the build", baseRef: "" }
        });
        await run("agent_session_start", toolset, picked);
        expect(started).toEqual([{ repo: "", prompt: "Fix the build", baseRef: "" }]);
    });

    it("keeps a session on the task's repository, never one the model swapped in", async () => {
        held.add("agents.manage");
        const toolset = await polarTools(USER, { repo: "octo/app", branch: "dev" });
        expect(await checked(toolset, "agent_session_start", picked)).toEqual({
            success: true,
            value: { repo: "octo/app", prompt: "Fix the build", baseRef: "dev" }
        });
        // An approved call comes back from the browser: the run settles it again.
        await run("agent_session_start", toolset, { ...picked, baseRef: "feature" });
        expect(started).toEqual([
            { repo: "octo/app", prompt: "Fix the build", baseRef: "feature" }
        ]);
    });

    it("leaves the model's repository alone outside a Code task", async () => {
        held.add("agents.manage");
        const toolset = await polarTools(USER);
        expect(await checked(toolset, "agent_session_start", picked)).toMatchObject({
            value: picked
        });
        await run("agent_session_start", toolset, picked);
        expect(started).toEqual([picked]);
    });
});

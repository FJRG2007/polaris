/**
 * Parity: every tool Polar's chat had as a flat built-in tool before Polaris
 * became its MCP connector is still reachable through the MCP path - listed by
 * the in-process server, loadable by discovery, and registered for the chat -
 * for a person with the permissions, and refused for one without, before the
 * tool ever runs. A tool the person switched off is neither listed, loaded
 * nor run.
 *
 * The list is the core catalogue as it stood when the switch was made. An
 * installed app's tools reach the chat through the same `mcpTools()` path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every permission held, or none. */
const state = { all: true };

vi.mock("@polaris/db", () => ({
    prisma: { polarToolGrant: { findMany: async () => [] } }
}));
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/docker-service", () => ({}));
vi.mock("@/lib/session", () => ({ sessionCan: async () => state.all }));

const { polarTools, polarCaller } = await import("@/lib/polar/tools");
const { connectInProcess } = await import("@/lib/mcp/in-process");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { toolScopes } = await import("@/lib/mcp/protocol");
const relevance = await import("@/lib/polar/tool-relevance");

/** The built-in tools the chat registered directly, before. */
const BEFORE = [
    "polaris_whoami", "polaris_search", "polaris_tools", "tasks_spaces", "tasks_list",
    "tasks_get", "tasks_create", "tasks_update", "tasks_comment", "tasks_reminders",
    "tasks_remind", "tasks_reminder_cancel", "agent_sessions_list", "agent_session_get",
    "agent_session_prompt", "agent_session_start", "orchestration_task_create",
    "orchestration_tasks", "orchestration_inbox", "orchestration_answer",
    "orchestration_message", "orchestration_report", "deploy_projects", "deploy_service",
    "deploy_deployments", "deploy_deployment", "deploy_logs", "deploy_variables", "env_list",
    "deploy_domains", "deploy_start", "deploy_set_variable", "env_set", "env_delete",
    "deploy_add_domain", "deploy_restart", "deploy_rollback", "watch_alarms",
    "watch_alarm_create", "watch_alarm_change", "watch_connectivity", "automations_list",
    "automations_get", "automations_node_types", "automations_create", "automations_update",
    "automations_publish", "automations_set_enabled", "automations_run", "notes_list",
    "notes_get", "notes_create", "notes_update", "chat_conversations", "chat_messages",
    "chat_send", "drive_sources", "drive_list", "drive_stat", "drive_share_create",
    "mail_mailboxes", "mail_list", "mail_read", "mail_send", "databases_list",
    "databases_schema", "databases_query", "databases_execute"
];

const USER = { id: "u1", isAdmin: false, viewingAs: null } as never;

async function load(set: Awaited<ReturnType<typeof polarTools>>, names: string[]) {
    const find = relevance.findToolsTool(set.catalog)[relevance.FIND_TOOLS] as {
        execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    const output = await find.execute({ names }, { toolCallId: "f", messages: [] });
    return relevance.loadedBy(relevance.FIND_TOOLS, output);
}

beforeEach(() => {
    state.all = true;
});

describe("Polaris as Polar's MCP connector", () => {
    it("still has every tool the chat had", () => {
        const now = new Set(MCP_TOOLS.map((tool) => tool.name));
        expect(BEFORE.filter((name) => !now.has(name))).toEqual([]);
    });

    it("reaches every one through the MCP path for a person with the permissions", async () => {
        const set = await polarTools(USER);
        const listed = new Set(
            (await connectInProcess(await polarCaller(USER)).list()).map((tool) => tool.name)
        );
        const loaded = new Set<string>();
        for (let index = 0; index < BEFORE.length; index += relevance.LOAD_MAX) {
            for (const name of await load(set, BEFORE.slice(index, index + relevance.LOAD_MAX)))
                loaded.add(name);
        }
        for (const name of BEFORE) {
            expect(listed.has(name), `${name} listed`).toBe(true);
            expect(loaded.has(name), `${name} loadable`).toBe(true);
            expect(set.tools[name], `${name} registered`).toBeDefined();
        }
    });

    it("reaches none that needs a permission for a person without it, and never runs it", async () => {
        state.all = false;
        const set = await polarTools(USER);
        const caller = await polarCaller(USER);
        const connection = connectInProcess(caller);
        const listed = new Set((await connection.list()).map((tool) => tool.name));
        const guarded = BEFORE.filter((name) => {
            const tool = MCP_TOOLS.find((entry) => entry.name === name)!;
            return toolScopes(tool).length > 0;
        });
        expect(guarded.length).toBeGreaterThan(60);
        expect(await load(set, guarded.slice(0, relevance.LOAD_MAX))).toEqual([]);
        for (const name of guarded) {
            expect(listed.has(name), `${name} listed`).toBe(false);
            expect(set.tools[name], `${name} registered`).toBeUndefined();
            // Scope before shape: refused in words, with nothing parsed or run.
            const outcome = await connection.call(name, {});
            expect(outcome.kind).toBe("result");
            expect(outcome.kind === "result" && outcome.ok).toBe(false);
        }
    });

    it("never lists, loads or runs a tool the person switched off", async () => {
        const set = await polarTools(USER, null, { tools: ["tasks_list"], servers: [] });
        expect(set.catalog.some((entry) => entry.name === "tasks_list")).toBe(false);
        expect(await load(set, ["tasks_list"])).toEqual([]);
        const execute = (set.tools.tasks_list as {
            execute: (input: unknown, options: unknown) => Promise<{ ok: boolean }>;
        }).execute;
        expect((await execute({}, { toolCallId: "t", messages: [] })).ok).toBe(false);
        const caller = await polarCaller(USER, new Set(["tasks_list"]));
        const listed = (await connectInProcess(caller).list()).map((tool) => tool.name);
        expect(listed).not.toContain("tasks_list");
        expect(await connectInProcess(caller).call("tasks_list", {})).toEqual({ kind: "missing" });
    });

    it("takes every tool out while the Polaris server is switched off", async () => {
        const set = await polarTools(USER, null, { tools: [], servers: ["polaris"] });
        expect(set.catalog).toEqual([]);
    });
});

/**
 * Polaris's own MCP tools, handed to Polar in-process for the signed-in person.
 *
 * The same tool list (`lib/mcp/catalog.ts`), the same handlers and the same
 * scope check as a connected assistant gets - only the caller is built from the
 * session rather than from a key: every scope whose permission the person holds
 * right now, and never an administrator's view-as. No token is minted.
 *
 * A tool that can change anything (`readOnly: false`) is marked for approval,
 * so the chat shows a card and nothing runs until the person says yes. A tool's
 * answer is data the model reads; the system prompt says so.
 *
 * Server-only.
 */

import { tool, type FlexibleSchema, type ToolSet } from "ai";
import { mcpTools } from "@/lib/mcp/catalog";
import { sessionCan, type SessionUser } from "@/lib/session";
import { MCP_SCOPES, scopeRequires, type McpScope } from "@/lib/mcp/scope-table";
import { McpRefusal, callerMayUse, type McpCaller, type McpTool } from "@/lib/mcp/protocol";

/** The scopes this person holds, worked out once per request. */
export async function sessionScopes(user: SessionUser): Promise<McpScope[]> {
    const held = new Map<string, boolean>();
    const scopes: McpScope[] = [];
    for (const scope of MCP_SCOPES) {
        const permission = scopeRequires(scope);
        if (!held.has(permission)) held.set(permission, await sessionCan(user, permission));
        if (held.get(permission)) scopes.push(scope);
    }
    return scopes;
}

/** Whether a tool must be approved in the chat before it runs. */
export function needsApproval(entry: Pick<McpTool<never>, "readOnly">): boolean {
    return !entry.readOnly;
}

export interface PolarToolSet {
    tools: ToolSet;
    /** Tool name to `user-approval`, for streamText's `toolApproval`. */
    approval: Record<string, "user-approval">;
    /** Name to the title and whether it writes, for the cards. */
    described: Record<string, { title: string; writes: boolean; destructive: boolean }>;
}

/** What a tool answers when it refused or failed, as the model reads it. */
function failure(entry: McpTool<never>, error: unknown): string {
    if (error instanceof McpRefusal) return error.message;
    console.error(`polar: ${entry.name} failed`, error);
    return `${entry.name} could not be completed. Polaris has logged why.`;
}

/**
 * The tools this person may use, as AI SDK tools. One they hold no scope for is
 * not offered at all, the way `tools/list` leaves it out for a key.
 */
export async function polarTools(user: SessionUser): Promise<PolarToolSet> {
    const caller: McpCaller = {
        userId: user.id,
        isAdmin: user.isAdmin && !user.viewingAs,
        scopes: await sessionScopes(user)
    };
    const result: PolarToolSet = { tools: {}, approval: {}, described: {} };
    for (const entry of await mcpTools()) {
        if (!callerMayUse(entry, caller)) continue;
        const writes = needsApproval(entry);
        result.tools[entry.name] = tool({
            description: entry.description,
            inputSchema: entry.input as unknown as FlexibleSchema<unknown>,
            async execute(input: unknown) {
                // Checked again at the moment it runs: an approval can sit for a
                // while, and a permission removed in between must hold.
                const fresh = { ...caller, scopes: await sessionScopes(user) };
                if (!callerMayUse(entry, fresh)) {
                    return { ok: false, text: `You no longer have access to ${entry.name}.` };
                }
                try {
                    const answer = await entry.run(input as never, fresh);
                    return { ok: true, text: answer.text, data: answer.structured ?? null };
                } catch (error) {
                    return { ok: false, text: failure(entry, error) };
                }
            }
        });
        if (writes) result.approval[entry.name] = "user-approval";
        result.described[entry.name] = {
            title: entry.title ?? entry.name,
            writes,
            destructive: writes && (entry.destructive ?? true)
        };
    }
    return result;
}

/**
 * Polaris's own MCP tools, handed to Polar in-process for the signed-in person.
 *
 * The same tool list (`lib/mcp/catalog.ts`), the same handlers and the same
 * scope check as a connected assistant gets - only the caller is built from the
 * session rather than from a key: every scope whose permission the person holds
 * right now, and never an administrator's view-as. No token is minted.
 *
 * A tool that can change anything (`readOnly: false`) is marked for approval,
 * so the chat shows a card and nothing runs until the person says yes - unless
 * they told Polar to stop asking about it (`tool-grants.ts`), which this loop
 * reads from the database, never from the browser. A tool's
 * answer is data the model reads; the system prompt says so.
 *
 * Server-only.
 */

import { tool, type ToolSet } from "ai";
import { mcpTools } from "@/lib/mcp/catalog";
import { sessionCan, type SessionUser } from "@/lib/session";
import { MCP_SCOPES, scopeRequires, type McpScope } from "@/lib/mcp/scope-table";
import {
    McpRefusal,
    callerMayUse,
    toolCategory,
    type McpCaller,
    type McpTool
} from "@/lib/mcp/protocol";
import type { CatalogEntry } from "@/lib/polar/tool-relevance";
import { callTarget, grantCovers, grantKeys } from "@/lib/polar/tool-grants";
import { polarInputSchema } from "@/lib/polar/tool-input";

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

/** The person as an MCP caller: their own scopes, never a view-as. */
export async function polarCaller(user: SessionUser): Promise<McpCaller> {
    return {
        userId: user.id,
        isAdmin: user.isAdmin && !user.viewingAs,
        scopes: await sessionScopes(user)
    };
}

/** Whether a tool must be approved in the chat before it runs. */
export function needsApproval(entry: Pick<McpTool<never>, "readOnly">): boolean {
    return !entry.readOnly;
}

export interface PolarToolSet {
    tools: ToolSet;
    /** Tool name to whether a call waits for the person, for streamText's
     *  `toolApproval`: approved when a stored grant covers it, else asked. */
    approval: Record<string, (input: unknown) => Promise<"approved" | "user-approval">>;
    /** Name to the title and whether it writes, for the cards. */
    described: Record<string, { title: string; writes: boolean; destructive: boolean }>;
    /** Every tool here, in catalog order, for choosing which the model sees. */
    catalog: CatalogEntry[];
    /** Runs a read-only tool as the person, for `read_current_view`: null when
     *  it is not theirs to use or would change something. */
    call: (name: string, input: unknown) => Promise<{ ok: boolean; text: string } | null>;
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
    const caller = await polarCaller(user);
    const readers = new Map<string, McpTool<never>>();
    const result: PolarToolSet = {
        tools: {},
        approval: {},
        described: {},
        catalog: [],
        async call(name, input) {
            const entry = readers.get(name);
            if (!entry) return null;
            const fresh = { ...caller, scopes: await sessionScopes(user) };
            if (!callerMayUse(entry, fresh)) return null;
            const parsed = entry.input.safeParse(input);
            if (!parsed.success) return { ok: false, text: `${name} could not read that record.` };
            try {
                return { ok: true, text: (await entry.run(parsed.data as never, fresh)).text };
            } catch (error) {
                return { ok: false, text: failure(entry, error) };
            }
        }
    };
    const grants = await grantKeys(user.id);
    for (const entry of await mcpTools()) {
        if (!callerMayUse(entry, caller)) continue;
        const writes = needsApproval(entry);
        if (!writes) readers.set(entry.name, entry);
        result.catalog.push({
            name: entry.name,
            description: entry.description,
            category: toolCategory(entry)
        });
        result.tools[entry.name] = tool({
            description: entry.description,
            inputSchema: polarInputSchema(entry.input),
            async execute(written: unknown) {
                // Checked again at the moment it runs: an approval can sit for a
                // while, and a permission removed in between must hold.
                const fresh = { ...caller, scopes: await sessionScopes(user) };
                if (!callerMayUse(entry, fresh)) {
                    return { ok: false, text: `You no longer have access to ${entry.name}.` };
                }
                // Checked as the model wrote it, parsed here: see `tool-input.ts`.
                const parsed = entry.input.safeParse(written);
                if (!parsed.success) {
                    return {
                        ok: false,
                        text: `${entry.name} was called with input it does not take.`
                    };
                }
                try {
                    const answer = await entry.run(parsed.data as never, fresh);
                    return { ok: true, text: answer.text, data: answer.structured ?? null };
                } catch (error) {
                    return { ok: false, text: failure(entry, error) };
                }
            }
        });
        if (writes) {
            result.approval[entry.name] = async (input) => {
                if (grants.size === 0) return "user-approval";
                const target = await callTarget(entry, input, caller);
                return grantCovers(grants, entry, target) ? "approved" : "user-approval";
            };
        }
        result.described[entry.name] = {
            title: entry.title ?? entry.name,
            writes,
            destructive: writes && (entry.destructive ?? true)
        };
    }
    return result;
}

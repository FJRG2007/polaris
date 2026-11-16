/**
 * Polaris's own MCP server as Polar's built-in connector, for the signed-in
 * person.
 *
 * Every call goes through the MCP server itself, in-process
 * (`lib/mcp/in-process.ts`): the same `tools/call` an external assistant
 * makes, held to the same scope check, input parse and record-level checks.
 * Only the caller is built from the session rather than from a key: every
 * scope whose permission the person holds right now, never an administrator's
 * view-as, and the tools they switched off `hidden`, so the server neither
 * lists, runs nor names them in its discovery answers. No token is minted.
 *
 * Every tool stays registered so an older turn naming one still validates;
 * which ones the model is SENT is `tool-relevance.ts`'s: the discovery tools
 * and whatever they loaded.
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
import { connectInProcess } from "@/lib/mcp/in-process";
import { sessionCan, type SessionUser } from "@/lib/session";
import {
    MCP_SCOPES,
    scopeRequires,
    type McpCategory,
    type McpScope
} from "@/lib/mcp/scope-table";
import { callerMayUse, toolCategory, type McpCaller, type McpTool } from "@/lib/mcp/protocol";
import type { CatalogEntry } from "@/lib/polar/tool-relevance";
import { callTarget, grantCovers, grantKeys } from "@/lib/polar/tool-grants";
import { polarInputSchema } from "@/lib/polar/tool-input";
import { codeTaskInput, type PolarCodeTask } from "@/lib/polar/code-task";
import { POLARIS_SERVER } from "@/lib/polar/tool-servers";

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

/** The person as an MCP caller: their own scopes, never a view-as, and the
 *  tools they switched off hidden from the server's answers. */
export async function polarCaller(
    user: SessionUser,
    hidden: ReadonlySet<string> | null = null
): Promise<McpCaller> {
    return {
        userId: user.id,
        isAdmin: user.isAdmin && !user.viewingAs,
        scopes: await sessionScopes(user),
        ...(hidden && hidden.size > 0 ? { hidden } : {})
    };
}

/** The person's own switches for Polaris's tools, as the settings store them:
 *  tools off by name, servers off by id (`tool-servers.ts`). */
export interface PolarToolsOff {
    readonly tools: readonly string[];
    readonly servers: readonly string[];
}

/** Which of Polaris's tools are switched off: every one while the Polaris
 *  server is, else the ones switched off by name. */
export function hiddenPolarisTools(
    off: PolarToolsOff | null,
    names: readonly string[]
): Set<string> {
    if (!off) return new Set();
    if (off.servers.includes(POLARIS_SERVER)) return new Set(names);
    const known = new Set(names);
    return new Set(off.tools.filter((name) => known.has(name)));
}

/** Whether a tool must be approved in the chat before it runs. */
export function needsApproval(entry: Pick<McpTool<never>, "readOnly">): boolean {
    return !entry.readOnly;
}

/** One of Polaris's tools as the settings screen and the cards describe it. */
export interface PolarToolDescription {
    title: string;
    /** The heading it is listed under, the MCP server's own (`polaris_tools`). */
    category: McpCategory;
    writes: boolean;
    destructive: boolean;
}

export interface PolarToolSet {
    tools: ToolSet;
    /** Tool name to whether a call waits for the person, for streamText's
     *  `toolApproval`: approved when a stored grant covers it, else asked. */
    approval: Record<string, (input: unknown) => Promise<"approved" | "user-approval">>;
    /** Name to the title, category and whether it writes, for the cards and
     *  the settings screen. */
    described: Record<string, PolarToolDescription>;
    /** Every tool the person may use and has not switched off, in catalog
     *  order: what discovery searches and loads from. */
    catalog: CatalogEntry[];
    /** Runs a read-only tool as the person, for `read_current_view`: null when
     *  it is not theirs to use or would change something. */
    call: (name: string, input: unknown) => Promise<{ ok: boolean; text: string } | null>;
}

/** How one run as the person went, before it is worded for its caller. */
type RunOutcome =
    | { kind: "denied" }
    | { kind: "invalid" }
    | { kind: "ran"; ok: boolean; text: string; data: unknown };

/**
 * The tools this person may use, as AI SDK tools. One they hold no scope for is
 * not offered at all, the way `tools/list` leaves it out for a key. `off` is
 * the person's own switches: a tool switched off stays registered, so an older
 * turn naming it still validates, but the server refuses it and discovery
 * never finds it.
 *
 * `codeTask` is the Code task the chat is on: a tool that would put work on a
 * repository takes that one, or none for "No repository", whatever the model
 * wrote (`codeTaskInput`). Settled where the call is checked, so the approval
 * card shows it, and again where it runs, since an approved call comes back
 * from the browser.
 */
export async function polarTools(
    user: SessionUser,
    codeTask: PolarCodeTask | null = null,
    off: PolarToolsOff | null = null
): Promise<PolarToolSet> {
    const catalogue = await mcpTools();
    const hidden = hiddenPolarisTools(
        off,
        catalogue.map((entry) => entry.name)
    );
    const caller = await polarCaller(user, hidden);
    const readers = new Map<string, McpTool<never>>();
    const runAs = async (entry: McpTool<never>, written: unknown): Promise<RunOutcome> => {
        const input = codeTaskInput(entry.name, written, codeTask);
        // Checked again at the moment it runs: an approval can sit for a
        // while, and a permission removed in between must hold.
        const fresh: McpCaller = { ...caller, scopes: await sessionScopes(user) };
        if (!callerMayUse(entry, fresh)) return { kind: "denied" };
        // Through the MCP server, as an external client's call goes: its scope
        // check, its parse of the input as the model wrote it (see
        // `tool-input.ts`), the tool's own checks, and its refusal wording.
        const outcome = await connectInProcess(fresh, catalogue).call(entry.name, input);
        if (outcome.kind === "missing") return { kind: "denied" };
        if (outcome.kind === "invalid") return { kind: "invalid" };
        return { kind: "ran", ok: outcome.ok, text: outcome.text, data: outcome.structured };
    };
    const result: PolarToolSet = {
        tools: {},
        approval: {},
        described: {},
        catalog: [],
        async call(name, input) {
            const entry = readers.get(name);
            if (!entry) return null;
            const outcome = await runAs(entry, input);
            if (outcome.kind === "denied") return null;
            if (outcome.kind === "invalid")
                return { ok: false, text: `${name} could not read that record.` };
            return { ok: outcome.ok, text: outcome.text };
        }
    };
    const grants = await grantKeys(user.id);
    for (const entry of catalogue) {
        if (!callerMayUse(entry, caller)) continue;
        const writes = needsApproval(entry);
        if (!writes) readers.set(entry.name, entry);
        // A tool switched off stays registered, for older turns, but is never
        // offered, searched or loaded.
        if (!hidden.has(entry.name)) {
            result.catalog.push({
                name: entry.name,
                description: entry.description,
                category: toolCategory(entry)
            });
        }
        result.tools[entry.name] = tool({
            description: entry.description,
            inputSchema: polarInputSchema(entry.input, (value) =>
                codeTaskInput(entry.name, value, codeTask)
            ),
            async execute(written: unknown) {
                const outcome = await runAs(entry, written);
                if (outcome.kind === "denied") {
                    return { ok: false, text: `You no longer have access to ${entry.name}.` };
                }
                if (outcome.kind === "invalid") {
                    return {
                        ok: false,
                        text: `${entry.name} was called with input it does not take.`
                    };
                }
                return { ok: outcome.ok, text: outcome.text, data: outcome.data };
            }
        });
        if (writes) {
            result.approval[entry.name] = async (input) => {
                if (grants.size === 0) return "user-approval";
                const settled = codeTaskInput(entry.name, input, codeTask);
                const target = await callTarget(entry, settled, caller);
                return grantCovers(grants, entry, target) ? "approved" : "user-approval";
            };
        }
        result.described[entry.name] = {
            title: entry.title ?? entry.name,
            category: toolCategory(entry),
            writes,
            destructive: writes && (entry.destructive ?? true)
        };
    }
    return result;
}

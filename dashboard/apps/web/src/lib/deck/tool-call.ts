/**
 * Calling an MCP tool as a deck's key.
 *
 * A deck action that changes something runs the tool an assistant would call
 * for it, through the same three gates the MCP endpoint applies: the tool must
 * be in the live catalogue (an uninstalled app's are not), the key must hold its
 * scope, and its input must parse against its own schema. A change also
 * spends the key's MCP and Deploy budgets and is written to its owner's
 * activity, as one made through the endpoint is. What the tool then checks - the screens' own reach and permission rules - is not repeated here.
 *
 * Server-only.
 */

import type { DeckCaller } from "./types";
import { DECK_FINER_SCOPES } from "./scopes";
import { mcpTools } from "@/lib/mcp/catalog";
import { translatorFor } from "@/lib/i18n/translate";
import { MCP_ONLY_SCOPES, type McpScope } from "@/lib/mcp/scope-table";
import { auditToolChange, spendToolBudget } from "@/lib/mcp/call-guard";
import { callerMayUse, McpRefusal, type McpCaller } from "@/lib/mcp/protocol";

/** A tool's answer, or the sentence a person is shown instead. */
export type ToolOutcome =
    | { readonly ok: true; readonly structured: unknown }
    | { readonly ok: false; readonly message: string | null };

/**
 * The MCP caller a deck's key acts as.
 *
 * A key carries permissions; an app's tools ask for the finer scopes of the
 * table (`places.control`). A finer scope is held here when the key holds the
 * permission it requires - which is what the approval screen listed - so a
 * deck allowed to operate devices may call the tool that operates them. Only
 * the ones a deck's actions use: the rest are separate consents.
 */
export function mcpCallerFor(caller: DeckCaller): McpCaller {
    const held = new Set(caller.scopes);
    const finer = DECK_FINER_SCOPES.filter((scope) => held.has(MCP_ONLY_SCOPES[scope].requires));
    return {
        userId: caller.userId,
        isAdmin: caller.isAdmin,
        keyId: caller.keyId,
        scopes: [...caller.scopes, ...finer] as McpScope[]
    };
}

/** Call one tool. A refusal the tool wrote for its caller comes back as
 *  written; anything else is logged and comes back as null. */
export async function callTool(
    caller: DeckCaller,
    name: string,
    input: unknown
): Promise<ToolOutcome> {
    const tool = (await mcpTools()).find((candidate) => candidate.name === name);
    const mcp = mcpCallerFor(caller);
    if (!tool || !callerMayUse(tool, mcp)) return { ok: false, message: null };
    const args = tool.input.safeParse(input);
    if (!args.success) return { ok: false, message: null };
    if (!tool.readOnly && (await spendToolBudget(tool, mcp)) !== null)
        return { ok: false, message: translatorFor(caller.locale, "api")("deck.errors.throttled") };
    let structured: unknown;
    try {
        structured = (await tool.run(args.data as never, mcp)).structured ?? null;
    } catch (caught) {
        if (caught instanceof McpRefusal) return { ok: false, message: caught.message };
        console.error(`deck: ${name} failed`, caught);
        return { ok: false, message: null };
    }
    await auditToolChange(tool, mcp, "streamdeck");
    return { ok: true, structured };
}

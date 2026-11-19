/**
 * A tool called for the signed-in person by Polaris itself - a phone widget, a
 * button in a chat message - rather than by an assistant holding a key.
 *
 * It runs exactly as a key with the same scopes would: the tool's own checks,
 * the credential budgets, and the activity line for a change. The caller holds
 * only the scopes asked for that the person actually has, so a surface reaches
 * nothing its person could not reach from the screen.
 *
 * Server-only.
 */

import { mcpTools } from "./catalog";
import { scopesAvailableTo } from "@polaris/auth";
import { MCP_ONLY_SCOPES, type McpScope } from "./scope-table";
import { auditToolChange, spendToolBudget, type McpVia } from "./call-guard";
import { callerMayUse, McpRefusal, type McpCaller } from "./protocol";

export type SessionToolOutcome =
    | { readonly ok: true; readonly structured: unknown }
    | {
          readonly ok: false;
          /** `missing`: the tool is not there or not this person's. `throttled`:
           *  over the budget. `refused`: the tool said no, with its sentence when
           *  it gave one. */
          readonly reason: "missing" | "throttled" | "refused";
          readonly message: string | null;
      };

/** The session as an MCP caller holding only those of `wanted` its person holds. */
export async function sessionCaller(
    user: { readonly id: string; readonly isAdmin: boolean },
    wanted: readonly McpScope[]
): Promise<McpCaller> {
    const held = new Set<string>(await scopesAvailableTo(user.id, user.isAdmin));
    const scopes = wanted.filter((scope) =>
        held.has(scope in MCP_ONLY_SCOPES ? MCP_ONLY_SCOPES[scope as keyof typeof MCP_ONLY_SCOPES].requires : scope)
    );
    return { userId: user.id, isAdmin: user.isAdmin, keyId: null, scopes };
}

/** Call one tool as `caller`. Never throws for the tool's own failure. */
export async function callSessionTool(
    caller: McpCaller,
    name: string,
    input: unknown,
    via: McpVia
): Promise<SessionToolOutcome> {
    const tool = (await mcpTools()).find((candidate) => candidate.name === name);
    if (!tool || !callerMayUse(tool, caller)) return { ok: false, reason: "missing", message: null };
    const args = tool.input.safeParse(input);
    if (!args.success) return { ok: false, reason: "refused", message: null };
    if (!tool.readOnly && (await spendToolBudget(tool, caller)) !== null) {
        return { ok: false, reason: "throttled", message: null };
    }
    try {
        const structured = (await tool.run(args.data as never, caller)).structured ?? null;
        await auditToolChange(tool, caller, via);
        return { ok: true, structured };
    } catch (caught) {
        if (caught instanceof McpRefusal) return { ok: false, reason: "refused", message: caught.message };
        console.error(`${via}: ${name} failed`, caught);
        return { ok: false, reason: "refused", message: null };
    }
}

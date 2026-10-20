/**
 * Polar's "Always allow": the write tools a person told Polar to stop asking
 * about, stored per person on the server and read by the chat's own loop.
 *
 * The same three answers Claude's connectors give a tool (always allow, needs
 * approval, blocked), minus blocked - a tool this person may not use is not
 * offered at all. Two rules keep it from widening anything:
 *
 * - A grant only skips the card. The call still runs as the person, and the
 *   tool's permission is checked again at the moment it runs, so a grant
 *   outlives no permission it was given under.
 * - For a tool that can destroy (`destructive`), a grant names the one thing
 *   the call acts on when the tool can say what that is (`McpTool.target`):
 *   always opening the studio door is not always opening every door. A
 *   destructive tool that names nothing is allowed whole, and the card says so
 *   before the person picks it.
 *
 * The browser never says what is allowed: it asks to allow a call it was shown,
 * and the server works out the tool and the target from that call itself.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { mcpTools } from "@/lib/mcp/catalog";
import type { McpCaller, McpTool, McpToolTarget } from "@/lib/mcp/protocol";

/** More than anybody allows by hand; bounds the read made on every turn. */
export const GRANT_LIMIT = 200;

export interface PolarToolGrantRow {
    id: string;
    tool: string;
    target: string;
    targetName: string;
    createdAt: Date;
}

/** One grant as a lookup key: the tool and the target ("" for any). */
function keyOf(tool: string, target: string): string {
    return `${tool}\u0000${target}`;
}

/** Whether a tool's grants are per target rather than for the whole tool. */
export function perTarget(entry: Pick<McpTool<never>, "readOnly" | "destructive">): boolean {
    return !entry.readOnly && (entry.destructive ?? true);
}

/**
 * The target id a grant for this call is stored under; "" for the whole tool.
 * Null when the tool names its target but this call's could not be read: a
 * grant then would cover every target, so there is none to give or match.
 */
export function grantScope(
    entry: Pick<McpTool<never>, "readOnly" | "destructive" | "target">,
    target: McpToolTarget | null
): string | null {
    if (!perTarget(entry)) return "";
    if (target) return target.id;
    return entry.target ? null : "";
}

/** This person's grants, as keys, for the approval check of one turn. */
export async function grantKeys(userId: string): Promise<Set<string>> {
    const rows = await prisma.polarToolGrant.findMany({
        where: { ownerId: userId },
        select: { tool: true, target: true },
        orderBy: { createdAt: "desc" },
        take: GRANT_LIMIT
    });
    return new Set(
        rows.map((row: { tool: string; target: string }) => keyOf(row.tool, row.target))
    );
}

/** Whether a grant covers this call. */
export function grantCovers(
    keys: ReadonlySet<string>,
    entry: Pick<McpTool<never>, "name" | "readOnly" | "destructive" | "target">,
    target: McpToolTarget | null
): boolean {
    const scope = grantScope(entry, target);
    return scope !== null && keys.has(keyOf(entry.name, scope));
}

/**
 * What a call acts on, by name, read as the caller. Null when the tool cannot
 * say, the input does not parse, or the caller may not see the thing - the
 * card then shows the raw id it already has.
 */
export async function callTarget(
    entry: McpTool<never>,
    input: unknown,
    caller: McpCaller
): Promise<McpToolTarget | null> {
    if (!entry.target) return null;
    const parsed = entry.input.safeParse(input);
    if (!parsed.success) return null;
    try {
        const found = await entry.target(parsed.data as never, caller);
        if (!found || !found.id || !found.name) return null;
        return {
            id: found.id.slice(0, 200),
            name: found.name.slice(0, 120),
            ...(found.action ? { action: found.action.slice(0, 40) } : {})
        };
    } catch {
        return null;
    }
}

/** A write tool this caller may use, by name; null for anything else. */
export async function grantableTool(name: string, mayUse: (entry: McpTool<never>) => boolean) {
    const entry = (await mcpTools()).find((candidate) => candidate.name === name);
    if (!entry || entry.readOnly || !mayUse(entry)) return null;
    return entry;
}

/** Why a grant was not stored: no target to scope it to, or the list is full. */
export type GrantRefusal = "target_unknown" | "limit";

/**
 * Stores a grant; allowing the same thing twice keeps the first. Refuses one
 * past `GRANT_LIMIT`, so every grant stored is both honored and listed.
 */
export async function saveGrant(
    userId: string,
    entry: McpTool<never>,
    target: McpToolTarget | null
): Promise<GrantRefusal | null> {
    const scope = grantScope(entry, target);
    if (scope === null) return "target_unknown";
    const key = { ownerId: userId, tool: entry.name, target: scope };
    const existing = await prisma.polarToolGrant.findUnique({
        where: { ownerId_tool_target: key },
        select: { id: true }
    });
    if (existing) return null;
    const held = await prisma.polarToolGrant.count({ where: { ownerId: userId } });
    if (held >= GRANT_LIMIT) return "limit";
    await prisma.polarToolGrant.upsert({
        where: { ownerId_tool_target: { ownerId: userId, tool: entry.name, target: scope } },
        create: {
            ownerId: userId,
            tool: entry.name,
            target: scope,
            targetName: scope && target ? target.name : ""
        },
        update: {}
    });
    return null;
}

/** This person's grants, newest first, for the settings list. */
export async function listGrants(userId: string): Promise<PolarToolGrantRow[]> {
    return prisma.polarToolGrant.findMany({
        where: { ownerId: userId },
        select: { id: true, tool: true, target: true, targetName: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: GRANT_LIMIT
    });
}

/** Removes one of this person's grants; anybody else's id removes nothing. */
export async function revokeGrant(userId: string, id: string): Promise<boolean> {
    const { count } = await prisma.polarToolGrant.deleteMany({ where: { id, ownerId: userId } });
    return count > 0;
}

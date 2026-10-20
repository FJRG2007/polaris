/**
 * A person's connectors as Polar tools, for that person's chat only.
 *
 * Each enabled connector's tools join the turn under `mcp_<connector>__<tool>`
 * (`policy.ts`), minus the ones the person blocked. One set to "needs
 * approval" - every write by default - waits on the same card Polaris's own
 * write tools use; "always allow" runs without it. The input is checked
 * against the tool's own schema before it leaves the deployment, and the
 * answer comes back as somebody else's text: capped, fenced, and named as
 * the connector's, so the model reads it as data and never as instructions.
 *
 * The MCP client is imported only when a call runs, so the list can be built
 * and asserted without it.
 *
 * Server-only.
 */

import { z } from "zod";
import type { SessionUser } from "@/lib/session";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { PolarAccess } from "@/lib/polar/access";
import * as rules from "@/lib/polar/connectors/policy";
import { hostAllowed } from "@/lib/polar/connectors/shared";
import { connectorPolicy, ownConnectors, setToolPolicy } from "@/lib/polar/connectors/store";

export interface ConnectorToolSet {
    tools: ToolSet;
    approval: Record<string, () => Promise<"user-approval">>;
    described: Record<
        string,
        { title: string; writes: boolean; destructive: boolean; connector: string }
    >;
}

const EMPTY = (): ConnectorToolSet => ({ tools: {}, approval: {}, described: {} });

/** What a failed call answers, as the model reads it. */
const FAILED: Record<string, string> = {
    sign_in: "needs to be signed in again on the Connectors screen",
    unreachable: "did not answer",
    refused: "is on an address this deployment does not reach",
    host: "is on a host the administrator no longer allows",
    failed: "could not complete the call"
};

export async function polarConnectorTools(
    user: Pick<SessionUser, "id">,
    access: Pick<PolarAccess, "connectors">
): Promise<ConnectorToolSet> {
    const result = EMPTY();
    if (!access.connectors) return result;
    const [connectors, policy] = await Promise.all([
        ownConnectors(user.id, { enabled: true }),
        connectorPolicy()
    ]);
    for (const { row } of connectors) {
        if (!hostAllowed(row.url, policy.hosts)) continue;
        for (const entry of row.tools) {
            const answer = rules.effectiveToolPolicy(entry, row.policies);
            if (answer === "block") continue;
            const name = rules.connectorToolName(row, entry.name);
            if (result.tools[name]) continue;
            result.tools[name] = tool({
                description: [
                    `A tool of "${row.name}", an outside MCP server this person connected.`,
                    entry.description
                ]
                    .filter(Boolean)
                    .join(" ")
                    .slice(0, 1200),
                inputSchema: jsonSchema(entry.inputSchema as never, {
                    validate: async (value) =>
                        rules.inputFits(entry.inputSchema, value)
                            ? { success: true, value }
                            : { success: false, error: new Error("input does not fit") }
                }),
                async execute(input: unknown, options) {
                    if (!rules.inputFits(entry.inputSchema, input)) {
                        return { ok: false, text: `${name} was called with input it does not take.` };
                    }
                    const session = await import("@/lib/polar/connectors/session");
                    try {
                        const raw = await session.callConnectorTool(
                            user.id,
                            row.id,
                            entry.name,
                            input as Record<string, unknown>,
                            options?.abortSignal
                        );
                        const output = rules.connectorOutputText(raw);
                        return {
                            ok: !output.isError,
                            text: rules.fenceConnectorOutput(row.name, output.text),
                            data: null,
                            untrusted: true
                        };
                    } catch (error) {
                        const code = error instanceof session.ConnectorError ? error.code : "failed";
                        if (code === "failed") console.error(`polar: ${name} failed`, error);
                        return { ok: false, text: `${row.name} ${FAILED[code] ?? FAILED.failed}.` };
                    }
                }
            });
            if (answer === "ask") result.approval[name] = async () => "user-approval";
            result.described[name] = {
                title: `${row.name}: ${entry.title ?? entry.name}`.slice(0, 200),
                writes: !entry.readOnly,
                destructive: entry.destructive,
                connector: row.name
            };
        }
    }
    return result;
}

/**
 * Stand-ins for connector tools an older message called that the person no
 * longer has (removed, blocked, off), so the thread still reads as valid. A
 * stand-in is never offered to the model: only the check sees it.
 */
export function connectorStandIns(messages: readonly unknown[], known: ToolSet): ToolSet {
    const found: ToolSet = {};
    for (const message of messages) {
        const parts = (message as { parts?: unknown })?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            const type = (part as { type?: unknown })?.type;
            if (typeof type !== "string" || !type.startsWith("tool-")) continue;
            const name = type.slice(5);
            if (rules.isConnectorToolName(name) && !known[name] && !found[name]) {
                found[name] = tool({ inputSchema: z.unknown() as never });
            }
        }
    }
    return found;
}

/**
 * "Always allow" on the approval card, for a connector's tool: the tool's
 * answer becomes "allow". Null for a name that is none of this person's
 * connector tools.
 */
export async function allowConnectorTool(userId: string, name: string): Promise<boolean | null> {
    if (!rules.isConnectorToolName(name)) return null;
    for (const { row } of await ownConnectors(userId)) {
        const entry = row.tools.find((one) => rules.connectorToolName(row, one.name) === name);
        if (entry) return setToolPolicy(userId, row.id, entry.name, "allow");
    }
    return false;
}

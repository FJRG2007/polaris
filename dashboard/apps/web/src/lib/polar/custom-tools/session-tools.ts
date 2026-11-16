/**
 * Custom tools inside a Code session: what the session's own tool server
 * (`session-tools-mcp.ts`, for a CLI agent) and the native engine
 * (`native/custom-tools.ts`) list and call, through
 * `/api/agents/sessions/:id/tools` with the session's token.
 *
 * The session gets the person's switched-on tools and the approved revision
 * of its repository's tools, the same set Polar chat offers. A call is parsed
 * against the tool's declared input here, asked about on the session through
 * the same permission prompt the agent's own tools use (unless the person set
 * the tool to "allow"), and answered with the command the sandbox runs - the
 * dashboard never runs it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as shared from "@/lib/polar/custom-tools/shared";
import * as runtime from "@/lib/polar/custom-tools/runtime";
import * as permissions from "@/lib/agents/session-permissions";
import { pushPermissionRequest } from "@/lib/agents/agent-notices";
import type { UnavailableModule } from "@/lib/polar/custom-tools/opencode-modules";

/** A session as the tool route reads it. */
export interface ToolSession {
    readonly id: string;
    readonly startedById: string | null;
    readonly place: string;
    readonly repoId: string | null;
}

export async function toolSession(id: string): Promise<ToolSession | null> {
    return prisma.agentSession.findUnique({
        where: { id },
        select: { id: true, startedById: true, place: true, repoId: true }
    });
}

/** Said instead of a tool list on a session on somebody's computer: those
 *  take the runner's frames, and the runner has no tool frame yet. */
export const COMPUTER_REFUSAL =
    "Custom tools do not run in a session on your computer yet. Use a session on Polaris or on your server for them.";

/** A tool as an MCP `tools/list` entry, and as the native engine declares it. */
export interface ListedTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
}

/** The flat input shape as JSON Schema. Pure. */
export function jsonSchemaOf(input: shared.ToolInputSchema): Record<string, unknown> {
    return {
        type: "object",
        properties: input.properties,
        required: input.required,
        additionalProperties: false
    };
}

export type ToolList =
    | { readonly ok: true; readonly tools: ListedTool[]; readonly unavailable: UnavailableModule[] }
    | { readonly ok: false; readonly refusal: string };

function sandboxOf(session: ToolSession): runtime.Sandbox {
    return { sessionId: session.id, repository: session.repoId };
}

export async function listSessionTools(session: ToolSession): Promise<ToolList> {
    if (session.place === "computer") return { ok: false, refusal: COMPUTER_REFUSAL };
    if (!session.startedById) return { ok: true, tools: [], unavailable: [] };
    const offer = await runtime.sandboxTools(session.startedById, sandboxOf(session));
    return {
        ok: true,
        tools: offer.tools.map(({ definition }) => ({
            name: definition.name,
            description: definition.description,
            inputSchema: jsonSchemaOf(definition.input)
        })),
        unavailable: offer.unavailable
    };
}

export type PreparedCall =
    | { readonly ok: true; readonly command: string; readonly timeoutSeconds: number }
    | { readonly ok: false; readonly refusal: string };

/** The detail a permission prompt shows: the tool and what it was given. */
export function promptDetail(name: string, args: Record<string, unknown>): string {
    const given = JSON.stringify(args);
    return `${name} ${given.length > 400 ? `${given.slice(0, 400)}...` : given}`;
}

/** Whether the person already answered "always" for this tool in this session. */
async function alwaysAllowed(sessionId: string, tool: string): Promise<boolean> {
    const row = await prisma.agentPermissionRequest.findFirst({
        where: { sessionId, status: "always", tool },
        select: { id: true }
    });
    return row !== null;
}

/** Asks on the session, the way the agent's own permission prompts are asked. */
async function ask(sessionId: string, tool: string, detail: string, signal?: AbortSignal): Promise<string | null> {
    if (await alwaysAllowed(sessionId, tool)) return null;
    const requestId = await permissions.openPermissionRequest(sessionId, { tool, detail, suggestions: null });
    void pushPermissionRequest(sessionId, requestId, detail).catch(() => undefined);
    const answer = await permissions.awaitPermission(requestId, sessionId, permissions.PERMISSION_WAIT_MS, signal);
    if (answer.status === "allow" || answer.status === "always") return null;
    if (answer.status === "deny") return "Denied from Polaris by the session owner.";
    return "Nobody answered the permission prompt in time, so this did not run. Ask again later or try another approach.";
}

export async function prepareSessionCall(
    session: ToolSession,
    name: string,
    written: unknown,
    signal?: AbortSignal
): Promise<PreparedCall> {
    if (session.place === "computer") return { ok: false, refusal: COMPUTER_REFUSAL };
    if (!session.startedById) return { ok: false, refusal: `No tool called ${name}.` };
    const offer = await runtime.sandboxTools(session.startedById, sandboxOf(session));
    const found = offer.tools.find((entry) => entry.definition.name === name);
    if (!found) return { ok: false, refusal: `No tool called ${name}. It may have been switched off or removed.` };
    const args = shared.callSchema(found.definition.input).safeParse(written ?? {});
    if (!args.success) return { ok: false, refusal: `${name} was called with input it does not take.` };
    if (found.asks) {
        const refusal = await ask(session.id, shared.turnToolName(name), promptDetail(name, args.data), signal);
        if (refusal) return { ok: false, refusal };
    }
    return {
        ok: true,
        command: shared.toolCommand(found.definition, args.data),
        timeoutSeconds: found.definition.timeoutSeconds
    };
}

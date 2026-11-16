/**
 * The person's custom tools as native tools: the same set a CLI agent's
 * session gets from its tool server (`session-tools-mcp.ts`), read from
 * `/api/agents/sessions/:id/tools` with the session token when the engine
 * starts, and named `custom_<name>` as Polar chat names them.
 *
 * A call goes to the same route, which parses the input, asks the person when
 * the tool asks (so the engine's own gate stays out of it, "none"), and
 * answers the command; the engine runs it in the checkout. Plan mode
 * withholds them like any tool that may change something.
 *
 * Server-free, like the rest of the engine.
 */

import { z } from "zod";
import { shellArgv } from "@/lib/polar/native/tools";
import * as shared from "@/lib/polar/custom-tools/shared";
import type { NativeTool, ToolOutput } from "@/lib/polar/native/tools";

const listSchema = z.object({
    ok: z.literal(true),
    tools: z
        .array(
            z.object({
                name: z.string().regex(shared.TOOL_NAME),
                description: z.string().max(1024),
                inputSchema: z.object({ properties: z.unknown(), required: z.unknown() }).passthrough()
            })
        )
        .max(shared.TOOLS_MOST * 2)
});

const callSchema = z.union([
    z.object({ ok: z.literal(true), command: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(shared.TIMEOUT_MOST) }),
    z.object({ ok: z.literal(false), refusal: z.string().max(2000) })
]);

/** How long the engine waits for the list before starting without it. */
const LIST_WAIT_MS = 30_000;

const fail = (text: string): ToolOutput => ({ text, isError: true });

/** One listed tool as a native tool. Null when its input is not one Polaris
 *  describes, which the route never sends. Pure but for `post`. */
export function nativeCustomTool(
    listed: z.infer<typeof listSchema>["tools"][number],
    post: (body: unknown, signal: AbortSignal) => Promise<unknown>
): NativeTool<never> | null {
    const input = shared.inputSchemaShape.safeParse({
        properties: listed.inputSchema.properties,
        required: listed.inputSchema.required
    });
    if (!input.success) return null;
    const tool: NativeTool<Record<string, unknown>> = {
        name: shared.turnToolName(listed.name),
        description: listed.description,
        schema: shared.callSchema(input.data),
        gate: "none",
        writes: true,
        async run(args, { ws, signal }) {
            const answer = callSchema.safeParse(await post({ name: listed.name, arguments: args }, signal).catch(() => null));
            if (!answer.success) return fail("Polaris could not be reached to run this tool.");
            if (!answer.data.ok) return fail(answer.data.refusal);
            const result = await ws.exec(shellArgv(ws.platform, answer.data.command), {
                timeoutMs: (answer.data.timeoutSeconds + 30) * 1000,
                signal
            });
            const run = shared.readToolRun(result.stdout + result.stderr);
            if (run.timedOut) return fail(`${listed.name} ran past ${answer.data.timeoutSeconds} s and was stopped.\n${run.text}`);
            if (!run.ok) return fail(run.text || `Exited with ${run.code ?? "an error"}.`);
            return { text: run.text || "(no output)" };
        }
    };
    return tool as unknown as NativeTool<never>;
}

/** The session's custom tools, or none when Polaris cannot be read: a
 *  session without them still works. */
export async function fetchCustomTools(
    url: string,
    token: string,
    fetchImpl: typeof fetch = fetch
): Promise<NativeTool<never>[]> {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const post = async (body: unknown, signal: AbortSignal) => {
        const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
        return response.json();
    };
    try {
        // Bounded: the engine waits on this before its first turn, and a
        // repository's modules are read in the sandbox to answer it.
        const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(LIST_WAIT_MS) });
        const listed = listSchema.safeParse(await response.json());
        if (!listed.success) return [];
        return listed.data.tools.flatMap((entry) => nativeCustomTool(entry, post) ?? []);
    } catch {
        return [];
    }
}

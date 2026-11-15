/**
 * A tool's input as Polar hands it to the model: checked against the tool's own
 * schema, but kept exactly as the model wrote it.
 *
 * The AI SDK keeps a call's checked input in the chat history, and the model
 * reads it back on the next step. A schema that rewrites while it checks -
 * trims a string, turns the spoken "open" into the door's "unlatch" - shows the
 * model a call it never made: it read action "unlatch", not one of the words it
 * is offered, and asked to open an already-approved door a second time. The
 * tool parses the input itself when it runs (`tools.ts`), the way an MCP
 * client's call does.
 *
 * `settle` is the one rewrite allowed, and it is applied before the check and
 * kept: a value the model may not choose (`codeTaskInput`), which the model
 * and the approval card are meant to read back as the call that will run.
 *
 * Server-only.
 */

import type { z } from "zod";
import type { McpTool } from "@/lib/mcp/protocol";
import { jsonSchema, zodSchema, type Schema } from "ai";

export function polarInputSchema(
    input: McpTool<never>["input"] | z.ZodType,
    settle: (value: unknown) => unknown = (value) => value
): Schema<unknown> {
    const described = zodSchema(input as any);
    return jsonSchema(() => described.jsonSchema, {
        validate: async (written) => {
            const value = settle(written);
            const checked = await input.safeParseAsync(value);
            return checked.success
                ? { success: true, value }
                : { success: false, error: checked.error };
        }
    });
}

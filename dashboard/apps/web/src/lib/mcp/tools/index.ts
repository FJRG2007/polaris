/**
 * Every tool Polaris offers over MCP, in the order a client sees them.
 *
 * One list rather than a registry that things add themselves to. A tool is a
 * capability handed to a model running against somebody's repository, so what is
 * on it should be a decision somebody made in a review, visible in one diff -
 * not something that appears because a file was imported.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { TASK_TOOLS } from "./tasks";
import { SESSION_TOOLS } from "./sessions";
import type { McpTool } from "../protocol";

const whoamiInput = z.object({});

/**
 * The one tool with no scope.
 *
 * Holding a valid key is already proof of the identity it reports, so requiring a
 * scope to read it back would only mean an agent cannot tell a misconfigured key
 * from a missing permission. It is also the tool that answers "am I connected to
 * the right Polaris", which is the first thing anybody asks.
 */
const whoami: McpTool<z.infer<typeof whoamiInput>> = {
    name: "polaris_whoami",
    description: "Who this key acts as on this Polaris, and what it is allowed to do.",
    input: whoamiInput,
    scope: null,
    readOnly: true,
    async run(_input, caller) {
        const user = await prisma.user.findUnique({
            where: { id: caller.userId },
            select: { name: true, username: true, email: true }
        });
        const name = user?.name || user?.username || "somebody";
        return {
            text: `You are acting as ${name}${caller.isAdmin ? " (an administrator)" : ""}. This key may: ${
                caller.scopes.join(", ") || "nothing"
            }.`,
            structured: {
                name,
                username: user?.username ?? null,
                isAdmin: caller.isAdmin,
                scopes: caller.scopes
            }
        };
    }
};

export const MCP_TOOLS: readonly McpTool<never>[] = [
    whoami as unknown as McpTool<never>,
    ...TASK_TOOLS,
    ...SESSION_TOOLS
];

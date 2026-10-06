/**
 * Every tool Polaris offers over MCP, in the order a client sees them.
 *
 * One list rather than a registry that things add themselves to. A tool is a
 * capability handed to a model running against somebody's repository, so what is
 * on it should be a decision somebody made in a review, visible in one diff -
 * not something that appears because a file was imported.
 *
 * Core's tools only. An installable app's are its own, offered through the
 * extension registry while it is installed (`lib/mcp/catalog.ts`): Calendar's
 * among them, which is why there is no calendar file here.
 */

import { z } from "zod";
import { CHAT_SEARCH, CHAT_TOOLS } from "./chat";
import { prisma } from "@polaris/db";
import { NOTE_SEARCH, NOTE_TOOLS } from "./notes";
import { TASK_SEARCH, TASK_TOOLS } from "./tasks";
import { DRIVE_SEARCH, DRIVE_TOOLS } from "./drive";
import { DEPLOY_SEARCH, DEPLOY_TOOLS } from "./deploy";
import { SESSION_TOOLS } from "./sessions";
import type { McpTool } from "../protocol";
import { MAIL_SEARCH, MAIL_TOOLS } from "./mail";
import { DISCOVERY_TOOLS } from "./discovery";
import type { McpSearchProvider } from "../search";

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
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Who am I",
    // i18n-ignore read by the calling model, not shown to a person
    description: "Who this key acts as on this Polaris, and what it is allowed to do.",
    input: whoamiInput,
    category: "polaris",
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
    ...DISCOVERY_TOOLS,
    ...TASK_TOOLS,
    ...SESSION_TOOLS,
    ...DEPLOY_TOOLS,
    ...NOTE_TOOLS,
    ...CHAT_TOOLS,
    ...DRIVE_TOOLS,
    ...MAIL_TOOLS
];

/**
 * What `polaris_search` asks of core's apps, one provider per kind of thing
 * (`lib/mcp/search.ts`). The same kind of reviewed list as the tools; an
 * installable app's providers come from its own `mcpSearch` hook.
 */
export const MCP_SEARCH_PROVIDERS: readonly McpSearchProvider[] = [
    TASK_SEARCH,
    NOTE_SEARCH,
    CHAT_SEARCH,
    DRIVE_SEARCH,
    MAIL_SEARCH,
    DEPLOY_SEARCH
];

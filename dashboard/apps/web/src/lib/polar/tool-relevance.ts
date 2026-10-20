/**
 * Which of Polaris's tools a turn shows the model, and the two tools that are
 * always there: `read_current_view` and `find_tools`.
 *
 * Every tool the person may use is still registered on the call, so approvals,
 * scopes and the validation of older turns are unchanged. What the model is
 * SENT is a smaller set (the AI SDK's `activeTools`): the core tools, the
 * current app's, and any `find_tools` turned up. Fifty tool schemas on every
 * request were most of its input, and most of them had nothing to do with the
 * screen. The same idea as Anthropic's tool search tool and CopilotKit's
 * per-screen actions, kept provider-neutral.
 *
 * Server-only by use.
 */

import { z } from "zod";
import { tool, type ToolSet } from "ai";
import type { McpCategory } from "@/lib/mcp/scope-table";
import { fenceScreen, type PageContext } from "@/lib/polar/shared";

export const READ_CURRENT_VIEW = "read_current_view";
export const FIND_TOOLS = "find_tools";

/** One tool as the relevance rules see it. */
export interface CatalogEntry {
    readonly name: string;
    readonly description: string;
    readonly category: McpCategory;
}

/** The tool categories each app's screens are about. An app that is not here
 *  gets only the core tools, and finds the rest. */
const APP_CATEGORIES: Readonly<Record<string, readonly McpCategory[]>> = {
    drive: ["files"],
    vault: ["account"],
    account: ["account"],
    games: ["games"],
    apps: ["development", "databases", "games"],
    watch: ["development"],
    home: ["home"],
    places: ["home"],
    tasks: ["productivity"],
    notes: ["productivity"],
    office: ["productivity", "files"],
    mail: ["mail"],
    chat: ["chat"],
    calendar: ["calendar"],
    crm: ["productivity"],
    automations: ["development"]
};

/** Tools every turn carries, whatever the screen. */
const CORE_CATEGORY: McpCategory = "polaris";

/**
 * The names the model is sent this turn, in a fixed order (the catalog's), so
 * the same screen sends byte-identical tools and a provider's prefix cache
 * holds. `extra` is what earlier turns or `find_tools` already brought in.
 */
export function activeToolNames(
    catalog: readonly CatalogEntry[],
    app: string | undefined,
    always: readonly string[],
    extra: ReadonlySet<string> = new Set()
): string[] {
    const categories = new Set<McpCategory>([CORE_CATEGORY, ...(APP_CATEGORIES[app ?? ""] ?? [])]);
    const names = catalog
        .filter((entry) => categories.has(entry.category) || extra.has(entry.name))
        .map((entry) => entry.name);
    return [...always, ...names];
}

/** Lowercase words of three letters or more. */
function words(text: string): string[] {
    return text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}

/** The catalog ranked against a query: name hits count most, then the
 *  description; ties keep catalog order. At most `limit`. */
export function rankTools(
    catalog: readonly CatalogEntry[],
    query: string,
    limit = 8
): CatalogEntry[] {
    const asked = [...new Set(words(query))];
    if (asked.length === 0) return [];
    return catalog
        .map((entry, index) => {
            const name = entry.name.toLowerCase();
            const description = new Set(words(entry.description));
            let score = 0;
            for (const word of asked) {
                // "server" finds "servers"; "deployment" finds "deploy".
                const stem = word.length > 5 ? word.slice(0, 5) : word;
                if (name.includes(stem)) score += 3;
                if (entry.category.includes(stem)) score += 2;
                if ([...description].some((term) => term.startsWith(stem))) score += 1;
            }
            return { entry, score, index };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map((row) => row.entry);
}

/** Tool names `find_tools` turned up in this turn's steps so far. */
export function foundInSteps(
    steps: readonly { toolResults?: readonly { toolName: string; output: unknown }[] }[]
): Set<string> {
    const found = new Set<string>();
    for (const step of steps) {
        for (const result of step.toolResults ?? []) {
            if (result.toolName !== FIND_TOOLS) continue;
            const tools = (result.output as { tools?: { name?: unknown }[] } | null)?.tools;
            for (const entry of tools ?? []) {
                if (typeof entry.name === "string") found.add(entry.name);
            }
        }
    }
    return found;
}

/** Tool names the conversation already used or found, so a follow-up (or an
 *  approval coming back) still has them. */
export function usedInMessages(
    messages: readonly { parts: readonly { type: string; output?: unknown }[] }[]
): Set<string> {
    const used = new Set<string>();
    for (const message of messages) {
        for (const part of message.parts) {
            if (!part.type.startsWith("tool-")) continue;
            const name = part.type.slice(5);
            used.add(name);
            if (name !== FIND_TOOLS) continue;
            const tools = (part.output as { tools?: { name?: unknown }[] } | null)?.tools;
            for (const entry of tools ?? []) {
                if (typeof entry.name === "string") used.add(entry.name);
            }
        }
    }
    return used;
}

/** `find_tools`: searches every tool the person may use. Read-only. */
export function findToolsTool(catalog: readonly CatalogEntry[]): ToolSet {
    return {
        [FIND_TOOLS]: tool({
            description:
                "Find more Polaris tools by what you need to do (e.g. 'restart a deploy', 'minecraft players'). Returns names and one-line descriptions; the tools found can be called in the next step. Use it when no tool you have fits.",
            inputSchema: z.object({ query: z.string().min(1).max(200) }),
            async execute({ query }) {
                const found = rankTools(catalog, query);
                return {
                    tools: found.map((entry) => ({
                        name: entry.name,
                        description: entry.description.split(/(?<=\.)\s/)[0]!.slice(0, 200)
                    }))
                };
            }
        })
    };
}

/** How a record kind is read, through an existing tool and its own checks. */
const READERS: Readonly<Record<string, { tool: string; input: (id: string) => unknown }>> = {
    task: { tool: "tasks_get", input: (id) => ({ task: id }) },
    note: { tool: "notes_get", input: (id) => ({ noteId: id }) },
    "agent session": { tool: "agent_session_get", input: (id) => ({ sessionId: id }) },
    "chat channel": { tool: "chat_messages", input: (id) => ({ conversationId: id }) },
    "deploy project": { tool: "deploy_projects", input: () => ({}) },
    "installed app": { tool: "games_servers", input: () => ({}) }
};

/** Kinds whose content is never read for the model, whatever tools exist. */
const NEVER_READ = /vault|password|secret|api key|snippet/i;

/** Most characters of a record the model reads at once. */
export const VIEW_TEXT_MAX = 6000;

export type ToolCall = (
    name: string,
    input: unknown
) => Promise<{ ok: boolean; text: string } | null>;

/**
 * `read_current_view`: what the open record says, read as the person through
 * the tool that already reads that kind of record, capped and fenced as data.
 */
export function currentViewTool(context: PageContext | null, call: ToolCall): ToolSet {
    return {
        [READ_CURRENT_VIEW]: tool({
            description:
                "Read the record open on the person's current screen (the one in the newest <screen> note), with their access. Use it when they say 'this', 'here' or ask about what they are looking at.",
            inputSchema: z.object({}),
            async execute() {
                const screen = fenceScreen(context);
                if (!context) return { text: "The person is not sharing their screen." };
                const record = context.record;
                const reader = record ? READERS[record.kind] : undefined;
                if (!record || !reader || NEVER_READ.test(record.kind)) {
                    return {
                        text: `${screen}\nNothing more can be read from this screen directly. Use find_tools to look for a tool about it.`
                    };
                }
                const answer = await call(reader.tool, reader.input(record.id));
                if (!answer) {
                    return {
                        text: `${screen}\nThe person cannot read this ${record.kind} through Polar.`
                    };
                }
                const body =
                    answer.text.length > VIEW_TEXT_MAX
                        ? `${answer.text.slice(0, VIEW_TEXT_MAX)}\n[cut at ${VIEW_TEXT_MAX} characters]`
                        : answer.text;
                return {
                    text: [
                        screen,
                        "<untrusted_page_data>",
                        body.replace(/<\/?untrusted_page_data>/gi, ""),
                        "</untrusted_page_data>"
                    ].join("\n")
                };
            }
        })
    };
}

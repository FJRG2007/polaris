/**
 * Which of Polaris's tools a turn shows the model, and the two tools Polar
 * adds beside the MCP server's own: `read_current_view` and `find_tools`.
 *
 * Polaris reaches Polar as one MCP connector (`tools.ts`), and the model is
 * sent its discovery tools, not its catalogue: `polaris_search` finds a thing
 * and names the tools that act on it, `polaris_tools` lists the tools by
 * category, and `find_tools` loads tools by name or by what they do. A tool
 * any of them turns up is sent from the next step on (the AI SDK's
 * `activeTools`), and stays for the rest of the conversation. Every tool the
 * person may use is still registered on the call, so approvals, scopes and the
 * validation of older turns are unchanged. A hundred tool schemas on every
 * request were most of its input; the same idea as Anthropic's tool search
 * tool, kept provider-neutral.
 *
 * Server-only by use.
 */

import { z } from "zod";
import type { McpCategory } from "@/lib/mcp/scope-table";
import { tool, type FlexibleSchema, type ToolSet } from "ai";
import { fenceSite, fenceScreen, type PageContext } from "@/lib/polar/shared";

export const READ_CURRENT_VIEW = "read_current_view";
export const FIND_TOOLS = "find_tools";

/** One tool as `find_tools` searches it: a Polaris category, or the name of
 *  the connector it comes from. */
export interface SearchEntry {
    readonly name: string;
    readonly description: string;
    readonly category: string;
}

/** One of Polaris's own tools as the relevance rules see it. */
export interface CatalogEntry extends SearchEntry {
    readonly category: McpCategory;
}

/** The MCP server's own discovery tools, sent on every turn the person has
 *  them on: finding a thing, and listing the tools by category. */
export const DISCOVERY_TOOL_NAMES: readonly string[] = ["polaris_search", "polaris_tools"];

/** Most tools one discovery answer loads. A list longer than this is a
 *  catalogue to read, not a choice made: the model loads from it by name. */
export const LOAD_MAX = 12;

/**
 * The names the model is sent this turn, in a fixed order (the catalog's), so
 * the same conversation sends byte-identical tools and a provider's prefix
 * cache holds: `always`, the discovery tools, and `extra` - what earlier turns
 * used or discovery already loaded. Nothing else of the catalogue is sent.
 */
export function activeToolNames(
    catalog: readonly SearchEntry[],
    always: readonly string[],
    extra: ReadonlySet<string> = new Set()
): string[] {
    const discovery = new Set(DISCOVERY_TOOL_NAMES);
    const names = catalog
        .filter((entry) => discovery.has(entry.name) || extra.has(entry.name))
        .map((entry) => entry.name);
    return [...always, ...names];
}

/** Most loaded tools one request carries, beside the ones always sent. A long
 *  conversation that has reached for many tools keeps the newest. */
export const LOADED_MAX = 40;

/**
 * The loaded tools a step is sent: what this turn's discovery found first,
 * then what earlier turns used, newest first, at most `LOADED_MAX`.
 */
export function boundedLoad(
    found: ReadonlySet<string>,
    used: ReadonlySet<string>
): Set<string> {
    return new Set([...found, ...[...used].reverse()].slice(0, LOADED_MAX));
}

/** A tool result as the chat holds it: Polaris's tools answer `{ ok, text,
 *  data }`, `data` being the MCP server's structured content. */
function dataOf(output: unknown): Record<string, unknown> | null {
    const data = (output as { data?: unknown } | null)?.data;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

/**
 * The tool names one discovery call loaded, read from its answer: every tool
 * `find_tools` returned; the tools `polaris_search` named for its matches; and
 * the tools `polaris_tools` listed for an intent when that is a short list the
 * person may call. Anything else loads nothing.
 */
export function loadedBy(toolName: string, output: unknown): string[] {
    const names: string[] = [];
    const add = (name: unknown) => {
        if (typeof name === "string" && !names.includes(name)) names.push(name);
    };
    if (toolName === FIND_TOOLS) {
        const tools = (output as { tools?: { name?: unknown }[] } | null)?.tools;
        for (const entry of Array.isArray(tools) ? tools : []) add(entry?.name);
        return names;
    }
    const data = dataOf(output);
    if (!data) return names;
    if (toolName === "polaris_search") {
        const results = Array.isArray(data.results) ? data.results : [];
        for (const result of results as { next?: { tool?: unknown }[] }[]) {
            for (const step of Array.isArray(result?.next) ? result.next : []) add(step?.tool);
        }
        return names.slice(0, LOAD_MAX);
    }
    if (toolName === "polaris_tools") {
        const groups = Array.isArray(data.categories) ? data.categories : [];
        const rows = (groups as { tools?: { name?: unknown; needs?: unknown }[] }[]).flatMap(
            (group) => (Array.isArray(group?.tools) ? group.tools : [])
        );
        const callable = rows.filter((row) => !Array.isArray(row?.needs) || row.needs.length === 0);
        if (data.matched !== true || callable.length > LOAD_MAX) return names;
        for (const row of callable) add(row.name);
    }
    return names;
}

/** Lowercase words of three letters or more, in any script. */
function words(text: string): string[] {
    return text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

/** Most tool names `find_tools` lists per area when nothing matched. */
const AREA_SAMPLE = 6;

/**
 * Every area the person has tools in, with a few tool names each, for a search
 * that matched nothing - a query in another language, or words no description
 * uses - so the next search, or the next call, lands instead of the model
 * concluding that Polaris cannot do it.
 */
export function toolAreas(
    catalog: readonly SearchEntry[]
): { area: string; count: number; tools: string[] }[] {
    const areas = new Map<string, { count: number; tools: string[] }>();
    for (const entry of catalog) {
        const area = areas.get(entry.category) ?? { count: 0, tools: [] };
        area.count += 1;
        if (area.tools.length < AREA_SAMPLE) area.tools.push(entry.name);
        areas.set(entry.category, area);
    }
    return [...areas].map(([area, { count, tools }]) => ({ area, count, tools }));
}

/** Most tools `find_tools` lists for one area. */
export const AREA_LIST_MAX = 60;

/** The catalog ranked against a query: name hits count most, then the
 *  description; ties keep catalog order. At most `limit`. */
export function rankTools<T extends SearchEntry>(
    catalog: readonly T[],
    query: string,
    limit = 8
): T[] {
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

/**
 * What the next step of a turn may do. The tools `find_tools` turned up are sent
 * from the step after; the turn's last step may call none, so a turn that spends
 * its whole budget looking still ends in an answer instead of stopping on a tool
 * call with nothing said.
 */
export function nextStep<T extends string>(
    stepNumber: number,
    stepMax: number,
    steps: Parameters<typeof foundInSteps>[0],
    activeFor: (found: ReadonlySet<string>) => T[]
): { activeTools?: T[]; toolChoice?: "none" } | undefined {
    const found = foundInSteps(steps);
    const last = stepNumber >= stepMax - 1;
    if (!last && found.size === 0) return undefined;
    return {
        ...(found.size > 0 ? { activeTools: activeFor(found) } : {}),
        ...(last ? { toolChoice: "none" as const } : {})
    };
}

/** Tool names discovery loaded in this turn's steps so far. */
export function foundInSteps(
    steps: readonly { toolResults?: readonly { toolName: string; output: unknown }[] }[]
): Set<string> {
    const found = new Set<string>();
    for (const step of steps) {
        for (const result of step.toolResults ?? []) {
            for (const name of loadedBy(result.toolName, result.output)) found.add(name);
        }
    }
    return found;
}

/** Tool names the conversation already used or loaded, so a follow-up (or an
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
            for (const loaded of loadedBy(name, part.output)) used.add(loaded);
        }
    }
    return used;
}

/** A plain object, not a refined one: some providers refuse a tool whose
 *  schema is not `type: object` at the top. Neither field given finds nothing,
 *  and the answer lists the areas to search in. */
const findToolsInput = z.object({
    query: z.string().max(200).optional().describe("What you need to do, in English."),
    names: z
        .array(z.string().max(64))
        .max(LOAD_MAX)
        .optional()
        .describe("Exact tool names to load."),
    area: z
        .string()
        .max(200)
        .optional()
        .describe("An area from an earlier answer: lists every tool in it, without loading.")
});

/** A description's first sentence, capped: what a tool is for. */
function firstSentence(description: string, max: number): string {
    return description.split(/(?<=\.)\s/)[0]!.slice(0, max);
}

/** `find_tools`: loads tools the person may use, by name or by what they do.
 *  Read-only. */
export function findToolsTool(catalog: readonly SearchEntry[]): ToolSet {
    return {
        [FIND_TOOLS]: tool({
            description:
                "Load tools - Polaris's own and those of the person's connected MCP servers - so you can call them in the next step: by exact names (from an earlier answer, polaris_tools or polaris_search), or by what you need to do. Always write the query in English, whatever language the person used: translate their request first (e.g. 'restart a deploy', 'minecraft players', 'turn off a device'). Returns names and one-line descriptions. Use it when no tool you have fits, and before ever saying something cannot be done. When nothing matches it lists the areas the person has tools in: pass one as `area` to list its tools, then load the ones you need by name.",
            inputSchema: findToolsInput as unknown as FlexibleSchema<
                z.infer<typeof findToolsInput>
            >,
            async execute({ query, names, area }) {
                // Browsing one area reads no words at all, so it works whatever
                // language the person asked in. It lists; it does not load,
                // since an area can hold hundreds of tools.
                if (area && !query?.trim() && !names?.length) {
                    const listed = catalog.filter((entry) => entry.category === area);
                    if (listed.length > 0) {
                        return {
                            tools: [],
                            area,
                            listed: listed.slice(0, AREA_LIST_MAX).map((entry) => ({
                                name: entry.name,
                                description: firstSentence(entry.description, 120)
                            })),
                            note: "Listed, not loaded: call find_tools with the names you need."
                        };
                    }
                }
                const asked = new Set(names ?? []);
                const named = catalog.filter((entry) => asked.has(entry.name));
                const ranked = query?.trim() ? rankTools(catalog, query) : [];
                const found = [
                    ...named,
                    ...ranked.filter((entry) => !asked.has(entry.name))
                ].slice(0, LOAD_MAX);
                const unknown = [...asked].filter(
                    (name) => !named.some((entry) => entry.name === name)
                );
                // Only in the answer when there is one: older turns read
                // `{ tools }` and nothing else.
                const unavailable =
                    unknown.length > 0
                        ? {
                              unavailable: unknown,
                              unavailableNote:
                                  "Not tools the person has on: switched off, not theirs to use, or misspelled."
                          }
                        : {};
                if (found.length === 0) {
                    return {
                        tools: [],
                        note: "No tool matched. Search again in English with the words of an area below, or with one of the tool names listed.",
                        areas: toolAreas(catalog),
                        ...unavailable
                    };
                }
                return {
                    tools: found.map((entry) => ({
                        name: entry.name,
                        description: firstSentence(entry.description, 200)
                    })),
                    ...unavailable
                };
            }
        })
    };
}

/** How a record kind is read, through an existing tool and its own checks. */
const READERS: Readonly<Record<string, { tool: string; input: (id: string) => unknown }>> = {
    task: { tool: "tasks_get", input: (id) => ({ task: id }) },
    note: { tool: "notes_get", input: (id) => ({ noteId: id }) },
    automation: { tool: "automations_get", input: (id) => ({ automation: id }) },
    "agent session": { tool: "agent_session_get", input: (id) => ({ sessionId: id }) },
    "chat channel": { tool: "chat_messages", input: (id) => ({ conversationId: id }) }
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
            inputSchema: z.object({}) as unknown as FlexibleSchema<Record<string, never>>,
            async execute() {
                const screen = fenceScreen(context);
                if (!context) return { text: "The person is not sharing their screen." };
                // A page outside Polaris: its own words, fenced as the site's.
                if (context.site) return { text: `${screen}\n${fenceSite(context.site)}` };
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

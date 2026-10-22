/**
 * Every MCP tool that changes something, offered as a deck action.
 *
 * Rather than one hand-written deck action per tool, a key can be set to any
 * tool an assistant could call with this key, and the press goes through
 * `callTool` - the live catalogue, the key's scope, the tool's own schema, its
 * budgets and its audit, exactly as the MCP endpoint applies them. The fields
 * are read from the tool's input schema; a field that names one of the
 * person's own things (a device, a conversation) is a picker of them.
 *
 * Left out: read-only tools (a key has nothing to show of an arbitrary answer;
 * the state keys cover what is worth showing), and a tool whose input a
 * settings screen cannot fill (a list, an object) where it is required. A tool
 * that can destroy or overwrite something asks for a second press.
 *
 * Server-only.
 */

import { callTool, mcpCallerFor } from "./tool-call";
import { mcpTools } from "@/lib/mcp/catalog";
import { callerMayUse, type McpTool } from "@/lib/mcp/protocol";
import { toJsonSchema, type JsonSchema } from "@/lib/mcp/json-schema";
import type { DeckActionView, DeckCaller, DeckOptionField } from "./types";

/** The id a tool is offered under. */
export const TOOL_PREFIX = "tool.";

/** A field that names one of the person's own things, and the tool that lists
 *  them. Its answer's first list of rows with an `id` is the picker. */
const ID_SOURCES: Readonly<Record<string, string>> = {
    deviceId: "places_devices",
    routineId: "places_routines",
    conversationId: "chat_conversations",
    calendarId: "calendar_calendars",
    sessionId: "agent_sessions_list"
};

/** The most choices one picker carries. */
const CHOICE_LIMIT = 100;

/** A field as the settings screen draws it, or null when it cannot be one. */
interface ToolField {
    readonly name: string;
    readonly type: DeckOptionField["type"];
    readonly required: boolean;
    readonly boolean?: boolean;
    readonly enum?: readonly string[];
    readonly min?: number;
    readonly max?: number;
    readonly source?: string;
}

/** The fields of a tool's input, or null when a required one is nothing a
 *  settings screen can fill. Optional ones it cannot fill are left out. */
export function toolFields(schema: JsonSchema): ToolField[] | null {
    if (schema.type !== "object" && !schema.properties) return [];
    const required = new Set(schema.required ?? []);
    const fields: ToolField[] = [];
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
        const field = fieldOf(name, property, required.has(name));
        if (field) fields.push(field);
        else if (required.has(name)) return null;
    }
    return fields;
}

function fieldOf(name: string, property: JsonSchema, required: boolean): ToolField | null {
    const type = Array.isArray(property.type) ? property.type[0] : property.type;
    const strings = property.enum?.every((value) => typeof value === "string");
    if (property.enum && strings) {
        return { name, type: "choice", required, enum: property.enum as string[] };
    }
    if (type === "boolean") return { name, type: "choice", required, boolean: true };
    if (type === "number" || type === "integer") {
        return {
            name,
            type: "number",
            required,
            ...(property.minimum === undefined ? {} : { min: property.minimum }),
            ...(property.maximum === undefined ? {} : { max: property.maximum })
        };
    }
    if (type === "string") {
        const source = ID_SOURCES[name];
        return source
            ? { name, type: "choice", required, source }
            : { name, type: "text", required };
    }
    return null;
}

/** The rows of a listing tool's answer, as choices. */
export function rowsOf(structured: unknown): { value: string; label: string }[] {
    if (!structured || typeof structured !== "object") return [];
    for (const value of Object.values(structured as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const rows = value.filter(
            (row): row is Record<string, unknown> =>
                !!row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
        );
        if (rows.length === 0) continue;
        return rows.slice(0, CHOICE_LIMIT).map((row) => {
            const name = [row.name, row.title, row.label].find(
                (candidate) => typeof candidate === "string" && candidate.trim() !== ""
            );
            return {
                value: row.id as string,
                label: (name as string | undefined) ?? (row.id as string)
            };
        });
    }
    return [];
}

/** A tool a key can be set to, with its fields. */
export interface DeckTool {
    readonly id: string;
    readonly tool: McpTool<never>;
    readonly fields: readonly ToolField[];
}

/** Every tool that changes something, that this key may call, whose input a
 *  settings screen can fill. */
export async function deckTools(caller: DeckCaller): Promise<DeckTool[]> {
    const mcp = mcpCallerFor(caller);
    const offered: DeckTool[] = [];
    for (const tool of await mcpTools()) {
        if (tool.readOnly || !callerMayUse(tool, mcp)) continue;
        let fields: ToolField[] | null;
        try {
            fields = toolFields(toJsonSchema(tool.input as never));
        } catch {
            // A schema the converter does not take is a tool no screen can fill.
            fields = null;
        }
        if (fields) offered.push({ id: `${TOOL_PREFIX}${tool.name}`, tool, fields });
    }
    return offered;
}

/** One tool as the catalogue hands it out. The tool's title is English: MCP
 *  tools are named for the model and the client, which have no locale. */
export async function toolView(entry: DeckTool, caller: DeckCaller): Promise<DeckActionView> {
    const options: DeckOptionField[] = await Promise.all(
        entry.fields.map(async (field) => {
            let choices: { value: string; label: string }[] | undefined;
            if (field.enum) choices = field.enum.map((value) => ({ value, label: value }));
            else if (field.boolean)
                choices = [
                    { value: "true", label: "true" },
                    { value: "false", label: "false" }
                ];
            else if (field.source) {
                const outcome = await callTool(caller, field.source, {});
                choices = outcome.ok ? rowsOf(outcome.structured) : [];
            }
            return {
                name: field.name,
                type: field.type,
                label: spokenName(field.name),
                required: field.required,
                ...(field.min === undefined ? {} : { min: field.min }),
                ...(field.max === undefined ? {} : { max: field.max }),
                ...(choices ? { choices } : {})
            };
        })
    );
    return {
        id: entry.id,
        kind: "run",
        area: "tools",
        label: entry.tool.title ?? entry.tool.name,
        icon: "zap",
        options,
        live: false,
        ...(entry.tool.destructive === false ? {} : { confirm: true })
    };
}

/** A field's name as a label: `deviceId` is "Device", `maxPlayers` is
 *  "Max players". */
export function spokenName(name: string): string {
    const words = name
        .replace(/Id$/, "")
        .replace(/_/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A key's settings as the tool takes them: only its own fields, a picked
 *  "true" or "false" as the boolean it stands for. The tool's schema decides
 *  the rest. */
export function toolInput(
    entry: DeckTool,
    options: Record<string, unknown>
): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    for (const field of entry.fields) {
        const value = options[field.name];
        if (value === undefined || value === null || value === "") continue;
        input[field.name] = field.boolean ? value === true || value === "true" : value;
    }
    return input;
}

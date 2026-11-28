/**
 * The MCP tools an installed app declares in its manifest (docs/addons-delivery.md):
 * name, words, the one permission of the app's own a caller needs, typed input
 * fields and a typed answer. Registered when the manifest is read, so the host
 * knows a tool's shape and gate before the app's bundle is loaded; the bundle
 * only does the work, and its answer is checked against what was declared.
 */

import { z } from "zod";
import {
    appFieldsReadable,
    appOutputReadable,
    appStepConfigSchema,
    parseAppStepOutput,
    type AppStepField,
    type AppStepOutputKind
} from "./automation-app-steps.js";

export interface AppMcpToolDefinition {
    /** `<app id with "_" for "-">_<name>`: a name a model can address, under the app. */
    readonly name: string;
    readonly title: string;
    /** What it does and does not, for the model choosing it. */
    readonly description: string;
    /** What the caller needs: one of the app's own permissions, also the scope a key must carry. */
    readonly permission: string;
    readonly readOnly: boolean;
    readonly destructive?: boolean;
    readonly fields: readonly AppStepField[];
    /** The answer's own fields. */
    readonly output: Readonly<Record<string, AppStepOutputKind>>;
    /** When it answers a list: each item's fields, under `items`. */
    readonly items?: Readonly<Record<string, AppStepOutputKind>>;
}

export interface RegisteredAppMcpTool extends AppMcpToolDefinition {
    readonly app: string;
}

const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for("polaris.app-mcp-tools")] ??= new Map()) as Map<
    string,
    RegisteredAppMcpTool
>;

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_TOOLS = 32;
/** The most items a declared list answer carries. */
export const APP_MCP_TOOL_MAX_ITEMS = 200;

/** The prefix every tool of `app` is named under. */
export function appMcpToolPrefix(app: string): string {
    return `${app.replaceAll("-", "_")}_`;
}

/**
 * Register (or replace) the tools an app declares. One outside the app's
 * prefix, behind a permission that is not the app's, or with an unreadable
 * field or answer is left out.
 */
export function registerAppMcpTools(app: string, definitions: readonly AppMcpToolDefinition[]): void {
    for (const [name, tool] of registry) if (tool.app === app) registry.delete(name);
    for (const definition of definitions.slice(0, MAX_TOOLS)) {
        if (!TOOL_NAME.test(definition.name) || !definition.name.startsWith(appMcpToolPrefix(app))) continue;
        if (!definition.permission.startsWith(`${app}.`)) continue;
        if (!appFieldsReadable(definition.fields) || !appOutputReadable(definition.output)) continue;
        if (definition.items && (!appOutputReadable(definition.items) || "items" in definition.output)) continue;
        registry.set(definition.name, {
            ...definition,
            app,
            title: definition.title.slice(0, 80),
            description: definition.description.slice(0, 500)
        });
    }
}

/** Forget every app's tools except those of `keep`. */
export function retainAppMcpTools(keep: Iterable<string>): void {
    const kept = new Set(keep);
    for (const [name, tool] of registry) if (!kept.has(tool.app)) registry.delete(name);
}

/** Every declared tool, in the order the apps declared them. */
export function appMcpToolDefinitions(): RegisteredAppMcpTool[] {
    return [...registry.values()];
}

/** A tool's input as its fields declare it: strict, nothing undeclared rides along. */
export function appMcpToolInputSchema(tool: Pick<AppMcpToolDefinition, "fields">): z.ZodType<Record<string, unknown>> {
    return appStepConfigSchema(tool);
}

/** A tool's answer checked against what it declared: the data, or null when it does not match. */
export function parseAppMcpToolOutput(
    tool: Pick<AppMcpToolDefinition, "output" | "items">,
    value: unknown
): Record<string, unknown> | null {
    if (!value || typeof value !== "object") return null;
    const { items, ...rest } = value as Record<string, unknown>;
    const own = parseAppStepOutput(tool, rest);
    if (!own) return null;
    if (!tool.items) return items === undefined ? own : null;
    if (!Array.isArray(items) || items.length > APP_MCP_TOOL_MAX_ITEMS) return null;
    const parsed: Record<string, unknown>[] = [];
    for (const item of items) {
        const one = parseAppStepOutput({ output: tool.items }, item);
        if (!one) return null;
        parsed.push(one);
    }
    return { ...own, items: parsed };
}

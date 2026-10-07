/**
 * What each scope lets a connected app do, as a person reads it: the tools a
 * scope opens, named in their language. It is the list behind a permission's
 * info button on the consent screen and on a connected app's permissions.
 *
 * Read from the tools themselves rather than written beside the scopes, so a
 * tool added to a scope is on the list the day it ships. Core's tools are
 * named in the dashboard's catalog (`mcp.tools.<name>`), an installed app's in
 * its own (`mcpToolLabels`); a tool neither names falls back to its English
 * title, and a test holds every catalogue to naming all of them.
 *
 * Server-only.
 */

import type { Locale } from "@polaris/core";
import type { McpScope } from "./scope-table";
import { pickMessages } from "@/lib/i18n/translate";
import { toolScopes, type McpTool } from "./protocol";

/** One thing a scope lets an app do. */
export interface ScopeAbility {
    readonly name: string;
    readonly label: string;
    /** Whether it only looks: the list marks the ones that change something. */
    readonly readOnly: boolean;
}

/** Each scope's abilities, in the order the tools are listed. */
export type ScopeAbilities = Partial<Record<McpScope, readonly ScopeAbility[]>>;

/** Group tools under every scope that opens them. Pure, for the tests. */
export function abilitiesOf(
    tools: readonly McpTool<never>[],
    label: (tool: McpTool<never>) => string,
    wanted?: ReadonlySet<McpScope>
): ScopeAbilities {
    const found: Partial<Record<McpScope, ScopeAbility[]>> = {};
    for (const tool of tools) {
        for (const scope of toolScopes(tool)) {
            if (wanted && !wanted.has(scope)) continue;
            (found[scope] ??= []).push({
                name: tool.name,
                label: label(tool),
                readOnly: tool.readOnly
            });
        }
    }
    return found;
}

/** The names core's catalog gives its own tools, in one locale. */
export function coreToolLabels(locale: Locale): Readonly<Record<string, string>> {
    const mcp = pickMessages(locale, ["mcp"]).mcp as { tools?: Record<string, string> } | undefined;
    return mcp?.tools ?? {};
}

/** The abilities of the scopes asked about, as the reader reads them. */
export async function scopeAbilities(
    locale: Locale,
    scopes: readonly McpScope[]
): Promise<ScopeAbilities> {
    // Loaded when asked: the catalogue reaches every tool module, which the
    // pages that import this for its types have no need of.
    const [{ mcpTools }, { appMcpToolLabels }] = await Promise.all([
        import("./catalog"),
        import("@/lib/app-extensions/registry")
    ]);
    const [tools, apps] = await Promise.all([mcpTools(), appMcpToolLabels(locale)]);
    const core = coreToolLabels(locale);
    return abilitiesOf(
        tools,
        (tool) => core[tool.name] ?? apps.get(tool.name) ?? tool.title ?? tool.name,
        new Set(scopes)
    );
}

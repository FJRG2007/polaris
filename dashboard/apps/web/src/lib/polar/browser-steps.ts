/**
 * The names of Polar's browser_* tools and how a step of one reads, for the
 * chat's cards and step lines. Pure and client-safe: the tools themselves are
 * in `browser-tools.ts`, which is server-only.
 */

export const BROWSER_TOOLS = {
    open: "browser_open",
    read: "browser_read",
    find: "browser_find",
    click: "browser_click",
    type: "browser_type",
    close: "browser_close"
} as const;

export type BrowserStepKind = "open" | "read" | "find" | "click" | "type" | "close";

const BROWSER_NAMES: ReadonlySet<string> = new Set(Object.values(BROWSER_TOOLS));

/** Whether a tool name is one of these. */
export function isBrowserTool(name: string): boolean {
    return BROWSER_NAMES.has(name);
}

/** What a browser call does and on which site, or null for another tool. */
export function browserStepOf(
    name: string,
    input: unknown
): { kind: BrowserStepKind; site: string; element: string } | null {
    if (!isBrowserTool(name)) return null;
    const kind = name.slice("browser_".length) as BrowserStepKind;
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    let site = typeof record.site === "string" ? record.site : "";
    if (kind === "open" && typeof record.url === "string") {
        try {
            site = new URL(record.url).host;
        } catch {
            site = record.url;
        }
    }
    const element = typeof record.element === "string" ? record.element : "";
    return { kind, site: site.slice(0, 120), element: element.slice(0, 120) };
}

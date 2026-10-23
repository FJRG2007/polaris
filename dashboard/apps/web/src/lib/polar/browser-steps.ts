/**
 * The name of Polar's browser tool and how a step of it reads, for the chat's
 * cards and step lines. Pure and client-safe: the tool itself is in
 * `browser-tools.ts`, which is server-only.
 *
 * One tool, `browser`, with an `action`. The six `browser_*` tools it replaced
 * are still recognised here so a stored conversation that used them reads the
 * same as it did.
 */

export const BROWSER_TOOL = "browser";

/** The tools before `browser`: never offered, still read from old threads. */
export const BROWSER_TOOLS = {
    open: "browser_open",
    read: "browser_read",
    find: "browser_find",
    click: "browser_click",
    type: "browser_type",
    close: "browser_close"
} as const;

export const BROWSER_ACTIONS = [
    "open",
    "read",
    "find",
    "click",
    "type",
    "key",
    "scroll",
    "hover",
    "select",
    "back",
    "forward",
    "reload",
    "wait",
    "close"
] as const;
export type BrowserStepKind = (typeof BROWSER_ACTIONS)[number];

const LEGACY_NAMES: ReadonlySet<string> = new Set(Object.values(BROWSER_TOOLS));
const ACTIONS: ReadonlySet<string> = new Set(BROWSER_ACTIONS);

/** Whether a tool name is the browser tool, or one it replaced. */
export function isBrowserTool(name: string): boolean {
    return name === BROWSER_TOOL || LEGACY_NAMES.has(name);
}

/** What a browser call does and on which site, or null for another tool. */
export function browserStepOf(
    name: string,
    input: unknown
): { kind: BrowserStepKind; site: string; element: string } | null {
    if (!isBrowserTool(name)) return null;
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const kind =
        name === BROWSER_TOOL
            ? typeof record.action === "string" && ACTIONS.has(record.action)
                ? (record.action as BrowserStepKind)
                : "read"
            : (name.slice("browser_".length) as BrowserStepKind);
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

/** The reason the chat's card stores when the person picks "Always for this
 *  site"; the tool passes it to the extension as the answer to open on. */
export const ALWAYS_SITE_REASON = "always-site";

/** Whether a message has a browser call that found no extension connected. */
export function noBrowserIn(
    parts: readonly { type: string; toolName?: string; state?: string; output?: unknown }[]
): boolean {
    return parts.some((part) => {
        const name = part.type === "dynamic-tool" ? (part.toolName ?? "") : part.type.slice(5);
        if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") return false;
        if (!isBrowserTool(name) || part.state !== "output-available") return false;
        return (part.output as { noBrowser?: unknown } | null)?.noBrowser === true;
    });
}

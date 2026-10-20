/**
 * The sites a Polar answer was built from, worked out from the parts the chat
 * stream already delivered - no extra event, no stored copy.
 *
 * A source is anything that put a page in front of the model: a `source-url`
 * part (what a provider's own web search reports), a result of Polaris's own
 * `search_web`, a page `read_page` opened. They are numbered in the order they
 * first appeared, and a link in the answer that points at one of them becomes
 * that number, so an answer cites the way ChatGPT's and Claude's do whichever
 * provider wrote it.
 *
 * Pure, so the panel and the tests read one answer.
 */

/** Polaris's own web tools, run on this server for a model with no search of its own. */
export const SEARCH_TOOL = "search_web";
export const READ_TOOL = "read_page";
/** The names a provider's own search tool is registered under. */
export const NATIVE_SEARCH_TOOLS = ["web_search", "google_search"] as const;

/** Every tool name that is a search, for counting and for the step rows. */
export const SEARCH_TOOLS: readonly string[] = [SEARCH_TOOL, ...NATIVE_SEARCH_TOOLS];

export function isWebTool(name: string): boolean {
    return name === READ_TOOL || SEARCH_TOOLS.includes(name);
}

export interface WebSource {
    url: string;
    title: string;
    /** The site, as the chip and the list show it. */
    host: string;
}

/** The slice of a message part this needs. */
export interface SourcePart {
    type: string;
    url?: string;
    title?: string;
    toolName?: string;
    state?: string;
    output?: unknown;
}

/** The site of an address, without the `www.`; null for anything not http(s). */
export function hostOf(address: string): string | null {
    try {
        const url = new URL(address);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.hostname.replace(/^www\./, "");
    } catch {
        return null;
    }
}

function toolOf(part: SourcePart): string | null {
    if (part.type === "dynamic-tool") return part.toolName ?? null;
    if (part.type.startsWith("tool-")) return part.type.slice(5);
    return null;
}

/** The pages one finished tool call reports, whatever the tool. */
function pagesOf(name: string, output: unknown): { url: string; title?: string }[] {
    if (!output || typeof output !== "object") {
        return [];
    }
    if (Array.isArray(output)) {
        // A provider's search: a list of results, each with a url and a title.
        return output.flatMap((entry) =>
            entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string"
                ? [{ url: (entry as { url: string }).url, title: titleOf(entry) }]
                : []
        );
    }
    const record = output as { results?: unknown; url?: unknown; title?: unknown; ok?: unknown };
    if (record.ok === false) return [];
    if (name === SEARCH_TOOL && Array.isArray(record.results)) return pagesOf(name, record.results);
    if (name === READ_TOOL && typeof record.url === "string") {
        return [{ url: record.url, title: typeof record.title === "string" ? record.title : undefined }];
    }
    return [];
}

function titleOf(entry: object): string | undefined {
    const title = (entry as { title?: unknown }).title;
    return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/** Every source of one message, numbered by first appearance, each once. */
export function sourcesOf(parts: readonly SourcePart[]): WebSource[] {
    const found = new Map<string, WebSource>();
    const add = (url: string, title: string | undefined) => {
        const host = hostOf(url);
        if (!host) return;
        const known = found.get(url);
        if (known) {
            if (known.title === known.host && title) known.title = title;
            return;
        }
        found.set(url, { url, title: title || host, host });
    };
    for (const part of parts) {
        if (part.type === "source-url" && typeof part.url === "string") {
            add(part.url, part.title);
            continue;
        }
        const name = toolOf(part);
        if (!name || !isWebTool(name) || part.state !== "output-available") continue;
        for (const page of pagesOf(name, part.output)) add(page.url, page.title);
    }
    return [...found.values()];
}

/** A markdown link: `[label](address)`, with the address free of spaces and brackets. */
const LINK = /\[([^\]\n]*)\]\((https?:\/\/[^\s()]+)\)/g;

/**
 * The answer with each link to a source replaced by that source's number, as
 * `[n]` linking to the page. A link to anything else is left as written.
 */
export function citeSources(text: string, sources: readonly WebSource[]): string {
    if (sources.length === 0) return text;
    const numbers = new Map(sources.map((source, index) => [source.url, index + 1]));
    return text.replace(LINK, (whole, _label: string, address: string) => {
        const number = numbers.get(address);
        return number ? `[\\[${number}\\]](${address})` : whole;
    });
}

/** How many searches and page reads a message made, for the line under it. */
export function webCallsOf(parts: readonly SourcePart[]): { searches: number; pages: number } {
    let searches = 0;
    let pages = 0;
    for (const part of parts) {
        const name = toolOf(part);
        if (!name || part.state !== "output-available") continue;
        if (SEARCH_TOOLS.includes(name)) searches += 1;
        else if (name === READ_TOOL) pages += 1;
    }
    return { searches, pages };
}

/** What a web step is doing, for its row: the query searched or the site read. */
export function webStepOf(name: string, input: unknown): { kind: "search" | "read"; detail: string } | null {
    if (!isWebTool(name)) return null;
    const record = (input && typeof input === "object" ? input : {}) as {
        query?: unknown;
        url?: unknown;
    };
    if (name === READ_TOOL) {
        const address = typeof record.url === "string" ? record.url : "";
        return { kind: "read", detail: hostOf(address) ?? address };
    }
    return { kind: "search", detail: typeof record.query === "string" ? record.query : "" };
}

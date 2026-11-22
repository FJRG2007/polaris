/**
 * What the launcher window and the main process say to each other, and the
 * ranking of what it lists. The window draws rows and sends back the id of the
 * one chosen; what a row does stays in the main process, so the page can never
 * ask to open an arbitrary address or program.
 */

export const LAUNCHER_CHANNELS = {
    query: "launcher:query",
    run: "launcher:run",
    hide: "launcher:hide",
    opened: "launcher:opened",
    clearClipboard: "launcher:clear-clipboard"
} as const;

export type LauncherRowKind = "answer" | "polaris" | "page" | "app" | "polar" | "web" | "clip";

export interface LauncherRow {
    readonly id: string;
    readonly kind: LauncherRowKind;
    readonly title: string;
    readonly subtitle: string;
}

export interface LauncherAnswer {
    readonly rows: readonly LauncherRow[];
    /** Why Polaris results are missing, when they are: signed out, unreachable. */
    readonly notice: string | null;
}

/** The bridge the launcher page gets as `window.polarisLauncher`. */
export interface PolarisLauncher {
    query(text: string): Promise<LauncherAnswer>;
    run(id: string): Promise<boolean>;
    hide(): Promise<void>;
    clearClipboard(): Promise<void>;
    onOpened(listener: () => void): void;
}

/** Something listed: its name, its context line and the words it is found by. */
export interface Searchable {
    readonly label: string;
    readonly context: string;
}

/**
 * How well `query` finds `item`, or 0 for not at all: the whole name first,
 * then its start, a word's start, anywhere in it, its letters in order, and
 * last a match in the context line.
 */
export function matchScore(query: string, item: Searchable): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    const label = item.label.toLowerCase();
    if (label === q) return 100;
    if (label.startsWith(q)) return 80;
    if (label.split(/[\s\-_/.]+/).some((word) => word.startsWith(q))) return 60;
    if (label.includes(q)) return 40;
    let at = 0;
    for (const char of label) if (char === q[at]) at += 1;
    if (at === q.length && q.length >= 2) return 20;
    if (item.context.toLowerCase().includes(q)) return 10;
    return 0;
}

/** The best `limit` matches, best first; ties keep their order. */
export function topMatches<T extends Searchable>(query: string, items: readonly T[], limit: number): T[] {
    return items
        .map((item, index) => ({ item, index, score: matchScore(query, item) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.item);
}

/** The search engines a web search can go to, the first the default. */
export const SEARCH_ENGINES = {
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
    brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=" }
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;

export const SEARCH_ENGINE_IDS = Object.keys(SEARCH_ENGINES) as [SearchEngine, ...SearchEngine[]];

export function webSearchUrl(engine: SearchEngine, query: string): string {
    return `${SEARCH_ENGINES[engine].url}${encodeURIComponent(query.trim())}`;
}

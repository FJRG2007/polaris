/**
 * Searching Modrinth for mods and plugins.
 *
 * The search runs on the server, not in the browser: the dashboard should not
 * make the operator's machine talk to a third party to render a page, and the
 * response is other people's text, so it is validated into a known shape before
 * anything renders it. Nothing is downloaded here - the image installs what
 * MODRINTH_PROJECTS lists when it boots, which is also how it removes what was
 * taken off the list.
 */

import { z } from "zod";

/** Modrinth asks API clients to identify themselves. */
const USER_AGENT = "polaris-dashboard (https://github.com/FJRG2007/polaris)";

const SEARCH_URL = "https://api.modrinth.com/v2/search";
const TIMEOUT_MS = 8000;

/** Server software, as the loader category Modrinth files projects under. Both
 *  mods and plugins are `project_type: mod` there; what distinguishes them is
 *  the loader category. */
const LOADER_BY_TYPE: Record<string, string> = {
    PAPER: "paper",
    PURPUR: "paper",
    SPIGOT: "spigot",
    FABRIC: "fabric",
    FORGE: "forge",
    NEOFORGE: "neoforge"
};

/** Whether this server software can load anything from Modrinth at all. */
export function loaderForType(type: string): string | null {
    return LOADER_BY_TYPE[type.toUpperCase()] ?? null;
}

export interface ModrinthProject {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly downloads: number;
    readonly categories: readonly string[];
}

const searchResponseSchema = z.object({
    hits: z
        .array(
            z.object({
                slug: z.string().min(1).max(64),
                title: z.string().max(200).catch(""),
                description: z.string().max(500).catch(""),
                downloads: z.number().nonnegative().catch(0),
                categories: z.array(z.string().max(64)).max(32).catch([])
            })
        )
        .max(50)
});

/**
 * Projects matching a query for one server flavour, most downloaded first.
 * Resolves empty when Modrinth is unreachable - a mod browser that cannot reach
 * the index is a browser with no results, not a broken page.
 */
export async function searchModrinth(query: string, loader: string, limit = 20): Promise<ModrinthProject[]> {
    const facets = JSON.stringify([["project_type:mod"], [`categories:${loader}`]]);
    const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&limit=${limit}&index=downloads`;
    try {
        const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!response.ok) return [];
        const parsed = searchResponseSchema.safeParse(await response.json());
        if (!parsed.success) return [];
        return parsed.data.hits.map((hit) => ({
            slug: hit.slug,
            title: hit.title || hit.slug,
            description: hit.description,
            downloads: hit.downloads,
            categories: hit.categories
        }));
    } catch {
        return [];
    }
}

/** The MODRINTH_PROJECTS value, as the list of projects it names. The image
 *  accepts commas or newlines, and an entry may carry a version or a prefix. */
export function parseProjectList(value: string): string[] {
    return value
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Back to the one line the container is given. */
export function formatProjectList(projects: readonly string[]): string {
    return [...new Set(projects)].join(",");
}

/**
 * Plugins from SpigotMC, which is where most of them actually are.
 *
 * Modrinth is the better index and the smaller one. A great deal of what a Paper
 * server runs has only ever been published on SpigotMC - the resource pages
 * everybody links to - and until now Polaris could install none of it, which made
 * "search for a plugin" answer "there is no such plugin" for plugins that are
 * right there.
 *
 * The image installs these from a list of resource numbers, so that is what this
 * hands back: `SPIGET_RESOURCES` is a comma-separated list of ids, and a plugin
 * is on a server because its number is on that list.
 *
 * Two things SpigotMC has that Modrinth does not, and both have to be caught here
 * rather than by somebody reading a boot log:
 *
 *   - a resource can be **external**, meaning the download button sends you to
 *     GitHub rather than handing over a file. Nothing can install one
 *     automatically, so they are marked and never offered as installable.
 *   - a resource can be **premium**, meaning it is paid. The same problem with a
 *     worse failure: a paid resource downloads as an HTML page that the server
 *     then tries to load as a jar.
 *
 * The version a resource says it was tested on is exactly that - a claim by its
 * author, not a build matrix - so it is shown and never used to refuse anything.
 */

import { z } from "zod";

/** Spiget is the read-only API in front of SpigotMC. */
const spigetApi = "https://api.spiget.org/v2";

/** SpigotMC asks API clients to identify themselves, as Modrinth does. */
const USER_AGENT = "polaris-dashboard (https://github.com/FJRG2007/polaris)";

const TIMEOUT_MS = 8000;

/** Where the resource numbers live on the server. */
export const SPIGET_KEY = "SPIGET_RESOURCES";

const resourceSchema = z.object({
    id: z.number().int().nonnegative(),
    name: z.string().max(200).catch(""),
    tag: z.string().max(500).catch(""),
    downloads: z.number().nonnegative().catch(0),
    testedVersions: z.array(z.string().max(32)).max(100).catch([]),
    external: z.boolean().catch(false),
    premium: z.boolean().catch(false),
    icon: z.object({ url: z.string().max(512).catch("") }).partial().catch({}),
    rating: z.object({ average: z.number().catch(0) }).partial().catch({})
});

const resourcesSchema = z.array(resourceSchema).max(100);

/** A plugin as the browser shows it. */
export interface SpigotPlugin {
    readonly id: number;
    readonly name: string;
    readonly summary: string;
    readonly downloads: number;
    /** What its author says it has been tested on, newest last. Shown, never
     *  enforced: it is a claim rather than a build list. */
    readonly testedVersions: readonly string[];
    readonly iconUrl: string | null;
    /** The page somebody reads before installing anything from a catalogue with
     *  no review process. */
    readonly pageUrl: string;
    /** Why this one cannot be installed from here, or null when it can. */
    readonly blocked: string | null;
}

async function spigetJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: { "user-agent": USER_AGENT, accept: "application/json" },
            signal: controller.signal
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Why the image could not install this one, or null. */
function blockedReason(resource: z.infer<typeof resourceSchema>): string | null {
    if (resource.premium) return "Paid on SpigotMC, so it has to be downloaded by hand";
    if (resource.external) return "Hosted somewhere else, so it has to be downloaded by hand";
    return null;
}

function toPlugin(resource: z.infer<typeof resourceSchema>): SpigotPlugin {
    const icon = resource.icon?.url ?? "";
    return {
        id: resource.id,
        name: resource.name,
        summary: resource.tag,
        downloads: resource.downloads,
        testedVersions: resource.testedVersions,
        // The icon path is relative to the site rather than absolute, and an empty
        // one is a resource that never uploaded one.
        iconUrl: icon.length > 0 ? `https://www.spigotmc.org/${icon}` : null,
        pageUrl: `https://www.spigotmc.org/resources/${resource.id}/`,
        blocked: blockedReason(resource)
    };
}

/**
 * Search SpigotMC, or list what is popular when nothing has been typed.
 *
 * Empty on any failure, which the caller reads as "this could not be asked"
 * rather than as "there is nothing" - the same rule the Modrinth browser
 * follows, for the same reason.
 */
export async function searchSpigot(query: string, limit = 20): Promise<SpigotPlugin[]> {
    const wanted = query.trim();
    const size = Math.min(50, Math.max(1, limit));
    const url =
        wanted.length > 0
            ? `${spigetApi}/search/resources/${encodeURIComponent(wanted)}?field=name&size=${size}&sort=-downloads`
            : `${spigetApi}/resources/free?size=${size}&sort=-downloads`;
    const parsed = resourcesSchema.safeParse(await spigetJson(url));
    return parsed.success ? parsed.data.map(toPlugin) : [];
}

/** One resource by its number, for showing what is already on a server's list. */
export async function readSpigotPlugins(ids: readonly number[]): Promise<SpigotPlugin[]> {
    const wanted = [...new Set(ids)].slice(0, 50);
    const found = await Promise.all(
        wanted.map(async (id) => {
            const parsed = resourceSchema.safeParse(await spigetJson(`${spigetApi}/resources/${id}`));
            return parsed.success ? toPlugin(parsed.data) : null;
        })
    );
    return found.filter((entry): entry is SpigotPlugin => entry !== null);
}

/** The numbers on a server's list, in the order they were written. */
export function parseSpigetList(value: string): number[] {
    const found: number[] = [];
    for (const entry of value.split(",")) {
        const id = Number.parseInt(entry.trim(), 10);
        if (Number.isInteger(id) && id > 0 && !found.includes(id)) found.push(id);
    }
    return found;
}

/** The list as the image reads it. */
export function formatSpigetList(ids: readonly number[]): string {
    return [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0).join(",");
}

/**
 * Browsing Modrinth for mods and plugins, for one particular server.
 *
 * All of it runs on the server, not in the browser: the dashboard should not make
 * the operator's machine talk to a third party to render a page, and the response
 * is other people's text, so it is validated into a known shape before anything
 * renders it. Nothing is downloaded here - the image installs what
 * MODRINTH_PROJECTS lists when it boots, which is also how it removes what was
 * taken off the list.
 *
 * The reason there is more here than a search box is that a project which does
 * not fit is not a mistake anybody catches by reading. It is a server that boots
 * without the plugin, or refuses to boot at all, hours later, with the reason in
 * a log nobody opens. So the server's own loader and version go into the query,
 * what is already installed is resolved to real titles rather than shown as
 * slugs, and the conflicts each project declares about the others are read back
 * and put on screen before the restart rather than after it.
 */

import { z } from "zod";

/** Modrinth asks API clients to identify themselves. */
const USER_AGENT = "polaris-dashboard (https://github.com/FJRG2007/polaris)";

/** Shared with `blueprint-version`, which asks the same API the same way and
 *  should not carry a second copy of where it is or how to identify to it. */
export const modrinthApi = "https://api.modrinth.com/v2";

const TIMEOUT_MS = 8000;

/** Server software, as the loader category Modrinth files projects under. */
const LOADER_BY_TYPE: Record<string, string> = {
    PAPER: "paper",
    PURPUR: "paper",
    SPIGOT: "spigot",
    FABRIC: "fabric",
    FORGE: "forge",
    NEOFORGE: "neoforge"
};

/** Modrinth indexes a server-side addon as a plugin or as a mod depending on the
 *  loader it targets, and searching for the wrong one of the two answers with
 *  nothing at all rather than with an error. */
const PLUGIN_LOADERS = new Set(["paper", "spigot", "purpur", "bukkit", "folia"]);

/** Whether this server software can load anything from Modrinth at all. */
export function loaderForType(type: string): string | null {
    return LOADER_BY_TYPE[type.toUpperCase()] ?? null;
}

/**
 * The shelves the browser opens on, per kind of server.
 *
 * Modrinth's own category tags, and only the ones that mean something on a
 * server: "decoration" and "cursed" are real tags and neither is what somebody
 * administering a server is looking for. A plugin server and a modded one are
 * filed under different tags for the same idea, which is why there are two lists
 * rather than one with holes in it.
 */
export interface ModrinthCategory {
    /** The Modrinth tag, or the empty string for "everything". */
    readonly value: string;
    readonly label: string;
}

const PLUGIN_CATEGORIES: readonly ModrinthCategory[] = [
    { value: "", label: "Popular" },
    { value: "management", label: "Management" },
    { value: "utility", label: "Utility" },
    { value: "adventure", label: "Adventure" },
    { value: "economy", label: "Economy" },
    { value: "game-mechanics", label: "Game mechanics" },
    { value: "social", label: "Social" },
    { value: "worldgen", label: "World generation" },
    { value: "optimization", label: "Performance" }
];

const MOD_CATEGORIES: readonly ModrinthCategory[] = [
    { value: "", label: "Popular" },
    { value: "utility", label: "Utility" },
    { value: "adventure", label: "Adventure" },
    { value: "technology", label: "Technology" },
    { value: "magic", label: "Magic" },
    { value: "storage", label: "Storage" },
    { value: "food", label: "Food" },
    { value: "worldgen", label: "World generation" },
    { value: "optimization", label: "Performance" }
];

/** What a server of this flavour can be browsed by. */
export function categoriesForLoader(loader: string): readonly ModrinthCategory[] {
    return PLUGIN_LOADERS.has(loader) ? PLUGIN_CATEGORIES : MOD_CATEGORIES;
}

/** Whether a category tag is one this loader is actually browsed by. Checked on
 *  the server, because it goes into a query to somebody else's API. */
export function isCategoryFor(loader: string, category: string): boolean {
    return category.length === 0 || categoriesForLoader(loader).some((entry) => entry.value === category);
}

export interface ModrinthProject {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly downloads: number;
    readonly categories: readonly string[];
    /** The project's own icon, for a list somebody scans rather than reads. Null
     *  for a project that has never uploaded one. */
    readonly iconUrl: string | null;
    /** Who publishes it. The answer to "is this the real one", which is the
     *  question behind installing anything with two similarly named results. */
    readonly author: string | null;
}

/** A Minecraft version, as Modrinth writes them. Kept strict because it is put
 *  into a query string and compared against what a project reports. */
const VERSION = /^[0-9][0-9.]{0,15}$/;

const searchResponseSchema = z.object({
    hits: z
        .array(
            z.object({
                slug: z.string().min(1).max(64),
                title: z.string().max(200).catch(""),
                description: z.string().max(500).catch(""),
                downloads: z.number().nonnegative().catch(0),
                categories: z.array(z.string().max(64)).max(32).catch([]),
                icon_url: z.string().max(512).nullish().catch(null),
                author: z.string().max(120).nullish().catch(null)
            })
        )
        .max(50)
});

function hitToProject(hit: z.infer<typeof searchResponseSchema>["hits"][number]): ModrinthProject {
    return {
        slug: hit.slug,
        title: hit.title || hit.slug,
        description: hit.description,
        downloads: hit.downloads,
        categories: hit.categories,
        // Only Modrinth's own CDN. An icon_url is a URL out of somebody else's
        // database, and the page it lands on is one an operator is logged into.
        iconUrl: isModrinthIcon(hit.icon_url) ? (hit.icon_url ?? null) : null,
        author: hit.author ?? null
    };
}

/**
 * Whether a URL is an icon on Modrinth's own CDN.
 *
 * An `icon_url` is a URL out of somebody else's database, and what it reaches is
 * fetched by Polaris and rendered inside a dashboard an operator is logged into.
 * So it has to be https, and it has to be them - anything else is dropped and the
 * row draws its initials instead.
 */
export function isModrinthIcon(url: string | null | undefined): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        return parsed.hostname === "cdn.modrinth.com" || parsed.hostname.endsWith(".modrinth.com");
    } catch {
        return false;
    }
}

/**
 * Projects that fit this server, most downloaded first.
 *
 * Every filter the server can supply is applied at the source rather than after
 * the fact: the loader it runs, the release it is on, and that the project has a
 * server side at all - a client-only mod installs cleanly, changes nothing, and
 * leaves somebody convinced their server is broken.
 *
 * Resolves empty when Modrinth is unreachable - a browser that cannot reach the
 * index is a browser with no results, not a broken page.
 */
export async function searchModrinth(
    query: string,
    loader: string,
    options: { version?: string | null; category?: string; limit?: number } = {}
): Promise<ModrinthProject[]> {
    const projectType = PLUGIN_LOADERS.has(loader) ? "plugin" : "mod";
    const facets: string[][] = [[`project_type:${projectType}`], [`categories:${loader}`]];
    // A plugin is server-side by definition and Modrinth does not always tag one,
    // so this is only worth asking of mods - where the client-only ones are the
    // majority of what a search returns.
    if (projectType === "mod") facets.push(["server_side:required", "server_side:optional"]);
    const version = (options.version ?? "").trim();
    if (VERSION.test(version)) facets.push([`versions:${version}`]);
    if (options.category) facets.push([`categories:${options.category}`]);

    const params = new URLSearchParams({
        facets: JSON.stringify(facets),
        limit: String(options.limit ?? 20),
        index: query.trim().length > 0 ? "relevance" : "downloads"
    });
    if (query.trim().length > 0) params.set("query", query.trim());

    const parsed = searchResponseSchema.safeParse(await modrinthJson(`${modrinthApi}/search?${params.toString()}`).catch(() => null));
    return parsed.success ? parsed.data.hits.map(hitToProject) : [];
}

const projectSchema = z.object({
    /** Modrinth's own id, which is what dependencies between projects are
     *  recorded by - the slugs are only what people type. */
    id: z.string().max(64).catch(""),
    slug: z.string().min(1).max(64),
    title: z.string().max(200).catch(""),
    description: z.string().max(500).catch(""),
    downloads: z.number().nonnegative().catch(0),
    categories: z.array(z.string().max(64)).max(32).catch([]),
    icon_url: z.string().max(512).nullish().catch(null),
    game_versions: z.array(z.string().max(32)).max(500).catch([]),
    loaders: z.array(z.string().max(32)).max(64).catch([])
});

const projectsSchema = z.array(projectSchema).max(100);

/** What is on the list, as the projects they are rather than as slugs. */
export interface InstalledProject extends ModrinthProject {
    /** The entry exactly as MODRINTH_PROJECTS holds it, so the screen can take it
     *  off again without guessing at the syntax. */
    readonly entry: string;
    /** Whether Modrinth knows this project at all. False for a slug that was
     *  mistyped, or a project that has since been taken down - which is a server
     *  whose next restart installs nothing and says so only in its log. */
    readonly known: boolean;
    /** Whether it has a build for the release this server runs. Null when the
     *  server's version could not be pinned down (LATEST), because "no build for
     *  an unknown version" is not a claim anybody can make. */
    readonly fitsVersion: boolean | null;
    /** Whether it has a build for this server's software. */
    readonly fitsLoader: boolean;
}

/**
 * The projects on a server's list, with whether each one actually fits it.
 *
 * One request for all of them rather than one each: Modrinth takes a list of ids,
 * and a server with a dozen plugins should not be a dozen round trips every time
 * the screen is opened.
 *
 * An entry Modrinth has never heard of comes back as itself, marked unknown. The
 * alternative - dropping it - would leave the screen showing a shorter list than
 * the server is actually going to try to install.
 */
export async function readInstalledProjects(
    entries: readonly string[],
    loader: string,
    version: string | null
): Promise<InstalledProject[]> {
    const slugs = entries.map((entry) => ({ entry, slug: projectSlug(entry) }));
    const askable = slugs.flatMap((item) => (item.slug ? [item.slug] : []));
    const found = new Map<string, z.infer<typeof projectSchema>>();
    if (askable.length > 0) {
        const parsed = projectsSchema.safeParse(
            await modrinthJson(`${modrinthApi}/projects?ids=${encodeURIComponent(JSON.stringify(askable))}`).catch(() => null)
        );
        if (parsed.success) for (const project of parsed.data) found.set(project.slug.toLowerCase(), project);
    }

    const pinned = (version ?? "").trim();
    return slugs.map(({ entry, slug }) => {
        const project = slug ? found.get(slug.toLowerCase()) : undefined;
        if (!project) {
            return {
                entry,
                slug: slug ?? entry,
                title: slug ?? entry,
                description: "",
                downloads: 0,
                categories: [],
                iconUrl: null,
                author: null,
                known: false,
                fitsVersion: null,
                fitsLoader: true
            };
        }
        return {
            entry,
            slug: project.slug,
            title: project.title || project.slug,
            description: project.description,
            downloads: project.downloads,
            categories: project.categories,
            iconUrl: isModrinthIcon(project.icon_url) ? (project.icon_url ?? null) : null,
            author: null,
            known: true,
            fitsVersion: VERSION.test(pinned) ? project.game_versions.includes(pinned) : null,
            // A project that lists no loader at all is a datapoint Modrinth is
            // missing, not a refusal - so it is not held against it.
            fitsLoader: project.loaders.length === 0 || project.loaders.includes(loader)
        };
    });
}

const versionSchema = z.array(
    z.object({
        dependencies: z
            .array(
                z.object({
                    project_id: z.string().max(64).nullish().catch(null),
                    dependency_type: z.string().max(32).catch("")
                })
            )
            .max(64)
            .catch([])
    })
).max(50);

/** Two projects on the same list that their own publishers say cannot both be
 *  installed. */
export interface ModrinthConflict {
    readonly slug: string;
    readonly withSlug: string;
}

/**
 * The conflicts declared between what is on the list.
 *
 * Modrinth records, per release of a project, which other projects it is
 * incompatible with - the publisher's own statement, not a guess made here. That
 * is the only kind of conflict worth putting on screen: anything inferred from
 * two plugins sharing a category would flag half of a normal server.
 *
 * Best effort throughout. A lookup that fails reports no conflicts rather than
 * blocking the screen, because the screen still has to let somebody take
 * something off a list.
 */
export async function readConflicts(slugs: readonly string[], loader: string): Promise<ModrinthConflict[]> {
    const asked = slugs.map(projectSlug).filter((slug): slug is string => slug !== null);
    if (asked.length < 2) return [];

    // Dependencies are recorded by project id, and the list here is slugs, so the
    // two have to be mapped onto each other before any of it means anything.
    const listed = projectsSchema.safeParse(
        await modrinthJson(`${modrinthApi}/projects?ids=${encodeURIComponent(JSON.stringify(asked))}`).catch(() => null)
    );
    if (!listed.success) return [];
    const slugById = new Map(listed.data.map((entry) => [entry.id, entry.slug]));
    const onList = new Set(listed.data.map((entry) => entry.slug.toLowerCase()));

    const conflicts: ModrinthConflict[] = [];
    for (const entry of listed.data) {
        const versions = versionSchema.safeParse(
            await modrinthJson(
                `${modrinthApi}/project/${encodeURIComponent(entry.slug)}/version?loaders=${encodeURIComponent(JSON.stringify([loader]))}`
            ).catch(() => null)
        );
        if (!versions.success) continue;
        // The newest release only: an incompatibility declared two years ago and
        // since resolved is not something to warn a person about today.
        for (const dependency of versions.data[0]?.dependencies ?? []) {
            if (dependency.dependency_type !== "incompatible" || !dependency.project_id) continue;
            const other = slugById.get(dependency.project_id);
            if (!other || !onList.has(other.toLowerCase())) continue;
            conflicts.push({ slug: entry.slug, withSlug: other });
        }
    }
    return conflicts;
}

/** One request to Modrinth, identified the way they ask for and bounded so a slow
 *  index cannot hold a page open. Throws on anything that is not an answer, which
 *  every caller here turns into "nothing is known" rather than into an error. */
export async function modrinthJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Modrinth answered ${response.status}`);
    return response.json();
}

/**
 * The slug out of a MODRINTH_PROJECTS entry.
 *
 * The image's own syntax: a trailing "?" makes a project optional, a ":" pins a
 * version, and a leading "@" names a file rather than a project. Only a plain
 * slug can be asked about.
 */
export function projectSlug(entry: string): string | null {
    const trimmed = entry.trim().replace(/\?+$/, "");
    if (trimmed.length === 0 || trimmed.startsWith("@")) return null;
    const slug = trimmed.split(":")[0]?.trim() ?? "";
    return /^[A-Za-z0-9!@$()`.+,_-]{1,64}$/.test(slug) ? slug : null;
}

/** How finished a build has to be before the image will install it. Cumulative,
 *  as the image reads them: beta also admits releases, alpha admits all three. */
export type ReleaseType = "release" | "beta" | "alpha";

const RELEASE_TYPES: readonly ReleaseType[] = ["release", "beta", "alpha"];

/** What each one admits, so a lookup asks about the same builds the image will. */
const ADMITS: Record<ReleaseType, ReadonlySet<string>> = {
    release: new Set(["release"]),
    beta: new Set(["release", "beta"]),
    alpha: new Set(["release", "beta", "alpha"])
};

/**
 * The release type an entry asks for, which is the image's own syntax: a colon
 * followed by `release`, `beta` or `alpha`.
 *
 * It has to be read here as well as passed through, because the two have to
 * agree. BedWars1058 only reaches 1.21 in snapshot builds, and asking Modrinth
 * "which releases does it support" without saying which builds count answered
 * 1.21.4 - a version the image then refused to install anything for, because by
 * default it takes finished releases only. The server restarted forever on it.
 *
 * A colon can also introduce a version rather than a type, so only the three
 * words count; anything else leaves the default alone.
 */
export function entryReleaseType(entry: string): ReleaseType {
    const parts = entry.trim().replace(/\?+$/, "").split(":");
    for (const part of parts.slice(1)) {
        const value = part.trim().toLowerCase();
        if ((RELEASE_TYPES as readonly string[]).includes(value)) return value as ReleaseType;
    }
    return "release";
}

/** Whether a build of this type is one an entry asking for `wanted` would take. */
export function admitsBuild(wanted: ReleaseType, buildType: string): boolean {
    return ADMITS[wanted].has(buildType);
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


/**
 * The exact build an entry is nailed to, if it is nailed to one.
 *
 * `slug` on its own takes whatever is newest at the next restart, so it can never
 * be out of date; `slug:beta` is a rule about which builds count, not a version.
 * Only an actual version is a pin, and only a pin can fall behind.
 *
 * Which is what makes an "update available" mark honest. Marking every entry would
 * be telling somebody their server is stale when it updates itself every boot.
 */
export function pinnedBuild(entry: string): string | null {
    const parts = entry
        .trim()
        .replace(/\?+$/, "")
        .split(":")
        .slice(1)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    return parts.find((part) => !(RELEASE_TYPES as readonly string[]).includes(part.toLowerCase())) ?? null;
}

/** The same entry pointed at another build, with everything else about it - the
 *  release type, the trailing `?` that makes it optional - left alone. */
export function repinEntry(entry: string, build: string): string {
    const optional = /\?+$/.test(entry.trim());
    const bare = entry.trim().replace(/\?+$/, "");
    const [slug, ...rest] = bare.split(":");
    const kept = rest
        .map((part) => part.trim())
        .filter((part) => (RELEASE_TYPES as readonly string[]).includes(part.toLowerCase()));
    return `${[slug, ...kept, build].join(":")}${optional ? "?" : ""}`;
}

const buildSchema = z
    .array(
        z.object({
            version_number: z.string().max(64).catch(""),
            version_type: z.string().max(32).catch("release"),
            game_versions: z.array(z.string().max(32)).max(200).catch([])
        })
    )
    .max(50);

/**
 * The newest build each pinned entry could move to, or nothing.
 *
 * Asked only about the entries that are pinned, which is usually none of them - an
 * unpinned list costs no requests at all. The build has to be one this server would
 * actually accept: the right loader, the release this server runs, and a type the
 * entry admits, or the offer is to move somebody onto something their next restart
 * would refuse to install.
 */
export async function newestBuilds(
    entries: readonly string[],
    loader: string,
    version: string | null
): Promise<Map<string, string>> {
    const newest = new Map<string, string>();
    const wanted = (version ?? "").trim();
    for (const entry of entries) {
        const slug = projectSlug(entry);
        const pin = pinnedBuild(entry);
        if (!slug || !pin) continue;
        const builds = buildSchema.safeParse(
            await modrinthJson(
                `${modrinthApi}/project/${encodeURIComponent(slug)}/version?loaders=${encodeURIComponent(JSON.stringify([loader]))}`
            ).catch(() => null)
        );
        if (!builds.success) continue;
        const admitted = builds.data.find(
            (build) =>
                build.version_number.length > 0 &&
                admitsBuild(entryReleaseType(entry), build.version_type) &&
                (!VERSION.test(wanted) || build.game_versions.includes(wanted))
        );
        // Newest first is Modrinth's own order. Nothing to say when the pin is
        // already it.
        if (admitted && admitted.version_number !== pin) newest.set(entry, admitted.version_number);
    }
    return newest;
}

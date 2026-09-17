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

/**
 * Whether this loader runs plugins rather than mods.
 *
 * The line everything about a Minecraft server falls on: what it can install,
 * which half of Modrinth to search, and - because a plugin has no build for a
 * modded server and never will - what may be put on its list at all.
 */
export function isPluginLoader(loader: string): boolean {
    return PLUGIN_LOADERS.has(loader);
}

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
    return isPluginLoader(loader) ? PLUGIN_CATEGORIES : MOD_CATEGORIES;
}

/** Whether a category tag is one this loader is actually browsed by. Checked on
 *  the server, because it goes into a query to somebody else's API. */
export function isCategoryFor(loader: string, category: string): boolean {
    return (
        category.length === 0 ||
        categoriesForLoader(loader).some((entry) => entry.value === category)
    );
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
    /** Whether it only runs in the player's own game. One of those on a server's
     *  list is a mod the server cannot load; it belongs in the list the players
     *  install instead. */
    readonly clientOnly: boolean;
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
                author: z.string().max(120).nullish().catch(null),
                server_side: z.string().max(32).catch("")
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
        author: hit.author ?? null,
        clientOnly: hit.server_side === "unsupported"
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
    options: {
        version?: string | null;
        category?: string;
        limit?: number;
        /** Whose install the results are for. A server's search is the mods with a
         *  server side; a player's is the mods with a client side, which is the
         *  opposite set and is where every minimap and HUD lives. */
        side?: "server" | "player";
    } = {}
): Promise<ModrinthProject[]> {
    const projectType = isPluginLoader(loader) ? "plugin" : "mod";
    const facets: string[][] = [[`project_type:${projectType}`], [`categories:${loader}`]];
    // A plugin is server-side by definition and Modrinth does not always tag one,
    // so this is only worth asking of mods - where the client-only ones are the
    // majority of what a search returns.
    if (projectType === "mod") {
        facets.push(
            options.side === "player"
                ? ["client_side:required", "client_side:optional"]
                : ["server_side:required", "server_side:optional"]
        );
    }
    const version = (options.version ?? "").trim();
    if (VERSION.test(version)) facets.push([`versions:${version}`]);
    if (options.category) facets.push([`categories:${options.category}`]);

    const params = new URLSearchParams({
        facets: JSON.stringify(facets),
        limit: String(options.limit ?? 20),
        index: query.trim().length > 0 ? "relevance" : "downloads"
    });
    if (query.trim().length > 0) params.set("query", query.trim());

    const parsed = searchResponseSchema.safeParse(
        await modrinthJson(`${modrinthApi}/search?${params.toString()}`).catch(() => null)
    );
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
    server_side: z.string().max(32).catch(""),
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
            await modrinthJson(
                `${modrinthApi}/projects?ids=${encodeURIComponent(JSON.stringify(askable))}`
            ).catch(() => null)
        );
        if (parsed.success)
            for (const project of parsed.data) found.set(project.slug.toLowerCase(), project);
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
                clientOnly: false,
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
            clientOnly: project.server_side === "unsupported",
            known: true,
            fitsVersion: VERSION.test(pinned) ? project.game_versions.includes(pinned) : null,
            // A project that lists no loader at all is a datapoint Modrinth is
            // missing, not a refusal - so it is not held against it.
            fitsLoader: project.loaders.length === 0 || project.loaders.includes(loader)
        };
    });
}

/**
 * A project's builds, as many as are worth reading.
 *
 * Sliced rather than refused past the limit: Modrinth answers with every build a
 * project ever published for that loader - Balm has two hundred - and a schema
 * that rejected the list over its length reported the whole project as having no
 * build here. TrashSlot then read as "needs Balm, which has no build here" on a
 * server where Balm installs perfectly well. Newest first is Modrinth's order, so
 * what is kept is the part any of this asks about.
 */
const BUILDS_READ = 200;

const someBuilds = <T extends z.ZodTypeAny>(build: T) =>
    z.preprocess(
        (value) => (Array.isArray(value) ? value.slice(0, BUILDS_READ) : value),
        z.array(build)
    );

const versionSchema = someBuilds(
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
    );

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
export async function readConflicts(
    slugs: readonly string[],
    loader: string
): Promise<ModrinthConflict[]> {
    const asked = slugs.map(projectSlug).filter((slug): slug is string => slug !== null);
    if (asked.length < 2) return [];

    // Dependencies are recorded by project id, and the list here is slugs, so the
    // two have to be mapped onto each other before any of it means anything.
    const listed = projectsSchema.safeParse(
        await modrinthJson(
            `${modrinthApi}/projects?ids=${encodeURIComponent(JSON.stringify(asked))}`
        ).catch(() => null)
    );
    if (!listed.success) return [];
    const slugById = new Map(listed.data.map((entry) => [entry.id, entry.slug]));
    const onList = new Set(listed.data.map((entry) => entry.slug.toLowerCase()));

    const releases = await walk(listed.data, (entry) => projectVersions(entry.slug, loader));
    const conflicts: ModrinthConflict[] = [];
    for (const [index, entry] of listed.data.entries()) {
        const versions = versionSchema.safeParse(releases[index]);
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

/**
 * How long an answer is reused.
 *
 * One look at the mods screen asks for the same projects from three walks - what
 * they are, what they clash with, what they need - and asks again on every edit.
 * Long enough that all of that is one request per address; short enough that a
 * build published a moment ago is offered on the next visit.
 */
const ANSWER_TTL_MS = 5 * 60_000;
/** A bound on the memory the answers hold, oldest dropped first. */
const ANSWERS_KEPT = 500;

/** Answers by address, kept as the promise so a question already on its way is
 *  joined rather than asked twice. */
const answers = new Map<string, { at: number; body: Promise<unknown> }>();

/** One request to Modrinth, identified the way they ask for and bounded so a slow
 *  index cannot hold a page open. Throws on anything that is not an answer, which
 *  every caller here turns into "nothing is known" rather than into an error. */
export function modrinthJson(url: string): Promise<unknown> {
    const now = Date.now();
    const kept = answers.get(url);
    if (kept && now - kept.at < ANSWER_TTL_MS) return kept.body;
    const body = askModrinth(url);
    answers.delete(url);
    answers.set(url, { at: now, body });
    if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value as string);
    // A failure is not an answer: the next screen asks again.
    body.catch(() => {
        if (answers.get(url)?.body === body) answers.delete(url);
    });
    return body;
}

async function askModrinth(url: string): Promise<unknown> {
    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Modrinth answered ${response.status}`);
    return response.json();
}

/** Drop every kept answer. For tests, which answer the same address differently. */
export function forgetModrinthAnswers(): void {
    answers.clear();
}

/** How many questions one walk puts to Modrinth at a time. */
const WALK_CONCURRENCY = 8;

/**
 * `items.map(run)`, a few at a time, in order.
 *
 * The walks below ask one question per project. One after another, a list of
 * twenty is twenty round trips end to end; all at once, it is a burst against
 * somebody else's rate limit.
 */
async function walk<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index] as T);
        }
    }
    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, items.length) }, worker));
    return results;
}

/** A project's releases for one loader, newest first, or null when they could not
 *  be read. One address for every walk here, so they share the answer - and the
 *  release the server runs is part of it, since that is what is being asked about
 *  and it is the difference between thirty builds and three hundred. */
function projectVersions(slug: string, loader: string, version = ""): Promise<unknown> {
    const filters = [`loaders=${encodeURIComponent(JSON.stringify([loader]))}`];
    if (VERSION.test(version)) {
        filters.push(`game_versions=${encodeURIComponent(JSON.stringify([version]))}`);
    }
    return modrinthJson(
        `${modrinthApi}/project/${encodeURIComponent(slug)}/version?${filters.join("&")}`
    ).catch(() => null);
}

/** One entry of MODRINTH_PROJECTS, as the three things its syntax can carry. */
export interface ProjectEntry {
    /** The project, with no "?" left on it. Empty for anything unaskable. */
    readonly slug: string;
    /** Whether a build that cannot be found may be skipped instead of ending the
     *  boot. */
    readonly optional: boolean;
    /** What followed the ":", which is a version, a release type, or both. */
    readonly parts: readonly string[];
}

/**
 * An entry split into its parts.
 *
 * The "?" belongs to the project rather than to the line: `grimac?:alpha` is the
 * optional project `grimac` asked for at alpha. Reading it only at the very end
 * of the string - which every reader here used to do - left the slug as
 * `grimac?`, a name no project has, so the row was reported as one Modrinth has
 * never heard of and a repin wrote the "?" into the middle of the name.
 *
 * Both spellings are taken, because the reader that was wrong about the first
 * was the one writing the second, and lists holding either are already deployed.
 */
export function splitEntry(entry: string): ProjectEntry {
    const trimmed = entry.trim();
    const head = trimmed.split(":")[0]?.trim() ?? "";
    const optional = /\?+$/.test(trimmed) || /\?+$/.test(head);
    const [slug = "", ...rest] = trimmed.replace(/\?+$/, "").split(":");
    return {
        slug: slug.trim().replace(/\?+$/, ""),
        optional,
        parts: rest.map((part) => part.trim().replace(/\?+$/, "")).filter((part) => part.length > 0)
    };
}

/**
 * The slug out of a MODRINTH_PROJECTS entry.
 *
 * The image's own syntax: a "?" makes a project optional, a ":" pins a version,
 * and a leading "@" names a file rather than a project. Only a plain slug can be
 * asked about.
 */
export function projectSlug(entry: string): string | null {
    const { slug } = splitEntry(entry);
    if (slug.length === 0 || slug.startsWith("@")) return null;
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
    for (const part of splitEntry(entry).parts) {
        const value = part.toLowerCase();
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
    const { parts } = splitEntry(entry);
    return (
        parts.find((part) => !(RELEASE_TYPES as readonly string[]).includes(part.toLowerCase())) ??
        null
    );
}

/**
 * The same entry pointed at another build, with everything else about it - the
 * release type, the `?` that makes it optional - left alone.
 *
 * The "?" is written onto the slug, which is the spelling the catalog's own
 * defaults use and therefore the one there is evidence the image reads. Hanging
 * it off the end of a pinned version instead would be inventing a third form.
 */
export function repinEntry(entry: string, build: string): string {
    const { slug, optional, parts } = splitEntry(entry);
    const kept = parts.filter((part) =>
        (RELEASE_TYPES as readonly string[]).includes(part.toLowerCase())
    );
    return [`${slug}${optional ? "?" : ""}`, ...kept, build].join(":");
}

const buildSchema = someBuilds(
    z.object({
        version_number: z.string().max(64).catch(""),
        version_type: z.string().max(32).catch("release"),
        game_versions: z.array(z.string().max(32)).max(200).catch([]),
        files: z
            .array(
                z.object({
                    filename: z.string().max(200).catch(""),
                    url: z.string().max(512).catch(""),
                    primary: z.boolean().catch(false),
                    hashes: z.object({ sha1: z.string().max(64).catch("") }).catch({ sha1: "" })
                })
            )
            .max(20)
            .catch([])
    })
);

/**
 * The newest build of one project this server would actually take, or null.
 *
 * "Would take" is three questions asked together, because a project can publish
 * for the loader, publish for the release, and still only ever publish it as an
 * alpha the entry does not admit - and any one of those alone is a build the next
 * restart refuses.
 *
 * Shared by the two callers that need the same answer for different reasons:
 * offering a newer build to move a pin onto, and deciding whether a required
 * dependency can be installed on this server at all. They were the same three
 * checks, and the second one only exists because the first already had them.
 */
async function admittedBuild(
    slug: string,
    loader: string,
    version: string,
    release: ReleaseType
): Promise<string | null> {
    const builds = buildSchema.safeParse(await projectVersions(slug, loader, version));
    if (!builds.success) return null;
    // Newest first is Modrinth's own order.
    const admitted = builds.data.find(
        (build) =>
            build.version_number.length > 0 &&
            admitsBuild(release, build.version_type) &&
            (!VERSION.test(version) || build.game_versions.includes(version))
    );
    return admitted?.version_number ?? null;
}

/** One build, as the thing a player would download. */
export interface ModrinthBuild {
    readonly version: string;
    readonly filename: string;
    readonly url: string;
    readonly sha1: string;
}

/**
 * The build an entry installs on this server, with the file behind it.
 *
 * The same three questions `admittedBuild` asks - the loader, the release, how
 * finished a build has to be - answered with the file, because that is what the
 * mod pack a player installs is made of.
 */
export async function buildFor(
    entry: string,
    loader: string,
    version: string | null
): Promise<ModrinthBuild | null> {
    const slug = projectSlug(entry);
    if (!slug) return null;
    const wanted = (version ?? "").trim();
    const pin = pinnedBuild(entry);
    const builds = buildSchema.safeParse(await projectVersions(slug, loader, wanted));
    if (!builds.success) return null;
    const release = entryReleaseType(entry);
    const admitted = builds.data.find(
        (build) =>
            build.version_number.length > 0 &&
            (pin === null || build.version_number === pin) &&
            admitsBuild(release, build.version_type) &&
            (!VERSION.test(wanted) || build.game_versions.includes(wanted))
    );
    const file = admitted?.files.find((one) => one.primary) ?? admitted?.files[0];
    if (!admitted || !file || !file.url || !file.filename) return null;
    return {
        version: admitted.version_number,
        filename: file.filename,
        url: file.url,
        sha1: file.hashes.sha1
    };
}

/**
 * The newest build each pinned entry could move to, or nothing.
 *
 * Asked only about the entries that are pinned, which is usually none of them - an
 * unpinned list costs no requests at all.
 */
export async function newestBuilds(
    entries: readonly string[],
    loader: string,
    version: string | null
): Promise<Map<string, string>> {
    const newest = new Map<string, string>();
    const wanted = (version ?? "").trim();
    const pinned = entries.filter((entry) => projectSlug(entry) && pinnedBuild(entry));
    const builds = await walk(pinned, (entry) =>
        admittedBuild(projectSlug(entry) as string, loader, wanted, entryReleaseType(entry))
    );
    for (const [index, entry] of pinned.entries()) {
        const build = builds[index] ?? null;
        // Nothing to say when the pin is already the newest it could be on.
        if (build !== null && build !== pinnedBuild(entry)) newest.set(entry, build);
    }
    return newest;
}

/** A project on the list, and something its publisher says it cannot run without. */
export interface ModrinthRequirement {
    /** The project that needs it. */
    readonly slug: string;
    /** What it needs. */
    readonly needs: string;
    /** And what that is called, for a sentence somebody reads. */
    readonly needsTitle: string;
    /**
     * Whether that dependency has a build this server would take.
     *
     * False is the whole reason this exists. The image treats a required
     * dependency it cannot resolve as a reason to END THE BOOT - not as a mod to
     * skip - so a project whose dependency has no build for this loader is not a
     * missing feature, it is a server that restarts until something stops it.
     * Dynamic Lights requires Fabric API, Fabric API has no NeoForge build, and
     * that is exactly what it did: nine restarts and a stopped server, from one
     * press of Add.
     *
     * The `?` that marks an entry optional does not help here and it is worth
     * knowing why: it makes the PROJECT skippable when no build is found for it,
     * and says nothing about the dependencies it drags in.
     */
    readonly available: boolean;
    /** Whether it is already on the list, so nothing offers to add it twice. */
    readonly onList: boolean;
}

/**
 * What the projects on a list require, and whether this server can have it.
 *
 * The other half of `readConflicts`: the same walk over the same declarations,
 * reading the dependencies a publisher marks `required` rather than the ones they
 * mark `incompatible`. Both are the publisher's own statement rather than anything
 * inferred here, which is what makes either worth putting on a screen.
 *
 * Bounded by construction: one request for the list, one per project for its
 * newest release, one for all the dependency names together, and one per distinct
 * dependency to see whether it has a build. A dependency two projects share is
 * asked about once.
 *
 * Best effort throughout, like the conflicts. A lookup that fails reports nothing
 * rather than blocking a screen whose whole job is letting somebody change a list.
 */
export async function readRequirements(
    entries: readonly string[],
    loader: string,
    version: string | null
): Promise<ModrinthRequirement[]> {
    const asked = entries.map(projectSlug).filter((slug): slug is string => slug !== null);
    if (asked.length === 0) return [];

    const listed = projectsSchema.safeParse(
        await modrinthJson(
            `${modrinthApi}/projects?ids=${encodeURIComponent(JSON.stringify(asked))}`
        ).catch(() => null)
    );
    if (!listed.success) return [];
    const onList = new Set(listed.data.map((project) => project.slug.toLowerCase()));
    const wanted = (version ?? "").trim();

    // Which entry each project came from, so a dependency is judged by the same
    // release type the entry that needs it asks for.
    const entryFor = new Map<string, string>();
    for (const entry of entries) {
        const slug = projectSlug(entry);
        if (slug) entryFor.set(slug.toLowerCase(), entry);
    }

    const needed: { by: string; id: string; release: ReleaseType }[] = [];
    const releases = await walk(listed.data, (project) => projectVersions(project.slug, loader));
    for (const [index, project] of listed.data.entries()) {
        const entry = entryFor.get(project.slug.toLowerCase()) ?? project.slug;
        const versions = versionSchema.safeParse(releases[index]);
        if (!versions.success) continue;
        // The newest release only, for the reason `readConflicts` gives: what a
        // project needed two years ago is not what it needs today.
        for (const dependency of versions.data[0]?.dependencies ?? []) {
            if (dependency.dependency_type !== "required" || !dependency.project_id) continue;
            needed.push({
                by: project.slug,
                id: dependency.project_id,
                release: entryReleaseType(entry)
            });
        }
    }
    if (needed.length === 0) return [];

    // Dependencies are recorded by id; their names come in one request rather than
    // one each.
    const ids = [...new Set(needed.map((one) => one.id))].slice(0, 100);
    const deps = projectsSchema.safeParse(
        await modrinthJson(
            `${modrinthApi}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`
        ).catch(() => null)
    );
    if (!deps.success) return [];
    const projectById = new Map(deps.data.map((project) => [project.id, project]));

    // Each dependency is judged once, by the release type of the first entry that
    // needs it.
    const judged = new Map<string, ReleaseType>();
    for (const one of needed) {
        const dependency = projectById.get(one.id);
        if (dependency && !judged.has(dependency.slug)) judged.set(dependency.slug, one.release);
    }
    const checks = [...judged];
    const builds = await walk(checks, ([slug, release]) =>
        admittedBuild(slug, loader, wanted, release)
    );
    const buildable = new Map(checks.map(([slug], index) => [slug, builds[index] !== null]));

    const seen = new Set<string>();
    const found: ModrinthRequirement[] = [];
    for (const one of needed) {
        const dependency = projectById.get(one.id);
        if (!dependency) continue;
        const pair = `${one.by}\n${dependency.slug}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        found.push({
            slug: one.by,
            needs: dependency.slug,
            needsTitle: dependency.title || dependency.slug,
            available: buildable.get(dependency.slug) ?? false,
            onList: onList.has(dependency.slug.toLowerCase())
        });
    }
    return found;
}

/**
 * What one project on the list still needs.
 *
 * Pure, and kept apart from the walk that fetched it: what a row draws is a
 * question about an answer rather than another question for Modrinth. It is also
 * the half that can be asserted without a network.
 *
 * Only what is missing. A dependency already on the list is a row of its own and
 * needs no second mention beside the thing that wanted it.
 */
export function neededBy(
    requires: readonly ModrinthRequirement[],
    slug: string
): ModrinthRequirement[] {
    const want = slug.toLowerCase();
    return requires.filter((need) => need.slug.toLowerCase() === want && !need.onList);
}

/**
 * Which projects on the list cannot run without this one.
 *
 * What makes a row explain itself. A dependency that arrived because something
 * else required it is otherwise a mod nobody remembers choosing - and the first
 * thing anybody does with one of those is take it off, which breaks the mod they
 * did choose.
 */
export function requiredBy(requires: readonly ModrinthRequirement[], slug: string): string[] {
    const want = slug.toLowerCase();
    return [
        ...new Set(
            requires.filter((need) => need.needs.toLowerCase() === want).map((need) => need.slug)
        )
    ];
}

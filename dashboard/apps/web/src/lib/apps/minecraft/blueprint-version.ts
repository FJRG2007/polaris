/**
 * The Minecraft release a blueprint can actually run on.
 *
 * A blueprint is a promise about the game the server plays, and it is kept by
 * plugins the image fetches from Modrinth at boot. Those plugins carry "?", which
 * means "warn and carry on" rather than "refuse to start" - the right choice for
 * a server that is already running, and the wrong one at creation: a blueprint
 * whose plugin has no build for the version being installed produced an ordinary
 * survival server, said nothing, and looked exactly like every other server the
 * operator had made.
 *
 * So the version is not left to chance. Before the server is created, the
 * blueprint's projects are asked what they support and the newest release all of
 * them agree on is pinned. Nothing is guessed here: the answer comes from
 * Modrinth, and when Modrinth cannot be reached the caller keeps what the
 * operator asked for rather than inventing a version.
 */

import { z } from "zod";

/** Modrinth asks API clients to identify themselves. */
const USER_AGENT = "polaris-dashboard (https://github.com/FJRG2007/polaris)";

const API = "https://api.modrinth.com/v2";
const TIMEOUT_MS = 8000;

/** Modrinth's own answers move about as often as Minecraft is released, so one
 *  lookup covers every dialog opened for the rest of the day. */
const CACHE_MS = 6 * 60 * 60 * 1000;

const projectSchema = z.object({ game_versions: z.array(z.string().max(32)).max(500).catch([]) });

const tagSchema = z.array(z.object({ version: z.string().max(32), version_type: z.string().max(32) })).max(2000);

/** What a project supports, and which of Minecraft's versions are releases,
 *  remembered for as long as they are worth remembering. */
const cache = new Map<string, { at: number; versions: string[] }>();

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

/** One cached lookup, or a fresh one. Empty on any failure, which callers read
 *  as "nothing is known about this" rather than as "this supports nothing". */
async function cached(key: string, load: () => Promise<string[]>): Promise<string[]> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.versions;
    const versions = await load().catch(() => []);
    // A failed lookup is not cached: the next caller should get to try again
    // rather than inherit six hours of an outage that has since ended.
    if (versions.length > 0) cache.set(key, { at: Date.now(), versions });
    return versions;
}

async function fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Modrinth answered ${response.status}`);
    return response.json();
}

/** The Minecraft releases a project has a build for. */
async function projectVersions(slug: string): Promise<string[]> {
    return cached(`project:${slug}`, async () => {
        const parsed = projectSchema.safeParse(await fetchJson(`${API}/project/${encodeURIComponent(slug)}`));
        return parsed.success ? parsed.data.game_versions : [];
    });
}

/** Minecraft's releases, newest first. Snapshots are left out: a blueprint that
 *  pinned one would put the whole server on a version nobody plays. */
async function releases(): Promise<string[]> {
    return cached("releases", async () => {
        const parsed = tagSchema.safeParse(await fetchJson(`${API}/tag/game_version`));
        return parsed.success
            ? parsed.data.filter((entry) => entry.version_type === "release").map((entry) => entry.version)
            : [];
    });
}

/**
 * The newest release every one of these projects supports, or null.
 *
 * Null covers three cases the caller treats the same way - there are no projects
 * to constrain the version, Modrinth could not be reached, or the projects share
 * no release at all - because in each of them the honest thing is to leave the
 * operator's own choice alone rather than pin a version on a guess.
 */
export async function newestCommonVersion(projects: readonly string[]): Promise<string | null> {
    const slugs = projects.map(projectSlug).filter((slug): slug is string => slug !== null);
    if (slugs.length === 0) return null;

    const [ordered, supported] = await Promise.all([
        releases(),
        Promise.all(slugs.map((slug) => projectVersions(slug)))
    ]);
    if (ordered.length === 0 || supported.some((versions) => versions.length === 0)) return null;

    const sets = supported.map((versions) => new Set(versions));
    // The tag list is newest first, so the first release all of them carry is the
    // newest one they agree on.
    return ordered.find((version) => sets.every((set) => set.has(version))) ?? null;
}

/** Whether the operator asked for whatever is newest, which is the only case a
 *  blueprint is allowed to decide the version for. A pinned version is a
 *  deliberate choice and is never overridden. */
export function wantsLatest(version: string | undefined): boolean {
    const value = (version ?? "").trim();
    return value.length === 0 || value.toUpperCase() === "LATEST";
}

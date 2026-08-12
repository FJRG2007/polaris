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
import { modrinthApi, modrinthJson, projectSlug } from "./modrinth";

/** Modrinth's own answers move about as often as Minecraft is released, so one
 *  lookup covers every dialog opened for the rest of the day. */
const CACHE_MS = 6 * 60 * 60 * 1000;

/** Every blueprint that installs anything runs on Paper, and a caller that knows
 *  otherwise says so. */
const DEFAULT_LOADER = "paper";

const versionsSchema = z
    .array(z.object({ game_versions: z.array(z.string().max(32)).max(500).catch([]) }))
    .max(500);

const tagSchema = z.array(z.object({ version: z.string().max(32), version_type: z.string().max(32) })).max(2000);

/** What a project supports, and which of Minecraft's versions are releases,
 *  remembered for as long as they are worth remembering. */
const cache = new Map<string, { at: number; versions: string[] }>();

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

/**
 * The Minecraft releases a project has a build for, on the software that will
 * load it.
 *
 * Asked of the project's builds rather than of the project. A project reports one
 * `game_versions` covering everything it has ever published, across every loader
 * at once - so a plugin whose Fabric build reaches a release its Paper build does
 * not answers yes for that release, and a Paper server pinned to it would find
 * nothing to install. Which is the failure this module exists to prevent, arrived
 * at from the other end.
 */
async function projectVersions(slug: string, loader: string): Promise<string[]> {
    return cached(`project:${loader}:${slug}`, async () => {
        const parsed = versionsSchema.safeParse(
            await modrinthJson(
                `${modrinthApi}/project/${encodeURIComponent(slug)}/version?loaders=${encodeURIComponent(JSON.stringify([loader]))}`
            )
        );
        return parsed.success ? [...new Set(parsed.data.flatMap((build) => build.game_versions))] : [];
    });
}

/** Minecraft's releases, newest first. Snapshots are left out: a blueprint that
 *  pinned one would put the whole server on a version nobody plays. */
async function releases(): Promise<string[]> {
    return cached("releases", async () => {
        const parsed = tagSchema.safeParse(await modrinthJson(`${modrinthApi}/tag/game_version`));
        return parsed.success
            ? parsed.data.filter((entry) => entry.version_type === "release").map((entry) => entry.version)
            : [];
    });
}

/**
 * Every release all of these projects support, newest first.
 *
 * Empty covers three cases the caller treats the same way - there are no projects
 * to constrain the version, Modrinth could not be reached, or the projects share
 * no release at all - because in each of them the honest thing is to leave the
 * operator's own choice alone rather than pin a version on a guess.
 *
 * The whole list rather than only its head, because the operator picks from it:
 * a blueprint that can run on six releases should let somebody choose the one
 * their players are on, and a picker built from anything wider would offer the
 * releases that produce the silent nothing this module exists to prevent.
 */
export async function commonVersions(projects: readonly string[], loader = DEFAULT_LOADER): Promise<string[]> {
    const slugs = projects.map(projectSlug).filter((slug): slug is string => slug !== null);
    if (slugs.length === 0) return [];

    const [ordered, supported] = await Promise.all([
        releases(),
        Promise.all(slugs.map((slug) => projectVersions(slug, loader)))
    ]);
    if (ordered.length === 0 || supported.some((versions) => versions.length === 0)) return [];

    const sets = supported.map((versions) => new Set(versions));
    // The tag list is newest first, so the releases all of them carry come out in
    // the same order.
    return ordered.filter((version) => sets.every((set) => set.has(version)));
}

/** Minecraft's own releases, newest first, for a server whose plugins put no
 *  constraint on which one it runs. */
export async function releaseVersions(): Promise<string[]> {
    return releases();
}

/** The newest release every one of these projects supports, or null. */
export async function newestCommonVersion(projects: readonly string[]): Promise<string | null> {
    return (await commonVersions(projects))[0] ?? null;
}

/**
 * Whether a release is one these projects positively cannot run on.
 *
 * Positively: an empty list means nothing is known - no projects, or Modrinth out
 * of reach - and "nothing is known" must never be reported as "this will not
 * work". The caller refuses a create on the strength of this, and refusing one
 * because an index was down would be the worse failure.
 */
export function knownUnsupported(versions: readonly string[], version: string): boolean {
    return versions.length > 0 && !versions.includes(version.trim());
}

/** Whether the operator asked for whatever is newest, which is the only case a
 *  blueprint is allowed to decide the version for. A pinned version is a
 *  deliberate choice and is never overridden. */
export function wantsLatest(version: string | undefined): boolean {
    const value = (version ?? "").trim();
    return value.length === 0 || value.toUpperCase() === "LATEST";
}

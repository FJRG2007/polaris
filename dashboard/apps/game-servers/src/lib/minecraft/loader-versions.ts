/**
 * The versions of a mod loader there are for one Minecraft release, as the
 * loader's own repository lists them.
 *
 * What the loader card offers when somebody wants a version other than the one
 * the server holds - back to the build before an update that broke a mod, or on
 * to one a mod asks for. Each list is read from the same repository the image
 * installs from, so every entry is a version the next start can download:
 *
 * - Fabric and Quilt publish the loader builds per release in their meta APIs.
 * - NeoForge publishes every build in one list, numbered after the release
 *   (21.4.x is Minecraft 1.21.4, 26.3.0.x is Minecraft 26.3).
 * - Forge publishes a map of release to builds, each written `<release>-<build>`;
 *   the image is given the build alone.
 *
 * Parsing is pure and kept apart from the requests so it can be tested on the
 * repositories' real answers.
 */

import { z } from "zod";
import { fresh } from "../fresh";
import type { PinnableType } from "./loader-pin";

/** Where each repository answers. */
const SOURCES: Record<PinnableType, (minecraft: string) => string> = {
    FABRIC: (minecraft) =>
        `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraft)}`,
    QUILT: (minecraft) =>
        `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(minecraft)}`,
    NEOFORGE: () =>
        "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
    FORGE: () => "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json"
};

/** The same shape the pin accepts: a version that can go into a variable as-is. */
const VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

/** More than any loader has published for one release; a bound on a stranger's
 *  answer rather than a limit anybody meets. */
const MOST_VERSIONS = 1000;

const metaSchema = z
    .array(z.object({ loader: z.object({ version: z.string().max(64) }) }))
    .max(5000);
const mavenSchema = z.object({ versions: z.array(z.string().max(64)).max(20000) });
const forgeSchema = z.record(z.string().max(32), z.array(z.string().max(96)).max(5000));

/** NeoForge's number for a release: 1.21.4 is 21.4, 1.21 is 21.0, and from the
 *  year-numbered releases on the release itself, to three places (26.3.0). */
export function neoforgePrefix(minecraft: string): string | null {
    const parts = minecraft.trim().split(".");
    if (parts.some((part) => !/^\d+$/.test(part))) return null;
    if (parts[0] === "1") {
        const rest = parts.slice(1);
        if (rest.length === 0 || rest.length > 2) return null;
        return `${rest[0]}.${rest[1] ?? "0"}.`;
    }
    if (parts.length > 3) return null;
    return `${[...parts, "0", "0"].slice(0, 3).join(".")}.`;
}

/** Newest first, by the numbers in them rather than by their letters, so 0.19.10
 *  comes before 0.19.9. */
function newestFirst(versions: readonly string[]): string[] {
    return [...new Set(versions)].sort((a, b) =>
        b.localeCompare(a, "en", { numeric: true, sensitivity: "base" })
    );
}

/** The loader versions an answer lists for one release, newest first. Empty for
 *  an answer that is not what the repository is supposed to send. */
export function loaderVersionsFrom(type: PinnableType, minecraft: string, body: unknown): string[] {
    let found: string[] = [];
    if (type === "FABRIC" || type === "QUILT") {
        const parsed = metaSchema.safeParse(body);
        found = parsed.success ? parsed.data.map((entry) => entry.loader.version) : [];
    } else if (type === "NEOFORGE") {
        const parsed = mavenSchema.safeParse(body);
        const prefix = neoforgePrefix(minecraft);
        found =
            parsed.success && prefix
                ? parsed.data.versions.filter((version) => version.startsWith(prefix))
                : [];
    } else {
        const parsed = forgeSchema.safeParse(body);
        const builds = parsed.success ? (parsed.data[minecraft] ?? []) : [];
        found = builds
            .filter((build) => build.startsWith(`${minecraft}-`))
            .map((build) => build.slice(minecraft.length + 1));
    }
    return newestFirst(found.filter((version) => VERSION_SHAPE.test(version))).slice(
        0,
        MOST_VERSIONS
    );
}

/** The repositories move about as often as a loader is released. */
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const cache = new Map<string, { at: number; versions: string[] }>();

/** The versions there are, newest first. Empty when the repository could not be
 *  reached or answered with something else - which the card reads as "nothing
 *  to offer right now", never as "there are none". */
export async function fetchLoaderVersions(
    type: PinnableType,
    minecraft: string
): Promise<string[]> {
    const key = `${type}:${minecraft}`;
    const hit = cache.get(key);
    if (hit && fresh(hit.at, CACHE_MS)) return hit.versions;
    const versions = await fetch(SOURCES[type](minecraft), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => loaderVersionsFrom(type, minecraft, body))
        .catch(() => []);
    // A failure is not remembered: the next look should get to try again.
    if (versions.length > 0) cache.set(key, { at: Date.now(), versions });
    return versions;
}

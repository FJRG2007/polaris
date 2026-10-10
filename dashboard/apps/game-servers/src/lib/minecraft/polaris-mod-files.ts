/**
 * The login mod's builds as this app's bundle carries them.
 *
 * The image build puts each jar in the bundle's `assets/minecraft-mods`, beside
 * a `.version` file holding the version that jar reports when a server checks in.
 * That version carries a fingerprint of the mod's source, so it changes whenever
 * the jar does - which is what lets the panel tell a server still running an
 * older build from one that is current, without anybody remembering to raise a
 * number.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { MOD_FILES } from "./polaris-login";
import { SYMBIOTE_FILES } from "./symbiote";
import { ANTICHEAT_FILE, ANTICHEAT_FILES } from "./polaris-anticheat";

/** Where the bundle carries the builds: beside its server half, which is where
 *  `__dirname` points when the dashboard loads it. Overridable for a development
 *  checkout that built them somewhere else. */
export function modDir(): string {
    return (
        process.env.POLARIS_MINECRAFT_MODS_DIR ||
        path.join(__dirname, "..", "assets", "minecraft-mods")
    );
}

/** Every jar the bundle carries: the login's builds, the anti-cheat's, and the
 *  mods Polaris carries for the operator. */
const SERVED: readonly string[] = [...MOD_FILES, ...ANTICHEAT_FILES, ...SYMBIOTE_FILES];

/** Where one build lives, or null for a name that is not one. */
export function modPath(file: string): string | null {
    return SERVED.includes(file) ? path.join(modDir(), file) : null;
}

/** The version a build reports, or null when the image has no record of it. The
 *  files never change under a running dashboard, so each is read once. */
const versions = new Map<string, Promise<string | null>>();

export function bundledModVersion(file: string): Promise<string | null> {
    const location = modPath(file);
    if (location === null) return Promise.resolve(null);
    let version = versions.get(file);
    if (!version) {
        version = readFile(`${location}.version`, "utf8")
            .then((text) => text.trim() || null)
            .catch(() => null);
        versions.set(file, version);
    }
    return version;
}

/**
 * Whether this image carries the anti-cheat's jar - the plugin, or the mod build
 * that carries it on NeoForge. A server with it on the list downloads it on every
 * boot and does not start when the answer is not the jar, so nothing switches it
 * on while the image has none to serve.
 */
export async function anticheatBundled(file: string = ANTICHEAT_FILE): Promise<boolean> {
    return jarBundled(file);
}

/** Whether this image carries a jar it serves. A server with one on its list
 *  does not start when the download is not the jar. */
export async function jarBundled(file: string): Promise<boolean> {
    const location = modPath(file);
    if (location === null) return false;
    const info = await stat(location).catch(() => null);
    return info?.isFile() ?? false;
}

/** A served jar's sha1, as the mod pack's installers check a download against,
 *  or null when the image does not carry it. Read once, like the versions. */
const checksums = new Map<string, Promise<string | null>>();

export function bundledSha1(file: string): Promise<string | null> {
    const location = modPath(file);
    if (location === null) return Promise.resolve(null);
    let sum = checksums.get(file);
    if (!sum) {
        sum = readFile(location)
            .then((bytes) => createHash("sha1").update(bytes).digest("hex"))
            .catch(() => null);
        checksums.set(file, sum);
    }
    return sum;
}

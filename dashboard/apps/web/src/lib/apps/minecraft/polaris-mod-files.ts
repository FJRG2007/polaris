/**
 * The login mod's builds as this dashboard image carries them.
 *
 * The image puts each jar in one folder, beside a `.version` file holding the
 * version that jar reports when a server checks in. That version carries a
 * fingerprint of the mod's source, so it changes whenever the jar does - which is
 * what lets the panel tell a server still running an older build from one that
 * is current, without anybody remembering to raise a number.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { MOD_FILES } from "./polaris-login";

/** Where the image puts the builds. Overridable for a development checkout that
 *  built them somewhere else. */
export function modDir(): string {
    return process.env.POLARIS_MINECRAFT_MODS_DIR || "/app/minecraft-mods";
}

/** Where one build lives, or null for a name that is not one. */
export function modPath(file: string): string | null {
    return MOD_FILES.includes(file) ? path.join(modDir(), file) : null;
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

/**
 * What a server has to carry for its own sounds to reach players, and how a
 * change to its software keeps or drops it.
 *
 * Handing a pack to players who are already on the server, without a restart,
 * needs something inside the server: the game has no command for it. That is
 * Polaris's own jar - the NeoForge mod, which every server it has a build for
 * already carries (`componentFileFor`), or the plugin on Paper, Purpur and
 * Spigot, which is only there for the login until sounds put it there too. The
 * plugin is held on the list by `POLARIS_SOUNDS=on`, so switching the login off
 * does not take it away.
 *
 * Everywhere else (vanilla, Fabric, Forge, a release Polaris has no build for)
 * the pack can still be the server's own resource pack: offered on every join
 * from a link that always serves the newest one, so a change reaches whoever
 * joins next. It is only written where the server has no pack of its own.
 *
 * Pure: nothing here reads or writes a server.
 */

import { loaderForType } from "./modrinth";
import {
    MODS_KEY,
    SERVER_ID_KEY,
    TOKEN_KEY,
    URL_KEY,
    carriesFile,
    modFileFor,
    modUrl,
    withMod
} from "./polaris-login";
import { SOUNDS_KEY } from "./sounds";

export const RESOURCE_PACK_KEY = "RESOURCE_PACK";
export const RESOURCE_PACK_SHA1_KEY = "RESOURCE_PACK_SHA1";
export const RESOURCE_PACK_ENFORCE_KEY = "RESOURCE_PACK_ENFORCE";

/** What carries the sounds on this software and release, or null. */
export type SoundsBuild =
    | { readonly kind: "mod"; readonly file: string }
    | { readonly kind: "plugin"; readonly file: string };

export function soundsBuildFor(software: string, version: string): SoundsBuild | null {
    const file = modFileFor(software, version);
    if (file === null) return null;
    return loaderForType(software) === "neoforge" ? { kind: "mod", file } : { kind: "plugin", file };
}

function buildOf(env: ReadonlyMap<string, string>): SoundsBuild | null {
    return soundsBuildFor(env.get("TYPE") ?? "", env.get("VERSION") ?? "");
}

/** Whether sounds are what keeps the plugin on this server's list. */
export function soundsHoldPlugin(env: ReadonlyMap<string, string>): boolean {
    const build = buildOf(env);
    return (
        build?.kind === "plugin" &&
        env.get(SOUNDS_KEY)?.trim().toLowerCase() === "on" &&
        carriesFile(env.get(MODS_KEY) ?? "", build.file)
    );
}

/** Whether the server carries its build and knows where Polaris is: what the
 *  jar needs to fetch the pack when it starts. */
export function soundsReady(env: ReadonlyMap<string, string>, installedAppId: string): boolean {
    const build = buildOf(env);
    return (
        build !== null &&
        carriesFile(env.get(MODS_KEY) ?? "", build.file) &&
        (env.get(URL_KEY) ?? "").trim().length > 0 &&
        env.get(SERVER_ID_KEY)?.trim() === installedAppId
    );
}

/**
 * What switching sounds on writes, or an empty map when the server already has
 * all of it: its build on the list, from this Polaris, and where to ask for the
 * pack. The token is the one the server has when it has one.
 */
export function soundsEnableEnv(
    current: ReadonlyMap<string, string>,
    input: { readonly baseUrl: string; readonly installedAppId: string; readonly token: string; readonly hasToken: boolean }
): Map<string, string> {
    const build = buildOf(current);
    const writes = new Map<string, string>();
    if (build === null) return writes;
    const mods = current.get(MODS_KEY) ?? "";
    if (!carriesFile(mods, build.file)) writes.set(MODS_KEY, withMod(mods, modUrl(input.baseUrl, build.file)));
    const base = input.baseUrl.replace(/\/+$/, "");
    if (!(current.get(URL_KEY) ?? "").trim()) writes.set(URL_KEY, base);
    if (current.get(SERVER_ID_KEY)?.trim() !== input.installedAppId) writes.set(SERVER_ID_KEY, input.installedAppId);
    if (!input.hasToken) writes.set(TOKEN_KEY, input.token);
    if (build.kind === "plugin" && current.get(SOUNDS_KEY)?.trim().toLowerCase() !== "on")
        writes.set(SOUNDS_KEY, "on");
    return writes;
}

/** Whether the build has to be put on the list, which is a restart. */
export function soundsNeedRestart(writes: ReadonlyMap<string, string>): boolean {
    return writes.has(MODS_KEY);
}

/**
 * What a move to other software or another release has to write for the sounds'
 * plugin, or null: it comes off where it does not load (a plugin copied into a
 * mod loader's folder ends the boot on some of them), unless the login still
 * holds it - the login's own move decides that. `mods` is the list as the rest
 * of the same save leaves it.
 */
export function soundsMovedTo(
    env: ReadonlyMap<string, string>,
    software: string,
    version: string,
    mods: string = env.get(MODS_KEY) ?? ""
): Map<string, string> | null {
    if (!soundsHoldPlugin(env)) return null;
    const from = buildOf(env);
    const to = soundsBuildFor(software, version);
    if (from !== null && to !== null && from.kind === to.kind && from.file === to.file) return null;
    const kept = mods
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && !(from !== null && carriesFile(entry, from.file)))
        .join(",");
    return new Map([
        [MODS_KEY, kept],
        [SOUNDS_KEY, ""]
    ]);
}

/** The part of a link that makes it this server's sound pack, whatever address
 *  it was written with. */
export function serverPackMarker(installedAppId: string): string {
    return `/api/minecraft/sounds/${installedAppId}/`;
}

/** Whether the server's own resource pack is free for the sounds: none, or the
 *  sounds' already. */
export function serverPackFree(env: ReadonlyMap<string, string>, installedAppId: string): boolean {
    const pack = (env.get(RESOURCE_PACK_KEY) ?? "").trim();
    return pack === "" || pack.includes(serverPackMarker(installedAppId));
}

/** Whether the server's own resource pack is the sounds'. */
export function serverPackIsOurs(env: ReadonlyMap<string, string>, installedAppId: string): boolean {
    return (env.get(RESOURCE_PACK_KEY) ?? "").includes(serverPackMarker(installedAppId));
}

/** What offering the sounds as the server's resource pack writes. No checksum:
 *  the link always serves the newest pack, and without one the game fetches it
 *  on every join, which is how a change reaches the next player in. */
export function serverPackEnv(url: string, required: boolean): Map<string, string> {
    return new Map([
        [RESOURCE_PACK_KEY, url],
        [RESOURCE_PACK_SHA1_KEY, ""],
        [RESOURCE_PACK_ENFORCE_KEY, required ? "true" : "false"]
    ]);
}

/** What taking it back writes. */
export function serverPackOffEnv(): Map<string, string> {
    return new Map([
        [RESOURCE_PACK_KEY, ""],
        [RESOURCE_PACK_SHA1_KEY, ""],
        [RESOURCE_PACK_ENFORCE_KEY, "false"]
    ]);
}

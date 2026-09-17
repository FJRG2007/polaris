/**
 * Polaris's own login mod: what a server has to carry for it, and when it can.
 *
 * It comes as a mod for NeoForge and as a plugin for Paper, Purpur and Spigot;
 * "the mod" below means either. The other join guards are Modrinth projects and
 * live on the project list. This one is not on Modrinth: the jar is built into
 * the dashboard image and the server's image downloads it from here, through
 * `MODS` - on a plugin server too, where the image copies `MODS` into the
 * plugins folder (its `start-setupModpack` hands `MODS` and `PLUGINS` to the
 * same copy there), so the one list carries both. So whether it is on is
 * read from two places - the jar on `MODS` and the switch the mod itself reads -
 * and everything that decides a server's guard has to look at both, or it seeds a
 * second login beside this one.
 *
 * The mod keeps no passwords. It asks Polaris over HTTP, which is why it needs the
 * address, the server's id and a token, and why a server that cannot reach Polaris
 * lets nobody in: it fails closed, and says so to the player and in its log.
 *
 * `MODS` is its own list. The image copies what it names into the mods folder and
 * removes, on a later boot, only files that list itself put there (a manifest per
 * list), so writing it never touches what the Modrinth list installed. The catch
 * is that a download that fails ends the boot: while this is on, a server only
 * starts when it can reach Polaris.
 *
 * Pure: nothing here reads or writes a server.
 */

import { loaderForType } from "./modrinth";

/** The image's list of jars to download, by URL. */
export const MODS_KEY = "MODS";

/** The switch the mod reads. Anything but `on` leaves the mod idle, which is what
 *  makes a jar left behind in the mods folder harmless. */
export const LOGIN_KEY = "POLARIS_LOGIN";

/** Where the mod reaches Polaris. */
export const URL_KEY = "POLARIS_URL";

/** Which server it is asking about. */
export const SERVER_ID_KEY = "POLARIS_SERVER_ID";

/** What it proves it is that server with. Stored as a secret. */
export const TOKEN_KEY = "POLARIS_SERVER_TOKEN";

/** The path the dashboard serves the jars under. */
export const MOD_PATH = "/api/minecraft/mod";

/** One jar the dashboard image carries, and the servers it loads on. */
export interface ModBuild {
    readonly file: string;
    /** Modrinth's loader names, as `loaderForType` gives them. */
    readonly loaders: readonly string[];
    /** Whether it loads on this release, as the server's `VERSION` spells it. */
    readonly runsOn: (version: string) => boolean;
}

/**
 * The oldest release the plugin is offered on: where Minecraft moved to Java 21,
 * which it is built for. It is compiled against this release's API and declares
 * it (`resources/minecraft/polaris-paper/gradle.properties`).
 */
export const PLUGIN_SINCE = "1.20.6";

/** A release as numbers, or null for anything that is not a plain release. */
function releaseParts(version: string): number[] | null {
    return /^\d+(\.\d+)*$/.test(version) ? version.split(".").map(Number) : null;
}

function atLeast(version: string, floor: string): boolean {
    const parts = releaseParts(version);
    const min = releaseParts(floor) ?? [];
    if (parts === null) return false;
    for (let at = 0; at < Math.max(parts.length, min.length); at++) {
        const left = parts[at] ?? 0;
        const right = min[at] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
}

/**
 * The builds the dashboard image carries.
 *
 * A mod declares the one release it was built for and the loader refuses to start
 * on any other, so a release missing here is a server the mod is not offered to -
 * not one that gets the nearest build. A plugin is different: Paper, Purpur and
 * Spigot load one built against an older API on every release after it, so the
 * plugin is offered from its floor on, LATEST included. `test/apps/polaris-login.test.ts`
 * checks that the image builds every file named here.
 */
export const MOD_BUILDS: readonly ModBuild[] = [
    {
        file: "polaris-neoforge-1.21.4.jar",
        loaders: ["neoforge"],
        runsOn: (version) => version === "1.21.4"
    },
    {
        file: "polaris-paper.jar",
        loaders: ["paper", "spigot"],
        runsOn: (version) => version.toUpperCase() === "LATEST" || atLeast(version, PLUGIN_SINCE)
    }
];

/** Every file the dashboard serves, for the route that serves them. */
export const MOD_FILES: readonly string[] = MOD_BUILDS.map((build) => build.file);

/** The build for this software and release, or null when there is none. */
export function modFileFor(software: string, version: string): string | null {
    const loader = loaderForType(software);
    if (!loader) return null;
    const release = version.trim();
    return (
        MOD_BUILDS.find((build) => build.loaders.includes(loader) && build.runsOn(release))?.file ??
        null
    );
}

/** Whether any build loads on this software, whatever the release - the question
 *  of whether a screen should ask about Polaris login at all. */
export function hasBuildFor(software: string): boolean {
    const loader = loaderForType(software);
    return loader !== null && MOD_BUILDS.some((build) => build.loaders.includes(loader));
}

/** Where a server downloads the build from. */
export function modUrl(baseUrl: string, file: string): string {
    return `${baseUrl.replace(/\/+$/, "")}${MOD_PATH}/${file}`;
}

/** The image splits `MODS` on commas and newlines. */
function modEntries(mods: string): string[] {
    return mods
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Each build's name without its release: `polaris-neoforge`, `polaris-paper`. */
const BUILD_FAMILIES: readonly string[] = MOD_FILES.map((file) =>
    file.replace(/(-[0-9][0-9.]*)?\.jar$/, "")
);

/** Whether an entry is one of these builds - for any release, and whichever
 *  address it was written with, since the dashboard's address can change after
 *  it was. */
function isModEntry(entry: string): boolean {
    const path = entry.split(/[?#]/)[0] ?? "";
    const file = path.slice(path.lastIndexOf("/") + 1);
    const release = /(-[0-9][0-9.]*)?\.jar$/.exec(file);
    return release !== null && BUILD_FAMILIES.includes(file.slice(0, release.index));
}

export function hasMod(mods: string): boolean {
    return modEntries(mods).some(isModEntry);
}

/** The list without any build of the mod. Empty is a real value, not an absent
 *  one: the image only removes what the list dropped when the list is set. */
export function withoutMod(mods: string): string {
    return modEntries(mods)
        .filter((entry) => !isModEntry(entry))
        .join(",");
}

/** The list with exactly this build of the mod on it. */
export function withMod(mods: string, url: string): string {
    return [...modEntries(withoutMod(mods)), url].join(",");
}

/** Whether a server's environment has the mod switched on. */
export function loginOn(env: ReadonlyMap<string, string>): boolean {
    return env.get(LOGIN_KEY)?.trim().toLowerCase() === "on" && hasMod(env.get(MODS_KEY) ?? "");
}

/**
 * What turning the mod on writes, apart from the project list - `join-guard` owns
 * that half, and takes the other guards off it.
 *
 * The caller passes the token the server already has when there is one, so turning
 * it off and on again does not strand a running server on the old one.
 */
export function enableEnv(input: {
    readonly current: ReadonlyMap<string, string>;
    readonly baseUrl: string;
    readonly installedAppId: string;
    readonly file: string;
    readonly token: string;
}): Map<string, string> {
    const { current } = input;
    return new Map([
        [MODS_KEY, withMod(current.get(MODS_KEY) ?? "", modUrl(input.baseUrl, input.file))],
        [LOGIN_KEY, "on"],
        [URL_KEY, input.baseUrl.replace(/\/+$/, "")],
        [SERVER_ID_KEY, input.installedAppId],
        [TOKEN_KEY, input.token]
    ]);
}

/** Those writes as environment variables, with the token kept secret. */
export function envWrites(
    writes: ReadonlyMap<string, string>
): { key: string; value: string; isSecret: boolean }[] {
    return [...writes].map(([key, value]) => ({ key, value, isSecret: key === TOKEN_KEY }));
}

/** What turning it off writes. The token stays: it is worthless without the
 *  switch, and keeping it means turning it back on changes nothing a running
 *  server holds. */
export function disableEnv(current: ReadonlyMap<string, string>): Map<string, string> {
    return new Map([
        [MODS_KEY, withoutMod(current.get(MODS_KEY) ?? "")],
        [LOGIN_KEY, "off"]
    ]);
}

/**
 * What the mod needs written for a server whose software or release is about to
 * be these.
 *
 * Null when there is nothing to do: the mod is off, or the server already names the
 * build for where it is going. Otherwise the variables to write - the build for the
 * new release, when there is one, or the ones that take the mod off. A build for
 * another release does not load, and the loader ends the boot over it, so keeping
 * it would be a server that never comes back up. When it comes off, the caller
 * seeds the project guard for the new software in its place, because a server that
 * was closed stays closed.
 */
export function modMovedTo(
    env: ReadonlyMap<string, string>,
    software: string,
    version: string
): Map<string, string> | null {
    if (!loginOn(env)) return null;
    const file = modFileFor(software, version);
    if (file !== null) {
        // Still the right software and release, but maybe written as another
        // build's address. Point it at the one this release loads.
        const mods = env.get(MODS_KEY) ?? "";
        const listed = modEntries(mods).find(isModEntry) ?? "";
        if (listed.endsWith(`/${file}`)) return null;
        const at = listed.lastIndexOf(MOD_PATH);
        const base = at > 0 ? listed.slice(0, at) : "";
        if (base) return new Map([[MODS_KEY, withMod(mods, modUrl(base, file))]]);
    }
    return disableEnv(env);
}

/** How long a running server may go without checking in before the panel says so.
 *  The mod checks in every minute. */
export const SILENCE_MS = 3 * 60_000;

export type LoginHealth =
    /** It checked in recently. */
    | "ok"
    /** The server is not up, or has not been up long enough to have checked in. */
    | "waiting"
    /** The server has been up a while and the mod has not reached Polaris. Nobody
     *  can join it. */
    | "silent";

export function loginHealth(input: {
    readonly seenAt: Date | null;
    /** When the server's current run began, or null when it is not up. */
    readonly upSince: Date | null;
    readonly now: Date;
}): LoginHealth {
    const { seenAt, upSince, now } = input;
    if (seenAt && now.getTime() - seenAt.getTime() <= SILENCE_MS) return "ok";
    if (!upSince || now.getTime() - upSince.getTime() <= SILENCE_MS) return "waiting";
    // Up for a while, and the last check-in is older than the run or than the
    // silence allowed.
    return "silent";
}

/**
 * Whether the server runs an older build of the mod than this dashboard serves.
 *
 * The jar is only fetched when the server boots, so an update to it waits for a
 * restart. Only said of a server whose mod is on and has checked in: a silent one
 * has a louder problem, and one with no check-in has not said what it runs.
 */
export function modOutdated(input: {
    readonly on: boolean;
    readonly health: LoginHealth;
    /** What the server last said it runs. */
    readonly running: string | null;
    /** What this dashboard serves it, or null when the image did not say. */
    readonly current: string | null;
}): boolean {
    const { on, health, running, current } = input;
    return on && health === "ok" && running !== null && current !== null && running !== current;
}

/** What a player's name has to look like. The same rule the game applies to a
 *  name in offline mode: up to sixteen printable characters, no spaces. */
export const PLAYER_NAME = /^[!-~]{1,16}$/;

export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 64;

/**
 * Polaris's own login mod: what a server has to carry for it, and when it can.
 *
 * The other join guards are Modrinth projects and live on the project list. This
 * one is not on Modrinth: the jar is built into the dashboard image and the
 * server's image downloads it from here, through `MODS`. So whether it is on is
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

/**
 * The builds the dashboard image carries, per loader, per release.
 *
 * A mod declares the one release it was built for and the loader refuses to start
 * on any other, so a release missing here is a server this is not offered to -
 * not one that gets the nearest build. `test/apps/polaris-login.test.ts` checks
 * that the image builds every file named here.
 */
export const MOD_BUILDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    neoforge: { "1.21.4": "polaris-neoforge-1.21.4.jar" }
};

/** Every file the dashboard serves, for the route that serves them. */
export const MOD_FILES: readonly string[] = Object.values(MOD_BUILDS).flatMap((builds) =>
    Object.values(builds)
);

/** The build for this software and release, or null when there is none. A server
 *  left on LATEST has no release to match, so it gets none either. */
export function modFileFor(software: string, version: string): string | null {
    const loader = loaderForType(software);
    if (!loader) return null;
    return MOD_BUILDS[loader]?.[version.trim()] ?? null;
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

/** Whether an entry is one of these builds, whichever address it was written
 *  with - the dashboard's address can change after it was. */
function isModEntry(entry: string): boolean {
    const path = entry.split(/[?#]/)[0] ?? "";
    const file = path.slice(path.lastIndexOf("/") + 1);
    return /^polaris-[a-z]+-[0-9][0-9.]*\.jar$/.test(file);
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

/** What a player's name has to look like. The same rule the game applies to a
 *  name in offline mode: up to sixteen printable characters, no spaces. */
export const PLAYER_NAME = /^[!-~]{1,16}$/;

export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 64;

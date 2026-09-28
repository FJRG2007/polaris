/**
 * Polaris's own anti-cheat engine: what a server has to carry for it, and where it
 * can run.
 *
 * It is a plugin, built into the dashboard image from
 * `resources/minecraft/polaris-anticheat` and downloaded by the server's image
 * through `MODS` like the login mod (`polaris-login`): on a plugin server the
 * image copies that list into the plugins folder. It is its own entry on the list
 * and its own switch, so turning the login on or off never touches it, and the
 * other way round.
 *
 * It simulates each player's movement packet by packet, so it runs only where it
 * can read those packets: Paper and everything built on it, Folia and Spigot -
 * Minecraft 1.8 to the latest, on the Java the managed images carry. The servers
 * that load plugins on top of a mod loader are left out: their mods change how
 * players move, and a simulation that does not know about them would accuse
 * everybody.
 *
 * What it catches it hands back to Polaris over HTTP, at the plugin's own alert
 * thresholds, so the Anti-cheat tab lists it: for that it carries the same
 * address, server id and token the login plugin uses (one token per server,
 * whichever of the two switched it on first).
 *
 * Pure: nothing here reads or writes a server.
 */

import { formatProjectList, loaderForType, parseProjectList, projectSlug } from "./modrinth";
import { MOD_PATH, MODS_KEY, SERVER_ID_KEY, TOKEN_KEY, URL_KEY } from "./polaris-login";

/** The switch: `on` when Polaris installed the plugin, `off` when somebody turned
 *  it off. The plugin reads it too, and reports to Polaris only while it is on. */
export const ANTICHEAT_KEY = "POLARIS_ANTICHEAT";

/** Where a server's Modrinth list lives. */
export const PROJECTS_KEY = "MODRINTH_PROJECTS";

/**
 * Anti-cheat plugins from Modrinth this engine replaces, by project slug. Servers
 * used to be seeded with one; two anti-cheats reading the same packets flag each
 * other's corrections, so switching this one on takes those off the list.
 */
export const REPLACED_PROJECTS: readonly string[] = ["grimac"];

/** A Modrinth list without the anti-cheats this engine replaces. */
export function withoutReplacedAnticheats(projects: string): string {
    const kept = parseProjectList(projects).filter(
        (entry) => !REPLACED_PROJECTS.includes(projectSlug(entry)?.toLowerCase() ?? "")
    );
    return formatProjectList(kept);
}

/**
 * Whether Polaris should switch the engine on for this server by itself: it runs
 * there, and nobody has decided either way. An owner who turned it off has `off`
 * written, which is a decision, and is kept.
 */
export function wantsDefaultAnticheat(env: ReadonlyMap<string, string>): boolean {
    const decided = (env.get(ANTICHEAT_KEY) ?? "").trim().toLowerCase();
    return decided === "" && anticheatRunsOn(env.get("TYPE") ?? "");
}

/** The file the dashboard serves the plugin as. */
export const ANTICHEAT_FILE = "polaris-anticheat-bukkit.jar";

/** Every file of it the dashboard serves, for the route. */
export const ANTICHEAT_FILES: readonly string[] = [ANTICHEAT_FILE];

/** Modrinth's loader names it runs on, as `loaderForType` gives them. */
const LOADERS: readonly string[] = ["paper", "folia", "spigot"];

/** Whether the engine runs on this software. */
export function anticheatRunsOn(software: string): boolean {
    const loader = loaderForType(software);
    return loader !== null && LOADERS.includes(loader);
}

/** The image splits `MODS` on commas and newlines. */
function entries(mods: string): string[] {
    return mods
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Whether an entry is the engine, whichever address it was written with. */
function isEntry(entry: string): boolean {
    const path = entry.split(/[?#]/)[0] ?? "";
    return ANTICHEAT_FILES.includes(path.slice(path.lastIndexOf("/") + 1));
}

/** Whether a server's environment has the engine switched on. */
export function anticheatOn(env: ReadonlyMap<string, string>): boolean {
    return (
        env.get(ANTICHEAT_KEY)?.trim().toLowerCase() === "on" &&
        entries(env.get(MODS_KEY) ?? "").some(isEntry)
    );
}

/** What turning it on writes: the plugin on the list, from this Polaris, and
 *  where it reports what it catches. */
export function anticheatEnableEnv(
    current: ReadonlyMap<string, string>,
    input: { readonly baseUrl: string; readonly installedAppId: string; readonly token: string }
): Map<string, string> {
    const base = input.baseUrl.replace(/\/+$/, "");
    const kept = entries(current.get(MODS_KEY) ?? "").filter((entry) => !isEntry(entry));
    const projects = current.get(PROJECTS_KEY);
    return new Map([
        [MODS_KEY, [...kept, `${base}${MOD_PATH}/${ANTICHEAT_FILE}`].join(",")],
        ...(projects !== undefined && withoutReplacedAnticheats(projects) !== projects
            ? [[PROJECTS_KEY, withoutReplacedAnticheats(projects)] as [string, string]]
            : []),
        [ANTICHEAT_KEY, "on"],
        [URL_KEY, base],
        [SERVER_ID_KEY, input.installedAppId],
        [TOKEN_KEY, input.token]
    ]);
}

/**
 * What a move to other software has to write for the engine, or null: it comes
 * off a server moving to software it cannot run on, since a plugin copied into a
 * mod loader's folder is at best dead weight. `mods` is the list as the rest of
 * the same save leaves it.
 */
export function anticheatMovedTo(
    env: ReadonlyMap<string, string>,
    software: string,
    mods: string = env.get(MODS_KEY) ?? ""
): Map<string, string> | null {
    if (!anticheatOn(env) || anticheatRunsOn(software)) return null;
    return anticheatDisableEnv(new Map([[MODS_KEY, mods]]));
}

/** What turning it off writes. Empty is a real value: the image only removes
 *  what the list dropped when the list is set. */
export function anticheatDisableEnv(current: ReadonlyMap<string, string>): Map<string, string> {
    return new Map([
        [
            MODS_KEY,
            entries(current.get(MODS_KEY) ?? "")
                .filter((entry) => !isEntry(entry))
                .join(",")
        ],
        [ANTICHEAT_KEY, "off"]
    ]);
}

/** Those writes as environment variables, with the token kept secret. */
export function anticheatEnvWrites(
    writes: ReadonlyMap<string, string>
): { key: string; value: string; isSecret: boolean }[] {
    return [...writes].map(([key, value]) => ({ key, value, isSecret: key === TOKEN_KEY }));
}

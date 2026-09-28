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
 * On a NeoForge server Polaris has a build of its own mod for, the plugin cannot
 * run but the mod carries the anti-xray part of it (see `polaris-neoforge`), so
 * the same switch turns that on and off: a server there counts as protected, and
 * gets it by default, like a plugin server.
 *
 * What it catches it hands back to Polaris over HTTP, at the plugin's own alert
 * thresholds, so the Anti-cheat tab lists it: for that it carries the same
 * address, server id and token the login plugin uses (one token per server,
 * whichever of the two switched it on first).
 *
 * Pure: nothing here reads or writes a server.
 */

import { formatProjectList, loaderForType, parseProjectList, projectSlug } from "./modrinth";
import {
    MOD_PATH,
    MODS_KEY,
    SERVER_ID_KEY,
    TOKEN_KEY,
    URL_KEY,
    loginOn,
    modFileFor
} from "./polaris-login";

/** The switch: `on` when Polaris installed the plugin, `off` when somebody turned
 *  it off. The plugin reads it too, and reports to Polaris only while it is on. */
export const ANTICHEAT_KEY = "POLARIS_ANTICHEAT";

/** The Polaris mod's own switch for its anti-xray: anything but `off` is on. */
export const ANTIXRAY_KEY = "POLARIS_ANTIXRAY";

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
    return (
        decided === "" &&
        anticheatBuildFor(env.get("TYPE") ?? "", env.get("VERSION") ?? "") !== null
    );
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

/**
 * What protects a server on this software and release: the plugin, the Polaris
 * mod's anti-xray, or nothing.
 */
export type AnticheatBuild =
    | { readonly kind: "plugin"; readonly file: string }
    | { readonly kind: "mod"; readonly file: string };

export function anticheatBuildFor(software: string, version: string): AnticheatBuild | null {
    if (anticheatRunsOn(software)) return { kind: "plugin", file: ANTICHEAT_FILE };
    if (loaderForType(software) !== "neoforge") return null;
    const file = modFileFor(software, version);
    return file ? { kind: "mod", file } : null;
}

/** The image splits `MODS` on commas and newlines. */
function entries(mods: string): string[] {
    return mods
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** The file an entry downloads, whichever address it was written with. */
function fileOf(entry: string): string {
    const path = entry.split(/[?#]/)[0] ?? "";
    return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether an entry is the engine plugin. */
function isEntry(entry: string): boolean {
    return ANTICHEAT_FILES.includes(fileOf(entry));
}

function carries(env: ReadonlyMap<string, string>, file: string): boolean {
    return entries(env.get(MODS_KEY) ?? "").some((entry) => fileOf(entry) === file);
}

/** Whether a server's environment has it switched on: the plugin, or the mod
 *  under the same switch. What the reporting route accepts a report on. */
export function anticheatOn(env: ReadonlyMap<string, string>): boolean {
    if (env.get(ANTICHEAT_KEY)?.trim().toLowerCase() !== "on") return false;
    const build = anticheatBuildFor(env.get("TYPE") ?? "", env.get("VERSION") ?? "");
    return (
        entries(env.get(MODS_KEY) ?? "").some(isEntry) ||
        (build?.kind === "mod" && carries(env, build.file))
    );
}

/**
 * Whether the server is protected when it next starts, as the switch shows it.
 *
 * The mod runs its anti-xray unless told not to, so a NeoForge server that has
 * the mod for its login is already protected with nothing written for this
 * switch - and saying "off" there would be wrong.
 */
export function anticheatActive(env: ReadonlyMap<string, string>): boolean {
    const build = anticheatBuildFor(env.get("TYPE") ?? "", env.get("VERSION") ?? "");
    if (!build) return false;
    if (build.kind === "plugin") return anticheatOn(env);
    const off = (key: string) => env.get(key)?.trim().toLowerCase() === "off";
    return carries(env, build.file) && !off(ANTICHEAT_KEY) && !off(ANTIXRAY_KEY);
}

/** What turning it on writes: the plugin on the list, from this Polaris, and
 *  where it reports what it catches. */
export function anticheatEnableEnv(
    current: ReadonlyMap<string, string>,
    input: { readonly baseUrl: string; readonly installedAppId: string; readonly token: string }
): Map<string, string> {
    const base = input.baseUrl.replace(/\/+$/, "");
    const build = anticheatBuildFor(current.get("TYPE") ?? "", current.get("VERSION") ?? "");
    const file = build?.file ?? ANTICHEAT_FILE;
    const kept = entries(current.get(MODS_KEY) ?? "").filter(
        (entry) => !isEntry(entry) && fileOf(entry) !== file
    );
    const projects = current.get(PROJECTS_KEY);
    return new Map([
        [MODS_KEY, [...kept, `${base}${MOD_PATH}/${file}`].join(",")],
        ...(build?.kind === "mod" ? [[ANTIXRAY_KEY, ""] as [string, string]] : []),
        ...(projects !== undefined && withoutReplacedAnticheats(projects) !== projects
            ? [[PROJECTS_KEY, withoutReplacedAnticheats(projects)] as [string, string]]
            : []),
        [ANTICHEAT_KEY, "on"],
        [URL_KEY, base],
        [SERVER_ID_KEY, input.installedAppId],
        [TOKEN_KEY, input.token]
    ]);
}

/** A `MODS` list without the engine on it, whichever address it was written with. */
export function withoutAnticheat(mods: string): string {
    return entries(mods)
        .filter((entry) => !isEntry(entry))
        .join(",");
}

/**
 * What a move to other software or another release has to write for the engine,
 * or null: it comes off a server moving where the same build does not load, since
 * a plugin copied into a mod loader's folder is at best dead weight and a mod
 * built for another release ends the boot. `env` is the server as it is before
 * the move, and `mods` the list as the rest of the same save leaves it. Nobody
 * decided against it, so the switch is left undecided rather than off, and
 * wherever it runs the default gets it on again with the build that loads there.
 */
export function anticheatMovedTo(
    env: ReadonlyMap<string, string>,
    software: string,
    version: string,
    mods: string = env.get(MODS_KEY) ?? ""
): Map<string, string> | null {
    if (!anticheatOn(env)) return null;
    const from = anticheatBuildFor(env.get("TYPE") ?? "", env.get("VERSION") ?? "");
    const to = anticheatBuildFor(software, version);
    if (from !== null && to !== null && from.kind === to.kind && from.file === to.file) return null;
    // The mod stays where the login still needs it; that switch moves it itself.
    const kept =
        from?.kind === "mod" && !loginOn(env)
            ? entries(withoutAnticheat(mods))
                  .filter((entry) => fileOf(entry) !== from.file)
                  .join(",")
            : withoutAnticheat(mods);
    return new Map([
        [MODS_KEY, kept],
        [ANTICHEAT_KEY, ""],
        ...(from?.kind === "mod" ? [[ANTIXRAY_KEY, ""] as [string, string]] : [])
    ]);
}

/** Whether the engine is switched on here through the Polaris mod, which then
 *  has to stay on the list whatever the login does. */
export function anticheatHoldsMod(env: ReadonlyMap<string, string>): boolean {
    const build = anticheatBuildFor(env.get("TYPE") ?? "", env.get("VERSION") ?? "");
    return build?.kind === "mod" && anticheatOn(env);
}

/** A `MODS` list without anything the engine put on it for this server: the
 *  plugin, and the mod's build unless the login still needs it. */
export function withoutAnticheatBuild(env: ReadonlyMap<string, string>): string {
    const mods = withoutAnticheat(env.get(MODS_KEY) ?? "");
    const build = anticheatBuildFor(env.get("TYPE") ?? "", env.get("VERSION") ?? "");
    if (build === null || !anticheatHoldsMod(env) || loginOn(env)) return mods;
    return entries(mods)
        .filter((entry) => fileOf(entry) !== build.file)
        .join(",");
}

/** What turning it off writes. Empty is a real value: the image only removes
 *  what the list dropped when the list is set. */
export function anticheatDisableEnv(current: ReadonlyMap<string, string>): Map<string, string> {
    const build = anticheatBuildFor(current.get("TYPE") ?? "", current.get("VERSION") ?? "");
    if (build?.kind === "mod") {
        // The mod is the login's too: it stays while the login is on, and is only
        // told to stop hiding ore.
        const mods = loginOn(current)
            ? (current.get(MODS_KEY) ?? "")
            : entries(current.get(MODS_KEY) ?? "")
                  .filter((entry) => fileOf(entry) !== build.file)
                  .join(",");
        return new Map([
            [MODS_KEY, mods],
            [ANTICHEAT_KEY, "off"],
            [ANTIXRAY_KEY, "off"]
        ]);
    }
    return new Map([
        [MODS_KEY, withoutAnticheat(current.get(MODS_KEY) ?? "")],
        [ANTICHEAT_KEY, "off"]
    ]);
}

/** Those writes as environment variables, with the token kept secret. */
export function anticheatEnvWrites(
    writes: ReadonlyMap<string, string>
): { key: string; value: string; isSecret: boolean }[] {
    return [...writes].map(([key, value]) => ({ key, value, isSecret: key === TOKEN_KEY }));
}

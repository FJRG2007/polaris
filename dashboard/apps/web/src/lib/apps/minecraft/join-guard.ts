/**
 * The project that asks players for a password, chosen for the server's loader.
 *
 * Named in one place because three of them need the same answer and a
 * disagreement between any two is a security switch that lies. The screen says
 * whether it is on by looking for a slug on the mod list; the create path puts
 * that slug there; and the screen's own instructions tell a player what to type,
 * which depends on which project answered. Spread across three files, the first
 * one to be updated would leave the other two describing a different server.
 *
 * There is no single project that covers everything, and picking per loader is
 * the whole reason this is a function rather than a constant:
 *
 * - A server that runs plugins takes a plugin. Nothing else loads.
 * - A server that runs mods takes a mod, and the mod that covers the ground is
 *   packaged as a data pack, which cannot register a command of its own. That is
 *   not a shortcoming of the project - vanilla gives an unauthenticated player
 *   exactly one way to send the server anything, a scoreboard value, so a data
 *   pack can only ever be driven through `/trigger` and a password can only ever
 *   be a number. A reader has to be told that, which is why `entry` exists.
 * - Vanilla and Bedrock take neither, and are told so rather than handed
 *   something that will not load.
 *
 * Chosen on coverage rather than on how well the page reads. A project's own
 * version list is the union across every loader it publishes for, which hides
 * the case that matters: `simple-login` names Fabric among its loaders and has
 * three Fabric builds covering two releases, against twenty-two releases for the
 * mod below. Seeding it onto a Fabric server would have looked right on the page
 * and installed nothing on almost every release anybody runs.
 */

import { isPluginLoader, loaderForType } from "./modrinth";

/** How a player gives their password, which decides what the screen tells them. */
export type JoinGuardEntry = "command" | "trigger";

export interface JoinGuard {
    /** The Modrinth slug, as it appears on the mod list. */
    readonly slug: string;
    readonly entry: JoinGuardEntry;
}

/**
 * For a server that loads plugins: commands of its own, so a password is text
 * rather than a number, hashed by the project itself.
 *
 * It names ProtocolLib as a soft dependency and says what doing without it costs -
 * passwords are not hidden from the log. Modrinth does not carry ProtocolLib, so
 * the image cannot install it and every server that gets this gets that too. It
 * is still the better of the two states: the log is readable by whoever already
 * administers the server, while the gap this closes is a stranger who learnt a
 * name. The screen says it rather than leaving somebody to find out.
 */
const PLUGIN_GUARD: JoinGuard = { slug: "simple-login", entry: "command" };

/** For a server that loads mods. A data pack, so `/trigger <objective> set
 *  <number>` and nothing else - see the note above. */
const MOD_GUARD: JoinGuard = { slug: "auth", entry: "trigger" };

/**
 * What this server can be asked to install, or null when it can install nothing.
 *
 * Null is an answer rather than a failure: a vanilla server loads neither
 * plugins nor mods, and Bedrock has no Modrinth list at all.
 */
export function joinGuardFor(software: string): JoinGuard | null {
    const loader = loaderForType(software);
    if (!loader) return null;
    return isPluginLoader(loader) ? PLUGIN_GUARD : MOD_GUARD;
}

/**
 * The entry Polaris puts on the mod list for it.
 *
 * Optional - the trailing `"?"` - on purpose. A release the project has no build
 * for would otherwise end the boot, and a server that does not start is a worse
 * answer to "close this server" than a server that starts without the guard.
 * What that costs is a screen that can say On while nothing was installed, so
 * whoever reads that flag is responsible for checking the server agrees.
 */
export function joinGuardEntry(software: string): string | null {
    const guard = joinGuardFor(software);
    return guard === null ? null : `${guard.slug}?`;
}

/** Every slug this may ever seed, for the paths that need to recognise one
 *  without knowing which server it came from - taking it back off a list, or
 *  telling a guard apart from a mod the operator chose themselves. */
export const JOIN_GUARD_SLUGS: readonly string[] = [PLUGIN_GUARD.slug, MOD_GUARD.slug];

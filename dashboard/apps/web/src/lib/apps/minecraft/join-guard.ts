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

import {
    formatProjectList,
    isPluginLoader,
    loaderForType,
    parseProjectList,
    projectSlug
} from "./modrinth";

/** How a player gives their password, which decides what the screen tells them. */
export type JoinGuardEntry = "command" | "trigger";

export interface JoinGuard {
    /** The Modrinth slug, as it appears on the mod list. */
    readonly slug: string;
    readonly entry: JoinGuardEntry;
    /**
     * Slugs this guard took over from, which a server may still carry from
     * before the swap.
     *
     * They count as this guard being on, everywhere. What they are not is
     * replaced: a server already carrying one keeps it, and the current slug is
     * not seeded beside it, because the two keep their passwords in different
     * places - swapping one for the other under a server that was working locks
     * every player out until they register again. So an older server is left on
     * what it has. What takes it off is turning the guard off, or the server's
     * software moving to the other loader - a reset through `protectionFor`, or a
     * save through `guardMovedTo`, which are the two places that look.
     *
     * The cost is that an older slug keeps whatever coverage it had. A reset onto
     * a release it has no build for is a server that comes up with no guard, and
     * the entry being optional is what makes that quiet - the same caveat
     * `joinGuardEntry` carries, reached by a different road.
     */
    readonly replaces: readonly string[];
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
const PLUGIN_GUARD: JoinGuard = { slug: "simple-login", entry: "command", replaces: ["mylogin"] };

/** For a server that loads mods. A data pack, so `/trigger <objective> set
 *  <number>` and nothing else - see the note above. */
const MOD_GUARD: JoinGuard = { slug: "auth", entry: "trigger", replaces: [] };

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

/** Every slug this guard answers to on a list: its own and the ones it replaced. */
export function joinGuardSlugs(guard: JoinGuard): readonly string[] {
    return [guard.slug, ...guard.replaces];
}

/** Every slug any guard answers to, for the paths that need to recognise a
 *  password project without knowing which loader it was meant for. Not "what
 *  Polaris seeded": an operator may have added any of these themselves, and a
 *  replaced slug is never seeded at all. */
export const JOIN_GUARD_SLUGS: readonly string[] = [
    ...joinGuardSlugs(PLUGIN_GUARD),
    ...joinGuardSlugs(MOD_GUARD)
];

/**
 * The same list with the guard moved to the one this software can load, or null
 * when there is nothing to move.
 *
 * For the server whose software is changed after it was built. A plugin cannot
 * load on a mod loader and a mod cannot load on Paper, so the guard a server was
 * closed with stops being a guard the moment its software does - and the entry
 * being optional is what makes that quiet, because the image skips what it
 * cannot resolve and the server comes up with nobody asked for a password.
 *
 * Only ever moves a guard that is already there. A server whose owner turned the
 * password off is a server whose owner turned it off, and changing the software
 * is not them asking for it back; equally, one that had it on did not ask to
 * lose it. So the answer is whichever of those two the list already says, kept
 * true across the change.
 *
 * Null rather than the list unchanged, so a caller can tell "nothing to do" from
 * "write this" without comparing strings - and write nothing at all in the
 * ordinary case, which is every save that is not a change of software.
 */
export function guardMovedTo(projects: string, software: string): string | null {
    const guard = joinGuardFor(software);
    const own = guard === null ? [] : joinGuardSlugs(guard);
    const entries = parseProjectList(projects);
    const slugOf = (entry: string) => projectSlug(entry)?.toLowerCase() ?? "";

    // What it is on now, whichever loader it was meant for. Nothing to move if
    // the server was never closed this way.
    if (!entries.some((entry) => JOIN_GUARD_SLUGS.includes(slugOf(entry)))) return null;

    const kept = entries.filter((entry) => {
        const slug = slugOf(entry);
        return own.includes(slug) || !JOIN_GUARD_SLUGS.includes(slug);
    });
    // Already on the right one - including an older slug it answers to, which is
    // left exactly as written for the reason `replaces` gives.
    const settled = kept.some((entry) => own.includes(slugOf(entry)));
    const next = formatProjectList(settled || guard === null ? kept : [...kept, `${guard.slug}?`]);
    return next === formatProjectList(entries) ? null : next;
}

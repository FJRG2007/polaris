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

import * as polarisLogin from "./polaris-login";
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
 * Software that loads neither leaves the list alone. The entry is optional, so
 * it installs nothing there, and it is the only record that the server was
 * closed: taking it off would hand a server moved to Vanilla and back again a
 * list that says nobody ever asked for a password.
 *
 * Null rather than the list unchanged, so a caller can tell "nothing to do" from
 * "write this" without comparing strings - and write nothing at all in the
 * ordinary case, which is every save that is not a change of software.
 */
export function guardMovedTo(projects: string, software: string): string | null {
    const guard = joinGuardFor(software);
    if (guard === null) return null;
    const own = joinGuardSlugs(guard);
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
    const next = formatProjectList(settled ? kept : [...kept, `${guard.slug}?`]);
    return next === formatProjectList(entries) ? null : next;
}

/**
 * The environment key the project list is saved under.
 *
 * Named here because the guard is decided here, but the list is not only the
 * guard's: it is every mod and plugin the image installs, and it is also where
 * the answer to "do Bedrock clients join this one" is written. Anything writing
 * it is writing all of that at once, which is why the paths that touch it add
 * and remove single entries rather than composing a list of their own.
 */
export const PROJECTS_KEY = "MODRINTH_PROJECTS";

/**
 * The environment key the server's software is saved under.
 *
 * Beside the one above for the same reason: the reconciliation reads both, and a
 * key spelled out a second time somewhere else is a rename that typechecks while
 * half the code goes on watching a setting nobody writes.
 *
 * A second spelling is the hazard, not a second name. `games-service` binds these
 * to `SOFTWARE_VAR` and `CROSSPLAY_VAR`, which say what the variable is doing in
 * a query that reads four of them together; bound to the constant rather than to
 * the string, those cannot drift from it.
 */
export const SOFTWARE_KEY = "TYPE";

/**
 * The same list with the password-on-join project on it.
 *
 * Every server gets this, rather than the operator finding the switch: a server
 * with Mojang authentication off has only a name to go on, so anybody who learns
 * a name that is on the player list can wear it. That is worth closing by
 * default, and a default is the only version of it that protects the servers
 * whose owner never opened the screen.
 *
 * Appended rather than forced. An entry already naming the guard, or the project
 * it replaced, is left exactly as it was written, because a pinned version, a
 * dropped `"?"` or an older project players already registered with is somebody
 * saying something more specific than this function knows.
 *
 * A server running Polaris's own login mod (`modOn`) gets no project at all, and
 * loses any it has: that mod is its guard, and a project beside it is a second
 * login keeping its passwords somewhere else.
 *
 * A default, not a policy: this runs where Polaris decides what a server starts
 * life with - a new one, and a reset, which is a server starting again - and where
 * a server loses the mod it was closed with. Turning it off afterwards is the Mods
 * screen and the join-password card, and both write the list straight out without
 * coming through here, so an operator who takes it off keeps it off. A reset puts
 * it back, along with everything else a fresh server is given.
 */
export function withJoinGuard(current: string, software: string, modOn = false): string {
    const guard = modOn ? null : joinGuardFor(software);
    const wanted = modOn ? null : joinGuardEntry(software);
    const own = guard === null ? [] : joinGuardSlugs(guard);
    // A password project for the other loader, whoever put it there: usually left
    // over from the software being changed, and at best a project with almost no
    // builds for this loader. Kept, it would sit beside the guard seeded below and
    // give players two logins, so a reset takes it off like the protection
    // plugins stripped beside it.
    const kept = parseProjectList(current).filter((entry) => {
        const listed = projectSlug(entry)?.toLowerCase();
        return (
            typeof listed !== "string" || own.includes(listed) || !JOIN_GUARD_SLUGS.includes(listed)
        );
    });
    if (wanted === null) return formatProjectList(kept);
    const already = kept.some((entry) => own.includes(projectSlug(entry)?.toLowerCase() ?? ""));
    return formatProjectList(already ? kept : [...kept, wanted]);
}

/**
 * What a settings save has to write alongside itself to keep the server closed,
 * or nothing.
 *
 * Only a save that changes the software or the release moves a guard, and only
 * one that is not itself writing the project list: that save is the
 * join-password card turning the guard off, and putting it back here would make
 * that button do nothing. The current environment is read only when both hold, so
 * an ordinary save costs no extra lookup.
 *
 * Polaris's login mod is looked at first. It has a build per release, so a save
 * that moves the server to software or a release it has none for takes it off -
 * and then seeds the project guard of the new software, because the server was
 * closed and the save did not ask to open it.
 */
export async function guardForSave(
    vars: readonly { key: string; value: string }[],
    readEnv: () => Promise<ReadonlyMap<string, string>>
): Promise<{ key: string; value: string }[]> {
    const saved = new Map(vars.map((entry) => [entry.key, entry.value]));
    const software = saved.get(SOFTWARE_KEY);
    const version = saved.get("VERSION");
    if ((!software && !version) || saved.has(PROJECTS_KEY)) return [];

    const current = await readEnv();
    const nextSoftware = software || (current.get(SOFTWARE_KEY) ?? "");
    const nextVersion = version ?? current.get("VERSION") ?? "";
    const mod = polarisLogin.modMovedTo(current, nextSoftware, nextVersion);
    if (mod !== null) {
        const after = new Map([...current, ...mod]);
        const projects = polarisLogin.loginOn(after)
            ? null
            : withJoinGuard(current.get(PROJECTS_KEY) ?? "", nextSoftware);
        const writes = [...mod].map(([key, value]) => ({ key, value }));
        return projects === null || projects === (current.get(PROJECTS_KEY) ?? "")
            ? writes
            : [...writes, { key: PROJECTS_KEY, value: projects }];
    }
    if (!software || polarisLogin.loginOn(current)) return [];
    const moved = guardMovedTo(current.get(PROJECTS_KEY) ?? "", software);
    return moved === null ? [] : [{ key: PROJECTS_KEY, value: moved }];
}

/**
 * A server's environment as a template should remember it.
 *
 * Polaris login belongs to the server it was switched on for - its id and token
 * are that server's, and a template never copies them - so a template made from
 * such a server would otherwise hand the next one the jar and a project list with
 * no guard on it. What it remembers instead is the project guard the software
 * would have been given, so a server built from it starts closed.
 */
export function guardAsTemplate(env: ReadonlyMap<string, string>): Map<string, string> {
    const copy = new Map(env);
    if (!polarisLogin.loginOn(env)) return copy;
    copy.set(polarisLogin.MODS_KEY, polarisLogin.withoutMod(env.get(polarisLogin.MODS_KEY) ?? ""));
    copy.set(
        PROJECTS_KEY,
        withJoinGuard(env.get(PROJECTS_KEY) ?? "", env.get(SOFTWARE_KEY) ?? "")
    );
    return copy;
}

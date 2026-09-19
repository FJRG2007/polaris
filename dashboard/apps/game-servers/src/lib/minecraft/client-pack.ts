/**
 * The mods a player needs to join one server, and the one command that installs
 * them.
 *
 * A modded server is only half an install: everything on it that renders, draws a
 * screen or holds a key bind has to be in the player's own `mods` folder too, at
 * the same build. Handing somebody a list of links is how that goes wrong - the
 * wrong build, the wrong loader, a jar in the wrong folder, and a player who
 * cannot join and does not know which of the fourteen jars is the reason.
 *
 * So Polaris resolves the list itself - the server's own mod list, plus the
 * client-only ones the operator chose for it - into exact files with their
 * checksums, and serves a script that puts them where that machine keeps them.
 * The player runs one line. Running it again is how they update: what the list
 * dropped is removed, what changed is replaced, and anything of their own in that
 * folder is left alone.
 *
 * The address carries a token derived from the instance's own secret, so it can
 * be sent to somebody who has no account here and cannot be guessed from the
 * server's id. It is not a session: it grants the mod list of one server and
 * nothing else.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
    buildFor,
    isModrinthUrl,
    loaderForType,
    parseProjectList,
    projectSlug,
    projectsByHash,
    readInstalledProjects,
    readRequirements,
    walk,
    type ModrinthBuild
} from "./modrinth";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";

const { readInstallConfig } = host.appsInstallConfig;
type InstallConfig = AppHostTypes["InstallConfig"];

/** Where the client-only mods for a server are kept: on the install, beside the
 *  rest of what somebody chose for it, never in the container's own list - the
 *  server must not try to load a mod that has no server side. */
export const CLIENT_MODS_KEY = "clientMods";

/** One mod a player installs, as the script downloads it. */
export interface PackMod {
    /** The Modrinth entry it came from, so the screen can name it. */
    readonly entry: string;
    readonly filename: string;
    readonly url: string;
    /** Modrinth's own checksum, so a truncated download is caught. */
    readonly sha1: string;
    readonly version: string;
    /** Whether it is on the server too, or only in the player's folder. */
    readonly where: "server" | "player";
    /** The Modrinth project, which is what makes a jar of the player's own with
     *  another name the same mod as this one. Empty when it is not known. */
    readonly projectId: string;
    /** The projects this build cannot run beside. */
    readonly incompatible: readonly string[];
}

/** A jar in a player's folder that the pack did not put there, as the installer
 *  reports it: its name and what is in it. */
export interface ForeignJar {
    readonly name: string;
    readonly sha1: string;
}

/** One of those the installer is to move out of the folder, and why. */
export interface SetAside {
    readonly name: string;
    readonly reason: string;
}

/**
 * Which of a player's own jars stop the pack from working.
 *
 * Two kinds, both the publisher's statement rather than a guess: a jar that is a
 * build of the same Modrinth project as a mod in the pack - another version under
 * another name, which the loader refuses to start with - and one whose project a
 * mod in the pack declares it cannot run beside. Everything else is the player's
 * business and is not named. A jar Modrinth does not know is not named either:
 * with no project to go on there is nothing to say it is either of those.
 *
 * Pure: `projectOf` is Modrinth's answer, by sha1, asked by the caller.
 */
export function setAsidePlan(
    mods: readonly PackMod[],
    jars: readonly ForeignJar[],
    projectOf: ReadonlyMap<string, string>
): SetAside[] {
    const shipped = new Set(mods.map((mod) => mod.filename));
    const sameProject = new Map<string, PackMod>();
    const clashes = new Map<string, PackMod>();
    for (const mod of mods) {
        if (mod.projectId) sameProject.set(mod.projectId, mod);
        for (const id of mod.incompatible) if (!clashes.has(id)) clashes.set(id, mod);
    }
    const moves: SetAside[] = [];
    for (const jar of jars) {
        if (shipped.has(jar.name)) continue;
        const project = projectOf.get(jar.sha1.toLowerCase());
        if (!project) continue;
        const same = sameProject.get(project);
        const clash = clashes.get(project);
        if (same) {
            moves.push({ name: jar.name, reason: `another copy of ${nameOf(same)}, installed as ${same.filename}` });
        } else if (clash) {
            moves.push({ name: jar.name, reason: `${nameOf(clash)} cannot run beside it` });
        }
    }
    return moves;
}

/** A pack mod as a sentence names it. */
function nameOf(mod: PackMod): string {
    return projectSlug(mod.entry) ?? mod.filename;
}

/** The same, asking Modrinth which project each jar is. */
export async function setAside(
    mods: readonly PackMod[],
    jars: readonly ForeignJar[]
): Promise<SetAside[]> {
    if (jars.length === 0 || mods.length === 0) return [];
    const projectOf = await projectsByHash(jars.map((jar) => jar.sha1));
    return setAsidePlan(mods, jars, projectOf);
}

export interface ClientPack {
    readonly server: string;
    readonly loader: string;
    /** The release, or empty for a server that follows the newest. */
    readonly version: string;
    readonly mods: readonly PackMod[];
    /** Entries the pack could not resolve to a file, by entry. A player is told
     *  rather than left with a mod list that quietly lost one. */
    readonly missing: readonly string[];
}

/** The client-only mods an install carries, as its config holds them. */
export function clientMods(config: InstallConfig): string[] {
    const held = config[CLIENT_MODS_KEY];
    return Array.isArray(held)
        ? held.filter((entry): entry is string => typeof entry === "string")
        : [];
}

/** The same, from the raw column. */
export function clientModsOf(raw: string | null | undefined): string[] {
    return clientMods(readInstallConfig(raw));
}

/**
 * The token for one server's pack.
 *
 * Derived rather than stored: it is the instance's own secret over the install's
 * id, so there is nothing to keep, nothing to migrate, and a server removed takes
 * its link with it. Rotating the instance secret invalidates every pack link,
 * which is the behaviour anybody rotating that secret is asking for.
 */
export function packToken(installedAppId: string): string {
    const secret = loadEnv().POLARIS_AUTH_SECRET || "";
    return createHmac("sha256", secret)
        .update(`minecraft-pack:${installedAppId}`)
        .digest("base64url")
        .slice(0, 32);
}

/** Whether a token is the one for this server, compared without leaking where it
 *  first differs. */
export function packTokenMatches(installedAppId: string, token: string): boolean {
    const expected = Buffer.from(packToken(installedAppId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** What a player would install, resolved to files. Entries the loader cannot use
 *  are left out; entries with no build for this server are reported. */
export async function resolvePack(input: {
    readonly name: string;
    readonly software: string;
    readonly version: string;
    readonly projects: string;
    readonly config: InstallConfig;
}): Promise<ClientPack> {
    const loader = loaderForType(input.software) ?? "";
    const version = /^[0-9][0-9.]*$/.test(input.version.trim()) ? input.version.trim() : "";
    const mods: PackMod[] = [];
    const missing: string[] = [];
    if (!loader) return { server: input.name, loader, version, mods, missing };
    const asked = await packEntries({
        server: parseProjectList(input.projects),
        player: clientMods(input.config),
        loader,
        version
    });
    const builds = await walk(asked, ({ entry }) => buildFor(entry, loader, version || null));
    for (const [index, { entry, where }] of asked.entries()) {
        const build = builds[index] ?? null;
        if (!build || !installableFile(build)) {
            missing.push(entry);
            continue;
        }
        // The shell compares the checksum as text against what sha1sum prints,
        // which is lowercase.
        const sha1 = CHECKSUM.test(build.sha1) ? build.sha1.toLowerCase() : "";
        mods.push({ entry, where, ...build, sha1 });
    }
    return { server: input.name, loader, version, mods, missing };
}

/** One project the pack installs, before it is resolved to a file. */
export interface PackEntry {
    /** As the list holds it, or the dependency with the release type it was
     *  judged by. */
    readonly entry: string;
    readonly where: PackMod["where"];
    /** The project as Modrinth names it, lowercased: what an id and a slug for the
     *  same project have in common. */
    readonly key: string;
    readonly title: string;
    readonly description: string;
    readonly iconUrl: string | null;
    /** The projects that pulled it in, by title, for a library nobody chose. */
    readonly neededBy: readonly string[];
}

/**
 * Every project a player installs, before any of it is resolved to a file.
 *
 * The one answer the install command and the mods screen both give, so the screen
 * cannot show a list the command does not install.
 */
export async function packEntries(input: {
    readonly server: readonly string[];
    readonly player: readonly string[];
    readonly loader: string;
    readonly version: string;
}): Promise<PackEntry[]> {
    // A file the image installs by path, not a project: nothing to resolve and
    // nothing a player could download.
    const listed = [
        ...input.server.map((entry) => ({ entry, where: "server" as const })),
        ...input.player.map((entry) => ({ entry, where: "player" as const }))
    ].filter(({ entry }) => projectSlug(entry));
    return withRequirements(
        await playerSide(listed, input.loader, input.version),
        input.loader,
        input.version
    );
}

/**
 * The entries a player puts in their own game: all of them but the server-only,
 * once each.
 *
 * A server-only mod in a player's folder is at best a jar that does nothing and at
 * worst one that stops the game from starting. When Modrinth cannot be asked, the
 * list is kept whole - a spare jar is the cheaper mistake than a missing one.
 */
async function playerSide(
    listed: readonly { readonly entry: string; readonly where: PackMod["where"] }[],
    loader: string,
    version: string
): Promise<PackEntry[]> {
    const projects = await readInstalledProjects(
        listed.map(({ entry }) => entry),
        loader,
        version || null
    );
    const kept = new Map<string, PackEntry>();
    for (const [index, { entry, where }] of listed.entries()) {
        const project = projects[index];
        if (project?.serverOnly) continue;
        const key = (project?.slug ?? projectSlug(entry) ?? entry).toLowerCase();
        if (kept.has(key)) continue;
        kept.set(key, {
            entry,
            where,
            key,
            title: project?.title || key,
            description: project?.description ?? "",
            iconUrl: project?.iconUrl ?? null,
            neededBy: []
        });
    }
    return [...kept.values()];
}

/** How many layers of "needs" are followed. Libraries rarely need more than one;
 *  the bound is what keeps a publisher's cycle from being a walk without end. */
const REQUIREMENT_DEPTH = 3;

/**
 * The entries, plus everything they cannot run without.
 *
 * The server installs a mod's required dependencies itself, so its list names
 * TrashSlot and never Balm - and a player given only the list gets a game that
 * refuses to start over the missing library. The same declarations the mods
 * screen reads decide what is added here, so the two cannot disagree about what a
 * mod needs. A dependency takes the side of whatever needed it, and the release
 * type its availability was judged by.
 */
async function withRequirements(
    entries: readonly PackEntry[],
    loader: string,
    version: string
): Promise<PackEntry[]> {
    const all = [...entries];
    const seen = new Set(all.map(({ key }) => key));
    let layer = all;
    for (let depth = 0; depth < REQUIREMENT_DEPTH && layer.length > 0; depth++) {
        const byKey = new Map(layer.map((one) => [one.key, one]));
        const needs = await readRequirements(
            layer.map(({ entry }) => entry),
            loader,
            version || null
        );
        const next = new Map<string, PackEntry>();
        for (const need of needs) {
            const key = need.needs.toLowerCase();
            if (need.needsServerOnly || need.onList || seen.has(key)) continue;
            const by = byKey.get(need.slug.toLowerCase());
            const known = next.get(key);
            next.set(key, {
                entry: need.release === "release" ? need.needs : `${need.needs}:${need.release}`,
                key,
                title: need.needsTitle || need.needs,
                description: "",
                iconUrl: null,
                ...known,
                where: known?.where === "server" || !by ? "server" : by.where,
                neededBy: [...new Set([...(known?.neededBy ?? []), ...(by ? [by.title] : [])])]
            });
        }
        for (const key of next.keys()) seen.add(key);
        layer = [...next.values()];
        all.push(...layer);
    }
    return all;
}

/** A jar name and nothing else: no folder to escape the mods folder with, no tab
 *  or newline to shift the line the installers read it off. Square brackets are a
 *  name, not a pattern, to both installers - they only ever reach a file by its
 *  literal name - and SecurityCraft publishes as "[1.21.4] SecurityCraft ...jar",
 *  which without them was never handed to a player at all. */
const JAR = /^(?!\.)[A-Za-z0-9._+ ()[\]-]{1,120}\.jar$/;

/** Whether a name is one the installers may be told about. */
export function isJarName(name: string): boolean {
    return JAR.test(name) && !name.includes("..");
}

/** Modrinth's own sha1, as the installers compare it. Anything else is no
 *  checksum rather than a checksum that can never match. */
const CHECKSUM = /^[A-Fa-f0-9]{40}$/;

/**
 * Whether a build is a file a script may be told to download.
 *
 * What comes back is somebody else's database, and it ends up as a path and a URL
 * on a player's machine: a name with a separator in it writes outside the mods
 * folder, and a URL anywhere but Modrinth is Polaris handing a stranger's download
 * to a friend of the operator. Neither is installed - the entry is reported as
 * unresolved, which is what "we could not get you this one" already means here.
 */
function installableFile(build: ModrinthBuild): boolean {
    return isJarName(build.filename) && isModrinthUrl(build.url);
}

/** The address a player is given, for one machine's kind of shell. */
export function packUrl(base: string, installedAppId: string, file: string): string {
    return `${base.replace(/\/$/, "")}/api/minecraft/pack/${installedAppId}/${packToken(installedAppId)}/${file}`;
}

/**
 * The line a player runs, per platform.
 *
 * One line, because the alternative is a page of instructions that ends in
 * somebody unzipping a folder into the wrong place. Windows goes through
 * PowerShell, which every supported Windows has; macOS and Linux go through the
 * shell they already have.
 */
export function packCommands(
    base: string,
    installedAppId: string
): Record<"windows" | "mac" | "linux", string> {
    const ps = packUrl(base, installedAppId, "install.ps1");
    const sh = packUrl(base, installedAppId, "install.sh");
    return {
        windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${ps} | iex"`,
        mac: `curl -fsSL ${sh} | sh`,
        linux: `curl -fsSL ${sh} | sh`
    };
}

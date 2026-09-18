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
    const server = parseProjectList(input.projects).map((entry) => ({
        entry,
        where: "server" as const
    }));
    const player = clientMods(input.config).map((entry) => ({ entry, where: "player" as const }));
    const mods: PackMod[] = [];
    const missing: string[] = [];
    if (!loader) return { server: input.name, loader, version, mods, missing };
    // A file the image installs by path, not a project: nothing to resolve and
    // nothing a player could download.
    const listed = [...server, ...player].filter(({ entry }) => projectSlug(entry));
    const asked = await withRequirements(await playerSide(listed, loader, version), loader, version);
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

type PackEntry = { readonly entry: string; readonly where: PackMod["where"] };

/**
 * The entries a player puts in their own game: all of them but the server-only.
 *
 * A server-only mod in a player's folder is at best a jar that does nothing and at
 * worst one that stops the game from starting. When Modrinth cannot be asked, the
 * list is kept whole - a spare jar is the cheaper mistake than a missing one.
 */
async function playerSide(
    listed: readonly PackEntry[],
    loader: string,
    version: string
): Promise<PackEntry[]> {
    const sides = await readInstalledProjects(
        listed.map(({ entry }) => entry),
        loader,
        version || null
    );
    return listed.filter((_, index) => !sides[index]?.serverOnly);
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
 * mod needs. A dependency takes the side of whatever needed it.
 */
async function withRequirements(
    entries: readonly PackEntry[],
    loader: string,
    version: string
): Promise<PackEntry[]> {
    const all = [...entries];
    const seen = new Set(all.map(({ entry }) => (projectSlug(entry) ?? entry).toLowerCase()));
    let layer = all;
    for (let depth = 0; depth < REQUIREMENT_DEPTH && layer.length > 0; depth++) {
        const whereOf = new Map(
            layer.map(({ entry, where }) => [(projectSlug(entry) ?? entry).toLowerCase(), where])
        );
        const needs = await readRequirements(
            layer.map(({ entry }) => entry),
            loader,
            version || null
        );
        const next: PackEntry[] = [];
        for (const need of needs) {
            const slug = need.needs.toLowerCase();
            if (need.needsServerOnly || seen.has(slug)) continue;
            seen.add(slug);
            next.push({ entry: need.needs, where: whereOf.get(need.slug.toLowerCase()) ?? "server" });
        }
        all.push(...next);
        layer = next;
    }
    return all;
}

/** A jar name and nothing else: no folder to escape the mods folder with, no tab
 *  or newline to shift the line the installers read it off. */
const JAR = /^(?!\.)[A-Za-z0-9._+ ()-]{1,120}\.jar$/;

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
    return JAR.test(build.filename) && !build.filename.includes("..") && isModrinthUrl(build.url);
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

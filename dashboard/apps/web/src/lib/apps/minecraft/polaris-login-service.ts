/**
 * The dashboard half of Polaris's login mod: the passwords it asks about, the
 * check-ins that say it can still ask, and switching it on and off.
 *
 * The mod authenticates as one server, with a token only that server's
 * environment carries, and everything it may do is scoped to that server's rows.
 * A token that leaks from one server is a way to guess passwords on that server,
 * rate limited, and nothing else.
 *
 * Server-only.
 */

import { isIP } from "node:net";
import { prisma } from "@polaris/db";
import { accessRefusal } from "./access";
import { readInstallConfig } from "@/lib/apps/install-config";
import * as polarisLogin from "./polaris-login";
import { publicAppUrl } from "@/lib/domain-service";
import { bundledModVersion } from "./polaris-mod-files";
import { readInstallEnvSecret } from "@/lib/apps/install-secret";
import { listEnvVars, setEnvVars } from "@/lib/env-var-service";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { enableLogin, foreignLogin, PROJECTS_KEY, SOFTWARE_KEY } from "./join-guard";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";

/** The server a mod request speaks for. */
export interface ModServer {
    readonly installedAppId: string;
    readonly ownerId: string;
}

/**
 * The server a request is from, when it carries that server's token and still
 * has the mod switched on.
 *
 * An unknown server and a wrong token are the same answer, so the endpoint does
 * not tell a stranger which ids exist. Digested before comparing, so the
 * comparison is over two buffers of equal length whatever was presented. A
 * lookup that fails throws rather than reading as a wrong token, because the mod
 * takes a refusal to mean the link is broken.
 */
export async function authorizeMod(
    request: Request,
    installedAppId: string
): Promise<ModServer | null> {
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented) return null;
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true, ownerId: true }
    });
    if (!install?.applicationId) return null;
    const vars = await listEnvVars("application", install.applicationId, install.ownerId);
    if (!polarisLogin.loginOn(new Map(vars.map((entry) => [entry.key, entry.value ?? ""])))) {
        return null;
    }
    const token = await readInstallEnvSecret(
        install.applicationId,
        install.ownerId,
        polarisLogin.TOKEN_KEY
    );
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!token || !timingSafeEqual(digest(presented), digest(token))) return null;
    return { installedAppId, ownerId: install.ownerId };
}

/** Record that the mod reached Polaris. */
export async function recordCheckIn(
    server: ModServer,
    about: { modVersion: string; gameVersion: string }
): Promise<void> {
    const row = { seenAt: new Date(), ...about };
    await prisma.minecraftLoginCheckIn.upsert({
        where: { installedAppId: server.installedAppId },
        create: { installedAppId: server.installedAppId, ...row },
        update: row
    });
}

const key = (name: string) => name.toLowerCase();

/**
 * Why this player may not join, or null when they may.
 *
 * The server's player list, held by Polaris: the name has to be on it, and when
 * the list binds names to networks, from one of the networks it names. Asked by
 * the mod before a player can do anything, so a name that is not on the list is
 * turned away before it can register a password for somebody else's account -
 * rather than kicked a minute later by the pass that reads the log.
 *
 * The same two exceptions as that pass. A server with no rules at all has a list
 * nobody set up, not one that says "nobody". And an address that is not an
 * address is judged on the name alone, as a join line that scrolled out is.
 */
export async function joinRefusal(
    server: ModServer,
    player: string,
    address: string | undefined
): Promise<string | null> {
    // Imported when asked: the rules live beside the code that reaches the
    // server, which this route never needs.
    const { playerAccessRules } = await import("./player-access");
    const [rules, install] = await Promise.all([
        playerAccessRules(server.installedAppId),
        prisma.installedApp.findUnique({
            where: { id: server.installedAppId },
            select: { config: true }
        })
    ]);
    if (rules.length === 0) return null;
    const bound = readInstallConfig(install?.config).bindAddresses !== false;
    const from = bound && address && isIP(address) ? address : null;
    return accessRefusal(player, from, rules);
}

export async function isRegistered(server: ModServer, player: string): Promise<boolean> {
    const row = await prisma.minecraftLogin.findUnique({
        where: {
            installedAppId_username: {
                installedAppId: server.installedAppId,
                username: key(player)
            }
        },
        select: { id: true }
    });
    return row !== null;
}

/** False when the name already has a password: registering is not a way to
 *  replace somebody else's. */
export async function register(
    server: ModServer,
    player: string,
    password: string
): Promise<boolean> {
    const passwordHash = await hashLinkPassword(password);
    try {
        await prisma.minecraftLogin.create({
            data: {
                installedAppId: server.installedAppId,
                username: key(player),
                displayName: player,
                passwordHash,
                lastLoginAt: new Date()
            }
        });
        return true;
    } catch (caught) {
        // The unique index, which is what makes two joins registering the same
        // name at once end with one password rather than the second one's.
        if ((caught as { code?: string }).code === "P2002") return false;
        throw caught;
    }
}

/**
 * How many password checks a server may get wrong, and over what window.
 *
 * Two buckets. Per player, counted before the account is looked up so an unknown
 * name costs exactly what a known one does, and cleared by a success: ten in
 * fifteen minutes is generous to fat fingers and hopeless for a guesser, and the
 * mod kicks after three anyway. Per server, failures only: the broad sweep, one
 * guess each across many names, which the per-player bucket never sees - and a
 * busy server whose players all log in after a restart must not trip it. Every
 * request comes from the server's own address, so this is the address limit too.
 */
const PLAYER_ATTEMPTS = 10;
const SERVER_FAILURES = 100;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

export type LoginResult =
    | { readonly kind: "ok" }
    | { readonly kind: "wrong" }
    | { readonly kind: "unknown" }
    | { readonly kind: "throttled"; readonly retryAfterMs: number };

/** Check a password. Throttled whatever the answer, so a guesser learns nothing
 *  from which attempt was refused. */
export async function checkPassword(
    server: ModServer,
    player: string,
    password: string
): Promise<LoginResult> {
    const failures = `mc-login-server:${server.installedAppId}`;
    const blocked = await remainingBlock(failures, SERVER_FAILURES, ATTEMPT_WINDOW_MS);
    if (blocked !== null) return { kind: "throttled", retryAfterMs: blocked };
    const bucket = playerBucket(server.installedAppId, player);
    const limit = await rateLimit(bucket, PLAYER_ATTEMPTS, ATTEMPT_WINDOW_MS);
    if (!limit.ok) return { kind: "throttled", retryAfterMs: limit.retryAfterMs };

    const where = {
        installedAppId_username: { installedAppId: server.installedAppId, username: key(player) }
    };
    const row = await prisma.minecraftLogin.findUnique({ where, select: { passwordHash: true } });
    const matched = row !== null && (await verifyLinkPassword(password, row.passwordHash));
    if (!matched) {
        await rateLimit(failures, SERVER_FAILURES, ATTEMPT_WINDOW_MS);
        return { kind: row === null ? "unknown" : "wrong" };
    }
    await resetRateLimit(bucket);
    await prisma.minecraftLogin.update({ where, data: { lastLoginAt: new Date() } });
    return { kind: "ok" };
}

/**
 * How long a failure bucket stays shut, or null when it is open. A read, not a
 * count: only a failure is counted, and it is counted after the fact.
 *
 * Open when the counter cannot be read, like `rateLimit`: a database hiccup must
 * not lock every player out of a server.
 */
async function remainingBlock(
    bucket: string,
    limit: number,
    windowMs: number
): Promise<number | null> {
    const row = await prisma.rateLimitCounter
        .findUnique({ where: { key: bucket } })
        .catch(() => null);
    if (!row) return null;
    const age = Date.now() - row.windowStart.getTime();
    return age < windowMs && row.count >= limit ? windowMs - age : null;
}

const playerBucket = (installedAppId: string, player: string) =>
    `mc-login:${installedAppId}:${key(player)}`;

/** Change a password, given the current one. Same throttle as a login: it is one. */
export async function changePassword(
    server: ModServer,
    player: string,
    current: string,
    next: string
): Promise<LoginResult> {
    const checked = await checkPassword(server, player, current);
    if (checked.kind !== "ok") return checked;
    await prisma.minecraftLogin.update({
        where: {
            installedAppId_username: {
                installedAppId: server.installedAppId,
                username: key(player)
            }
        },
        data: { passwordHash: await hashLinkPassword(next) }
    });
    return checked;
}

/** One registered player, as the panel lists them. */
export interface RegisteredPlayer {
    readonly name: string;
    readonly createdAt: string;
    readonly lastLoginAt: string | null;
}

/** What the panel shows about the mod on one server. */
export interface LoginState {
    /** Whether the mod is switched on. */
    readonly on: boolean;
    /** The build this server would get, or null when there is none for it. */
    readonly build: string | null;
    /** A login Polaris does not manage that the server already carries. */
    readonly foreign: string | null;
    /** Whether Polaris has an address a server can reach it on, which the mod
     *  needs before the server will start. */
    readonly reachable: boolean;
    readonly health: polarisLogin.LoginHealth;
    readonly seenAt: string | null;
    readonly modVersion: string | null;
    /** The build this dashboard serves the server, when the image says. */
    readonly currentVersion: string | null;
    /** Whether the server runs an older build than that, until it restarts. */
    readonly outdated: boolean;
    readonly players: readonly RegisteredPlayer[];
}

export async function loginState(
    installedAppId: string,
    applicationId: string,
    ownerId: string
): Promise<LoginState> {
    const [vars, install, checkIn, players, deployment, publicUrl] = await Promise.all([
        listEnvVars("application", applicationId, ownerId),
        prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } }),
        prisma.minecraftLoginCheckIn.findUnique({ where: { installedAppId } }),
        prisma.minecraftLogin.findMany({
            where: { installedAppId },
            orderBy: { displayName: "asc" },
            select: { displayName: true, createdAt: true, lastLoginAt: true }
        }),
        prisma.deployment.findFirst({
            where: { deployableType: "application", deployableId: applicationId },
            orderBy: { createdAt: "desc" },
            select: { finishedAt: true }
        }),
        publicAppUrl().catch(() => null)
    ]);
    const env = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    const now = new Date();
    const upSince = latest(
        onlineSince(install?.config ?? null),
        deployment ? (deployment.finishedAt ?? now) : null
    );
    const on = polarisLogin.loginOn(env);
    const build = polarisLogin.modFileFor(env.get(SOFTWARE_KEY) ?? "", env.get("VERSION") ?? "");
    const health = polarisLogin.loginHealth({ seenAt: checkIn?.seenAt ?? null, upSince, now });
    const modVersion = checkIn?.modVersion ?? null;
    const currentVersion = build ? await bundledModVersion(build) : null;
    return {
        on,
        build,
        foreign: foreignLogin(env.get(PROJECTS_KEY) ?? ""),
        reachable: publicUrl !== null,
        health,
        seenAt: checkIn?.seenAt.toISOString() ?? null,
        modVersion,
        currentVersion,
        outdated: polarisLogin.modOutdated({
            on,
            health,
            running: modVersion,
            current: currentVersion
        }),
        players: players.map((row) => ({
            name: row.displayName,
            createdAt: row.createdAt.toISOString(),
            lastLoginAt: row.lastLoginAt?.toISOString() ?? null
        }))
    };
}

/** The later of two moments, or null when the server is not up at all. */
function latest(onlineAt: Date | null, deployedAt: Date | null): Date | null {
    if (!onlineAt) return null;
    return deployedAt && deployedAt > onlineAt ? deployedAt : onlineAt;
}

/** When the server's current run began, as the activity sweep recorded it. */
function onlineSince(config: string | null): Date | null {
    try {
        const raw = (JSON.parse(config ?? "{}") as { onlineSince?: unknown }).onlineSince;
        const at = typeof raw === "string" ? new Date(raw) : null;
        return at && !Number.isNaN(at.getTime()) ? at : null;
    } catch {
        return null;
    }
}

/**
 * Switch the mod on or off. The caller restarts the server.
 *
 * On, the project guards come off the list - two logins on one server would ask
 * a player for two passwords. Off, the project guard is not put back: turning the
 * password off is what the operator asked for.
 */
export async function setLogin(
    installedAppId: string,
    applicationId: string,
    ownerId: string,
    on: boolean
): Promise<void> {
    const vars = await listEnvVars("application", applicationId, ownerId);
    const current = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    let writes: Map<string, string>;
    if (on) {
        const build = polarisLogin.modFileFor(
            current.get(SOFTWARE_KEY) ?? "",
            current.get("VERSION") ?? ""
        );
        const foreign = foreignLogin(current.get(PROJECTS_KEY) ?? "");
        if (foreign !== null) {
            throw new Error(
                `This server logs players in with ${foreign}, which Polaris does not manage. Remove it from the Mods screen first.`
            );
        }
        if (build === null) {
            throw new Error(
                `Polaris login has no build for this server's software and release. It runs on Paper, Purpur and Spigot from Minecraft ${polarisLogin.PLUGIN_SINCE}, and on NeoForge 1.21.4.`
            );
        }
        // The server downloads the mod from this address and asks it on every
        // join, and a LAN-only name does not resolve inside a container - where
        // there is no public one, switching this on would be a server that never
        // starts.
        const baseUrl = await publicAppUrl();
        if (baseUrl === null) {
            throw new Error(
                "Polaris login needs this Polaris to have a public address: the server downloads the mod from it and asks it on every join."
            );
        }
        const token =
            (await readInstallEnvSecret(applicationId, ownerId, polarisLogin.TOKEN_KEY)) ??
            randomBytes(32).toString("hex");
        writes = enableLogin({
            current,
            baseUrl,
            installedAppId,
            file: build,
            token
        });
    } else {
        writes = polarisLogin.disableEnv(current);
    }
    await setEnvVars("application", applicationId, ownerId, polarisLogin.envWrites(writes));
}

/** Forget a player's password, so they register again on their next join. */
export async function forgetPlayer(installedAppId: string, player: string): Promise<boolean> {
    const removed = await prisma.minecraftLogin.deleteMany({
        where: { installedAppId, username: key(player) }
    });
    await resetRateLimit(playerBucket(installedAppId, player));
    return removed.count > 0;
}

/** Everything the mod kept about a server that no longer exists. */
export async function clearLogins(installedAppId: string): Promise<void> {
    await Promise.all([
        prisma.minecraftLogin.deleteMany({ where: { installedAppId } }),
        prisma.minecraftLoginCheckIn.deleteMany({ where: { installedAppId } })
    ]).catch(() => undefined);
}

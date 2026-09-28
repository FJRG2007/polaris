/**
 * Polaris's anti-cheat engine on one server: switching it, and what it reports.
 *
 * The decisions about the environment are `polaris-anticheat`'s; this reads and
 * writes it, checks that a report comes from the server it names, and keeps what
 * the plugin caught for the evidence window the Anti-cheat tab scores over.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { TOKEN_KEY, loginOn } from "./polaris-login";
import { SOFTWARE_KEY } from "./join-guard";
import { anticheatBundled } from "./polaris-mod-files";
import { EVIDENCE_WINDOW_MS, readXray } from "./xray";
import { engineScore } from "./suspicion";
import * as anticheat from "./polaris-anticheat";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const { publicAppUrl } = host.domainService;
const { listEnvVars, setEnvVars } = host.envVarService;
const { readInstallEnvSecret } = host.appsInstallSecret;
const { rateLimit } = host.rateLimitService;
const { createNotification } = host.notificationService;

export interface AnticheatState {
    readonly on: boolean;
    /** Whether the engine runs on this server's software at all. */
    readonly supported: boolean;
    /** What carries it here: the full plugin, or the Polaris mod's anti-xray. */
    readonly kind: "plugin" | "mod" | null;
    /** Whether this Polaris has an address the server can download it from. */
    readonly reachable: boolean;
}

export async function anticheatState(
    applicationId: string,
    ownerId: string
): Promise<AnticheatState> {
    const [vars, publicUrl] = await Promise.all([
        listEnvVars("application", applicationId, ownerId),
        publicAppUrl().catch(() => null)
    ]);
    const env = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    const build = anticheat.anticheatBuildFor(
        env.get(SOFTWARE_KEY) ?? "",
        env.get("VERSION") ?? ""
    );
    return {
        on: anticheat.anticheatActive(env),
        supported: build !== null,
        kind: build?.kind ?? null,
        reachable: publicUrl !== null
    };
}

/** Switch the engine. The caller restarts the server onto it. */
export async function setAnticheat(
    installedAppId: string,
    applicationId: string,
    ownerId: string,
    on: boolean
): Promise<void> {
    const vars = await listEnvVars("application", applicationId, ownerId);
    const current = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    let writes: Map<string, string>;
    if (on) {
        const build = anticheat.anticheatBuildFor(
            current.get(SOFTWARE_KEY) ?? "",
            current.get("VERSION") ?? ""
        );
        if (!build) {
            throw new Error(
                "Polaris anti-cheat runs on Paper, Purpur, Pufferfish, Leaf, Folia and Spigot, and its anti-xray on NeoForge 1.21.4. This server's software cannot load it."
            );
        }
        // The server downloads the plugin from this address when it boots and
        // reports to it, and a LAN-only name does not resolve inside a container.
        const baseUrl = await publicAppUrl();
        if (baseUrl === null) {
            throw new Error(
                "Polaris anti-cheat needs this Polaris to have a public address: the server downloads the plugin from it when it starts."
            );
        }
        if (!(await anticheatBundled(build.file))) {
            throw new Error(
                build.kind === "plugin"
                    ? "This Polaris was installed without the anti-cheat plugin. Update Polaris from Settings to get it."
                    : "This Polaris was installed without the Polaris mod for this release. Update Polaris from Settings to get it."
            );
        }
        // The token the server already has, when the login plugin gave it one:
        // one secret per server, so neither switch strands the other.
        const token =
            (await readInstallEnvSecret(applicationId, ownerId, TOKEN_KEY)) ??
            randomBytes(32).toString("hex");
        writes = anticheat.anticheatEnableEnv(current, { baseUrl, installedAppId, token });
    } else {
        writes = anticheat.anticheatDisableEnv(current);
    }
    await setEnvVars("application", applicationId, ownerId, anticheat.anticheatEnvWrites(writes));
}

/**
 * Switch the engine on wherever it runs and nobody has decided either way - the
 * servers made before it came on by default. The change is written, not applied:
 * a server loads the plugin on its next start, and nobody is disconnected for it
 * now. Once written it is a decision like any other, so this never touches that
 * server again, and an owner's `off` is never undone.
 *
 * Only where this Polaris has a public address, which the server downloads the
 * plugin from; without one there is nothing to write yet, and the next sweep
 * after an address is set does it.
 */
export async function adoptAnticheatDefaults(): Promise<{ adopted: number }> {
    const baseUrl = await publicAppUrl().catch(() => null);
    if (baseUrl === null) return { adopted: 0 };
    const installs = await prisma.installedApp.findMany({
        where: { catalogId: "minecraft", status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, ownerId: true, applicationId: true }
    });
    // The two keys the decision rests on, for every server in one read, so only
    // the servers still waiting for it are read in full.
    const rows = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: { in: installs.map((install) => install.applicationId!) },
            key: { in: [anticheat.ANTICHEAT_KEY, SOFTWARE_KEY, "VERSION"] }
        },
        select: { scopeId: true, key: true, value: true }
    });
    const deciding = new Map<string, Map<string, string>>();
    for (const row of rows) {
        const env = deciding.get(row.scopeId) ?? new Map<string, string>();
        env.set(row.key, row.value ?? "");
        deciding.set(row.scopeId, env);
    }
    const waiting = installs.filter((install) =>
        anticheat.wantsDefaultAnticheat(deciding.get(install.applicationId!) ?? new Map())
    );
    let adopted = 0;
    for (const install of waiting) {
        const applicationId = install.applicationId!;
        try {
            const vars = await listEnvVars("application", applicationId, install.ownerId);
            const current = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
            if (!anticheat.wantsDefaultAnticheat(current)) continue;
            const build = anticheat.anticheatBuildFor(
                current.get(SOFTWARE_KEY) ?? "",
                current.get("VERSION") ?? ""
            );
            if (build === null || !(await anticheatBundled(build.file))) continue;
            const token =
                (await readInstallEnvSecret(applicationId, install.ownerId, TOKEN_KEY)) ??
                randomBytes(32).toString("hex");
            const writes = anticheat.anticheatEnableEnv(current, {
                baseUrl,
                installedAppId: install.id,
                token
            });
            await setEnvVars(
                "application",
                applicationId,
                install.ownerId,
                anticheat.anticheatEnvWrites(writes)
            );
            adopted += 1;
        } catch (caught) {
            // One server that cannot be read is not a reason to skip the rest.
            console.error(
                `[minecraft-anticheat] could not switch it on for ${install.id}:`,
                caught
            );
        }
    }
    return { adopted };
}

/**
 * The server a report is from, when it carries that server's token and still has
 * the engine switched on - or Polaris login, whose NeoForge mod carries the
 * anti-xray on servers the engine does not run on. An unknown server and a wrong
 * token are the same answer.
 */
export async function authorizeReporter(
    request: Request,
    installedAppId: string
): Promise<{ installedAppId: string; ownerId: string } | null> {
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented) return null;
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true, ownerId: true }
    });
    if (!install?.applicationId) return null;
    const vars = await listEnvVars("application", install.applicationId, install.ownerId);
    const env = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    if (!anticheat.anticheatOn(env) && !loginOn(env)) return null;
    const token = await readInstallEnvSecret(install.applicationId, install.ownerId, TOKEN_KEY);
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!token || !timingSafeEqual(digest(presented), digest(token))) return null;
    return { installedAppId, ownerId: install.ownerId };
}

/**
 * Where the server's X-Ray honeypots are, as the plugin reads them: [dimension,
 * x, y, z] with 0 for the Overworld and 1 for the Nether. Its anti-xray hides
 * every buried ore but these, so the traps are what an X-Ray client still shows.
 */
export async function honeypotsFor(installedAppId: string): Promise<number[][]> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    if (!row) return [];
    return readXray(host.appsInstallConfig.readInstallConfig(row.config)).honeypots.map((trap) => [
        trap.dimension === "minecraft:the_nether" ? 1 : 0,
        trap.x,
        trap.y,
        trap.z
    ]);
}

/** One flag as the plugin sends it, already validated by the route. */
export interface ReportedFlag {
    readonly player: string;
    readonly check: string;
    readonly vl: number;
    readonly verbose: string;
    readonly at: number;
}

/** Reports one server may send in a minute. The plugin sends one every five
 *  seconds at most (twelve a minute), each capped by the route; the room above
 *  that is for retries after Polaris was unreachable. */
export const REPORTS_PER_MINUTE = 60;

/**
 * Keep what a server reported. Times from the server's clock are trusted only
 * within a minute of Polaris's, so a server with a wrong clock cannot file
 * evidence in the past or the future.
 */
export async function recordFlags(
    server: { readonly installedAppId: string; readonly ownerId: string },
    flags: readonly ReportedFlag[]
): Promise<{ kept: number; limited: boolean }> {
    const { installedAppId } = server;
    const allowed = await rateLimit(
        `minecraft-anticheat:${installedAppId}`,
        REPORTS_PER_MINUTE,
        60_000
    ).catch(() => ({ ok: true }));
    if (!allowed.ok) return { kept: 0, limited: true };
    const now = Date.now();
    const rows = flags.map((flag) => ({
        installedAppId,
        player: flag.player.toLowerCase(),
        playerName: flag.player,
        check: flag.check,
        violations: Math.round(flag.vl),
        verbose: flag.verbose,
        at: new Date(Math.abs(flag.at - now) <= 60_000 ? flag.at : now)
    }));
    const players = [...new Set(rows.map((row) => row.player))];
    const before = await alertsPerPlayer(installedAppId, players, now);
    if (rows.length > 0) await prisma.minecraftAnticheatFlag.createMany({ data: rows });
    await tellOwner(server, players, before, now).catch(() => undefined);
    // Evidence older than the window counts for nothing, and is let go as new
    // evidence arrives rather than on a timer of its own.
    await prisma.minecraftAnticheatFlag
        .deleteMany({ where: { installedAppId, at: { lt: new Date(now - EVIDENCE_WINDOW_MS) } } })
        .catch(() => undefined);
    return { kept: rows.length, limited: false };
}

/** What the engine caught per player within the evidence window, newest first:
 *  every check with how often it failed, and the latest flags to show. */
export interface EngineRecord {
    readonly name: string;
    readonly checks: readonly {
        readonly check: string;
        readonly alerts: number;
        readonly maxViolations: number;
        readonly lastAt: number;
    }[];
    readonly recent: readonly {
        readonly check: string;
        readonly violations: number;
        readonly verbose: string;
        readonly at: number;
    }[];
}

/** Flags listed per player on the tab. */
const RECENT_PER_PLAYER = 20;

export async function engineRecords(installedAppId: string): Promise<EngineRecord[]> {
    const since = new Date(Date.now() - EVIDENCE_WINDOW_MS);
    const [groups, rows] = await Promise.all([
        prisma.minecraftAnticheatFlag.groupBy({
            by: ["player", "check"],
            where: { installedAppId, at: { gte: since } },
            _count: { _all: true },
            _max: { violations: true, at: true, playerName: true }
        }),
        prisma.minecraftAnticheatFlag.findMany({
            where: { installedAppId, at: { gte: since } },
            orderBy: { at: "desc" },
            take: 2000,
            select: { player: true, check: true, violations: true, verbose: true, at: true }
        })
    ]);
    const records = new Map<
        string,
        {
            name: string;
            checks: EngineRecord["checks"][number][];
            recent: EngineRecord["recent"][number][];
        }
    >();
    for (const group of groups) {
        const held = records.get(group.player) ?? {
            name: group._max.playerName ?? group.player,
            checks: [],
            recent: []
        };
        held.checks.push({
            check: group.check,
            alerts: group._count._all,
            maxViolations: group._max.violations ?? 0,
            lastAt: group._max.at?.getTime() ?? 0
        });
        records.set(group.player, held);
    }
    for (const row of rows) {
        const held = records.get(row.player);
        if (!held || held.recent.length >= RECENT_PER_PLAYER) continue;
        held.recent.push({
            check: row.check,
            violations: row.violations,
            verbose: row.verbose,
            at: row.at.getTime()
        });
    }
    return [...records.values()].map((held) => ({
        name: held.name,
        checks: held.checks.sort((left, right) => right.alerts - left.alerts),
        recent: held.recent
    }));
}

/** Forget one player's flags, when a moderator clears them. */
export async function clearEngineFlags(installedAppId: string, player: string): Promise<void> {
    await prisma.minecraftAnticheatFlag.deleteMany({
        where: { installedAppId, player: player.toLowerCase() }
    });
}

/** Everything kept about a server that no longer exists. */
export async function clearAnticheatFlags(installedAppId: string): Promise<void> {
    await prisma.minecraftAnticheatFlag
        .deleteMany({ where: { installedAppId } })
        .catch(() => undefined);
}

/** Each player's checks and alert counts within the window. */
async function alertsPerPlayer(
    installedAppId: string,
    players: readonly string[],
    now: number
): Promise<Map<string, { name: string; checks: { check: string; alerts: number }[] }>> {
    const groups = await prisma.minecraftAnticheatFlag.groupBy({
        by: ["player", "check"],
        where: {
            installedAppId,
            player: { in: [...players] },
            at: { gte: new Date(now - EVIDENCE_WINDOW_MS) }
        },
        _count: { _all: true },
        _max: { playerName: true }
    });
    const found = new Map<string, { name: string; checks: { check: string; alerts: number }[] }>();
    for (const group of groups) {
        const held = found.get(group.player) ?? {
            name: group._max.playerName ?? group.player,
            checks: []
        };
        held.checks.push({ check: group.check, alerts: group._count._all });
        found.set(group.player, held);
    }
    return found;
}

/**
 * Tell the owner the first time a player's alerts make them look likely to be
 * cheating within the window - once, when the score crosses that line, not on
 * every alert after it. Nothing is done to the player: that is the owner's call,
 * or the plugin's own punishments.
 */
async function tellOwner(
    server: { readonly installedAppId: string; readonly ownerId: string },
    players: readonly string[],
    before: Map<string, { name: string; checks: { check: string; alerts: number }[] }>,
    now: number
): Promise<void> {
    const after = await alertsPerPlayer(server.installedAppId, players, now);
    const serious = (checks: readonly { check: string; alerts: number }[] | undefined) => {
        const level = engineScore(checks ?? []).level;
        return level === "likely" || level === "confirmed";
    };
    const crossed = players.filter(
        (key) => !serious(before.get(key)?.checks) && serious(after.get(key)?.checks)
    );
    if (crossed.length === 0) return;
    const install = await prisma.installedApp.findUnique({
        where: { id: server.installedAppId },
        select: { name: true }
    });
    for (const key of crossed) {
        const record = after.get(key)!;
        const score = engineScore(record.checks);
        await createNotification({
            userId: server.ownerId,
            type: "games.xray",
            title: `${record.name} is likely cheating on ${install?.name ?? "Minecraft"}`,
            body: `${score.reasons.join(". ")}. Polaris anti-cheat caught it; look at the Anti-cheat tab before deciding.`,
            href: `/apps/installed/${server.installedAppId}/security`,
            level: "warning",
            actionRequired: true
        });
    }
}

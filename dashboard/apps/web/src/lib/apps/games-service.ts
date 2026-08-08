/**
 * Every game server this owner runs, whatever edition, as one list.
 *
 * A game server is an installed marketplace app whose manifest declares the
 * game-server capability, so this is a view over the same installs the app pages
 * manage rather than a second place servers can exist. Each row carries what the
 * list actually shows - who is playing and where to connect - which is a live
 * read per server, gathered in parallel and never allowed to fail the list: a
 * server that is still booting is a row that says so, not a page that errors.
 */

import { freemem, totalmem } from "node:os";
import { prisma } from "@polaris/db";
import { listHosts } from "@/lib/host-service";
import { getServerMetrics } from "@/lib/server-metrics-service";
import { appHasCapability, findApp } from "@/lib/apps/catalog";
import { applyFirewallBans, editionOf, getServerStatus, type MinecraftEdition } from "@/lib/apps/minecraft/service";

/** A machine a server can be created on, with what it has left to give. */
export interface GameMachine {
    readonly id: string;
    readonly name: string;
    /** What the machine has, when Polaris can measure it. */
    readonly memoryTotalBytes: number | null;
    readonly memoryFreeBytes: number | null;
    /** Memory this owner's game servers on it are already promised. */
    readonly committedMb: number;
}

export interface GameServerRow {
    readonly id: string;
    readonly name: string;
    readonly catalogId: string;
    readonly catalogName: string;
    readonly edition: MinecraftEdition;
    /** The machine it runs on. */
    readonly serverName: string | null;
    readonly running: boolean;
    readonly answering: boolean;
    readonly address: string | null;
    readonly online: number;
    readonly max: number;
    readonly players: readonly string[];
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
}

/** The owner's game servers, newest first. */
export async function listGameServers(ownerId: string): Promise<GameServerRow[]> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        orderBy: { createdAt: "desc" }
    });
    const games = installs.filter((install) => {
        const manifest = findApp(install.catalogId);
        return manifest ? appHasCapability(manifest, "game-server") : false;
    });
    const targets = new Map(
        (
            await prisma.deployTarget.findMany({
                where: { id: { in: games.map((game) => game.targetId).filter((id): id is string => id !== null) } },
                select: { id: true, name: true }
            })
        ).map((target) => [target.id, target.name])
    );

    return Promise.all(
        games.map(async (install) => {
            const manifest = findApp(install.catalogId);
            const status = await getServerStatus(ownerId, install.id).catch(() => null);
            return {
                id: install.id,
                name: install.name,
                catalogId: install.catalogId,
                catalogName: manifest?.name ?? install.catalogId,
                edition: editionOf(install.catalogId),
                serverName: install.targetId ? (targets.get(install.targetId) ?? null) : null,
                running: status?.running ?? false,
                answering: status?.answering ?? false,
                address: status?.address ?? null,
                online: status?.players.online ?? 0,
                max: status?.players.max ?? 0,
                players: status?.players.players ?? [],
                message: status?.message ?? (status ? null : "This server is still being set up")
            };
        })
    );
}

/**
 * The machines a server can go on, and what each has left.
 *
 * Two numbers, because they answer different questions. What the machine has
 * free right now is measured (over SSH for a connected server, from the host this
 * process runs on for the local one) and moves. What its game servers are already
 * promised is Polaris' own bookkeeping and does not: it is the sum of the heaps
 * handed out, which is what actually decides whether the next server fits.
 */
export async function listGameMachines(ownerId: string): Promise<GameMachine[]> {
    const hosts = await listHosts(ownerId);
    const committed = await committedMemoryByTarget(ownerId);
    const local: GameMachine = {
        id: "local",
        name: "Local (this server)",
        // The web runs in a container that shares the host's memory accounting, so
        // these are the machine's figures unless it was given a limit of its own.
        memoryTotalBytes: totalmem(),
        memoryFreeBytes: freemem(),
        committedMb: committed.get("local") ?? 0
    };
    const remote = await Promise.all(
        hosts.map(async (host) => {
            const metrics = await getServerMetrics(host.id, ownerId).catch(() => null);
            return {
                id: host.id,
                name: host.name,
                memoryTotalBytes: metrics?.memoryTotalBytes ?? null,
                memoryFreeBytes:
                    metrics?.memoryTotalBytes !== null &&
                    metrics?.memoryTotalBytes !== undefined &&
                    metrics.memoryUsedBytes !== null
                        ? metrics.memoryTotalBytes - metrics.memoryUsedBytes
                        : null,
                committedMb: committed.get(host.id) ?? 0
            };
        })
    );
    return [local, ...remote];
}

/** Megabytes of heap this owner's game servers have been given, per machine. */
async function committedMemoryByTarget(ownerId: string): Promise<Map<string, number>> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: { catalogId: true, applicationId: true, targetId: true }
    });
    const games = installs.filter((install) => {
        const manifest = findApp(install.catalogId);
        return manifest ? appHasCapability(manifest, "game-server") : false;
    });
    if (games.length === 0) return new Map();

    const targets = await prisma.deployTarget.findMany({
        where: { id: { in: games.map((game) => game.targetId).filter((id): id is string => id !== null) } },
        select: { id: true, kind: true, hostId: true }
    });
    const machineOf = new Map(targets.map((target) => [target.id, target.kind === "host" && target.hostId ? target.hostId : "local"]));

    const vars = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: { in: games.map((game) => game.applicationId as string) },
            key: "MEMORY"
        },
        select: { scopeId: true, value: true }
    });
    const memoryOf = new Map(vars.map((row) => [row.scopeId, parseMemoryMb(row.value ?? "")]));

    const byMachine = new Map<string, number>();
    for (const game of games) {
        const machine = game.targetId ? (machineOf.get(game.targetId) ?? "local") : "local";
        const megabytes = memoryOf.get(game.applicationId as string) ?? 0;
        byMachine.set(machine, (byMachine.get(machine) ?? 0) + megabytes);
    }
    return byMachine;
}

/** "2G", "2560M" or a bare number of megabytes, as megabytes. */
export function parseMemoryMb(value: string): number {
    const match = /^(\d+(?:\.\d+)?)\s*([gGmM])?$/.exec(value.trim());
    if (!match) return 0;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return 0;
    return match[2]?.toLowerCase() === "g" ? Math.round(amount * 1024) : Math.round(amount);
}

/**
 * Hand every running server the addresses the firewall blocks.
 *
 * A blocklist that only applies where somebody pressed a button is not a
 * blocklist, so this is the pass that makes it true everywhere: it walks the
 * owner's game servers and bans on each what it has not banned yet. Best effort
 * per server - one that is still starting is skipped, not fatal - and it reports
 * what it did so the caller can log it.
 */
export async function syncFirewallBans(ownerId: string): Promise<{ servers: number; banned: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        select: { id: true, catalogId: true }
    });
    let servers = 0;
    let banned = 0;
    for (const install of installs) {
        const manifest = findApp(install.catalogId);
        if (!manifest || !appHasCapability(manifest, "game-server")) continue;
        // Bedrock has no ban command at all, so there is nothing to hand it.
        if (editionOf(install.catalogId) === "bedrock") continue;
        const applied = await applyFirewallBans(ownerId, install.id).catch(() => null);
        if (applied === null) continue;
        servers += 1;
        banned += applied;
    }
    return { servers, banned };
}

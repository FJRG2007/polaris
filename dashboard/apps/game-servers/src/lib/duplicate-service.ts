/**
 * Duplicating a game server: a second server with everything the first has -
 * settings, mods and plugins, world, schedules, kept commands, player rules,
 * sounds, logins, who may run it and the backup plan it is under - on its own
 * port, its own volume and its own credentials.
 *
 * Two halves. `startDuplicate` decides and records: it checks the name and the
 * room on the disk, works out the copy's ports, environment and config (see
 * `duplicate-plan`), and creates the copy's records with nothing deployed. Then
 * `runDuplicate` does the slow part in the background: the source is saved and
 * stopped, its files copied into the copy's own storage, the source started
 * again, and the copy deployed. Every step is written onto the copy's config, so
 * the list can say where it is and, if it stops, why.
 *
 * The source's storage is only ever read. If the copy fails, the source is
 * exactly what it was, running if it was running; the copy stays in the list
 * saying what went wrong, with a retry and a delete beside it.
 */

import { prisma } from "@polaris/db";
import { gameMessage } from "./game-message";
import { flushGameWorld } from "./games-flush";
import { allocateArkPorts } from "./ark/create";
import { mintJoinPassword } from "./ark/service";
import { allocateFivemPort } from "./fivem/create";
import { packToken } from "./minecraft/client-pack";
import { allocateHytalePort } from "./hytale/create";
import { randomBytes, randomUUID } from "node:crypto";
import { gameServerCatalogIds } from "./game-catalog";
import { FIVEM_CONTAINER_PORT } from "./fivem/config";
import { adoptConsolePassword, mintConsolePassword } from "./fivem/service";
import { setGameHostname } from "./minecraft/address";
import { TOKEN_KEY } from "./minecraft/polaris-login";
import { findGame, gameOfServer } from "@polaris/core";
import { soundPackToken } from "./minecraft/sounds-service";
import * as plan from "./duplicate-plan";
import type { DuplicateFailure, DuplicateState } from "./duplicate-plan";
import { heldByCopies } from "./duplicate-busy";
import { host } from "@polaris/app-host";

const { findApp } = host.appsCatalog;
const { availableHostPort } = host.appsPortRegistry;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { deployApplication, setApplicationRunning } = host.deployService;
const { holdStorage, releaseStorage } = host.storageHold;
const duplicates = host.appsInstallDuplicate;

/** How often progress is written while bytes move. */
const PROGRESS_EVERY_MS = 3_000;

/** Sources a copy is being started or retried from in this process right now. */
const claiming = new Set<string>();

/** A published port of the source, as its service config records it. */
interface PublishedPort {
    readonly host: number;
    readonly container: number;
    readonly protocol: "tcp" | "udp";
}

/**
 * Check, decide and record a copy of a server, returning its id. Nothing is
 * stopped and no bytes move here; that is `runDuplicate`, which the caller runs
 * after answering.
 */
export async function startDuplicate(
    ownerId: string,
    actorId: string,
    raw: plan.DuplicateServerInput
): Promise<{ installedAppId: string }> {
    const parsed = plan.duplicateServerSchema.safeParse(raw);
    if (!parsed.success)
        throw new Error(
            parsed.error.issues[0]?.message ?? gameMessage("games", "duplicate.nameRequired")
        );
    const { installedAppId: sourceId, name } = parsed.data;
    return claimSource(sourceId, () => recordDuplicate(ownerId, actorId, sourceId, name));
}

async function recordDuplicate(
    ownerId: string,
    actorId: string,
    sourceId: string,
    name: string
): Promise<{ installedAppId: string }> {
    const source = await duplicates.readInstallCopySource(ownerId, sourceId).catch(() => null);
    if (!source || !gameServerCatalogIds().includes(source.catalogId))
        throw new Error(gameMessage("games", "lib.noSuchServer"));
    if (!source.deployed) throw new Error(gameMessage("games", "duplicate.failure.neverDeployed"));
    if ((await heldByCopies()).has(sourceId))
        throw new Error(gameMessage("games", "duplicate.alreadyCopying"));

    const siblings = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, catalogId: { in: gameServerCatalogIds() } },
        select: { name: true },
        take: 1000
    });
    if (
        plan.nameTaken(
            name,
            siblings.map((row) => row.name)
        )
    )
        throw new Error(gameMessage("games", "duplicate.nameTaken", { name }));

    // Asked of the running server before anything exists, so a copy that cannot
    // fit is refused while refusing costs nothing. A stopped server cannot be
    // asked; the copying container checks again and that check always runs.
    const figures = await duplicates.measureInstallData(ownerId, sourceId);
    if (figures && !figures.fits)
        throw new Error(
            gameMessage("games", "duplicate.failure.noSpace", {
                need: plan.formatBytes(figures.usedBytes),
                free: plan.formatBytes(figures.freeBytes)
            })
        );

    const copyId = randomUUID();
    const substitutions: (readonly [string, string])[] = [
        [packToken(sourceId), packToken(copyId)],
        [soundPackToken(sourceId), soundPackToken(copyId)],
        [sourceId, copyId]
    ];
    const ports = await copyPorts(source.catalogId, source.sourceConfig);
    const env = plan.copiedEnv({
        env: source.env,
        remint: remintFor(source.catalogId),
        substitutions,
        overrides: ports.env
    });
    const config = plan.copiedConfig(readInstallConfig(source.config), substitutions);
    const sourceRunning = await desiredRunning(source.applicationId);
    const state: DuplicateState = {
        from: sourceId,
        fromName: source.name,
        stage: "preparing",
        copiedBytes: 0,
        totalBytes: figures?.usedBytes ?? null,
        failure: null,
        needBytes: null,
        freeBytes: null,
        sourceWasRunning: sourceRunning,
        startedAt: new Date().toISOString()
    };

    try {
        await duplicates.createInstallCopy(ownerId, actorId, sourceId, {
            installedAppId: copyId,
            name,
            env,
            ports: ports.published,
            config: { ...config, [plan.DUPLICATE_KEY]: state }
        });
    } catch (error) {
        if ((error as { code?: unknown }).code === "name-taken")
            throw new Error(gameMessage("games", "duplicate.nameTaken", { name }));
        throw error;
    }
    try {
        await copyGameRows(sourceId, copyId, substitutions);
    } catch (error) {
        await duplicates
            .discardInstallCopy(ownerId, copyId)
            .catch((discardError: unknown) =>
                console.error(`games: duplicate ${copyId} could not be taken back:`, discardError)
            );
        throw error;
    }
    return { installedAppId: copyId };
}

/**
 * The slow half: stop the source, copy its files, start it again, deploy the
 * copy. Never throws - every outcome is written onto the copy for the list to
 * show, and the source is started again whatever happened to the copy.
 */
export async function runDuplicate(
    ownerId: string,
    actorId: string | null,
    copyId: string
): Promise<void> {
    await copyThrough(ownerId, actorId, copyId).catch(async (error: unknown) => {
        console.error(`games: duplicate ${copyId} failed:`, error);
        await markFailed(copyId, "copyFailed").catch(() => undefined);
    });
}

async function copyThrough(ownerId: string, actorId: string | null, copyId: string): Promise<void> {
    const copy = await prisma.installedApp.findFirst({
        where: { id: copyId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true, config: true, name: true }
    });
    const begun = copy ? plan.readDuplicateState(readInstallConfig(copy.config)) : null;
    if (!copy?.applicationId || !begun) return;
    const source = await prisma.installedApp.findFirst({
        where: { id: begun.from, ownerId, status: { not: "removed" } },
        select: { id: true, applicationId: true }
    });

    let state: DuplicateState = {
        ...begun,
        stage: "preparing",
        failure: null,
        needBytes: null,
        freeBytes: null
    };
    const write = async (patch: Partial<DuplicateState>): Promise<void> => {
        state = { ...state, ...patch };
        await patchInstallConfig(copyId, { [plan.DUPLICATE_KEY]: state }).catch(() => undefined);
    };
    await prisma.installedApp
        .update({ where: { id: copyId }, data: { status: "installing" } })
        .catch(() => undefined);
    await write({});

    if (!source?.applicationId) {
        await fail(copyId, write, "copyFailed");
        return;
    }
    const sourceApplicationId = source.applicationId;
    const held = [sourceApplicationId, copy.applicationId];
    let holding = true;
    const release = async (): Promise<void> => {
        if (!holding) return;
        holding = false;
        await releaseStorage(held).catch(() => undefined);
    };
    await holdStorage(held);

    try {
        // Read now, not when the copy was asked for: a retry comes after the source
        // was started again or switched off, and only what it is doing now says
        // whether it has to be stopped and brought back.
        await write({ sourceWasRunning: await desiredRunning(sourceApplicationId) });
        await write({ stage: "stopping" });
        if (state.sourceWasRunning && (await desiredRunning(sourceApplicationId))) {
            // Written out first: a stop that is not graceful is killed, and a
            // copy of an unsaved world is a copy of the world as it was minutes ago.
            await flushGameWorld(ownerId, source.id);
            await setApplicationRunning(sourceApplicationId, ownerId, false, actorId);
        }

        await write({ stage: "copying" });
        let lastWrite = 0;
        try {
            await duplicates.copyInstallData(ownerId, source.id, copyId, async (progress) => {
                const now = Date.now();
                if (now - lastWrite < PROGRESS_EVERY_MS) return;
                lastWrite = now;
                await write({
                    copiedBytes: progress.copiedBytes,
                    totalBytes: progress.totalBytes ?? state.totalBytes
                });
            });
        } finally {
            // Back up whatever happened to the copy: the source is the server
            // somebody is playing on, and this was never meant to cost it more than
            // the minutes the copy took.
            await release();
            if (state.sourceWasRunning) await restartSource(ownerId, sourceApplicationId, actorId);
        }

        await write({ stage: "starting", copiedBytes: state.totalBytes ?? state.copiedBytes });
        try {
            await deployApplication(copy.applicationId, ownerId, actorId);
        } catch (error) {
            console.error(`games: duplicate ${copyId} did not start:`, error);
            await fail(copyId, write, "startFailed");
            return;
        }
        await duplicates.verifyInstallCopy(ownerId, copyId);
        await afterCopy(ownerId, copyId, copy.catalogId);
        await finish(ownerId, copyId, copy.catalogId, copy.name);
        if (actorId)
            await host.auditService
                .recordAudit({
                    actorId,
                    action: "games.duplicate",
                    targetType: "installedApp",
                    targetId: copyId,
                    metadata: { from: source.id }
                })
                .catch(() => undefined);
    } catch (error) {
        await release();
        const refusal = error as {
            name?: unknown;
            code?: unknown;
            detail?: { needBytes?: number; freeBytes?: number };
        };
        if (refusal.name === "InstallCopyRefusal" && typeof refusal.code === "string") {
            await fail(copyId, write, plan.failureFor(refusal.code), refusal.detail);
            return;
        }
        console.error(`games: duplicate ${copyId} failed:`, error);
        await fail(copyId, write, "copyFailed");
    }
}

/**
 * Copies a restart cut short. A copy is a background task of this process, so
 * one found mid-way at boot is one that will never finish: it is marked so, and
 * its source - stopped for it - is started again if it was running before.
 */
export async function recoverInterruptedCopies(): Promise<number> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, config: { contains: `"${plan.DUPLICATE_KEY}"` } },
        select: { id: true, ownerId: true, config: true },
        take: 200
    });
    let recovered = 0;
    for (const row of rows) {
        const state = plan.readDuplicateState(readInstallConfig(row.config));
        if (!state || state.stage === "failed") continue;
        await markFailed(row.id, "interrupted", state);
        if (state.sourceWasRunning) {
            const source = await prisma.installedApp.findFirst({
                where: { id: state.from, ownerId: row.ownerId },
                select: { applicationId: true }
            });
            if (source?.applicationId && !(await desiredRunning(source.applicationId)))
                await restartSource(row.ownerId, source.applicationId, null);
        }
        recovered += 1;
    }
    return recovered;
}

/**
 * Take a copy that failed for one more try, if it is one: it is a copy, it
 * failed, and nothing has taken it since. The claim is the switch from failed to
 * installing, so of two presses only one wins and only one copy runs.
 */
export async function claimRetry(ownerId: string, copyId: string): Promise<boolean> {
    const row = await prisma.installedApp.findFirst({
        where: { id: copyId, ownerId, status: { not: "removed" } },
        select: { config: true }
    });
    const state = plan.readDuplicateState(readInstallConfig(row?.config));
    if (state?.stage !== "failed") return false;
    return claimSource(state.from, async () => {
        // Its source may be held by another copy started since this one failed.
        if ((await heldByCopies()).has(state.from)) return false;
        const claimed = await prisma.installedApp.updateMany({
            where: { id: copyId, ownerId, status: "failed" },
            data: { status: "installing" }
        });
        if (claimed.count !== 1) return false;
        await patchInstallConfig(copyId, {
            [plan.DUPLICATE_KEY]: {
                ...state,
                stage: "preparing",
                failure: null
            } satisfies DuplicateState
        });
        return true;
    });
}

/** Run `work` as the only start or retry of a copy of this source in flight. */
async function claimSource<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    if (claiming.has(sourceId)) throw new Error(gameMessage("games", "duplicate.alreadyCopying"));
    claiming.add(sourceId);
    try {
        return await work();
    } finally {
        claiming.delete(sourceId);
    }
}

/** Write a copy as failed from outside its run, from what its config says. */
async function markFailed(
    copyId: string,
    failure: DuplicateFailure,
    known?: DuplicateState
): Promise<void> {
    const row = known
        ? null
        : await prisma.installedApp.findUnique({ where: { id: copyId }, select: { config: true } });
    const state = known ?? plan.readDuplicateState(readInstallConfig(row?.config));
    if (state) {
        await patchInstallConfig(copyId, {
            [plan.DUPLICATE_KEY]: { ...state, stage: "failed", failure } satisfies DuplicateState
        }).catch(() => undefined);
    }
    await prisma.installedApp
        .update({ where: { id: copyId }, data: { status: "failed" } })
        .catch(() => undefined);
}

async function fail(
    copyId: string,
    write: (patch: Partial<DuplicateState>) => Promise<void>,
    failure: DuplicateFailure,
    detail: { needBytes?: number; freeBytes?: number } = {}
): Promise<void> {
    await write({
        stage: "failed",
        failure,
        needBytes: detail.needBytes ?? null,
        freeBytes: detail.freeBytes ?? null
    });
    await prisma.installedApp
        .update({ where: { id: copyId }, data: { status: "failed" } })
        .catch(() => undefined);
}

/** Start the source again, logged rather than thrown: the copy's outcome is
 *  reported on the copy, and this must not replace it. */
async function restartSource(
    ownerId: string,
    applicationId: string,
    actorId: string | null
): Promise<void> {
    await setApplicationRunning(applicationId, ownerId, true, actorId).catch((error: unknown) =>
        console.error(`games: could not start ${applicationId} again after copying it:`, error)
    );
}

/** The copy is up: its own address, and the record says it is done. */
async function finish(
    ownerId: string,
    copyId: string,
    catalogId: string,
    name: string
): Promise<void> {
    const game = gameOfServer(catalogId);
    const definition = game ? findGame(game.id) : undefined;
    await setGameHostname(ownerId, copyId, {
        name,
        srv: catalogId === "minecraft",
        ...(definition ? { gameLabel: definition.domainLabel } : {})
    }).catch((error: unknown) =>
        console.error(`games: duplicate ${copyId} has no address:`, error)
    );
    await patchInstallConfig(copyId, { [plan.DUPLICATE_KEY]: null });
    await prisma.installedApp.update({ where: { id: copyId }, data: { status: "running" } });
}

/** What one game needs once its copied files are in place. */
async function afterCopy(ownerId: string, copyId: string, catalogId: string): Promise<void> {
    if (catalogId !== "fivem") return;
    // FiveM keeps its console password in a config file the image wrote on the
    // source's first start, so the copied file names the source's. The deploy
    // holds the copy's own; the file is brought in line with it.
    const app = await prisma.installedApp.findUnique({
        where: { id: copyId },
        select: { applicationId: true }
    });
    const row = app?.applicationId
        ? await prisma.envVar.findFirst({
              where: { scopeType: "application", scopeId: app.applicationId, key: "RCON_PASSWORD" },
              select: { id: true }
          })
        : null;
    const password = row ? await host.envVarService.revealEnvVar(row.id, ownerId) : null;
    if (!password) return;
    await adoptConsolePassword(ownerId, copyId, password).catch((error: unknown) =>
        console.error(
            `games: duplicate ${copyId} kept the source's console password in its config:`,
            error
        )
    );
}

/**
 * The credentials a copy must not share with its source, by variable, with how
 * a new one is minted. The manifest's generated ones (Minecraft's RCON password)
 * the way the install mints them; the rest the way each game's own create does.
 */
function remintFor(catalogId: string): Record<string, () => string> {
    const remint: Record<string, () => string> = {
        [TOKEN_KEY]: () => randomBytes(32).toString("hex")
    };
    for (const declared of findApp(catalogId)?.template?.env ?? []) {
        if (declared.generated)
            remint[declared.key] = () =>
                `${declared.generatedPrefix ?? ""}${randomBytes(24).toString("hex")}`;
    }
    if (catalogId === "fivem") remint.RCON_PASSWORD = mintConsolePassword;
    if (catalogId === "ark") remint.ADMIN_PASSWORD = mintJoinPassword;
    return remint;
}

/** The source's published ports, as its service config records them. */
function publishedPorts(sourceConfig: Record<string, unknown>): PublishedPort[] {
    const out: PublishedPort[] = [];
    const protocolOf = (value: unknown): "tcp" | "udp" => (value === "udp" ? "udp" : "tcp");
    if (typeof sourceConfig.hostPort === "number") {
        out.push({
            host: sourceConfig.hostPort,
            container:
                typeof sourceConfig.port === "number" ? sourceConfig.port : sourceConfig.hostPort,
            protocol: protocolOf(sourceConfig.hostProtocol)
        });
    }
    if (Array.isArray(sourceConfig.extraPorts)) {
        for (const entry of sourceConfig.extraPorts as {
            host?: unknown;
            container?: unknown;
            protocol?: unknown;
        }[]) {
            if (typeof entry.host === "number" && typeof entry.container === "number")
                out.push({
                    host: entry.host,
                    container: entry.container,
                    protocol: protocolOf(entry.protocol)
                });
        }
    }
    return out;
}

/**
 * Ports for the copy. ARK, FiveM and Hytale allocate theirs the way their own
 * create does, inside the operator's port blocks and with ARK's tied run kept
 * whole; anything else takes the next free port from where each of the
 * source's sits, on the same transport, for the same container port.
 */
async function copyPorts(
    catalogId: string,
    sourceConfig: Record<string, unknown>
): Promise<{
    published: {
        hostPort?: number;
        hostProtocol?: "tcp" | "udp";
        extraPorts?: { host: number; container: number; protocol: "tcp" | "udp" }[];
    };
    env: Record<string, string>;
}> {
    if (catalogId === "ark") {
        const ports = await allocateArkPorts();
        return {
            published: {
                hostPort: ports.game,
                hostProtocol: "udp",
                extraPorts: [
                    { host: ports.raw, container: ports.raw, protocol: "udp" },
                    { host: ports.query, container: ports.query, protocol: "udp" }
                ]
            },
            env: {
                GAME_CLIENT_PORT: String(ports.game),
                UDP_SOCKET_PORT: String(ports.raw),
                SERVER_LIST_PORT: String(ports.query)
            }
        };
    }
    if (catalogId === "fivem") {
        const port = await allocateFivemPort();
        return {
            published: {
                hostPort: port,
                hostProtocol: "tcp",
                extraPorts: [{ host: port, container: FIVEM_CONTAINER_PORT, protocol: "udp" }]
            },
            env: {}
        };
    }
    if (catalogId === "hytale") {
        const port = await allocateHytalePort();
        return { published: { hostPort: port, hostProtocol: "udp" }, env: {} };
    }
    const source = publishedPorts(sourceConfig);
    const hosts = await plan.nextFreePorts(
        source.map((port) => ({ from: port.host, protocol: port.protocol })),
        (from, protocol) => availableHostPort(from, protocol)
    );
    const [primary, ...extra] = source;
    return {
        published: {
            ...(primary ? { hostPort: hosts[0], hostProtocol: primary.protocol } : {}),
            ...(extra.length > 0
                ? {
                      extraPorts: extra.map((port, index) => ({
                          host: hosts[index + 1]!,
                          container: port.container,
                          protocol: port.protocol
                      }))
                  }
                : {})
        },
        env: {}
    };
}

/** Whether a service is meant to be up. */
async function desiredRunning(applicationId: string): Promise<boolean> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { desiredState: true, currentDeploymentId: true }
    });
    return app?.desiredState === "running" && app.currentDeploymentId !== null;
}

/**
 * The rows that make a server what it is beyond its config: who may join, the
 * rules it plays by, the bans in force, which player is which person, the
 * passwords its players set, and its sounds. What it has merely been through -
 * sessions, statistics, samples, flags - stays the source's.
 */
async function copyGameRows(
    fromId: string,
    toId: string,
    substitutions: readonly (readonly [string, string])[]
): Promise<void> {
    const where = { installedAppId: fromId };
    const [access, rules, sanctions, links, logins, sounds, pack] = await Promise.all([
        prisma.gamePlayerAccess.findMany({ where, take: 5000 }),
        prisma.gameRuleSetting.findMany({ where, take: 1000 }),
        prisma.gameSanction.findMany({
            where: {
                ...where,
                liftedAt: null,
                OR: [{ until: null }, { until: { gt: new Date() } }]
            },
            take: 5000
        }),
        prisma.gamePlayerLink.findMany({ where, take: 5000 }),
        prisma.minecraftLogin.findMany({ where, take: 10000 }),
        prisma.minecraftSound.findMany({ where, take: 500 }),
        prisma.minecraftSoundPack.findUnique({ where: { installedAppId: fromId } })
    ]);
    const strip = <T extends { id: string; installedAppId: string }>(row: T) => {
        const { id: _id, installedAppId: _from, ...rest } = row;
        return { ...rest, installedAppId: toId };
    };
    await prisma.$transaction([
        prisma.gamePlayerAccess.createMany({ data: access.map(strip) }),
        prisma.gameRuleSetting.createMany({ data: rules.map(strip) }),
        prisma.gameSanction.createMany({ data: sanctions.map(strip) }),
        prisma.gamePlayerLink.createMany({ data: links.map(strip) }),
        prisma.minecraftLogin.createMany({ data: logins.map(strip) }),
        prisma.minecraftSound.createMany({ data: sounds.map(strip) }),
        ...(pack
            ? [
                  prisma.minecraftSoundPack.create({
                      data: {
                          installedAppId: toId,
                          revision: pack.revision,
                          settings: plan.substitute(pack.settings, substitutions)
                      }
                  })
              ]
            : [])
    ]);
}

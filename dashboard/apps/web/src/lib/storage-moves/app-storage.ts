/**
 * Where a service keeps its data, as chosen from its own screen - the server half.
 *
 * A service's mode (`placement.ts`) is followed by three things: choosing it
 * moves the data when that can be done now, the `app-storage` sweep moves it the
 * next time the service is stopped, and starting a `park` service brings its
 * data home before it starts (`bringHomeBeforeStart`, from `setApplicationRunning`).
 * Every one of them is an ordinary storage move, started with `auto` so its
 * original is emptied once the service runs on the checked copy.
 *
 * Server-only.
 */

import * as plan from "./plan";
import { prisma } from "@polaris/db";
import { storageHeld } from "./hold";
import * as placement from "./placement";
import { getSetting, setSetting } from "@/lib/setting-store";
import { gameForCatalogId, HOST_MOUNTABLE_KINDS } from "@polaris/core";
import { startMove, type MoveError, type StartRefusal } from "./service";

/** The label a move stores for this server when no screen named it: every screen
 *  shows an empty one as "this server" in the reader's language. */
const THIS_SERVER = "";

export async function readPolicy(): Promise<placement.StoragePolicy> {
    return placement.parsePolicy(await getSetting(placement.POLICY_SETTING));
}

export async function writePolicy(policy: placement.StoragePolicy): Promise<void> {
    await setSetting(placement.POLICY_SETTING, JSON.stringify(policy));
}

interface AppFacts {
    readonly id: string;
    readonly ownerId: string;
    readonly desiredState: string;
    readonly asleep: boolean;
    readonly deployed: boolean;
    readonly swarm: boolean;
    readonly game: boolean;
    readonly own: placement.StorageChoice | null;
    readonly pendingSince: Date | null;
    readonly createdAt: Date;
    readonly volumes: placement.PlacedVolume[];
}

const APP_SELECT = {
    id: true,
    desiredState: true,
    asleepSince: true,
    currentDeploymentId: true,
    storageMode: true,
    storageConnectionId: true,
    parkPendingSince: true,
    createdAt: true,
    target: { select: { runtime: true } },
    environment: { select: { project: { select: { ownerId: true } } } },
    volumes: { select: { id: true, name: true, kind: true, source: true, connectionId: true } }
} as const;

async function factsOf(where: { id: { in: string[] } } | { storageMode: { not: null } }) {
    const apps = await prisma.application.findMany({ where, select: APP_SELECT, take: 1000 });
    const installs = await prisma.installedApp.findMany({
        where: { applicationId: { in: apps.map((app) => app.id) } },
        select: { applicationId: true, catalogId: true }
    });
    const games = new Set(
        installs
            .filter((install) => gameForCatalogId(install.catalogId))
            .map((install) => install.applicationId)
    );
    return apps.map((app): AppFacts => ({
        id: app.id,
        ownerId: app.environment.project.ownerId,
        desiredState: app.desiredState,
        asleep: app.asleepSince !== null,
        deployed: app.currentDeploymentId !== null,
        swarm: app.target.runtime === "swarm",
        game: games.has(app.id),
        own: placement.choiceOf(app.storageMode, app.storageConnectionId),
        pendingSince: app.parkPendingSince,
        createdAt: app.createdAt,
        volumes: app.volumes.flatMap((volume) => {
            const where = plan.placementOf(volume);
            return where ? [{ id: volume.id, location: plan.locationOf(where) }] : [];
        })
    }));
}

/** Every game server's install, for a policy that applies to all of them. */
async function gameInstalls(): Promise<{ applicationId: string; name: string }[]> {
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true, catalogId: true, name: true },
        take: 1000
    });
    return installs
        .filter((install) => gameForCatalogId(install.catalogId))
        .map((install) => ({ applicationId: install.applicationId!, name: install.name }));
}

async function gameAppIds(): Promise<string[]> {
    return (await gameInstalls()).map((install) => install.applicationId);
}

/** The NAS locations an owner has that a service of theirs can be kept on. */
async function ownedConnections(ownerId: string): Promise<{ id: string; name: string }[]> {
    return prisma.storageConnection.findMany({
        where: { ownerId, kind: { in: [...HOST_MOUNTABLE_KINDS] } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 100
    });
}

/** The ids of the NAS locations each of these owners has. */
async function connectionsByOwner(ownerIds: readonly string[]): Promise<Map<string, string[]>> {
    const rows = await prisma.storageConnection.findMany({
        where: { ownerId: { in: [...new Set(ownerIds)] }, kind: { in: [...HOST_MOUNTABLE_KINDS] } },
        select: { id: true, ownerId: true },
        take: 5000
    });
    const owned = new Map<string, string[]>();
    for (const row of rows) {
        if (row.ownerId) owned.set(row.ownerId, [...(owned.get(row.ownerId) ?? []), row.id]);
    }
    return owned;
}

function destinationOf(location: plan.Location): string {
    return location.kind === "server" ? "server" : location.connectionId;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Take every stopped service with a mode to where that mode keeps it. Never
 * touches a running service, so a choice made by the instance for every game
 * server reaches each one the next time it is stopped, not in the middle of a
 * game.
 */
export async function sweepAppStorage(): Promise<{ started: number }> {
    const policy = await readPolicy();
    const chosen = await factsOf({ storageMode: { not: null } });
    // Game servers nobody chose for follow the instance's default when owners may
    // not choose, or when they were created after it was set.
    const forced =
        policy.ownersChoose && policy.since === null
            ? []
            : await factsOf({
                  id: {
                      in: (await gameAppIds()).filter((id) => !chosen.some((app) => app.id === id))
                  }
              });
    const apps = [...chosen, ...forced];
    if (apps.length === 0) return { started: 0 };
    const ids = apps.map((app) => app.id);
    const [busy, failures, owned] = await Promise.all([
        prisma.storageMove.findMany({
            where: { applicationId: { in: ids }, state: { in: [...plan.BLOCKING_STATES] } },
            select: { applicationId: true }
        }),
        prisma.storageMove.findMany({
            where: {
                applicationId: { in: ids },
                auto: true,
                state: "failed",
                finishedAt: { gt: new Date(Date.now() - placement.RETRY_AFTER_MS) }
            },
            select: { applicationId: true, finishedAt: true }
        }),
        connectionsByOwner(apps.map((app) => app.ownerId))
    ]);
    const moving = new Set(busy.map((move) => move.applicationId));
    const failedAt = new Map(failures.map((move) => [move.applicationId, move.finishedAt]));
    const now = new Date();
    let started = 0;
    for (const app of apps) {
        const action = placement.sweepAction({
            choice: placement.effectiveChoice(
                app.own,
                policy,
                app.game,
                app.createdAt,
                owned.get(app.ownerId) ?? []
            ),
            stopped: app.desiredState === "stopped" && !app.asleep,
            deployed: app.deployed && !app.swarm,
            busy: moving.has(app.id) || storageHeld(app.id),
            volumes: app.volumes,
            pendingSince: app.pendingSince,
            failedAt: failedAt.get(app.id) ?? null,
            now
        });
        try {
            if (action.kind === "stamp" || action.kind === "clear")
                await prisma.application.update({
                    where: { id: app.id },
                    data: { parkPendingSince: action.kind === "stamp" ? now : null }
                });
            if (action.kind === "move") {
                const result = await startMove({
                    volumeId: action.volumeId,
                    destination: destinationOf(action.to),
                    actorId: null,
                    serverLabel: THIS_SERVER,
                    auto: true
                });
                if ("id" in result) started += 1;
                await prisma.application.update({
                    where: { id: app.id },
                    data: { parkPendingSince: null }
                });
            }
        } catch (caught) {
            console.error(`polaris: storage sweep could not place ${app.id}:`, caught);
        }
    }
    return { started };
}

/**
 * The names of the game servers the instance's default applies to that cannot
 * follow it, because their owner does not have the default's NAS: they stay
 * where they are, and the admin screen says which.
 */
export async function gameServersOutOfReach(): Promise<string[]> {
    const policy = await readPolicy();
    if (!placement.policyChoice(policy)?.connectionId) return [];
    const installs = await gameInstalls();
    const apps = await factsOf({ id: { in: installs.map((install) => install.applicationId) } });
    const owned = await connectionsByOwner(apps.map((app) => app.ownerId));
    const off = new Set(
        apps
            .filter((app) =>
                placement.defaultOutOfReach(
                    app.own,
                    policy,
                    app.game,
                    app.createdAt,
                    owned.get(app.ownerId) ?? []
                )
            )
            .map((app) => app.id)
    );
    return installs
        .filter((install) => off.has(install.applicationId))
        .map((install) => install.name);
}

// ---------------------------------------------------------------------------
// Starting a parked service
// ---------------------------------------------------------------------------

/**
 * Bring a `park` service's data home and start it there, instead of starting it
 * from the NAS. True when that is now under way and the caller's own start must
 * not run; false to start as always - nothing to bring home, or it could not be
 * brought (then the service starts from the NAS, slower, rather than not at all).
 */
export async function bringHomeBeforeStart(
    applicationId: string,
    actorId: string | null
): Promise<boolean> {
    const [app] = await factsOf({ id: { in: [applicationId] } });
    if (!app) return false;
    const [policy, owned] = await Promise.all([readPolicy(), ownedConnections(app.ownerId)]);
    const choice = placement.effectiveChoice(
        app.own,
        policy,
        app.game,
        app.createdAt,
        owned.map((connection) => connection.id)
    );
    const volumeId = placement.homecoming(choice, app.volumes);
    if (!volumeId) return false;
    const running = await prisma.storageMove.findFirst({
        where: { applicationId, state: { in: [...plan.BLOCKING_STATES] } },
        select: { id: true, auto: true, state: true }
    });
    if (running) {
        // Still on its way to the NAS: let it finish and start the service where
        // it lands. The next stop takes it nowhere, and the next start brings it
        // home - better than a start that waits for two copies in a row.
        if (!running.auto || !plan.WORKING_STATES.includes(running.state as plan.MoveState))
            return false;
        await prisma.storageMove.update({
            where: { id: running.id },
            data: { wasRunning: true }
        });
        return true;
    }
    const result = await startMove({
        volumeId,
        destination: "server",
        actorId,
        serverLabel: THIS_SERVER,
        auto: true,
        startAfter: true
    });
    if ("refused" in result) return false;
    await prisma.application.update({
        where: { id: applicationId },
        data: { parkPendingSince: null }
    });
    return true;
}

// ---------------------------------------------------------------------------
// The service's own screen
// ---------------------------------------------------------------------------

export interface AppStorageMove {
    readonly state: plan.MoveState;
    readonly auto: boolean;
    readonly originLabel: string;
    readonly targetLabel: string;
    readonly percent: number | null;
    readonly copiedBytes: number | null;
    readonly totalBytes: number | null;
    readonly error: MoveError | null;
    readonly finishedAt: string | null;
}

export interface AppStorageView {
    /** Where each volume is now: null for this server, else the NAS's name. */
    readonly places: (string | null)[];
    /** The mode that applies, the instance's when it decides for game servers. */
    readonly choice: placement.StorageChoice | null;
    /** The instance decides for game servers; the owner sees, not chooses. */
    readonly locked: boolean;
    /** The instance's default applies to it, on a NAS its owner does not have,
     *  so it stays where it is. */
    readonly outOfReach: boolean;
    /** The NAS locations this service may be kept on. */
    readonly connections: { id: string; name: string }[];
    readonly parkable: boolean;
    /** Why nothing can be chosen yet, if so. */
    readonly blocked: "notDeployed" | "swarm" | "noVolumes" | null;
    readonly running: boolean;
    /** The latest move of its data, if any. */
    readonly move: AppStorageMove | null;
    /** How much there is, from the last copy that measured it. */
    readonly sizeBytes: number | null;
}

function errorOf(json: string | null): MoveError | null {
    if (!json) return null;
    try {
        return JSON.parse(json) as MoveError;
    } catch {
        return { code: "unexpected" };
    }
}

export async function appStorageView(applicationId: string): Promise<AppStorageView | null> {
    const [app] = await factsOf({ id: { in: [applicationId] } });
    if (!app) return null;
    const [policy, owned, latest, measured] = await Promise.all([
        readPolicy(),
        ownedConnections(app.ownerId),
        prisma.storageMove.findFirst({
            where: { applicationId },
            orderBy: { createdAt: "desc" },
            select: {
                state: true,
                auto: true,
                originLabel: true,
                targetLabel: true,
                copiedBytes: true,
                totalBytes: true,
                error: true,
                finishedAt: true
            }
        }),
        prisma.storageMove.findFirst({
            where: { applicationId, totalBytes: { not: null } },
            orderBy: { createdAt: "desc" },
            select: { totalBytes: true }
        })
    ]);
    const names = new Map(owned.map((connection) => [connection.id, connection.name]));
    const offered = new Set(placement.offeredConnections([...names.keys()], policy, app.game));
    const choice = placement.effectiveChoice(app.own, policy, app.game, app.createdAt, [
        ...names.keys()
    ]);
    let move: AppStorageMove | null = null;
    if (latest) {
        const state = plan.isMoveState(latest.state) ? latest.state : "failed";
        const copied = latest.copiedBytes === null ? null : Number(latest.copiedBytes);
        const total = latest.totalBytes === null ? null : Number(latest.totalBytes);
        move = {
            state,
            auto: latest.auto,
            originLabel: latest.originLabel,
            targetLabel: latest.targetLabel,
            percent: state === "copying" ? plan.progressPercent(copied, total) : null,
            copiedBytes: copied,
            totalBytes: total,
            error: errorOf(latest.error),
            finishedAt: latest.finishedAt?.toISOString() ?? null
        };
    }
    return {
        places: app.volumes.map((volume) =>
            volume.location.kind === "server"
                ? null
                : (names.get(volume.location.connectionId) ?? volume.location.connectionId)
        ),
        choice,
        locked: app.game && !policy.ownersChoose,
        outOfReach: placement.defaultOutOfReach(app.own, policy, app.game, app.createdAt, [
            ...names.keys()
        ]),
        connections: owned.filter((connection) => offered.has(connection.id)),
        parkable: placement.parkable(app.volumes.length),
        blocked: !app.deployed
            ? "notDeployed"
            : app.swarm
              ? "swarm"
              : app.volumes.length === 0
                ? "noVolumes"
                : null,
        running: app.desiredState === "running",
        move,
        sizeBytes: measured && measured.totalBytes !== null ? Number(measured.totalBytes) : null
    };
}

export type ChooseRefusal = StartRefusal | "locked" | "notParkable" | "noVolumes";

/**
 * Set a service's mode and start what can start now. A stopped service is taken
 * to its place at once; a running one is moved now only for `server` and `nas`,
 * which is what the person asked for (the move stops it, copies, and starts it
 * again); a running `park` service is already where it runs and is taken to the
 * NAS once it is stopped.
 */
export async function chooseAppStorage(input: {
    applicationId: string;
    choice: placement.StorageChoice;
    actorId: string;
    serverLabel: string;
}): Promise<{ moving: boolean } | { refused: ChooseRefusal }> {
    const [app] = await factsOf({ id: { in: [input.applicationId] } });
    if (!app) return { refused: "missing" };
    const policy = await readPolicy();
    if (app.game && !policy.ownersChoose) return { refused: "locked" };
    if (app.volumes.length === 0) return { refused: "noVolumes" };
    if (input.choice.mode === "park" && !placement.parkable(app.volumes.length))
        return { refused: "notParkable" };
    if (input.choice.connectionId) {
        const owned = (await ownedConnections(app.ownerId)).map((connection) => connection.id);
        if (
            !placement
                .offeredConnections(owned, policy, app.game)
                .includes(input.choice.connectionId)
        )
            return { refused: "notOffered" };
    }
    await prisma.application.update({
        where: { id: app.id },
        data: {
            storageMode: input.choice.mode,
            storageConnectionId: input.choice.connectionId,
            parkPendingSince: null
        }
    });
    const stopped = app.desiredState === "stopped" && !app.asleep;
    if (input.choice.mode === "park" && !stopped) return { moving: false };
    const target = placement.restingLocation(input.choice);
    const away = app.volumes.find((volume) => !plan.sameLocation(volume.location, target));
    if (!away) return { moving: false };
    const result = await startMove({
        volumeId: away.id,
        destination: destinationOf(target),
        actorId: input.actorId,
        serverLabel: input.serverLabel,
        auto: true
    });
    if ("refused" in result) {
        // The mode stands - the sweep follows it later - but a move that could not
        // start now is said, not swallowed. Busy means one is already on its way.
        return result.refused === "busy" ? { moving: true } : { refused: result.refused };
    }
    return { moving: true };
}

/**
 * Keep a service's mode true to a move somebody started by hand from the storage
 * page: a service set to a mode would otherwise be taken back the next time it
 * stops. Only a service that has a mode is touched; one nobody chose for stays so.
 */
export async function followManualMove(applicationId: string, destination: string): Promise<void> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { storageMode: true }
    });
    if (!app?.storageMode) return;
    await prisma.application.update({
        where: { id: applicationId },
        data:
            destination === "server"
                ? { storageMode: "server", storageConnectionId: null, parkPendingSince: null }
                : { storageMode: "nas", storageConnectionId: destination, parkPendingSince: null }
    });
}

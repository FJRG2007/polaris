"use server";

/**
 * What the Game servers app does. Creating a server is the one action with any
 * weight to it, and it is deliberately the only place that decides what a server
 * is made of - the dialog asks, this authorizes and records, and games-create
 * turns the answers into an install.
 */

import { type GameId, GAMES } from "@polaris/core";
import { gameWords, issueText, messageText } from "./game-words";
import { z } from "zod";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { clearResourceGrants } from "@polaris/auth";
import { findMap } from "../lib/minecraft/maps";
import { prepareMap, type MapDownload } from "../lib/minecraft/map-store";
import { flushGameWorld } from "../lib/games-flush";
import { setServerRunning } from "../lib/games-operations";
import { gameDomainSuffix } from "../lib/minecraft/address";
import { clearQueue } from "../lib/minecraft/queue-service";
import { clearSnapshots } from "../lib/minecraft/inventory-service";
import { releaseVersions } from "../lib/minecraft/blueprint-version";
import { blueprintVersions, createGameServer, expectedMinecraftHeapMb } from "../lib/games-create";
import { listGameMachines, listGameServerFacts, type GameMachine } from "../lib/games-service";
import { clearGameServerPrefs, setGameServerPref } from "../lib/games-prefs";
import { clearLogins } from "../lib/minecraft/polaris-login-service";
import { clearSounds } from "../lib/minecraft/sounds-service";
import { clearAnticheatFlags } from "../lib/minecraft/polaris-anticheat-service";
import { clearSanctions } from "../lib/sanctions-service";
import { prisma } from "@polaris/db";
import { gameServerCatalogIds } from "../lib/game-catalog";
import { isTemplateName, type ServerTemplateView } from "../lib/game-templates";
import { adoptGameServersApp, installGameServersApp } from "../lib/game-install";
import * as duplicatePlan from "../lib/duplicate-plan";
import * as duplicateService from "../lib/duplicate-service";
import { refuseWhileCopying } from "../lib/duplicate-busy";
import { createGameServerSchema, type CreateGameServerInput } from "../lib/games-schema";
import { GAME_BLUEPRINTS, formatMemory } from "../lib/minecraft/blueprints";
import {
    deleteServerTemplate,
    listServerTemplates,
    readServerTemplate,
    saveServerAsTemplate
} from "../lib/game-templates-service";
import { host } from "@polaris/app-host";

const { clientIp } = host.requestContext;
const { requirePermission, userHasManage } = host.session;
const { recordAudit } = host.auditService;
const { uninstallApp } = host.appsInstallService;
const { deployApplication } = host.deployService;
const { installRef, requireGameServer, requireGameServerOwner } = host.appsInstallAccess;
const { measureInstallData } = host.appsInstallDuplicate;

export interface GameSetup {
    /** Machines a server can run on, with what each has left. */
    readonly machines: GameMachine[];
    /** What a server's name ends in, per game (".mc.example.com"), so the dialog
     *  can show the address before anything exists. Null with no domain. */
    readonly domainSuffixes: Readonly<Record<GameId, string | null>>;
    /** The games this Polaris can create a server of right now - the ones whose
     *  manager is installed. The rest are a trip to the marketplace, not a choice
     *  the dialog can offer and then fail. */
    readonly games: readonly GameId[];
    /** The address this operator is on right now, offered as the one their own
     *  player is registered to - it is where they would connect from too. */
    readonly yourAddress: string | null;
}

/**
 * Everything the create dialog needs that only the server knows, as fast as the
 * server can say it.
 *
 * The machine list comes back unmeasured on purpose. Measuring what each one has
 * free costs an SSH session per connected machine, and an unreachable machine
 * costs the full probe timeout - which the dialog used to spend with its game
 * picker and its machine list both behind skeletons, for a figure that is a
 * footnote under one of them. The names are what the choice is made from and
 * they are a database read away; the figures follow from gameMachinesAction.
 */
export async function gameSetupAction(): Promise<GameSetup> {
    const user = await requirePermission("games.manage");
    const [machines, suffixes, games, yourAddress] = await Promise.all([
        listGameMachines(user.id, false),
        Promise.all(GAMES.map((game) => gameDomainSuffix(game.domainLabel).catch(() => null))),
        installedGameIds(user.id),
        clientIp()
    ]);
    return {
        machines,
        domainSuffixes: Object.fromEntries(
            GAMES.map((game, index) => [game.id, suffixes[index] ?? null])
        ) as Record<GameId, string | null>,
        games,
        yourAddress: yourAddress ?? null
    };
}

/**
 * What each machine actually has free, measured.
 *
 * The half of the setup above that costs a round trip to every connected
 * machine, asked for on its own so it can arrive late without holding anything
 * up. A machine that cannot be reached simply reports nothing, exactly as it did
 * before, and the dialog goes on offering it - refusing to let somebody pick a
 * machine because Polaris could not measure it would be a worse answer than a
 * missing figure.
 */
export async function gameMachinesAction(): Promise<GameMachine[]> {
    const user = await requirePermission("games.manage");
    return listGameMachines(user.id, true);
}

/**
 * The games this person may create a server of right now.
 *
 * Every game Polaris knows, once game servers are on for them - there is one app
 * for all of them, and a game's runtime is installed with its first server rather
 * than in advance. An owner who has never turned it on gets nothing, so the dialog
 * cannot offer a create the action behind it would refuse.
 */
async function installedGameIds(ownerId: string): Promise<GameId[]> {
    const installedAppId = await adoptGameServersApp(ownerId);
    return installedAppId === null ? [] : GAMES.map((game) => game.id);
}

const expectedMemorySchema = z.object({
    edition: z.enum(["java", "bedrock"]),
    blueprintId: z.string().trim().min(1).max(64),
    software: z.string().trim().min(1).max(32).optional(),
    // The modpack or the jar, which changes the figure: a modpack server is
    // priced as a mod loader whatever the blueprint is.
    softwareSource: z.string().trim().min(1).max(500).optional(),
    mapId: z.string().trim().min(1).max(64).optional(),
    crossplay: z.boolean(),
    concurrentPlayers: z.number().int().min(1).max(1000),
    serverId: z.string().trim().min(1).max(64).optional(),
    installedAppId: z.string().uuid().optional()
});

/** What memory a server of this shape would be given, so the create and reset
 *  dialogs can say it before anything is written. Null for an edition that runs no
 *  JVM, or a shape that cannot be read. */
export async function expectedMemoryAction(
    input: z.input<typeof expectedMemorySchema>
): Promise<string | null> {
    const parsed = expectedMemorySchema.safeParse(input);
    if (!parsed.success) return null;
    try {
        const ownerId = parsed.data.installedAppId
            ? (await requireGameServer("games.read", parsed.data.installedAppId)).access.ownerId
            : (await requirePermission("games.read")).id;
        const heapMb = await expectedMinecraftHeapMb(ownerId, parsed.data);
        return heapMb === null ? null : formatMemory(heapMb);
    } catch {
        return null;
    }
}

/** The releases a blueprint can be built on, and the newest of them. */
export interface BlueprintVersions {
    /** Newest first. Empty means nothing constrains the choice - a blueprint that
     *  installs nothing, or a Modrinth that could not be reached. */
    readonly versions: readonly string[];
    /** The newest of them, which is what LATEST resolves to. */
    readonly latest: string | null;
    /** Whether it is the blueprint's own plugins that limit the list, rather than
     *  it simply being every release Minecraft has. */
    readonly pinned: boolean;
}

/**
 * The Minecraft releases a blueprint's plugins can run on, for the dialog to
 * offer before anything is created.
 *
 * Worth showing rather than deciding quietly: a blueprint pinning an older
 * release is a real consequence - the clients that join have to match it - and
 * finding out afterwards, from the version field on a server that is already
 * built, is how somebody ends up deleting it and trying again. The whole list is
 * sent because the field is a picker: the operator's players may be on a release
 * that is not the newest one, and every entry here is one the game will actually
 * be installed on.
 */
export async function blueprintVersionsAction(
    blueprintId: string,
    crossplay = false,
    /** The map it is being built on, whose own plugin list - usually none at all -
     *  replaces the blueprint's and so decides this list with it. Without this the
     *  field offered the releases a plugin the server will not be installing has a
     *  build for, which is a shorter list than the one it will actually run on. */
    mapId?: string
): Promise<BlueprintVersions> {
    await requirePermission("games.read");
    const blueprint = GAME_BLUEPRINTS.find((entry) => entry.id === blueprintId);
    if (!blueprint) return { versions: [], latest: null, pinned: false };
    const map = findMap(mapId);
    const versions = await blueprintVersions(blueprint, crossplay, undefined, map).catch(() => []);
    // A blueprint that constrains nothing still needs a list to pick from, so it
    // gets Minecraft's own releases.
    const offered = versions.length > 0 ? versions : await releaseVersions().catch(() => []);
    return { versions: offered, latest: offered[0] ?? null, pinned: versions.length > 0 };
}

/** Minecraft's releases, newest first, for the version field of a server that
 *  already exists. Empty when they could not be read, which the field answers
 *  by letting the release be typed instead. */
export async function minecraftReleasesAction(): Promise<string[]> {
    await requirePermission("games.read");
    return releaseVersions().catch(() => []);
}

/**
 * Where a map's world stands on this instance, starting its download the first
 * time a server is built on it. The create and reset forms ask this until it is
 * ready, so the server's container finds the world already here.
 *
 * Read permission, because a reset is open to whoever may manage that one
 * server: what it can do is fetch one of the few archives the catalog names.
 */
export async function prepareMapAction(mapId: string): Promise<MapDownload> {
    await requirePermission("games.read");
    const parsed = z.string().trim().min(1).max(64).safeParse(mapId);
    const map = parsed.success ? findMap(parsed.data) : undefined;
    if (!map) return { state: "failed", reason: "failed" };
    return prepareMap(map);
}

/** Create a server. Returns its installed-app id so the page can open it. */
export async function createGameServerAction(
    input: CreateGameServerInput & { templateId?: string }
): Promise<{ installedAppId?: string; hostname?: string | null; error?: string }> {
    const user = await requirePermission("games.manage");
    const parsed = createGameServerSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                (await gameWords("games"))("errors.checkTheDetailsAndTry")
        };
    try {
        // A saved server's settings, if this one is being built from one. Read here
        // rather than trusted from the form: what the browser sends is which
        // template, never what is in it.
        const template = input.templateId
            ? await readServerTemplate(user.id, input.templateId)
            : null;
        const created = await createGameServer(user.id, user.id, {
            ...parsed.data,
            ...(template ? { templateSettings: template.settings } : {})
        });
        await recordAudit({
            actorId: user.id,
            action: "games.create",
            targetType: "installedApp",
            targetId: created.installedAppId,
            metadata: createMetadata(parsed.data)
        });
        revalidatePath("/apps/games");
        return { installedAppId: created.installedAppId, hostname: created.hostname };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotCreateTheServer")
        };
    }
}

/** What the audit records about a create, in each game's own terms. Its own
 *  function because a conditional expression with a branch per game is a shape
 *  that stops being readable at the third one. */
function createMetadata(input: CreateGameServerInput): Record<string, unknown> {
    switch (input.game) {
        case "ark":
            return { game: "ark", map: input.map, closed: input.exclusiveJoin };
        case "fivem":
            return { game: "fivem", onesync: input.onesync, closed: input.exclusiveJoin };
        case "hytale":
            return { game: "hytale", memory: input.memory };
        case "minecraft":
            return {
                game: "minecraft",
                edition: input.edition,
                blueprint: input.blueprintId,
                map: input.mapId ?? null
            };
    }
}

/** Everything this person has saved, for the create dialog to offer. */
export async function listServerTemplatesAction(
    game?: string
): Promise<{ templates: ServerTemplateView[] }> {
    try {
        const user = await requirePermission("games.read");
        return { templates: await listServerTemplates(user.id, game) };
    } catch {
        return { templates: [] };
    }
}

/** Write down how a server is built, so another can be built the same way. */
export async function saveServerAsTemplateAction(
    installedAppId: string,
    name: string,
    summary: string
): Promise<{ id?: string; error?: string }> {
    if (!isTemplateName(name))
        return { error: (await gameWords("games"))("errors.giveTheTemplateAName") };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const saved = await saveServerAsTemplate(access.ownerId, installedAppId, name, summary);
        if (saved.id) {
            await recordAudit({
                actorId: user.id,
                action: "games.template-save",
                targetType: "installedApp",
                targetId: installedAppId,
                metadata: { name: name.trim() }
            });
            revalidatePath("/apps/games");
        }
        return saved;
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotSaveThisAs")
        };
    }
}

export async function deleteServerTemplateAction(id: string): Promise<{ error?: string }> {
    try {
        const user = await requirePermission("games.manage");
        await deleteServerTemplate(user.id, id);
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotDeleteThatTemplate")
        };
    }
}

/**
 * Keep a server at the top of your own list, or put it away.
 *
 * Only ever about the caller's list: it takes `games.read` because seeing a server
 * is the whole qualification for having an opinion about where it sits, and it
 * changes nothing about the server - somebody else's list, and the server itself,
 * are untouched. Nothing is audited for the same reason.
 */
export async function setGameServerPrefAction(
    installedAppId: string,
    patch: { favorite?: boolean; archived?: boolean }
): Promise<{ error?: string }> {
    try {
        const { user } = await requireGameServer("games.read", installedAppId);
        await setGameServerPref(user.id, installedAppId, patch);
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotUpdateYourList")
        };
    }
}

/** Start or stop a server from the list, without opening it. */
export async function setGameServerRunningAction(
    installedAppId: string,
    running: boolean
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        await setServerRunning(user, access, running);
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotChangeTheServer")
        };
    }
}

/** Deploy the server again, for a container that is wedged or out of date. */
export async function redeployGameServerAction(
    installedAppId: string
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        if (!access.install.applicationId)
            throw new Error((await gameWords("games"))("errors.thisServerHasNotBeen"));
        await refuseWhileCopying(installedAppId);
        // A redeploy tears the container down and builds it again, so it costs the
        // same unwritten minutes a stop does - and used to take them silently.
        await flushGameWorld(access.ownerId, installedAppId);
        await deployApplication(access.install.applicationId, access.ownerId, user.id);
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotRedeployTheServer")
        };
    }
}

/**
 * Delete a server: its container, and the install that listed it.
 *
 * Reachable from the list rather than only from the server's own page, because a
 * server that cannot be opened is exactly the one somebody needs to be rid of -
 * a failed create leaves a row whose page has nothing to render.
 */
export async function deleteGameServerAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServerOwner(installedAppId);
        await uninstallApp(access.ownerId, installedAppId);
        // The server is gone, so the access people were given to it is too. An
        // orphan grant reaches nothing, but leaving it would show up on their page
        // as access to a thing that no longer exists.
        await clearResourceGrants(await installRef(installedAppId));
        // And so is everything that only described this server: the bags it was
        // keeping copies of, and the decisions still waiting for players who will
        // never join it again.
        // Including where it sat on somebody's list: a favourite of a server that
        // is gone is a row nothing will ever read again - and the passwords its
        // players set, which nothing can ask about any more.
        await Promise.all([
            clearSnapshots(installedAppId),
            clearQueue(installedAppId),
            clearGameServerPrefs(installedAppId),
            clearLogins(installedAppId),
            clearSounds(installedAppId),
            clearAnticheatFlags(installedAppId),
            clearSanctions(installedAppId)
        ]);
        await recordAudit({
            actorId: user.id,
            action: "games.delete",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotDeleteTheServer")
        };
    }
}

/**
 * Who may duplicate this server, decided by the same rule the screens draw the
 * action from: a copy is a new server (instance-wide `games.manage`) of somebody's
 * world (the owner's or an administrator's). Throws the reason otherwise.
 */
async function requireDuplicate(installedAppId: string) {
    const { user, access } = await requireGameServer("games.manage", installedAppId);
    const allowed = duplicatePlan.duplicatePermission({
        canCreate: await userHasManage(user, "games.manage"),
        isOwner: access.isOwner,
        isAdmin: user.isAdmin
    });
    if (!allowed.allowed)
        throw new Error(
            allowed.reason === "cannot-create"
                ? (await gameWords("games"))("duplicate.cannotCreate")
                : (await gameWords("games"))("duplicate.notOwner")
        );
    return { user, access };
}

export interface DuplicateSetup {
    /** Every name the owner's servers already use, for the dialog to check as
     *  somebody types. */
    readonly takenNames: string[];
    /** What the files take and what the machine has free, or null when the server
     *  is off and cannot be asked - the copy checks again either way. */
    readonly usedBytes: number | null;
    readonly freeBytes: number | null;
    readonly fits: boolean | null;
    /** Whether it is up, which is whether the copy takes it down for a while. */
    readonly running: boolean;
}

/** What the duplicate dialog needs to know before anybody presses anything. */
export async function duplicateSetupAction(
    installedAppId: string
): Promise<{ setup?: DuplicateSetup; error?: string }> {
    try {
        const { access } = await requireDuplicate(installedAppId);
        const [figures, siblings, running] = await Promise.all([
            measureInstallData(access.ownerId, installedAppId),
            listOwnerServerNames(access.ownerId),
            access.install.applicationId
                ? prisma.application
                      .findUnique({
                          where: { id: access.install.applicationId },
                          select: { desiredState: true }
                      })
                      .then((row) => row?.desiredState === "running")
                : Promise.resolve(false)
        ]);
        return {
            setup: {
                takenNames: siblings,
                usedBytes: figures?.usedBytes ?? null,
                freeBytes: figures?.freeBytes ?? null,
                fits: figures?.fits ?? null,
                running
            }
        };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("duplicate.couldNotStart")
        };
    }
}

/** The names of every server the owner has, for the uniqueness check. */
async function listOwnerServerNames(ownerId: string): Promise<string[]> {
    const rows = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, catalogId: { in: gameServerCatalogIds() } },
        select: { name: true },
        take: 1000
    });
    return rows.map((row) => row.name);
}

/**
 * Duplicate a server. Answers as soon as the copy is recorded; the source is
 * stopped, copied and started again after the answer, and the copy's row says
 * how far that has got.
 */
export async function duplicateGameServerAction(
    input: duplicatePlan.DuplicateServerInput
): Promise<{ installedAppId?: string; error?: string }> {
    const parsed = duplicatePlan.duplicateServerSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                (await gameWords("games"))("errors.checkTheDetailsAndTry")
        };
    try {
        const { user, access } = await requireDuplicate(parsed.data.installedAppId);
        const created = await duplicateService.startDuplicate(access.ownerId, user.id, parsed.data);
        after(() => duplicateService.runDuplicate(access.ownerId, user.id, created.installedAppId));
        await recordAudit({
            actorId: user.id,
            action: "games.duplicate.start",
            targetType: "installedApp",
            targetId: created.installedAppId,
            metadata: { from: parsed.data.installedAppId }
        });
        revalidatePath("/apps/games");
        return { installedAppId: created.installedAppId };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("duplicate.couldNotStart")
        };
    }
}

/** Try a copy that failed again, from where its source is now. */
export async function retryDuplicateAction(copyId: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireDuplicate(copyId);
        if (!(await duplicateService.claimRetry(access.ownerId, copyId)))
            throw new Error((await gameWords("games"))("duplicate.nothingToRetry"));
        after(() => duplicateService.runDuplicate(access.ownerId, user.id, copyId));
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("duplicate.couldNotStart")
        };
    }
}

/** Turn game servers on, from the page that needs them. It runs nothing:
 *  installing it is what makes this Polaris able to create servers at all, and
 *  each game's own runtime arrives with the first server of it. */
export async function installGameServersAction(): Promise<{ error?: string }> {
    const user = await requirePermission("games.manage");
    try {
        const installedAppId = await installGameServersApp(user.id, user.id);
        await recordAudit({
            actorId: user.id,
            action: "apps.install",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath("/apps/games");
        revalidatePath("/apps/marketplace");
        revalidatePath("/admin/apps");
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotTurnGameServers")
        };
    }
}

/**
 * The servers an automation step may name: those the signed-in account can
 * start and stop (`games.manage`) or use the console of (`games.console`), as
 * their pages would let it. Asked again on every run, as the run-as account.
 */
export async function automationServersAction(
    permission: unknown
): Promise<{ servers?: { id: string; name: string }[]; error?: string }> {
    const parsed = z.enum(["games.manage", "games.console"]).safeParse(permission);
    if (!parsed.success)
        return { error: (await gameWords("games"))("errors.couldNotChangeTheServer") };
    try {
        const user = await host.session.requireUser();
        const granted = await host.appsInstallAccess.reachableInstallIds(user, parsed.data);
        const servers = await listGameServerFacts(user.id, granted);
        return { servers: servers.map((server) => ({ id: server.id, name: server.name })) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.couldNotChangeTheServer")
        };
    }
}

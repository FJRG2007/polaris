"use server";

/**
 * What the Game servers app does. Creating a server is the one action with any
 * weight to it, and it is deliberately the only place that decides what a server
 * is made of - the dialog asks, this authorizes and records, and games-create
 * turns the answers into an install.
 */

import { revalidatePath } from "next/cache";
import { clientIp } from "@/lib/request-context";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { clearResourceGrants } from "@polaris/auth";
import { findMap } from "@/lib/apps/minecraft/maps";
import { flushGameWorld } from "@/lib/apps/games-flush";
import { clearCrashLoop } from "@/lib/apps/games-health";
import { uninstallApp } from "@/lib/apps/install-service";
import { GAMES, type GameId } from "@/lib/apps/games-catalog";
import { gameDomainSuffix } from "@/lib/apps/minecraft/address";
import { clearQueue } from "@/lib/apps/minecraft/queue-service";
import { clearSnapshots } from "@/lib/apps/minecraft/inventory-service";
import { releaseVersions } from "@/lib/apps/minecraft/blueprint-version";
import { blueprintVersions, createGameServer } from "@/lib/apps/games-create";
import { listGameMachines, type GameMachine } from "@/lib/apps/games-service";
import { deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import { clearGameServerPrefs, setGameServerPref } from "@/lib/apps/games-prefs";
import { isTemplateName, type ServerTemplateView } from "@/lib/apps/game-templates";
import { adoptGameServersApp, installGameServersApp } from "@/lib/apps/game-install";
import { createGameServerSchema, type CreateGameServerInput } from "@/lib/apps/games-schema";
import { installRef, requireGameServer, requireGameServerOwner } from "@/lib/apps/install-access";
import { GAME_BLUEPRINTS, recommendedMemoryMb, formatMemory } from "@/lib/apps/minecraft/blueprints";
import {
    deleteServerTemplate,
    listServerTemplates,
    readServerTemplate,
    saveServerAsTemplate
} from "@/lib/apps/game-templates-service";

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
        domainSuffixes: Object.fromEntries(GAMES.map((game, index) => [game.id, suffixes[index] ?? null])) as Record<
            GameId,
            string | null
        >,
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

/** What memory a server for this many players would be given, so the dialog can
 *  say it before anything is created. */
export async function suggestedMemoryAction(concurrentPlayers: number, blueprintId: string): Promise<string> {
    await requirePermission("games.read");
    const blueprint = GAME_BLUEPRINTS.find((entry) => entry.id === blueprintId);
    return formatMemory(recommendedMemoryMb(concurrentPlayers, blueprint?.weight ?? "normal"));
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

/** Create a server. Returns its installed-app id so the page can open it. */
export async function createGameServerAction(
    input: CreateGameServerInput & { templateId?: string }
): Promise<{ installedAppId?: string; hostname?: string | null; error?: string }> {
    const user = await requirePermission("games.manage");
    const parsed = createGameServerSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // A saved server's settings, if this one is being built from one. Read here
        // rather than trusted from the form: what the browser sends is which
        // template, never what is in it.
        const template = input.templateId ? await readServerTemplate(user.id, input.templateId) : null;
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
        return { error: caught instanceof Error ? caught.message : "Could not create the server" };
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
        default:
            return {
                game: "minecraft",
                edition: input.edition,
                blueprint: input.blueprintId,
                map: input.mapId ?? null
            };
    }
}

/** Everything this person has saved, for the create dialog to offer. */
export async function listServerTemplatesAction(game?: string): Promise<{ templates: ServerTemplateView[] }> {
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
    if (!isTemplateName(name)) return { error: "Give the template a name" };
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
        return { error: caught instanceof Error ? caught.message : "Could not save this as a template" };
    }
}

export async function deleteServerTemplateAction(id: string): Promise<{ error?: string }> {
    try {
        const user = await requirePermission("games.manage");
        await deleteServerTemplate(user.id, id);
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete that template" };
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
        return { error: caught instanceof Error ? caught.message : "Could not update your list" };
    }
}

/** Start or stop a server from the list, without opening it. */
export async function setGameServerRunningAction(
    installedAppId: string,
    running: boolean
): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        if (!access.install.applicationId) throw new Error("This server has not been deployed yet");
        // Written out before it goes down. A stop that does not finish gracefully
        // is killed, and what a kill costs is the last few minutes everyone played.
        if (!running) await flushGameWorld(access.ownerId, installedAppId);
        // Somebody starting it again is somebody saying the last crash is dealt
        // with, or at least worth another try. If it was not, the health sweep
        // writes the loop back within the minute.
        if (running) await clearCrashLoop(installedAppId);
        await setApplicationRunning(access.install.applicationId, access.ownerId, running);
        await recordAudit({
            actorId: user.id,
            action: running ? "games.start" : "games.stop",
            targetType: "installedApp",
            targetId: installedAppId
        });
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the server" };
    }
}

/** Deploy the server again, for a container that is wedged or out of date. */
export async function redeployGameServerAction(installedAppId: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        if (!access.install.applicationId) throw new Error("This server has not been deployed yet");
        // A redeploy tears the container down and builds it again, so it costs the
        // same unwritten minutes a stop does - and used to take them silently.
        await flushGameWorld(access.ownerId, installedAppId);
        await deployApplication(access.install.applicationId, access.ownerId, user.id);
        revalidatePath("/apps/games");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not redeploy the server" };
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
        await clearResourceGrants(installRef(installedAppId));
        // And so is everything that only described this server: the bags it was
        // keeping copies of, and the decisions still waiting for players who will
        // never join it again.
        // Including where it sat on somebody's list: a favourite of a server that
        // is gone is a row nothing will ever read again.
        await Promise.all([
            clearSnapshots(installedAppId),
            clearQueue(installedAppId),
            clearGameServerPrefs(installedAppId)
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
        return { error: caught instanceof Error ? caught.message : "Could not delete the server" };
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
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not turn game servers on" };
    }
}

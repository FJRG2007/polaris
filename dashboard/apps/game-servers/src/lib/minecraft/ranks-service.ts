/**
 * Ranks on a server: kept in the install's own config blob under `ranks`, sent to
 * the game as scoreboard team commands (`ranks.ts`).
 *
 * **What was saved here is the source of truth.** A save is stored before the
 * server is asked, so a server that is off keeps the operator's ranks and gets
 * them when it starts; the commands that undo the last apply (players who lost a
 * rank, teams no longer wanted) are worked out from what that apply recorded, so
 * a team Polaris did not create is never removed unless the operator adopted it
 * on import and was shown that saving replaces it.
 *
 * Applied again when the server comes up (the activity sweep sees it) and for
 * each ranked player the moment they are seen arriving. Teams persist in the
 * world, so both are belt and braces: the commands are idempotent and a server
 * that already has everything only answers "nothing changed".
 */

import { readNbt } from "./nbt";
import * as world from "./world";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { gameOfServer } from "@polaris/core";
import { gameMessage } from "../game-message";
import { readContainerBytes } from "../container-files";
import { editionOf, withServerContainer, type ServerContainer } from "./service";
import * as ranksLib from "./ranks";
import type { Rank, RanksState } from "./ranks";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { listEnvVars } = host.envVarService;

/** How long `save-all` is given to write the scoreboard before it is read. */
const SAVE_WAIT_MS = 1_500;

/** What an apply did. `applied` is false when the server could not be told -
 *  the ranks are saved and wait for it to start. */
export interface RankApply {
    readonly applied: boolean;
    readonly sent: number;
    readonly refused: number;
}

interface RankInstall {
    readonly ownerId: string;
    readonly catalogId: string;
    readonly config: Record<string, unknown>;
}

async function installOf(installedAppId: string): Promise<RankInstall | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { ownerId: true, catalogId: true, config: true, status: true }
    });
    if (!row || row.status === "removed") return null;
    return {
        ownerId: row.ownerId,
        catalogId: row.catalogId,
        config: readInstallConfig(row.config)
    };
}

/** Whether ranks can reach this server: Minecraft, and Java - Bedrock has no teams. */
function isJavaMinecraft(catalogId: string): boolean {
    return gameOfServer(catalogId)?.id === "minecraft" && editionOf(catalogId) === "java";
}

/** Refuse a server ranks cannot reach. */
function assertJava(catalogId: string): void {
    if (gameOfServer(catalogId)?.id !== "minecraft")
        throw new Error(gameMessage("games", "lib.serverNotFound"));
    if (editionOf(catalogId) !== "java") throw new Error(gameMessage("minecraft", "ranks.bedrock"));
}

/** The saved ranks of a server. */
export async function readServerRanks(installedAppId: string): Promise<RanksState> {
    const install = await installOf(installedAppId);
    if (!install) throw new Error(gameMessage("games", "lib.serverNotFound"));
    return ranksLib.readRanks(install.config);
}

/** Send lines and count the ones the game refused. */
async function send(server: ServerContainer, lines: readonly string[]): Promise<number> {
    if (lines.length === 0) return 0;
    const answers = server.sayEach
        ? await server.sayEach(lines.map((line) => [line]))
        : await Promise.all(lines.map((line) => server.say([line]).catch(() => null)));
    return answers.filter((answer) => answer !== null && ranksLib.refusedAnswer(answer)).length;
}

/** Make the server match the saved ranks, and record what was sent. */
export async function applyRanks(ownerId: string, installedAppId: string): Promise<RankApply> {
    const install = await installOf(installedAppId);
    if (!install) throw new Error(gameMessage("games", "lib.serverNotFound"));
    assertJava(install.catalogId);
    const state = ranksLib.readRanks(install.config);
    const lines = ranksLib.rankCommands(state.ranks, state.applied);
    if (lines.length === 0) return { applied: true, sent: 0, refused: 0 };
    let refused: number;
    try {
        const outcome = await withServerContainer(ownerId, installedAppId, async (server) =>
            server.running ? send(server, lines) : null
        );
        if (outcome === null) return { applied: false, sent: 0, refused: 0 };
        refused = outcome;
    } catch {
        // Off, starting, or not answering: the ranks wait for the next start.
        return { applied: false, sent: 0, refused: 0 };
    }
    const next: RanksState = {
        ranks: ranksLib.withoutSources(state.ranks),
        applied: ranksLib.appliedBy(state.ranks)
    };
    await patchInstallConfig(installedAppId, { [ranksLib.RANKS_KEY]: next });
    return { applied: true, sent: lines.length, refused };
}

/** Store the ranks, then apply them. Stored first so a server that is off, or
 *  drops the connection, still gets them on its next start. */
export async function saveRanks(
    ownerId: string,
    installedAppId: string,
    ranks: readonly Rank[]
): Promise<RankApply> {
    const install = await installOf(installedAppId);
    if (!install) throw new Error(gameMessage("games", "lib.serverNotFound"));
    assertJava(install.catalogId);
    const current = ranksLib.readRanks(install.config);
    await patchInstallConfig(installedAppId, {
        [ranksLib.RANKS_KEY]: { ranks: [...ranks], applied: current.applied }
    });
    return applyRanks(ownerId, installedAppId);
}

/** The level the server plays, from its own settings. */
async function levelOf(ownerId: string, applicationId: string): Promise<string> {
    const vars = await listEnvVars("application", applicationId, ownerId).catch(() => []);
    const level = vars.find((item) => item.key === world.levelEnvKey("java"))?.value?.trim() ?? "";
    return world.isLevelName(level) ? level : world.defaultLevel("java");
}

/**
 * The server's own teams, as ranks to edit - nothing is changed by reading them.
 * The world is saved first, so a team made a minute ago by a command is in the
 * file; a server that is off is read as it last saved.
 */
export async function importServerTeams(
    ownerId: string,
    installedAppId: string,
    applicationId: string
): Promise<Rank[]> {
    const install = await installOf(installedAppId);
    if (!install) throw new Error(gameMessage("games", "lib.serverNotFound"));
    assertJava(install.catalogId);
    const level = await levelOf(ownerId, applicationId);
    const path = `${world.levelParent("java")}/${level}/data/scoreboard.dat`;
    try {
        const file = await withServerContainer(ownerId, installedAppId, async (server) => {
            if (server.running) {
                await server.say(["save-all"]).catch(() => "");
                await new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MS));
            }
            return readContainerBytes(server, path).catch(() => null);
        });
        // No file is a world nobody has made a team in yet.
        if (!file || file.length === 0) return [];
        return ranksLib.ranksFromTeams(
            ranksLib.teamsFromScoreboard(readNbt(file)),
            ranksLib.readRanks(install.config).ranks
        );
    } catch {
        throw new Error(gameMessage("minecraft", "ranks.importFailed"));
    }
}

/** A server has just come up: its ranks again, best effort. */
export async function applyRanksOnStart(installedAppId: string): Promise<RankApply | null> {
    try {
        const install = await installOf(installedAppId);
        if (!install || !isJavaMinecraft(install.catalogId)) return null;
        if (ranksLib.readRanks(install.config).ranks.length === 0) return null;
        return await applyRanks(install.ownerId, installedAppId);
    } catch (error) {
        console.warn("polaris: ranks were not applied on start", installedAppId, String(error));
        return null;
    }
}

/** Players just seen arriving: each ranked one joins their rank's team. Best
 *  effort - a join must never fail because of a rank. */
export async function applyRanksOnJoin(
    installedAppId: string,
    players: readonly string[]
): Promise<number> {
    try {
        const install = await installOf(installedAppId);
        if (!install || !isJavaMinecraft(install.catalogId)) return 0;
        const lines = ranksLib.joinCommands(ranksLib.readRanks(install.config).ranks, players);
        if (lines.length === 0) return 0;
        await withServerContainer(install.ownerId, installedAppId, (server) =>
            server.sayAll(lines)
        );
        return lines.length;
    } catch (error) {
        console.warn("polaris: ranks were not applied on join", installedAppId, String(error));
        return 0;
    }
}

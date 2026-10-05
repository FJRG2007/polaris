/**
 * Starting, stopping and restarting a game server, and a line typed into its
 * console: the work and its record, once.
 *
 * Shared by the server screens' actions and the assistant tools, so a server
 * an assistant stops is flushed, stopped and written down exactly as one
 * stopped from its page - never by a second copy that forgot the flush. The
 * caller has already settled who is asking and their standing on the server
 * (`requireGameServer` on a screen, `gameServerAccess` for a tool); `ownerId`
 * is whose shelf the work runs on, `user.id` who did it.
 *
 * Server-only.
 */

import { gameOfServer } from "@polaris/core";
import { host } from "@polaris/app-host";
import { gameMessage } from "./game-message";
import { flushGameWorld } from "./games-flush";
import { clearCrashLoop } from "./games-health";
import { runArkCommand } from "./ark/service";
import { runFivemCommand } from "./fivem/service";
import { runRestartNow } from "./games-restart-service";
import { runConsoleLine } from "./minecraft/service";

/** Who is acting, as far as the record needs. */
interface Actor {
    readonly id: string;
}

/** The standing on one server that the work needs. */
interface ServerStanding {
    readonly ownerId: string;
    readonly install: {
        readonly id: string;
        readonly catalogId: string;
        readonly applicationId: string | null;
    };
}

/** Bring a server up or take it down. */
export async function setServerRunning(
    user: Actor,
    access: ServerStanding,
    running: boolean
): Promise<void> {
    const applicationId = access.install.applicationId;
    if (!applicationId) throw new Error(gameMessage("games", "errors.thisServerHasNotBeen"));
    // Written out before it goes down. A stop that does not finish gracefully
    // is killed, and what a kill costs is the last few minutes everyone played.
    if (!running) await flushGameWorld(access.ownerId, access.install.id);
    // Somebody starting it again is somebody saying the last crash is dealt
    // with, or at least worth another try. If it was not, the health sweep
    // writes the loop back within the minute.
    if (running) await clearCrashLoop(access.install.id);
    await host.deployService.setApplicationRunning(applicationId, access.ownerId, running, user.id);
    await host.auditService.recordAudit({
        actorId: user.id,
        action: running ? "games.start" : "games.stop",
        targetType: "installedApp",
        targetId: access.install.id
    });
}

/** Save the world and restart the server now. */
export async function restartServerNow(user: Actor, access: ServerStanding): Promise<void> {
    await runRestartNow(access.ownerId, access.install.id, user.id);
    await host.auditService.recordAudit({
        actorId: user.id,
        action: "games.restart.now",
        targetType: "installedApp",
        targetId: access.install.id
    });
}

/** Run one console line on a server, in its game's own language, and answer
 *  what the server said. The caller has checked the line's shape. */
export async function runConsoleCommand(
    user: Actor,
    access: ServerStanding,
    line: string
): Promise<string> {
    const installedAppId = access.install.id;
    // Recorded before it runs, and recorded whatever it does.
    //
    // Every other thing this screen can do to a server leaves a line in the
    // audit - who opped whom, who banned whom, who changed the world. The
    // console is how you do all of those without going through any of them,
    // and it was the one action that left nothing at all. A server where the
    // deliberate route is written down and the general-purpose one is not is a
    // server with no record of anything that mattered.
    await host.auditService.recordAudit({
        actorId: user.id,
        action: "games.console",
        targetType: "installedApp",
        targetId: installedAppId,
        metadata: { line }
    });
    // One console, a language per game underneath. Which one is decided here
    // rather than by the screen: the panel that renders the console is the
    // same one.
    const game = gameOfServer(access.install.catalogId)?.id;
    const typed = line.replace(/^\//, "");
    const output =
        game === "ark"
            ? await runArkCommand(access.ownerId, installedAppId, typed)
            : game === "fivem"
              ? await runFivemCommand(access.ownerId, installedAppId, typed)
              : await runConsoleLine(access.ownerId, installedAppId, line);
    return output.trim();
}

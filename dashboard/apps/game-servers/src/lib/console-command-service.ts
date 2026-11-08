/**
 * Where a server's kept console commands are stored.
 *
 * On the install's own settings blob, beside everything else that is a fact about
 * that server rather than about a deployment: they survive a redeploy, a machine
 * move and a browser, and everybody who may use the console sees the same list.
 *
 * Thin on purpose - the rules about what a command may be live in
 * `console-commands`, which the dialog validates against too.
 */

import { prisma } from "@polaris/db";
import {
    SAVED_COMMANDS_KEY,
    blanksAsVariablesIn,
    readSavedCommands,
    withSavedCommand,
    withoutSavedCommand,
    type SavedCommand
} from "./console-commands";
import { host } from "@polaris/app-host";
import { gameOfServer } from "@polaris/core";
import { gameMessage } from "./game-message";
import {
    CONSOLE_SCHEDULES_KEY,
    MAX_CONSOLE_SCHEDULES,
    isActive,
    readConsoleSchedules,
    type ConsoleSchedule
} from "./console-schedule";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/** The list one server carries. Empty for a server nobody has kept one on.
 *  On a Minecraft server a `<player>` blank is the variable that asks for it. */
export async function readConsoleCommands(installedAppId: string): Promise<SavedCommand[]> {
    return (await readKept(installedAppId)).list;
}

async function readKept(
    installedAppId: string
): Promise<{ list: SavedCommand[]; minecraft: boolean }> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, catalogId: true }
    });
    const list = readSavedCommands(readInstallConfig(row?.config));
    const minecraft = Boolean(row) && gameOfServer(row!.catalogId)?.id === "minecraft";
    return { list: minecraft ? blanksAsVariablesIn(list) : list, minecraft };
}

/** Add one or rewrite the one of that id, and hand back the list as it now is. */
export async function saveConsoleCommand(
    installedAppId: string,
    entry: SavedCommand
): Promise<SavedCommand[]> {
    const kept = await readKept(installedAppId);
    // Read the way the rest of the list is, so the button it comes back as asks
    // for its blanks without waiting for the next reload.
    const list = withSavedCommand(
        kept.list,
        kept.minecraft ? blanksAsVariablesIn([entry])[0]! : entry
    );
    await patchInstallConfig(installedAppId, { [SAVED_COMMANDS_KEY]: list });
    return list;
}

/** Forget one, and the schedules made from it with it: a schedule nobody can see
 *  the button for is a command nobody remembers is still running. */
export async function deleteConsoleCommand(
    installedAppId: string,
    id: string
): Promise<SavedCommand[]> {
    const list = withoutSavedCommand(await readConsoleCommands(installedAppId), id);
    const schedules = (await readConsoleSchedulesOf(installedAppId)).filter(
        (schedule) => schedule.commandId !== id
    );
    await patchInstallConfig(installedAppId, {
        [SAVED_COMMANDS_KEY]: list,
        [CONSOLE_SCHEDULES_KEY]: schedules
    });
    return list;
}

/** The scheduled runs one server carries, finished ones included until they are
 *  cleared, so a run that was skipped stays on screen to say so. */
export async function readConsoleSchedulesOf(installedAppId: string): Promise<ConsoleSchedule[]> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    return readConsoleSchedules(readInstallConfig(row?.config));
}

export async function addConsoleSchedule(
    installedAppId: string,
    schedule: ConsoleSchedule
): Promise<ConsoleSchedule[]> {
    // A finished one makes room for a new one rather than refusing it.
    let list = await readConsoleSchedulesOf(installedAppId);
    if (list.length >= MAX_CONSOLE_SCHEDULES) list = list.filter(isActive);
    if (list.length >= MAX_CONSOLE_SCHEDULES) {
        throw new Error(
            gameMessage("games", "consoleSchedule.errors.tooMany", { count: MAX_CONSOLE_SCHEDULES })
        );
    }
    const next = [...list, schedule];
    await patchInstallConfig(installedAppId, { [CONSOLE_SCHEDULES_KEY]: next });
    return next;
}

/** Stop one, or clear one that has finished: either way it is gone. */
export async function removeConsoleSchedule(
    installedAppId: string,
    id: string
): Promise<ConsoleSchedule[]> {
    const next = (await readConsoleSchedulesOf(installedAppId)).filter(
        (schedule) => schedule.id !== id
    );
    await patchInstallConfig(installedAppId, { [CONSOLE_SCHEDULES_KEY]: next });
    return next;
}

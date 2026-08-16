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
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import {
    SAVED_COMMANDS_KEY,
    readSavedCommands,
    withSavedCommand,
    withoutSavedCommand,
    type SavedCommand
} from "@/lib/apps/console-commands";

/** The list one server carries. Empty for a server nobody has kept one on. */
export async function readConsoleCommands(installedAppId: string): Promise<SavedCommand[]> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    return readSavedCommands(readInstallConfig(row?.config));
}

/** Add one or rewrite the one of that id, and hand back the list as it now is. */
export async function saveConsoleCommand(
    installedAppId: string,
    entry: SavedCommand
): Promise<SavedCommand[]> {
    const list = withSavedCommand(await readConsoleCommands(installedAppId), entry);
    await patchInstallConfig(installedAppId, { [SAVED_COMMANDS_KEY]: list });
    return list;
}

export async function deleteConsoleCommand(installedAppId: string, id: string): Promise<SavedCommand[]> {
    const list = withoutSavedCommand(await readConsoleCommands(installedAppId), id);
    await patchInstallConfig(installedAppId, { [SAVED_COMMANDS_KEY]: list });
    return list;
}

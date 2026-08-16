"use server";

/**
 * The console's own actions, for every game rather than one.
 *
 * The console is a single screen with two languages underneath it, and what it can
 * do besides send a line - keep a command, drop one - is the same on both. Its own
 * module because it is its own concern, and because the panel that renders it does
 * not know which game it is looking at.
 *
 * Gated on `games.console`, the same grant sending a line needs: a kept command is
 * a button that runs one, so being able to add one is the same power. Writes are
 * recorded, because a list of commands a server is run with is part of how that
 * server was administered.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { recordAudit } from "@/lib/audit-service";
import { requireGameServer } from "@/lib/apps/install-access";
import {
    deleteConsoleCommand,
    readConsoleCommands,
    saveConsoleCommand
} from "@/lib/apps/console-command-service";
import {
    MAX_SAVED_COMMAND,
    MAX_SAVED_LABEL,
    normalizeSavedCommand,
    type SavedCommand
} from "@/lib/apps/console-commands";

const saveSchema = z.object({
    installedAppId: z.string().uuid(),
    /** Absent for a new one; present when an existing one is being rewritten. */
    id: z.string().uuid().optional(),
    label: z.string().trim().max(MAX_SAVED_LABEL).optional(),
    command: z.string().trim().min(1).max(MAX_SAVED_COMMAND)
});

export type SaveConsoleCommandInput = z.infer<typeof saveSchema>;

/** What this server keeps. Empty rather than an error for somebody who may not
 *  see it: the console draws with or without them. */
export async function listConsoleCommandsAction(
    installedAppId: string
): Promise<{ commands: SavedCommand[] }> {
    const parsed = z.string().uuid().safeParse(installedAppId);
    if (!parsed.success) return { commands: [] };
    try {
        await requireGameServer("games.console", parsed.data);
        return { commands: await readConsoleCommands(parsed.data) };
    } catch {
        return { commands: [] };
    }
}

export async function saveConsoleCommandAction(
    input: SaveConsoleCommandInput
): Promise<{ commands?: SavedCommand[]; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the command and try again" };
    const entry = normalizeSavedCommand({
        id: parsed.data.id ?? randomUUID(),
        label: parsed.data.label ?? null,
        command: parsed.data.command
    });
    if (!entry) return { error: "That command cannot be kept" };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        const commands = await saveConsoleCommand(parsed.data.installedAppId, entry);
        await recordAudit({
            actorId: user.id,
            action: "games.console.save",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { label: entry.label, command: entry.command }
        });
        return { commands };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That command could not be kept" };
    }
}

export async function deleteConsoleCommandAction(
    installedAppId: string,
    id: string
): Promise<{ commands?: SavedCommand[]; error?: string }> {
    const parsed = z.object({ installedAppId: z.string().uuid(), id: z.string().min(1).max(64) }).safeParse({
        installedAppId,
        id
    });
    if (!parsed.success) return { error: "That command could not be removed" };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        const commands = await deleteConsoleCommand(parsed.data.installedAppId, parsed.data.id);
        await recordAudit({
            actorId: user.id,
            action: "games.console.forget",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { id: parsed.data.id }
        });
        return { commands };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That command could not be removed" };
    }
}

"use server";

/**
 * A Drive change made while Polaris could not be reached, made now that it
 * answers (`offline-changes`).
 *
 * The same rename, move, bin and new folder the explorer asks for, with one
 * difference: a replay may arrive after the change was already made - the
 * first attempt landed and only its answer was lost - so a change whose result
 * is already there is answered as done instead of refused.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { requireUser } from "@/lib/session";
import { requireDriveDriver } from "@/lib/drive-authz";
import { mkdirAction, moveIntoAction, renameAction, startDriveJobAction } from "./actions";

const path = z.string().max(4096);

const driveChangeSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("rename"), connectionId: z.string().min(1).max(128), from: path, to: path }),
    z.object({ op: z.literal("move"), connectionId: z.string().min(1).max(128), from: path, dest: path }),
    z.object({ op: z.literal("trash"), connectionId: z.string().min(1).max(128), path }),
    z.object({ op: z.literal("mkdir"), connectionId: z.string().min(1).max(128), path, name: z.string().min(1).max(255) })
]);

export type DriveChange = z.infer<typeof driveChangeSchema>;

/** Whether each of these paths is there now; null when the source cannot be asked. */
async function present(connectionId: string, paths: readonly string[]): Promise<boolean[] | null> {
    const user = await requireUser();
    let driver;
    try {
        driver = await requireDriveDriver(user.id, connectionId, paths[0] ?? "", "read");
    } catch {
        return null;
    }
    try {
        return await Promise.all(
            paths.map((one) =>
                driver.stat(core.normalizeRelPath(one)).then(
                    () => true,
                    () => false
                )
            )
        );
    } finally {
        await driver.dispose();
    }
}

export async function replayDriveChangeAction(input: unknown): Promise<{ error?: string }> {
    const parsed = driveChangeSchema.safeParse(input);
    if (!parsed.success) return { error: "" };
    const change = parsed.data;
    switch (change.op) {
        case "rename": {
            const result = await renameAction(change.connectionId, change.from, change.to);
            if (!result.error) return {};
            const [from, to] = (await present(change.connectionId, [change.from, change.to])) ?? [];
            return from === false && to === true ? {} : result;
        }
        case "move": {
            const base = core.baseName(core.normalizeRelPath(change.from));
            const landed = change.dest ? `${change.dest}/${base}` : base;
            // Already moved: the source is gone and its name is in the folder.
            const [from, there] = (await present(change.connectionId, [change.from, landed])) ?? [];
            if (from === false && there === true) return {};
            const result = await moveIntoAction(change.connectionId, change.from, change.dest);
            if (result.conflict) return { error: "" };
            return result.error ? { error: result.error } : {};
        }
        case "trash": {
            const [still] = (await present(change.connectionId, [change.path])) ?? [];
            if (still === false) return {};
            const result = await startDriveJobAction(change.connectionId, "trash", [change.path]);
            return result.error ? { error: result.error } : {};
        }
        case "mkdir": {
            const target = core.normalizeRelPath(change.path ? `${change.path}/${change.name}` : change.name);
            const [exists] = (await present(change.connectionId, [target])) ?? [];
            if (exists === true) return {};
            return mkdirAction(change.connectionId, change.path, change.name);
        }
    }
}

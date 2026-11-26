"use client";

/**
 * Drive changes made while Polaris could not be reached - a rename, a move, a
 * delete to the bin, a new folder - kept on this device in the offline write
 * queue every app shares (`lib/offline/app-writes`), in the order they were
 * made, and made when Polaris answers (`replayDriveChangeAction`).
 *
 * Until then the folder is drawn as it will be (`withDriveChanges`), and the
 * changes wait in a strip above it with a clock, or with why one was not made
 * and the two things to do about it. Uploads and permanent deletes are not
 * kept: one needs the file's bytes on the host, the other cannot be undone.
 */

import type { DriveEntry } from "./types";
import type { DriveChange } from "./offline-actions";
import { useEffect, useState } from "react";
import { replayDriveChangeAction } from "./offline-actions";
import { undelivered } from "@/lib/offline/try-now";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import { appWrites, registerWriteKind, type AppWrite } from "@/lib/offline/app-writes";

export type { DriveChange };

export const DRIVE_CHANGE = "drive.change";

/** Make one kept change. Exported for the tests. */
export async function deliverDriveChange(entry: Pick<AppWrite, "payload">): Promise<QueueSendResult> {
    try {
        const result = await replayDriveChangeAction(entry.payload);
        return result.error === undefined ? { sent: "" } : { refused: result.error };
    } catch (caught) {
        return undelivered(caught);
    }
}

// Each change is its own step: a rename then a move of the same file are two.
registerWriteKind(DRIVE_CHANGE, deliverDriveChange, { additive: true });

/**
 * Keep a change for when Polaris answers. False when this device keeps nothing.
 * Not tried again here: it was just tried, and the queue tries on its own once
 * Polaris is back - a few changes in a row would otherwise use up the first
 * one's attempts in seconds.
 */
export async function keepDriveChange(change: DriveChange): Promise<boolean> {
    const key = newClientKey();
    return appWrites
        .enqueue({ key, kind: DRIVE_CHANGE, target: change.connectionId, payload: change })
        .catch(() => false);
}

function parentOf(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut < 0 ? "" : path.slice(0, cut);
}

function nameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A folder's listing as it will be once the waiting changes are made: renamed
 * rows renamed, moved and binned rows gone, rows moved in and new folders there.
 * A change that failed is drawn as the server has it. Pure, for the tests.
 */
export function withDriveChanges(
    entries: readonly DriveEntry[],
    connectionId: string,
    folder: string,
    changes: readonly AppWrite[]
): DriveEntry[] {
    let rows = [...entries];
    for (const entry of changes) {
        if (entry.state !== "pending") continue;
        const change = entry.payload as DriveChange;
        if (change.connectionId !== connectionId) continue;
        if (change.op === "rename") {
            const row = rows.find((one) => one.path === change.from);
            rows = rows.filter((one) => one.path !== change.from);
            if (row && parentOf(change.to) === folder) rows.push({ ...row, name: nameOf(change.to), path: change.to });
        } else if (change.op === "move") {
            const row = rows.find((one) => one.path === change.from);
            rows = rows.filter((one) => one.path !== change.from);
            const path = change.dest ? `${change.dest}/${nameOf(change.from)}` : nameOf(change.from);
            if (row && change.dest === folder) rows.push({ ...row, path });
        } else if (change.op === "trash") {
            rows = rows.filter((one) => one.path !== change.path);
        } else if (change.path === folder) {
            const path = folder ? `${folder}/${change.name}` : change.name;
            if (!rows.some((one) => one.path === path)) {
                rows.push({ name: change.name, path, kind: "dir", size: "0", modifiedAt: entry.createdAt, createdAt: entry.createdAt });
            }
        }
    }
    return rows;
}

/** The changes kept for one source, oldest first, kept current. */
export function useDriveChanges(connectionId: string | null): readonly AppWrite[] {
    const [entries, setEntries] = useState<readonly AppWrite[]>([]);
    useEffect(() => {
        if (!connectionId) {
            setEntries([]);
            return;
        }
        let live = true;
        const reload = () =>
            void appWrites.readAll().then(
                (all) =>
                    live &&
                    setEntries(
                        all
                            .filter((entry) => entry.kind === DRIVE_CHANGE && entry.target === connectionId)
                            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                    ),
                () => undefined
            );
        reload();
        const unsubscribe = appWrites.subscribe((event) => {
            if (!event || event.entry.kind === DRIVE_CHANGE) reload();
        });
        return () => {
            live = false;
            unsubscribe();
        };
    }, [connectionId]);
    return entries;
}

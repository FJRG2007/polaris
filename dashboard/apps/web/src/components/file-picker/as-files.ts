"use client";

/**
 * Picks, as files a screen can stage.
 *
 * For the screens that upload when the message is sent rather than when the file
 * is chosen. What comes off a storage or an address is fetched by Polaris and
 * handed over here, so a chosen file behaves exactly like one dragged in from
 * the desktop and nothing downstream has to know the difference.
 */

import type { PickedFile } from "./picked-file";

/** A file left where it is, for a screen that can send where rather than what. */
export interface KeptPick {
    readonly connectionId: string;
    readonly path: string;
    readonly name: string;
    readonly size: number;
}

/**
 * @param keepDrive - Leave the picks that are already on a storage alone, and
 *   hand back where they are instead of their bytes. For a screen that can send
 *   a reference: fetching a file out of Polaris so the browser can upload it
 *   back into Polaris is a round trip of the whole file for nothing, and it is
 *   what makes a big file impossible to share at all.
 */
export async function asFiles(
    picked: readonly PickedFile[],
    keepDrive = false
): Promise<{ files: File[]; kept: KeptPick[]; failed: string[] }> {
    const files: File[] = [];
    const kept: KeptPick[] = [];
    const failed: string[] = [];

    for (const one of picked) {
        if (one.kind === "upload") {
            files.push(one.file);
            continue;
        }
        if (one.kind === "drive" && keepDrive) {
            kept.push({
                connectionId: one.connectionId,
                path: one.path,
                name: one.name,
                size: one.size
            });
            continue;
        }
        const url =
            one.kind === "url"
                ? `/api/attachments/fetch?url=${encodeURIComponent(one.url)}`
                : `/api/attachments/fetch?c=${encodeURIComponent(one.connectionId)}&p=${encodeURIComponent(one.path)}`;
        try {
            const answer = await fetch(url);
            if (!answer.ok) {
                const body = (await answer.json().catch(() => null)) as { error?: string } | null;
                failed.push(body?.error ?? "That file could not be fetched.");
                continue;
            }
            const named = answer.headers.get("x-polaris-filename") ?? "";
            const name = named ? decodeURIComponent(named) : "attachment";
            const bytes = await answer.blob();
            files.push(new File([bytes], name, { type: bytes.type || "application/octet-stream" }));
        } catch {
            failed.push("That file could not be fetched.");
        }
    }
    return { files, kept, failed };
}

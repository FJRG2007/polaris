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

export async function asFiles(picked: readonly PickedFile[]): Promise<{ files: File[]; failed: string[] }> {
    const files: File[] = [];
    const failed: string[] = [];

    for (const one of picked) {
        if (one.kind === "upload") {
            files.push(one.file);
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
    return { files, failed };
}

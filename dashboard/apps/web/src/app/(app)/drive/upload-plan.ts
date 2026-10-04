/**
 * Turning a set of dropped or picked files, and the person's answers about the
 * names already taken, into the uploads to send. Pure, so the rules are tested
 * without a browser.
 */

import { z } from "zod";
import type { UploadItem } from "@/lib/drop-items";
import type { ClashView, ConflictChoice } from "@/lib/drive/conflict-types";

/** What the upload route is told to do with a taken name. */
export type UploadConflict = "fail" | "keepBoth" | "replace";

/** One upload to send. */
export interface PlannedUpload {
    readonly file: File;
    /** Where it goes, relative to the folder it was dropped on. */
    readonly relPath: string;
    readonly conflict: UploadConflict;
}

/** The first segment of a relative path: the item that lands in the folder itself. */
export function topOf(relPath: string): string {
    const slash = relPath.indexOf("/");
    return slash < 0 ? relPath : relPath.slice(0, slash);
}

/**
 * The items an upload puts directly in the folder - each file, and each folder
 * of a folder upload once - which are the names that can clash there.
 */
export function topLevelEntries(
    items: readonly UploadItem[]
): { path: string; kind: "file" | "dir" }[] {
    const seen = new Map<string, "file" | "dir">();
    for (const { relPath } of items) {
        const top = topOf(relPath);
        if (!seen.has(top)) seen.set(top, top === relPath ? "file" : "dir");
    }
    return [...seen].map(([path, kind]) => ({ path, kind }));
}

/** The route's word for a choice; no choice means the name was free when checked. */
export function uploadConflictFor(choice: ConflictChoice | undefined): UploadConflict {
    if (choice === "replace" || choice === "merge") return "replace";
    return choice === "keepBoth" ? "keepBoth" : "fail";
}

/**
 * The uploads to send. `decisions` is keyed by the path the person was asked
 * about: a top-level name, or a file inside a folder being merged. A skipped
 * top-level item takes everything under it along; a folder kept as both goes
 * under the name `renamed` holds for it.
 */
export function planUploads(
    items: readonly UploadItem[],
    decisions: ReadonlyMap<string, ConflictChoice>,
    renamed: ReadonlyMap<string, string>
): PlannedUpload[] {
    const planned: PlannedUpload[] = [];
    for (const { file, relPath } of items) {
        const top = topOf(relPath);
        if (decisions.get(top) === "skip" || decisions.get(relPath) === "skip") continue;
        const newTop = renamed.get(top);
        const path = newTop && top !== relPath ? `${newTop}${relPath.slice(top.length)}` : relPath;
        // A file inside a folder that was merged is asked about by its own
        // path; a folder decision never reaches the files inside it.
        const choice = top === relPath ? decisions.get(top) : decisions.get(relPath);
        planned.push({ file, relPath: path, conflict: uploadConflictFor(choice) });
    }
    return planned;
}

const clashSchema = z.object({
    path: z.string(),
    incomingKind: z.enum(["file", "dir"]),
    existingName: z.string(),
    existingKind: z.enum(["file", "dir"]),
    canReplace: z.boolean(),
    replaceBlocked: z.enum(["permission", "locked", "kind", "merge"]).nullable(),
    recoverable: z.boolean()
});

/** The clash in a 409 from the upload route, or null when the body is not one. */
export function conflictIn(body: string): ClashView | null {
    try {
        const parsed = z
            .object({ error: z.literal("name_conflict"), clash: clashSchema })
            .safeParse(JSON.parse(body));
        return parsed.success ? parsed.data.clash : null;
    } catch {
        return null;
    }
}

/** Split `list` into pieces of at most `size`, for a check that takes a bounded batch. */
export function chunked<T>(list: readonly T[], size: number): T[][] {
    const pieces: T[][] = [];
    for (let index = 0; index < list.length; index += size) {
        pieces.push(list.slice(index, index + size));
    }
    return pieces;
}

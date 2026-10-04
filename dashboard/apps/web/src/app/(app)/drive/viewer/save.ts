/**
 * Write-back and export plumbing shared by every editable viewer. An editor only
 * has to turn its state into bytes; these helpers put those bytes back on the
 * connection (overwriting the file or writing a named copy next to it) or hand
 * them straight to the browser as a download that never touches the server.
 */

import { sendFile } from "@/components/transfers/move-file";
import { z } from "zod";
import { parentPath } from "@polaris/core";
import type { ViewerTarget } from "./types";

/** Characters no supported backend accepts in a file name (SMB is the strictest). */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;

/** True if the value contains a C0 control character, which backends reject. */
function hasControlChar(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) < 0x20) return true;
    }
    return false;
}

/** Why a file name was refused, as a key under `driveViewer.editorActions.problems`. */
export type NameProblem = "nameEmpty" | "nameTooLong" | "nameIllegalChars" | "nameInvalid";

/** Why a save did not happen, as a key under `driveViewer.editorActions.problems`. */
export type SaveProblem = "unavailable" | "denied" | "locked" | "nameTaken" | "failed";

/**
 * A single file name (no path separators), validated the same way on every
 * editor. Each issue's message is a `NameProblem`, translated where it is shown.
 */
export const fileNameSchema = z
    .string()
    .trim()
    .min(1, "nameEmpty" satisfies NameProblem)
    .max(255, "nameTooLong" satisfies NameProblem)
    .refine((name) => !ILLEGAL_NAME_CHARS.test(name), "nameIllegalChars" satisfies NameProblem)
    .refine((name) => !hasControlChar(name), "nameInvalid" satisfies NameProblem)
    .refine((name) => name !== "." && name !== "..", "nameInvalid" satisfies NameProblem);

/** Split a file name into its base and its dot-prefixed extension ("" when none). */
function splitName(name: string): { base: string; extension: string } {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return { base: name, extension: "" };
    return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * Name proposed when saving a copy: " copy" before the extension, matching the
 * suffix the server-side duplicate uses. `extension` (dot-less) overrides the
 * original one when the editor can only write another format.
 */
export function copyNameFor(name: string, extension?: string): string {
    const parts = splitName(name);
    return `${parts.base} copy${extension ? `.${extension}` : parts.extension}`;
}

/** Replace a name's extension, keeping its base ("book.xls" -> "book.xlsx"). */
export function withExtension(name: string, extension: string): string {
    return `${splitName(name).base}.${extension}`;
}

/**
 * Write bytes to `name` in the target's folder. `conflict` is what happens to a
 * file already holding the name: `overwrite` for the file being saved in place,
 * `replace` (old one to the bin) for a copy the person agreed may replace one,
 * and `fail` for a copy under a name they were told is free.
 * Returns why it did not save, or null on success.
 */
export async function saveFileBytes(
    target: ViewerTarget,
    name: string,
    body: Blob,
    conflict: "overwrite" | "replace" | "fail" = "overwrite"
): Promise<SaveProblem | null> {
    if (!target.connectionId) return "unavailable";
    const query = new URLSearchParams({ c: target.connectionId, name, conflict });
    const parent = parentPath(target.path);
    if (parent) query.set("p", parent);
    try {
        // Through the shared sender: a slide deck with video in it is a save
        // somebody watches, and this is the one that reports how far it has got.
        const sent = await sendFile(`/api/drive/upload?${query.toString()}`, body, { name });
        if (sent.ok) return null;
        if (sent.status === 403) return "denied";
        if (sent.status === 423) return "locked";
        if (sent.status === 409) return "nameTaken";
        return "failed";
    } catch {
        return "failed";
    }
}

/**
 * Names already present in the target's folder, lowercased. Used to warn before
 * a copy silently replaces an existing file; an unreachable listing yields an
 * empty set, so the save still goes through.
 */
export async function siblingNames(target: ViewerTarget): Promise<Set<string>> {
    if (!target.connectionId) return new Set();
    const query = new URLSearchParams({ c: target.connectionId });
    const parent = parentPath(target.path);
    if (parent) query.set("p", parent);
    try {
        const response = await fetch(`/api/drive/list?${query.toString()}`);
        if (!response.ok) return new Set();
        const body = (await response.json()) as { entries?: { name?: unknown }[] };
        const names = (body.entries ?? [])
            .map((entry) => entry.name)
            .filter((name): name is string => typeof name === "string");
        return new Set(names.map((name) => name.toLowerCase()));
    } catch {
        return new Set();
    }
}

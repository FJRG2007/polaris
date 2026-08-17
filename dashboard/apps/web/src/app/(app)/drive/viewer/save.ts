/**
 * Write-back and export plumbing shared by every editable viewer. An editor only
 * has to turn its state into bytes; these helpers put those bytes back on the
 * connection (overwriting the file or writing a named copy next to it) or hand
 * them straight to the browser as a download that never touches the server.
 */

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

/** A single file name (no path separators), validated the same way on every editor. */
export const fileNameSchema = z
    .string()
    .trim()
    .min(1, "Enter a file name")
    .max(255, "That name is too long")
    .refine((name) => !ILLEGAL_NAME_CHARS.test(name), 'A name cannot contain \\ / : * ? " < > |')
    .refine((name) => !hasControlChar(name), "That name is not valid")
    .refine((name) => name !== "." && name !== "..", "That name is not valid");

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
 * Write bytes to `name` in the target's folder, overwriting whatever is there.
 * Returns a human-readable error, or null on success.
 */
export async function saveFileBytes(
    target: ViewerTarget,
    name: string,
    body: Blob
): Promise<string | null> {
    if (!target.connectionId) return "This file cannot be saved from here.";
    const query = new URLSearchParams({ c: target.connectionId, name });
    const parent = parentPath(target.path);
    if (parent) query.set("p", parent);
    try {
        const response = await fetch(`/api/drive/upload?${query.toString()}`, {
            method: "PUT",
            body
        });
        if (response.ok) return null;
        if (response.status === 403) return "Could not save - you may not have write access here.";
        if (response.status === 423) return "This file is locked.";
        return "Could not save this file.";
    } catch {
        return "Could not save this file.";
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

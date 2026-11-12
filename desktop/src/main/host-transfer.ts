/**
 * Moving the list of hosts to and from another device: a file, the clipboard,
 * or a code read off a QR. The list carries addresses and names only
 * (`host-list` in core); every sign-in stays with the browser session it
 * belongs to, so a list taken in still asks to sign in on each host.
 */

import type { HostImport } from "@/shared/bridge";
import { readFile, stat, writeFile } from "node:fs/promises";
import { clipboard, dialog, type BrowserWindow } from "electron";
import { SERVERS_MAX, type SavedServer } from "@/shared/servers";
import {
    encodeHostList,
    hostListFile,
    mergeHostLists,
    readHostList
} from "../../../dashboard/packages/core/src/host-list";

/** A list file is a few kilobytes; anything far larger is not one. */
const FILE_MAX = 64 * 1024;

export interface HostStore {
    readonly saved: () => SavedServer[];
    readonly keep: (servers: readonly SavedServer[]) => void;
}

/** The list as a code, put on the clipboard. */
export function copyHosts(store: HostStore): { ok: true; count: number; } {
    const servers = store.saved();
    clipboard.writeText(encodeHostList(servers));
    return { ok: true, count: servers.length };
}

/** The list written to a file somebody picks. False when they cancelled. */
export async function saveHostsFile(store: HostStore, parent: BrowserWindow | null): Promise<HostImport> {
    const options = {
        title: "Export hosts",
        defaultPath: "polaris-hosts.json",
        filters: [{ name: "Polaris hosts", extensions: ["json"] }]
    };
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, error: null };
    try {
        await writeFile(picked.filePath, hostListFile(store.saved()), "utf8");
        return { ok: true, added: 0, named: 0, skipped: 0 };
    } catch {
        return { ok: false, error: "Polaris could not write that file. Pick another folder." };
    }
}

/** Take in a list read from a code, a link or a file's text. */
export function importHosts(store: HostStore, text: string): HostImport {
    const incoming = readHostList(text);
    if (incoming === null) return { ok: false, error: "That is not a list of Polaris hosts." };
    const merged = mergeHostLists(store.saved(), incoming, SERVERS_MAX);
    if (merged.added > 0 || merged.named > 0) store.keep(merged.hosts);
    return { ok: true, added: merged.added, named: merged.named, skipped: merged.skipped };
}

/** Take in a list from a file somebody picks. */
export async function importHostsFile(store: HostStore, parent: BrowserWindow | null): Promise<HostImport> {
    const options = {
        title: "Import hosts",
        properties: ["openFile" as const],
        filters: [{ name: "Polaris hosts", extensions: ["json", "txt"] }]
    };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return { ok: false, error: null };
    try {
        if ((await stat(path)).size > FILE_MAX) return { ok: false, error: "That file is too large to be a list of hosts." };
        return importHosts(store, await readFile(path, "utf8"));
    } catch {
        return { ok: false, error: "Polaris could not read that file." };
    }
}

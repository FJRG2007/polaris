/**
 * The API key used to push from this computer, kept by the operating system.
 *
 * Encrypted with Electron's `safeStorage` - the Keychain on macOS, DPAPI on
 * Windows, the desktop's secret service on Linux - and written to the app's data
 * folder only in that encrypted form. It is never written in plain text: a Linux
 * desktop with no secret service, where `safeStorage` would fall back to a
 * hard-coded key, is told the key cannot be kept, and asked for it again next
 * time instead.
 *
 * The key is kept per Polaris: each is bound to the address it was entered for,
 * so switching server cannot send one instance's key to another, and going back
 * finds the first one still kept. A file from before there was more than one
 * server holds a single `{ server, key }`, which reads as a list of one.
 */

import { join } from "node:path";
import { app, safeStorage } from "electron";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** The keys kept, by server origin. */
type Stored = Record<string, string>;

function file(): string {
    return join(app.getPath("userData"), "api-key.bin");
}

/** Whether a key can be kept here without writing it in plain text. */
export function canKeepApiKey(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

/** The stored keys as decrypted text, read leniently. Pure, for the tests. */
export function readStoredKeys(text: string): Stored {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return {};
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const value = raw as Record<string, unknown>;
    if (typeof value.server === "string" && typeof value.key === "string") return { [value.server]: value.key };
    const keys = (value.keys ?? {}) as Record<string, unknown>;
    if (typeof keys !== "object" || keys === null) return {};
    return Object.fromEntries(
        Object.entries(keys).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
}

function load(): Stored {
    if (!canKeepApiKey()) return {};
    try {
        return readStoredKeys(safeStorage.decryptString(readFileSync(file())));
    } catch {
        return {};
    }
}

function save(keys: Stored): void {
    if (Object.keys(keys).length === 0) {
        rmSync(file(), { force: true });
        return;
    }
    const temp = `${file()}.${process.pid}.tmp`;
    writeFileSync(temp, safeStorage.encryptString(JSON.stringify({ keys })), { mode: 0o600 });
    renameSync(temp, file());
}

/** The key kept for this Polaris, or null. */
export function readApiKey(server: string): string | null {
    return load()[server] ?? null;
}

/** Keep a key for this Polaris. Answers false when it could not be kept safely. */
export function keepApiKey(server: string, key: string): boolean {
    if (!canKeepApiKey()) return false;
    save({ ...load(), [server]: key });
    return true;
}

/** Forget the key kept for this Polaris; the others stay. */
export function forgetApiKey(server: string): void {
    save(Object.fromEntries(Object.entries(load()).filter(([origin]) => origin !== server)));
}

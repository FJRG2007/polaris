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
 * The key is kept per Polaris: it is bound to the address it was entered for, so
 * changing server cannot send one instance's key to another.
 */

import { join } from "node:path";
import { app, safeStorage } from "electron";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

interface Stored {
    readonly server: string;
    readonly key: string;
}

function file(): string {
    return join(app.getPath("userData"), "api-key.bin");
}

/** Whether a key can be kept here without writing it in plain text. */
export function canKeepApiKey(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

/** The key kept for this Polaris, or null. */
export function readApiKey(server: string): string | null {
    if (!canKeepApiKey()) return null;
    try {
        const stored = JSON.parse(
            safeStorage.decryptString(readFileSync(file()))
        ) as Partial<Stored>;
        return stored.server === server && typeof stored.key === "string" ? stored.key : null;
    } catch {
        return null;
    }
}

/** Keep a key for this Polaris. Answers false when it could not be kept safely. */
export function keepApiKey(server: string, key: string): boolean {
    if (!canKeepApiKey()) return false;
    const temp = `${file()}.${process.pid}.tmp`;
    writeFileSync(
        temp,
        safeStorage.encryptString(JSON.stringify({ server, key } satisfies Stored)),
        { mode: 0o600 }
    );
    renameSync(temp, file());
    return true;
}

export function forgetApiKey(): void {
    rmSync(file(), { force: true });
}

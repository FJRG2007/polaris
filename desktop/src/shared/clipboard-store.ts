/**
 * The clipboard history on disk: encrypted with the operating system's own
 * key store (Electron `safeStorage`: DPAPI on Windows, the Keychain on macOS,
 * the Secret Service or KWallet on Linux), kept for the chosen time, and
 * bounded in entries and bytes so it can never grow without end.
 *
 * Nothing here touches Electron or the disk directly: both are handed in, so
 * every rule runs in a test. Where the system has no key store
 * (`isEncryptionAvailable()` false), nothing is written at all - the history
 * lives in memory only and the settings say so. Plain text never reaches disk.
 */

import { z } from "zod";
import { CLIPBOARD_MAX_CHARS, type ClipEntry } from "./clipboard-history";

/** How long the history keeps a copy, as the settings offer it. */
export const CLIPBOARD_KEEP = {
    day: 24 * 60 * 60_000,
    week: 7 * 24 * 60 * 60_000,
    month: 30 * 24 * 60 * 60_000,
    quarter: 90 * 24 * 60 * 60_000
} as const;

export type ClipboardKeep = keyof typeof CLIPBOARD_KEEP;

export const CLIPBOARD_KEEP_IDS = Object.keys(CLIPBOARD_KEEP) as [ClipboardKeep, ...ClipboardKeep[]];

export const DEFAULT_CLIPBOARD_KEEP: ClipboardKeep = "week";

/**
 * Whether the history is on: what somebody chose, else on. The history used
 * to be off by default and every saved settings file carries that `false`
 * whether or not anybody chose it, so an install that never touched the switch
 * comes out on, and only a choice made since the marker existed is kept.
 */
export function clipboardOn(stored: boolean, chosen: boolean): boolean {
    return chosen ? stored : true;
}

/** The most entries kept, whatever their age. */
export const CLIPBOARD_MAX_ENTRIES = 1_000;

/** The most text kept in all, in UTF-16 code units (about 4 MB of characters). */
export const CLIPBOARD_MAX_TOTAL_CHARS = 2_000_000;

/**
 * The history as it may be kept: nothing older than `keepMs`, nothing from the
 * future (a clock set back), no copy over the per-entry cap, and the newest
 * first until either bound is reached.
 */
export function boundClips(history: readonly ClipEntry[], now: number, keepMs: number): ClipEntry[] {
    const kept: ClipEntry[] = [];
    let total = 0;
    for (const entry of [...history].sort((a, b) => b.at - a.at)) {
        if (entry.at > now || now - entry.at > keepMs) continue;
        if (!entry.text.trim() || entry.text.length > CLIPBOARD_MAX_CHARS) continue;
        if (kept.length >= CLIPBOARD_MAX_ENTRIES || total + entry.text.length > CLIPBOARD_MAX_TOTAL_CHARS) break;
        total += entry.text.length;
        kept.push(entry);
    }
    return kept;
}

const fileSchema = z.object({
    v: z.literal(1),
    clips: z
        .array(z.object({ text: z.string().max(CLIPBOARD_MAX_CHARS), at: z.number().int().nonnegative() }))
        .max(CLIPBOARD_MAX_ENTRIES)
});

/** What the operating system's key store does, as `safeStorage` offers it. */
export interface ClipboardCipher {
    available(): boolean;
    encrypt(text: string): Uint8Array;
    decrypt(data: Uint8Array): string;
}

/** The one file, as the store needs it. */
export interface ClipboardFile {
    /** Its bytes, or null when there is none. */
    read(): Uint8Array | null;
    /** Replace it whole, never leaving it half written (temp name + rename). */
    write(data: Uint8Array): void;
    remove(): void;
}

/**
 * The history kept between runs: read once on start, written on each copy.
 * Every failure - no key store, a file that will not decrypt or parse, a
 * write the disk refuses - ends in a working history in memory, never a
 * crash.
 */
export class ClipboardStore {
    constructor(
        private readonly cipher: ClipboardCipher,
        private readonly file: ClipboardFile
    ) {}

    /** Whether copies outlive a restart here: false means memory only. */
    persists(): boolean {
        try {
            return this.cipher.available();
        } catch {
            return false;
        }
    }

    /** What was kept, pruned to `keepMs`; empty when it cannot be read. */
    load(now: number, keepMs: number): ClipEntry[] {
        if (!this.persists()) return [];
        let raw: Uint8Array | null;
        try {
            raw = this.file.read();
        } catch {
            return [];
        }
        if (!raw) return [];
        try {
            const parsed = fileSchema.safeParse(JSON.parse(this.cipher.decrypt(raw)));
            if (parsed.success) return boundClips(parsed.data.clips, now, keepMs);
        } catch {
            // Undecryptable (another user's key, a reinstalled system) or not JSON.
        }
        // Unreadable is as good as gone: start again rather than fail on it every run.
        this.clear();
        return [];
    }

    /** Keep `history`, pruned. What was kept, which is what memory should hold. */
    save(history: readonly ClipEntry[], now: number, keepMs: number): ClipEntry[] {
        const kept = boundClips(history, now, keepMs);
        if (!this.persists()) return kept;
        try {
            if (kept.length === 0) this.file.remove();
            else this.file.write(this.cipher.encrypt(JSON.stringify({ v: 1, clips: kept })));
        } catch {
            // The disk refused: memory still has it, and the next copy tries again.
        }
        return kept;
    }

    /** Forget everything on disk. */
    clear(): void {
        try {
            this.file.remove();
        } catch {
            // Already gone, or the disk refused; nothing else to do.
        }
    }
}

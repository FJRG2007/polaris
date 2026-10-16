/**
 * The clipboard blocks are copied to and pasted from: one block at a time, kept
 * for this tab, so a trigger copied in one automation can be pasted into
 * another opened afterwards.
 *
 * Kept apart from the system clipboard on purpose. A block is the editor's own
 * data, not text somebody would paste into a message, and reading the system
 * clipboard asks the browser for a permission nobody should be prompted for
 * just to see whether Paste can be offered.
 *
 * What comes back is unchecked data: the editor that pastes it parses it with
 * its own schema first, and only a block of the same surface and the same role
 * (a trigger where a trigger goes) is ever handed back.
 */

const STORAGE_KEY = "polaris.automation.clipboard";

export interface ClipboardEntry {
    /** Which editor it came from: "places", "mail". */
    readonly surface: string;
    /** Which list it belongs in: "trigger", "condition", "step". */
    readonly role: string;
    readonly block: unknown;
}

let held: ClipboardEntry | null = null;

function storage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

export function copyBlock(entry: ClipboardEntry): void {
    held = { ...entry, block: JSON.parse(JSON.stringify(entry.block)) as unknown };
    try {
        storage()?.setItem(STORAGE_KEY, JSON.stringify(held));
    } catch {
        // No room or no storage: it lasts as long as this page does.
    }
}

function stored(): ClipboardEntry | null {
    if (held) return held;
    try {
        const raw = storage()?.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<ClipboardEntry> | null;
        if (
            !parsed ||
            typeof parsed.surface !== "string" ||
            typeof parsed.role !== "string" ||
            !("block" in parsed)
        )
            return null;
        held = { surface: parsed.surface, role: parsed.role, block: parsed.block };
        return held;
    } catch {
        return null;
    }
}

/** The block waiting to be pasted into this list, or null. A fresh copy each
 *  time, so pasting twice never hands out the same object. */
export function pastedBlock(surface: string, role: string): unknown {
    const entry = stored();
    if (!entry || entry.surface !== surface || entry.role !== role) return null;
    return JSON.parse(JSON.stringify(entry.block)) as unknown;
}

export function hasBlock(surface: string, role: string): boolean {
    const entry = stored();
    return entry !== null && entry.surface === surface && entry.role === role;
}

/** Empties it; for tests. */
export function clearClipboard(): void {
    held = null;
    try {
        storage()?.removeItem(STORAGE_KEY);
    } catch {
        // Nothing to clear.
    }
}

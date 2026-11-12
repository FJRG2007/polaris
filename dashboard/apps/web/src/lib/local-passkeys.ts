"use client";

/**
 * Which passkeys this browser is known to hold, so a sign-in or unlock screen can
 * ask for one the moment it opens instead of waiting for a press.
 *
 * WebAuthn has no way to ask "does this device have a passkey for me" without
 * raising a prompt (Chrome's immediate mode still needs a press, and nothing else
 * has it), and a prompt for a passkey that lives on another computer is a dialog
 * about phones and security keys the person did not ask for. So nothing is
 * guessed: a credential goes on this list only after it answered a ceremony here
 * as a `platform` authenticator - Windows Hello, Touch ID, Android, a password
 * manager built into the browser. A phone reached by QR code and a USB key report
 * `cross-platform` and are never listed: they may well not be here next time.
 *
 * The list is per browser profile and origin (localStorage), holds ids only - a
 * credential id is not a secret and opens nothing - and is pruned by the screens
 * themselves: an id the server no longer knows is dropped, and one whose
 * automatic prompt keeps going unanswered is dropped after `MAX_MISSES`, which is
 * what a passkey deleted from the device looks like from here.
 */

const STORAGE_KEY = "polaris.passkeys.local";
/** Set for the rest of the tab once an automatic prompt went unanswered, or the
 *  account was signed out on purpose: the next screen waits for the button. */
const PAUSE_KEY = "polaris.passkeys.auto-paused";
/** Automatic prompts in a row, with no success between, before an id is dropped. */
const MAX_MISSES = 3;
/** Bounds the list; a browser holding more passkeys than this for one site is
 *  not a real case, and the oldest go first. */
const MAX_ENTRIES = 20;

interface LocalPasskey {
    /** base64url, as WebAuthn reports it. */
    readonly id: string;
    /** Automatic prompts that went unanswered since it last worked. */
    readonly misses: number;
    /** When it last answered here, ms since the epoch. */
    readonly usedAt: number;
}

function read(): LocalPasskey[] {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (entry): entry is LocalPasskey =>
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as LocalPasskey).id === "string" &&
                typeof (entry as LocalPasskey).misses === "number" &&
                typeof (entry as LocalPasskey).usedAt === "number"
        );
    } catch {
        return [];
    }
}

function write(entries: readonly LocalPasskey[]): void {
    try {
        if (entries.length === 0) window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
        // Storage refused (private window, blocked site data): the screens fall
        // back to the button, which is how they worked before this existed.
    }
}

/** The ids of the passkeys this browser has used itself, most recent first. */
export function localPasskeyIds(): string[] {
    if (typeof window === "undefined") return [];
    return read()
        .sort((a, b) => b.usedAt - a.usedAt)
        .map((entry) => entry.id);
}

/**
 * Note a passkey that was just created or just answered a ceremony in this
 * browser - only when the browser says the authenticator is part of this device.
 */
export function rememberLocalPasskey(credential: {
    readonly id: string;
    readonly authenticatorAttachment?: string | null;
}): void {
    if (typeof window === "undefined") return;
    if (credential.authenticatorAttachment !== "platform") return;
    const id = credential.id;
    if (!id) return;
    const others = read().filter((entry) => entry.id !== id);
    const next = [{ id, misses: 0, usedAt: Date.now() }, ...others]
        .sort((a, b) => b.usedAt - a.usedAt)
        .slice(0, MAX_ENTRIES);
    write(next);
}

/** Drop ids this browser should stop asking for: the server does not know them. */
export function forgetLocalPasskeys(ids: readonly string[]): void {
    if (typeof window === "undefined" || ids.length === 0) return;
    const gone = new Set(ids);
    write(read().filter((entry) => !gone.has(entry.id)));
}

/**
 * An automatic prompt for these ids went unanswered - dismissed, timed out, or
 * the passkey is no longer on the device. Counted, dropped after `MAX_MISSES`,
 * and the rest of this tab waits for the button.
 */
export function missedLocalPasskeys(ids: readonly string[]): void {
    if (typeof window === "undefined") return;
    pauseAutomaticPasskey();
    if (ids.length === 0) return;
    const missed = new Set(ids);
    write(
        read()
            .map((entry) => (missed.has(entry.id) ? { ...entry, misses: entry.misses + 1 } : entry))
            .filter((entry) => entry.misses < MAX_MISSES)
    );
}

/** Stop asking on its own for the rest of this tab. */
export function pauseAutomaticPasskey(): void {
    try {
        window.sessionStorage.setItem(PAUSE_KEY, "1");
    } catch {
        // Without session storage the pause is lost, and the next screen asks
        // once more; the misses above still bound how often.
    }
}

/** Whether this tab already said no, or signed out on purpose. */
export function automaticPasskeyPaused(): boolean {
    try {
        return window.sessionStorage.getItem(PAUSE_KEY) === "1";
    } catch {
        return false;
    }
}

/** Resume asking on its own, after a passkey answered. */
export function resumeAutomaticPasskey(): void {
    try {
        window.sessionStorage.removeItem(PAUSE_KEY);
    } catch {
        // Nothing to undo when there is no session storage.
    }
}

/**
 * Resolves once somebody is plausibly at the screen: the tab is visible and the
 * window has focus. A vault that locked while its owner was away must not open a
 * prompt that times out in an empty room and counts against the passkey.
 */
export function whenAttended(signal: AbortSignal): Promise<boolean> {
    const attended = () => document.visibilityState === "visible" && document.hasFocus();
    if (attended()) return Promise.resolve(true);
    return new Promise((resolve) => {
        const check = () => {
            if (!attended()) return;
            cleanup();
            resolve(true);
        };
        const abort = () => {
            cleanup();
            resolve(false);
        };
        const cleanup = () => {
            window.removeEventListener("focus", check);
            document.removeEventListener("visibilitychange", check);
            signal.removeEventListener("abort", abort);
        };
        window.addEventListener("focus", check);
        document.addEventListener("visibilitychange", check);
        signal.addEventListener("abort", abort);
    });
}

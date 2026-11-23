/**
 * The typed password, held in this tab's memory across the second-factor page
 * only, so an account that always answers a challenge still gets its account
 * key and password lock (docs/chat-e2ee-phase1.md, phase 1 item "every account
 * gets AK").
 *
 * The sign-in form moves to the challenge page with a client-side navigation,
 * so this module - and the value - survive it; a reload, a new tab or a full
 * navigation loses it, and the account simply settles at a later sign-in.
 * Nothing is written to storage, the value is taken once, and it expires after
 * a few minutes whether or not anybody takes it. It is the same string the form
 * itself was holding a moment earlier; it never leaves the tab, except as
 * OPAQUE messages that do not reveal it.
 *
 * Kept free of imports so the challenge page can carry it without loading any
 * of the key code; that code is fetched only when there is something to settle.
 */

/** How long a held password waits for its challenge to be answered. */
export const HOLD_MS = 10 * 60_000;

let held: { readonly password: string; readonly until: number } | null = null;

/** Keep the password for the challenge page about to open. */
export function holdForSecondFactor(password: string, now = Date.now()): void {
    held = password ? { password, until: now + HOLD_MS } : null;
}

/** The held password, once; null when nothing is held or it expired. */
export function takeHeldPassword(now = Date.now()): string | null {
    const taken = held;
    held = null;
    return taken && taken.until > now ? taken.password : null;
}

/** Let go of it without using it: another account, or the challenge abandoned. */
export function dropHeldPassword(): void {
    held = null;
}

/**
 * After the challenge was answered and the session is whole: open the account
 * key with the held password, or create it and seal its password lock. Never
 * throws and never fails the sign-in; with nothing held it loads nothing.
 */
export async function settleAfterSecondFactor(): Promise<void> {
    const password = takeHeldPassword();
    if (!password) return;
    try {
        const keys = await import("@/lib/chat/e2ee/account-key-client");
        await keys.settleAfterPassword(password, null);
    } catch {
        // The account settles at its next sign-in.
    }
}

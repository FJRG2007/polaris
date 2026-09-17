/**
 * The short code a client shows and somebody types back, on its own.
 *
 * Pure: no database, no request, no clock. That matters because the screens that
 * approve these are client components, and anything they import is bundled for
 * the browser - so the code has to be definable without the service that stores
 * one. Two flows use it today, the vault's sign-in and the browser extension's
 * connection, and one definition of what a code is between them is the point.
 */

/**
 * How long a request waits to be answered.
 *
 * Long enough to open the dashboard and find the screen; short enough that a
 * code left on a screen in an office is not still good after lunch.
 */
export const AUTHORIZATION_TTL_MS = 5 * 60 * 1000;

/** How long the client leaves between polls. */
export const AUTHORIZATION_POLL_MS = 2000;

/**
 * The alphabet the code is drawn from.
 *
 * No vowels, so nothing spells a word somebody has to read aloud in an office; and
 * no 0/O or 1/I/L, which are the pairs people mistype when copying between a popup
 * and a dashboard. Twenty-eight characters over eight positions is enough that
 * guessing one inside its five minutes is not a thing to worry about.
 */
const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";

/** How many characters the code carries. */
const CODE_LENGTH = 8;

/** A code, drawn from a source of randomness the caller provides so a test can be
 *  deterministic and production cannot be. */
export function newUserCode(random: (size: number) => Uint8Array): string {
    const bytes = random(CODE_LENGTH);
    let code = "";
    for (let index = 0; index < CODE_LENGTH; index += 1) {
        code += CODE_ALPHABET[bytes[index]! % CODE_ALPHABET.length];
    }
    return code;
}

/** The code as it is shown: two groups, because nobody reads eight characters as
 *  one run. Only ever for display - what is stored and compared is the plain form. */
export function formatUserCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What somebody typed, as a code.
 *
 * Spaces and dashes go, letters are upped: the code is shown grouped and read off
 * a screen, so it arrives back with whatever separators the reader saw. Returns
 * null for anything that is not the right shape, so the refusal happens before a
 * lookup rather than as a miss that reads like an expired code.
 */
export function readUserCode(typed: string): string | null {
    const bare = typed.replace(/[\s-]/g, "").toUpperCase();
    if (bare.length !== CODE_LENGTH) return null;
    for (const character of bare) {
        if (!CODE_ALPHABET.includes(character)) return null;
    }
    return bare;
}

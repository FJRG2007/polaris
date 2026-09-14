/**
 * The short code a client shows and somebody types back, on its own.
 *
 * Apart from the service that stores these (`lib/vault/authorization`) because the
 * screen that approves one is a client component: anything it imports is bundled
 * for the browser, and that service imports Prisma. Keeping the alphabet, the
 * shapes and the two string functions here is what lets both sides share one
 * definition of what a code is instead of each carrying its own.
 *
 * Everything in this file is pure. No database, no request, no clock.
 */

/**
 * How long a request waits to be answered.
 *
 * Long enough to open the dashboard, find the vault and unlock it; short enough
 * that a code left on a screen in an office is not still good after lunch.
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
    const cleaned = typed.trim().toUpperCase().replace(/[\s-]/g, "");
    if (cleaned.length !== CODE_LENGTH) return null;
    for (const character of cleaned) {
        if (!CODE_ALPHABET.includes(character)) return null;
    }
    return cleaned;
}

/** A waiting request, as the person deciding on it is shown it. */
export interface PendingAuthorization {
    readonly userCode: string;
    /** What the client called itself. A label, never a decision. */
    readonly device: string;
    /** The address it asked from, when it was recorded. */
    readonly requestIp: string | null;
    /** Which of this deployment's names it asked on. */
    readonly host: string | null;
    /** The public half the key would be sealed to, so the screen approving can do
     *  the sealing without a second round trip. */
    readonly publicKey: string;
    readonly requestedAt: string;
    readonly expiresAt: string;
}

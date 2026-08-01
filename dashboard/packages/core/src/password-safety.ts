/**
 * What makes a password unacceptable beyond being too short.
 *
 * Length rules stop nothing that matters. The two passwords that actually fall
 * are the one already sitting in a credential-stuffing list, and the one built
 * out of the account it protects - "Fjrg2007" for fjrg2007 is one guess to
 * anyone who knows the address. The first needs a corpus to check against and
 * lives with the code that can reach one; the rule below is the second, and it is
 * pure, so the same comparison runs wherever the identity is known.
 *
 * Comparison is on normalized values on both sides, because the variations
 * people reach for are exactly the ones a naive check misses: casing, accents,
 * and the punctuation sprinkled through "F.J.R.G_2007" to make it look different
 * from "fjrg2007".
 */

/**
 * Fold a value down to what a comparison should treat as the same string:
 * lowercase, unaccented, and stripped of everything that is not a letter or a
 * digit. Decomposing first is what removes the accents - NFKD splits an accented
 * letter into the letter and a combining mark, and the strip below takes the
 * mark with the rest of the punctuation.
 */
export function normalizeForComparison(value: string): string {
    return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Below this, a shared run is a coincidence rather than a giveaway. */
const IDENTITY_RUN = 4;

/** The pieces of an identity value worth comparing against on their own - an
 *  address gives up its local part, a display name gives up each of its words. */
function identityPieces(value: string): string[] {
    const local = value.includes("@") ? value.slice(0, value.indexOf("@")) : "";
    return [value, local, ...value.split(/[\s._-]+/)].filter(Boolean);
}

/**
 * Whether a password gives away, or is given away by, the account it belongs to.
 *
 * True when the password contains any piece of the identity (or is contained by
 * one) once both sides are normalized - the name, the username, the address, its
 * local part, or the name of the site itself.
 */
export function passwordMatchesIdentity(
    password: string,
    identity: Iterable<string | null | undefined>
): boolean {
    const candidate = normalizeForComparison(password);
    if (candidate.length === 0) return false;
    for (const value of identity) {
        if (!value) continue;
        for (const piece of identityPieces(value)) {
            const normalized = normalizeForComparison(piece);
            if (normalized.length < IDENTITY_RUN) continue;
            if (candidate.includes(normalized) || normalized.includes(candidate)) return true;
        }
    }
    return false;
}

/** What to tell someone whose password is their own name back at them. Kept here
 *  so the client and the server refuse it in the same words. */
export const IDENTITY_PASSWORD_MESSAGE =
    "That password is too close to your name, username or address. Pick something unrelated to the account.";

/** And the same for one that is already public. */
export const BREACHED_PASSWORD_MESSAGE =
    "That password has appeared in a known data breach. Pick a different one.";

/**
 * Whether the password somebody is inventing is already public.
 *
 * A password that meets every length rule is still worthless if it is sitting in
 * a credential-stuffing list, and a manager that watches somebody type one into a
 * sign-up form and says nothing has missed the only moment where saying something
 * costs nothing.
 *
 * **The password never leaves this extension, and the check is asked of Polaris
 * rather than of anybody else.** What goes out is the first five characters of
 * its SHA-1 - one bucket in a million, shared with every other password that
 * begins the same way - and what comes back is a few hundred hashes to search
 * here. The route it asks is the deployment's own, for the same reason the update
 * check is: the manifest declares no host permission at all, and a password
 * manager that stood on permission to reach a second host to do this would be
 * spending far more than the answer is worth.
 *
 * It fails OPEN, and that is deliberate. A server that cannot be reached is not
 * evidence that a password is fine, but a sign-up form that refuses to proceed
 * because a warning could not be fetched is a manager getting in the way of the
 * thing somebody is actually doing. Null is "unknown", and the caller says
 * nothing.
 */

/** Long enough for a server on the other side of a tunnel, short enough that it
 *  never outlives the form it is warning about. */
const TIMEOUT_MS = 4000;

/** Below this there is nothing to check yet: somebody is still typing. */
export const SHORTEST_CHECKED = 6;

/** Uppercase hex SHA-1, which is the only form the corpus is indexed by. */
export async function sha1Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
}

/**
 * How many times a suffix appears in a range answer, or zero when it does not.
 *
 * The corpus pads its answers with lines whose count is zero, so a hash that is
 * present is not the same as a hash that is known - the count is what says so,
 * and a padded line has to read as absent.
 */
export function countIn(range: string, suffix: string): number {
    for (const line of range.split("\n")) {
        const [candidate, count] = line.trim().split(":");
        if (candidate?.toUpperCase() === suffix.toUpperCase()) return Number(count) || 0;
    }
    return 0;
}

/**
 * How many times this password appears in the corpus, or null when the question
 * could not be asked at all.
 *
 * Null is not "safe": it is "unknown", and every caller treats it as a pass on
 * purpose.
 */
export async function breachCount(origin: string, password: string): Promise<number | null> {
    if (password.length < SHORTEST_CHECKED) return null;
    try {
        const hash = await sha1Hex(password);
        const response = await fetch(`${origin}/api/polaris/pwned/${hash.slice(0, 5)}`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            credentials: "omit"
        });
        if (!response.ok) return null;
        return countIn(await response.text(), hash.slice(5));
    } catch {
        return null;
    }
}

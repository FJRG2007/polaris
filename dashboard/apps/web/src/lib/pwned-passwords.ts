/**
 * Whether a password is already public.
 *
 * A password that meets every length and character rule is still worthless if it
 * is sitting in a credential-stuffing list, and that is the single most likely
 * way an account here is taken. The check is against Have I Been Pwned's range
 * API, which is free, needs no key, and never sees the password: only the first
 * five characters of its SHA-1 are sent, and the answer is a few hundred hashes
 * to search locally. `Add-Padding` keeps the response size from narrowing that
 * down further.
 *
 * It runs on both sides. The client checks as the password is typed so the
 * refusal arrives before the submit, and the server checks again on submit
 * because the client is not the enforcement point.
 *
 * It fails OPEN. An outage at somebody else's API must never be the reason a
 * person cannot get back into their account - the length and identity rules
 * still apply, and they are the ones this deployment can guarantee.
 */

const RANGE_URL = "https://api.pwnedpasswords.com/range";

/** Long enough for a slow answer, short enough not to stall a form submit. */
const TIMEOUT_MS = 4000;

/** Uppercase hex SHA-1, which is the only form the range API speaks. */
async function sha1Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
}

/**
 * Every hash in the corpus that begins with these five characters, as the API
 * sends them, or null when it could not be asked.
 *
 * Separate from the count because the browser extension needs the range itself:
 * its manifest declares no host permission at all, so it cannot reach this API,
 * and it asks its own Polaris for the bucket and searches it there. That route is
 * the only other caller - see `app/api/polaris/pwned/[prefix]`.
 */
export async function pwnedRange(prefix: string, signal?: AbortSignal): Promise<string | null> {
    try {
        const response = await fetch(`${RANGE_URL}/${prefix}`, {
            headers: { "Add-Padding": "true" },
            signal: signal ?? AbortSignal.timeout(TIMEOUT_MS)
        });
        return response.ok ? await response.text() : null;
    } catch {
        return null;
    }
}

/**
 * How many times this password appears in the corpus, or null when the question
 * could not be asked. Null is not "safe" - it is "unknown", and every caller
 * treats it as a pass on purpose.
 */
export async function passwordBreachCount(password: string, signal?: AbortSignal): Promise<number | null> {
    if (!password) return null;
    try {
        const hash = await sha1Hex(password);
        const range = await pwnedRange(hash.slice(0, 5), signal);
        if (range === null) return null;
        const suffix = hash.slice(5);
        for (const line of range.split("\n")) {
            const [candidate, count] = line.trim().split(":");
            if (candidate === suffix) return Number(count) || 0;
        }
        return 0;
    } catch {
        return null;
    }
}

/** Whether the corpus knows this password. Unknown answers read as "no". */
export async function passwordIsBreached(password: string, signal?: AbortSignal): Promise<boolean> {
    return ((await passwordBreachCount(password, signal)) ?? 0) > 0;
}

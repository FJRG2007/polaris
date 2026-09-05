/**
 * Remembering what the breach corpus said, so it is not asked again tomorrow.
 *
 * Opening an item in the vault asked Have I Been Pwned about that password every
 * single time - a request per item per visit, for an answer that changes when a
 * new corpus is published and not before. So the answer is kept for a month.
 *
 * What it is keyed by is the whole of the design, and the obvious key is the one
 * that must not be used. The natural cache key is the password's SHA-1, and
 * writing that into `localStorage` would put an unsalted hash of every vault
 * password on the disk of a machine whose vault is supposed to be unreadable
 * without the master password - a weak one would fall to a rainbow table in
 * seconds. A vault that leaks its contents to a local reader is not a vault.
 *
 * So the key is sixteen bits of the password and nothing more, alongside the id
 * of the item it belongs to. Sixteen bits is less than the twenty already sent
 * to the corpus over the network by the k-anonymity lookup itself, and far too
 * few to confirm a guess: one candidate in sixty-five thousand survives the
 * filter, which is no help to somebody who has to hash every candidate anyway.
 *
 * The cost of so short a fingerprint is a stale answer when a password is
 * changed to another whose fingerprint collides - one time in sixty-five
 * thousand, for at most a month. That is the right side to fail on: the frequent
 * case is right and cheap, and the rare one is corrected by the next expiry.
 *
 * Nothing is cached without an item to key it to. A password being typed into a
 * form has no id, is asked about once, and is never written down here.
 */

/** A month. Long enough that a vault is not re-asking about itself every week,
 *  short enough that a corpus published since is picked up without anybody
 *  having to know there is a cache. */
export const BREACH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Where the answers live. One key, one object, so clearing it is one removal. */
export const BREACH_CACHE_KEY = "polaris.vault.breach";

/** The most answers kept. A vault larger than this loses its oldest, which costs
 *  one request; keeping every answer for ever would grow without a bound. */
const MOST_KEPT = 500;

/** What is stored against one item and password: the count, and when it was
 *  asked. */
export type BreachAnswer = { count: number; at: number };

/**
 * Sixteen bits of a password, as four hex characters.
 *
 * FNV-1a, and deliberately not a cryptographic hash: this is not standing
 * between anybody and anything, it is telling "the same password as last time"
 * from "a different one". Truncation is what makes it safe to write down, so the
 * width is the point rather than the algorithm.
 */
export function passwordFingerprint(password: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < password.length; index += 1) {
        hash ^= password.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ((hash ^ (hash >>> 16)) & 0xffff).toString(16).padStart(4, "0");
}

/** The key one answer is filed under. */
export function breachKey(scope: string, password: string): string {
    return `${scope}:${passwordFingerprint(password)}`;
}

/** Every answer still worth keeping. Anything older than the window is dropped
 *  on the way past rather than by a sweep of its own. */
export function liveAnswers(
    stored: Record<string, BreachAnswer>,
    now: number
): Record<string, BreachAnswer> {
    const live: Record<string, BreachAnswer> = {};
    for (const [key, answer] of Object.entries(stored)) {
        if (typeof answer?.count === "number" && now - answer.at < BREACH_TTL_MS) live[key] = answer;
    }
    return live;
}

/**
 * The stored answers, with a new one added and the oldest dropped if there are
 * now too many. Pure, so the eviction and the expiry can be asserted without a
 * browser.
 */
export function withAnswer(
    stored: Record<string, BreachAnswer>,
    key: string,
    count: number,
    now: number
): Record<string, BreachAnswer> {
    const live = liveAnswers(stored, now);
    live[key] = { count, at: now };
    const keys = Object.keys(live);
    if (keys.length <= MOST_KEPT) return live;
    const oldest = keys
        .sort((left, right) => (live[left]?.at ?? 0) - (live[right]?.at ?? 0))
        .slice(0, keys.length - MOST_KEPT);
    for (const stale of oldest) delete live[stale];
    return live;
}

/** What is on this machine, or nothing at all. Storage can be off, full, or a
 *  private window, and none of those is worth an error on a screen. */
function read(): Record<string, BreachAnswer> {
    try {
        const raw = window.localStorage.getItem(BREACH_CACHE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, BreachAnswer>) : {};
    } catch {
        return {};
    }
}

/** The remembered count for this item's password, or null when it has not been
 *  asked lately. */
export function rememberedBreach(scope: string, password: string, now = Date.now()): number | null {
    if (!scope || !password) return null;
    const answer = read()[breachKey(scope, password)];
    return answer && now - answer.at < BREACH_TTL_MS ? answer.count : null;
}

/** Keep an answer. Silent on failure: a cache that cannot be written is a cache
 *  that is not there, which is the state everything here already handles. */
export function rememberBreach(
    scope: string,
    password: string,
    count: number,
    now = Date.now()
): void {
    if (!scope || !password) return;
    try {
        const next = withAnswer(read(), breachKey(scope, password), count, now);
        window.localStorage.setItem(BREACH_CACHE_KEY, JSON.stringify(next));
    } catch {
        // Storage off or full. The corpus gets asked again next time.
    }
}

/** Throw the lot away. Used when the vault is locked, where even a fingerprint is
 *  more than the next person at this machine should find. */
export function forgetBreaches(): void {
    try {
        window.localStorage.removeItem(BREACH_CACHE_KEY);
    } catch {
        // Nothing to forget.
    }
}

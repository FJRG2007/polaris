/**
 * Whether the Polaris a route signs visitors in through is answering right now.
 *
 * Not a decision and not on the request path. Every decision the guard makes is local -
 * the rule rides the route, tokens are verified with keys the route carries, bans and
 * revocations come from the snapshot on disk. What this answers is narrower: when the
 * guard is about to send a visitor to Polaris to sign in, will they find anything
 * there? If not, they get a page saying sign-in is unavailable instead of their
 * browser's connection error, and a visitor already signed in is not sent away to
 * refresh a claim nobody can refresh.
 *
 * Checked lazily and in the background: a request asks for the last known answer and,
 * when it is older than the interval, starts one probe without waiting for it. So a
 * guard that never protects a login never makes a single outbound request, and one that
 * does makes at most one per login address per interval however busy it is.
 *
 * "Unknown" - never probed yet - is treated as reachable by the caller. That is the
 * behaviour every guard had before this existed, and the first request after a start
 * is what starts finding out.
 */

/** How old an answer may be before the next request starts a fresh probe. */
const CHECK_EVERY_MS = 30_000;

/** How soon a single failed probe is checked again. One failure is not an answer - a
 *  dropped packet or a restart in progress looks the same - so it is confirmed quickly
 *  rather than left standing for a whole interval. */
const RECHECK_MS = 5000;

/** Consecutive failed probes before the address is reported down. */
const DOWN_AFTER = 2;

/** How long one probe may take. Polaris's health route answers in milliseconds when it
 *  is up; a probe still waiting after this is a Polaris the visitor would also be
 *  waiting on. */
const PROBE_TIMEOUT_MS = 4000;

/** At most this many login addresses are tracked. The set is "where this server's
 *  routes say Polaris is", written by Polaris, so it is tiny; the cap only keeps a
 *  misconfiguration from growing it. */
const MAX_BASES = 16;

export interface ControlPlaneWatch {
    /** The last known answer for this login address: true up, false down, null not yet
     *  known. Starts a background probe when the answer is stale. */
    reachable(base: string, now?: number): boolean | null;
}

interface Probe {
    reachable: boolean | null;
    checkedAt: number;
    pending: boolean;
    failures: number;
}

/** `probe` is injected so tests decide what Polaris answers without a network. */
export function createControlPlaneWatch(
    probe: (base: string) => Promise<boolean> = probeHealth,
    clock: () => number = Date.now
): ControlPlaneWatch {
    const bases = new Map<string, Probe>();
    return {
        reachable(base, now = clock()) {
            let entry = bases.get(base);
            if (!entry) {
                if (bases.size >= MAX_BASES) return null;
                entry = { reachable: null, checkedAt: -Infinity, pending: false, failures: 0 };
                bases.set(base, entry);
            }
            const unconfirmed = entry.failures > 0 && entry.failures < DOWN_AFTER;
            if (
                !entry.pending &&
                now - entry.checkedAt >= (unconfirmed ? RECHECK_MS : CHECK_EVERY_MS)
            ) {
                const held = entry;
                held.pending = true;
                void probe(base)
                    .catch(() => false)
                    .then((up) => {
                        held.failures = up ? 0 : held.failures + 1;
                        if (up) held.reachable = true;
                        else if (held.failures >= DOWN_AFTER) held.reachable = false;
                        held.checkedAt = clock();
                        held.pending = false;
                    });
            }
            return entry.reachable;
        }
    };
}

/**
 * Ask Polaris's health route. Any answer below 500 means something is serving the
 * sign-in page - a redirect to the canonical host, or a 403 from a firewall rule that
 * does not admit this server, is Polaris answering. Only a 5xx (a Polaris without its
 * database, or a proxy with nothing behind it), a refused connection or a timeout is
 * down.
 */
export async function probeHealth(base: string): Promise<boolean> {
    try {
        const response = await fetch(`${base}/api/health`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            redirect: "manual"
        });
        return response.status < 500;
    } catch {
        return false;
    }
}

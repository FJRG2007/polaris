/**
 * Whether Polaris itself answers, as opposed to whether this device is online.
 *
 * The browser knows only the second (`navigator.onLine`), and it says "online" all
 * the while a server is restarting, an update is rolling over, or a hotel network
 * is holding every request for its sign-in page. From the reader's side those look
 * exactly like Polaris breaking, so they are told apart here.
 *
 * Nothing polls while everything works. The signals are ones the app already has:
 * a live stream that drops, a request or an action that fails the way a network
 * failure does, a gateway answering for a server that is not there. Any of those
 * starts one probe - a read of the build stamp, the smallest route there is and
 * one that needs no session - and only a failed probe turns into "unreachable",
 * with further probes backing off until one succeeds.
 *
 * The probe reads the body rather than trusting the status: a captive portal
 * answers 200 with its own page, and that is not Polaris answering.
 */

/** The route the probe reads. No session, no database: a stamp and nothing else. */
export const PROBE_URL = "/api/version";

/** How long one probe may take before it counts as no answer. */
const PROBE_TIMEOUT_MS = 5000;

/** The waits between probes while Polaris does not answer, the last repeated. */
const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

/** Statuses a proxy answers with on behalf of a server that is not there. */
const GATEWAY = new Set([502, 503, 504]);

export interface Reachability {
    /** False only after a probe went unanswered. */
    readonly reachable: boolean;
    /** Counts the times Polaris came back after being unreachable, so a banner can
     *  say so once per recovery. */
    readonly recoveries: number;
}

let snapshot: Reachability = { reachable: true, recoveries: 0 };
const listeners = new Set<() => void>();
let probing: Promise<boolean> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

function set(next: Reachability): void {
    if (next.reachable === snapshot.reachable && next.recoveries === snapshot.recoveries) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
}

export function reachability(): Reachability {
    return snapshot;
}

/** For `useSyncExternalStore`. Wires the browser's own cues the first time
 *  anything listens: coming back online or to the foreground while Polaris was
 *  unreachable is worth asking again at once rather than waiting out the backoff. */
export function subscribeReachability(listener: () => void): () => void {
    if (listeners.size === 0 && typeof window !== "undefined") {
        window.addEventListener("online", onCue);
        document.addEventListener("visibilitychange", onCue);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || typeof window === "undefined") return;
        window.removeEventListener("online", onCue);
        document.removeEventListener("visibilitychange", onCue);
    };
}

function onCue(): void {
    if (snapshot.reachable || document.visibilityState === "hidden") return;
    void probeNow();
}

/** Whether a thrown error is a request that got no answer, rather than a refusal
 *  the server made. `fetch` rejects with a TypeError when nothing answered, in
 *  every browser; a server action whose request was answered by a proxy's error
 *  page instead of the server says it could not read the response. */
export function isNetworkFailure(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (!(error instanceof Error) || error.name === "AbortError") return false;
    return /failed to fetch|networkerror|load failed|network connection|unexpected response was received/i.test(
        error.message
    );
}

/** A request failed. Starts a probe when it failed the way an unreachable server
 *  makes requests fail. */
export function noteRequestFailure(error: unknown): void {
    if (isNetworkFailure(error)) noteTrouble();
}

/** A response came back. A gateway answering for the server is a reason to ask. */
export function noteResponseStatus(status: number): void {
    if (GATEWAY.has(status)) noteTrouble();
}

/** A live stream lost its connection. */
export function noteStreamTrouble(): void {
    noteTrouble();
}

function noteTrouble(): void {
    // The device being offline is its own banner, and a probe would only confirm it.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    // Already unreachable and waiting to ask again: the backoff decides when.
    if (retry) return;
    void probeNow();
}

/** Ask whether Polaris answers, now. Concurrent callers share one request. */
export function probeNow(): Promise<boolean> {
    if (retry) {
        clearTimeout(retry);
        retry = null;
    }
    probing ??= (async () => {
        const answered = await answers();
        probing = null;
        if (answered) {
            attempt = 0;
            if (!snapshot.reachable) set({ reachable: true, recoveries: snapshot.recoveries + 1 });
            return true;
        }
        set({ ...snapshot, reachable: false });
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        retry = setTimeout(() => {
            retry = null;
            void probeNow();
        }, wait);
        return false;
    })();
    return probing;
}

/** Whether the probe route answers as Polaris does: JSON carrying a build field. */
async function answers(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(PROBE_URL, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return false;
        const body: unknown = await response.json();
        return typeof body === "object" && body !== null && "build" in body;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Back to the first state, for tests. */
export function resetReachability(): void {
    if (retry) clearTimeout(retry);
    retry = null;
    probing = null;
    attempt = 0;
    snapshot = { reachable: true, recoveries: 0 };
    listeners.clear();
}

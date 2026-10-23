/**
 * Whether the server Polaris runs on can reach the internet, as the browser
 * learns it: the `internet` flag `/api/version` answers from the server's offline
 * breaker (`lib/offline/outbound-lookup`).
 *
 * Asked while something is subscribed and the tab is visible: every minute, and
 * every fifteen seconds while the answer is "offline", so the notice goes away
 * soon after the line comes back. A failed ask changes nothing - not reaching
 * Polaris at all is `lib/reachability`'s to say, not this.
 */

const EVERY_MS = 60_000;
const OFFLINE_EVERY_MS = 15_000;

let offline = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let asking = false;
const listeners = new Set<() => void>();

export function hostOffline(): boolean {
    return offline;
}

/** Read one answer of `/api/version`. Exported for the test. */
export function offlineFrom(data: unknown): boolean | null {
    if (!data || typeof data !== "object") return null;
    const internet = (data as { internet?: unknown }).internet;
    return typeof internet === "boolean" ? !internet : null;
}

async function ask(): Promise<void> {
    timer = null;
    asking = true;
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
        try {
            const response = await fetch("/api/version", { cache: "no-store" });
            const next = response.ok ? offlineFrom(await response.json()) : null;
            if (next !== null && next !== offline) {
                offline = next;
                for (const listener of listeners) listener();
            }
        } catch {
            // Nothing answered: the reachability check owns that.
        }
    }
    asking = false;
    if (listeners.size > 0) timer = setTimeout(() => void ask(), offline ? OFFLINE_EVERY_MS : EVERY_MS);
}

export function subscribeHostOffline(listener: () => void): () => void {
    listeners.add(listener);
    if (timer === null && !asking) void ask();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
}

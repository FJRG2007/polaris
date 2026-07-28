/**
 * Shared reading of the public URL a tunnel sidecar announces in its own logs
 * (cloudflared quick tunnels, ngrok). Both helpers exist for the same reason: a
 * sidecar that is up is not the same thing as a URL that works. The process mints
 * a throwaway hostname on every start, and the hostname dies with the process
 * that minted it - while the container, and its whole log, live on.
 */

/** How long a probe may take before the URL counts as dead. Generous enough for a
 *  cold origin, short enough that a status check does not stall the panel. */
const PROBE_TIMEOUT_MS = 5_000;

/** What the edge answers when it has no live tunnel behind a hostname it still
 *  serves, so a response with one of these means published but dead. */
const TUNNEL_DOWN_STATUS = new Set([502, 503, 504, 530]);

/**
 * The most recently announced URL in a sidecar's logs, or null. A restart of the
 * process inside a container that never stopped appends a second URL to the same
 * log, so the first match in the window is the one that is already dead - only the
 * last one can still be live.
 */
export function newestUrl(buffer: string, pattern: RegExp): string | null {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matches = buffer.match(new RegExp(pattern.source, flags));
    return matches?.[matches.length - 1] ?? null;
}

/**
 * Whether the public URL answers right now. Any HTTP status the origin produces
 * counts as reachable - a 404 or a 401 still proves the request crossed the edge
 * and arrived - so only a dead hostname or an edge with nothing behind it fails.
 */
export async function tunnelReachable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, {
            method: "HEAD",
            redirect: "manual",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
        });
        return !TUNNEL_DOWN_STATUS.has(response.status);
    } catch {
        return false;
    }
}

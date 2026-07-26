/**
 * The shape of a quick tunnel's cached Setting value, kept apart from the service
 * that writes it so readers (the domain list on the project page) can decode a
 * stored record without pulling in the docker/deploy machinery.
 */

/** The cached tunnel URL and the container start time it was captured on. */
export interface StoredTunnel {
    url: string | null;
    startedAt: string | null;
}

/** Parse a stored tunnel value. New values are JSON `{url, startedAt}`; an older value
 *  is a bare URL string (or an empty live-but-unknown marker), handled tolerantly. A
 *  null url means the tunnel is live but cloudflared has not printed its URL yet. */
export function parseStoredTunnel(value: string): StoredTunnel {
    if (!value) return { url: null, startedAt: null };
    try {
        const parsed = JSON.parse(value) as { url?: unknown; startedAt?: unknown };
        if (parsed && typeof parsed === "object" && ("url" in parsed || "startedAt" in parsed)) {
            return {
                url: typeof parsed.url === "string" && parsed.url ? parsed.url : null,
                startedAt: typeof parsed.startedAt === "string" && parsed.startedAt ? parsed.startedAt : null
            };
        }
    } catch {
        // Not JSON: an older plain-URL value.
    }
    return { url: value, startedAt: null };
}

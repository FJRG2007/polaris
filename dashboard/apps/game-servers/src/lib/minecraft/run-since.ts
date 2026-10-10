/**
 * When the run a server is on began.
 *
 * The later of two moments: when the activity sweep last saw it come online, and
 * when its last deploy finished - a deploy recreates the container even when the
 * sweep has not looked since. Null when the server is not up at all. What decides
 * whether something changed since the server started is compared against this,
 * so every such notice agrees on what "since it started" means.
 *
 * Pure.
 */

/** When the server's current run began, as the activity sweep recorded it. */
function onlineSince(config: string | null): Date | null {
    try {
        const raw = (JSON.parse(config ?? "{}") as { onlineSince?: unknown }).onlineSince;
        const at = typeof raw === "string" ? new Date(raw) : null;
        return at && !Number.isNaN(at.getTime()) ? at : null;
    } catch {
        return null;
    }
}

export function runSince(config: string | null, deployedAt: Date | null): Date | null {
    const onlineAt = onlineSince(config);
    if (!onlineAt) return null;
    return deployedAt && deployedAt > onlineAt ? deployedAt : onlineAt;
}

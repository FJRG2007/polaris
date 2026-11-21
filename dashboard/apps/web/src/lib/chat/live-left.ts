/** What is left of a live location share, rounded up to the minute so it never reads as over while it still moves. */
export function liveLeft(untilMs: number, nowMs: number): { hours: number; minutes: number } {
    const total = Math.max(0, Math.ceil((untilMs - nowMs) / 60_000));
    return { hours: Math.floor(total / 60), minutes: total % 60 };
}

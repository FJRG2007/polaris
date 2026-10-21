/**
 * How long to wait before reconnecting, after `failures` attempts in a row.
 *
 * Doubles from one second to a minute, with up to a fifth of jitter either way
 * so a Polaris that restarts is not met by every deck in the house at once.
 * Pure: `random` is passed in.
 */
export function backoffMs(failures: number, random: () => number = Math.random): number {
    const base = Math.min(60_000, 1000 * 2 ** Math.max(0, Math.min(failures, 16)));
    const jitter = base * 0.2 * (random() * 2 - 1);
    return Math.round(base + jitter);
}

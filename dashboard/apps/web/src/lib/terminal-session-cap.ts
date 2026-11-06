/**
 * How many long-lived server shells one account may hold at once, on every
 * server together.
 *
 * A setting with a working default in code rather than an environment
 * variable: an installed Polaris only reconciles `.env` on the full edition, so
 * a limit that only exists once a variable appears is one no deployment can
 * change. The web app reads it and hands it to the terminal sidecar with each
 * ticket, since the sidecar cannot read the database.
 */

import { getSetting, setSetting } from "@/lib/setting-store";

export const TERMINAL_SESSION_CAP_KEY = "terminal.sessions.perAccount";
export const DEFAULT_TERMINAL_SESSION_CAP = 10;
export const MAX_TERMINAL_SESSION_CAP = 50;

/** A stored value as a cap, or the default when it is missing or not one. Pure. */
export function parseTerminalSessionCap(stored: string | null): number {
    const n = Number(stored);
    return stored !== null && Number.isInteger(n) && n >= 1 && n <= MAX_TERMINAL_SESSION_CAP
        ? n
        : DEFAULT_TERMINAL_SESSION_CAP;
}

/** The cap in force. A database that cannot be read leaves the default. */
export async function terminalSessionCap(): Promise<number> {
    return parseTerminalSessionCap(await getSetting(TERMINAL_SESSION_CAP_KEY).catch(() => null));
}

/** Store a cap; the default is stored as nothing, so a later change of the
 *  default reaches deployments that never chose one. */
export async function setTerminalSessionCap(cap: number): Promise<void> {
    await setSetting(
        TERMINAL_SESSION_CAP_KEY,
        cap === DEFAULT_TERMINAL_SESSION_CAP ? null : String(cap)
    );
}

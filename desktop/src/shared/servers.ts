/**
 * The Polaris servers this app knows, and which one it opens.
 *
 * The first run asked for one address and File > Change server replaced it, so
 * somebody with a Polaris at home and one at work typed the other address every
 * time they went from one to the other. Now every address opened here is kept
 * in a list with the name somebody gave it, the way the browser extension keeps
 * its servers. Switching only changes which one the windows open: the sign-in
 * on each stays in its own cookies, so going back finds it still signed in.
 *
 * Pure, so the list can be asserted without Electron.
 */

import { readServerAddress } from "./server-address";

/** One server as it is stored: an address, and what somebody called it. */
export interface SavedServer {
    readonly origin: string;
    /** Null until somebody names it; the host is shown until then. */
    readonly name: string | null;
}

/** One server as the servers window draws it. */
export interface ServerRow extends SavedServer {
    readonly host: string;
    /** Whether it is the one the windows are open on. */
    readonly active: boolean;
}

/** The longest name a server may be given. */
export const SERVER_NAME_MAX = 40;

/** How many servers are kept. A list longer than this is not one anybody reads. */
export const SERVERS_MAX = 20;

/** Surrounding space trimmed and inner runs collapsed; empty means "show the host". */
export function normalizeServerName(typed: string): string | null {
    const name = typed.replace(/\s+/g, " ").trim();
    return name === "" ? null : name;
}

/** The list as stored, read leniently: anything malformed or repeated is left out. */
export function readServers(raw: unknown): SavedServer[] {
    if (!Array.isArray(raw)) return [];
    const kept: SavedServer[] = [];
    for (const entry of raw) {
        const value = (entry ?? {}) as { origin?: unknown; name?: unknown; };
        const origin = readServerAddress(value.origin);
        if (!origin || kept.some((server) => server.origin === origin)) continue;
        const name = typeof value.name === "string" ? normalizeServerName(value.name.slice(0, SERVER_NAME_MAX)) : null;
        kept.push({ origin, name });
        if (kept.length === SERVERS_MAX) break;
    }
    return kept;
}

/** The list with this server in it, at the front when it is new. */
export function withServer(saved: readonly SavedServer[], origin: string): SavedServer[] {
    if (saved.some((server) => server.origin === origin)) return [...saved];
    return [{ origin, name: null }, ...saved].slice(0, SERVERS_MAX);
}

export function renameServer(saved: readonly SavedServer[], origin: string, name: string | null): SavedServer[] {
    return saved.map((server) => (server.origin === origin ? { origin, name } : server));
}

export function withoutServer(saved: readonly SavedServer[], origin: string): SavedServer[] {
    return saved.filter((server) => server.origin !== origin);
}

export function listServers(saved: readonly SavedServer[], active: string | null): ServerRow[] {
    return saved.map((server) => ({ ...server, host: new URL(server.origin).host, active: server.origin === active }));
}

/** What a row is called: its name, or its host until it has one. */
export function describeServer(server: Pick<ServerRow, "name" | "host">): string {
    return server.name ?? server.host;
}

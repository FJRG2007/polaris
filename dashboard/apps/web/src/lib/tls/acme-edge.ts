/**
 * The certificate contact address, from the screen to the edge.
 *
 * The address is part of Traefik's static configuration, which it reads once when it
 * starts - its dynamic directory cannot carry it. So it travels the way the call
 * server's key does: the dashboard writes it into a volume both containers mount,
 * the edge's start-up reads it from there, and nothing about it passes through
 * `.env`, which an installed Polaris never rewrites. Taking effect needs the edge to
 * start again, which the host daemon can do; without one (the limited edition) it
 * takes effect the next time the edge starts for any reason, and the screen says so.
 */

import { loadEnv } from "@polaris/config";
import { readFile, stat } from "node:fs/promises";
import { HostdClient } from "@polaris/hostd-client";
import { getSetting, setSetting } from "@/lib/setting-store";
import { dynamicPath, writeDynamicFile } from "@/lib/traefik-dynamic";
import {
    ACME_EMAIL_FILE,
    ACME_EMAIL_SETTING,
    acmeEdgeState,
    resolveAcmeEmail,
    type AcmeEdgeState,
    type AcmeEmailSource
} from "./acme-contact";

/** What the certificate contact card draws. */
export interface AcmeContactStatus {
    /** The address in use; empty for none. */
    readonly email: string;
    readonly source: AcmeEmailSource;
    readonly edge: AcmeEdgeState;
    /** Whether the edge can be restarted from here. */
    readonly canRestart: boolean;
}

/** The address in use, wherever it came from. */
export async function currentAcmeEmail(): Promise<{ email: string; source: AcmeEmailSource }> {
    const stored = await getSetting(ACME_EMAIL_SETTING).catch(() => null);
    return resolveAcmeEmail(stored, loadEnv().POLARIS_ACME_EMAIL);
}

/** The stack's own edge, by its compose labels - its name changes on every
 *  recreate, the labels do not. */
const EDGE_FILTER = encodeURIComponent(
    JSON.stringify({ label: ["com.docker.compose.project=polaris", "com.docker.compose.service=traefik"] })
);

interface EdgeContainer {
    readonly id: string;
    readonly startedAt: number;
    readonly readsFile: boolean;
}

/** The edge container as the daemon sees it, or null when it will not say. */
async function inspectEdge(client: HostdClient): Promise<EdgeContainer | null> {
    const listing = await client.dockerRequest("GET", `/containers/json?all=1&filters=${EDGE_FILTER}`).catch(() => null);
    if (!listing || listing.status !== 200) return null;
    let id: string | null = null;
    try {
        const parsed = JSON.parse(listing.body) as unknown;
        const first = Array.isArray(parsed) ? (parsed[0] as { Id?: unknown } | undefined) : undefined;
        id = typeof first?.Id === "string" ? first.Id : null;
    } catch {
        return null;
    }
    if (!id) return null;
    const inspect = await client.dockerRequest("GET", `/containers/${encodeURIComponent(id)}/json`).catch(() => null);
    if (!inspect || inspect.status !== 200) return null;
    try {
        const body = JSON.parse(inspect.body) as {
            State?: { StartedAt?: unknown };
            Config?: { Entrypoint?: unknown; Cmd?: unknown };
        };
        const startedAt = Date.parse(typeof body.State?.StartedAt === "string" ? body.State.StartedAt : "");
        if (Number.isNaN(startedAt)) return null;
        // The start-up that reads the file names it; one from before it does not.
        const readsFile = JSON.stringify([body.Config?.Entrypoint, body.Config?.Cmd]).includes(ACME_EMAIL_FILE);
        return { id, startedAt, readsFile };
    } catch {
        return null;
    }
}

/** When the address file was last written, or null when there is none. */
async function writtenAt(): Promise<number | null> {
    const info = await stat(dynamicPath(ACME_EMAIL_FILE)).catch(() => null);
    return info?.isFile() ? info.mtimeMs : null;
}

/** The address, and whether the edge is running with it. */
export async function acmeContactStatus(): Promise<AcmeContactStatus> {
    const [current, edge, written] = await Promise.all([
        currentAcmeEmail(),
        inspectEdge(new HostdClient()),
        writtenAt()
    ]);
    return {
        ...current,
        edge: acmeEdgeState({
            startedAt: edge?.startedAt ?? null,
            readsFile: edge?.readsFile ?? false,
            writtenAt: written
        }),
        canRestart: edge !== null
    };
}

/** Write the file the edge reads, only when what it holds differs: its time is how
 *  the screen tells whether the edge has read it, so an unchanged rewrite would
 *  report a restart as needed when none is. */
async function publish(email: string): Promise<void> {
    const present = await readFile(dynamicPath(ACME_EMAIL_FILE), "utf8").catch(() => null);
    if (present !== null && present.trim() === email) return;
    await writeDynamicFile(ACME_EMAIL_FILE, `${email}\n`);
}

/** Keep an address; an empty one is kept as the choice of none. The value has been
 *  through `acmeEmailSchema` already. */
export async function saveAcmeEmail(email: string): Promise<void> {
    await setSetting(ACME_EMAIL_SETTING, email);
    await publish(email);
}

/**
 * Put the chosen address back in the edge's directory, once at start-up, so a
 * volume that was recreated or restored holds it again. Nothing is written when
 * nobody has chosen one: the edge then uses the installer's, the same fallback
 * `currentAcmeEmail` applies.
 */
export async function syncAcmeEmailFile(): Promise<void> {
    const stored = await getSetting(ACME_EMAIL_SETTING);
    if (stored === null) return;
    await publish((await currentAcmeEmail()).email);
}

/**
 * Restart the edge so it reads the address. False when this machine has no daemon
 * to do it. Every domain stops answering for the second or two it takes, including
 * the one this request arrived on - so callers answer first and restart after.
 */
export async function restartEdge(): Promise<boolean> {
    const client = new HostdClient();
    const edge = await inspectEdge(client);
    if (!edge) return false;
    const reply = await client.dockerRequest("POST", `/containers/${encodeURIComponent(edge.id)}/restart`);
    return reply.status === 204 || reply.status === 304;
}

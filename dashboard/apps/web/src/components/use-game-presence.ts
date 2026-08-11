"use client";

/**
 * Who is playing, live, on whatever screen is asking.
 *
 * The server keeps one reading per audience and pushes it when it changes (see
 * `games-presence`); this is the browser half. Every tab on the device shares one
 * connection, so a dashboard open in three places costs the servers exactly what
 * one costs.
 *
 * A screen that also polls for other things keeps doing so - metrics, the roster,
 * the port advice all change slowly and none of them belong here. Presence is the
 * one thing on those screens that moves by itself, and it is the one thing that
 * should not wait for a poll to come round.
 *
 * Each reading carries when it was taken, so a screen holding a second source can
 * tell which of the two is older instead of letting the last writer win.
 */

import { z } from "zod";
import { useEffect, useState } from "react";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";
import type { ServerPresence } from "@/lib/apps/games-service";

const STREAM_PATH = "/api/apps/games/stream";

/**
 * Frames arrive from our own server, but also over a channel shared with tabs
 * that may still be running a previous build of this app - so they are checked
 * rather than trusted.
 */
const readingSchema = z.object({
    at: z.number(),
    servers: z.array(
        z.object({
            id: z.string(),
            answering: z.boolean(),
            containerRunning: z.boolean().nullable(),
            online: z.number(),
            max: z.number(),
            players: z.array(z.object({ name: z.string(), id: z.string().nullable() })),
            message: z.string().nullable()
        })
    )
});

export interface GamePresence {
    /** By installed-app id. Empty until the first frame arrives. */
    readonly servers: ReadonlyMap<string, ServerPresence>;
    /** When the server took the reading, and 0 while there has not been one. */
    readonly at: number;
}

const NOTHING: GamePresence = { servers: new Map(), at: 0 };

/**
 * Follow who is playing.
 *
 * Pass the servers this screen is about - one for a server's own page - so the
 * watcher behind it only reads those. Omit it on a screen showing all of them.
 */
export function useGamePresence(servers?: readonly string[]): GamePresence {
    const scope = useSessionScope();
    // A stable key for an array prop, so a screen that rebuilds the list on every
    // render does not reopen the connection each time.
    const only = servers ? [...servers].sort().join(",") : "";
    const [presence, setPresence] = useState<GamePresence>(NOTHING);

    useEffect(() => {
        const path = only ? `${STREAM_PATH}?${new URLSearchParams({ server: only }).toString()}` : STREAM_PATH;
        return subscribeSharedStream(path, scope, ({ data }) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(data);
            } catch {
                return;
            }
            const reading = readingSchema.safeParse(parsed);
            if (!reading.success) return;
            setPresence({
                at: reading.data.at,
                servers: new Map(reading.data.servers.map((server) => [server.id, server]))
            });
        });
    }, [only, scope]);

    return presence;
}

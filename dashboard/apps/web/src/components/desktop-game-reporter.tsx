"use client";

/**
 * Passes the game the desktop app sees on this computer on to Polaris.
 *
 * A browser cannot see what else is running, so this does nothing anywhere but
 * inside the desktop app, and inside it only in the main window - the app tells
 * that window alone, so two windows open on the Polaris never report twice.
 *
 * The app says when a game starts, when it stops, and once a minute while it
 * runs; every one of those is sent on as it is, and the server decides what is
 * news. The account's own list of programs it calls games is handed to the app
 * on the way in, so a game somebody added from another computer is recognized
 * here too.
 *
 * Nothing is drawn.
 */

import { useEffect } from "react";
import * as core from "@polaris/core";
import type { DesktopGame } from "@/lib/desktop-bridge";
import { useDesktopBridge } from "@/components/desktop-app";

const ENDPOINT = "/api/activity/game";

/** Send one report. A failure is dropped: the next heartbeat is a minute away,
 *  and the card lapsing for a minute is the worst that can come of it. */
function report(game: DesktopGame | null): void {
    void fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ game })
    }).catch(() => undefined);
}

export function DesktopGameReporter() {
    const bridge = useDesktopBridge();

    useEffect(() => {
        if (!bridge?.onGameActivity || !bridge.gameActivity) return;
        let live = true;

        // The programs this account added as games, wherever it added them.
        void fetch(ENDPOINT, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((body: unknown) => {
                const games = core.activitySettingsSchema.shape.customGames.safeParse(
                    (body as { customGames?: unknown } | null)?.customGames ?? []
                );
                if (live && games.success) void bridge.setCustomGames?.(games.data);
            })
            .catch(() => undefined);

        const stop = bridge.onGameActivity(report);
        // What is running already: a page that loaded after the game started
        // has otherwise nothing to say until the next heartbeat.
        void bridge
            .gameActivity()
            .then(({ game, reporter }) => {
                if (live && reporter) report(game);
            })
            .catch(() => undefined);
        return () => {
            live = false;
            stop();
        };
    }, [bridge]);

    return null;
}

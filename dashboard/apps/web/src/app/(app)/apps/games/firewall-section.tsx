"use client";

/**
 * A game server, seen from the firewall.
 *
 * The scope picker lists it as an ordinary service because that is what it is in
 * the deploy tree, and every rule below this point guards HTTP - which a game port
 * is not. So the rules that DO apply to it are put at the top rather than left on
 * the server's own page: an operator who came here to close a server down should
 * not have to be told they came to the wrong screen.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GameAccessEditor } from "@/components/game-access-editor";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { playerAccessAction } from "@/app/(app)/apps/installed/[id]/minecraft-actions";

export interface GamesFirewallSectionProps {
    readonly installedAppId: string;
    /** Which game it plays, or null for one no game in the catalogue claims. */
    readonly game: string | null;
    /** Minecraft's player list, read on the server so it paints with the page. */
    readonly access: PlayerAccessView | null;
}

export function GamesFirewallSection({ installedAppId, game, access }: GamesFirewallSectionProps) {
    if (game === "minecraft")
        return <PlayerListPanel installedAppId={installedAppId} initial={access} />;
    if (game === "fivem") {
        return (
            <p className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
                A FiveM server is guarded by its own list of players rather than by the rules below
                - a game port does not go through the web firewall.{" "}
                <Link
                    href={`/apps/installed/${installedAppId}/security`}
                    className="text-primary hover:underline"
                >
                    Open who may join
                </Link>
                . Addresses blocked here are carried onto that list as well.
            </p>
        );
    }
    if (game === "ark") {
        return (
            <p className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
                An ARK server is guarded by its join password and its own allow list of Steam ids,
                not by the rules below.{" "}
                <Link
                    href={`/apps/installed/${installedAppId}/security`}
                    className="text-primary hover:underline"
                >
                    Open who may join
                </Link>
                .
            </p>
        );
    }
    return null;
}

function PlayerListPanel({
    installedAppId,
    initial
}: {
    installedAppId: string;
    /** Read on the server, so the list is painted with the page rather than after it. */
    initial: PlayerAccessView | null;
}) {
    const [access, setAccess] = useState<PlayerAccessView | null>(initial);

    const reload = useCallback(() => {
        void playerAccessAction(installedAppId).then(setAccess);
    }, [installedAppId]);

    // Only when the page opened without it - the server read is the normal path and
    // re-fetching what was just handed over would be a wasted round trip.
    useEffect(() => {
        if (initial === null) reload();
    }, [initial, reload]);

    return <GameAccessEditor installedAppId={installedAppId} access={access} onChanged={reload} />;
}

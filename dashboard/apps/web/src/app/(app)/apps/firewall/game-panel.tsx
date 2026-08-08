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

import { useCallback, useEffect, useState } from "react";
import { GameAccessEditor } from "@/components/game-access-editor";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { playerAccessAction } from "@/app/(app)/apps/installed/[id]/minecraft-actions";

export function GameFirewallPanel({
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

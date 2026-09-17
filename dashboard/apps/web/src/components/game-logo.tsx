/**
 * A game's own mark, from its publisher.
 *
 * Catalog presentation rather than part of Game servers: the overview and the
 * marketplace show it whether or not the app is installed. Decoration beside a
 * name that is already written out, so it is hidden from a screen reader rather
 * than described twice.
 */

import { cn } from "@polaris/ui";
import type { GameDefinition } from "@/lib/apps/games-catalog";

export function GameLogo({ game, className }: { game: GameDefinition; className?: string }) {
    return (
        // eslint-disable-next-line @next/next/no-img-element -- a small static logo served by the dashboard
        <img
            src={game.logo}
            alt=""
            aria-hidden
            className={cn("shrink-0 object-contain", className)}
        />
    );
}

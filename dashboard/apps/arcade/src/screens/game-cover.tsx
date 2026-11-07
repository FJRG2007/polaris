"use client";

/**
 * A game's cover at the top of its library card, 16:9. A game with no cover
 * (or one that fails to load) shows a placeholder that reads as one - its icon
 * and "No cover yet" - never a stand-in picture.
 */

import { useState } from "react";
import { useArcadeT } from "./i18n";
import { gameCoverSrc } from "../games/registry";
import type { GameDefinition } from "../games/types";

export function GameCover({ game }: { game: GameDefinition }) {
    const t = useArcadeT();
    const src = gameCoverSrc(game);
    const [failed, setFailed] = useState(false);
    const Icon = game.icon;
    if (src && !failed) {
        return (
            <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setFailed(true)}
                className="aspect-video w-full border-b border-border bg-muted object-cover"
            />
        );
    }
    return (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 border-b border-dashed border-border bg-muted text-muted-foreground">
            <Icon className="h-10 w-10 shrink-0" aria-hidden />
            <span className="max-w-full truncate px-4 text-xs">{t("coverMissing")}</span>
        </div>
    );
}

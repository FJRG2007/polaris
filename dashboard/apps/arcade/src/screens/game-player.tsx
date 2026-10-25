"use client";

/** One game, full screen, with the way back to the library above it. */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useArcadeT } from "./i18n";
import { GameFrame } from "./game-frame";
import { findGame } from "../games/registry";

export function GamePlayer({ gameId }: { gameId: string }) {
    const t = useArcadeT();
    const router = useRouter();
    const game = findGame(gameId);
    if (!game) return null;
    const Icon = game.icon;
    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
            <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t(`games.${game.id}.name` as never)}
                </h1>
                <Link
                    href="/games"
                    aria-label={t("close")}
                    title={t("close")}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"
                >
                    <X className="h-4 w-4" aria-hidden />
                </Link>
            </header>
            <div className="min-h-0 flex-1">
                <GameFrame game={game} onExit={() => router.push("/games")} />
            </div>
        </div>
    );
}

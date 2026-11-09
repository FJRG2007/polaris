"use client";

/** The Games library: every game and the way into each, and the way to use
 *  this phone as the controller of a game open on another screen. Rooms are
 *  not here: each game with rooms offers them on its own page; its card says
 *  only that it has them and how many public ones are open. */

import Link from "next/link";
import { useArcadeT } from "./i18n";
import { GameCover } from "./game-cover";
import { useEffect, useState } from "react";
import { GAMES } from "../games/registry";
import { Gamepad2, Play } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import { Badge, Button, Card, CardBody } from "@polaris/ui";

type Counts = { ok: true; counts: Readonly<Record<string, number>> } | { ok: false };

export function GamesScreen({ together }: { together: boolean }) {
    const t = useArcadeT();
    const shown = GAMES;
    const withRooms = together && shown.some((game) => game.rooms);
    const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});

    useEffect(() => {
        if (!withRooms) return;
        let live = true;
        void (hostUi.arcadeRooms.publicRoomCounts() as Promise<Counts>)
            .then((answer) => live && answer.ok && setCounts(answer.counts))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [withRooms]);

    return (
        <div className="mx-auto w-full max-w-5xl px-4 py-6">
            <div className="flex min-w-0 flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                    <h1 className="text-xl font-semibold">{t("title")}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t("intro")}</p>
                </div>
                <Button asChild variant="outline" className="max-sm:w-full">
                    <Link href="/games/pad" title={t("phonePadIntro")}>
                        <Gamepad2 className="h-4 w-4" aria-hidden />
                        {t("phonePad")}
                    </Link>
                </Button>
            </div>
            {shown.length === 0 ? (
                <p className="mt-6 text-sm text-muted-foreground">{t("empty")}</p>
            ) : (
                <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {shown.map((game) => {
                        const Icon = game.icon;
                        const open = counts[game.id] ?? 0;
                        return (
                            <li key={game.id} className="min-w-0">
                                <Card className="overflow-hidden">
                                    <GameCover game={game} />
                                    <CardBody className="flex min-w-0 flex-col gap-3">
                                        <div className="flex min-w-0 items-center gap-3">
                                            <Icon className="h-8 w-8 shrink-0" aria-hidden />
                                            <div className="min-w-0">
                                                <p className="truncate font-medium">
                                                    {t(`games.${game.id}.name` as never)}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {game.multiplayer
                                                        ? t("multiplayer")
                                                        : t("solo")}
                                                </p>
                                            </div>
                                        </div>
                                        {game.rooms && (
                                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                <Badge>{t("multiplayerBadge")}</Badge>
                                                {together && open > 0 && (
                                                    <span className="text-xs text-muted-foreground">
                                                        {t("openRooms", { count: open })}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        <p className="text-sm text-muted-foreground">
                                            {t(`games.${game.id}.summary` as never)}
                                        </p>
                                        <Button asChild size="sm" className="self-start">
                                            <Link href={`/games/${game.id}`}>
                                                <Play className="h-4 w-4" aria-hidden />
                                                {t("play")}
                                            </Link>
                                        </Button>
                                    </CardBody>
                                </Card>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

"use client";

/** The Games library: every game, the way into each, and - for whoever may
 *  play with others - rooms to play the multiplayer ones together. */

import Link from "next/link";
import { Play } from "lucide-react";
import { useArcadeT } from "./i18n";
import { GameCover } from "./game-cover";
import { GAMES } from "../games/registry";
import { Button, Card, CardBody } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";

export function GamesScreen({ together }: { together: boolean }) {
    const t = useArcadeT();
    const shown = GAMES;
    const multiplayer = shown
        .filter((game) => game.multiplayer)
        .map((game) => ({ id: game.id, name: t(`games.${game.id}.name` as never) }));
    const Rooms = hostUi.arcadeRooms.GameRooms;
    return (
        <div className="mx-auto w-full max-w-5xl px-4 py-6">
            <h1 className="text-xl font-semibold">{t("title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("intro")}</p>
            {shown.length === 0 ? (
                <p className="mt-6 text-sm text-muted-foreground">{t("empty")}</p>
            ) : (
                <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {shown.map((game) => {
                        const Icon = game.icon;
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
            {multiplayer.length > 0 && (
                <section className="mt-10 min-w-0" aria-labelledby="games-together">
                    <h2 id="games-together" className="text-lg font-semibold">
                        {t("together")}
                    </h2>
                    {together ? (
                        <>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {t("togetherIntro")}
                            </p>
                            <div className="mt-4">
                                <Rooms games={multiplayer} />
                            </div>
                        </>
                    ) : (
                        <p className="mt-1 text-sm text-muted-foreground">{t("togetherDenied")}</p>
                    )}
                </section>
            )}
        </div>
    );
}

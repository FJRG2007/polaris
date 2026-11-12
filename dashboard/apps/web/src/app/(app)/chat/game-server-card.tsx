"use client";

/**
 * The card a person gets when they are let onto a game server: the server and
 * its game, the address with a copy button, Join where the game takes a link,
 * and a fold-out guide for somebody who has never joined one.
 */

import Link from "next/link";
import { Gamepad2 } from "lucide-react";
import { findGame } from "@polaris/core";
import { useEffect, useState } from "react";
import { GameLogo } from "@/components/game-logo";
import { MessageTime } from "@/components/message-time";
import { Button, CopyButton, Skeleton } from "@polaris/ui";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { splitAddress, type GameServerCardView } from "@/lib/chat/game-server-card";

export function GameServerCard({
    serverId,
    message
}: {
    serverId: string;
    message: ChatMessageView;
}) {
    const t = useTranslations("chat");
    const [view, setView] = useState<GameServerCardView | null | undefined>(undefined);

    useEffect(() => {
        let live = true;
        // Loaded with the card rather than with every conversation: the list
        // renders without pulling the server's session code in.
        void import("./game-server-card-actions")
            .then(({ readGameServerCard }) => readGameServerCard(serverId))
            .then((found) => {
                if (live) setView(found);
            })
            .catch(() => {
                if (live) setView(null);
            });
        return () => {
            live = false;
        };
        // The message object is replaced whenever it is woken: read it again.
    }, [serverId, message]);

    if (view === null) return null;
    const ready = view?.state === "ready" ? view : null;
    const definition = ready?.game ? findGame(ready.game) : undefined;
    const parts = ready?.address ? splitAddress(ready.address) : null;
    const facts = ready
        ? [
              definition?.name ?? t("gameServerCard.gameServer"),
              ready.release ? t("gameServerCard.version", { version: ready.release }) : null,
              ready.running ? null : t("gameServerCard.stopped")
          ]
              .filter(Boolean)
              .join(" - ")
        : t("gameServerCard.gameServer");

    return (
        <div className="py-1 pl-14 pr-4">
            <div className="flex min-w-0 max-w-md flex-col gap-2 rounded-md border bg-card p-3">
                <div className="flex min-w-0 items-center gap-3">
                    {definition ? (
                        <GameLogo game={definition} className="size-8 shrink-0" />
                    ) : (
                        <Gamepad2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                        {view === undefined ? (
                            <Skeleton className="h-4 w-40" />
                        ) : ready ? (
                            <p className="truncate text-sm font-medium" title={ready.name}>
                                {ready.name}
                            </p>
                        ) : (
                            <p className="text-sm">{t("gameServerCard.denied")}</p>
                        )}
                        <p className="truncate text-xs text-muted-foreground">
                            {facts} <MessageTime iso={message.createdAt} />
                        </p>
                    </div>
                    {ready?.joinLink && (
                        <Button size="sm" asChild>
                            <a href={ready.joinLink}>{t("callGames.join")}</a>
                        </Button>
                    )}
                </div>
                {ready && (
                    <>
                        {ready.address ? (
                            <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2 py-1">
                                <code
                                    className="min-w-0 flex-1 truncate font-mono text-xs"
                                    title={ready.address}
                                >
                                    {ready.address}
                                </code>
                                <CopyButton
                                    value={ready.address}
                                    label={t("gameServerCard.copyAddress")}
                                />
                            </div>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                {t("gameServerCard.noAddress")}
                            </p>
                        )}
                        <details className="text-xs">
                            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                                {t("gameServerCard.howToJoin")}
                            </summary>
                            <p className="mt-1.5 whitespace-pre-line leading-relaxed">
                                {t(`gameServerCard.guide.${ready.guide}`, {
                                    address: ready.address ?? "-",
                                    host: parts?.host ?? "-",
                                    port: parts?.port ?? "-",
                                    name: ready.name,
                                    version: ready.release ?? "-"
                                })}
                            </p>
                        </details>
                        <Link
                            href={ready.href}
                            className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                        >
                            {t("gameServerCard.open")}
                        </Link>
                    </>
                )}
            </div>
        </div>
    );
}

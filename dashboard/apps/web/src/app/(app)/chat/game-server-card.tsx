"use client";

/**
 * The card a person gets when they are let onto a game server: the server and
 * its game, the address with a copy button, Join where the game takes a link,
 * and a fold-out guide for somebody who has never joined one.
 *
 * Two messages draw it. A line Polaris wrote when somebody was let onto the
 * server's page, and the invite a player gets from whoever added them, which
 * sits in that person's own row like a Discord server invite and also says who
 * to join as and from where.
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
import type { NamespaceTranslator } from "@/lib/i18n/types";
import {
    splitAddress,
    type GameInvite,
    type GameInviteCardView,
    type GamePlayerJoinFrom,
    type GameServerCardView
} from "@/lib/chat/game-server-card";

type ReadyView = Extract<GameServerCardView, { state: "ready" }>;

/** Read once per card, with the card rather than with every conversation, so
 *  the list renders without pulling the server's session code in. Read again
 *  whenever `again` changes - a woken message is a new object. */
function useCardView<T>(read: () => Promise<T | null>, keys: readonly unknown[]) {
    const [view, setView] = useState<T | null | undefined>(undefined);
    useEffect(() => {
        let live = true;
        read()
            .then((found) => {
                if (live) setView(found);
            })
            .catch(() => {
                if (live) setView(null);
            });
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys are what the read depends on
    }, keys);
    return view;
}

export function GameServerCard({
    serverId,
    message
}: {
    serverId: string;
    message: ChatMessageView;
}) {
    const view = useCardView(
        () => import("./game-server-card-actions").then((actions) => actions.readGameServerCard(serverId)),
        [serverId, message]
    );
    if (view === null) return null;
    return (
        <div className="py-1 ps-14 pe-4">
            <ServerPanel view={view} message={message} canOpen />
        </div>
    );
}

/** The invite a player got from whoever added them, drawn in that person's row. */
export function GameInviteCard({
    invite,
    message
}: {
    invite: GameInvite;
    message: ChatMessageView;
}) {
    const t = useTranslations("chat");
    const view = useCardView<GameInviteCardView>(
        () =>
            import("./game-server-card-actions").then((actions) =>
                actions.readGameInviteCard(invite.installedAppId, invite.player)
            ),
        [invite.installedAppId, invite.player, message]
    );
    if (view === null) return null;
    const ready = view?.state === "ready" ? view : null;
    return (
        <div className="mt-1" aria-label={t("gameServerCard.invite.label")}>
            <ServerPanel
                view={view}
                message={null}
                canOpen={ready?.canOpen ?? false}
                invite={ready ? { player: ready.player, joinFrom: ready.joinFrom } : undefined}
                sender={message.authorName}
            />
        </div>
    );
}

function ServerPanel({
    view,
    message,
    canOpen,
    invite,
    sender
}: {
    view: GameServerCardView | undefined;
    /** The message to time the card by, when the row around it does not. */
    message: ChatMessageView | null;
    canOpen: boolean;
    invite?: { player: string; joinFrom: GamePlayerJoinFrom | null };
    sender?: string | null;
}) {
    const t = useTranslations("chat");
    const ready: ReadyView | null = view?.state === "ready" ? view : null;
    const definition = ready?.game ? findGame(ready.game) : undefined;
    const parts = ready?.address ? splitAddress(ready.address) : null;
    const facts = ready
        ? [
              definition?.name ?? t("gameServerCard.gameServer"),
              ready.release ? t("gameServerCard.version", { version: ready.release }) : null,
              invite ? null : ready.running ? null : t("gameServerCard.stopped")
          ]
              .filter(Boolean)
              .join(" - ")
        : t("gameServerCard.gameServer");

    return (
        <div className="flex w-full min-w-0 max-w-md flex-col gap-2 rounded-md border bg-card p-3">
            <div className="flex min-w-0 items-center gap-3">
                {definition ? (
                    <GameLogo game={definition} className="size-10 shrink-0 rounded-md" />
                ) : (
                    <Gamepad2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                    {view === undefined ? (
                        <Skeleton className="h-4 w-40 max-w-full" />
                    ) : ready ? (
                        <p className="truncate text-sm font-medium" title={ready.name}>
                            {ready.name}
                        </p>
                    ) : (
                        <p className="text-sm">{t("gameServerCard.denied")}</p>
                    )}
                    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {invite && ready && (
                            <span className="inline-flex shrink-0 items-center gap-1">
                                <span
                                    aria-hidden
                                    className={`size-2 rounded-full ${ready.running ? "bg-success" : "bg-muted-foreground"}`}
                                />
                                {ready.running
                                    ? t("gameServerCard.invite.running")
                                    : t("gameServerCard.stopped")}
                                <span aria-hidden>-</span>
                            </span>
                        )}
                        <span className="min-w-0 truncate" title={facts}>{facts}</span>
                        {message && <MessageTime iso={message.createdAt} inline />}
                    </p>
                </div>
                {ready?.joinLink && (
                    <Button size="sm" asChild className="shrink-0">
                        <a href={ready.joinLink}>
                            {invite ? t("gameServerCard.invite.play") : t("callGames.join")}
                        </a>
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
                    {invite && (
                        <div className="min-w-0 text-xs">
                            <p className="break-words font-medium">
                                {t("gameServerCard.invite.joinAs", { player: invite.player })}
                            </p>
                            {invite.joinFrom && (
                                <p className="break-words text-muted-foreground">
                                    {joinFromText(invite.joinFrom, sender ?? "", t)}
                                </p>
                            )}
                        </div>
                    )}
                    <details className="text-xs">
                        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                            {t("gameServerCard.howToJoin")}
                        </summary>
                        <p className="mt-1.5 whitespace-pre-line break-words leading-relaxed">
                            {t(`gameServerCard.guide.${ready.guide}`, {
                                address: ready.address ?? "-",
                                host: parts?.host ?? "-",
                                port: parts?.port ?? "-",
                                name: ready.name,
                                version: ready.release ?? "-"
                            })}
                        </p>
                    </details>
                    {canOpen && (
                        <Link
                            href={ready.href}
                            className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                        >
                            {invite ? t("gameServerCard.invite.openServer") : t("gameServerCard.open")}
                        </Link>
                    )}
                </>
            )}
        </div>
    );
}

function joinFromText(
    from: GamePlayerJoinFrom,
    sender: string,
    t: NamespaceTranslator<"chat">
): string {
    switch (from.kind) {
        case "signIns":
            return t("gameServerCard.invite.fromSignIns");
        case "anywhere":
            return t("gameServerCard.invite.fromAnywhere");
        case "addresses":
            return t("gameServerCard.invite.fromAddresses", { addresses: from.addresses.join(", ") });
        case "ask":
            return t("gameServerCard.invite.fromAsk", { name: sender });
    }
}

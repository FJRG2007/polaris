"use client";

/**
 * A game lobby: the game somebody was invited to, played with no call - the
 * way a game launcher's invite works. The page asks for a ticket into the
 * lobby's data-only room, the game claims its seat as soon as it is in, and
 * the reader can invite more people from here. Leaving goes back to the
 * conversation; the last player out ends the session and its card says so.
 *
 * The heading and the way back are on screen at once; only the game waits.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import * as lobby from "./lobby-actions";
import { useRouter } from "next/navigation";
import { ArrowLeft, Joystick } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useLobbyRoom, type LobbyTicket } from "./use-lobby-room";
import { GameInviteDialog } from "@/components/arcade/game-invite-dialog";
import { CallGamesPanel, useCallActivity, type ActivityApi } from "./call-activity-panel";

const API: ActivityApi = {
    callGames: lobby.lobbyGames,
    claimCallGame: lobby.claimLobbyGame,
    renewCallGame: lobby.renewLobbyGame,
    leaveCallGame: lobby.leaveLobbyGame,
    vouchCallGames: lobby.vouchLobbyGames
};

export function GameLobby({ sessionId }: { sessionId: string }) {
    const t = useTranslations("chat");
    const router = useRouter();
    const [entry, setEntry] = useState<lobby.LobbyEntry | null>(null);
    const [left, setLeft] = useState(false);
    const [inviting, setInviting] = useState(false);

    useEffect(() => {
        let live = true;
        void lobby
            .enterLobby(sessionId)
            .then((answer) => live && setEntry(answer))
            .catch(() => live && setEntry({ ok: false, reason: "server" }));
        return () => {
            live = false;
        };
    }, [sessionId]);

    const ticket = useMemo<LobbyTicket | null>(
        () =>
            entry?.ok && !left ? { url: entry.url, token: entry.token, seat: entry.seat } : null,
        [entry, left]
    );
    const room = useLobbyRoom(ticket);
    const activity = useCallActivity(sessionId, room, ticket !== null, API);

    // In the lobby is playing: the seat is claimed as soon as the server says
    // the reader may, once.
    const claimed = useRef(false);
    const game = entry?.ok ? entry.game : null;
    useEffect(() => {
        if (!game || claimed.current || left || activity.answer?.ok !== true) return;
        claimed.current = true;
        activity.play(game);
    }, [game, left, activity]);

    const back = entry?.ok && entry.member ? `/chat/c/${entry.channelId}` : "/chat";
    const leave = () => {
        activity.leave();
        setLeft(true);
        router.push(back);
    };
    const name = game ? (activity.gameName(game) ?? t("callGames.someGame")) : null;
    const problem = !entry
        ? null
        : !entry.ok
          ? t(`lobby.refused.${entry.reason}`)
          : room.status === "failed"
            ? t("lobby.refused.server")
            : null;

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-3 sm:p-4">
            <header className="flex min-w-0 items-center gap-2">
                <Button asChild size="sm" variant="ghost">
                    <Link href={back}>
                        <ArrowLeft className="size-4" />
                        {t("lobby.back")}
                    </Link>
                </Button>
                <Joystick className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={name ?? ""}>
                    {name ?? t("lobby.title")}
                </h1>
            </header>
            {problem ? (
                <p role="alert" className="text-sm text-muted-foreground">
                    {problem}
                </p>
            ) : activity.session && activity.playing ? (
                <CallGamesPanel
                    activity={{ ...activity, focused: true }}
                    onInvite={() => setInviting(true)}
                    onLeave={leave}
                />
            ) : (
                <div
                    className="flex min-h-[16rem] flex-1 animate-pulse items-center justify-center rounded-md border bg-muted/40 text-sm text-muted-foreground"
                    aria-busy
                >
                    {t("callGames.checking")}
                </div>
            )}
            {inviting && game && (
                <GameInviteDialog
                    sessionId={sessionId}
                    game={game}
                    gameName={name ?? ""}
                    onClose={() => setInviting(false)}
                />
            )}
        </div>
    );
}

"use client";

/**
 * The line a conversation shows for a game played in its call: the game, who
 * is playing, and Join - or why not. Read again whenever its message is woken
 * (somebody joined, left, or the game ended) and every half minute while the
 * game runs, so a session nobody closed still ends on screen.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Joystick } from "lucide-react";
import { Button } from "@polaris/ui";
import { Avatar } from "@/components/avatar";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ActivityCardView, JoinRefusal } from "@/lib/chat/activity-card";
import { formatElapsed } from "@polaris/core";
import { readActivityCard } from "./activity-card-actions";
import { requestActivityJoin } from "./activity-join";
import { useCallHold } from "./call-hold";
import { MessageTime } from "@/components/message-time";

const REFRESH_MS = 30_000;

export function ActivityCard({
    sessionId,
    message
}: {
    sessionId: string;
    message: ChatMessageView;
}) {
    const t = useTranslations("chat");
    const router = useRouter();
    const { session } = useCallHold();
    const [view, setView] = useState<ActivityCardView | null | undefined>(undefined);

    useEffect(() => {
        let live = true;
        let timer: number | undefined;
        const read = () =>
            void readActivityCard(sessionId)
                .then((found) => {
                    if (!live) return;
                    setView(found);
                    if (!found || found.ended) window.clearInterval(timer);
                    else if (timer === undefined) timer = window.setInterval(read, REFRESH_MS);
                })
                .catch(() => undefined);
        read();
        return () => {
            live = false;
            window.clearInterval(timer);
        };
        // The message object is replaced whenever it is woken, which is the
        // signal to read the card again.
    }, [sessionId, message]);

    if (view === null) return null;
    const otherCall = Boolean(
        view && view.meetingId !== null && session && session.meetingId !== view.meetingId
    );
    const reason: string | null = !view
        ? null
        : view.refusal
          ? refusalText(t, view.refusal)
          : otherCall
            ? t("activityCard.otherCall")
            : null;
    const game = view?.gameName || t("callGames.someGame");
    const starter = view?.startedBy.name || t("callGames.someone");

    const join = () => {
        if (!view) return;
        // A lobby has no call: straight in, nothing rings.
        if (view.meetingId === null) router.push(view.href);
        else if (session?.meetingId === view.meetingId)
            requestActivityJoin(view.meetingId, view.game);
        else router.push(view.href);
    };

    return (
        <div className="py-1 pl-14 pr-4">
            <div className="flex min-w-0 max-w-md flex-wrap items-center gap-3 rounded-md border bg-card p-3">
                <Joystick className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                    <p
                        className="truncate text-sm"
                        title={t("activityCard.started", { name: starter, game })}
                    >
                        {view
                            ? t("activityCard.started", { name: starter, game })
                            : t("callGames.checking")}
                    </p>
                    {view && (
                        <p className="truncate text-xs text-muted-foreground">
                            {view.ended
                                ? endedLine(t, view)
                                : t("activityCard.players", {
                                      count: view.playing,
                                      max: view.max
                                  })}{" "}
                            <MessageTime iso={message.createdAt} />
                        </p>
                    )}
                    {view && !view.ended && view.players.length > 0 && (
                        <ul
                            className="mt-1.5 flex min-w-0 -space-x-1.5"
                            aria-label={t("activityCard.whoIsPlaying")}
                        >
                            {view.players.map((player) => (
                                <li
                                    key={player.id}
                                    title={player.name}
                                    className="rounded-full ring-2 ring-card"
                                >
                                    <Avatar
                                        person={{ id: player.id, name: player.name }}
                                        size={20}
                                        status={false}
                                    />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {view && !view.ended && (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                        <Button
                            size="sm"
                            disabled={
                                reason !== null ||
                                (view.inGame && session?.meetingId === view.meetingId)
                            }
                            title={reason ?? undefined}
                            onClick={join}
                        >
                            {view.inGame && session?.meetingId === view.meetingId
                                ? t("activityCard.playing")
                                : t("callGames.join")}
                        </Button>
                        {reason && (
                            <span className="max-w-48 text-right text-xs text-muted-foreground">
                                {reason}
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

/** "Ended - 12:04 - played by A, B", or "Invitation expired" for a session
 *  nobody ever joined. */
function endedLine(t: ReturnType<typeof useTranslations<"chat">>, view: ActivityCardView): string {
    if (view.played.length === 0) return t("activityCard.expired");
    const names = view.played
        .map((person) => person.name)
        .filter(Boolean)
        .join(", ");
    return t("activityCard.endedPlayed", {
        time: formatElapsed(view.durationMs ?? 0),
        names
    });
}

function refusalText(t: ReturnType<typeof useTranslations<"chat">>, reason: JoinRefusal): string {
    if (reason === "denied") return t("callGames.denied");
    if (reason === "missing") return t("callGames.missing");
    if (reason === "full") return t("activityCard.full");
    return t("activityCard.ended");
}

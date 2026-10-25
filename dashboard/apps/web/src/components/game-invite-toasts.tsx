"use client";

/**
 * Somebody invited you to play - the launcher's toast: who, which game, Join
 * and Decline. No call and no ringing: an invitation to play is not a phone
 * call. Mounted by the dashboard shell beside the incoming calls, so it reaches
 * whoever is reading anything, and woken by the chat stream's `game-invite`
 * frame; read again on mount, so a reload still shows what is open. An
 * invitation leaves the screen when it expires, is declined, or its session
 * ends.
 */

import { Button } from "@polaris/ui";
import { Joystick } from "lucide-react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { useCallback, useEffect, useState } from "react";
import { useChatStream } from "@/app/(app)/chat/use-chat-stream";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    declineGameInvite,
    pendingGameInvites,
    type PendingInvite
} from "@/app/(app)/chat/activity-card-actions";

/** How often what is shown is checked against the server while any is up, so
 *  an invitation to a session that ended goes away. */
const RECHECK_MS = 60_000;

export function GameInviteToasts() {
    const t = useTranslations("chat");
    const router = useRouter();
    const [invites, setInvites] = useState<readonly PendingInvite[]>([]);

    const read = useCallback(() => {
        void pendingGameInvites()
            .then(setInvites)
            .catch(() => undefined);
    }, []);
    useEffect(read, [read]);
    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind === "game-invite") read();
            },
            [read]
        )
    );

    // Gone when it expires, and checked again while any is up.
    const showing = invites.length > 0;
    useEffect(() => {
        if (!showing) return;
        const timer = window.setInterval(() => {
            const now = Date.now();
            setInvites((was) => {
                const kept = was.filter((one) => Date.parse(one.expiresAt) > now);
                return kept.length === was.length ? was : kept;
            });
            read();
        }, RECHECK_MS);
        return () => window.clearInterval(timer);
    }, [showing, read]);

    const drop = (sessionId: string) =>
        setInvites((was) => was.filter((one) => one.sessionId !== sessionId));

    if (invites.length === 0) return null;
    return (
        <ul
            className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
            aria-label={t("gameInvites.label")}
        >
            {invites.slice(0, 3).map((invite) => {
                const game = invite.gameName || t("callGames.someGame");
                const from = invite.from.name || t("callGames.someone");
                return (
                    <li
                        key={invite.sessionId}
                        role="status"
                        className="pointer-events-auto flex min-w-0 items-center gap-3 rounded-md border bg-card p-3 shadow-lg"
                    >
                        <Avatar
                            person={{ id: invite.from.id, name: from }}
                            size={32}
                            status={false}
                        />
                        <div className="min-w-0 flex-1">
                            <p
                                className="truncate text-sm"
                                title={t("activityCard.invited", { name: from, game })}
                            >
                                {t("activityCard.invited", { name: from, game })}
                            </p>
                            <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Joystick className="size-3" aria-hidden />
                                {t(invite.inCall ? "gameInvites.inCall" : "gameInvites.noCall")}
                            </p>
                            <div className="mt-2 flex gap-2">
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        drop(invite.sessionId);
                                        router.push(invite.href);
                                    }}
                                >
                                    {t("callGames.join")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                        drop(invite.sessionId);
                                        void declineGameInvite(invite.sessionId).catch(
                                            () => undefined
                                        );
                                    }}
                                >
                                    {t("gameInvites.decline")}
                                </Button>
                            </div>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}

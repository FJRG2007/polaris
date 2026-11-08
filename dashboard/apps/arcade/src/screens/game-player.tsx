"use client";

/**
 * One game, full screen, with the way back to the library above it - and, for
 * a game played together, Invite: it opens the game in a call with whoever was
 * invited (the dashboard's own dialog, see `arcadeInvite` in the host's pieces) -
 * and, for a game whose definition declares rooms, Play with others: the
 * host's rooms for this game (`arcadeRooms`), from the bar or from the game's
 * own start screen, off with the reason for whoever may not play with others.
 * Full screen hands the game the whole display; Escape gives it back.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useArcadeT } from "./i18n";
import { GameFrame } from "./game-frame";
import { findGame } from "../games/registry";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useRef, useState } from "react";
import { Expand, Shrink, UserPlus, Users, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";

type InviteAccess = { ok: true } | { ok: false; reason: "denied" | "missing" };

const ICON_BUTTON =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent";

export function GamePlayer({ gameId, together }: { gameId: string; together: boolean }) {
    const t = useArcadeT();
    const router = useRouter();
    const game = findGame(gameId);
    const stage = useRef<HTMLDivElement | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [canFullscreen, setCanFullscreen] = useState(false);
    const [access, setAccess] = useState<InviteAccess | null>(null);
    const [inviting, setInviting] = useState(false);
    const [roomsOpen, setRoomsOpen] = useState(false);
    const multiplayer = game?.multiplayer ?? false;

    useEffect(() => {
        setCanFullscreen(document.fullscreenEnabled);
        const read = () =>
            setFullscreen(stage.current !== null && document.fullscreenElement === stage.current);
        document.addEventListener("fullscreenchange", read);
        return () => document.removeEventListener("fullscreenchange", read);
    }, []);

    useEffect(() => {
        if (!multiplayer) return;
        let live = true;
        void (hostUi.arcadeInvite.gameInviteAccess() as Promise<InviteAccess>)
            .then((found) => live && setAccess(found))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [multiplayer]);

    if (!game) return null;
    const Icon = game.icon;
    const name = t(`games.${game.id}.name` as never);
    const InviteDialog = hostUi.arcadeInvite.GameInviteDialog;
    const inviteRefused =
        access && !access.ok
            ? access.reason === "denied"
                ? t("inviteDenied")
                : t("inviteMissing")
            : null;
    const fullscreenLabel = fullscreen ? t("exitFullscreen") : t("fullscreen");
    const hasRooms = Boolean(game.rooms);
    const Rooms = hostUi.arcadeRooms.GameRooms;
    const showRooms = () => {
        // The rooms are drawn by the page, over the game: full screen would hide them
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        setRoomsOpen(true);
    };

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
            <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
                    {name}
                </h1>
                {hasRooms && (
                    <button
                        type="button"
                        onClick={showRooms}
                        disabled={!together}
                        aria-label={t("together")}
                        title={together ? t("together") : t("togetherDenied")}
                        className={ICON_BUTTON}
                    >
                        <Users className="h-4 w-4" aria-hidden />
                    </button>
                )}
                {multiplayer && access && (
                    <button
                        type="button"
                        onClick={() => setInviting(true)}
                        disabled={!access.ok}
                        aria-label={t("invite")}
                        title={inviteRefused ?? t("invite")}
                        className={ICON_BUTTON}
                    >
                        <UserPlus className="h-4 w-4" aria-hidden />
                    </button>
                )}
                {canFullscreen && (
                    <button
                        type="button"
                        onClick={() => {
                            if (fullscreen) void document.exitFullscreen().catch(() => undefined);
                            else void stage.current?.requestFullscreen().catch(() => undefined);
                        }}
                        aria-pressed={fullscreen}
                        aria-label={fullscreenLabel}
                        title={fullscreenLabel}
                        className={ICON_BUTTON}
                    >
                        {fullscreen ? (
                            <Shrink className="h-4 w-4" aria-hidden />
                        ) : (
                            <Expand className="h-4 w-4" aria-hidden />
                        )}
                    </button>
                )}
                <Link
                    href="/games"
                    aria-label={t("close")}
                    title={t("close")}
                    className={ICON_BUTTON}
                >
                    <X className="h-4 w-4" aria-hidden />
                </Link>
            </header>
            <div ref={stage} className="min-h-0 flex-1 bg-black">
                <GameFrame
                    game={game}
                    onExit={() => router.push("/games")}
                    rooms={!hasRooms ? "off" : together ? "on" : "denied"}
                    onRooms={hasRooms ? showRooms : undefined}
                />
            </div>
            {roomsOpen && together && hasRooms && (
                <Dialog open onOpenChange={(open) => !open && setRoomsOpen(false)}>
                    <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle>{t("together")}</DialogTitle>
                            <DialogDescription>{t("togetherIntro")}</DialogDescription>
                        </DialogHeader>
                        <Rooms game={{ id: game.id, name }} />
                    </DialogContent>
                </Dialog>
            )}
            {inviting && (
                <InviteDialog game={game.id} gameName={name} onClose={() => setInviting(false)} />
            )}
        </div>
    );
}

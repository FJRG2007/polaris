"use client";

/**
 * One game, full screen, with the way back to the library above it - and, for
 * a game played together, Invite: it opens the game in a call with whoever was
 * invited (the dashboard's own dialog, see `arcadeInvite` in the host's pieces).
 * Full screen hands the game the whole display; Escape gives it back.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useArcadeT } from "./i18n";
import { GameFrame } from "./game-frame";
import { findGame } from "../games/registry";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useRef, useState } from "react";
import { Expand, Shrink, UserPlus, X } from "lucide-react";

type InviteAccess = { ok: true } | { ok: false; reason: "denied" | "missing" };

const ICON_BUTTON =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent";

export function GamePlayer({ gameId }: { gameId: string }) {
    const t = useArcadeT();
    const router = useRouter();
    const game = findGame(gameId);
    const stage = useRef<HTMLDivElement | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [canFullscreen, setCanFullscreen] = useState(false);
    const [access, setAccess] = useState<InviteAccess | null>(null);
    const [inviting, setInviting] = useState(false);
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

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
            <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>{name}</h1>
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
                <Link href="/games" aria-label={t("close")} title={t("close")} className={ICON_BUTTON}>
                    <X className="h-4 w-4" aria-hidden />
                </Link>
            </header>
            <div ref={stage} className="min-h-0 flex-1 bg-black">
                <GameFrame game={game} onExit={() => router.push("/games")} />
            </div>
            {inviting && (
                <InviteDialog game={game.id} gameName={name} onClose={() => setInviting(false)} />
            )}
        </div>
    );
}

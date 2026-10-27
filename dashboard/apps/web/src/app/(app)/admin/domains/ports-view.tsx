"use client";

/**
 * The Ports page's body. Each card draws nothing when nothing on this server needs
 * it, and nothing while its first read is out - so until each has said which, a
 * card-shaped skeleton holds its place, and the empty note appears only once both
 * have answered and neither has anything to show.
 */

import { Skeleton } from "@polaris/ui";
import { useCallback, useState } from "react";
import { CallPortsCard } from "./call-ports-card";
import { GamePortsCard } from "./game-ports-card";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function PortsView() {
    const t = useTranslations("admin");
    const [game, setGame] = useState<boolean | null>(null);
    const [call, setCall] = useState<boolean | null>(null);
    const onGame = useCallback((shown: boolean) => setGame(shown), []);
    const onCall = useCallback((shown: boolean) => setCall(shown), []);

    return (
        <div className="flex w-full flex-col gap-6">
            <GamePortsCard onKnown={onGame} />
            {game === null ? <CardSkeleton /> : null}
            <CallPortsCard onKnown={onCall} />
            {call === null ? <CardSkeleton /> : null}
            {game === false && call === false ? (
                <p className="text-sm text-muted-foreground">{t("domains.pages.ports.empty")}</p>
            ) : null}
        </div>
    );
}

/** A port card's shape while its read is out: a heading, a line, a few rows. */
function CardSkeleton() {
    return (
        <div data-testid="ports-skeleton" className="flex flex-col gap-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3.5 w-full max-w-xl" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
        </div>
    );
}

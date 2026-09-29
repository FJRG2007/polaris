"use client";

/**
 * What game servers decided about the players linked to this account.
 *
 * Its own card, under Polaris's own, because it is a different authority: a
 * server's moderator or its anti-cheat banned a Minecraft player, and none of
 * that moves the account up or down the ladder above. Each row names the game
 * and the server, so nobody reads a ban on somebody's survival world as a
 * decision about their Polaris account.
 */

import { Gamepad2 } from "lucide-react";
import { Badge, Skeleton } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** One sanction as the page is handed it - moments as strings, since it crosses
 *  from a server component. */
export interface GameSanctionRow {
    readonly id: string;
    readonly kind: "ban" | "timeout" | "kick";
    readonly game: string;
    readonly server: string;
    readonly player: string;
    readonly at: string;
    readonly until: string | null;
    readonly active: boolean;
    readonly reason: string | null;
}

const KIND_KEYS = {
    ban: "standing.games.banned",
    timeout: "standing.games.timedOut",
    kick: "standing.games.kicked"
} as const;

/** The card's heading, drawn before the list has answered. */
export function GameSanctionsHeading() {
    const t = useTranslations("account");
    return (
        <div>
            <h2 className="flex items-center gap-2 text-sm font-medium">
                <Gamepad2 className="size-4 shrink-0 text-muted-foreground" />
                {t("standing.games.title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("standing.games.description")}</p>
        </div>
    );
}

/** The shape of two rows, while the servers' records are read. */
export function GameSanctionsSkeleton() {
    return (
        <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
        </div>
    );
}

export function GameSanctionsList({
    sanctions,
    incomplete
}: {
    sanctions: readonly GameSanctionRow[];
    incomplete: boolean;
}) {
    const format = useDisplayFormat();
    const t = useTranslations("account");

    return (
        <div className="flex flex-col gap-2">
            {incomplete && <p className="text-sm text-warning">{t("standing.games.incomplete")}</p>}
            {sanctions.length === 0 && !incomplete && (
                <p className="text-sm text-muted-foreground">{t("standing.games.none")}</p>
            )}
            {sanctions.length > 0 && (
                <ul className="flex flex-col gap-2">
                    {sanctions.map((sanction) => (
                        <li
                            key={sanction.id}
                            className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                <span className="min-w-0 truncate" title={sanction.server}>
                                    {t.rich(KIND_KEYS[sanction.kind], {
                                        where: (chunks) => (
                                            <span key="where" className="font-medium">
                                                {chunks}
                                            </span>
                                        ),
                                        server: sanction.server
                                    })}
                                </span>
                                <span className="flex shrink-0 items-center gap-1.5">
                                    <Badge>{sanction.game}</Badge>
                                    <Badge variant={sanction.active ? "danger" : "neutral"}>
                                        {sanction.active
                                            ? t("standing.games.active")
                                            : t("standing.games.ended")}
                                    </Badge>
                                </span>
                            </div>
                            <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                                <span>
                                    {t("standing.games.as", {
                                        player: sanction.player,
                                        date: format.dateTime(sanction.at)
                                    })}
                                </span>
                                {sanction.active && (
                                    <span>
                                        {sanction.until
                                            ? t("standing.inForce.until", {
                                                  time: format.dateTime(sanction.until)
                                              })
                                            : t("standing.inForce.untilLifted")}
                                    </span>
                                )}
                            </p>
                            {sanction.reason && (
                                <p className="break-words text-xs text-muted-foreground">
                                    {t("standing.games.reason", { reason: sanction.reason })}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

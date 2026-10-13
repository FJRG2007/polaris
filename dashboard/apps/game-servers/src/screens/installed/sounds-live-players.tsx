"use client";

/**
 * Who on the server has the sound pack, opened under the counts on demand.
 *
 * A page at a time, searched and filtered on the server: the jar names everybody
 * on, and a server of thousands drawn as one row of tags each was neither
 * readable nor cheap to send. Nothing is read until the list is opened.
 */

import { useGameText } from "../game-text";
import { useEffect, useState } from "react";
import * as actions from "./sounds-actions";
import { Badge, Button, Input } from "@polaris/ui";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type {
    LiveSoundFilter,
    LiveSoundPlayer,
    LiveSoundState
} from "../../lib/minecraft/sounds-live";

/** Names per page: enough to scan, few enough to send every refresh. */
export const LIVE_PAGE_SIZE = 25;

/** How long typing settles before the search is sent. */
const SEARCH_DELAY_MS = 250;

const FILTERS: readonly LiveSoundFilter[] = ["all", "have", "missing"];

export function LiveSoundPlayers({
    installedAppId,
    stateWords
}: {
    installedAppId: string;
    stateWords: (state: LiveSoundState) => string;
}) {
    const t = useGameText("minecraft");
    const [typed, setTyped] = useState("");
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<LiveSoundFilter>("all");
    const [offset, setOffset] = useState(0);
    const [page, setPage] = useState<{ players: LiveSoundPlayer[]; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setQuery(typed.trim());
            setOffset(0);
        }, SEARCH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [typed]);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        void actions
            .liveSoundPlayersAction({
                installedAppId,
                query,
                filter,
                offset,
                limit: LIVE_PAGE_SIZE
            })
            .then(
                (answer) => {
                    if (!alive) return;
                    setLoading(false);
                    if (answer.players) {
                        setPage({ players: answer.players, total: answer.total ?? 0 });
                        setError(null);
                    } else setError(answer.error ?? t("sounds.delivery.whoFailed"));
                },
                () => {
                    if (!alive) return;
                    setLoading(false);
                    setError(t("sounds.delivery.whoFailed"));
                }
            );
        return () => {
            alive = false;
        };
    }, [installedAppId, query, filter, offset, t]);

    const total = page?.total ?? 0;
    const shown = page?.players ?? [];

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input
                    value={typed}
                    maxLength={16}
                    spellCheck={false}
                    placeholder={t("sounds.delivery.searchPlayers")}
                    aria-label={t("sounds.delivery.searchPlayers")}
                    className="h-8 min-w-0 flex-1 basis-40"
                    onChange={(event) => setTyped(event.target.value)}
                />
                <div className="flex gap-1" role="group" aria-label={t("sounds.delivery.whoTitle")}>
                    {FILTERS.map((one) => (
                        <Button
                            key={one}
                            type="button"
                            size="xs"
                            variant={filter === one ? "secondary" : "ghost"}
                            aria-pressed={filter === one}
                            onClick={() => {
                                setFilter(one);
                                setOffset(0);
                            }}
                        >
                            {one === "all"
                                ? t("sounds.delivery.filterAll")
                                : one === "have"
                                  ? t("sounds.delivery.filterHave")
                                  : t("sounds.delivery.filterMissing")}
                        </Button>
                    ))}
                </div>
            </div>
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : !page ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                </p>
            ) : shown.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("sounds.delivery.whoNoMatch")}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {shown.map((one) => (
                        <li
                            key={one.name}
                            className="flex min-w-0 items-center justify-between gap-2 px-2 py-1 text-xs"
                        >
                            <span className="min-w-0 truncate font-mono" title={one.name}>
                                {one.name}
                            </span>
                            <Badge
                                variant={
                                    one.state === "loaded"
                                        ? "success"
                                        : one.state === "pending"
                                          ? "neutral"
                                          : "danger"
                                }
                            >
                                {stateWords(one.state)}
                            </Badge>
                        </li>
                    ))}
                </ul>
            )}
            {total > LIVE_PAGE_SIZE ? (
                <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                    <span className="tabular-nums">
                        {t("sounds.delivery.whoPage", {
                            from: offset + 1,
                            to: Math.min(offset + LIVE_PAGE_SIZE, total),
                            total
                        })}
                    </span>
                    <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={loading || offset === 0}
                        aria-label={t("sounds.delivery.previousPage")}
                        title={t("sounds.delivery.previousPage")}
                        onClick={() => setOffset(Math.max(offset - LIVE_PAGE_SIZE, 0))}
                    >
                        <ChevronLeft className="size-3.5" />
                    </Button>
                    <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={loading || offset + LIVE_PAGE_SIZE >= total}
                        aria-label={t("sounds.delivery.nextPage")}
                        title={t("sounds.delivery.nextPage")}
                        onClick={() => setOffset(offset + LIVE_PAGE_SIZE)}
                    >
                        <ChevronRight className="size-3.5" />
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

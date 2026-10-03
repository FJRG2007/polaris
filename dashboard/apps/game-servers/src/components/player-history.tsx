"use client";

/**
 * What somebody's time on a server adds up to, drawn the same way for both games.
 *
 * One component because it is one question. Polaris watches Minecraft and ARK the
 * same way - it asks each of them who is on, once a minute, and writes down what
 * changed - so the record it keeps has the same shape whichever game produced it,
 * and two panels drawing it two ways would only invite them to drift.
 *
 * The figures the server itself counted are Minecraft's alone: it keeps a file of
 * them beside the world, covering the whole life of that world rather than only the
 * part Polaris was present for. ARK counts nothing, so that row simply does not
 * draw - which is why it is a separate block and not a column somewhere.
 */

import type { PlayerStats } from "../lib/games-activity";
import { useGameText, type GameText } from "../screens/game-text";
import type { PlayerRecord } from "../lib/games-activity-service";
import { hostUi } from "@polaris/app-host/client";
import { figureLanguage, formatCount, formatDuration } from "../lib/figures";

const { useDisplayFormat } = hostUi.displayFormat;

/** How long somebody has played, in the largest unit that still says something
 *  (`figures.formatDuration`): `45 min`, `3.5 h`, `1.1 d`, `6.4 wk`. */
export function playedFor(t: GameText<"games">, ms: number, locale: string): string {
    if (ms < 60_000) return t("history.underAMinute");
    return formatDuration(ms, figureLanguage(locale));
}

/** One figure with its label. */
export function Figure({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="truncate text-sm font-medium" title={value}>
                {value}
            </p>
        </div>
    );
}

export function PlayerRecordPanel({
    record,
    stats,
    loading
}: {
    record: PlayerRecord | null;
    /** Minecraft only, and null until it is read - or for good, on a world too young
     *  to have written the file. */
    stats?: PlayerStats | null;
    loading: boolean;
}) {
    const t = useGameText("games");
    const format = useDisplayFormat();
    const locale = hostUi.i18nProvider.useLocale();
    const count = (value: number) => formatCount(value, figureLanguage(locale));
    const history = record?.history;
    const seen = (history?.visits ?? 0) > 0;
    // For somebody on, when the visit they are on began: the last moment they were
    // seen is now, which says nothing.
    const latest = history?.online ? history.onSince : (history?.lastSeen ?? null);

    if (!seen && !stats) {
        return (
            <p className="py-4 text-center text-sm text-muted-foreground">
                {loading ? t("history.readingTheRecord") : t("history.polarisHasNotSeenThis")}
            </p>
        );
    }

    return (
        <div className="space-y-2">
            {seen && history && (
                <div className="grid grid-cols-2 gap-2">
                    <Figure label={t("history.played")} value={playedFor(t, history.playedMs, locale)} />
                    <Figure label={t("history.visits")} value={count(history.visits)} />
                    <Figure
                        label={t("history.firstSeen")}
                        value={history.firstSeen ? format.date(history.firstSeen) : "-"}
                    />
                    <Figure
                        label={history.online ? t("history.onSince") : t("history.lastSeen")}
                        value={latest ? format.dateTime(latest) : "-"}
                    />
                </div>
            )}
            {stats && (
                <div className="grid grid-cols-3 gap-2">
                    {/* Counted by the server rather than by Polaris, so it covers
                        the whole life of the world. */}
                    <Figure
                        label={t("history.playtimeAllTime")}
                        value={playedFor(t, stats.playedMs, locale)}
                    />
                    <Figure label={t("history.deaths")} value={count(stats.deaths)} />
                    <Figure label={t("history.mobsKilled")} value={count(stats.mobKills)} />
                </div>
            )}
        </div>
    );
}

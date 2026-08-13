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

import { useDisplayFormat } from "./display-format";
import type { PlayerStats } from "@/lib/apps/games-activity";
import type { PlayerRecord } from "@/lib/apps/games-activity-service";

/** How long somebody has played, in the largest unit that still says something. */
export function playedFor(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return `${minutes} min`;
    const hours = minutes / 60;
    // One decimal below a day, because "1.5 h" is a real difference from "1 h".
    // Past that the fraction is noise.
    if (hours < 24) return `${Number(hours.toFixed(1))} h`;
    return `${Math.round(hours)} h`;
}

/** One figure with its label. */
export function Figure({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="truncate text-sm font-medium" title={value}>{value}</p>
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
    const format = useDisplayFormat();
    const history = record?.history;
    const seen = (history?.visits ?? 0) > 0;

    if (!seen && !stats) {
        return (
            <p className="py-4 text-center text-sm text-muted-foreground">
                {loading ? "Reading the record" : "Polaris has not seen this player on the server yet."}
            </p>
        );
    }

    return (
        <div className="space-y-2">
            {seen && history && (
                <div className="grid grid-cols-2 gap-2">
                    <Figure label="Played" value={playedFor(history.playedMs)} />
                    <Figure label="Visits" value={String(history.visits)} />
                    <Figure label="First seen" value={history.firstSeen ? format.date(history.firstSeen) : "-"} />
                    <Figure
                        label={history.online ? "On since" : "Last seen"}
                        value={history.lastSeen ? format.dateTime(history.lastSeen) : "-"}
                    />
                </div>
            )}
            {stats && (
                <div className="grid grid-cols-3 gap-2">
                    {/* Counted by the server rather than by Polaris, so it covers
                        the whole life of the world. */}
                    <Figure label="Playtime, all time" value={playedFor(stats.playedMs)} />
                    <Figure label="Deaths" value={String(stats.deaths)} />
                    <Figure label="Mobs killed" value={String(stats.mobKills)} />
                </div>
            )}
        </div>
    );
}

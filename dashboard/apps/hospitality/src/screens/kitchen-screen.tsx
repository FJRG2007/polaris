"use client";

/**
 * The kitchen or bar display: every order sent to this station and not ready
 * yet, oldest first, with how long it has waited (green, then amber at 10
 * minutes, red at 20). Tapping a line bumps it; "All ready" bumps the order;
 * the last bump can be undone for a few seconds instead of asking first.
 */

import { Check, Undo2 } from "lucide-react";
import type { KitchenTicket } from "../lib/till";
import { readMenuAction } from "../actions/catalog";
import { useCallback, useEffect, useState } from "react";
import { markLinesAction, readKitchenAction } from "../actions/till";
import { useHospitalityLive, useHospitalityMode } from "./live-client";
import { readCache, unwrap, useHospitalityT, writeCache } from "./i18n";
import { Button, EmptyState, Select, Skeleton, cn, useToast } from "@polaris/ui";

function minutesSince(iso: string, now: number): number {
    return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
}

export function KitchenScreen() {
    const t = useHospitalityT();
    const toast = useToast();
    const [mode] = useHospitalityMode();
    const [venueId, setVenueId] = useState<string | null>(null);
    const [station, setStation] = useState<string>(() => readCache<string>("station") ?? "all");
    const [tickets, setTickets] = useState<KitchenTicket[] | null>(null);
    const [undo, setUndo] = useState<string[] | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const load = useCallback(() => {
        unwrap(() => readMenuAction({ venueId: readCache<string>("venue") }), t("errors.loadFailed"))
            .then((answer) => {
                setVenueId(answer.menu.venueId);
                if (!answer.menu.venueId) return setTickets([]);
                return unwrap(
                    () => readKitchenAction({ venueId: answer.menu.venueId, station: station === "all" ? null : station }),
                    t("errors.loadFailed")
                ).then((k) => setTickets(k.tickets));
            })
            .catch((caught: Error) => toast.show({ title: t("errors.loadFailed"), body: caught.message }));
    }, [station, t, toast]);
    useEffect(load, [load]);
    useHospitalityLive(venueId, load);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);

    const bump = (lineIds: string[], ready: boolean) => {
        // Gone from the screen at once; back if the server refuses.
        const before = tickets;
        if (ready) setTickets((all) => all && all.map((x) => ({ ...x, lines: x.lines.filter((l) => !lineIds.includes(l.id)) })).filter((x) => x.lines.length));
        setUndo(ready ? lineIds : null);
        unwrap(() => markLinesAction({ lineIds, ready }), t("errors.saveFailed"))
            .then(() => !ready && load())
            .catch((caught: Error) => {
                setTickets(before);
                toast.show({ title: t("errors.saveFailed"), body: caught.message });
            });
    };

    return (
        <div className="flex min-w-0 flex-col gap-3 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Select
                    aria-label={t("kitchen.station")}
                    value={station}
                    onValueChange={(s) => {
                        setStation(s);
                        writeCache("station", s);
                    }}
                    options={[
                        { value: "all", label: t("kitchen.all") },
                        { value: "kitchen", label: t("stations.kitchen") },
                        { value: "bar", label: t("stations.bar") }
                    ]}
                />
                {undo ? (
                    <Button variant="outline" onClick={() => { bump(undo, false); setUndo(null); }}>
                        <Undo2 aria-hidden /> {t("kitchen.undo")}
                    </Button>
                ) : null}
            </div>
            {tickets === null ? (
                <div className="grid gap-3 sm:grid-cols-3" aria-busy>
                    {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}
                </div>
            ) : tickets.length === 0 ? (
                <EmptyState title={t("kitchen.empty")} />
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {tickets.map((ticket) => {
                        const waited = minutesSince(ticket.lines[0]?.sentAt ?? new Date(now).toISOString(), now);
                        return (
                            <article
                                key={ticket.orderId}
                                className={cn(
                                    "flex min-w-0 flex-col rounded-lg border-2 bg-background",
                                    waited >= 20 ? "border-red-600" : waited >= 10 ? "border-amber-500" : "border-green-600"
                                )}
                            >
                                <header className="flex min-w-0 items-center gap-2 border-b p-2">
                                    <span className={cn("min-w-0 flex-1 truncate font-bold", mode === "basic" ? "text-2xl" : "text-lg")} title={ticket.table}>
                                        {ticket.table}
                                    </span>
                                    <span className="shrink-0 tabular-nums">{t("kitchen.minutes", { count: waited })}</span>
                                </header>
                                <ul className="flex flex-col">
                                    {ticket.lines.map((line) => (
                                        <li key={line.id}>
                                            <button
                                                type="button"
                                                onClick={() => bump([line.id], true)}
                                                className={cn("flex w-full min-w-0 items-start gap-2 border-b px-2 text-start", mode === "basic" ? "py-3 text-lg" : "py-2")}
                                            >
                                                <span className="w-7 shrink-0 text-end font-bold tabular-nums">{line.quantity}</span>
                                                <span className="flex min-w-0 flex-1 flex-col">
                                                    <span className="truncate font-medium" title={line.name}>{line.name}</span>
                                                    {line.modifiers.length ? <span className="text-sm text-muted-foreground">{line.modifiers.join(", ")}</span> : null}
                                                    {line.note ? <span className="text-sm text-amber-700 dark:text-amber-400">{line.note}</span> : null}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                <Button className="m-2" size={mode === "basic" ? "lg" : "primary"} onClick={() => bump(ticket.lines.map((l) => l.id), true)}>
                                    <Check aria-hidden /> {t("kitchen.allReady")}
                                </Button>
                            </article>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

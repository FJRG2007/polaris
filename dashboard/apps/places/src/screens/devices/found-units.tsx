"use client";

/**
 * "Found on your network": the units a connection finds by itself, to pick from
 * before anything is typed.
 *
 * Home Assistant's Gree integration has no address field at all - it scans, and
 * whatever answers is added. That is the right default and it is what an empty
 * address still does here; this list is the part Home Assistant leaves out, so
 * that somebody with three air conditioners can see which is which (the name each
 * was given in the maker's app, its MAC and where it is now) and connect just the
 * one they mean. Picking one fills the address with its MAC, so it is followed
 * when the router moves it.
 *
 * Asked for when the connection is chosen, never before: the scan is a look
 * around somebody's network, and it takes a few seconds. What it found is kept
 * for half a minute, so going back and forth in the dialog does not scan again.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import { Check, RefreshCw } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import { Button, cn, CopyButton, Skeleton } from "@polaris/ui";
import type { DiscoveredUnit } from "../../lib/drivers/contract";

const { runAction } = hostUi.runAction;

/** What a scan found, per connection, for this long. */
const KEEP_MS = 30_000;
const held = new Map<string, { at: number; units: DiscoveredUnit[] }>();

type Scan =
    | { readonly state: "scanning" }
    | { readonly state: "done"; readonly units: readonly DiscoveredUnit[] }
    | { readonly state: "failed" };

export function FoundUnits({
    connection,
    picked,
    onPick
}: {
    connection: string;
    /** The MAC or address the form holds now, to mark the row it came from. */
    picked: string;
    onPick: (unit: DiscoveredUnit) => void;
}) {
    const t = usePlacesT();
    const [scan, setScan] = useState<Scan>(() => {
        const kept = held.get(connection);
        return kept && Date.now() - kept.at < KEEP_MS
            ? { state: "done", units: kept.units }
            : { state: "scanning" };
    });
    const [round, setRound] = useState(0);

    useEffect(() => {
        const kept = held.get(connection);
        if (round === 0 && kept && Date.now() - kept.at < KEEP_MS) {
            setScan({ state: "done", units: kept.units });
            return;
        }
        let live = true;
        setScan({ state: "scanning" });
        void runAction(
            () => actions.discoverDeviceUnitsAction({ connection, fresh: round > 0 }),
            () => undefined
        ).then((result) => {
            if (!live) return;
            if (!result || result.error || !result.units) {
                setScan({ state: "failed" });
                return;
            }
            held.set(connection, { at: Date.now(), units: result.units });
            setScan({ state: "done", units: result.units });
        });
        return () => {
            live = false;
        };
    }, [connection, round]);

    const chosen = picked.trim().toUpperCase();

    return (
        <section aria-labelledby="found-units-title" className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
                <span id="found-units-title" className="text-xs text-muted-foreground">
                    {t("connect.found.title")}
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={scan.state === "scanning"}
                    onClick={() => setRound((count) => count + 1)}
                >
                    <RefreshCw
                        className={cn("size-3.5", scan.state === "scanning" && "animate-spin")}
                    />
                    {t("connect.found.again")}
                </Button>
            </div>
            {scan.state === "scanning" ? (
                <div aria-busy="true" className="flex flex-col gap-1.5">
                    <span className="sr-only" aria-live="polite">
                        {t("connect.found.scanning")}
                    </span>
                    {[0, 1].map((row) => (
                        <div
                            key={row}
                            className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
                        >
                            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <Skeleton className="h-3.5 w-32" />
                                <Skeleton className="h-3 w-48 max-w-full" />
                            </span>
                        </div>
                    ))}
                </div>
            ) : scan.state === "failed" ? (
                <p className="text-xs text-muted-foreground">{t("connect.found.failed")}</p>
            ) : scan.units.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("connect.found.none")}</p>
            ) : (
                <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                    {scan.units.map((unit) => {
                        const selected =
                            chosen !== "" &&
                            (chosen === unit.mac || chosen === unit.address.toUpperCase());
                        const name = unit.name || unit.model || unit.address;
                        return (
                            <li
                                key={unit.mac ?? unit.address}
                                className={cn(
                                    "flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors duration-fast",
                                    selected
                                        ? "border-accent bg-accent/10"
                                        : "border-border bg-card hover:border-border-strong"
                                )}
                            >
                                <button
                                    type="button"
                                    aria-pressed={selected}
                                    aria-label={t("connect.found.use", { name })}
                                    onClick={() => onPick(unit)}
                                    className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:outline-none"
                                >
                                    <Check
                                        className={cn(
                                            "mt-0.5 size-4 shrink-0",
                                            selected ? "text-accent" : "text-transparent"
                                        )}
                                    />
                                    <span className="flex min-w-0 flex-col gap-0.5">
                                        <span className="truncate text-sm font-medium" title={name}>
                                            {name}
                                            {unit.model && unit.model !== name && (
                                                <span className="font-normal text-foreground-subtle">
                                                    {" "}
                                                    {unit.model}
                                                </span>
                                            )}
                                        </span>
                                        <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                                            {unit.mac ?? t("connect.found.noMac")} - {unit.address}
                                        </span>
                                    </span>
                                </button>
                                {unit.mac && (
                                    <CopyButton
                                        value={unit.mac}
                                        label={t("connect.found.copyMac", { mac: unit.mac })}
                                    />
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

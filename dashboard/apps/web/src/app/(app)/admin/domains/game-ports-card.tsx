"use client";

/**
 * The ports the game servers answer on, and what still has to be opened for them.
 *
 * A section of its own because the rest of this page is finished the moment 80 and
 * 443 reach Polaris - the zone check goes green, the router advice disappears, and
 * a game server sitting on a port nobody ever forwarded is invisible from here.
 * That is the state most deployments are in: websites work, the server says
 * "running", and every player outside the network gets a timeout.
 *
 * So it is driven by the servers themselves rather than by the DNS check, and it
 * shows what is confirmed apart from what is not: a port is ticked once something
 * has actually arrived on it from a public address, which is the one piece of
 * evidence a router cannot fake.
 *
 * It reads in two passes for the same reason it exists at all. The first asks what
 * is already known, which is a database read; every one after it knocks, which
 * waits out a timeout on each port nobody has opened. Rendering this on the server
 * meant the whole page waited for the first of those, so both now happen in the
 * browser and the card appears as soon as there is something in it.
 *
 * Nothing is drawn until that first read answers - not even a skeleton. A
 * deployment that runs no game server has no card here at all, and a placeholder
 * that resolves into nothing is a page that moves under whoever is reading it.
 */

import { GamePortsLive } from "./game-ports-live";
import { PortPolicyForm } from "./port-policy-form";
import { describeBlock } from "@/lib/apps/port-block";
import { PortsReadFailed } from "./ports-read-failed";
import { PageSection } from "@/components/page-section";
import { useEffect, useState, type ReactNode } from "react";
import { HostPortRangesForm } from "./host-port-ranges-form";
import { Button, Input, Select, Skeleton } from "@polaris/ui";
import type { GamePortsReading } from "@/lib/apps/port-advice";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    GAME_PORTS_SEARCH_MAX,
    GAME_PORTS_SORTS,
    GAME_PORTS_STATUSES,
    gamePortsSearch,
    type GamePortsSort,
    type GamePortsStatus
} from "@/lib/apps/game-ports-query";

/** How often the card re-reads. The knock behind it is rate limited to one every
 *  thirty seconds per server, so this is about how soon the answer shows. */
const POLL_MS = 15_000;

const PORTS_URL = "/api/admin/domains/game-ports";

/** How long typing settles before the search is asked for. */
const SEARCH_SETTLE_MS = 300;

/** A page as the endpoint sends it: the reading, the next page's cursor, and
 *  whether any game server exists at all. */
type GamePortsPageBody = GamePortsReading & { next: string | null; any: boolean };

/** `onKnown` hears, once the first read is in, whether the card has anything to
 *  show - so a page holding only this card can tell loading from empty. */
export function GamePortsCard({ onKnown }: { onKnown?: (shown: boolean) => void } = {}) {
    const t = useTranslations("admin");
    const [typed, setTyped] = useState("");
    const [q, setQ] = useState("");
    const [status, setStatus] = useState<GamePortsStatus>("all");
    const [sort, setSort] = useState<GamePortsSort>("name");
    // The cursors of the pages walked so far; the last is the page on screen.
    const [cursors, setCursors] = useState<(string | null)[]>([null]);
    // Off for the first read and on for every one after: knocking on a closed port
    // waits out a timeout, so the card is on screen before it starts.
    const [probe, setProbe] = useState(false);
    // Whether this deployment runs game servers at all, remembered across filters:
    // a search that finds nothing keeps the card, a deployment with none hides it.
    const [any, setAny] = useState<boolean | null>(null);

    useEffect(() => {
        const timer = setTimeout(() => {
            const next = typed.trim().slice(0, GAME_PORTS_SEARCH_MAX);
            if (next === q) return;
            setQ(next);
            setCursors([null]);
        }, SEARCH_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [typed, q]);

    const after = cursors[cursors.length - 1] ?? null;
    const search = gamePortsSearch({ q, status, sort, after });
    const params = [search, probe ? "probe=1" : ""].filter(Boolean).join("&");
    const live = useLiveResource<GamePortsPageBody>({
        url: params ? `${PORTS_URL}?${params}` : PORTS_URL,
        cacheKey: `admin.gamePorts:${search}`,
        intervalMs: POLL_MS,
        select: (body) => body as GamePortsPageBody
    });

    useEffect(() => {
        // Once the first read has answered either way. A card that never loaded has
        // nothing to knock for, and would otherwise retry against the slow URL.
        if (!live.loading) setProbe(true);
    }, [live.loading]);

    const reading = live.data;
    useEffect(() => {
        if (reading) setAny(reading.any || reading.servers.length > 0);
    }, [reading]);
    const failed = reading === null && live.error !== null && any === null;
    const known = any !== null || failed || (!live.loading && reading === null);
    const shown = failed || any === true;
    useEffect(() => {
        if (known) onKnown?.(shown);
    }, [known, shown, onKnown]);
    if (failed) {
        return (
            <PortsReadFailed
                id="game-ports"
                title={t("domainsPorts.game.title")}
                refreshing={live.refreshing}
                onRetry={live.refresh}
            />
        );
    }
    // Nothing to say on a deployment that runs no game servers, and a card that
    // explains a situation nobody is in is noise on an admin page.
    if (any !== true) return null;
    const statusOptions = GAME_PORTS_STATUSES.map((value) => ({
        value,
        label: t(`domainsPorts.list.status.${value}`)
    }));
    const sortOptions = GAME_PORTS_SORTS.map((value) => ({
        value,
        label: t(`domainsPorts.list.sort.${value}`)
    }));
    const description = (
        <>
            {t("domainsPorts.game.description")}
            {reading?.policy === "range" ? (
                <>
                    {" "}
                    {t.rich<ReactNode>("domainsPorts.game.range", {
                        tcp: (chunks) => (
                            <span key="tcp" className="font-mono text-foreground">
                                {chunks}
                            </span>
                        ),
                        udp: (chunks) => (
                            <span key="udp" className="font-mono text-foreground">
                                {chunks}
                            </span>
                        ),
                        tcpRange: describeBlock(reading.blocks.tcp),
                        udpRange: describeBlock(reading.blocks.udp)
                    })}
                </>
            ) : null}
        </>
    );

    return (
        <PageSection id="game-ports" title={t("domainsPorts.game.title")} description={description}>
            {reading ? (
                <PortPolicyForm policy={reading.policy} blocks={reading.blocks} onSaved={live.refresh} />
            ) : null}
            <HostPortRangesForm />

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-48 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 start-2.5 size-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={typed}
                        maxLength={GAME_PORTS_SEARCH_MAX}
                        className="h-9 ps-8"
                        placeholder={t("domainsPorts.list.search")}
                        aria-label={t("domainsPorts.list.search")}
                        onChange={(event) => setTyped(event.target.value)}
                    />
                </div>
                <Select
                    value={status}
                    options={statusOptions}
                    aria-label={t("domainsPorts.list.statusAria")}
                    className="h-9 w-40"
                    onValueChange={(next) => {
                        setStatus(next as GamePortsStatus);
                        setCursors([null]);
                    }}
                />
                <Select
                    value={sort}
                    options={sortOptions}
                    aria-label={t("domainsPorts.list.sortAria")}
                    className="h-9 w-40"
                    onValueChange={(next) => {
                        setSort(next as GamePortsSort);
                        setCursors([null]);
                    }}
                />
            </div>

            {reading ? (
                reading.servers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("domainsPorts.list.noMatch")}</p>
                ) : (
                    <GamePortsLive
                        reading={reading}
                        stale={live.stale}
                        refreshing={live.refreshing}
                        onRefresh={live.refresh}
                    />
                )
            ) : (
                // Only the list waits on the page; the controls above stay usable.
                <div data-testid="game-ports-rows-skeleton" className="flex flex-col gap-2">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-4/5" />
                </div>
            )}

            {cursors.length > 1 || reading?.next ? (
                <div className="flex items-center justify-end gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={cursors.length <= 1}
                        onClick={() => setCursors((list) => list.slice(0, -1))}
                    >
                        <ChevronLeft className="size-4 shrink-0" />
                        {t("domainsPorts.list.previous")}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        {t("domainsPorts.list.page", { page: cursors.length })}
                    </span>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={!reading?.next}
                        onClick={() => {
                            const next = reading?.next;
                            if (next) setCursors((list) => [...list, next]);
                        }}
                    >
                        {t("domainsPorts.list.next")}
                        <ChevronRight className="size-4 shrink-0" />
                    </Button>
                </div>
            ) : null}
        </PageSection>
    );
}
